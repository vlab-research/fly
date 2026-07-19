package types

import (
	"encoding/json"
	"fmt"
)

type PlatformType string

const (
	PlatformMessenger PlatformType = "messenger"
	PlatformWhatsApp  PlatformType = "whatsapp"
	PlatformInstagram PlatformType = "instagram"
	PlatformTelegram  PlatformType = "telegram"
)

type SendMessageCommand struct {
	Type              string          `json:"type,omitempty"`
	CommandID         string          `json:"command_id"`
	IssuedAt          int64           `json:"issued_at"`
	ConversationID    string          `json:"conversation_id"`
	UserID            string          `json:"user_id"`
	Platform          PlatformType    `json:"platform"`
	PlatformAccountID string          `json:"platform_account_id"`
	Message           MessageContent  `json:"message"`
	PlatformContext   json.RawMessage `json:"platform_context,omitempty"`
}

type HandoffCommand struct {
	Type              string          `json:"type"`
	CommandID         string          `json:"command_id"`
	IssuedAt          int64           `json:"issued_at"`
	ConversationID    string          `json:"conversation_id"`
	UserID            string          `json:"user_id"`
	Platform          PlatformType    `json:"platform"`
	PlatformAccountID string          `json:"platform_account_id"`
	TargetAppID       string          `json:"target_app_id"`
	Metadata          json.RawMessage `json:"metadata,omitempty"`
}

type MessageType string

const (
	MessageTypeText     MessageType = "text"
	MessageTypeQuestion MessageType = "question"
	MessageTypeMedia    MessageType = "media"
)

type MediaType string

const (
	MediaTypeImage MediaType = "image"
	MediaTypeVideo MediaType = "video"
	MediaTypeAudio MediaType = "audio"
	MediaTypeFile  MediaType = "file"
)

type MessageContent struct {
	Type MessageType `json:"type"`

	Text *string `json:"text,omitempty"`

	QuestionText *string  `json:"question_text,omitempty"`
	Options      []Option `json:"options,omitempty"`

	MediaType *MediaType `json:"media_type,omitempty"`
	MediaURL  *string    `json:"media_url,omitempty"`
	Caption   *string    `json:"caption,omitempty"`

	Metadata json.RawMessage `json:"metadata,omitempty"`
}

type Option struct {
	Value       json.RawMessage `json:"value"`
	Label       string          `json:"label"`
	Description *string         `json:"description,omitempty"`
}

func (o *Option) ValueAsString() string {
	if len(o.Value) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(o.Value, &s); err == nil {
		return s
	}
	var b bool
	if err := json.Unmarshal(o.Value, &b); err == nil {
		if b {
			return "true"
		}
		return "false"
	}
	var f float64
	if err := json.Unmarshal(o.Value, &f); err == nil {
		if f == float64(int64(f)) {
			return fmt.Sprintf("%d", int64(f))
		}
		return fmt.Sprintf("%v", f)
	}
	return string(o.Value)
}

func (mc *MessageContent) GetMetadataString() string {
	if len(mc.Metadata) == 0 {
		return ""
	}
	return string(mc.Metadata)
}

func (mc *MessageContent) GetRefFromMetadata() string {
	if len(mc.Metadata) == 0 {
		return ""
	}
	var m map[string]interface{}
	if err := json.Unmarshal(mc.Metadata, &m); err != nil {
		return ""
	}
	if ref, ok := m["ref"]; ok {
		if refStr, ok := ref.(string); ok {
			return refStr
		}
	}
	return ""
}

func (mc *MessageContent) GetTypeFromMetadata() string {
	if len(mc.Metadata) == 0 {
		return ""
	}
	var m map[string]interface{}
	if err := json.Unmarshal(mc.Metadata, &m); err != nil {
		return ""
	}
	if t, ok := m["type"]; ok {
		if tStr, ok := t.(string); ok {
			return tStr
		}
	}
	return ""
}

func (cmd *SendMessageCommand) GetOTNToken() string {
	if len(cmd.PlatformContext) == 0 {
		return ""
	}
	var pc struct {
		OneTimeNotifToken string `json:"one_time_notif_token"`
	}
	if err := json.Unmarshal(cmd.PlatformContext, &pc); err != nil {
		return ""
	}
	return pc.OneTimeNotifToken
}

func (mc *MessageContent) UnmarshalJSON(data []byte) error {
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
	default:
		return ErrUnsupportedMessageType
	}
	return nil
}
