package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/vlab-research/exodus/db"
	"github.com/vlab-research/exodus/query"
	"github.com/vlab-research/exodus/sender"
	"github.com/vlab-research/exodus/types"
)

// BailStore defines the database operations needed for bail execution
type BailStore interface {
	GetEnabledBails(ctx context.Context) ([]*db.Bail, error)
	GetLastSuccessfulExecution(ctx context.Context, bailID uuid.UUID) (*time.Time, error)
	RecordEvent(ctx context.Context, event *db.BailEvent) error
}

// QueryExecutor defines the interface for executing SQL queries
type QueryExecutor interface {
	Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error)
}

// BailSender defines the interface for sending bailouts
type BailSender interface {
	SendBailouts(ctx context.Context, users []sender.UserTarget, destinationForm string, metadata map[string]interface{}) (int, error)
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
			err = fmt.Errorf("panic during bail execution: %v", r)
			log.Printf("PANIC in bail %s (%s): %v", dbBail.Name, dbBail.ID, r)

			// Record panic as error event
			e.recordError(ctx, dbBail, err)
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
	if !shouldExecute(&bailDef.Execution, now, lastExecution) {
		log.Printf("Bail %s not ready to execute (timing conditions not met)", dbBail.Name)
		return nil
	}

	log.Printf("Bail %s ready to execute", dbBail.Name)

	// Query users matching bail conditions
	users, err := e.queryUsers(ctx, dbBail, &bailDef)
	if err != nil {
		err := fmt.Errorf("failed to query users: %w", err)
		e.recordError(ctx, dbBail, err)
		return err
	}

	usersMatched := len(users)
	log.Printf("Found %d users matching bail conditions", usersMatched)

	if usersMatched == 0 {
		// No users to bail, but still record as successful execution
		e.recordSuccess(ctx, dbBail, &bailDef, 0, 0)
		return nil
	}

	// Apply limit if necessary
	usersToProcess := users
	if e.limit > 0 && len(users) > e.limit {
		log.Printf("Limiting bail to %d users (matched %d)", e.limit, usersMatched)
		usersToProcess = users[:e.limit]
	}

	// Send bailouts
	usersBailed, err := e.sender.SendBailouts(ctx, usersToProcess, bailDef.Action.DestinationForm, bailDef.Action.Metadata)
	if err != nil {
		// Even if some sends failed, record partial success
		log.Printf("Partially failed to send bailouts: %v", err)
		e.recordSuccess(ctx, dbBail, &bailDef, usersMatched, usersBailed)
		return fmt.Errorf("partially failed to send bailouts: %w", err)
	}

	log.Printf("Successfully bailed %d users", usersBailed)
	e.recordSuccess(ctx, dbBail, &bailDef, usersMatched, usersBailed)
	return nil
}

// queryUsers executes the SQL query and returns matching users
func (e *Executor) queryUsers(ctx context.Context, dbBail *db.Bail, bailDef *types.BailDefinition) ([]sender.UserTarget, error) {
	// Build SQL query from bail definition
	sql, params, err := query.BuildQuery(bailDef)
	if err != nil {
		return nil, fmt.Errorf("failed to build query: %w", err)
	}

	log.Printf("Executing query for bail %s", dbBail.Name)

	// Execute query
	rows, err := e.query.Query(ctx, sql, params...)
	if err != nil {
		return nil, fmt.Errorf("failed to execute query: %w", err)
	}

	// Convert results to UserTarget structs
	var users []sender.UserTarget
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

		users = append(users, sender.UserTarget{
			UserID: userID,
			PageID: pageID,
		})
	}

	return users, nil
}

// recordSuccess logs successful execution
func (e *Executor) recordSuccess(ctx context.Context, dbBail *db.Bail, bailDef *types.BailDefinition, usersMatched, usersBailed int) {
	// Marshal definition back to JSON for snapshot
	defJSON, err := json.Marshal(bailDef)
	if err != nil {
		log.Printf("Warning: Failed to marshal bail definition for event: %v", err)
		defJSON = []byte("{}")
	}

	event := &db.BailEvent{
		BailID:             &dbBail.ID,
		UserID:             dbBail.UserID,
		BailName:           dbBail.Name,
		EventType:          "execution",
		UsersMatched:       usersMatched,
		UsersBailed:        usersBailed,
		DefinitionSnapshot: defJSON,
	}

	if err := e.store.RecordEvent(ctx, event); err != nil {
		log.Printf("Warning: Failed to record success event for bail %s: %v", dbBail.Name, err)
	}
}

// recordError logs failed execution
func (e *Executor) recordError(ctx context.Context, dbBail *db.Bail, execErr error) {
	// Create error JSON
	errorJSON := json.RawMessage(fmt.Sprintf(`{"message": "%s"}`, execErr.Error()))

	// Try to get definition, use empty object if fails
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
		Error:              &errorJSON,
	}

	if err := e.store.RecordEvent(ctx, event); err != nil {
		log.Printf("Warning: Failed to record error event for bail %s: %v", dbBail.Name, err)
	}
}
