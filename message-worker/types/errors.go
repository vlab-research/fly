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
	ErrTooManyOptions         = errors.New("too many options for platform")
	ErrUnsupportedMediaType   = errors.New("unsupported media type for platform")
	ErrInvalidPlatform        = errors.New("invalid platform type")
	ErrMissingUtilityTemplate = errors.New(`utility_message field missing required "template" in metadata`)
	ErrMissingUtilityLanguage = errors.New(`utility_message field missing required "language" in metadata`)
)
