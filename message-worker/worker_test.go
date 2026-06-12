package messageworker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vlab-research/botparty"
	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

type mockEventProducer struct {
	events []types.UniversalEvent
	err    error
}

func (m *mockEventProducer) PublishEvent(ctx context.Context, event types.UniversalEvent) error {
	if m.err != nil {
		return m.err
	}
	m.events = append(m.events, event)
	return nil
}

type mockBotserver struct {
	server   *httptest.Server
	requests [][]byte
}

func newMockBotserver() *mockBotserver {
	mock := &mockBotserver{
		requests: [][]byte{},
	}
	mock.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := make([]byte, r.ContentLength)
		r.Body.Read(body)
		mock.requests = append(mock.requests, body)
		w.WriteHeader(http.StatusOK)
	}))
	return mock
}

func (m *mockBotserver) URL() string {
	return m.server.URL
}

func (m *mockBotserver) Close() {
	m.server.Close()
}

type mockMessageSender struct {
	response *SendMessageResponse
	err      error
	calls    int
}

func (m *mockMessageSender) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}, platformContext json.RawMessage) (*SendMessageResponse, error) {
	m.calls++
	if m.err != nil {
		return nil, m.err
	}
	return m.response, nil
}

func (m *mockMessageSender) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	m.calls++
	return m.err
}

func TestWorker_ProcessCommand_SendMessage_Success(t *testing.T) {
	mockProducer := &mockEventProducer{}
	mockSender := &mockMessageSender{
		response: &SendMessageResponse{
			MessageID: "msg_123",
			Success:   true,
		},
	}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	text := "Hello, world!"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_123",
		IssuedAt:          1234567890000,
		ConversationID:    "conv_456",
		UserID:            "user_789",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_123",
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: &text,
		},
	}

	clients := map[types.PlatformType]MessageSender{
		types.PlatformMessenger: mockSender,
	}
	worker := NewWorker(clients, mockProducer, mockBot.URL(), zap.NewNop())

	cmdJSON, _ := json.Marshal(cmd)
	err := worker.ProcessCommand(context.Background(), cmdJSON)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	if mockSender.calls != 1 {
		t.Errorf("Expected 1 call to SendMessage, got %d", mockSender.calls)
	}

	if len(mockProducer.events) != 1 {
		t.Fatalf("Expected 1 event, got %d", len(mockProducer.events))
	}

	event := mockProducer.events[0]
	if event.EventType != "message_sent" {
		t.Errorf("Expected event type 'message_sent', got '%s'", event.EventType)
	}
	if event.ConversationID != cmd.ConversationID {
		t.Errorf("Expected conversation_id '%s', got '%s'", cmd.ConversationID, event.ConversationID)
	}

	var payload types.MessageSentPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("Failed to unmarshal payload: %v", err)
	}

	if payload.CommandID != cmd.CommandID {
		t.Errorf("Expected command_id '%s', got '%s'", cmd.CommandID, payload.CommandID)
	}
	if payload.PlatformMessageID == nil || *payload.PlatformMessageID != "msg_123" {
		t.Errorf("Expected platform_message_id 'msg_123', got %v", payload.PlatformMessageID)
	}
}

func TestWorker_ProcessCommand_LegacySendMessage_Success(t *testing.T) {
	mockProducer := &mockEventProducer{}
	mockSender := &mockMessageSender{
		response: &SendMessageResponse{
			MessageID: "msg_legacy",
			Success:   true,
		},
	}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	text := "Legacy message"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_legacy",
		ConversationID:    "conv_legacy",
		UserID:            "user_legacy",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_legacy",
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: &text,
		},
	}

	clients := map[types.PlatformType]MessageSender{
		types.PlatformMessenger: mockSender,
	}
	worker := NewWorker(clients, mockProducer, mockBot.URL(), zap.NewNop())

	cmdJSON, _ := json.Marshal(cmd)
	err := worker.ProcessCommand(context.Background(), cmdJSON)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	if mockSender.calls != 1 {
		t.Errorf("Expected 1 call to SendMessage, got %d", mockSender.calls)
	}
}

func TestWorker_ProcessCommand_TranslationError(t *testing.T) {
	mockProducer := &mockEventProducer{}
	mockSender := &mockMessageSender{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	clients := map[types.PlatformType]MessageSender{
		types.PlatformMessenger: mockSender,
	}
	worker := NewWorker(clients, mockProducer, mockBot.URL(), zap.NewNop())

	cmd := types.SendMessageCommand{
		Type:              "send_message",
		CommandID:         "cmd_123",
		ConversationID:    "conv_456",
		UserID:            "user_789",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_123",
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: nil,
		},
	}

	cmdJSON, _ := json.Marshal(cmd)
	err := worker.ProcessCommand(context.Background(), cmdJSON)
	if err != nil {
		t.Fatalf("Expected nil (error handled by reporting to botserver), got: %v", err)
	}

	if len(mockBot.requests) != 1 {
		t.Fatalf("Expected 1 request to botserver, got %d", len(mockBot.requests))
	}

	var externalEvent botparty.ExternalEvent
	if err := json.Unmarshal(mockBot.requests[0], &externalEvent); err != nil {
		t.Fatalf("Failed to unmarshal botserver request: %v", err)
	}

	if externalEvent.Event.Type != "machine_report" {
		t.Errorf("Expected event type 'machine_report', got '%s'", externalEvent.Event.Type)
	}
	if externalEvent.User != cmd.UserID {
		t.Errorf("Expected user '%s', got '%s'", cmd.UserID, externalEvent.User)
	}
	if externalEvent.Page != cmd.PlatformAccountID {
		t.Errorf("Expected page '%s', got '%s'", cmd.PlatformAccountID, externalEvent.Page)
	}

	var reportValue MachineReportValue
	if err := json.Unmarshal(*externalEvent.Event.Value, &reportValue); err != nil {
		t.Fatalf("Failed to unmarshal machine_report value: %v", err)
	}

	if reportValue.Error.Tag != "STATE_ACTIONS" {
		t.Errorf("Expected error tag 'STATE_ACTIONS' for translation error, got '%s'", reportValue.Error.Tag)
	}
}

func TestWorker_EmitMessageSent(t *testing.T) {
	mockProducer := &mockEventProducer{}

	worker := &Worker{
		producer: mockProducer,
		logger:   zap.NewNop(),
	}

	text := "Test message"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_123",
		ConversationID:    "conv_456",
		UserID:            "user_789",
		Platform:          types.PlatformWhatsApp,
		PlatformAccountID: "wa_123",
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: &text,
		},
	}

	err := worker.emitMessageSent(context.Background(), cmd, "msg_xyz", 2)
	if err != nil {
		t.Fatalf("Failed to emit event: %v", err)
	}

	if len(mockProducer.events) != 1 {
		t.Fatalf("Expected 1 event, got %d", len(mockProducer.events))
	}

	event := mockProducer.events[0]
	if event.EventType != "message_sent" {
		t.Errorf("Expected event type 'message_sent', got '%s'", event.EventType)
	}
	if event.Source != types.EventSourceMessageWorker {
		t.Errorf("Expected source 'message_worker', got '%s'", event.Source)
	}
	if event.Platform.Type != types.PlatformWhatsApp {
		t.Errorf("Expected platform 'whatsapp', got '%s'", event.Platform.Type)
	}
	if event.Platform.AccountID != "wa_123" {
		t.Errorf("Expected account_id 'wa_123', got '%s'", event.Platform.AccountID)
	}

	var payload types.MessageSentPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("Failed to unmarshal payload: %v", err)
	}

	if payload.Attempts != 2 {
		t.Errorf("Expected 2 attempts, got %d", payload.Attempts)
	}
	if payload.PlatformMessageID == nil || *payload.PlatformMessageID != "msg_xyz" {
		t.Errorf("Expected platform_message_id 'msg_xyz'")
	}
}

func TestWorker_EmitMessageFailed(t *testing.T) {
	mockProducer := &mockEventProducer{}

	worker := &Worker{
		producer: mockProducer,
		logger:   zap.NewNop(),
	}

	text := "Test message"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_123",
		ConversationID:    "conv_456",
		UserID:            "user_789",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_123",
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: &text,
		},
	}

	testErr := &PlatformError{
		StatusCode: 503,
		Message:    "Service unavailable",
		Retriable:  true,
	}

	err := worker.emitMessageFailed(context.Background(), cmd, testErr, 3, true)
	if err != nil {
		t.Fatalf("Expected nil (error handled), got: %v", err)
	}

	if len(mockProducer.events) != 1 {
		t.Fatalf("Expected 1 event, got %d", len(mockProducer.events))
	}

	event := mockProducer.events[0]
	if event.EventType != "message_failed" {
		t.Errorf("Expected event type 'message_failed', got '%s'", event.EventType)
	}

	var payload types.MessageFailedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("Failed to unmarshal payload: %v", err)
	}

	if payload.Attempts != 3 {
		t.Errorf("Expected 3 attempts, got %d", payload.Attempts)
	}
	if !payload.Retriable {
		t.Errorf("Expected retriable=true")
	}
	if payload.Error != testErr.Error() {
		t.Errorf("Expected error '%s', got '%s'", testErr.Error(), payload.Error)
	}
}

func TestWorker_EmitMessageFailed_ProducerError(t *testing.T) {
	producerErr := errors.New("kafka connection failed")
	mockProducer := &mockEventProducer{
		err: producerErr,
	}

	worker := &Worker{
		producer: mockProducer,
		logger:   zap.NewNop(),
	}

	text := "Test message"
	cmd := types.SendMessageCommand{
		CommandID:      "cmd_123",
		ConversationID: "conv_456",
		UserID:         "user_789",
		Platform:       types.PlatformMessenger,
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: &text,
		},
	}

	originalErr := errors.New("original error")
	err := worker.emitMessageFailed(context.Background(), cmd, originalErr, 1, false)
	if err == nil {
		t.Fatal("Expected error, got nil")
	}

	errStr := err.Error()
	if !contains(errStr, "original error") {
		t.Errorf("Error should mention original error: %s", errStr)
	}
	if !contains(errStr, "kafka connection failed") {
		t.Errorf("Error should mention producer error: %s", errStr)
	}
}

func TestWorker_ProcessCommand_NoClientForPlatform(t *testing.T) {
	mockProducer := &mockEventProducer{}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	clients := map[types.PlatformType]MessageSender{}
	worker := NewWorker(clients, mockProducer, mockBot.URL(), zap.NewNop())

	text := "Hello"
	cmd := types.SendMessageCommand{
		Type:              "send_message",
		CommandID:         "cmd_123",
		ConversationID:    "conv_456",
		UserID:            "user_789",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_123",
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: &text,
		},
	}

	cmdJSON, _ := json.Marshal(cmd)
	err := worker.ProcessCommand(context.Background(), cmdJSON)
	if err != nil {
		t.Fatalf("Expected nil (error handled), got: %v", err)
	}

	if len(mockBot.requests) != 1 {
		t.Fatalf("Expected 1 request to botserver, got %d", len(mockBot.requests))
	}

	var externalEvent botparty.ExternalEvent
	if err := json.Unmarshal(mockBot.requests[0], &externalEvent); err != nil {
		t.Fatalf("Failed to unmarshal botserver request: %v", err)
	}

	if externalEvent.Event.Type != "machine_report" {
		t.Errorf("Expected event type 'machine_report', got '%s'", externalEvent.Event.Type)
	}

	var reportValue MachineReportValue
	if err := json.Unmarshal(*externalEvent.Event.Value, &reportValue); err != nil {
		t.Fatalf("Failed to unmarshal machine_report value: %v", err)
	}

	if reportValue.Error.Tag != "STATE_ACTIONS" {
		t.Errorf("Expected error tag 'STATE_ACTIONS' for config error, got '%s'", reportValue.Error.Tag)
	}
}

func TestGenerateEventID(t *testing.T) {
	id1 := generateEventID()
	id2 := generateEventID()

	if id1 == id2 {
		t.Errorf("Expected unique event IDs, got same: %s", id1)
	}

	if len(id1) < 10 {
		t.Errorf("Event ID seems too short: %s", id1)
	}

	if id1[:4] != "evt_" {
		t.Errorf("Event ID should start with 'evt_', got: %s", id1)
	}
}

func TestIsPlatformError(t *testing.T) {
	platformErr := &PlatformError{
		StatusCode: 400,
		Message:    "User blocked the page",
		Retriable:  false,
	}
	if !IsPlatformError(platformErr) {
		t.Error("Expected IsPlatformError to return true for PlatformError")
	}

	regularErr := errors.New("some error")
	if IsPlatformError(regularErr) {
		t.Error("Expected IsPlatformError to return false for regular error")
	}

	if IsPlatformError(nil) {
		t.Error("Expected IsPlatformError to return false for nil")
	}
}

func TestWorker_ReportError_PlatformError(t *testing.T) {
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(nil, nil, mockBot.URL(), zap.NewNop())

	text := "Test message"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_123",
		ConversationID:    "conv_456",
		UserID:            "user_789",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_123",
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: &text,
		},
	}

	platformErr := &PlatformError{
		StatusCode: 400,
		Message:    "User blocked the page",
		Retriable:  false,
	}

	err := worker.reportError(cmd, platformErr)
	if err != nil {
		t.Fatalf("reportError failed: %v", err)
	}

	if len(mockBot.requests) != 1 {
		t.Fatalf("Expected 1 request to botserver, got %d", len(mockBot.requests))
	}

	var externalEvent botparty.ExternalEvent
	if err := json.Unmarshal(mockBot.requests[0], &externalEvent); err != nil {
		t.Fatalf("Failed to unmarshal botserver request: %v", err)
	}

	if externalEvent.Event.Type != "machine_report" {
		t.Errorf("Expected event type 'machine_report', got '%s'", externalEvent.Event.Type)
	}

	var reportValue MachineReportValue
	if err := json.Unmarshal(*externalEvent.Event.Value, &reportValue); err != nil {
		t.Fatalf("Failed to unmarshal machine_report value: %v", err)
	}

	if reportValue.Error.Tag != "FB" {
		t.Errorf("Expected error tag 'FB' for platform error, got '%s'", reportValue.Error.Tag)
	}
	if reportValue.User != cmd.UserID {
		t.Errorf("Expected user '%s', got '%s'", cmd.UserID, reportValue.User)
	}
	if reportValue.Page != cmd.PlatformAccountID {
		t.Errorf("Expected page '%s', got '%s'", cmd.PlatformAccountID, reportValue.Page)
	}
}

func TestWorker_ReportError_NonPlatformError(t *testing.T) {
	mockBot := newMockBotserver()
	defer mockBot.Close()

	worker := NewWorker(nil, nil, mockBot.URL(), zap.NewNop())

	text := "Test message"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_123",
		ConversationID:    "conv_456",
		UserID:            "user_789",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_123",
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: &text,
		},
	}

	regularErr := errors.New("translation failed")

	err := worker.reportError(cmd, regularErr)
	if err != nil {
		t.Fatalf("reportError failed: %v", err)
	}

	if len(mockBot.requests) != 1 {
		t.Fatalf("Expected 1 request to botserver, got %d", len(mockBot.requests))
	}

	var externalEvent botparty.ExternalEvent
	if err := json.Unmarshal(mockBot.requests[0], &externalEvent); err != nil {
		t.Fatalf("Failed to unmarshal botserver request: %v", err)
	}

	var reportValue MachineReportValue
	if err := json.Unmarshal(*externalEvent.Event.Value, &reportValue); err != nil {
		t.Fatalf("Failed to unmarshal machine_report value: %v", err)
	}

	if reportValue.Error.Tag != "STATE_ACTIONS" {
		t.Errorf("Expected error tag 'STATE_ACTIONS' for non-platform error, got '%s'", reportValue.Error.Tag)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > len(substr) && findSubstring(s, substr))
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
