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

	if _, err := translateWhatsAppMedia(msg); !errors.Is(err, types.ErrAttachmentIDUnsupported) {
		t.Errorf("whatsapp: got %v, want ErrAttachmentIDUnsupported", err)
	}
	if _, err := translateInstagramMedia(msg); !errors.Is(err, types.ErrAttachmentIDUnsupported) {
		t.Errorf("instagram: got %v, want ErrAttachmentIDUnsupported", err)
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
