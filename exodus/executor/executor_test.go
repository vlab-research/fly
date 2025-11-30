package executor

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/vlab-research/exodus/db"
	"github.com/vlab-research/exodus/sender"
)

// Mock implementations for testing

type mockBailStore struct {
	bails             []*db.Bail
	lastExecution     *time.Time
	recordedEvents    []*db.BailEvent
	getBailsError     error
	getLastExecError  error
	recordEventError  error
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
	sentBailouts  []sender.UserTarget
	successCount  int
	sendError     error
}

func (m *mockBailSender) SendBailouts(ctx context.Context, users []sender.UserTarget, destinationForm string, metadata map[string]interface{}) (int, error) {
	if m.sendError != nil {
		return m.successCount, m.sendError
	}
	m.sentBailouts = append(m.sentBailouts, users...)
	m.successCount = len(users)
	return m.successCount, nil
}

// Helper functions

func createTestBail(id uuid.UUID, name string, timing string, timeOfDay, timezone, datetime *string) *db.Bail {
	surveyID := uuid.New()

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
		SurveyID:        surveyID,
		Name:            name,
		Description:     "Test bail",
		Enabled:         true,
		Definition:      defJSON,
		DestinationForm: "bailout_form",
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}
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
			{"userid": "user1", "pageid": "page1"},
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
			{"userid": "user1", "pageid": "page1"},
			{"userid": "user2", "pageid": "page2"},
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
}

func TestExecutor_Run_ContinuesOnBailError(t *testing.T) {
	bailID1 := uuid.New()
	bailID2 := uuid.New()

	// First bail will fail (invalid definition)
	badDef := []byte(`{"invalid": "json"}`)
	badBail := &db.Bail{
		ID:              bailID1,
		SurveyID:        uuid.New(),
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
			{"userid": "user1", "pageid": "page1"},
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

	// First event should be error
	if store.recordedEvents[0].EventType != "error" {
		t.Errorf("Expected first event to be 'error', got '%s'", store.recordedEvents[0].EventType)
	}

	// Second event should be success
	if store.recordedEvents[1].EventType != "execution" {
		t.Errorf("Expected second event to be 'execution', got '%s'", store.recordedEvents[1].EventType)
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

	// Should have recorded an event (since query succeeded, just no valid users)
	if len(store.recordedEvents) == 0 {
		t.Errorf("Expected at least one event recorded")
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
			{"userid": "user1", "pageid": "page1"},
			{"userid": "user2", "pageid": "page2"},
			{"userid": "user3", "pageid": "page3"},
		},
	}

	// Sender that partially fails
	sender := &mockBailSender{
		successCount: 2, // Only 2 out of 3 succeeded
		sendError:    errors.New("some sends failed"),
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
			{"userid": "user1", "pageid": "page1"},
			{"userid": "user2", "pageid": "page2"},
			{"userid": "user3", "pageid": "page3"},
			{"userid": "user4", "pageid": "page4"},
			{"userid": "user5", "pageid": "page5"},
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

	// Should still record a success event with 0 users
	if len(store.recordedEvents) != 1 {
		t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
	}

	event := store.recordedEvents[0]
	if event.EventType != "execution" {
		t.Errorf("Expected event type 'execution', got '%s'", event.EventType)
	}
	if event.UsersMatched != 0 {
		t.Errorf("Expected 0 users matched, got %d", event.UsersMatched)
	}
	if event.UsersBailed != 0 {
		t.Errorf("Expected 0 users bailed, got %d", event.UsersBailed)
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
			{"userid": "user1", "pageid": "page1"},
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
