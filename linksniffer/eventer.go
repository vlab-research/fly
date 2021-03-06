package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

type Event struct {
	Type string `json:"type"` // forwarder:click
	Url  string `json:"url"`
}

type LinkClickEvent struct {
	Type  string `json:"type"` // external
	Value Event  `json:"value"`
}

type ExternalEvent struct {
	User  string         `json:"user"`
	Page  string         `json:"page"`
	Event LinkClickEvent `json:"event"`
}

type Eventer struct {
	client    *http.Client
	botserver string
}

func (e *Eventer) Send(user, page, url string) error {
	event := Event{"linksniffer:click", url}
	lc := LinkClickEvent{"external", event}
	ee := ExternalEvent{user, page, lc}

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
