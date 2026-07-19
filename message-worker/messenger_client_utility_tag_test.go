package messageworker

// Functional tests for the two production gaps in the Messenger send path:
//
//  1. utility_message fields (metadata.type == "utility_message") must reach
//     Facebook as a Meta message template with messaging_type "UTILITY" —
//     never as plain text/question. This is the go-forward re-contact
//     mechanism and was never exercised in the V2 rewrite.
//  2. A field's sendParams (message.metadata.sendParams.{messaging_type,tag})
//     must be forwarded as top-level fields on the Facebook Send request —
//     tags are in active production use (see
//     replybot/lib/typewheels/transition.test.js).
//
// These drive a full types.SendMessageCommand through Worker.ProcessCommand
// -> processSendMessage -> TranslateToMessenger -> the *real* MessengerClient
// -> an httptest server standing in for the Facebook Graph API, and assert on
// the raw outbound HTTP request body. This is the level at which the two
// defects actually manifest: the translator alone can produce a correct
// types.MessengerMessage, but historically messaging_type/tag never made it
// onto the wire because FacebookSendRequest only carried {Recipient, Message}.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

// capturingFacebookServer stands in for the Facebook Graph API /me/messages
// endpoint and records every raw request body it receives, so tests can
// assert on the exact JSON shape sent over the wire.
type capturingFacebookServer struct {
	server *httptest.Server
	bodies [][]byte
}

func newCapturingFacebookServer() *capturingFacebookServer {
	s := &capturingFacebookServer{}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.bodies = append(s.bodies, body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"recipient_id":"user_1","message_id":"mid.test"}`))
	}))
	return s
}

func (s *capturingFacebookServer) Close() {
	s.server.Close()
}

// outboundFacebookRequest mirrors the wire shape of FacebookSendRequest for
// assertions (kept independent of the production struct so the test doesn't
// silently pass just because it round-trips through the same type).
type outboundFacebookRequest struct {
	Recipient     map[string]string `json:"recipient"`
	MessagingType string            `json:"messaging_type"`
	Tag           string            `json:"tag"`
	Message       struct {
		Text     string `json:"text"`
		Metadata string `json:"metadata"`
		Template *struct {
			Name     string `json:"name"`
			Language struct {
				Code string `json:"code"`
			} `json:"language"`
			Components []struct {
				Type       string `json:"type"`
				Parameters []struct {
					Type    string `json:"type"`
					Text    string `json:"text"`
					Payload string `json:"payload"`
				} `json:"parameters"`
			} `json:"components"`
		} `json:"template"`
	} `json:"message"`
}

func sendThroughWorker(t *testing.T, fbServer *capturingFacebookServer, cmd types.SendMessageCommand) outboundFacebookRequest {
	t.Helper()

	mockBot := newMockBotserver()
	defer mockBot.Close()

	client := NewMessengerClient(fbServer.server.URL, NewStaticTokenStore("test-token"))
	clients := map[types.PlatformType]MessageSender{types.PlatformMessenger: client}
	producer := &mockEventProducer{}
	worker := NewWorker(clients, producer, mockBot.URL(), zap.NewNop())

	cmdJSON, err := json.Marshal(cmd)
	if err != nil {
		t.Fatalf("failed to marshal command: %v", err)
	}

	if err := worker.ProcessCommand(context.Background(), cmdJSON); err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	if len(mockBot.requests) != 0 {
		t.Fatalf("expected no machine_report to botserver (send should have succeeded), got %d", len(mockBot.requests))
	}

	if len(fbServer.bodies) != 1 {
		t.Fatalf("expected exactly 1 request to Facebook, got %d", len(fbServer.bodies))
	}

	var got outboundFacebookRequest
	if err := json.Unmarshal(fbServer.bodies[0], &got); err != nil {
		t.Fatalf("failed to unmarshal outbound Facebook request: %v\nbody: %s", err, fbServer.bodies[0])
	}
	return got
}

func TestWorker_UtilityMessage_NoChoices_SendsUtilityTemplateWithoutButtons(t *testing.T) {
	fbServer := newCapturingFacebookServer()
	defer fbServer.Close()

	text := "Your payment of KSh 35 is confirmed"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_utility_text",
		ConversationID:    "conv_1",
		UserID:            "user_1",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_1",
		Message: types.MessageContent{
			Type:     types.MessageTypeText,
			Text:     &text,
			Metadata: json.RawMessage(`{"type":"utility_message","template":"recontact_owis","language":"en_US","params":["KSh 35"],"ref":"utility_1"}`),
		},
	}

	got := sendThroughWorker(t, fbServer, cmd)

	if got.MessagingType != "UTILITY" {
		t.Errorf("messaging_type = %q, want %q", got.MessagingType, "UTILITY")
	}
	if got.Tag != "" {
		t.Errorf("tag = %q, want empty", got.Tag)
	}
	if got.Recipient["id"] != "user_1" {
		t.Errorf("recipient.id = %q, want %q", got.Recipient["id"], "user_1")
	}
	if got.Message.Text != "" {
		t.Errorf("message.text = %q, want empty (utility message must be a template, not plain text)", got.Message.Text)
	}
	tmpl := got.Message.Template
	if tmpl == nil {
		t.Fatalf("message.template is nil, want a populated template")
	}
	if tmpl.Name != "recontact_owis" {
		t.Errorf("template.name = %q, want %q", tmpl.Name, "recontact_owis")
	}
	if tmpl.Language.Code != "en_US" {
		t.Errorf("template.language.code = %q, want %q", tmpl.Language.Code, "en_US")
	}
	if len(tmpl.Components) != 1 {
		t.Fatalf("expected exactly 1 component (body only, no choices), got %d", len(tmpl.Components))
	}
	body := tmpl.Components[0]
	if body.Type != "body" {
		t.Errorf("components[0].type = %q, want %q", body.Type, "body")
	}
	if len(body.Parameters) != 1 || body.Parameters[0].Type != "text" || body.Parameters[0].Text != "KSh 35" {
		t.Errorf("unexpected body parameters: %+v", body.Parameters)
	}
}

func TestWorker_UtilityMessage_WithChoices_SendsUtilityTemplateWithButtons(t *testing.T) {
	fbServer := newCapturingFacebookServer()
	defer fbServer.Close()

	questionText := "Can you make it at 10:00?"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_utility_question",
		ConversationID:    "conv_1",
		UserID:            "user_1",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_1",
		Message: types.MessageContent{
			Type:         types.MessageTypeQuestion,
			QuestionText: &questionText,
			Options: []types.Option{
				{Value: json.RawMessage(`"utility_2"`), Label: "Yes"},
				{Value: json.RawMessage(`"utility_2"`), Label: "No"},
			},
			Metadata: json.RawMessage(`{"type":"utility_message","template":"recontact_confirm","language":"en_US","params":["10:00"],"ref":"utility_2"}`),
		},
	}

	got := sendThroughWorker(t, fbServer, cmd)

	if got.MessagingType != "UTILITY" {
		t.Errorf("messaging_type = %q, want %q", got.MessagingType, "UTILITY")
	}
	tmpl := got.Message.Template
	if tmpl == nil {
		t.Fatalf("message.template is nil, want a populated template")
	}
	if len(tmpl.Components) != 2 {
		t.Fatalf("expected 2 components (body + buttons), got %d", len(tmpl.Components))
	}
	buttons := tmpl.Components[1]
	if buttons.Type != "buttons" {
		t.Errorf("components[1].type = %q, want %q", buttons.Type, "buttons")
	}
	if len(buttons.Parameters) != 2 {
		t.Fatalf("expected 2 button parameters (one per choice), got %d", len(buttons.Parameters))
	}
	for i, p := range buttons.Parameters {
		if p.Type != "POSTBACK" {
			t.Errorf("button[%d].type = %q, want %q", i, p.Type, "POSTBACK")
		}
		if p.Payload != "utility_2" {
			t.Errorf("button[%d].payload = %q, want %q (the field's own ref)", i, p.Payload, "utility_2")
		}
	}
}

func TestWorker_TaggedTextMessage_SurfacesMessagingTypeAndTag(t *testing.T) {
	fbServer := newCapturingFacebookServer()
	defer fbServer.Close()

	text := "Your appointment has been confirmed"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_tagged",
		ConversationID:    "conv_1",
		UserID:            "user_1",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_1",
		Message: types.MessageContent{
			Type:     types.MessageTypeText,
			Text:     &text,
			Metadata: json.RawMessage(`{"sendParams":{"messaging_type":"MESSAGE_TAG","tag":"CONFIRMED_EVENT_UPDATE"}}`),
		},
	}

	got := sendThroughWorker(t, fbServer, cmd)

	if got.MessagingType != "MESSAGE_TAG" {
		t.Errorf("messaging_type = %q, want %q", got.MessagingType, "MESSAGE_TAG")
	}
	if got.Tag != "CONFIRMED_EVENT_UPDATE" {
		t.Errorf("tag = %q, want %q", got.Tag, "CONFIRMED_EVENT_UPDATE")
	}
	if got.Message.Text != text {
		t.Errorf("message.text = %q, want %q (tagged send is still plain text, not a template)", got.Message.Text, text)
	}
	if got.Message.Template != nil {
		t.Errorf("message.template should be nil for a plain tagged text message, got %+v", got.Message.Template)
	}
}

func TestWorker_PlainTextMessage_OmitsMessagingTypeAndTag(t *testing.T) {
	fbServer := newCapturingFacebookServer()
	defer fbServer.Close()

	text := "Hello, world!"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_plain",
		ConversationID:    "conv_1",
		UserID:            "user_1",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "page_1",
		Message: types.MessageContent{
			Type: types.MessageTypeText,
			Text: &text,
		},
	}

	got := sendThroughWorker(t, fbServer, cmd)

	if got.MessagingType != "" {
		t.Errorf("messaging_type = %q, want empty for an untagged plain-text send", got.MessagingType)
	}
	if got.Tag != "" {
		t.Errorf("tag = %q, want empty for an untagged plain-text send", got.Tag)
	}
	if got.Message.Text != text {
		t.Errorf("message.text = %q, want %q", got.Message.Text, text)
	}
}
