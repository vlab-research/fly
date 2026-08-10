package messageworker

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

// stubMediaStore is a MediaStore test double, following the same pattern as
// stub_clients.go: a small, explicitly-configured stand-in rather than a mock
// framework.
type stubMediaStore struct {
	handle *types.MediaHandle
	err    error

	calls       int
	lastAssetID string
	lastAccount string
}

func (s *stubMediaStore) GetHandle(ctx context.Context, assetID, accountID string) (*types.MediaHandle, error) {
	s.calls++
	s.lastAssetID = assetID
	s.lastAccount = accountID
	return s.handle, s.err
}

func (s *stubMediaStore) Close() {}

// capturingMessageSender records the platform payload it was asked to send,
// so tests can assert on its shape (by-id vs by-url) without a real client.
type capturingMessageSender struct {
	lastMessage interface{}
	calls       int
}

func (m *capturingMessageSender) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}, platformContext json.RawMessage) (*SendMessageResponse, error) {
	m.calls++
	m.lastMessage = message
	return &SendMessageResponse{MessageID: "msg_1", Success: true}, nil
}

func (m *capturingMessageSender) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	return nil
}

const testAssetURL = "https://media.example.com/a/11111111-1111-1111-1111-111111111111"

func mediaCommand(platform types.PlatformType, url string) types.SendMessageCommand {
	return types.SendMessageCommand{
		CommandID:         "cmd_media_1",
		ConversationID:    "conv_1",
		UserID:            "user_1",
		Platform:          platform,
		PlatformAccountID: "account_1",
		Message: types.MessageContent{
			Type:      types.MessageTypeMedia,
			MediaType: mediaTypePtr(types.MediaTypeImage),
			MediaURL:  stringPtr(url),
		},
	}
}

func newMediaWorker(t *testing.T, sender MessageSender, store MediaStore, use bool) *Worker {
	t.Helper()
	mockBot := newMockBotserver()
	t.Cleanup(mockBot.Close)

	clients := map[types.PlatformType]MessageSender{
		types.PlatformMessenger: sender,
		types.PlatformWhatsApp:  sender,
	}
	w := NewWorker(clients, &mockEventProducer{}, mockBot.URL(), zap.NewNop())
	return w.WithMediaStore(store, use, time.Hour)
}

// Degradation is the design's core invariant (§13): a lookup failure must be
// logged and treated as a miss, and the message still sends -- by URL -- with
// no error surfaced to the caller. This is the most important test in this
// file.
func TestResolveMedia_StoreLookupError_DegradesToURL(t *testing.T) {
	store := &stubMediaStore{err: errors.New("crdb unavailable")}
	sender := &capturingMessageSender{}
	w := newMediaWorker(t, sender, store, true)

	cmd := mediaCommand(types.PlatformMessenger, testAssetURL)
	err := w.processSendMessage(context.Background(), cmd)
	if err != nil {
		t.Fatalf("expected no error to be surfaced to the caller, got %v", err)
	}
	if store.calls != 1 {
		t.Fatalf("expected store to be queried once, got %d calls", store.calls)
	}
	if sender.calls != 1 {
		t.Fatalf("expected message to still be sent, got %d calls", sender.calls)
	}
	msg, ok := sender.lastMessage.(types.MessengerSendRequest)
	if !ok {
		t.Fatalf("expected MessengerSendRequest, got %T", sender.lastMessage)
	}
	payload, ok := msg.Message.Attachment.Payload.(types.AttachmentPayload)
	if !ok {
		t.Fatalf("expected AttachmentPayload, got %T", msg.Message.Attachment.Payload)
	}
	if payload.URL != testAssetURL {
		t.Errorf("expected send by URL %q, got payload %+v", testAssetURL, payload)
	}
	if payload.AttachmentID != "" {
		t.Errorf("expected no attachment_id on a lookup failure, got %q", payload.AttachmentID)
	}
}

// A live, unexpired handle resolves by id on both Messenger and WhatsApp.
func TestResolveMedia_LiveHandle_SendsByID(t *testing.T) {
	store := &stubMediaStore{handle: &types.MediaHandle{PlatformMediaID: "platform_media_123"}}

	t.Run("messenger", func(t *testing.T) {
		sender := &capturingMessageSender{}
		w := newMediaWorker(t, sender, store, true)
		cmd := mediaCommand(types.PlatformMessenger, testAssetURL)
		if err := w.processSendMessage(context.Background(), cmd); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		msg := sender.lastMessage.(types.MessengerSendRequest)
		payload := msg.Message.Attachment.Payload.(types.AttachmentPayload)
		if payload.AttachmentID != "platform_media_123" {
			t.Errorf("expected attachment_id \"platform_media_123\", got payload %+v", payload)
		}
		if payload.URL != "" || payload.IsReusable != nil {
			t.Errorf("by-id payload must carry no url/is_reusable, got %+v", payload)
		}
	})

	t.Run("whatsapp", func(t *testing.T) {
		sender := &capturingMessageSender{}
		w := newMediaWorker(t, sender, store, true)
		cmd := mediaCommand(types.PlatformWhatsApp, testAssetURL)
		if err := w.processSendMessage(context.Background(), cmd); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		msg := sender.lastMessage.(types.WhatsAppMessage)
		if msg.Image == nil || msg.Image.ID != "platform_media_123" {
			t.Errorf("expected image.id \"platform_media_123\", got %+v", msg.Image)
		}
		if msg.Image.Link != "" {
			t.Errorf("by-id media must carry no link, got %+v", msg.Image)
		}
	})
}

// No handle row (nil, nil) is an ordinary miss: send by URL on both platforms.
func TestResolveMedia_Miss_SendsByURL(t *testing.T) {
	store := &stubMediaStore{} // handle: nil, err: nil

	t.Run("messenger", func(t *testing.T) {
		sender := &capturingMessageSender{}
		w := newMediaWorker(t, sender, store, true)
		cmd := mediaCommand(types.PlatformMessenger, testAssetURL)
		if err := w.processSendMessage(context.Background(), cmd); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		msg := sender.lastMessage.(types.MessengerSendRequest)
		payload := msg.Message.Attachment.Payload.(types.AttachmentPayload)
		if payload.URL != testAssetURL {
			t.Errorf("expected send by URL, got payload %+v", payload)
		}
	})

	t.Run("whatsapp", func(t *testing.T) {
		sender := &capturingMessageSender{}
		w := newMediaWorker(t, sender, store, true)
		cmd := mediaCommand(types.PlatformWhatsApp, testAssetURL)
		if err := w.processSendMessage(context.Background(), cmd); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		msg := sender.lastMessage.(types.WhatsAppMessage)
		if msg.Image == nil || msg.Image.Link != testAssetURL {
			t.Errorf("expected send by URL, got %+v", msg.Image)
		}
	})
}

// A third-party URL never matches the /a/<uuid> shape, so it must never reach
// the store at all -- it is sent as-is, exactly as it is today.
func TestResolveMedia_ThirdPartyURL_NeverQueriesStore(t *testing.T) {
	const thirdPartyURL = "https://i.imgur.com/x.png"
	store := &stubMediaStore{handle: &types.MediaHandle{PlatformMediaID: "should_not_be_used"}}
	sender := &capturingMessageSender{}
	w := newMediaWorker(t, sender, store, true)

	cmd := mediaCommand(types.PlatformMessenger, thirdPartyURL)
	if err := w.processSendMessage(context.Background(), cmd); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if store.calls != 0 {
		t.Fatalf("expected store not to be queried for a third-party URL, got %d calls", store.calls)
	}
	msg := sender.lastMessage.(types.MessengerSendRequest)
	payload := msg.Message.Attachment.Payload.(types.AttachmentPayload)
	if payload.URL != thirdPartyURL {
		t.Errorf("expected send by the original URL, got payload %+v", payload)
	}
}

// Rule 1 (§8.3): a legacy media_attachment_id command never touches the
// resolver or the store, and the payload is byte-for-byte unchanged.
func TestResolveMedia_LegacyAttachmentID_StoreNeverQueried(t *testing.T) {
	store := &stubMediaStore{handle: &types.MediaHandle{PlatformMediaID: "should_not_be_used"}}
	sender := &capturingMessageSender{}
	w := newMediaWorker(t, sender, store, true)

	cmd := types.SendMessageCommand{
		CommandID:         "cmd_legacy_1",
		ConversationID:    "conv_1",
		UserID:            "user_1",
		Platform:          types.PlatformMessenger,
		PlatformAccountID: "account_1",
		Message: types.MessageContent{
			Type:              types.MessageTypeMedia,
			MediaType:         mediaTypePtr(types.MediaTypeImage),
			MediaAttachmentID: stringPtr("1658615935222752"),
		},
	}
	if err := w.processSendMessage(context.Background(), cmd); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if store.calls != 0 {
		t.Fatalf("expected store not to be queried for a legacy attachment id, got %d calls", store.calls)
	}
	msg := sender.lastMessage.(types.MessengerSendRequest)
	payload := msg.Message.Attachment.Payload.(types.AttachmentPayload)
	if payload.AttachmentID != "1658615935222752" {
		t.Errorf("expected the legacy attachment_id unchanged, got payload %+v", payload)
	}
}

// With the handle layer disabled (MEDIA_HANDLE_USE off, the shipped-dark
// default), the store must never be queried even when one is configured.
func TestResolveMedia_HandleUseOff_StoreNeverQueried(t *testing.T) {
	store := &stubMediaStore{handle: &types.MediaHandle{PlatformMediaID: "should_not_be_used"}}
	sender := &capturingMessageSender{}
	w := newMediaWorker(t, sender, store, false)

	cmd := mediaCommand(types.PlatformMessenger, testAssetURL)
	if err := w.processSendMessage(context.Background(), cmd); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if store.calls != 0 {
		t.Fatalf("expected store not to be queried when MEDIA_HANDLE_USE is off, got %d calls", store.calls)
	}
	msg := sender.lastMessage.(types.MessengerSendRequest)
	payload := msg.Message.Attachment.Payload.(types.AttachmentPayload)
	if payload.URL != testAssetURL {
		t.Errorf("expected send by URL, got payload %+v", payload)
	}
}
