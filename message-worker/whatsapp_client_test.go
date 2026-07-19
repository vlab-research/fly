package messageworker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vlab-research/fly/message-worker/types"
)

type capturingWAServer struct {
	server *httptest.Server
	paths  []string
	bodies [][]byte
	auth   []string
}

func newCapturingWAServer(status int, respBody string) *capturingWAServer {
	s := &capturingWAServer{}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.paths = append(s.paths, r.URL.Path)
		s.bodies = append(s.bodies, body)
		s.auth = append(s.auth, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(respBody))
	}))
	return s
}

func (s *capturingWAServer) Close() { s.server.Close() }

const waOKResponse = `{"messaging_product":"whatsapp","contacts":[{"wa_id":"27123"}],"messages":[{"id":"wamid.test"}]}`

func TestWhatsAppClient_SendMessage_Text(t *testing.T) {
	server := newCapturingWAServer(http.StatusOK, waOKResponse)
	defer server.Close()

	client := NewWhatsAppClient(server.server.URL, NewStaticTokenStore("test-token"))
	body := "Hello from the bot"
	msg := types.WhatsAppMessage{Type: "text", Text: &types.WhatsAppText{Body: body}}

	resp, err := client.SendMessage(context.Background(), "PHONE_1", "27123", msg, nil)
	if err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}
	if !resp.Success || resp.MessageID != "wamid.test" {
		t.Errorf("resp = %+v, want Success=true MessageID=wamid.test", resp)
	}

	if len(server.paths) != 1 {
		t.Fatalf("expected 1 request, got %d", len(server.paths))
	}
	// POST /{phone_number_id}/messages
	if server.paths[0] != "/PHONE_1/messages" {
		t.Errorf("path = %s, want /PHONE_1/messages", server.paths[0])
	}
	if server.auth[0] != "Bearer test-token" {
		t.Errorf("auth = %s, want Bearer test-token", server.auth[0])
	}

	var out map[string]interface{}
	if err := json.Unmarshal(server.bodies[0], &out); err != nil {
		t.Fatalf("bad request body: %v", err)
	}
	if out["messaging_product"] != "whatsapp" {
		t.Errorf("messaging_product = %v, want whatsapp", out["messaging_product"])
	}
	if out["to"] != "27123" {
		t.Errorf("to = %v, want 27123", out["to"])
	}
	if out["type"] != "text" {
		t.Errorf("type = %v, want text", out["type"])
	}
	text, _ := out["text"].(map[string]interface{})
	if text == nil || text["body"] != body {
		t.Errorf("text.body = %v, want %q", out["text"], body)
	}
}

func TestWhatsAppClient_SendMessage_InteractiveButtons(t *testing.T) {
	server := newCapturingWAServer(http.StatusOK, waOKResponse)
	defer server.Close()

	client := NewWhatsAppClient(server.server.URL, NewStaticTokenStore("test-token"))
	msg := types.WhatsAppMessage{
		Type: "interactive",
		Interactive: &types.WhatsAppInteractive{
			Type: "button",
			Body: types.WhatsAppText{Text: "Pick one"},
			Action: types.WhatsAppAction{
				Buttons: []types.WhatsAppButton{
					{Type: "reply", Reply: types.WhatsAppButtonReply{ID: "0", Title: "Red"}},
				},
			},
		},
	}

	if _, err := client.SendMessage(context.Background(), "PHONE_1", "27123", msg, nil); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var out map[string]interface{}
	json.Unmarshal(server.bodies[0], &out)
	if out["type"] != "interactive" {
		t.Fatalf("type = %v, want interactive", out["type"])
	}
	interactive := out["interactive"].(map[string]interface{})
	action := interactive["action"].(map[string]interface{})
	buttons := action["buttons"].([]interface{})
	b0 := buttons[0].(map[string]interface{})
	reply := b0["reply"].(map[string]interface{})
	if reply["title"] != "Red" {
		t.Errorf("button title = %v, want Red", reply["title"])
	}
}

func TestWhatsAppClient_SendMessage_WrongMessageType(t *testing.T) {
	server := newCapturingWAServer(http.StatusOK, waOKResponse)
	defer server.Close()

	client := NewWhatsAppClient(server.server.URL, NewStaticTokenStore("test-token"))
	// Pass a non-WhatsAppMessage — the client must reject it before sending.
	_, err := client.SendMessage(context.Background(), "PHONE_1", "27123", "not-a-wa-message", nil)
	if err == nil {
		t.Fatal("expected error for wrong message type, got nil")
	}
	if len(server.paths) != 0 {
		t.Errorf("should not have sent a request, got %d", len(server.paths))
	}
}

func TestWhatsAppClient_SendMessage_HTTPError(t *testing.T) {
	server := newCapturingWAServer(http.StatusUnauthorized, `{"error":{"message":"Invalid token","code":190}}`)
	defer server.Close()

	client := NewWhatsAppClient(server.server.URL, NewStaticTokenStore("bad-token"))
	msg := types.WhatsAppMessage{Type: "text", Text: &types.WhatsAppText{Body: "hi"}}

	_, err := client.SendMessage(context.Background(), "PHONE_1", "27123", msg, nil)
	if err == nil {
		t.Fatal("expected error for 401 response, got nil")
	}
	if pe, ok := err.(*PlatformError); !ok {
		t.Errorf("expected *PlatformError, got %T", err)
	} else if pe.StatusCode != 190 {
		t.Errorf("StatusCode = %d, want 190 (parsed from error body)", pe.StatusCode)
	}
}

func TestWhatsAppClient_PassThreadControl_NoOp(t *testing.T) {
	client := NewWhatsAppClient("http://unused", NewStaticTokenStore("test-token"))
	if err := client.PassThreadControl(context.Background(), "27123", "PHONE_1", "app", "{}"); err != nil {
		t.Errorf("PassThreadControl should be a no-op returning nil, got %v", err)
	}
}
