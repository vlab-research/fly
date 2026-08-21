package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

type Event struct {
	Type string `json:"type"` // linksniffer:click
	Url  string `json:"url"`
}

type LinkClickEvent struct {
	Type  string `json:"type"` // external
	Value Event  `json:"value"`
}

type ExternalEvent struct {
	User      string         `json:"user"`
	AccountID string         `json:"account_id"`
	Page      string         `json:"page"`
	Platform  string         `json:"platform"`
	Event     LinkClickEvent `json:"event"`
}

type Eventer struct {
	client    *http.Client
	botserver string
}

func (e *Eventer) Send(user, accountID, platform, url string) error {
	event := Event{"linksniffer:click", url}
	lc := LinkClickEvent{"external", event}
	ee := ExternalEvent{user, accountID, accountID, platform, lc}

	body, err := json.Marshal(ee)
	if err != nil {
		return err
	}

	resp, err := e.client.Post(e.botserver, "application/json", bytes.NewBuffer(body))
	if err != nil {
		return err
	}

	code := resp.StatusCode
	if code != 200 {
		err := fmt.Errorf("Non 200 response from Botserver: %v", code)
		log.Print(err)
		return err
	}

	return nil
}
