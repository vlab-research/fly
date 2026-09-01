package messageworker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// SyntheticEvent is the payload POSTed to hermes /synthetic endpoint.
type SyntheticEvent struct {
	User      string              `json:"user"`
	AccountID string              `json:"account_id"`
	Platform  string              `json:"platform"`
	Event     *SyntheticEventType `json:"event"`
}

// SyntheticEventType describes the event type and value.
type SyntheticEventType struct {
	Type  string           `json:"type"`
	Value *json.RawMessage `json:"value,omitempty"`
}

// SyntheticPoster sends synthetic events to hermes.
type SyntheticPoster interface {
	Send(event *SyntheticEvent) error
}

// HTTPSyntheticPoster implements SyntheticPoster using http.Client.
type HTTPSyntheticPoster struct {
	client    *http.Client
	botserver string
}

// Runs in the worker goroutine on every send failure. Unbounded, a hung
// botserver stalls the consumer past max.poll.interval.ms and wedges it.
const syntheticPostTimeout = 10 * time.Second

// NewHTTPSyntheticPoster creates a new SyntheticPoster for sending events to hermes.
func NewHTTPSyntheticPoster(botserver string) SyntheticPoster {
	return &HTTPSyntheticPoster{
		client:    &http.Client{Timeout: syntheticPostTimeout},
		botserver: botserver,
	}
}

// Send POSTs the synthetic event to hermes with the X-Vlab-Poster header.
func (p *HTTPSyntheticPoster) Send(event *SyntheticEvent) error {
	body, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("failed to marshal synthetic event: %w", err)
	}

	req, err := http.NewRequest("POST", p.botserver, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Vlab-Poster", "message-worker")

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to post to botserver: %w", err)
	}
	defer resp.Body.Close()

	// Wording preserved verbatim from botparty.Send, which this replaces. A local
	// struct is a wire change, not a behaviour change, so the error text — which
	// operators grep for in logs — must not drift.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Non 200 response from Botserver: %v", resp.StatusCode)
	}

	return nil
}
