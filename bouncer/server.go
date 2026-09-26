package main

import (
	"embed"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"os"

	"github.com/labstack/echo/v4"
)

//go:embed page.html
var pageFS embed.FS

var pageTemplate = template.Must(template.ParseFS(pageFS, "page.html"))

// Turnstile tokens are at most 2048 characters (siteverify docs); anything
// longer is not a token and is not worth a round trip to Cloudflare.
const maxTokenLength = 2048

type Verifier interface {
	Verify(token, remoteIP string) (SiteverifyResponse, error)
}

type Sender interface {
	Send(ExternalEvent) error
}

// TurnstileConfig is everything the `captcha` method needs when its provider
// resolves to `turnstile`.
type TurnstileConfig struct {
	SiteKey      string
	ExpectedHost string
	CheckBinding bool
	Verifier     Verifier
}

type Server struct {
	HMACKey   []byte
	Turnstile TurnstileConfig
	Sender    Sender
	// AllowAuto permits the `auto` method. Off in staging and production.
	AllowAuto bool
}

func mustEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		log.Fatalf("[BOUNCER_CONFIG] %s is not set", name)
	}
	return v
}

func main() {
	secret := mustEnv("TURNSTILE_SECRET_KEY")
	checkBinding := !isDummySecret(secret)
	if !checkBinding {
		log.Printf("[BOUNCER_TEST_KEYS] TURNSTILE_SECRET_KEY is a Cloudflare dummy secret: hostname and conversation binding are NOT checked")
	}

	server := &Server{
		HMACKey: []byte(mustEnv("BOUNCER_HMAC_KEY")),
		Turnstile: TurnstileConfig{
			SiteKey:      mustEnv("TURNSTILE_SITE_KEY"),
			ExpectedHost: mustEnv("BOUNCER_HOSTNAME"),
			CheckBinding: checkBinding,
			Verifier:     NewTurnstile(secret),
		},
		Sender:    NewEventer(mustEnv("BOTSERVER_URL")),
		AllowAuto: os.Getenv("BOUNCER_ALLOW_AUTO") == "true",
	}
	if server.AllowAuto {
		log.Printf("[BOUNCER_AUTO_ENABLED] the `auto` method is allowed: links requesting it verify with no participant action")
	}

	e := echo.New()
	e.GET("/verify", server.page)
	e.POST("/verify/submit", server.submit)
	e.GET("/health", server.health)

	e.Logger.Fatal(e.Start(":1323"))
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

// openLink checks a link end to end: complete, correctly signed, and asking
// for methods this bouncer implements. It returns the methods with `default`
// resolved.
func (s *Server) openLink(l Link, err error) ([]Method, error) {
	if err != nil {
		log.Printf("[BOUNCER_BAD_LINK] %v", err)
		return nil, err
	}
	if !verifySig(s.HMACKey, l) {
		log.Printf("[BOUNCER_BAD_SIGNATURE] user=%s account=%s platform=%s", l.User, l.Account, l.Platform)
		return nil, fmt.Errorf("bad signature")
	}
	ms, err := decodeMethods(l.Methods)
	if err != nil {
		log.Printf("[BOUNCER_BAD_LINK] user=%s %v", l.User, err)
		return nil, err
	}
	for _, m := range ms {
		if m.Type == methodAuto && !s.AllowAuto {
			log.Printf("[BOUNCER_AUTO_DISABLED] user=%s account=%s asked for `auto`, which this environment does not allow", l.User, l.Account)
			return nil, fmt.Errorf("auto is not allowed here")
		}
	}
	return resolveMethods(ms), nil
}

// pageData is also serialized whole into the page's JSON config block, so it
// holds nothing that is not already in the URL or public.
type pageData struct {
	Broken           bool
	User             string
	Account          string
	Platform         string
	Methods          string
	Sig              string
	Steps            []Method
	TurnstileSiteKey string
	NeedsTurnstile   bool
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

	d := pageData{
		User: l.User, Account: l.Account, Platform: l.Platform,
		Methods: l.Methods, Sig: l.Sig, Steps: steps,
	}
	for _, m := range steps {
		if m.Type == methodCaptcha && m.Provider == providerTurn {
			d.NeedsTurnstile = true
			d.TurnstileSiteKey = s.Turnstile.SiteKey
		}
	}
	return s.render(c, http.StatusOK, d)
}

func (s *Server) render(c echo.Context, code int, d pageData) error {
	c.Response().Header().Set(echo.HeaderContentType, echo.MIMETextHTMLCharsetUTF8)
	c.Response().WriteHeader(code)
	return pageTemplate.Execute(c.Response(), d)
}

// StepResult is the page's proof for one method, in the same order as the
// link's methods. Only `token` exists today (captcha).
type StepResult struct {
	Token string `json:"token"`
}

type submitRequest struct {
	User     string       `json:"vlab_user"`
	Account  string       `json:"vlab_account"`
	Platform string       `json:"vlab_platform"`
	Methods  string       `json:"vlab_methods"`
	Sig      string       `json:"vlab_sig"`
	Results  []StepResult `json:"results"`
}

// status tells the page which screen to show: `verified`, `failed` (do the
// steps again), `retry` (our side broke; just try again) or `broken`.
type submitResponse struct {
	Status string `json:"status"`
}

// errRetry marks a failure on our side (Cloudflare unreachable), as opposed
// to a participant who did not pass.
type errRetry struct{ error }

// checkStep verifies one method's proof. New method types and providers are
// added here.
func (s *Server) checkStep(m Method, r StepResult, l Link, remoteIP string) error {
	switch {
	case m.Type == methodCaptcha && m.Provider == providerTurn:
		if r.Token == "" || len(r.Token) > maxTokenLength {
			return fmt.Errorf("missing or oversized token")
		}
		answer, err := s.Turnstile.Verifier.Verify(r.Token, remoteIP)
		if err != nil {
			return errRetry{err}
		}
		return judgeSiteverify(answer, s.Turnstile.ExpectedHost, l.Sig, s.Turnstile.CheckBinding)
	case m.Type == methodAuto && m.Provider == providerNone:
		return nil
	default:
		return fmt.Errorf("no checker for %s:%s", m.Type, m.Provider)
	}
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
		log.Printf("[BOUNCER_VERIFY_FAILED] user=%s methods=%s reason=%d results for %d methods", l.User, describeMethods(steps), len(req.Results), len(steps))
		return c.JSON(http.StatusBadRequest, submitResponse{"failed"})
	}

	for i, m := range steps {
		if err := s.checkStep(m, req.Results[i], l, c.RealIP()); err != nil {
			if _, ok := err.(errRetry); ok {
				log.Printf("[BOUNCER_PROVIDER_ERROR] user=%s method=%s:%s error=%v", l.User, m.Type, m.Provider, err)
				return c.JSON(http.StatusBadGateway, submitResponse{"retry"})
			}
			log.Printf("[BOUNCER_VERIFY_FAILED] user=%s account=%s platform=%s method=%s:%s reason=%v", l.User, l.Account, l.Platform, m.Type, m.Provider, err)
			return c.JSON(http.StatusForbidden, submitResponse{"failed"})
		}
	}

	// Unlike linksniffer, the event IS the product: never tell a participant
	// they are verified when the survey waiting on it will not hear about it.
	if err := s.Sender.Send(buildEvent(l.Identity, steps)); err != nil {
		log.Printf("[BOUNCER_EVENT_FAILED] user=%s account=%s platform=%s error=%v", l.User, l.Account, l.Platform, err)
		return c.JSON(http.StatusBadGateway, submitResponse{"retry"})
	}

	log.Printf("[BOUNCER_VERIFIED] user=%s account=%s platform=%s methods=%s", l.User, l.Account, l.Platform, describeMethods(steps))
	return c.JSON(http.StatusOK, submitResponse{"verified"})
}
