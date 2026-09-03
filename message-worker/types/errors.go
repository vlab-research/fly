package types

import "errors"

// Command validation errors
var (
	ErrMissingTextField         = errors.New("text field is required for text messages")
	ErrMissingQuestionTextField = errors.New("question_text field is required for question messages")
	ErrMissingOptions           = errors.New("options are required for question messages")
	ErrMissingMediaType         = errors.New("media_type is required for media messages")
	ErrMissingMediaURL          = errors.New("media messages require either media_url or media_attachment_id")
	ErrUnsupportedMessageType   = errors.New("unsupported message type")
)

// Platform capability errors
var (
	ErrAttachmentIDUnsupported = errors.New("media_attachment_id is only supported on messenger")
)

// Translation errors
var (
	ErrTooManyOptions           = errors.New("too many options for platform")
	ErrUnsupportedMediaType     = errors.New("unsupported media type for platform")
	ErrInvalidPlatform          = errors.New("invalid platform type")
	ErrMissingUtilityTemplate   = errors.New(`utility_message field missing required "template" in metadata`)
	ErrMissingUtilityLanguage   = errors.New(`utility_message field missing required "language" in metadata`)
	ErrMissingWebviewURL        = errors.New(`webview field missing required "url" in metadata`)
	ErrWebviewButtonTextTooLong = errors.New("webview buttonText is too long for WhatsApp")
	ErrWebviewURLScheme         = errors.New("webview url scheme is not supported by WhatsApp")
)

// WhatsAppCTAButtonTextMaxChars is the Cloud API's documented ceiling on a
// cta_url button's display_text. Exceeding it makes WhatsApp reject the whole
// message, so the translator fails loudly with the field ref instead — a
// STATE_ACTIONS error the researcher can see and fix, rather than an opaque
// delivery failure.
const WhatsAppCTAButtonTextMaxChars = 20

// WhatsAppRowDescriptionMaxChars is the Cloud API's ceiling on a list row's
// description — the secondary line under the row title, which carries the full
// option text on WhatsApp.
//
// Unlike the cta_url cap above this one is not enforced by failing the send: a
// description is supporting text, and clipping it costs a few words at the end
// of a line the respondent can still read in full in the message body. Failing
// the whole question over it would strand the respondent for no gain.
const WhatsAppRowDescriptionMaxChars = 72
