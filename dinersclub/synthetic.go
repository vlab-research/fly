package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

// Event describes the synthetic event type and value.
type Event struct {
	Type  string           `json:"type"`
	Value *json.RawMessage `json:"value,omitempty"`
}

// SyntheticEvent is the payload POSTed to hermes /synthetic endpoint for payment results.
type SyntheticEvent struct {
	User      string `json:"user"`
	AccountID string `json:"account_id"`
	Platform  string `json:"platform"`
	Event     *Event `json:"event"`
}

// Poster sends synthetic events to hermes.
type Poster interface {
	Send(event *SyntheticEvent) error
}

// HTTPPoster implements Poster using http.Client.
type HTTPPoster struct {
	client    *http.Client
	botserver string
}

// NewHTTPPoster creates a new Poster for sending synthetic events to hermes.
func NewHTTPPoster(botserver string) Poster {
	return &HTTPPoster{
		client:    &http.Client{Timeout: getConfig().ProviderTimeout},
		botserver: botserver,
	}
}

// Send POSTs the synthetic event to hermes with the X-Vlab-Poster header.
func (p *HTTPPoster) Send(event *SyntheticEvent) error {
	body, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("failed to marshal synthetic event: %w", err)
	}

	req, err := http.NewRequest("POST", p.botserver, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Vlab-Poster", "dinersclub")

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to post to botserver: %w", err)
	}
	defer resp.Body.Close()

	// Wording preserved verbatim from botparty.Send, which this replaces. The
	// message is load-bearing beyond this package: dinersclub_test.go asserts on
	// it, and it is what operators grep for in logs. A local struct is a wire
	// change, not a behaviour change, so the error text must not drift.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Non 200 response from Botserver: %v", resp.StatusCode)
	}

	return nil
}
