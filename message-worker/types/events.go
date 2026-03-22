package types

import "encoding/json"

// UniversalEvent represents the platform-agnostic event structure
type UniversalEvent struct {
	EventID        string          `json:"event_id"`
	ConversationID string          `json:"conversation_id"`
	UserID         string          `json:"user_id"`
	Timestamp      int64           `json:"timestamp"`
	Platform       PlatformContext `json:"platform"`
	Source         EventSource     `json:"source"`
	EventType      string          `json:"type"`
	Payload        json.RawMessage `json:"payload"`
}

// PlatformContext contains platform-specific metadata
type PlatformContext struct {
	Type      PlatformType `json:"type"`
	AccountID string       `json:"account_id"`
}

// EventSource represents the origin of the event
type EventSource string

const (
	EventSourceMessageWorker EventSource = "message_worker" // Message delivery confirmations
	EventSourceUser          EventSource = "user"           // User-initiated events
	EventSourceSystem        EventSource = "system"         // System/internal events
)

// MessageSentPayload represents successful message delivery
type MessageSentPayload struct {
	Type              string  `json:"type"`
	CommandID         string  `json:"command_id"`
	ConversationID    string  `json:"conversation_id"`
	UserID            string  `json:"user_id"`
	PlatformMessageID *string `json:"platform_message_id,omitempty"`
	Attempts          int     `json:"attempts"`
}

// MessageFailedPayload represents failed message delivery
type MessageFailedPayload struct {
	Type           string  `json:"type"`
	CommandID      string  `json:"command_id"`
	ConversationID string  `json:"conversation_id"`
	UserID         string  `json:"user_id"`
	Error          string  `json:"error"`
	ErrorCode      *string `json:"error_code,omitempty"`
	Attempts       int     `json:"attempts"`
	Retriable      bool    `json:"retriable"`
}
