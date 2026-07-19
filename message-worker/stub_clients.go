package messageworker

import (
	"context"
	"encoding/json"
	"fmt"
)

type StubClient struct {
	platformName string
}

func NewStubClient(platformName string) *StubClient {
	return &StubClient{platformName: platformName}
}

func (c *StubClient) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}, platformContext json.RawMessage) (*SendMessageResponse, error) {
	return nil, &PlatformError{
		StatusCode: 501,
		Message:    fmt.Sprintf("%s messaging not yet implemented", c.platformName),
		Retriable:  false,
	}
}

func (c *StubClient) PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error {
	return &PlatformError{
		StatusCode: 501,
		Message:    fmt.Sprintf("%s pass_thread_control not yet implemented", c.platformName),
		Retriable:  false,
	}
}

// WhatsAppClient is a real HTTP client — see whatsapp_client.go.

type InstagramClient struct {
	StubClient
}

func NewInstagramClient() *InstagramClient {
	return &InstagramClient{
		StubClient: StubClient{platformName: "Instagram"},
	}
}

type TelegramClient struct {
	StubClient
}

func NewTelegramClient() *TelegramClient {
	return &TelegramClient{
		StubClient: StubClient{platformName: "Telegram"},
	}
}
