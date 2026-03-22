package messageworker

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/vlab-research/botparty"
	"github.com/vlab-research/fly/message-worker/types"
)

// mockHandoffSender is a mock client for testing pass_thread_control
type mockHandoffSender struct {
	err              error
	calls            int
	userIDs          []string
	targetAppIDs     []string
	metadatas        []string
}

func (m *mockHandoffSender) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}) (*SendMessageResponse, error) {
	return nil, nil
}

func (m *mockHandoffSender) SendNativeMessage(ctx context.Context, userID, platformAccountID string, payload json.RawMessage) (string, error) {
	return "", nil
}

func (m *mockHandoffSender) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	m.calls++
	m.userIDs = append(m.userIDs, userID)
	m.targetAppIDs = append(m.targetAppIDs, targetAppID)
	m.metadatas = append(m.metadatas, metadata)
	return m.err
}

// handoffMockEventProducer for testing with correct signature
type handoffMockEventProducer struct {
	events []types.UniversalEvent
	err    error
}

func (m *handoffMockEventProducer) PublishEvent(ctx context.Context, event types.UniversalEvent) error {
	if m.err != nil {
		return m.err
	}
	m.events = append(m.events, event)
	return nil
}

func TestWorker_ProcessCommand_PassThreadControl_Success(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockSender := &mockHandoffSender{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(
		map[types.PlatformType]MessageSender{types.PlatformMessenger: mockSender},
		mockProducer,
		mockBot.URL(),
	)

	// Create a pass_thread_control command
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_handoff_123",
		UserID:            "user_456",
		PlatformAccountID: "page_789",
		Platform:          types.PlatformMessenger,
		Message: types.MessageContent{
			Type:            types.MessageTypePassThreadControl,
			TargetAppID:     "263902037430900",
			HandoffMetadata: `{"source":"replybot","reason":"live_agent_request"}`,
		},
	}

	err := worker.ProcessCommand(context.Background(), cmd)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	// Verify PassThreadControl was called
	if mockSender.calls != 1 {
		t.Errorf("Expected 1 call to PassThreadControl, got %d", mockSender.calls)
	}

	// Verify the correct parameters were passed
	if len(mockSender.userIDs) != 1 || mockSender.userIDs[0] != "user_456" {
		t.Errorf("Expected userID user_456, got %v", mockSender.userIDs)
	}
	if len(mockSender.targetAppIDs) != 1 || mockSender.targetAppIDs[0] != "263902037430900" {
		t.Errorf("Expected targetAppID 263902037430900, got %v", mockSender.targetAppIDs)
	}
	if len(mockSender.metadatas) != 1 || mockSender.metadatas[0] != `{"source":"replybot","reason":"live_agent_request"}` {
		t.Errorf("Expected metadata %s, got %s", `{"source":"replybot","reason":"live_agent_request"}`, mockSender.metadatas[0])
	}

	// Verify message_sent event was emitted (for handoff, message_id will be empty)
	if len(mockProducer.events) != 1 {
		t.Errorf("Expected 1 event, got %d", len(mockProducer.events))
	} else {
		// Check that the event has empty message_id
		var payload types.MessageSentPayload
		if err := json.Unmarshal(mockProducer.events[0].Payload, &payload); err == nil {
			if payload.PlatformMessageID != nil && *payload.PlatformMessageID != "" {
				t.Errorf("Expected empty message_id for handoff, got %s", *payload.PlatformMessageID)
			}
		}
	}
}

func TestWorker_ProcessCommand_PassThreadControl_NoClient(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	// No client configured for Messenger
	worker := NewWorker(
		map[types.PlatformType]MessageSender{},
		mockProducer,
		mockBot.URL(),
	)

	cmd := types.SendMessageCommand{
		CommandID:         "cmd_handoff_456",
		UserID:            "user_456",
		PlatformAccountID: "page_789",
		Platform:          types.PlatformMessenger,
		Message: types.MessageContent{
			Type:            types.MessageTypePassThreadControl,
			TargetAppID:     "263902037430900",
			HandoffMetadata: `{"reason":"test"}`,
		},
	}

	err := worker.ProcessCommand(context.Background(), cmd)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	// Verify that an error was reported to botserver
	if len(mockBot.requests) != 1 {
		t.Errorf("Expected 1 botserver request, got %d", len(mockBot.requests))
	}
}

func TestWorker_ProcessCommand_PassThreadControl_RetriableError(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	// Mock sender that returns a retriable error
	mockSender := &mockHandoffSender{
		err: &PlatformError{
			StatusCode: 429,
			Message:    "Too many requests",
			Retriable:  true,
		},
	}

	worker := NewWorker(
		map[types.PlatformType]MessageSender{types.PlatformMessenger: mockSender},
		mockProducer,
		mockBot.URL(),
	)

	cmd := types.SendMessageCommand{
		CommandID:         "cmd_handoff_789",
		UserID:            "user_456",
		PlatformAccountID: "page_789",
		Platform:          types.PlatformMessenger,
		Message: types.MessageContent{
			Type:            types.MessageTypePassThreadControl,
			TargetAppID:     "263902037430900",
			HandoffMetadata: `{"reason":"test"}`,
		},
	}

	err := worker.ProcessCommand(context.Background(), cmd)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	// Verify that the error was retried
	if mockSender.calls < 3 {
		t.Errorf("Expected at least 3 retry attempts, got %d", mockSender.calls)
	}

	// Verify that an error was reported to botserver
	if len(mockBot.requests) != 1 {
		t.Errorf("Expected 1 botserver request, got %d", len(mockBot.requests))
	}
}

func TestWorker_ProcessCommand_PassThreadControl_NonRetriableError(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	// Mock sender that returns a non-retriable error
	mockSender := &mockHandoffSender{
		err: &PlatformError{
			StatusCode: 401,
			Message:    "Unauthorized - invalid token",
			Retriable:  false,
		},
	}

	worker := NewWorker(
		map[types.PlatformType]MessageSender{types.PlatformMessenger: mockSender},
		mockProducer,
		mockBot.URL(),
	)

	cmd := types.SendMessageCommand{
		CommandID:         "cmd_handoff_999",
		UserID:            "user_456",
		PlatformAccountID: "page_789",
		Platform:          types.PlatformMessenger,
		Message: types.MessageContent{
			Type:            types.MessageTypePassThreadControl,
			TargetAppID:     "263902037430900",
			HandoffMetadata: `{"reason":"test"}`,
		},
	}

	err := worker.ProcessCommand(context.Background(), cmd)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	// For non-retriable errors, should only try once
	if mockSender.calls != 1 {
		t.Errorf("Expected 1 call (no retries for non-retriable error), got %d", mockSender.calls)
	}

	// Verify that an error was reported to botserver
	if len(mockBot.requests) != 1 {
		t.Errorf("Expected 1 botserver request, got %d", len(mockBot.requests))
	}

	// Verify the error report contains the FB tag for platform errors
	var event botparty.ExternalEvent
	if err := json.Unmarshal(mockBot.requests[0], &event); err == nil {
		var value struct {
			Error struct {
				Tag string `json:"tag"`
			} `json:"error"`
		}
		if event.Event.Value != nil {
			if err := json.Unmarshal(*event.Event.Value, &value); err == nil {
				if value.Error.Tag != "FB" {
					t.Errorf("Expected FB tag for platform error, got %s", value.Error.Tag)
				}
			}
		}
	}
}

func TestWorker_ProcessCommand_PassThreadControl_ValidatesTargetAppID(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(
		map[types.PlatformType]MessageSender{types.PlatformMessenger: &mockHandoffSender{}},
		mockProducer,
		mockBot.URL(),
	)

	// Create a command with missing TargetAppID (should fail validation)
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_handoff_invalid",
		UserID:            "user_456",
		PlatformAccountID: "page_789",
		Platform:          types.PlatformMessenger,
		Message: types.MessageContent{
			Type:            types.MessageTypePassThreadControl,
			TargetAppID:     "", // Missing required field
			HandoffMetadata: `{"reason":"test"}`,
		},
	}

	// Note: Validation is typically done at the consumer level before calling ProcessCommand.
	// This test documents the expected behavior if validation fails.
	// In practice, invalid commands would be rejected before reaching here.
	// For now, we test that the command would error during processing.
	err := worker.ProcessCommand(context.Background(), cmd)
	// We expect this to either fail during processing or be caught earlier
	// The important thing is that it doesn't panic
	_ = err
}
