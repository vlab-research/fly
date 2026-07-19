package types

// MessengerMessage represents a message in Messenger API format
type MessengerMessage struct {
	Text         string       `json:"text,omitempty"`
	QuickReplies []QuickReply `json:"quick_replies,omitempty"`
	Attachment   *Attachment  `json:"attachment,omitempty"`
	Metadata     string       `json:"metadata,omitempty"` // JSON string with ref for tracking
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
