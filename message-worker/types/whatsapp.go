package types

// WhatsAppMessage represents a message in WhatsApp API format
type WhatsAppMessage struct {
	Type        string               `json:"type"` // "text", "interactive", "image", "video", "audio", "document", "template"
	Text        *WhatsAppText        `json:"text,omitempty"`
	Interactive *WhatsAppInteractive `json:"interactive,omitempty"`
	Image       *WhatsAppMedia       `json:"image,omitempty"`
	Video       *WhatsAppMedia       `json:"video,omitempty"`
	Audio       *WhatsAppMedia       `json:"audio,omitempty"`
	Document    *WhatsAppMedia       `json:"document,omitempty"`
	Template    *WhatsAppTemplate    `json:"template,omitempty"`
}

// WhatsAppTemplate is the Cloud API template-send payload (type: "template"),
// used for utility_message fields sent outside the 24h customer-service
// window. Deliberately distinct from the Messenger types.MessageTemplate:
// WhatsApp encodes buttons as one component PER button with sub_type/index,
// which Messenger's Send API rejects ("Invalid keys \"index\"" — see
// documentation/utility-messages.md).
type WhatsAppTemplate struct {
	Name       string                      `json:"name"`
	Language   WhatsAppTemplateLanguage    `json:"language"`
	Components []WhatsAppTemplateComponent `json:"components,omitempty"`
}

// WhatsAppTemplateLanguage identifies the approved template's language code
// (e.g. "en_US"). WhatsApp matches (name, language) against an approved
// template at the WABA level.
type WhatsAppTemplateLanguage struct {
	Code string `json:"code"`
}

// WhatsAppTemplateComponent is one send-time component: "body" carries
// positional text parameters for {{n}} placeholders; "button" (singular,
// one component per button) carries sub_type "quick_reply", a string index
// ("0".."2"), and a single payload parameter.
type WhatsAppTemplateComponent struct {
	Type       string                      `json:"type"`               // "body" | "button"
	SubType    string                      `json:"sub_type,omitempty"` // "quick_reply" for buttons
	Index      string                      `json:"index,omitempty"`    // button position as a string
	Parameters []WhatsAppTemplateParameter `json:"parameters,omitempty"`
}

// WhatsAppTemplateParameter is a single component parameter: {type: "text",
// text} for body placeholders, {type: "payload", payload} for quick-reply
// buttons.
type WhatsAppTemplateParameter struct {
	Type    string `json:"type"` // "text" | "payload"
	Text    string `json:"text,omitempty"`
	Payload string `json:"payload,omitempty"`
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
