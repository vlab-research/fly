package messageworker

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/vlab-research/botparty"
	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

type mockHandoffSender struct {
	err          error
	calls        int
	userIDs      []string
	targetAppIDs []string
	metadatas    []string
}

func (m *mockHandoffSender) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}, platformContext json.RawMessage) (*SendMessageResponse, error) {
	m.calls++
	if m.err != nil {
		return nil, m.err
	}
	return &SendMessageResponse{MessageID: "msg_handoff_sender", Success: true}, nil
}

func (m *mockHandoffSender) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	m.calls++
	m.userIDs = append(m.userIDs, userID)
	m.targetAppIDs = append(m.targetAppIDs, targetAppID)
	m.metadatas = append(m.metadatas, metadata)
	return m.err
}

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

func (m *handoffMockEventProducer) PublishRawEvent(ctx context.Context, key string, value []byte) error {
	if m.err != nil {
		return m.err
	}
	return nil
}

func TestWorker_ProcessCommand_Handoff_Success(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockSender := &mockHandoffSender{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(
		map[types.PlatformType]MessageSender{types.PlatformMessenger: mockSender},
		mockProducer,
		mockBot.URL(),
		zap.NewNop(),
	)

	cmd := types.HandoffCommand{
		Type:              "handoff",
		CommandID:         "cmd_handoff_123",
		IssuedAt:          1234567890000,
		ConversationID:    "conv_456",
		UserID:            "user_456",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_789",
		TargetAppID:       "263902037430900",
		Metadata:          json.RawMessage(`{"source":"replybot","reason":"live_agent_request"}`),
	}

	cmdJSON, _ := json.Marshal(cmd)
	err := worker.ProcessCommand(context.Background(), cmdJSON)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	if mockSender.calls != 1 {
		t.Errorf("Expected 1 call to PassThreadControl, got %d", mockSender.calls)
	}

	if len(mockSender.userIDs) != 1 || mockSender.userIDs[0] != "user_456" {
		t.Errorf("Expected userID user_456, got %v", mockSender.userIDs)
	}
	if len(mockSender.targetAppIDs) != 1 || mockSender.targetAppIDs[0] != "263902037430900" {
		t.Errorf("Expected targetAppID 263902037430900, got %v", mockSender.targetAppIDs)
	}
	if len(mockSender.metadatas) != 1 || mockSender.metadatas[0] != `{"source":"replybot","reason":"live_agent_request"}` {
		t.Errorf("Expected metadata %s, got %s", `{"source":"replybot","reason":"live_agent_request"}`, mockSender.metadatas[0])
	}

	// Event emission is temporarily disabled
	if len(mockProducer.events) != 0 {
		t.Errorf("Expected 0 events, got %d", len(mockProducer.events))
	}
}

func TestWorker_ProcessCommand_Handoff_NoClient(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(
		map[types.PlatformType]MessageSender{},
		mockProducer,
		mockBot.URL(),
		zap.NewNop(),
	)

	cmd := types.HandoffCommand{
		Type:              "handoff",
		CommandID:         "cmd_handoff_456",
		UserID:            "user_456",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_789",
		TargetAppID:       "263902037430900",
		Metadata:          json.RawMessage(`{"reason":"test"}`),
	}

	cmdJSON, _ := json.Marshal(cmd)
	err := worker.ProcessCommand(context.Background(), cmdJSON)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	if len(mockBot.requests) != 1 {
		t.Errorf("Expected 1 botserver request, got %d", len(mockBot.requests))
	}
}

func TestWorker_ProcessCommand_Handoff_RetriableError(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

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
		zap.NewNop(),
	)

	cmd := types.HandoffCommand{
		Type:              "handoff",
		CommandID:         "cmd_handoff_789",
		UserID:            "user_456",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_789",
		TargetAppID:       "263902037430900",
		Metadata:          json.RawMessage(`{"reason":"test"}`),
	}

	cmdJSON, _ := json.Marshal(cmd)
	err := worker.ProcessCommand(context.Background(), cmdJSON)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	if mockSender.calls < 3 {
		t.Errorf("Expected at least 3 retry attempts, got %d", mockSender.calls)
	}

	if len(mockBot.requests) != 1 {
		t.Errorf("Expected 1 botserver request, got %d", len(mockBot.requests))
	}
}

func TestWorker_ProcessCommand_Handoff_NonRetriableError(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

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
		zap.NewNop(),
	)

	cmd := types.HandoffCommand{
		Type:              "handoff",
		CommandID:         "cmd_handoff_999",
		UserID:            "user_456",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_789",
		TargetAppID:       "263902037430900",
		Metadata:          json.RawMessage(`{"reason":"test"}`),
	}

	cmdJSON, _ := json.Marshal(cmd)
	err := worker.ProcessCommand(context.Background(), cmdJSON)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	if mockSender.calls != 1 {
		t.Errorf("Expected 1 call (no retries for non-retriable error), got %d", mockSender.calls)
	}

	if len(mockBot.requests) != 1 {
		t.Errorf("Expected 1 botserver request, got %d", len(mockBot.requests))
	}

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

func TestWorker_ProcessCommand_LegacyPassThreadControl(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockSender := &mockHandoffSender{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(
		map[types.PlatformType]MessageSender{types.PlatformMessenger: mockSender},
		mockProducer,
		mockBot.URL(),
		zap.NewNop(),
	)

	legacyJSON := json.RawMessage(`{
		"command_id": "cmd_legacy_handoff",
		"issued_at": 1234567890000,
		"conversation_id": "conv_legacy",
		"user_id": "user_456",
		"platform": "messenger",
		"platform_account_id": "page_789",
		"message": {
			"type": "pass_thread_control",
			"target_app_id": "263902037430900",
			"handoff_metadata": "{\"source\":\"replybot\",\"reason\":\"live_agent_request\"}"
		}
	}`)

	err := worker.ProcessCommand(context.Background(), legacyJSON)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	if mockSender.calls != 1 {
		t.Errorf("Expected 1 call to PassThreadControl, got %d", mockSender.calls)
	}

	if len(mockSender.targetAppIDs) != 1 || mockSender.targetAppIDs[0] != "263902037430900" {
		t.Errorf("Expected targetAppID 263902037430900, got %v", mockSender.targetAppIDs)
	}
}

func TestWorker_ProcessCommand_LegacyNative_ReturnsError(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(
		map[types.PlatformType]MessageSender{types.PlatformMessenger: &mockHandoffSender{}},
		mockProducer,
		mockBot.URL(),
		zap.NewNop(),
	)

	legacyJSON := json.RawMessage(`{
		"command_id": "cmd_legacy_native",
		"user_id": "user_456",
		"platform": "messenger",
		"platform_account_id": "page_789",
		"message": {
			"type": "native",
			"native_payload": {"recipient": {"id": "user_123"}, "message": {"text": "test"}}
		}
	}`)

	err := worker.ProcessCommand(context.Background(), legacyJSON)
	if err == nil {
		t.Fatal("Expected error for legacy native message, got nil")
	}
}

func TestWorker_ProcessCommand_LegacyDefault_SendsMessage(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockSender := &mockHandoffSender{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(
		map[types.PlatformType]MessageSender{types.PlatformMessenger: mockSender},
		mockProducer,
		mockBot.URL(),
		zap.NewNop(),
	)

	legacyJSON := json.RawMessage(`{
		"command_id": "cmd_legacy_text",
		"conversation_id": "conv_456",
		"user_id": "user_789",
		"platform": "messenger",
		"platform_account_id": "page_123",
		"message": {
			"type": "text",
			"text": "Hello from legacy format"
		}
	}`)

	err := worker.ProcessCommand(context.Background(), legacyJSON)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}
}

func TestWorker_ProcessCommand_UnknownCommandType(t *testing.T) {
	mockProducer := &handoffMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(
		map[types.PlatformType]MessageSender{},
		mockProducer,
		mockBot.URL(),
		zap.NewNop(),
	)

	cmdJSON := json.RawMessage(`{"type": "unknown_command", "command_id": "cmd_x"}`)

	err := worker.ProcessCommand(context.Background(), cmdJSON)
	if err == nil {
		t.Fatal("Expected error for unknown command type, got nil")
	}
}
