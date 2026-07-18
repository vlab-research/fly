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

// Attachment represents a Messenger attachment (media)
type Attachment struct {
	Type    string            `json:"type"` // "image", "video", "audio", "file"
	Payload AttachmentPayload `json:"payload"`
}

// AttachmentPayload contains the attachment URL
type AttachmentPayload struct {
	URL         string `json:"url"`
	IsReusable  *bool  `json:"is_reusable,omitempty"`
}
