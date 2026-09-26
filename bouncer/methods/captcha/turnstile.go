package captcha

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/vlab-research/bouncer/verify"
)

const siteverifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

// Turnstile tokens are at most 2048 characters (siteverify docs); anything
// longer is not a token and is not worth a round trip to Cloudflare.
const maxTokenLength = 2048

//go:embed turnstile.js
var turnstileJS string

// Cloudflare's published dummy secrets
// (developers.cloudflare.com/turnstile/troubleshooting/testing). siteverify
// answers them with fixed `hostname: localhost` and `cdata: test-data`, so the
// binding checks cannot pass under them. Skipping those checks only for these
// secrets costs nothing: an always-pass secret already lets everyone through.
var dummySecrets = map[string]bool{
	"1x0000000000000000000000000000000AA": true,
	"2x0000000000000000000000000000000AA": true,
	"3x0000000000000000000000000000000AA": true,
}

func isDummySecret(secret string) bool { return dummySecrets[secret] }

// SiteverifyResponse is the subset of Turnstile's siteverify answer we read.
type SiteverifyResponse struct {
	Success    bool     `json:"success"`
	ErrorCodes []string `json:"error-codes"`
	Hostname   string   `json:"hostname"`
	CData      string   `json:"cdata"`
}

// Siteverify calls Cloudflare. An interface so tests can stand in for it.
type Siteverify interface {
	Verify(token, remoteIP string) (SiteverifyResponse, error)
}

// Turnstile is the Cloudflare Turnstile captcha provider.
type Turnstile struct {
	SiteKey      string
	ExpectedHost string
	CheckBinding bool
	API          Siteverify
}

// NewTurnstile builds the provider from its keys and the public host the
// page is served on (siteverify reports it, and anything else is refused).
func NewTurnstile(siteKey, secret, host string) *Turnstile {
	checkBinding := !isDummySecret(secret)
	if !checkBinding {
		log.Printf("[BOUNCER_TEST_KEYS] TURNSTILE_SECRET_KEY is a Cloudflare dummy secret: hostname and conversation binding are NOT checked")
	}
	return &Turnstile{
		SiteKey:      siteKey,
		ExpectedHost: host,
		CheckBinding: checkBinding,
		API:          &siteverifyClient{&http.Client{Timeout: 10 * time.Second}, siteverifyURL, secret},
	}
}

func (t *Turnstile) Name() string { return "turnstile" }

// The page adds `binding` to Config; the widget carries it back through
// siteverify as cData.
func (t *Turnstile) Client() verify.Client {
	return verify.Client{
		Runner: "captcha/turnstile",
		Config: map[string]string{"sitekey": t.SiteKey},
		JS:     template.JS(turnstileJS),
	}
}

func (t *Turnstile) Check(ctx verify.Context, token string) error {
	if len(token) > maxTokenLength {
		return fmt.Errorf("oversized token")
	}
	answer, err := t.API.Verify(token, ctx.RemoteIP)
	if err != nil {
		return fmt.Errorf("%w: %v", verify.ErrUnavailable, err)
	}
	return judgeSiteverify(answer, t.ExpectedHost, ctx.Binding, t.CheckBinding)
}

// judgeSiteverify decides whether a siteverify answer proves a human solved
// the challenge on OUR page for THIS link.
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

type siteverifyClient struct {
	client *http.Client
	url    string
	secret string
}

func (s *siteverifyClient) Verify(token, remoteIP string) (SiteverifyResponse, error) {
	form := url.Values{"secret": {s.secret}, "response": {token}}
	if remoteIP != "" {
		form.Set("remoteip", remoteIP)
	}

	resp, err := s.client.PostForm(s.url, form)
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
