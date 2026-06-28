package types

// InstagramMessage represents a message in Instagram API format
// Instagram uses the same structure as Messenger
type InstagramMessage struct {
	Text         string       `json:"text,omitempty"`
	QuickReplies []QuickReply `json:"quick_replies,omitempty"`
	Attachment   *Attachment  `json:"attachment,omitempty"`
}
