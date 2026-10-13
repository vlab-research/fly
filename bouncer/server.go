package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log"
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/vlab-research/bouncer/verify"
)

//go:embed page.html
var pageFS embed.FS

var pageTemplate = template.Must(template.ParseFS(pageFS, "page.html"))

type Sender interface {
	Send(ExternalEvent) error
}

// Server knows links, signatures and events. What a method is, and how its
// proof is checked, is entirely the registry's (see package verify).
type Server struct {
	HMACKey []byte
	Methods verify.Registry
	Sender  Sender
}

func (s *Server) health(c echo.Context) error {
	return c.String(http.StatusOK, "pong")
}

// The URL carries the participant's identity, and the page loads third-party
// scripts, so the referrer must not leak it. The page is per-conversation, so
// nothing may cache it.
func setPageHeaders(c echo.Context) {
	h := c.Response().Header()
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cache-Control", "no-store")
}

// openLink checks a link end to end -- complete, correctly signed, asking for
// methods this deployment offers with valid parameters -- and plans its steps.
func (s *Server) openLink(l Link, err error) ([]verify.Step, error) {
	if err != nil {
		log.Printf("[BOUNCER_BAD_LINK] %v", err)
		return nil, err
	}
	if !verifySig(s.HMACKey, l) {
		log.Printf("[BOUNCER_BAD_SIGNATURE] user=%s account=%s platform=%s", l.User, l.Account, l.Platform)
		return nil, fmt.Errorf("bad signature")
	}
	requests, err := decodeMethods(l.Methods)
	if err == nil {
		var steps []verify.Step
		if steps, err = s.Methods.Plan(requests); err == nil {
			return steps, nil
		}
	}
	log.Printf("[BOUNCER_BAD_METHODS] user=%s account=%s %v", l.User, l.Account, err)
	return nil, err
}

func ran(steps []verify.Step) []map[string]string {
	out := make([]map[string]string, len(steps))
	for i, st := range steps {
		out[i] = st.Ran()
	}
	return out
}

// pageStep is one step as the page sees it. Config always carries `binding`
// (the link signature) for providers that bind their proof to the link.
type pageStep struct {
	Runner string            `json:"runner"`
	Config map[string]string `json:"config"`
}

// pageData is also serialized whole into the page's JSON config block, so it
// holds nothing that is not already in the URL or public.
type pageData struct {
	Broken   bool
	User     string
	Account  string
	Platform string
	Methods  string
	Sig      string
	Steps    []pageStep
	// Each runner's JS once, however many steps use it.
	RunnerJS []template.JS `json:"-"`
}

func buildPage(l Link, steps []verify.Step) pageData {
	d := pageData{User: l.User, Account: l.Account, Platform: l.Platform, Methods: l.Methods, Sig: l.Sig}
	seen := map[string]bool{}
	for _, st := range steps {
		cl := st.Client()
		cfg := map[string]string{"binding": l.Sig}
		for k, v := range cl.Config {
			cfg[k] = v
		}
		d.Steps = append(d.Steps, pageStep{cl.Runner, cfg})
		if !seen[cl.Runner] {
			seen[cl.Runner] = true
			d.RunnerJS = append(d.RunnerJS, cl.JS)
		}
	}
	return d
}

// page renders the verification steps. A broken or tampered link fails here,
// before anything renders, so a survey tester sees it immediately.
func (s *Server) page(c echo.Context) error {
	setPageHeaders(c)

	l, err := parseLink(c.QueryParam)
	steps, err := s.openLink(l, err)
	if err != nil {
		return s.render(c, http.StatusBadRequest, pageData{Broken: true})
	}
	return s.render(c, http.StatusOK, buildPage(l, steps))
}

func (s *Server) render(c echo.Context, code int, d pageData) error {
	c.Response().Header().Set(echo.HeaderContentType, echo.MIMETextHTMLCharsetUTF8)
	c.Response().WriteHeader(code)
	return pageTemplate.Execute(c.Response(), d)
}

// Results holds one proof per step, in the link's method order. Each proof is
// opaque here; only its step can read it.
type submitRequest struct {
	User     string            `json:"vlab_user"`
	Account  string            `json:"vlab_account"`
	Platform string            `json:"vlab_platform"`
	Methods  string            `json:"vlab_methods"`
	Sig      string            `json:"vlab_sig"`
	Results  []json.RawMessage `json:"results"`
}

// status tells the page which screen to show: `verified`, `failed` (do the
// steps again), `retry` (our side broke; just try again) or `broken`.
type submitResponse struct {
	Status string `json:"status"`
}

func (s *Server) submit(c echo.Context) error {
	setPageHeaders(c)

	var req submitRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, submitResponse{"broken"})
	}

	fields := map[string]string{
		paramUser: req.User, paramAccount: req.Account, paramPlatform: req.Platform,
		paramMethods: req.Methods, paramSig: req.Sig,
	}
	l, err := parseLink(func(k string) string { return fields[k] })
	steps, err := s.openLink(l, err)
	if err != nil {
		return c.JSON(http.StatusBadRequest, submitResponse{"broken"})
	}
	if len(req.Results) != len(steps) {
		log.Printf("[BOUNCER_VERIFY_FAILED] user=%s reason=%d results for %d methods", l.User, len(req.Results), len(steps))
		return c.JSON(http.StatusBadRequest, submitResponse{"failed"})
	}

	ctx := verify.Context{RemoteIP: c.RealIP(), Binding: l.Sig}
	for i, st := range steps {
		if err := st.Check(ctx, req.Results[i]); err != nil {
			if errors.Is(err, verify.ErrUnavailable) {
				log.Printf("[BOUNCER_PROVIDER_ERROR] user=%s method=%v error=%v", l.User, st.Ran(), err)
				return c.JSON(http.StatusBadGateway, submitResponse{"retry"})
			}
			log.Printf("[BOUNCER_VERIFY_FAILED] user=%s account=%s platform=%s method=%v reason=%v", l.User, l.Account, l.Platform, st.Ran(), err)
			return c.JSON(http.StatusForbidden, submitResponse{"failed"})
		}
	}

	// Unlike linksniffer, the event IS the product: never tell a participant
	// they are verified when the survey waiting on it will not hear about it.
	if err := s.Sender.Send(buildEvent(l.Identity, ran(steps))); err != nil {
		log.Printf("[BOUNCER_EVENT_FAILED] user=%s account=%s platform=%s error=%v", l.User, l.Account, l.Platform, err)
		return c.JSON(http.StatusBadGateway, submitResponse{"retry"})
	}

	log.Printf("[BOUNCER_VERIFIED] user=%s account=%s platform=%s methods=%v", l.User, l.Account, l.Platform, ran(steps))
	return c.JSON(http.StatusOK, submitResponse{"verified"})
}
