package types

import (
	"encoding/json"
	"fmt"
)

// PlatformType represents the chat platform
type PlatformType string

const (
	PlatformMessenger PlatformType = "messenger"
	PlatformWhatsApp  PlatformType = "whatsapp"
	PlatformInstagram PlatformType = "instagram"
	PlatformTelegram  PlatformType = "telegram"
)

// SendMessageCommand represents the platform-agnostic message command
type SendMessageCommand struct {
	CommandID         string       `json:"command_id"`
	IssuedAt          int64        `json:"issued_at"`
	ConversationID    string       `json:"conversation_id"`
	UserID            string       `json:"user_id"`
	Platform          PlatformType `json:"platform"`
	PlatformAccountID string       `json:"platform_account_id"`
	Message           MessageContent `json:"message"`
}

// MessageType represents the type of message content
type MessageType string

const (
	MessageTypeText             MessageType = "text"
	MessageTypeQuestion         MessageType = "question"
	MessageTypeMedia            MessageType = "media"
	MessageTypeNative           MessageType = "native"
	MessageTypePassThreadControl MessageType = "pass_thread_control"
)

// MediaType represents the type of media content
type MediaType string

const (
	MediaTypeImage MediaType = "image"
	MediaTypeVideo MediaType = "video"
	MediaTypeAudio MediaType = "audio"
	MediaTypeFile  MediaType = "file"
)

// MessageContent represents platform-agnostic message content with type discrimination
type MessageContent struct {
	Type MessageType `json:"type"` // "text", "question", "media", "native", "pass_thread_control"

	// For text messages
	Text *string `json:"text,omitempty"`

	// For question messages
	QuestionText *string  `json:"question_text,omitempty"`
	Options      []Option `json:"options,omitempty"`

	// For media messages
	MediaType *MediaType `json:"media_type,omitempty"`
	MediaURL  *string    `json:"media_url,omitempty"`
	Caption   *string    `json:"caption,omitempty"`

	// For native passthrough messages (type: "native")
	// Pre-formatted platform-specific payload that bypasses translation
	NativePayload json.RawMessage `json:"native_payload,omitempty"`

	// For pass_thread_control messages (type: "pass_thread_control")
	TargetAppID      string `json:"target_app_id,omitempty"`     // App to hand off to
	HandoffMetadata  string `json:"handoff_metadata,omitempty"` // JSON string context for handoff

	// Metadata for tracking (contains ref for question matching)
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// Option represents a choice option in a question
type Option struct {
	// Value can be a string, boolean, or number depending on field type:
	// - yes_no/legal: boolean (true/false)
	// - multiple_choice: string (the choice ref or label)
	// - rating/opinion_scale: string number ("1", "2", etc.)
	Value interface{} `json:"value"` // The actual value/payload
	Label string      `json:"label"` // What the user sees
}

// ValueAsString returns the Value as a string for platforms that need string payloads
// - strings are returned as-is
// - booleans are returned as "true" or "false"
// - numbers are formatted as their string representation
func (o *Option) ValueAsString() string {
	switch v := o.Value.(type) {
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		// JSON numbers are float64
		if v == float64(int64(v)) {
			return fmt.Sprintf("%d", int64(v))
		}
		return fmt.Sprintf("%v", v)
	default:
		return fmt.Sprintf("%v", v)
	}
}

// UnmarshalJSON implements custom JSON unmarshaling to handle type discrimination
func (mc *MessageContent) UnmarshalJSON(data []byte) error {
	// First unmarshal into a temporary struct to get all fields
	type Alias MessageContent
	aux := &struct {
		*Alias
	}{
		Alias: (*Alias)(mc),
	}

	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}

	return nil
}

// Validate checks if the message content is valid
func (mc *MessageContent) Validate() error {
	switch mc.Type {
	case MessageTypeText:
		if mc.Text == nil || *mc.Text == "" {
			return ErrMissingTextField
		}
	case MessageTypeQuestion:
		if mc.QuestionText == nil || *mc.QuestionText == "" {
			return ErrMissingQuestionTextField
		}
		if len(mc.Options) == 0 {
			return ErrMissingOptions
		}
	case MessageTypeMedia:
		if mc.MediaType == nil {
			return ErrMissingMediaType
		}
		if mc.MediaURL == nil || *mc.MediaURL == "" {
			return ErrMissingMediaURL
		}
	case MessageTypeNative:
		if len(mc.NativePayload) == 0 {
			return fmt.Errorf("native_payload is required for type 'native'")
		}
	case MessageTypePassThreadControl:
		if mc.TargetAppID == "" {
			return fmt.Errorf("target_app_id is required for type 'pass_thread_control'")
		}
	default:
		return ErrUnsupportedMessageType
	}
	return nil
}
