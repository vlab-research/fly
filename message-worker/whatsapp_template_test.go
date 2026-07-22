package messageworker

// Functional tests for WhatsApp template sends (utility_message fields on the
// WhatsApp path). WhatsApp only allows free-form sends within 24h of the
// user's last message; outside that window (dean timeouts / follow-ups,
// payment retries) the business must send a pre-approved template. These
// mirror messenger_client_utility_tag_test.go: a full
// types.SendMessageCommand is driven through Worker.ProcessCommand ->
// processSendMessage -> TranslateToWhatsApp -> the *real* WhatsAppClient ->
// an httptest server standing in for the WhatsApp Cloud API, asserting on
// the raw outbound HTTP request body — the level at which a wrong template
// shape actually manifests.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

// outboundWhatsAppRequest mirrors the wire shape of WhatsAppSendRequest for
// template sends (kept independent of the production structs so the test
// doesn't silently pass just because it round-trips through the same types).
type outboundWhatsAppRequest struct {
	MessagingProduct string `json:"messaging_product"`
	RecipientType    string `json:"recipient_type"`
	To               string `json:"to"`
	Type             string `json:"type"`
	Text             *struct {
		Body string `json:"body"`
	} `json:"text"`
	Template *struct {
		Name     string `json:"name"`
		Language struct {
			Code string `json:"code"`
		} `json:"language"`
		Components []struct {
			Type       string `json:"type"`
			SubType    string `json:"sub_type"`
			Index      string `json:"index"`
			Parameters []struct {
				Type    string `json:"type"`
				Text    string `json:"text"`
				Payload string `json:"payload"`
			} `json:"parameters"`
		} `json:"components"`
	} `json:"template"`
}

func sendThroughWhatsAppWorker(t *testing.T, waServer *capturingWAServer, cmd types.SendMessageCommand) outboundWhatsAppRequest {
	t.Helper()

	mockBot := newMockBotserver()
	defer mockBot.Close()

	client := NewWhatsAppClient(waServer.server.URL, NewStaticTokenStore("test-token"))
	clients := map[types.PlatformType]MessageSender{types.PlatformWhatsApp: client}
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

	if len(waServer.bodies) != 1 {
		t.Fatalf("expected exactly 1 request to WhatsApp, got %d", len(waServer.bodies))
	}

	var got outboundWhatsAppRequest
	if err := json.Unmarshal(waServer.bodies[0], &got); err != nil {
		t.Fatalf("failed to unmarshal outbound WhatsApp request: %v\nbody: %s", err, waServer.bodies[0])
	}
	return got
}

func TestWorker_WhatsAppUtilityMessage_NoChoices_SendsTemplate(t *testing.T) {
	waServer := newCapturingWAServer(http.StatusOK, waOKResponse)
	defer waServer.Close()

	text := "Your payment of KSh 35 is confirmed"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_wa_utility_text",
		ConversationID:    "conv_1",
		UserID:            "27123456789",
		Platform:          types.PlatformWhatsApp,
		PlatformAccountID: "PHONE_1",
		Message: types.MessageContent{
			Type:     types.MessageTypeText,
			Text:     &text,
			Metadata: json.RawMessage(`{"type":"utility_message","template":"recontact_owis","language":"en_US","params":["KSh 35"],"ref":"utility_1"}`),
		},
	}

	got := sendThroughWhatsAppWorker(t, waServer, cmd)

	if waServer.paths[0] != "/PHONE_1/messages" {
		t.Errorf("path = %s, want /PHONE_1/messages", waServer.paths[0])
	}
	if got.MessagingProduct != "whatsapp" {
		t.Errorf("messaging_product = %q, want %q", got.MessagingProduct, "whatsapp")
	}
	if got.To != "27123456789" {
		t.Errorf("to = %q, want %q", got.To, "27123456789")
	}
	if got.Type != "template" {
		t.Errorf("type = %q, want %q (utility message must be a template send, not free-form)", got.Type, "template")
	}
	if got.Text != nil {
		t.Errorf("text = %+v, want absent (template send must not carry a text body)", got.Text)
	}
	tmpl := got.Template
	if tmpl == nil {
		t.Fatalf("template is nil, want a populated template")
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

func TestWorker_WhatsAppUtilityMessage_WithChoices_SendsQuickReplyButtons(t *testing.T) {
	waServer := newCapturingWAServer(http.StatusOK, waOKResponse)
	defer waServer.Close()

	questionText := "Can you make it at 10:00?"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_wa_utility_question",
		ConversationID:    "conv_1",
		UserID:            "27123456789",
		Platform:          types.PlatformWhatsApp,
		PlatformAccountID: "PHONE_1",
		Message: types.MessageContent{
			Type:         types.MessageTypeQuestion,
			QuestionText: &questionText,
			Options: []types.Option{
				{Value: json.RawMessage(`"Yes"`), Label: "Yes"},
				{Value: json.RawMessage(`"No"`), Label: "No"},
			},
			Metadata: json.RawMessage(`{"type":"utility_message","template":"recontact_confirm","language":"en_US","params":["10:00"],"ref":"utility_2"}`),
		},
	}

	got := sendThroughWhatsAppWorker(t, waServer, cmd)

	if got.Type != "template" {
		t.Fatalf("type = %q, want %q", got.Type, "template")
	}
	tmpl := got.Template
	if tmpl == nil {
		t.Fatalf("template is nil, want a populated template")
	}
	// body + one component per button (WhatsApp's per-button shape — NOT
	// Messenger's single "buttons" component).
	if len(tmpl.Components) != 3 {
		t.Fatalf("expected 3 components (body + 2 buttons), got %d", len(tmpl.Components))
	}
	if tmpl.Components[0].Type != "body" {
		t.Errorf("components[0].type = %q, want %q", tmpl.Components[0].Type, "body")
	}
	wantValues := []string{"Yes", "No"}
	for i := 0; i < 2; i++ {
		btn := tmpl.Components[i+1]
		if btn.Type != "button" {
			t.Errorf("components[%d].type = %q, want %q", i+1, btn.Type, "button")
		}
		if btn.SubType != "quick_reply" {
			t.Errorf("components[%d].sub_type = %q, want %q", i+1, btn.SubType, "quick_reply")
		}
		if btn.Index != []string{"0", "1"}[i] {
			t.Errorf("components[%d].index = %q, want %q", i+1, btn.Index, []string{"0", "1"}[i])
		}
		if len(btn.Parameters) != 1 {
			t.Fatalf("components[%d] expected 1 parameter, got %d", i+1, len(btn.Parameters))
		}
		p := btn.Parameters[0]
		if p.Type != "payload" {
			t.Errorf("components[%d].parameters[0].type = %q, want %q", i+1, p.Type, "payload")
		}
		// The payload must be the same {"value":...,"ref":...} JSON that
		// Messenger quick replies deliver, so replybot's inbound quick-reply
		// handling parses it unchanged.
		var payload struct {
			Value string `json:"value"`
			Ref   string `json:"ref"`
		}
		if err := json.Unmarshal([]byte(p.Payload), &payload); err != nil {
			t.Fatalf("components[%d] payload is not valid JSON: %v (payload: %s)", i+1, err, p.Payload)
		}
		if payload.Value != wantValues[i] {
			t.Errorf("components[%d] payload.value = %q, want %q", i+1, payload.Value, wantValues[i])
		}
		if payload.Ref != "utility_2" {
			t.Errorf("components[%d] payload.ref = %q, want %q", i+1, payload.Ref, "utility_2")
		}
	}
}

func TestWorker_WhatsAppUtilityMessage_NoParams_OmitsBodyComponent(t *testing.T) {
	waServer := newCapturingWAServer(http.StatusOK, waOKResponse)
	defer waServer.Close()

	text := "We have your results ready"
	cmd := types.SendMessageCommand{
		CommandID:         "cmd_wa_utility_noparams",
		ConversationID:    "conv_1",
		UserID:            "27123456789",
		Platform:          types.PlatformWhatsApp,
		PlatformAccountID: "PHONE_1",
		Message: types.MessageContent{
			Type:     types.MessageTypeText,
			Text:     &text,
			Metadata: json.RawMessage(`{"type":"utility_message","template":"results_ready","language":"en_US","ref":"utility_3"}`),
		},
	}

	got := sendThroughWhatsAppWorker(t, waServer, cmd)

	tmpl := got.Template
	if tmpl == nil {
		t.Fatalf("template is nil, want a populated template")
	}
	// WhatsApp rejects a body component with an empty parameters array, so a
	// paramless template send carries no components at all (unlike Messenger,
	// which always includes a body component).
	if len(tmpl.Components) != 0 {
		t.Errorf("expected 0 components for a paramless, buttonless template, got %d: %+v", len(tmpl.Components), tmpl.Components)
	}
}

func TestTranslateToWhatsApp_UtilityMessage_MissingTemplate_Errors(t *testing.T) {
	text := "hello"
	cmd := types.SendMessageCommand{
		Platform: types.PlatformWhatsApp,
		Message: types.MessageContent{
			Type:     types.MessageTypeText,
			Text:     &text,
			Metadata: json.RawMessage(`{"type":"utility_message","language":"en_US"}`),
		},
	}
	_, err := TranslateToWhatsApp(cmd)
	if !errors.Is(err, types.ErrMissingUtilityTemplate) {
		t.Errorf("err = %v, want ErrMissingUtilityTemplate", err)
	}
}

func TestTranslateToWhatsApp_UtilityMessage_MissingLanguage_Errors(t *testing.T) {
	text := "hello"
	cmd := types.SendMessageCommand{
		Platform: types.PlatformWhatsApp,
		Message: types.MessageContent{
			Type:     types.MessageTypeText,
			Text:     &text,
			Metadata: json.RawMessage(`{"type":"utility_message","template":"results_ready"}`),
		},
	}
	_, err := TranslateToWhatsApp(cmd)
	if !errors.Is(err, types.ErrMissingUtilityLanguage) {
		t.Errorf("err = %v, want ErrMissingUtilityLanguage", err)
	}
}
