package messageworker

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/vlab-research/fly/message-worker/types"
)

// An attachment-id payload must serialise without a "url" key at all --
// Messenger rejects `"url": ""` with (#100) "... should represent a valid URL",
// which is the bug this guards against.
func TestAttachmentIDPayloadOmitsURL(t *testing.T) {
	b, err := json.Marshal(types.AttachmentPayload{AttachmentID: "1658615935222752"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got, want := string(b), `{"attachment_id":"1658615935222752"}`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

// The URL form must keep is_reusable -- that flag is what makes Messenger mint
// an attachment id in the first place.
func TestMediaURLPayloadKeepsIsReusable(t *testing.T) {
	b, err := json.Marshal(types.AttachmentPayload{URL: "https://example.com/i.jpg", IsReusable: ptrBool(true)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got, want := string(b), `{"url":"https://example.com/i.jpg","is_reusable":true}`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

// Attachment ids are scoped to the page that uploaded the media, so the
// non-Messenger translators must reject them rather than nil-deref MediaURL.
func TestAttachmentIDRejectedOnOtherPlatforms(t *testing.T) {
	msg := types.MessageContent{
		Type:              types.MessageTypeMedia,
		MediaType:         mediaTypePtr(types.MediaTypeImage),
		MediaAttachmentID: stringPtr("1658615935222752"),
	}

	if _, err := translateWhatsAppMedia(msg, nil); !errors.Is(err, types.ErrAttachmentIDUnsupported) {
		t.Errorf("whatsapp: got %v, want ErrAttachmentIDUnsupported", err)
	}
	if _, err := translateInstagramMedia(msg, nil); !errors.Is(err, types.ErrAttachmentIDUnsupported) {
		t.Errorf("instagram: got %v, want ErrAttachmentIDUnsupported", err)
	}
}

// Full TranslateToMessenger pin, one layer above the AttachmentPayload-only
// pins above. §8.3 rule 1 of the media-abstraction resolver ("legacy
// passthrough, byte-for-byte unchanged") depends on this exact shape holding
// for every media type, not just image -- audio/video/file share the same
// attachmentType switch in translateMessengerMedia, but a struct-level test
// wouldn't catch an accidental field on MessengerMessage (e.g. a stray
// Metadata default) leaking into the marshalled payload the way a literal
// JSON string comparison does. mentalitybaseline and ENGbauchiMNCHmid
// (tens of thousands of responses/day) carry essentially all of this traffic
// via MediaAttachmentID today, so this pin is the regression gate for the
// refactor that follows.
func TestTranslateToMessengerMediaByAttachmentID_PinnedJSON(t *testing.T) {
	tests := []struct {
		name      string
		mediaType types.MediaType
		wantJSON  string
	}{
		{"image", types.MediaTypeImage, `{"attachment":{"type":"image","payload":{"attachment_id":"1658615935222752"}}}`},
		{"video", types.MediaTypeVideo, `{"attachment":{"type":"video","payload":{"attachment_id":"1658615935222752"}}}`},
		{"audio", types.MediaTypeAudio, `{"attachment":{"type":"audio","payload":{"attachment_id":"1658615935222752"}}}`},
		{"file", types.MediaTypeFile, `{"attachment":{"type":"file","payload":{"attachment_id":"1658615935222752"}}}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := types.SendMessageCommand{
				CommandID:      "cmd_pin_id_" + tt.name,
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type:              types.MessageTypeMedia,
					MediaType:         mediaTypePtr(tt.mediaType),
					MediaAttachmentID: stringPtr("1658615935222752"),
				},
			}

			got, err := TranslateToMessenger(cmd)
			if err != nil {
				t.Fatalf("TranslateToMessenger() error = %v", err)
			}

			b, err := json.Marshal(got)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			// The critical invariant: no "url" key and no "is_reusable" key at
			// all when sending by attachment id. Messenger rejects an empty
			// "url" with (#100) "... should represent a valid URL" -- that is
			// the bug a stray omitempty-less field would silently reintroduce.
			if got, want := string(b), tt.wantJSON; got != want {
				t.Errorf("TranslateToMessenger() = %s, want %s", got, want)
			}
		})
	}
}

// Converse of the pin above: sending by URL keeps "url" + "is_reusable" and
// carries no "attachment_id" key. Pinned at the same TranslateToMessenger
// level so the two forms are guaranteed mutually exclusive in the actual
// wire payload, not just in the Go struct the translator builds.
func TestTranslateToMessengerMediaByURL_PinnedJSON(t *testing.T) {
	tests := []struct {
		name      string
		mediaType types.MediaType
		url       string
		wantJSON  string
	}{
		{"image", types.MediaTypeImage, "https://example.com/image.jpg", `{"attachment":{"type":"image","payload":{"url":"https://example.com/image.jpg","is_reusable":true}}}`},
		{"video", types.MediaTypeVideo, "https://example.com/video.mp4", `{"attachment":{"type":"video","payload":{"url":"https://example.com/video.mp4","is_reusable":true}}}`},
		{"audio", types.MediaTypeAudio, "https://example.com/audio.mp3", `{"attachment":{"type":"audio","payload":{"url":"https://example.com/audio.mp3","is_reusable":true}}}`},
		{"file", types.MediaTypeFile, "https://example.com/doc.pdf", `{"attachment":{"type":"file","payload":{"url":"https://example.com/doc.pdf","is_reusable":true}}}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := types.SendMessageCommand{
				CommandID:      "cmd_pin_url_" + tt.name,
				ConversationID: "conv_1",
				UserID:         "user_1",
				Platform:       types.PlatformMessenger,
				Message: types.MessageContent{
					Type:      types.MessageTypeMedia,
					MediaType: mediaTypePtr(tt.mediaType),
					MediaURL:  stringPtr(tt.url),
				},
			}

			got, err := TranslateToMessenger(cmd)
			if err != nil {
				t.Fatalf("TranslateToMessenger() error = %v", err)
			}

			b, err := json.Marshal(got)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			if got, want := string(b), tt.wantJSON; got != want {
				t.Errorf("TranslateToMessenger() = %s, want %s", got, want)
			}
		})
	}
}

// Metadata (the JSON string carrying the field ref, used for delivery
// tracking) rides alongside the attachment on both branches -- it must
// survive the attachment-id path exactly the same way it does the URL path,
// since replybot's generic-translator.js sets it independently of which
// media identifier is present.
func TestTranslateToMessengerMedia_MetadataPinnedOnBothBranches(t *testing.T) {
	metadata := json.RawMessage(`{"ref":"q_123"}`)

	byID := types.SendMessageCommand{
		CommandID:      "cmd_pin_meta_id",
		ConversationID: "conv_1",
		UserID:         "user_1",
		Platform:       types.PlatformMessenger,
		Message: types.MessageContent{
			Type:              types.MessageTypeMedia,
			MediaType:         mediaTypePtr(types.MediaTypeImage),
			MediaAttachmentID: stringPtr("1658615935222752"),
			Metadata:          metadata,
		},
	}

	got, err := TranslateToMessenger(byID)
	if err != nil {
		t.Fatalf("TranslateToMessenger() error = %v", err)
	}
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got, want := string(b), `{"attachment":{"type":"image","payload":{"attachment_id":"1658615935222752"}},"metadata":"{\"ref\":\"q_123\"}"}`; got != want {
		t.Errorf("attachment-id branch: TranslateToMessenger() = %s, want %s", got, want)
	}

	byURL := byID
	byURL.CommandID = "cmd_pin_meta_url"
	byURL.Message.MediaAttachmentID = nil
	byURL.Message.MediaURL = stringPtr("https://example.com/image.jpg")

	got, err = TranslateToMessenger(byURL)
	if err != nil {
		t.Fatalf("TranslateToMessenger() error = %v", err)
	}
	b, err = json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got, want := string(b), `{"attachment":{"type":"image","payload":{"url":"https://example.com/image.jpg","is_reusable":true}},"metadata":"{\"ref\":\"q_123\"}"}`; got != want {
		t.Errorf("url branch: TranslateToMessenger() = %s, want %s", got, want)
	}
}

// Either identifier satisfies validation; neither does not.
func TestMediaValidationAcceptsEitherIdentifier(t *testing.T) {
	base := func() types.MessageContent {
		return types.MessageContent{Type: types.MessageTypeMedia, MediaType: mediaTypePtr(types.MediaTypeImage)}
	}

	byURL := base()
	byURL.MediaURL = stringPtr("https://example.com/i.jpg")
	if err := byURL.Validate(); err != nil {
		t.Errorf("url form: unexpected error %v", err)
	}

	byID := base()
	byID.MediaAttachmentID = stringPtr("1658615935222752")
	if err := byID.Validate(); err != nil {
		t.Errorf("attachment id form: unexpected error %v", err)
	}

	neither := base()
	if err := neither.Validate(); !errors.Is(err, types.ErrMissingMediaURL) {
		t.Errorf("neither: got %v, want ErrMissingMediaURL", err)
	}
}
