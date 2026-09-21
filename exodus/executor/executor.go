package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/vlab-research/exodus/db"
	"github.com/vlab-research/exodus/platform"
	"github.com/vlab-research/exodus/query"
	"github.com/vlab-research/exodus/sender"
	"github.com/vlab-research/exodus/types"
)

// BailStore defines the database operations needed for bail execution
type BailStore interface {
	GetEnabledBails(ctx context.Context) ([]*db.Bail, error)
	GetLastSuccessfulExecution(ctx context.Context, bailID uuid.UUID) (*time.Time, error)
	RecordEvent(ctx context.Context, event *db.BailEvent) error
	GetMessagingCredentials(ctx context.Context, pageids []string) (map[string]platform.Credential, error)
}

// QueryExecutor defines the interface for executing SQL queries
type QueryExecutor interface {
	Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error)
}

// BailSender defines the interface for sending bailouts
type BailSender interface {
	SendBailouts(ctx context.Context, users []sender.UserTarget, metadata map[string]interface{}) ([]string, error)
}

// Executor runs bail execution loop
type Executor struct {
	store  BailStore
	query  QueryExecutor
	sender BailSender
	limit  int // Max users per bail
}

// New creates a new Executor instance
func New(store BailStore, queryExec QueryExecutor, snd BailSender, limit int) *Executor {
	return &Executor{
		store:  store,
		query:  queryExec,
		sender: snd,
		limit:  limit,
	}
}

// Run executes all enabled bails once (for CronJob mode)
// Returns an error only for critical system failures that should stop execution.
// Individual bail errors are logged and recorded but don't stop processing other bails.
func (e *Executor) Run(ctx context.Context) error {
	now := time.Now()
	log.Printf("Starting bail execution run at %s", now.Format(time.RFC3339))

	// Load enabled bails
	bails, err := e.store.GetEnabledBails(ctx)
	if err != nil {
		return fmt.Errorf("failed to load enabled bails: %w", err)
	}

	if len(bails) == 0 {
		log.Printf("No enabled bails found")
		return nil
	}

	log.Printf("Found %d enabled bails to process", len(bails))

	// Process each bail with error isolation
	for _, bail := range bails {
		// Check for context cancellation
		select {
		case <-ctx.Done():
			return fmt.Errorf("execution cancelled: %w", ctx.Err())
		default:
		}

		// Process bail with panic recovery
		if err := e.processBail(ctx, bail, now); err != nil {
			log.Printf("Error processing bail %s (%s): %v", bail.Name, bail.ID, err)
			// Continue processing other bails
		}
	}

	log.Printf("Completed bail execution run")
	return nil
}

// processBail handles a single bail with error recovery
func (e *Executor) processBail(ctx context.Context, dbBail *db.Bail, now time.Time) (err error) {
	// Panic recovery to ensure one bad bail doesn't crash the entire executor
	defer func() {
		if r := recover(); r != nil {
			panicErr := fmt.Errorf("panic during bail execution: %v", r)
			log.Printf("PANIC in bail %s (%s): %v", dbBail.Name, dbBail.ID, r)

			if recordErr := e.recordError(ctx, dbBail, panicErr); recordErr != nil {
				err = fmt.Errorf("%w (also failed to record panic: %v)", panicErr, recordErr)
			} else {
				err = panicErr
			}
		}
	}()

	log.Printf("Processing bail: %s (ID: %s)", dbBail.Name, dbBail.ID)

	// Parse the bail definition from JSON
	var bailDef types.BailDefinition
	if err := json.Unmarshal(dbBail.Definition, &bailDef); err != nil {
		err := fmt.Errorf("failed to parse bail definition: %w", err)
		e.recordError(ctx, dbBail, err)
		return err
	}

	// Validate the definition
	if err := bailDef.Validate(); err != nil {
		err := fmt.Errorf("invalid bail definition: %w", err)
		e.recordError(ctx, dbBail, err)
		return err
	}

	// Get last execution time
	lastExecution, err := e.store.GetLastSuccessfulExecution(ctx, dbBail.ID)
	if err != nil {
		err := fmt.Errorf("failed to get last execution time: %w", err)
		e.recordError(ctx, dbBail, err)
		return err
	}

	// Check if should execute based on timing
	ready, err := shouldExecute(&bailDef.Execution, now, lastExecution)
	if err != nil {
		err := fmt.Errorf("timing check failed: %w", err)
		e.recordError(ctx, dbBail, err)
		return err
	}
	if !ready {
		log.Printf("Bail %s not ready to execute (timing conditions not met)", dbBail.Name)
		return nil
	}

	log.Printf("Bail %s ready to execute", dbBail.Name)

	// Branch on bail type: conditions-based or user_list-based
	bailType := bailDef.Type
	if bailType == "" {
		bailType = "conditions" // backward compatibility
	}

	// Query users matching bail conditions
	users, skipped, err := e.queryUsers(ctx, dbBail, &bailDef, bailType)
	if err != nil {
		err := fmt.Errorf("failed to query users: %w", err)
		e.recordError(ctx, dbBail, err)
		return err
	}

	usersMatched := len(users)
	log.Printf("Found %d users matching bail conditions (%d skipped)", usersMatched, len(skipped))

	if usersMatched == 0 {
		// Skips are the whole story of such a run, so they still need an event:
		// without one the UI shows nothing at all for a bail that reached nobody.
		if len(skipped) > 0 {
			log.Printf("Bail %s reached no one: all %d targets skipped", dbBail.Name, len(skipped))
			return e.recordSuccess(ctx, dbBail, &bailDef, 0, nil, skipped)
		}
		log.Printf("Bail %s matched no users, skipping", dbBail.Name)
		return nil
	}

	// Apply limit if necessary
	usersToProcess := users
	if e.limit > 0 && len(users) > e.limit {
		log.Printf("Limiting bail to %d users (matched %d)", e.limit, usersMatched)
		usersToProcess = users[:e.limit]
	}

	// Send bailouts
	bailedIDs, err := e.sender.SendBailouts(ctx, usersToProcess, bailDef.Action.Metadata)
	if err != nil {
		// Even if some sends failed, record partial success
		log.Printf("Partially failed to send bailouts: %v", err)
		if recordErr := e.recordSuccess(ctx, dbBail, &bailDef, usersMatched, bailedIDs, skipped); recordErr != nil {
			log.Printf("Also failed to record partial success for bail %s: %v", dbBail.Name, recordErr)
		}
		return fmt.Errorf("partially failed to send bailouts: %w", err)
	}

	log.Printf("Successfully bailed %d users", len(bailedIDs))
	return e.recordSuccess(ctx, dbBail, &bailDef, usersMatched, bailedIDs, skipped)
}

// queryUsers returns the conversations this bail should reach, plus the targets
// it could not resolve to a transport.
// For "conditions" type bails, it builds and executes a SQL query
// For "user_list" type bails, it resolves the listed accounts against the owner's credentials
func (e *Executor) queryUsers(ctx context.Context, dbBail *db.Bail, bailDef *types.BailDefinition, bailType string) (users []sender.UserTarget, skipped []platform.Skipped, err error) {
	if bailType == "user_list" {
		if bailDef.UserList == nil {
			return nil, nil, fmt.Errorf("user_list is nil for user_list-type bail")
		}
		log.Printf("Resolving user_list targets for bail %s", dbBail.Name)
		return e.resolveUserList(ctx, dbBail, bailDef.UserList)
	}

	// Handle conditions-based bails: execute SQL query
	// Build SQL query from bail definition
	sql, params, err := query.BuildQuery(bailDef, dbBail.UserID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to build query: %w", err)
	}

	log.Printf("Executing query for bail %s", dbBail.Name)

	// Execute query
	rows, err := e.query.Query(ctx, sql, params...)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to execute query: %w", err)
	}

	// Convert results to UserTarget structs with resolved destination form
	for _, row := range rows {
		userID, ok := row["userid"].(string)
		if !ok {
			log.Printf("Warning: Invalid userid type in query result: %T", row["userid"])
			continue
		}

		pageID, ok := row["pageid"].(string)
		if !ok {
			log.Printf("Warning: Invalid pageid type in query result: %T", row["pageid"])
			continue
		}

		// The query's INNER JOIN already guarantees a messaging credential per row,
		// so an unresolvable platform means the query changed underneath the
		// executor. That is a defect in this binary, not a property of one target,
		// and it fails the whole bail rather than quietly reaching fewer people.
		transport, ok := row["platform"].(string)
		if !ok || !platform.Valid(transport) {
			return nil, nil, fmt.Errorf("query returned an unusable platform %v (%T) for user=%s account_id=%s",
				row["platform"], row["platform"], userID, pageID)
		}

		users = append(users, sender.UserTarget{
			UserID:          userID,
			PageID:          pageID,
			Platform:        transport,
			DestinationForm: bailDef.Action.DestinationForm,
		})
	}

	return users, nil, nil
}

// resolveUserList turns a bail's listed users into targets, resolving each
// account's transport from the owner's credentials. Each entry's shortcode
// becomes the destination form for that user.
func (e *Executor) resolveUserList(ctx context.Context, dbBail *db.Bail, ul *types.UserList) ([]sender.UserTarget, []platform.Skipped, error) {
	targets := make([]platform.Target, len(ul.Users))
	pageids := make([]string, 0, len(ul.Users))
	seen := make(map[string]struct{}, len(ul.Users))

	for i, entry := range ul.Users {
		targets[i] = platform.Target{
			UserID:          entry.UserID,
			PageID:          entry.PageID,
			DestinationForm: entry.Shortcode,
		}
		if _, ok := seen[entry.PageID]; !ok {
			seen[entry.PageID] = struct{}{}
			pageids = append(pageids, entry.PageID)
		}
	}

	creds, err := e.store.GetMessagingCredentials(ctx, pageids)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to load messaging credentials: %w", err)
	}

	resolved, skipped := platform.Resolve(targets, creds, dbBail.UserID)

	users := make([]sender.UserTarget, len(resolved))
	for i, r := range resolved {
		users[i] = sender.UserTarget{
			UserID:          r.UserID,
			PageID:          r.PageID,
			Platform:        r.Platform,
			DestinationForm: r.DestinationForm,
		}
	}

	return users, skipped, nil
}

// recordSuccess records a successful bail execution event.
// usersMatched counts resolved targets only; skipped targets are reported separately.
// Returns an error if marshaling fails (corrupt snapshot would be worse than no record)
// or if the DB write fails.
func (e *Executor) recordSuccess(ctx context.Context, dbBail *db.Bail, bailDef *types.BailDefinition, usersMatched int, bailedIDs []string, skipped []platform.Skipped) error {
	defJSON, err := json.Marshal(bailDef)
	if err != nil {
		return fmt.Errorf("failed to marshal bail definition for success event: %w", err)
	}

	var executionResults *json.RawMessage
	if bailedIDs != nil || len(skipped) > 0 {
		// An all-skipped run still records user_ids, as an empty list rather than
		// a null, so every execution event has the same shape.
		if bailedIDs == nil {
			bailedIDs = []string{}
		}
		results := map[string]interface{}{"user_ids": bailedIDs}
		if len(skipped) > 0 {
			results["skipped"] = skipped
		}
		raw, err := json.Marshal(results)
		if err != nil {
			return fmt.Errorf("failed to marshal execution results for success event: %w", err)
		}
		msg := json.RawMessage(raw)
		executionResults = &msg
	}

	event := &db.BailEvent{
		BailID:             &dbBail.ID,
		UserID:             dbBail.UserID,
		BailName:           dbBail.Name,
		EventType:          "execution",
		UsersMatched:       usersMatched,
		UsersBailed:        len(bailedIDs),
		DefinitionSnapshot: defJSON,
		ExecutionResults:   executionResults,
	}

	if err := e.store.RecordEvent(ctx, event); err != nil {
		return fmt.Errorf("failed to record success event for bail %s: %w", dbBail.Name, err)
	}
	return nil
}

// recordError records a failed bail execution event.
// Returns an error if the DB write fails (so callers can include it in their own error).
func (e *Executor) recordError(ctx context.Context, dbBail *db.Bail, execErr error) error {
	errorJSON, err := json.Marshal(map[string]string{"message": execErr.Error()})
	if err != nil {
		return fmt.Errorf("failed to encode error event: %w", err)
	}
	errorRaw := json.RawMessage(errorJSON)

	defJSON := json.RawMessage("{}")
	if dbBail.Definition != nil {
		defJSON = dbBail.Definition
	}

	event := &db.BailEvent{
		BailID:             &dbBail.ID,
		UserID:             dbBail.UserID,
		BailName:           dbBail.Name,
		EventType:          "error",
		UsersMatched:       0,
		UsersBailed:        0,
		DefinitionSnapshot: defJSON,
		Error:              &errorRaw,
	}

	if err := e.store.RecordEvent(ctx, event); err != nil {
		log.Printf("Warning: Failed to record error event for bail %s: %v", dbBail.Name, err)
		return fmt.Errorf("failed to record error event: %w", err)
	}
	return nil
}
