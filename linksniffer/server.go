package main

import (
	"fmt"
	"github.com/labstack/echo/v4"
	"log"
	"net/http"
	"net/url"
	"os"
)

func main() {
	botserverUrl := os.Getenv("BOTSERVER_URL")

	client := &http.Client{}
	eventer := &Eventer{client, botserverUrl}
	server := &Server{eventer}

	e := echo.New()
	e.GET("/", server.forward)
	e.GET("/health", server.health)

	e.Logger.Fatal(e.Start(":1323"))
}

type Server struct {
	Eventer *Eventer
}

func (s *Server) health(c echo.Context) error {
	return c.String(http.StatusOK, "pong")
}

// The canonical conversation-identity query params. replybot builds every
// `link_tracking` URL from config and stamps these three itself
// (`replybot/lib/generic-translator.js` IDENTITY_PARAMS), so linksniffer and
// moviehouse read ONE shared set of names. The `vlab_` prefix is what makes a
// collision structurally impossible -- unprefixed `id` used to mean "the
// participant" here and "the Vimeo video" on moviehouse, which is exactly the
// class of mistake the prefix removes.
const (
	paramUser     = "vlab_user"
	paramAccount  = "vlab_account"
	paramPlatform = "vlab_platform"
)

// firstNonEmpty returns the first non-empty value, or "".
//
// This is how every legacy fallback below is expressed: the canonical name
// first, then the names URLs already in flight use. The fallbacks are NOT
// vestigial politeness -- a Messenger conversation stays open for 24 hours, so
// links delivered before this deploys will be clicked after it, and dropping the
// old names would 400 those clicks (`id` is required) and lose the event that a
// `wait` on `linksniffer:click` is blocked on.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// The transports a conversation can run on. `platform` is never "synthetic" --
// that is a `source`, not a platform. See documentation/event-envelope.md.
var messagingPlatforms = map[string]bool{
	"messenger": true,
	"whatsapp":  true,
}

// resolvePlatform decides the conversation's platform from the query param. It
// returns the platform, whether it was assumed, and whether the supplied value
// was rejected as unrecognized.
//
// ABSENT and INVALID are deliberately NOT the same thing, and the caller treats
// them differently:
//
//   ABSENT is legitimate. Every URL delivered to a participant before
//   `vlab_platform` existed carries no platform, and those links must keep
//   working for as long as they are in inboxes. Assume messenger -- the only
//   live transport -- and log it so the legacy tail is measurable.
//
//   INVALID is a bug, and the caller REFUSES TO FORWARD. replybot owns these
//   URLs end to end for the `link_tracking` and `moviehouse` field types and
//   writes this param from `ctx.platform` (generic-translator.js), so a
//   well-formed link CANNOT carry a bad value. An invalid one can only come from
//   a hand-authored `webview` field or a tampered URL -- exactly the case a
//   survey tester should see break loudly during testing, rather than have
//   silently coerced to messenger and discovered later as misattributed data.
//   Forwarding anyway would make a researcher's typo indistinguishable from a
//   working link right up until the numbers are wrong.
func resolvePlatform(platformParam string) (platform string, assumed bool, invalid bool) {
	if platformParam == "" {
		return "messenger", true, false
	}
	if !messagingPlatforms[platformParam] {
		return "", false, true
	}
	return platformParam, false, false
}

// buildRedirectURL constructs the final redirect URL from base URL and protocol.
// Only http/https use ://, everything else uses single colon.
func buildRedirectURL(baseURL, protocol string) string {
	if protocol == "http" || protocol == "https" {
		return protocol + "://" + baseURL
	}
	return protocol + ":" + baseURL
}

func (s *Server) forward(c echo.Context) error {
	// Canonical name first, then the legacy names that URLs already delivered to
	// participants carry. `pageid` was the original account name, `account_id`
	// the normalized one, and both predate `vlab_account`.
	id := firstNonEmpty(c.QueryParam(paramUser), c.QueryParam("id"))
	resolvedAccountID := firstNonEmpty(c.QueryParam(paramAccount), c.QueryParam("account_id"), c.QueryParam("pageid"))
	platformParam := firstNonEmpty(c.QueryParam(paramPlatform), c.QueryParam("platform"))

	// The destination and its protocol are content, not identity, so they keep
	// their names: replybot writes exactly these two.
	u := c.QueryParam("url")
	p := c.QueryParam("p")

	if id == "" {
		e := fmt.Errorf("Cannot forward to url, lacking tracking id")
		return echo.NewHTTPError(http.StatusBadRequest, e)
	}

	if p == "" {
		p = "https"
	}

	// Resolve platform and check if it was assumed
	platform, platformAssumed, platformInvalid := resolvePlatform(platformParam)
	if platformInvalid {
		// Refuse. See resolvePlatform: replybot cannot emit this, so it is a
		// hand-authored or tampered URL and must fail where a tester will see it.
		log.Printf("[LINKSNIFFER_PLATFORM_INVALID] id=%s account=%s platform=%q -- not a known platform, refusing to forward", id, resolvedAccountID, platformParam)
		e := fmt.Errorf("unknown platform %q -- must be one of messenger, whatsapp, or omitted", platformParam)
		return echo.NewHTTPError(http.StatusBadRequest, e)
	}
	if platformAssumed {
		log.Printf("[LINKSNIFFER_PLATFORM_ASSUMED] id=%s account=%s", id, resolvedAccountID)
	}

	// Build the redirect URL
	u = buildRedirectURL(u, p)

	u, err := url.PathUnescape(u)
	if err != nil {
		// This said "Error sending event" before, which pointed debugging at the
		// wrong subsystem entirely -- nothing has been sent at this point.
		log.Printf("[LINKSNIFFER_BAD_URL] id=%s url=%q could not be unescaped: %v", id, u, err)
		e := fmt.Errorf("URL could not be unescaped: %v", u)
		return echo.NewHTTPError(http.StatusBadRequest, e)
	}

	// Send event, but don't propagate the error to the participant
	// Tracking is best-effort; the redirect is the product.
	err = s.Eventer.Send(id, resolvedAccountID, platform, u)
	if err != nil {
		log.Printf("[LINKSNIFFER_EVENT_FAILED] id=%s account=%s error=%v", id, resolvedAccountID, err)
	}

	return c.Redirect(http.StatusFound, u)
}
