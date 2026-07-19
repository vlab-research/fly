package types

// MessengerMessage represents a message in Messenger API format
type MessengerMessage struct {
	Text         string           `json:"text,omitempty"`
	QuickReplies []QuickReply     `json:"quick_replies,omitempty"`
	Attachment   *Attachment      `json:"attachment,omitempty"`
	Template     *MessageTemplate `json:"template,omitempty"` // Meta message template (utility_message)
	Metadata     string           `json:"metadata,omitempty"` // JSON string with ref for tracking
}

// MessengerSendRequest wraps a translated MessengerMessage together with the
// top-level Facebook Send API fields (messaging_type, tag) that must ride
// alongside — not inside — the message body. Facebook's Send API puts
// messaging_type/tag as siblings of "message" on the request, so they can't
// live on MessengerMessage itself; this wrapper is what TranslateToMessenger's
// caller builds before handing off to MessengerClient.SendMessage.
type MessengerSendRequest struct {
	Message       MessengerMessage
	MessagingType string
	Tag           string
}

// MessageTemplate represents a Meta message template payload, e.g. for
// utility_message (messaging_type: UTILITY). Distinct from TemplatePayload,
// which is the older Messenger *attachment* template (button /
// one_time_notif_req / notification_messages) — this is the newer
// message.template shape used for WhatsApp-style pre-approved templates sent
// over Messenger's utility messaging class.
type MessageTemplate struct {
	Name       string              `json:"name"`
	Language   TemplateLanguage    `json:"language"`
	Components []TemplateComponent `json:"components,omitempty"`
}

// TemplateLanguage identifies the approved template's language code (e.g. "en_US").
type TemplateLanguage struct {
	Code string `json:"code"`
}

// TemplateComponent is one component of a MessageTemplate ("body" carries
// text substitutions, "buttons" carries per-button POSTBACK payloads).
type TemplateComponent struct {
	Type       string                       `json:"type"`
	Parameters []TemplateComponentParameter `json:"parameters,omitempty"`
}

// TemplateComponentParameter is a single parameter within a TemplateComponent:
// {type: "text", text: ...} for body components, {type: "POSTBACK", payload: ...}
// for button components.
type TemplateComponentParameter struct {
	Type    string `json:"type,omitempty"`
	Text    string `json:"text,omitempty"`
	Payload string `json:"payload,omitempty"`
}

// QuickReply represents a Messenger quick reply button
type QuickReply struct {
	ContentType string `json:"content_type"`        // "text", "user_phone_number", "user_email"
	Title       string `json:"title,omitempty"`     // Only for "text" type quick replies
	Payload     string `json:"payload,omitempty"`   // Only for "text" type quick replies
}

// Attachment represents a Messenger attachment. Payload holds either an
// AttachmentPayload (media) or a TemplatePayload (button / one_time_notif_req /
// notification_messages templates); both marshal correctly through interface{}.
type Attachment struct {
	Type    string      `json:"type"` // "image", "video", "audio", "file", "template"
	Payload interface{} `json:"payload"`
}

// AttachmentPayload contains the attachment URL
type AttachmentPayload struct {
	URL         string `json:"url"`
	IsReusable  *bool  `json:"is_reusable,omitempty"`
}

// TemplatePayload represents a Messenger template attachment payload. The set of
// populated fields depends on TemplateType ("button", "one_time_notif_req",
// "notification_messages").
type TemplatePayload struct {
	TemplateType string   `json:"template_type"`
	Text         string   `json:"text,omitempty"`         // button template
	Buttons      []Button `json:"buttons,omitempty"`      // button template
	Title        string   `json:"title,omitempty"`        // one_time_notif_req / notification_messages
	Payload      string   `json:"payload,omitempty"`      // one_time_notif_req / notification_messages (JSON string with ref)

	NotificationMessagesTimezone string `json:"notification_messages_timezone,omitempty"`
	NotificationMessagesCTAText  string `json:"notification_messages_cta_text,omitempty"`
}

// Button represents a Messenger template button (web_url, postback, ...)
type Button struct {
	Type                string `json:"type"`
	Title               string `json:"title,omitempty"`
	URL                 string `json:"url,omitempty"`                  // web_url
	WebviewHeightRatio  string `json:"webview_height_ratio,omitempty"` // web_url
	MessengerExtensions *bool  `json:"messenger_extensions,omitempty"` // web_url; kept even when false
	Payload             string `json:"payload,omitempty"`              // postback
}
