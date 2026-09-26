package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const siteverifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

// Cloudflare's published dummy secrets
// (developers.cloudflare.com/turnstile/troubleshooting/testing). siteverify
// answers them with fixed `hostname: localhost` and `cdata: test-data`, so the
// binding checks below cannot pass under them. Skipping those checks only for
// these secrets costs nothing: an always-pass secret already lets everyone
// through.
var dummySecrets = map[string]bool{
	"1x0000000000000000000000000000000AA": true,
	"2x0000000000000000000000000000000AA": true,
	"3x0000000000000000000000000000000AA": true,
}

func isDummySecret(secret string) bool { return dummySecrets[secret] }

// SiteverifyResponse is the subset of Turnstile's siteverify answer bouncer reads.
type SiteverifyResponse struct {
	Success    bool     `json:"success"`
	ErrorCodes []string `json:"error-codes"`
	Hostname   string   `json:"hostname"`
	CData      string   `json:"cdata"`
}

// judgeSiteverify decides whether a siteverify answer proves a human solved
// the challenge on OUR page for THIS conversation. The page renders the widget
// with cData = the link's signature, so a token solved for one conversation
// cannot be spent on another's.
func judgeSiteverify(r SiteverifyResponse, expectedHost, expectedCData string, checkBinding bool) error {
	if !r.Success {
		return fmt.Errorf("challenge not passed: %s", strings.Join(r.ErrorCodes, ","))
	}
	if !checkBinding {
		return nil
	}
	if r.Hostname != expectedHost {
		return fmt.Errorf("token solved on %q, expected %q", r.Hostname, expectedHost)
	}
	if r.CData != expectedCData {
		return fmt.Errorf("token bound to a different conversation")
	}
	return nil
}

type Turnstile struct {
	client *http.Client
	url    string
	secret string
}

func NewTurnstile(secret string) *Turnstile {
	return &Turnstile{&http.Client{Timeout: 10 * time.Second}, siteverifyURL, secret}
}

func (t *Turnstile) Verify(token, remoteIP string) (SiteverifyResponse, error) {
	form := url.Values{"secret": {t.secret}, "response": {token}}
	if remoteIP != "" {
		form.Set("remoteip", remoteIP)
	}

	resp, err := t.client.PostForm(t.url, form)
	if err != nil {
		return SiteverifyResponse{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return SiteverifyResponse{}, fmt.Errorf("siteverify returned %d", resp.StatusCode)
	}

	var r SiteverifyResponse
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return SiteverifyResponse{}, fmt.Errorf("siteverify response unreadable: %w", err)
	}
	return r, nil
}
