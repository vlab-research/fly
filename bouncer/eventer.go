package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// The wait value a survey blocks on, emitted once every requested method has
// passed. There is deliberately no failure counterpart: replybot matches waits
// by subset (waiting.js `_contains`), so any `bouncer:verified` event --
// whatever else it carried -- would release a wait on `{type: bouncer:verified}`.
const verifiedEventType = "bouncer:verified"

// Methods records what actually ran, one entry per step (see verify.Step.Ran).
type EventValue struct {
	Type    string              `json:"type"`
	Methods []map[string]string `json:"methods"`
}

type SyntheticEvent struct {
	Type  string     `json:"type"` // external
	Value EventValue `json:"value"`
}

type ExternalEvent struct {
	User      string         `json:"user"`
	AccountID string         `json:"account_id"`
	Page      string         `json:"page"`
	Platform  string         `json:"platform"`
	Event     SyntheticEvent `json:"event"`
}

// buildEvent is the /synthetic body for one passed verification. `page`
// mirrors `account_id`, as every synthetic producer still sends it.
func buildEvent(id Identity, ran []map[string]string) ExternalEvent {
	return ExternalEvent{
		User:      id.User,
		AccountID: id.Account,
		Page:      id.Account,
		Platform:  id.Platform,
		Event:     SyntheticEvent{"external", EventValue{verifiedEventType, ran}},
	}
}

type Eventer struct {
	client    *http.Client
	botserver string
}

func NewEventer(botserver string) *Eventer {
	return &Eventer{&http.Client{Timeout: 10 * time.Second}, botserver}
}

func (e *Eventer) Send(ev ExternalEvent) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}

	resp, err := e.client.Post(e.botserver, "application/json", bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("non 200 response from botserver: %d", resp.StatusCode)
	}
	return nil
}
