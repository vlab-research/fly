package messageworker

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/vlab-research/botparty"
	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

// mockNativeMessageSender is a mock client for testing native message sending
type mockNativeMessageSender struct {
	messageID string
	err       error
	calls     int
	payloads  []json.RawMessage
}

func (m *mockNativeMessageSender) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}) (*SendMessageResponse, error) {
	m.calls++
	if m.err != nil {
		return nil, m.err
	}
	return &SendMessageResponse{
		MessageID: m.messageID,
		Success:   true,
	}, nil
}

func (m *mockNativeMessageSender) SendNativeMessage(ctx context.Context, userID, platformAccountID string, payload json.RawMessage) (string, error) {
	m.calls++
	m.payloads = append(m.payloads, payload)
	if m.err != nil {
		return "", m.err
	}
	return m.messageID, nil
}

func (m *mockNativeMessageSender) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	return nil
}

// customMockEventProducer for testing with correct signature
type customMockEventProducer struct {
	events []types.UniversalEvent
	err    error
}

func (m *customMockEventProducer) PublishEvent(ctx context.Context, event types.UniversalEvent) error {
	if m.err != nil {
		return m.err
	}
	m.events = append(m.events, event)
	return nil
}

func TestWorker_ProcessCommand_Native_Success(t *testing.T) {
	mockProducer := &customMockEventProducer{}
	mockSender := &mockNativeMessageSender{
		messageID: "native_msg_123",
	}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	clients := map[types.PlatformType]MessageSender{
		types.PlatformMessenger: mockSender,
	}
	worker := NewWorker(clients, mockProducer, mockBot.URL(), zap.NewNop())

	// Create a native message command
	nativePayload := json.RawMessage(`{
		"recipient": {"id": "user_123"},
		"message": {
			"text": "Pre-formatted message",
			"quick_replies": [
				{"content_type": "text", "title": "Yes", "payload": "yes"},
				{"content_type": "text", "title": "No", "payload": "no"}
			]
		}
	}`)

	cmd := types.SendMessageCommand{
		CommandID:         "cmd_native_123",
		UserID:            "user_123",
		PlatformAccountID: "page_123",
		Platform:          types.PlatformMessenger,
		Message: types.MessageContent{
			Type:           types.MessageTypeNative,
			NativePayload:  nativePayload,
		},
	}

	err := worker.ProcessCommand(context.Background(), cmd)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	// Verify the native message was sent (not translated)
	if mockSender.calls != 1 {
		t.Errorf("Expected 1 call to SendNativeMessage, got %d", mockSender.calls)
	}

	// Verify the payload was passed through unchanged
	if len(mockSender.payloads) != 1 {
		t.Errorf("Expected 1 payload, got %d", len(mockSender.payloads))
	} else if string(mockSender.payloads[0]) != string(nativePayload) {
		t.Errorf("Payload mismatch. Expected %s, got %s", string(nativePayload), string(mockSender.payloads[0]))
	}

	// Event emission is temporarily disabled
	if len(mockProducer.events) != 0 {
		t.Errorf("Expected 0 events, got %d", len(mockProducer.events))
	}
}

func TestWorker_ProcessCommand_Native_NoClient(t *testing.T) {
	mockProducer := &customMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	// No client configured for Messenger
	worker := NewWorker(
		map[types.PlatformType]MessageSender{},
		mockProducer,
		mockBot.URL(),
		zap.NewNop(),
	)

	nativePayload := json.RawMessage(`{"recipient": {"id": "user_123"}, "message": {"text": "test"}}`)

	cmd := types.SendMessageCommand{
		CommandID:         "cmd_native_456",
		UserID:            "user_123",
		PlatformAccountID: "page_123",
		Platform:          types.PlatformMessenger,
		Message: types.MessageContent{
			Type:          types.MessageTypeNative,
			NativePayload: nativePayload,
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

func TestWorker_ProcessCommand_Native_RetriableError(t *testing.T) {
	mockProducer := &customMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	// Mock sender that returns a retriable error
	mockSender := &mockNativeMessageSender{
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
		zap.NewNop(),
	)

	nativePayload := json.RawMessage(`{"recipient": {"id": "user_123"}, "message": {"text": "test"}}`)

	cmd := types.SendMessageCommand{
		CommandID:         "cmd_native_789",
		UserID:            "user_123",
		PlatformAccountID: "page_123",
		Platform:          types.PlatformMessenger,
		Message: types.MessageContent{
			Type:          types.MessageTypeNative,
			NativePayload: nativePayload,
		},
	}

	err := worker.ProcessCommand(context.Background(), cmd)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	// Verify that the error was retried and then reported
	// With default retry config, we should have 3 attempts
	if mockSender.calls < 3 {
		t.Errorf("Expected at least 3 retry attempts, got %d", mockSender.calls)
	}

	// Verify that an error was reported to botserver
	if len(mockBot.requests) != 1 {
		t.Errorf("Expected 1 botserver request, got %d", len(mockBot.requests))
	}
}

func TestWorker_ProcessCommand_Native_NonRetriableError(t *testing.T) {
	mockProducer := &customMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	// Mock sender that returns a non-retriable error
	mockSender := &mockNativeMessageSender{
		err: &PlatformError{
			StatusCode: 403,
			Message:    "User has blocked the bot",
			Retriable:  false,
		},
	}

	worker := NewWorker(
		map[types.PlatformType]MessageSender{types.PlatformMessenger: mockSender},
		mockProducer,
		mockBot.URL(),
		zap.NewNop(),
	)

	nativePayload := json.RawMessage(`{"recipient": {"id": "user_123"}, "message": {"text": "test"}}`)

	cmd := types.SendMessageCommand{
		CommandID:         "cmd_native_999",
		UserID:            "user_123",
		PlatformAccountID: "page_123",
		Platform:          types.PlatformMessenger,
		Message: types.MessageContent{
			Type:          types.MessageTypeNative,
			NativePayload: nativePayload,
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
