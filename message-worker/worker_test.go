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

// Mock EventProducer for testing
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

// mockBotserver creates a test server that captures machine_report requests
type mockBotserver struct {
	server   *httptest.Server
	requests [][]byte
}

func newMockBotserver() *mockBotserver {
	mock := &mockBotserver{
		requests: [][]byte{},
	}
	mock.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Read request body
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

// MockMessageSender for testing
type mockMessageSender struct {
	response *SendMessageResponse
	err      error
	calls    int
}

func (m *mockMessageSender) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}) (*SendMessageResponse, error) {
	m.calls++
	if m.err != nil {
		return nil, m.err
	}
	return m.response, nil
}

func (m *mockMessageSender) SendNativeMessage(ctx context.Context, userID, platformAccountID string, payload json.RawMessage) (string, error) {
	m.calls++
	if m.err != nil {
		return "", m.err
	}
	return m.response.MessageID, nil
}

func (m *mockMessageSender) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	m.calls++
	return m.err
}

func TestWorker_ProcessCommand_Success(t *testing.T) {
	mockProducer := &mockEventProducer{}
	mockSender := &mockMessageSender{
		response: &SendMessageResponse{
			MessageID: "msg_123",
			Success:   true,
		},
	}
	mockBot := newMockBotserver()
	defer mockBot.Close()

	// Create command
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

	// Create worker with mock sender
	clients := map[types.PlatformType]MessageSender{
		types.PlatformMessenger: mockSender,
	}
	worker := NewWorker(clients, mockProducer, mockBot.URL(), zap.NewNop())

	// Process command
	err := worker.ProcessCommand(context.Background(), cmd)
	if err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	// Verify mock was called
	if mockSender.calls != 1 {
		t.Errorf("Expected 1 call to SendMessage, got %d", mockSender.calls)
	}

	// Event emission is temporarily disabled
	if len(mockProducer.events) != 0 {
		t.Fatalf("Expected 0 events, got %d", len(mockProducer.events))
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

	// Create command with invalid message (missing text)
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_123",
		ConversationID:    "conv_456",
		UserID:            "user_789",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_123",
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: nil, // Missing required field
		},
	}

	// Process command - should fail on translation but return nil after reporting error
	err := worker.ProcessCommand(context.Background(), cmd)
	if err != nil {
		t.Fatalf("Expected nil (error handled by reporting to botserver), got: %v", err)
	}

	// Verify machine_report was sent to botserver
	if len(mockBot.requests) != 1 {
		t.Fatalf("Expected 1 request to botserver, got %d", len(mockBot.requests))
	}

	// Parse the request to verify it's a valid machine_report
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

	// Parse the machine_report value
	var reportValue MachineReportValue
	if err := json.Unmarshal(*externalEvent.Event.Value, &reportValue); err != nil {
		t.Fatalf("Failed to unmarshal machine_report value: %v", err)
	}

	// Translation errors should use STATE_ACTIONS tag (not FB)
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

	// emitMessageFailed returns nil when event is successfully published
	// (error is "handled" by publishing the failure event)
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

	// Should contain both original error and producer error
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

	// Create worker with no clients
	clients := map[types.PlatformType]MessageSender{}
	worker := NewWorker(clients, mockProducer, mockBot.URL(), zap.NewNop())

	text := "Hello"
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

	// Should return nil because error is handled by reporting to botserver
	err := worker.ProcessCommand(context.Background(), cmd)
	if err != nil {
		t.Fatalf("Expected nil (error handled), got: %v", err)
	}

	// Should have sent a machine_report to botserver
	if len(mockBot.requests) != 1 {
		t.Fatalf("Expected 1 request to botserver, got %d", len(mockBot.requests))
	}

	// Parse the request to verify it's a valid machine_report
	var externalEvent botparty.ExternalEvent
	if err := json.Unmarshal(mockBot.requests[0], &externalEvent); err != nil {
		t.Fatalf("Failed to unmarshal botserver request: %v", err)
	}

	if externalEvent.Event.Type != "machine_report" {
		t.Errorf("Expected event type 'machine_report', got '%s'", externalEvent.Event.Type)
	}

	// Parse the machine_report value
	var reportValue MachineReportValue
	if err := json.Unmarshal(*externalEvent.Event.Value, &reportValue); err != nil {
		t.Fatalf("Failed to unmarshal machine_report value: %v", err)
	}

	// No-client errors should use STATE_ACTIONS tag (not FB)
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
	// PlatformError should return true
	platformErr := &PlatformError{
		StatusCode: 400,
		Message:    "User blocked the page",
		Retriable:  false,
	}
	if !IsPlatformError(platformErr) {
		t.Error("Expected IsPlatformError to return true for PlatformError")
	}

	// Regular error should return false
	regularErr := errors.New("some error")
	if IsPlatformError(regularErr) {
		t.Error("Expected IsPlatformError to return false for regular error")
	}

	// nil should return false
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

	// Platform error should use FB tag
	platformErr := &PlatformError{
		StatusCode: 400,
		Message:    "User blocked the page",
		Retriable:  false,
	}

	err := worker.reportError(cmd, platformErr)
	if err != nil {
		t.Fatalf("reportError failed: %v", err)
	}

	// Verify machine_report was sent to botserver
	if len(mockBot.requests) != 1 {
		t.Fatalf("Expected 1 request to botserver, got %d", len(mockBot.requests))
	}

	// Parse the request
	var externalEvent botparty.ExternalEvent
	if err := json.Unmarshal(mockBot.requests[0], &externalEvent); err != nil {
		t.Fatalf("Failed to unmarshal botserver request: %v", err)
	}

	if externalEvent.Event.Type != "machine_report" {
		t.Errorf("Expected event type 'machine_report', got '%s'", externalEvent.Event.Type)
	}

	// Parse the machine_report value
	var reportValue MachineReportValue
	if err := json.Unmarshal(*externalEvent.Event.Value, &reportValue); err != nil {
		t.Fatalf("Failed to unmarshal machine_report value: %v", err)
	}

	// Platform errors should use FB tag (leads to BLOCKED state)
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

	// Non-platform error should use STATE_ACTIONS tag
	regularErr := errors.New("translation failed")

	err := worker.reportError(cmd, regularErr)
	if err != nil {
		t.Fatalf("reportError failed: %v", err)
	}

	// Verify machine_report was sent to botserver
	if len(mockBot.requests) != 1 {
		t.Fatalf("Expected 1 request to botserver, got %d", len(mockBot.requests))
	}

	// Parse the request
	var externalEvent botparty.ExternalEvent
	if err := json.Unmarshal(mockBot.requests[0], &externalEvent); err != nil {
		t.Fatalf("Failed to unmarshal botserver request: %v", err)
	}

	// Parse the machine_report value
	var reportValue MachineReportValue
	if err := json.Unmarshal(*externalEvent.Event.Value, &reportValue); err != nil {
		t.Fatalf("Failed to unmarshal machine_report value: %v", err)
	}

	// Non-platform errors should use STATE_ACTIONS tag (leads to ERROR state)
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
