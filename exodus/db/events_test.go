package db

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRecordEvent(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	userID := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	// Create a bail to reference
	bail := &Bail{
		UserID:        userID,
		Name:            "test-bail",
		Description:     "Test bail",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm:  "exit-form",
	}
	err := db.CreateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	// Build execution_results
	execResultsData, _ := json.Marshal(map[string]interface{}{"user_ids": []string{"uid1", "uid2"}})
	execResults := json.RawMessage(execResultsData)

	// Create an event
	event := &BailEvent{
		BailID:             &bail.ID,
		UserID:             userID,
		BailName:           bail.Name,
		EventType:          "execution",
		UsersMatched:       10,
		UsersBailed:        8,
		DefinitionSnapshot: bail.Definition,
		Error:              nil,
		ExecutionResults:   &execResults,
	}

	// Test RecordEvent
	err = db.RecordEvent(context.Background(), event)
	if err != nil {
		t.Fatalf("RecordEvent failed: %v", err)
	}

	// Verify ID and Timestamp were generated
	if event.ID == uuid.Nil {
		t.Error("Expected event ID to be generated")
	}
	if event.Timestamp.IsZero() {
		t.Error("Expected timestamp to be generated")
	}

	// Retrieve and verify ExecutionResults is stored and readable
	events, err := db.GetEventsByBailID(context.Background(), bail.ID)
	if err != nil {
		t.Fatalf("GetEventsByBailID failed: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("Expected 1 event, got %d", len(events))
	}
	if events[0].ExecutionResults == nil {
		t.Error("Expected ExecutionResults to be non-nil for execution event")
	}
	var result map[string]interface{}
	if err := json.Unmarshal(*events[0].ExecutionResults, &result); err != nil {
		t.Fatalf("Failed to unmarshal ExecutionResults: %v", err)
	}
	userIDs, ok := result["user_ids"].([]interface{})
	if !ok || len(userIDs) != 2 {
		t.Errorf("Expected user_ids with 2 entries, got %v", result["user_ids"])
	}
}

func TestRecordErrorEvent(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	userID := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	// Create a bail
	bail := &Bail{
		UserID:        userID,
		Name:            "error-test-bail",
		Description:     "Test bail for errors",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm:  "exit-form",
	}
	err := db.CreateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	// Create an error event with error details
	errorData := map[string]string{
		"message": "Test error",
		"code":    "TEST_ERROR",
	}
	errorJSON, _ := json.Marshal(errorData)
	errorRaw := json.RawMessage(errorJSON)

	event := &BailEvent{
		BailID:             &bail.ID,
		UserID:           userID,
		BailName:           bail.Name,
		EventType:          "error",
		UsersMatched:       0,
		UsersBailed:        0,
		DefinitionSnapshot: bail.Definition,
		Error:              &errorRaw,
	}

	err = db.RecordEvent(context.Background(), event)
	if err != nil {
		t.Fatalf("RecordEvent failed: %v", err)
	}

	// Retrieve and verify error field
	events, err := db.GetEventsByBailID(context.Background(), bail.ID)
	if err != nil {
		t.Fatalf("GetEventsByBailID failed: %v", err)
	}

	if len(events) != 1 {
		t.Fatalf("Expected 1 event, got %d", len(events))
	}

	if events[0].Error == nil {
		t.Error("Expected error field to be populated")
	}
	if events[0].EventType != "error" {
		t.Errorf("Expected event_type 'error', got %s", events[0].EventType)
	}
	if events[0].ExecutionResults != nil {
		t.Error("Expected ExecutionResults to be nil for error event")
	}
}

func TestGetEventsByBailID(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	userID := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	// Create two bails
	bail1 := &Bail{
		UserID:        userID,
		Name:            "bail-1",
		Description:     "Bail 1",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm:  "exit-form-1",
	}
	err := db.CreateBail(context.Background(), bail1)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	bail2 := &Bail{
		UserID:        userID,
		Name:            "bail-2",
		Description:     "Bail 2",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm:  "exit-form-2",
	}
	err = db.CreateBail(context.Background(), bail2)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	// Create events for bail 1
	for i := 0; i < 3; i++ {
		event := &BailEvent{
			BailID:             &bail1.ID,
			UserID:           userID,
			BailName:           bail1.Name,
			EventType:          "execution",
			UsersMatched:       10 + i,
			UsersBailed:        8 + i,
			DefinitionSnapshot: bail1.Definition,
		}
		err := db.RecordEvent(context.Background(), event)
		if err != nil {
			t.Fatalf("RecordEvent failed: %v", err)
		}
		time.Sleep(time.Millisecond) // Ensure different timestamps
	}

	// Create events for bail 2
	for i := 0; i < 2; i++ {
		event := &BailEvent{
			BailID:             &bail2.ID,
			UserID:           userID,
			BailName:           bail2.Name,
			EventType:          "execution",
			UsersMatched:       5 + i,
			UsersBailed:        4 + i,
			DefinitionSnapshot: bail2.Definition,
		}
		err := db.RecordEvent(context.Background(), event)
		if err != nil {
			t.Fatalf("RecordEvent failed: %v", err)
		}
	}

	// Test GetEventsByBailID for bail 1
	events1, err := db.GetEventsByBailID(context.Background(), bail1.ID)
	if err != nil {
		t.Fatalf("GetEventsByBailID failed: %v", err)
	}
	if len(events1) != 3 {
		t.Errorf("Expected 3 events for bail 1, got %d", len(events1))
	}

	// Verify events are ordered by timestamp descending (most recent first)
	for i := 0; i < len(events1)-1; i++ {
		if events1[i].Timestamp.Before(events1[i+1].Timestamp) {
			t.Error("Events should be ordered by timestamp descending")
		}
	}

	// Verify all events belong to bail 1
	for _, e := range events1 {
		if e.BailID == nil || *e.BailID != bail1.ID {
			t.Errorf("Expected event to belong to bail %s", bail1.ID)
		}
	}

	// Test GetEventsByBailID for bail 2
	events2, err := db.GetEventsByBailID(context.Background(), bail2.ID)
	if err != nil {
		t.Fatalf("GetEventsByBailID failed: %v", err)
	}
	if len(events2) != 2 {
		t.Errorf("Expected 2 events for bail 2, got %d", len(events2))
	}
}

func TestGetEventsByUser(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	userID1 := SetupTestUser(t, pool)
	userID2 := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	// Create a bail for survey 1
	bail1 := &Bail{
		UserID:        userID1,
		Name:            "survey1-bail",
		Description:     "Bail for survey 1",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm:  "exit-form",
	}
	err := db.CreateBail(context.Background(), bail1)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	// Create a bail for survey 2
	bail2 := &Bail{
		UserID:        userID2,
		Name:            "survey2-bail",
		Description:     "Bail for survey 2",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm:  "exit-form",
	}
	err = db.CreateBail(context.Background(), bail2)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	// Create 5 events for survey 1
	for i := 0; i < 5; i++ {
		event := &BailEvent{
			BailID:             &bail1.ID,
			UserID:           userID1,
			BailName:           bail1.Name,
			EventType:          "execution",
			UsersMatched:       10,
			UsersBailed:        8,
			DefinitionSnapshot: bail1.Definition,
		}
		err := db.RecordEvent(context.Background(), event)
		if err != nil {
			t.Fatalf("RecordEvent failed: %v", err)
		}
		time.Sleep(time.Millisecond)
	}

	// Create 3 events for survey 2
	for i := 0; i < 3; i++ {
		event := &BailEvent{
			BailID:             &bail2.ID,
			UserID:           userID2,
			BailName:           bail2.Name,
			EventType:          "execution",
			UsersMatched:       5,
			UsersBailed:        4,
			DefinitionSnapshot: bail2.Definition,
		}
		err := db.RecordEvent(context.Background(), event)
		if err != nil {
			t.Fatalf("RecordEvent failed: %v", err)
		}
	}

	// Test GetEventsByUser with limit
	events, err := db.GetEventsByUser(context.Background(), userID1, 3)
	if err != nil {
		t.Fatalf("GetEventsByUser failed: %v", err)
	}

	// Should return only 3 events (limit applied)
	if len(events) != 3 {
		t.Errorf("Expected 3 events (limited), got %d", len(events))
	}

	// Verify all events belong to survey 1
	for _, e := range events {
		if e.UserID != userID1 {
			t.Errorf("Expected event to belong to survey %s", userID1)
		}
	}

	// Test with larger limit to get all events
	allEvents, err := db.GetEventsByUser(context.Background(), userID1, 100)
	if err != nil {
		t.Fatalf("GetEventsByUser failed: %v", err)
	}
	if len(allEvents) != 5 {
		t.Errorf("Expected 5 events total, got %d", len(allEvents))
	}
}

func TestGetLastSuccessfulExecution(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	userID := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	// Create a bail
	bail := &Bail{
		UserID:        userID,
		Name:            "last-execution-test",
		Description:     "Test last execution",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm:  "exit-form",
	}
	err := db.CreateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	// Test with no executions yet
	lastTime, err := db.GetLastSuccessfulExecution(context.Background(), bail.ID)
	if err != nil {
		t.Fatalf("GetLastSuccessfulExecution failed: %v", err)
	}
	if lastTime != nil {
		t.Error("Expected nil for bail with no executions")
	}

	// Record an error event (should not count)
	errorEvent := &BailEvent{
		BailID:             &bail.ID,
		UserID:           userID,
		BailName:           bail.Name,
		EventType:          "error",
		UsersMatched:       0,
		UsersBailed:        0,
		DefinitionSnapshot: bail.Definition,
	}
	err = db.RecordEvent(context.Background(), errorEvent)
	if err != nil {
		t.Fatalf("RecordEvent failed: %v", err)
	}

	// Still should be nil (error events don't count)
	lastTime, err = db.GetLastSuccessfulExecution(context.Background(), bail.ID)
	if err != nil {
		t.Fatalf("GetLastSuccessfulExecution failed: %v", err)
	}
	if lastTime != nil {
		t.Error("Expected nil (error events should not count)")
	}

	// Record first execution
	firstExecution := &BailEvent{
		BailID:             &bail.ID,
		UserID:           userID,
		BailName:           bail.Name,
		EventType:          "execution",
		UsersMatched:       10,
		UsersBailed:        8,
		DefinitionSnapshot: bail.Definition,
	}
	err = db.RecordEvent(context.Background(), firstExecution)
	if err != nil {
		t.Fatalf("RecordEvent failed: %v", err)
	}

	time.Sleep(10 * time.Millisecond)

	// Record second execution
	secondExecution := &BailEvent{
		BailID:             &bail.ID,
		UserID:           userID,
		BailName:           bail.Name,
		EventType:          "execution",
		UsersMatched:       12,
		UsersBailed:        10,
		DefinitionSnapshot: bail.Definition,
	}
	err = db.RecordEvent(context.Background(), secondExecution)
	if err != nil {
		t.Fatalf("RecordEvent failed: %v", err)
	}

	// Should return the most recent execution time
	lastTime, err = db.GetLastSuccessfulExecution(context.Background(), bail.ID)
	if err != nil {
		t.Fatalf("GetLastSuccessfulExecution failed: %v", err)
	}
	if lastTime == nil {
		t.Fatal("Expected last execution time to be non-nil")
	}

	// Verify it's the second execution (most recent)
	if !lastTime.Equal(secondExecution.Timestamp) {
		t.Errorf("Expected timestamp %v, got %v", secondExecution.Timestamp, *lastTime)
	}

	// Should be after the first execution
	if !lastTime.After(firstExecution.Timestamp) {
		t.Error("Last execution should be after first execution")
	}
}

func TestGetLatestEventsByBailIDs(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	userID := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	def := CreateTestBailDefinition()

	// Three bails: two with events, one without.
	bailWithEvents := &Bail{
		UserID:          userID,
		Name:            "bail-with-events",
		Definition:      def,
		DestinationForm: "exit-form",
	}
	if err := db.CreateBail(context.Background(), bailWithEvents); err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	bailWithoutEvents := &Bail{
		UserID:          userID,
		Name:            "bail-without-events",
		Definition:      def,
		DestinationForm: "exit-form",
	}
	if err := db.CreateBail(context.Background(), bailWithoutEvents); err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	bailOther := &Bail{
		UserID:          userID,
		Name:            "bail-other",
		Definition:      def,
		DestinationForm: "exit-form",
	}
	if err := db.CreateBail(context.Background(), bailOther); err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	// Three events for bailWithEvents; we want the most recent one returned.
	older := &BailEvent{
		BailID:             &bailWithEvents.ID,
		UserID:             userID,
		BailName:           bailWithEvents.Name,
		EventType:          "execution",
		UsersMatched:       5,
		UsersBailed:        5,
		DefinitionSnapshot: def,
	}
	if err := db.RecordEvent(context.Background(), older); err != nil {
		t.Fatalf("RecordEvent failed: %v", err)
	}
	time.Sleep(10 * time.Millisecond)
	middle := &BailEvent{
		BailID:             &bailWithEvents.ID,
		UserID:             userID,
		BailName:           bailWithEvents.Name,
		EventType:          "execution",
		UsersMatched:       7,
		UsersBailed:        7,
		DefinitionSnapshot: def,
	}
	if err := db.RecordEvent(context.Background(), middle); err != nil {
		t.Fatalf("RecordEvent failed: %v", err)
	}
	time.Sleep(10 * time.Millisecond)
	newest := &BailEvent{
		BailID:             &bailWithEvents.ID,
		UserID:             userID,
		BailName:           bailWithEvents.Name,
		EventType:          "execution",
		UsersMatched:       9,
		UsersBailed:        9,
		DefinitionSnapshot: def,
	}
	if err := db.RecordEvent(context.Background(), newest); err != nil {
		t.Fatalf("RecordEvent failed: %v", err)
	}

	// And include an event for bailOther, but query only bailWithEvents to verify filtering.
	otherEvent := &BailEvent{
		BailID:             &bailOther.ID,
		UserID:             userID,
		BailName:           bailOther.Name,
		EventType:          "execution",
		UsersMatched:       1,
		UsersBailed:        1,
		DefinitionSnapshot: def,
	}
	if err := db.RecordEvent(context.Background(), otherEvent); err != nil {
		t.Fatalf("RecordEvent failed: %v", err)
	}

	// Empty input -> empty map, no error.
	empty, err := db.GetLatestEventsByBailIDs(context.Background(), nil)
	if err != nil {
		t.Fatalf("GetLatestEventsByBailIDs(nil) failed: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("Expected empty map for nil input, got %d entries", len(empty))
	}

	// Query just the bail with events -> one entry pointing at the newest event.
	got := map[uuid.UUID]*BailEvent{}
	got, err = db.GetLatestEventsByBailIDs(context.Background(), []uuid.UUID{bailWithEvents.ID})
	if err != nil {
		t.Fatalf("GetLatestEventsByBailIDs single bail failed: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("Expected 1 entry, got %d", len(got))
	}
	latest, ok := got[bailWithEvents.ID]
	if !ok {
		t.Fatalf("Expected entry for bail %s", bailWithEvents.ID)
	}
	if latest.ID != newest.ID {
		t.Errorf("Expected most recent event %s, got %s", newest.ID, latest.ID)
	}

	// Query all three bails: bailWithEvents has an entry, bailWithoutEvents does not,
	// bailOther is included even though we excluded it above.
	all, err := db.GetLatestEventsByBailIDs(context.Background(), []uuid.UUID{
		bailWithEvents.ID,
		bailWithoutEvents.ID,
		bailOther.ID,
	})
	if err != nil {
		t.Fatalf("GetLatestEventsByBailIDs multiple bails failed: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("Expected 2 entries (one per bail with events), got %d", len(all))
	}
	if _, ok := all[bailWithoutEvents.ID]; ok {
		t.Error("Expected no entry for bail without events")
	}
	if entry, ok := all[bailOther.ID]; !ok {
		t.Error("Expected entry for bailOther")
	} else if entry.ID != otherEvent.ID {
		t.Errorf("Expected otherEvent %s, got %s", otherEvent.ID, entry.ID)
	}
}
