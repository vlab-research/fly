package types

// WhatsAppMessage represents a message in WhatsApp API format
type WhatsAppMessage struct {
	Type        string               `json:"type"` // "text", "interactive", "image", "video", "audio", "document"
	Text        *WhatsAppText        `json:"text,omitempty"`
	Interactive *WhatsAppInteractive `json:"interactive,omitempty"`
	Image       *WhatsAppMedia       `json:"image,omitempty"`
	Video       *WhatsAppMedia       `json:"video,omitempty"`
	Audio       *WhatsAppMedia       `json:"audio,omitempty"`
	Document    *WhatsAppMedia       `json:"document,omitempty"`
}

// WhatsAppText represents text content
type WhatsAppText struct {
	Body string `json:"body,omitempty"`
	Text string `json:"text,omitempty"`
}

// WhatsAppInteractive represents interactive messages (buttons, lists)
type WhatsAppInteractive struct {
	Type   string           `json:"type"` // "button", "list"
	Body   WhatsAppText     `json:"body"`
	Action WhatsAppAction   `json:"action"`
}

// WhatsAppAction represents the action part of interactive messages
type WhatsAppAction struct {
	// For buttons
	Buttons []WhatsAppButton `json:"buttons,omitempty"`

	// For lists
	Button   string             `json:"button,omitempty"` // Button text (e.g., "Choose")
	Sections []WhatsAppSection  `json:"sections,omitempty"`
}

// WhatsAppButton represents a reply button (max 3)
type WhatsAppButton struct {
	Type  string              `json:"type"` // "reply"
	Reply WhatsAppButtonReply `json:"reply"`
}

// WhatsAppButtonReply contains button details
type WhatsAppButtonReply struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// WhatsAppSection represents a section in a list (max 10 rows total)
type WhatsAppSection struct {
	Title string         `json:"title,omitempty"`
	Rows  []WhatsAppRow  `json:"rows"`
}

// WhatsAppRow represents a row in a list
type WhatsAppRow struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

// WhatsAppMedia represents media content
type WhatsAppMedia struct {
	Link    string `json:"link"`
	Caption string `json:"caption,omitempty"`
}
