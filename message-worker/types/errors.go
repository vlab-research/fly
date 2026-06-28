package types

import "errors"

// Command validation errors
var (
	ErrMissingTextField         = errors.New("text field is required for text messages")
	ErrMissingQuestionTextField = errors.New("question_text field is required for question messages")
	ErrMissingOptions           = errors.New("options are required for question messages")
	ErrMissingMediaType         = errors.New("media_type is required for media messages")
	ErrMissingMediaURL          = errors.New("media_url is required for media messages")
	ErrUnsupportedMessageType   = errors.New("unsupported message type")
)

// Translation errors
var (
	ErrTooManyOptions          = errors.New("too many options for platform")
	ErrUnsupportedMediaType    = errors.New("unsupported media type for platform")
	ErrInvalidPlatform         = errors.New("invalid platform type")
)
