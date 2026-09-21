package executor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/vlab-research/exodus/db"
	"github.com/vlab-research/exodus/platform"
	"github.com/vlab-research/exodus/sender"
)

// Mock implementations for testing

type mockBailStore struct {
	bails            []*db.Bail
	lastExecution    *time.Time
	recordedEvents   []*db.BailEvent
	credentials      map[string]platform.Credential
	credentialsError error
	getBailsError    error
	getLastExecError error
	recordEventError error
}

func (m *mockBailStore) GetEnabledBails(ctx context.Context) ([]*db.Bail, error) {
	if m.getBailsError != nil {
		return nil, m.getBailsError
	}
	return m.bails, nil
}

func (m *mockBailStore) GetLastSuccessfulExecution(ctx context.Context, bailID uuid.UUID) (*time.Time, error) {
	if m.getLastExecError != nil {
		return nil, m.getLastExecError
	}
	return m.lastExecution, nil
}

func (m *mockBailStore) RecordEvent(ctx context.Context, event *db.BailEvent) error {
	if m.recordEventError != nil {
		return m.recordEventError
	}
	m.recordedEvents = append(m.recordedEvents, event)
	return nil
}

func (m *mockBailStore) GetMessagingCredentials(ctx context.Context, pageids []string) (map[string]platform.Credential, error) {
	if m.credentialsError != nil {
		return nil, m.credentialsError
	}
	found := make(map[string]platform.Credential, len(pageids))
	for _, pageid := range pageids {
		if cred, ok := m.credentials[pageid]; ok {
			found[pageid] = cred
		}
	}
	return found, nil
}

type mockQueryExecutor struct {
	results    []map[string]interface{}
	queryError error
}

func (m *mockQueryExecutor) Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error) {
	if m.queryError != nil {
		return nil, m.queryError
	}
	return m.results, nil
}

type mockBailSender struct {
	sentBailouts []sender.UserTarget
	returnIDs    []string // pre-set IDs to return when sendError is set (partial failure)
	sendError    error
}

func (m *mockBailSender) SendBailouts(ctx context.Context, users []sender.UserTarget, metadata map[string]interface{}) ([]string, error) {
	if m.sendError != nil {
		return m.returnIDs, m.sendError
	}
	m.sentBailouts = append(m.sentBailouts, users...)
	ids := make([]string, len(users))
	for i, u := range users {
		ids[i] = u.UserID
	}
	return ids, nil
}

// Helper functions

func createTestBail(id uuid.UUID, name string, timing string, timeOfDay, timezone, datetime *string) *db.Bail {
	userID := uuid.New()

	def := map[string]interface{}{
		"conditions": map[string]interface{}{
			"type":  "form",
			"value": "test_form",
		},
		"execution": map[string]interface{}{
			"timing": timing,
		},
		"action": map[string]interface{}{
			"destination_form": "bailout_form",
		},
	}

	if timeOfDay != nil {
		def["execution"].(map[string]interface{})["time_of_day"] = *timeOfDay
	}
	if timezone != nil {
		def["execution"].(map[string]interface{})["timezone"] = *timezone
	}
	if datetime != nil {
		def["execution"].(map[string]interface{})["datetime"] = *datetime
	}

	defJSON, _ := json.Marshal(def)

	return &db.Bail{
		ID:              id,
		UserID:          userID,
		Name:            name,
		Description:     "Test bail",
		Enabled:         true,
		Definition:      defJSON,
		DestinationForm: "bailout_form",
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}
}

// createTestUserListBail creates a user_list type bail owned by userID, the
// identity whose connected accounts the listed pageids are resolved against.
func createTestUserListBail(id uuid.UUID, userID uuid.UUID, name string, users []map[string]interface{}, timing string) *db.Bail {
	def := map[string]interface{}{
		"type": "user_list",
		"user_list": map[string]interface{}{
			"users": users,
		},
		"execution": map[string]interface{}{
			"timing": timing,
		},
		"action": map[string]interface{}{
			"destination_form": "bailout_form",
		},
	}

	defJSON, _ := json.Marshal(def)

	return &db.Bail{
		ID:              id,
		UserID:          userID,
		Name:            name,
		Description:     "Test user_list bail",
		Enabled:         true,
		Definition:      defJSON,
		DestinationForm: "",
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}
}

// ownedCredentials connects each pageid to owner under the given entity.
func ownedCredentials(owner uuid.UUID, entity string, pageids ...string) map[string]platform.Credential {
	creds := make(map[string]platform.Credential, len(pageids))
	for _, pageid := range pageids {
		creds[pageid] = platform.Credential{PageID: pageid, Entity: entity, OwnerID: owner}
	}
	return creds
}

// executionResults decodes the execution_results of the single recorded event.
func executionResults(t *testing.T, event *db.BailEvent) map[string]interface{} {
	t.Helper()
	if event.ExecutionResults == nil {
		t.Fatal("expected execution_results to be recorded, got nil")
	}
	var results map[string]interface{}
	if err := json.Unmarshal(*event.ExecutionResults, &results); err != nil {
		t.Fatalf("execution_results is not valid JSON: %v", err)
	}
	return results
}

// Tests

func TestExecutor_Run_NoEnabledBails(t *testing.T) {
	store := &mockBailStore{
		bails: []*db.Bail{},
	}
	query := &mockQueryExecutor{}
	sender := &mockBailSender{}

	executor := New(store, query, sender, 100)

	err := executor.Run(context.Background())
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}

	if len(sender.sentBailouts) != 0 {
		t.Errorf("Expected no bailouts sent, got %d", len(sender.sentBailouts))
	}
}

func TestExecutor_Run_SkipsNotReady(t *testing.T) {
	bailID := uuid.New()

	// Create a scheduled bail that shouldn't execute now
	timeOfDay := "03:00"
	timezone := "UTC"
	bail := createTestBail(bailID, "scheduled_bail", "scheduled", &timeOfDay, &timezone, nil)

	// Set last execution to 1 hour ago (within 24 hours)
	lastExec := time.Now().Add(-1 * time.Hour)

	store := &mockBailStore{
		bails:         []*db.Bail{bail},
		lastExecution: &lastExec,
	}
	query := &mockQueryExecutor{
		results: []map[string]interface{}{
			{"userid": "user1", "pageid": "page1", "platform": "messenger"},
		},
	}
	sender := &mockBailSender{}

	executor := New(store, query, sender, 100)

	err := executor.Run(context.Background())
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}

	// Should not have sent any bailouts because timing not met
	if len(sender.sentBailouts) != 0 {
		t.Errorf("Expected no bailouts sent (timing not met), got %d", len(sender.sentBailouts))
	}

	// Should not have recorded any events
	if len(store.recordedEvents) != 0 {
		t.Errorf("Expected no events recorded (bail skipped), got %d", len(store.recordedEvents))
	}
}

func TestExecutor_Run_ExecutesBail(t *testing.T) {
	bailID := uuid.New()

	// Create an immediate bail (always executes)
	bail := createTestBail(bailID, "immediate_bail", "immediate", nil, nil, nil)

	store := &mockBailStore{
		bails:         []*db.Bail{bail},
		lastExecution: nil, // No prior execution
	}
	query := &mockQueryExecutor{
		results: []map[string]interface{}{
			{"userid": "user1", "pageid": "page1", "platform": "messenger"},
			{"userid": "user2", "pageid": "page2", "platform": "messenger"},
		},
	}
	sender := &mockBailSender{}

	executor := New(store, query, sender, 100)

	err := executor.Run(context.Background())
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}

	// Should have sent bailouts for both users
	if len(sender.sentBailouts) != 2 {
		t.Errorf("Expected 2 bailouts sent, got %d", len(sender.sentBailouts))
	}

	// Should have recorded a success event
	if len(store.recordedEvents) != 1 {
		t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
	}

	event := store.recordedEvents[0]
	if event.EventType != "execution" {
		t.Errorf("Expected event type 'execution', got '%s'", event.EventType)
	}
	if event.UsersMatched != 2 {
		t.Errorf("Expected 2 users matched, got %d", event.UsersMatched)
	}
	if event.UsersBailed != 2 {
		t.Errorf("Expected 2 users bailed, got %d", event.UsersBailed)
	}
	if event.ExecutionResults == nil {
		t.Error("Expected ExecutionResults to be non-nil for execution event")
	}
}

func TestExecutor_Run_ContinuesOnBailError(t *testing.T) {
	bailID1 := uuid.New()
	bailID2 := uuid.New()

	// First bail will fail (invalid definition)
	badDef := []byte(`{"invalid": "json"}`)
	badBail := &db.Bail{
		ID:              bailID1,
		UserID:          uuid.New(),
		Name:            "bad_bail",
		Description:     "This will fail",
		Enabled:         true,
		Definition:      badDef,
		DestinationForm: "bailout_form",
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}

	// Second bail is good
	goodBail := createTestBail(bailID2, "good_bail", "immediate", nil, nil, nil)

	store := &mockBailStore{
		bails:         []*db.Bail{badBail, goodBail},
		lastExecution: nil,
	}
	query := &mockQueryExecutor{
		results: []map[string]interface{}{
			{"userid": "user1", "pageid": "page1", "platform": "messenger"},
		},
	}
	sender := &mockBailSender{}

	executor := New(store, query, sender, 100)

	err := executor.Run(context.Background())
	if err != nil {
		t.Errorf("Expected no error (should continue despite bad bail), got: %v", err)
	}

	// Should have sent bailouts for the good bail
	if len(sender.sentBailouts) != 1 {
		t.Errorf("Expected 1 bailout sent (from good bail), got %d", len(sender.sentBailouts))
	}

	// Should have recorded 2 events: 1 error for bad bail, 1 success for good bail
	if len(store.recordedEvents) != 2 {
		t.Fatalf("Expected 2 events recorded, got %d", len(store.recordedEvents))
	}

	// First event should be error with nil ExecutionResults
	if store.recordedEvents[0].EventType != "error" {
		t.Errorf("Expected first event to be 'error', got '%s'", store.recordedEvents[0].EventType)
	}
	if store.recordedEvents[0].ExecutionResults != nil {
		t.Error("Expected ExecutionResults to be nil for error event")
	}

	// Second event should be success with non-nil ExecutionResults
	if store.recordedEvents[1].EventType != "execution" {
		t.Errorf("Expected second event to be 'execution', got '%s'", store.recordedEvents[1].EventType)
	}
	if store.recordedEvents[1].ExecutionResults == nil {
		t.Error("Expected ExecutionResults to be non-nil for execution event")
	}
}

func TestExecutor_ProcessBail_PanicRecovery(t *testing.T) {
	bailID := uuid.New()
	bail := createTestBail(bailID, "panic_bail", "immediate", nil, nil, nil)

	store := &mockBailStore{
		bails:         []*db.Bail{bail},
		lastExecution: nil,
	}

	// Query executor that panics
	query := &mockQueryExecutor{
		queryError: nil,
	}

	sender := &mockBailSender{}

	executor := New(store, query, sender, 100)

	// Modify the query to cause a panic when processing results
	// We'll simulate this by having Query return invalid data
	query.results = []map[string]interface{}{
		{"invalid_column": "test"}, // Missing userid and pageid
	}

	err := executor.Run(context.Background())

	// Should not panic, even though processing failed
	if err != nil {
		t.Errorf("Expected no error (panic should be recovered), got: %v", err)
	}

	// No valid users were parsed from results, so no event should be recorded
	if len(store.recordedEvents) != 0 {
		t.Errorf("Expected no events recorded, got %d", len(store.recordedEvents))
	}
}

func TestExecutor_Run_SystemError(t *testing.T) {
	store := &mockBailStore{
		getBailsError: errors.New("database connection failed"),
	}
	query := &mockQueryExecutor{}
	sender := &mockBailSender{}

	executor := New(store, query, sender, 100)

	err := executor.Run(context.Background())

	// System errors should be returned
	if err == nil {
		t.Error("Expected error for system failure, got nil")
	}

	if !errors.Is(err, errors.New("failed to load enabled bails: database connection failed")) &&
		err.Error() != "failed to load enabled bails: database connection failed" {
		t.Errorf("Expected specific error message, got: %v", err)
	}
}

func TestExecutor_Run_QueryError(t *testing.T) {
	bailID := uuid.New()
	bail := createTestBail(bailID, "query_error_bail", "immediate", nil, nil, nil)

	store := &mockBailStore{
		bails:         []*db.Bail{bail},
		lastExecution: nil,
	}
	query := &mockQueryExecutor{
		queryError: errors.New("SQL syntax error"),
	}
	sender := &mockBailSender{}

	executor := New(store, query, sender, 100)

	err := executor.Run(context.Background())

	// Should not return error (bail errors are isolated)
	if err != nil {
		t.Errorf("Expected no error (bail errors isolated), got: %v", err)
	}

	// Should have recorded an error event
	if len(store.recordedEvents) != 1 {
		t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
	}

	event := store.recordedEvents[0]
	if event.EventType != "error" {
		t.Errorf("Expected event type 'error', got '%s'", event.EventType)
	}
}

func TestExecutor_Run_PartialSendFailure(t *testing.T) {
	bailID := uuid.New()
	bail := createTestBail(bailID, "partial_fail_bail", "immediate", nil, nil, nil)

	store := &mockBailStore{
		bails:         []*db.Bail{bail},
		lastExecution: nil,
	}
	query := &mockQueryExecutor{
		results: []map[string]interface{}{
			{"userid": "user1", "pageid": "page1", "platform": "messenger"},
			{"userid": "user2", "pageid": "page2", "platform": "messenger"},
			{"userid": "user3", "pageid": "page3", "platform": "messenger"},
		},
	}

	// Sender that partially fails
	sender := &mockBailSender{
		returnIDs: []string{"user1", "user3"}, // 2 out of 3 succeeded
		sendError: errors.New("some sends failed"),
	}

	executor := New(store, query, sender, 100)

	err := executor.Run(context.Background())

	// Should not return system error
	if err != nil {
		t.Errorf("Expected no error (partial failure handled), got: %v", err)
	}

	// Should have recorded a success event with partial counts
	if len(store.recordedEvents) != 1 {
		t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
	}

	event := store.recordedEvents[0]
	if event.EventType != "execution" {
		t.Errorf("Expected event type 'execution', got '%s'", event.EventType)
	}
	if event.UsersMatched != 3 {
		t.Errorf("Expected 3 users matched, got %d", event.UsersMatched)
	}
	if event.UsersBailed != 2 {
		t.Errorf("Expected 2 users bailed (partial success), got %d", event.UsersBailed)
	}
}

func TestExecutor_Run_RespectLimit(t *testing.T) {
	bailID := uuid.New()
	bail := createTestBail(bailID, "limited_bail", "immediate", nil, nil, nil)

	store := &mockBailStore{
		bails:         []*db.Bail{bail},
		lastExecution: nil,
	}
	query := &mockQueryExecutor{
		results: []map[string]interface{}{
			{"userid": "user1", "pageid": "page1", "platform": "messenger"},
			{"userid": "user2", "pageid": "page2", "platform": "messenger"},
			{"userid": "user3", "pageid": "page3", "platform": "messenger"},
			{"userid": "user4", "pageid": "page4", "platform": "messenger"},
			{"userid": "user5", "pageid": "page5", "platform": "messenger"},
		},
	}
	sender := &mockBailSender{}

	// Set limit to 3
	executor := New(store, query, sender, 3)

	err := executor.Run(context.Background())
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}

	// Should have sent bailouts for only 3 users (limit)
	if len(sender.sentBailouts) != 3 {
		t.Errorf("Expected 3 bailouts sent (limit), got %d", len(sender.sentBailouts))
	}

	// Should have recorded matched=5, bailed=3
	if len(store.recordedEvents) != 1 {
		t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
	}

	event := store.recordedEvents[0]
	if event.UsersMatched != 5 {
		t.Errorf("Expected 5 users matched, got %d", event.UsersMatched)
	}
	if event.UsersBailed != 3 {
		t.Errorf("Expected 3 users bailed (limit), got %d", event.UsersBailed)
	}
}

func TestExecutor_Run_NoUsersMatched(t *testing.T) {
	bailID := uuid.New()
	bail := createTestBail(bailID, "no_match_bail", "immediate", nil, nil, nil)

	store := &mockBailStore{
		bails:         []*db.Bail{bail},
		lastExecution: nil,
	}
	query := &mockQueryExecutor{
		results: []map[string]interface{}{}, // No users match
	}
	sender := &mockBailSender{}

	executor := New(store, query, sender, 100)

	err := executor.Run(context.Background())
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}

	// Should not have sent any bailouts
	if len(sender.sentBailouts) != 0 {
		t.Errorf("Expected no bailouts sent, got %d", len(sender.sentBailouts))
	}

	// Should not record any event when no users matched
	if len(store.recordedEvents) != 0 {
		t.Fatalf("Expected 0 events recorded, got %d", len(store.recordedEvents))
	}
}

func TestExecutor_Run_ContextCancellation(t *testing.T) {
	bailID := uuid.New()
	bail := createTestBail(bailID, "cancelled_bail", "immediate", nil, nil, nil)

	store := &mockBailStore{
		bails:         []*db.Bail{bail},
		lastExecution: nil,
	}
	query := &mockQueryExecutor{
		results: []map[string]interface{}{
			{"userid": "user1", "pageid": "page1", "platform": "messenger"},
		},
	}
	sender := &mockBailSender{}

	executor := New(store, query, sender, 100)

	// Create a cancelled context
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	err := executor.Run(ctx)

	// Should return context error
	if err == nil {
		t.Error("Expected error for cancelled context, got nil")
	}

	if !errors.Is(err, context.Canceled) {
		t.Errorf("Expected context.Canceled error, got: %v", err)
	}
}

func TestExecutor_Run_UserListBail(t *testing.T) {
	bailID := uuid.New()
	owner := uuid.New()

	// Create a user_list type bail with 2 users
	users := []map[string]interface{}{
		{
			"userid":    "user1",
			"pageid":    "page1",
			"shortcode": "form1",
		},
		{
			"userid":    "user2",
			"pageid":    "page2",
			"shortcode": "form2",
		},
	}
	bail := createTestUserListBail(bailID, owner, "userlist_bail", users, "immediate")

	store := &mockBailStore{
		bails:         []*db.Bail{bail},
		lastExecution: nil,
		credentials:   ownedCredentials(owner, platform.EntityFacebookPage, "page1", "page2"),
	}
	query := &mockQueryExecutor{} // No query should be executed for user_list type
	sender := &mockBailSender{}

	executor := New(store, query, sender, 100)

	err := executor.Run(context.Background())
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}

	// Should have sent bailouts for both users from the list (not from query)
	if len(sender.sentBailouts) != 2 {
		t.Errorf("Expected 2 bailouts sent, got %d", len(sender.sentBailouts))
	}

	// Check that destination forms were set correctly (from shortcodes)
	if sender.sentBailouts[0].DestinationForm != "form1" {
		t.Errorf("Expected first user destination form 'form1', got '%s'", sender.sentBailouts[0].DestinationForm)
	}
	if sender.sentBailouts[1].DestinationForm != "form2" {
		t.Errorf("Expected second user destination form 'form2', got '%s'", sender.sentBailouts[1].DestinationForm)
	}

	for _, target := range sender.sentBailouts {
		if target.Platform != platform.Messenger {
			t.Errorf("Expected platform resolved from the account's credential, got '%s' for user %s", target.Platform, target.UserID)
		}
	}

	// Should have recorded a success event
	if len(store.recordedEvents) != 1 {
		t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
	}

	event := store.recordedEvents[0]
	if event.EventType != "execution" {
		t.Errorf("Expected event type 'execution', got '%s'", event.EventType)
	}
	if event.UsersMatched != 2 {
		t.Errorf("Expected 2 users matched, got %d", event.UsersMatched)
	}
	if event.UsersBailed != 2 {
		t.Errorf("Expected 2 users bailed, got %d", event.UsersBailed)
	}
}

func TestExecutor_Run_UserListBail_WithLimit(t *testing.T) {
	bailID := uuid.New()
	owner := uuid.New()

	// Create a user_list type bail with 3 users
	users := []map[string]interface{}{
		{"userid": "user1", "pageid": "page1", "shortcode": "form1"},
		{"userid": "user2", "pageid": "page2", "shortcode": "form2"},
		{"userid": "user3", "pageid": "page3", "shortcode": "form3"},
	}
	bail := createTestUserListBail(bailID, owner, "userlist_limited_bail", users, "immediate")

	store := &mockBailStore{
		bails:         []*db.Bail{bail},
		lastExecution: nil,
		credentials:   ownedCredentials(owner, platform.EntityFacebookPage, "page1", "page2", "page3"),
	}
	query := &mockQueryExecutor{}
	sender := &mockBailSender{}

	// Set limit to 2
	executor := New(store, query, sender, 2)

	err := executor.Run(context.Background())
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}

	// Should have sent bailouts for only 2 users (limit)
	if len(sender.sentBailouts) != 2 {
		t.Errorf("Expected 2 bailouts sent (limit), got %d", len(sender.sentBailouts))
	}

	// Should have recorded matched=3, bailed=2
	if len(store.recordedEvents) != 1 {
		t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
	}

	event := store.recordedEvents[0]
	if event.UsersMatched != 3 {
		t.Errorf("Expected 3 users matched, got %d", event.UsersMatched)
	}
	if event.UsersBailed != 2 {
		t.Errorf("Expected 2 users bailed (limit), got %d", event.UsersBailed)
	}
}

// The error message must reach the database as valid JSON even when it quotes
// the offending value, as every timing error does.
func TestRecordError_MessageWithQuotesIsValidJSON(t *testing.T) {
	store := &mockBailStore{}
	exec := New(store, &mockQueryExecutor{}, &mockBailSender{}, 100)
	bail := &db.Bail{ID: uuid.New(), UserID: uuid.New(), Name: "quoted"}
	msg := `timing check failed: invalid datetime "2026-06-01T09:00:00Z": must be in YYYY-MM-DDTHH:MM:SS format`

	if err := exec.recordError(context.Background(), bail, errors.New(msg)); err != nil {
		t.Fatalf("recordError() error = %v", err)
	}
	if len(store.recordedEvents) != 1 {
		t.Fatalf("recorded %d events, want 1", len(store.recordedEvents))
	}

	encoded, err := json.Marshal(store.recordedEvents[0].Error)
	if err != nil {
		t.Fatalf("error event is not valid JSON: %v", err)
	}
	var decoded map[string]string
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal error event: %v", err)
	}
	if decoded["message"] != msg {
		t.Errorf("message = %q, want %q", decoded["message"], msg)
	}
}

// A user_list names accounts the owner may no longer hold. Those targets are
// skipped rather than sent with a guessed platform, and the skips are recorded
// so the researcher can see who was not reached and why.
func TestExecutor_Run_UserListBail_RecordsSkippedTargets(t *testing.T) {
	bailID := uuid.New()
	owner := uuid.New()
	stranger := uuid.New()

	users := []map[string]interface{}{
		{"userid": "user_fb", "pageid": "page_fb", "shortcode": "form1"},
		{"userid": "user_wa", "pageid": "page_wa", "shortcode": "form2"},
		{"userid": "user_unowned", "pageid": "page_unowned", "shortcode": "form3"},
		{"userid": "user_missing", "pageid": "page_missing", "shortcode": "form4"},
	}
	bail := createTestUserListBail(bailID, owner, "userlist_mixed_bail", users, "immediate")

	credentials := ownedCredentials(owner, platform.EntityFacebookPage, "page_fb")
	credentials["page_wa"] = platform.Credential{PageID: "page_wa", Entity: platform.EntityWhatsAppBusiness, OwnerID: owner}
	credentials["page_unowned"] = platform.Credential{PageID: "page_unowned", Entity: platform.EntityFacebookPage, OwnerID: stranger}

	store := &mockBailStore{
		bails:       []*db.Bail{bail},
		credentials: credentials,
	}
	snd := &mockBailSender{}

	executor := New(store, &mockQueryExecutor{}, snd, 100)

	if err := executor.Run(context.Background()); err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	if len(snd.sentBailouts) != 2 {
		t.Fatalf("Expected 2 bailouts sent, got %d: %+v", len(snd.sentBailouts), snd.sentBailouts)
	}
	if got := snd.sentBailouts[0]; got.UserID != "user_fb" || got.Platform != platform.Messenger {
		t.Errorf("Expected user_fb on messenger, got %+v", got)
	}
	if got := snd.sentBailouts[1]; got.UserID != "user_wa" || got.Platform != platform.WhatsApp {
		t.Errorf("Expected user_wa on whatsapp, got %+v", got)
	}

	if len(store.recordedEvents) != 1 {
		t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
	}
	event := store.recordedEvents[0]
	if event.UsersMatched != 2 {
		t.Errorf("Expected 2 users matched (resolved targets only), got %d", event.UsersMatched)
	}
	if event.UsersBailed != 2 {
		t.Errorf("Expected 2 users bailed, got %d", event.UsersBailed)
	}

	results := executionResults(t, event)
	skipped, ok := results["skipped"].([]interface{})
	if !ok {
		t.Fatalf("Expected a skipped array in execution_results, got: %v", results)
	}
	if len(skipped) != 2 {
		t.Fatalf("Expected 2 skipped targets, got %d: %v", len(skipped), skipped)
	}

	want := []map[string]interface{}{
		{"userid": "user_unowned", "pageid": "page_unowned", "reason": platform.ReasonNotOwned},
		{"userid": "user_missing", "pageid": "page_missing", "reason": platform.ReasonNotFound},
	}
	for i, expected := range want {
		got, ok := skipped[i].(map[string]interface{})
		if !ok {
			t.Fatalf("skipped[%d] is not an object: %v", i, skipped[i])
		}
		for key, value := range expected {
			if got[key] != value {
				t.Errorf("skipped[%d][%q] = %v, want %v", i, key, got[key], value)
			}
		}
	}
}

// A run that reached nobody because every target was skipped still needs an
// event: without one the researcher sees no trace of a bail that did nothing.
func TestExecutor_Run_UserListBail_AllSkippedStillRecordsEvent(t *testing.T) {
	bailID := uuid.New()
	owner := uuid.New()

	users := []map[string]interface{}{
		{"userid": "user1", "pageid": "page_missing_1", "shortcode": "form1"},
		{"userid": "user2", "pageid": "page_missing_2", "shortcode": "form2"},
	}
	bail := createTestUserListBail(bailID, owner, "userlist_all_skipped", users, "immediate")

	store := &mockBailStore{bails: []*db.Bail{bail}}
	snd := &mockBailSender{}

	executor := New(store, &mockQueryExecutor{}, snd, 100)

	if err := executor.Run(context.Background()); err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	if len(snd.sentBailouts) != 0 {
		t.Errorf("Expected no bailouts sent, got %d", len(snd.sentBailouts))
	}
	if len(store.recordedEvents) != 1 {
		t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
	}

	event := store.recordedEvents[0]
	if event.EventType != "execution" {
		t.Errorf("Expected event type 'execution', got '%s'", event.EventType)
	}
	if event.UsersMatched != 0 || event.UsersBailed != 0 {
		t.Errorf("Expected 0 matched and 0 bailed, got %d and %d", event.UsersMatched, event.UsersBailed)
	}

	results := executionResults(t, event)
	skipped, ok := results["skipped"].([]interface{})
	if !ok || len(skipped) != 2 {
		t.Fatalf("Expected 2 skipped targets in execution_results, got: %v", results)
	}
	bailed, ok := results["user_ids"].([]interface{})
	if !ok || len(bailed) != 0 {
		t.Errorf("Expected an empty user_ids list, got: %v", results["user_ids"])
	}
}

// A conditions query joins credentials, so every row it returns already has a
// transport. A row without one means the query is not the one this executor
// expects, which fails the bail instead of reaching people with a guess.
func TestExecutor_Run_ConditionsBail_UnusablePlatformFailsLoudly(t *testing.T) {
	tests := []struct {
		name string
		row  map[string]interface{}
	}{
		{name: "null platform", row: map[string]interface{}{"userid": "user1", "pageid": "page1", "platform": nil}},
		{name: "empty platform", row: map[string]interface{}{"userid": "user1", "pageid": "page1", "platform": ""}},
		{name: "missing platform column", row: map[string]interface{}{"userid": "user1", "pageid": "page1"}},
		{name: "unknown platform", row: map[string]interface{}{"userid": "user1", "pageid": "page1", "platform": "telegram"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bail := createTestBail(uuid.New(), "platform_bail", "immediate", nil, nil, nil)
			store := &mockBailStore{bails: []*db.Bail{bail}}
			query := &mockQueryExecutor{results: []map[string]interface{}{tt.row}}
			snd := &mockBailSender{}

			executor := New(store, query, snd, 100)

			if err := executor.Run(context.Background()); err != nil {
				t.Fatalf("Expected no error from Run (bail errors are isolated), got: %v", err)
			}

			if len(snd.sentBailouts) != 0 {
				t.Errorf("Expected no bailouts sent, got %d", len(snd.sentBailouts))
			}
			if len(store.recordedEvents) != 1 {
				t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
			}
			if store.recordedEvents[0].EventType != "error" {
				t.Errorf("Expected an error event, got '%s'", store.recordedEvents[0].EventType)
			}
		})
	}
}

// postedEvents runs the executor against a real sender and returns the JSON
// bodies botserver received, decoded exactly as they went over the wire.
func postedEvents(t *testing.T, store *mockBailStore) []map[string]interface{} {
	t.Helper()

	var bodies []map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("reading posted body: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		var body map[string]interface{}
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("posted body is not valid JSON: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		bodies = append(bodies, body)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	executor := New(store, &mockQueryExecutor{}, sender.New(server.URL, 0, false), 100)
	if err := executor.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	return bodies
}

// VIR-64: a Messenger user_list bail went out with "platform": "", replybot took
// its degraded path, and 463 of 587 users silently lost the form switch. The
// platform on the wire must come from the account's credential and must never be
// empty.
func TestExecutor_Run_VIR64_UserListBailPostsPlatformFromCredential(t *testing.T) {
	owner := uuid.New()

	users := []map[string]interface{}{
		{"userid": "user_fb", "pageid": "page_fb", "shortcode": "form1"},
		{"userid": "user_wa", "pageid": "page_wa", "shortcode": "form2"},
	}
	bail := createTestUserListBail(uuid.New(), owner, "vir64_bail", users, "immediate")

	credentials := ownedCredentials(owner, platform.EntityFacebookPage, "page_fb")
	credentials["page_wa"] = platform.Credential{PageID: "page_wa", Entity: platform.EntityWhatsAppBusiness, OwnerID: owner}

	bodies := postedEvents(t, &mockBailStore{bails: []*db.Bail{bail}, credentials: credentials})

	if len(bodies) != 2 {
		t.Fatalf("Expected 2 posted events, got %d: %v", len(bodies), bodies)
	}

	want := map[string]string{"user_fb": platform.Messenger, "user_wa": platform.WhatsApp}
	for _, body := range bodies {
		user, _ := body["user"].(string)
		expected, known := want[user]
		if !known {
			t.Errorf("Unexpected user in posted event: %v", body)
			continue
		}
		got, ok := body["platform"].(string)
		if !ok || got == "" {
			t.Errorf("Posted event for %s carries no platform: %v", user, body)
			continue
		}
		if got != expected {
			t.Errorf("Posted event for %s has platform %q, want %q", user, got, expected)
		}
	}
}

// Definitions saved before the platform was resolved still carry one per entry.
// The stored value is ignored: only the account's credential decides.
func TestExecutor_Run_UserListBail_StoredPlatformLosesToCredential(t *testing.T) {
	owner := uuid.New()

	users := []map[string]interface{}{
		{"userid": "user1", "pageid": "page_fb", "platform": "whatsapp", "shortcode": "form1"},
	}
	bail := createTestUserListBail(uuid.New(), owner, "stored_platform_bail", users, "immediate")

	store := &mockBailStore{
		bails:       []*db.Bail{bail},
		credentials: ownedCredentials(owner, platform.EntityFacebookPage, "page_fb"),
	}

	bodies := postedEvents(t, store)

	if len(bodies) != 1 {
		t.Fatalf("Expected 1 posted event, got %d: %v", len(bodies), bodies)
	}
	if got := bodies[0]["platform"]; got != platform.Messenger {
		t.Errorf("Posted platform = %v, want %q: the credential decides, not the stored value",
			got, platform.Messenger)
	}
}
