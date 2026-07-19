package messageworker

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

type mockNativeMessageSender struct {
	messageID string
	err       error
	calls     int
}

func (m *mockNativeMessageSender) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}, platformContext json.RawMessage) (*SendMessageResponse, error) {
	m.calls++
	if m.err != nil {
		return nil, m.err
	}
	return &SendMessageResponse{
		MessageID: m.messageID,
		Success:   true,
	}, nil
}

func (m *mockNativeMessageSender) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	return nil
}

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

func (m *customMockEventProducer) PublishRawEvent(ctx context.Context, key string, value []byte) error {
	if m.err != nil {
		return m.err
	}
	return nil
}

func TestWorker_ProcessCommand_NativeLegacy_ReturnsError(t *testing.T) {
	mockProducer := &customMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	mockSender := &mockNativeMessageSender{messageID: "native_msg_123"}
	clients := map[types.PlatformType]MessageSender{
		types.PlatformMessenger: mockSender,
	}
	worker := NewWorker(clients, mockProducer, mockBot.URL(), zap.NewNop())

	legacyJSON := json.RawMessage(`{
		"command_id": "cmd_native_123",
		"user_id": "user_123",
		"platform_account_id": "page_123",
		"platform": "messenger",
		"message": {
			"type": "native",
			"native_payload": {"recipient": {"id": "user_123"}, "message": {"text": "test"}}
		}
	}`)

	err := worker.ProcessCommand(context.Background(), legacyJSON)
	if err == nil {
		t.Fatal("Expected error for legacy native message, got nil")
	}

	if mockSender.calls != 0 {
		t.Errorf("Expected 0 calls to SendMessage (native not supported), got %d", mockSender.calls)
	}
}

func TestWorker_ProcessCommand_NativeLegacy_NoClient(t *testing.T) {
	mockProducer := &customMockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(
		map[types.PlatformType]MessageSender{},
		mockProducer,
		mockBot.URL(),
		zap.NewNop(),
	)

	legacyJSON := json.RawMessage(`{
		"command_id": "cmd_native_456",
		"user_id": "user_123",
		"platform_account_id": "page_123",
		"platform": "messenger",
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
