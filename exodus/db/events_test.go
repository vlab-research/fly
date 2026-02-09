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

	// Create an event
	event := &BailEvent{
		BailID:             &bail.ID,
		UserID:           userID,
		BailName:           bail.Name,
		EventType:          "execution",
		UsersMatched:       10,
		UsersBailed:        8,
		DefinitionSnapshot: bail.Definition,
		Error:              nil,
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
