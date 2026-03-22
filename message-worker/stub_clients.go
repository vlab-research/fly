package messageworker

import (
	"context"
	"encoding/json"
	"fmt"
)

// StubClient is a placeholder client that returns "not implemented" errors
// Used for platforms that haven't been fully implemented yet
type StubClient struct {
	platformName string
}

// NewStubClient creates a new stub client for a platform
func NewStubClient(platformName string) *StubClient {
	return &StubClient{platformName: platformName}
}

// SendMessage returns a not-implemented error
func (c *StubClient) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}) (*SendMessageResponse, error) {
	return nil, &PlatformError{
		StatusCode: 501,
		Message:    fmt.Sprintf("%s messaging not yet implemented", c.platformName),
		Retriable:  false,
	}
}

// SendNativeMessage returns a not-implemented error
func (c *StubClient) SendNativeMessage(ctx context.Context, userID, platformAccountID string, payload json.RawMessage) (string, error) {
	return "", &PlatformError{
		StatusCode: 501,
		Message:    fmt.Sprintf("%s native messaging not yet implemented", c.platformName),
		Retriable:  false,
	}
}

// PassThreadControl returns a not-implemented error
func (c *StubClient) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	return &PlatformError{
		StatusCode: 501,
		Message:    fmt.Sprintf("%s pass_thread_control not yet implemented", c.platformName),
		Retriable:  false,
	}
}

// WhatsAppClient is a stub implementation for WhatsApp
// TODO: Implement proper WhatsApp Business API integration
type WhatsAppClient struct {
	StubClient
}

// NewWhatsAppClient creates a stub WhatsApp client
func NewWhatsAppClient() *WhatsAppClient {
	return &WhatsAppClient{
		StubClient: StubClient{platformName: "WhatsApp"},
	}
}

// InstagramClient is a stub implementation for Instagram
// TODO: Implement proper Instagram Messaging API integration
type InstagramClient struct {
	StubClient
}

// NewInstagramClient creates a stub Instagram client
func NewInstagramClient() *InstagramClient {
	return &InstagramClient{
		StubClient: StubClient{platformName: "Instagram"},
	}
}

// TelegramClient is a stub implementation for Telegram
// TODO: Implement proper Telegram Bot API integration
type TelegramClient struct {
	StubClient
}

// NewTelegramClient creates a stub Telegram client
func NewTelegramClient() *TelegramClient {
	return &TelegramClient{
		StubClient: StubClient{platformName: "Telegram"},
	}
}
