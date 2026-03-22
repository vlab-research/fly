package messageworker

import (
	"context"
	"encoding/json"
	"fmt"
)

// MessageSender defines the interface for sending messages to any platform
// Each platform implementation handles:
// - Getting the appropriate access token for the platformAccountID
// - Formatting the request for the platform's API
// - Handling platform-specific errors and retry logic
type MessageSender interface {
	SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}) (*SendMessageResponse, error)
	SendNativeMessage(ctx context.Context, userID, platformAccountID string, payload json.RawMessage) (string, error)
	PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error
}

// SendMessageResponse represents the response from a platform API
type SendMessageResponse struct {
	MessageID string `json:"message_id"`
	Success   bool   `json:"success"`
	Error     string `json:"error,omitempty"`
}

// PlatformError represents an error from a platform API
type PlatformError struct {
	StatusCode int
	Message    string
	Retriable  bool
}

func (e *PlatformError) Error() string {
	return fmt.Sprintf("platform API error (status %d): %s", e.StatusCode, e.Message)
}
