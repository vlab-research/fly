package messageworker

import (
	"context"
	"encoding/json"
	"fmt"
)

type MessageSender interface {
	SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}, platformContext json.RawMessage) (*SendMessageResponse, error)
	PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error
}

type SendMessageResponse struct {
	MessageID string `json:"message_id"`
	Success   bool   `json:"success"`
	Error     string `json:"error,omitempty"`
}

type PlatformError struct {
	StatusCode int
	Message    string
	Retriable  bool
}

func (e *PlatformError) Error() string {
	return fmt.Sprintf("platform API error (status %d): %s", e.StatusCode, e.Message)
}
