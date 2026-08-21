package main

import (
	"bytes"
	"io/ioutil"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

// TestFirstNonEmpty tests the pure fallback chain. Order is the whole contract:
// the canonical `vlab_*` name wins, and the legacy names are consulted only when
// it is absent.
func TestFirstNonEmpty(t *testing.T) {
	tests := []struct {
		name     string
		values   []string
		expected string
	}{
		{"prefers the first", []string{"canonical", "account_id", "pageid"}, "canonical"},
		{"falls through one", []string{"", "account_id", "pageid"}, "account_id"},
		{"falls through to the last", []string{"", "", "pageid"}, "pageid"},
		{"all empty", []string{"", "", ""}, ""},
		{"nothing at all", []string{}, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, firstNonEmpty(tt.values...))
		})
	}
}

// TestCanonicalParamsAreRead is the forward path: a URL built by replybot's
// `link_tracking` field type carries only the vlab_* names, and every component
// of the conversation triple must come out of them.
func TestCanonicalParamsAreRead(t *testing.T) {
	e := echo.New()

	expectedEvent := `{"user":"user-123","account_id":"acct-456","page":"acct-456","platform":"whatsapp","event":{"type":"external","value":{"type":"linksniffer:click","url":"https://who.int/hpv"}}}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Equal(t, expectedEvent, string(data))
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	q := make(url.Values)
	q.Set("url", "who.int/hpv")
	q.Set("p", "https")
	q.Set("vlab_user", "user-123")
	q.Set("vlab_account", "acct-456")
	q.Set("vlab_platform", "whatsapp")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	s := &Server{&Eventer{&http.Client{}, ts.URL}}

	assert.Nil(t, s.forward(c))
	assert.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "https://who.int/hpv", rec.Header().Get("Location"))
}

// A canonical platform must NOT be counted as assumed. If it were, the
// [LINKSNIFFER_PLATFORM_ASSUMED] counter could never reach zero and step 4 of
// the envelope rollout would stay permanently blocked.
func TestCanonicalPlatformIsNotAssumed(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	e := echo.New()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	q := make(url.Values)
	q.Set("url", "example.com")
	q.Set("vlab_user", "123")
	q.Set("vlab_account", "456")
	q.Set("vlab_platform", "whatsapp")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	s := &Server{&Eventer{&http.Client{}, ts.URL}}

	assert.Nil(t, s.forward(c))
	assert.NotContains(t, buf.String(), "[LINKSNIFFER_PLATFORM_ASSUMED]")
	assert.NotContains(t, buf.String(), "[LINKSNIFFER_PLATFORM_INVALID]")
}

// The canonical names win over legacy ones when both are present -- which is
// what a hand-authored `id=` placeholder on a migrated field would produce.
func TestCanonicalParamsWinOverLegacy(t *testing.T) {
	e := echo.New()

	expectedEvent := `{"user":"canonical-user","account_id":"canonical-acct","page":"canonical-acct","platform":"whatsapp","event":{"type":"external","value":{"type":"linksniffer:click","url":"https://example.com"}}}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Equal(t, expectedEvent, string(data))
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	q := make(url.Values)
	q.Set("url", "example.com")
	q.Set("vlab_user", "canonical-user")
	q.Set("vlab_account", "canonical-acct")
	q.Set("vlab_platform", "whatsapp")
	q.Set("id", "legacy-user")
	q.Set("account_id", "legacy-acct")
	q.Set("pageid", "older-acct")
	q.Set("platform", "messenger")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	s := &Server{&Eventer{&http.Client{}, ts.URL}}

	assert.Nil(t, s.forward(c))
	assert.Equal(t, http.StatusFound, rec.Code)
}

// A link delivered before this deploy and clicked after it. Messenger's 24-hour
// window guarantees this happens, and a 400 here would lose the click event a
// `wait` on linksniffer:click is blocked on.
func TestLegacyInFlightLinkStillWorks(t *testing.T) {
	e := echo.New()

	expectedEvent := `{"user":"legacy-user","account_id":"legacy-acct","page":"legacy-acct","platform":"messenger","event":{"type":"external","value":{"type":"linksniffer:click","url":"https://example.com"}}}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Equal(t, expectedEvent, string(data))
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	q := make(url.Values)
	q.Set("url", "example.com")
	q.Set("id", "legacy-user")
	q.Set("pageid", "legacy-acct")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	s := &Server{&Eventer{&http.Client{}, ts.URL}}

	assert.Nil(t, s.forward(c))
	assert.Equal(t, http.StatusFound, rec.Code)
}

// A vlab_user present but empty must not shadow a legacy id -- `firstNonEmpty`
// skips empties, and an empty-string identity would be a poisoned cache key.
func TestEmptyCanonicalFallsBackToLegacy(t *testing.T) {
	e := echo.New()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Contains(t, string(data), `"user":"legacy-user"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	q := make(url.Values)
	q.Set("url", "example.com")
	q.Set("vlab_user", "")
	q.Set("id", "legacy-user")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	s := &Server{&Eventer{&http.Client{}, ts.URL}}

	assert.Nil(t, s.forward(c))
	assert.Equal(t, http.StatusFound, rec.Code)
}

// replybot writes `p` separately from `url` for exactly this reason: the
// tel:/mailto:/sms: destinations documentation/platform-abstraction.md says are
// expected to route through here.
func TestCanonicalTelDestination(t *testing.T) {
	e := echo.New()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Contains(t, string(data), `"url":"tel:+234-0700-220-1122"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	q := make(url.Values)
	q.Set("url", "+234-0700-220-1122")
	q.Set("p", "tel")
	q.Set("vlab_user", "user-123")
	q.Set("vlab_account", "acct-456")
	q.Set("vlab_platform", "whatsapp")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	s := &Server{&Eventer{&http.Client{}, ts.URL}}

	assert.Nil(t, s.forward(c))
	assert.Equal(t, "tel:+234-0700-220-1122", rec.Header().Get("Location"))
}

// A vlab_user with no legacy id must satisfy the required-id check.
func TestErrorsWhenNeitherUserParamIsPresent(t *testing.T) {
	e := echo.New()

	q := make(url.Values)
	q.Set("url", "example.com")
	q.Set("vlab_account", "acct-456")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	s := &Server{&Eventer{&http.Client{}, "http://localhost:1"}}

	err := s.forward(c)
	assert.NotNil(t, err)
	he, ok := err.(*echo.HTTPError)
	assert.True(t, ok)
	assert.Equal(t, http.StatusBadRequest, he.Code)
}

// TestResolvePlatform tests the pure function for platform resolution and assumption detection.
func TestResolvePlatform(t *testing.T) {
	tests := []struct {
		name             string
		platformParam    string
		expectedPlatform string
		expectedAssumed  bool
		expectedInvalid  bool
	}{
		{"explicit messenger", "messenger", "messenger", false, false},
		{"explicit whatsapp", "whatsapp", "whatsapp", false, false},
		{"absent defaults to messenger", "", "messenger", true, false},
		// A researcher-authored typo must not become a conversation identity.
		{"unknown platform is rejected, not trusted", "sms", "messenger", true, true},
		{"wrong case is rejected, not silently accepted", "Messenger", "messenger", true, true},
		{"synthetic is never a platform", "synthetic", "messenger", true, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			platform, assumed, invalid := resolvePlatform(tt.platformParam)
			assert.Equal(t, tt.expectedPlatform, platform)
			assert.Equal(t, tt.expectedAssumed, assumed)
			assert.Equal(t, tt.expectedInvalid, invalid)
		})
	}
}

// An unrecognized platform must be logged under its own tag rather than folded
// into the assumed-platform count, so the canary for legacy hand-authored links
// stays separable from the canary for researcher typos.
func TestForwardWithInvalidPlatformLogsItsOwnTag(t *testing.T) {
	e := echo.New()

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		// Falls back to messenger rather than forwarding the bad value on.
		assert.Contains(t, string(data), `"platform":"messenger"`)
	}))
	defer ts.Close()

	var logBuf bytes.Buffer
	log.SetOutput(&logBuf)
	defer log.SetOutput(os.Stderr)

	q := make(url.Values)
	q.Set("url", "redcross.org")
	q.Set("id", "123")
	q.Set("account_id", "789")
	q.Set("platform", "sms")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	client := &http.Client{}
	s := &Server{&Eventer{client, ts.URL}}

	s.forward(c)

	logOutput := logBuf.String()
	assert.Contains(t, logOutput, "[LINKSNIFFER_PLATFORM_INVALID]")
	assert.Contains(t, logOutput, `platform="sms"`)
	// The participant still reaches their destination.
	assert.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "https://redcross.org", rec.Header().Get("Location"))
}

// TestBuildRedirectURL tests the pure function for URL construction.
func TestBuildRedirectURL(t *testing.T) {
	tests := []struct {
		name     string
		baseURL  string
		protocol string
		expected string
	}{
		{"https URL", "example.com/path", "https", "https://example.com/path"},
		{"http URL", "example.com/path", "http", "http://example.com/path"},
		{"tel URL", "1234567890", "tel", "tel:1234567890"},
		{"mailto URL", "user@example.com", "mailto", "mailto:user@example.com"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := buildRedirectURL(tt.baseURL, tt.protocol)
			assert.Equal(t, tt.expected, result)
		})
	}
}

// TestForwardHttpsWithDefaultPlatform tests that https works and platform defaults to messenger.
func TestForwardHttpsWithDefaultPlatform(t *testing.T) {
	e := echo.New()

	// Capture log output
	var logBuf bytes.Buffer
	oldLogOutput := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldLogOutput)

	expectedEvent := `{"user":"123","account_id":"789","page":"789","platform":"messenger","event":{"type":"external","value":{"type":"linksniffer:click","url":"https://redcross.org"}}}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Equal(t, expectedEvent, string(data))
		w.WriteHeader(http.StatusOK)
	}))

	q := make(url.Values)
	q.Set("url", "redcross.org")
	q.Set("id", "123")
	q.Set("pageid", "789")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	client := &http.Client{}
	s := &Server{&Eventer{client, ts.URL}}

	err := s.forward(c)
	assert.Nil(t, err)
	assert.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "https://redcross.org", rec.Header().Get("Location"))

	// Verify platform assumption was logged
	logOutput := logBuf.String()
	assert.Contains(t, logOutput, "[LINKSNIFFER_PLATFORM_ASSUMED]")
	assert.Contains(t, logOutput, "id=123")
	assert.Contains(t, logOutput, "account=789")
}

// TestForwardWithExplicitPlatform tests that explicit platform is passed through and NOT logged as assumed.
func TestForwardWithExplicitPlatform(t *testing.T) {
	e := echo.New()

	// Capture log output
	var logBuf bytes.Buffer
	oldLogOutput := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldLogOutput)

	expectedEvent := `{"user":"456","account_id":"999","page":"999","platform":"whatsapp","event":{"type":"external","value":{"type":"linksniffer:click","url":"https://example.com"}}}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Equal(t, expectedEvent, string(data))
		w.WriteHeader(http.StatusOK)
	}))

	q := make(url.Values)
	q.Set("url", "example.com")
	q.Set("id", "456")
	q.Set("pageid", "999")
	q.Set("platform", "whatsapp")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	client := &http.Client{}
	s := &Server{&Eventer{client, ts.URL}}

	err := s.forward(c)
	assert.Nil(t, err)
	assert.Equal(t, http.StatusFound, rec.Code)

	// Verify platform assumption was NOT logged
	logOutput := logBuf.String()
	assert.NotContains(t, logOutput, "[LINKSNIFFER_PLATFORM_ASSUMED]")
}

// TestRedirectOnEventFailureNon200 tests that redirect happens even when botserver returns non-200.
func TestRedirectOnEventFailureNon200(t *testing.T) {
	e := echo.New()

	// Capture log output
	var logBuf bytes.Buffer
	oldLogOutput := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldLogOutput)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))

	q := make(url.Values)
	q.Set("url", "example.com")
	q.Set("id", "user123")
	q.Set("pageid", "account456")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	client := &http.Client{}
	s := &Server{&Eventer{client, ts.URL}}

	err := s.forward(c)
	assert.Nil(t, err)
	assert.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "https://example.com", rec.Header().Get("Location"))

	// Verify event failure was logged
	logOutput := logBuf.String()
	assert.Contains(t, logOutput, "[LINKSNIFFER_EVENT_FAILED]")
	assert.Contains(t, logOutput, "id=user123")
	assert.Contains(t, logOutput, "account=account456")
}

// TestRedirectOnEventFailureConnectionRefused tests that redirect happens even when botserver is unreachable.
func TestRedirectOnEventFailureConnectionRefused(t *testing.T) {
	e := echo.New()

	// Capture log output
	var logBuf bytes.Buffer
	oldLogOutput := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldLogOutput)

	// Use an invalid URL that will cause connection refused
	invalidURL := "http://127.0.0.1:1"

	q := make(url.Values)
	q.Set("url", "example.com")
	q.Set("id", "user789")
	q.Set("pageid", "account111")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	client := &http.Client{}
	s := &Server{&Eventer{client, invalidURL}}

	err := s.forward(c)
	assert.Nil(t, err)
	assert.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "https://example.com", rec.Header().Get("Location"))

	// Verify event failure was logged
	logOutput := logBuf.String()
	assert.Contains(t, logOutput, "[LINKSNIFFER_EVENT_FAILED]")
}

// TestAccountIDPrefersAccountIDOverPageID tests that account_id query param is preferred.
func TestAccountIDPrefersAccountIDOverPageID(t *testing.T) {
	e := echo.New()

	expectedEvent := `{"user":"123","account_id":"preferred","page":"preferred","platform":"messenger","event":{"type":"external","value":{"type":"linksniffer:click","url":"https://example.com"}}}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Equal(t, expectedEvent, string(data))
		w.WriteHeader(http.StatusOK)
	}))

	q := make(url.Values)
	q.Set("url", "example.com")
	q.Set("id", "123")
	q.Set("account_id", "preferred")
	q.Set("pageid", "legacy")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	client := &http.Client{}
	s := &Server{&Eventer{client, ts.URL}}

	err := s.forward(c)
	assert.Nil(t, err)
	assert.Equal(t, http.StatusFound, rec.Code)
}

// TestPageIDStillWorksAlone tests that legacy pageid parameter still works.
func TestPageIDStillWorksAlone(t *testing.T) {
	e := echo.New()

	expectedEvent := `{"user":"123","account_id":"legacy789","page":"legacy789","platform":"messenger","event":{"type":"external","value":{"type":"linksniffer:click","url":"https://example.com"}}}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Equal(t, expectedEvent, string(data))
		w.WriteHeader(http.StatusOK)
	}))

	q := make(url.Values)
	q.Set("url", "example.com")
	q.Set("id", "123")
	q.Set("pageid", "legacy789")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	client := &http.Client{}
	s := &Server{&Eventer{client, ts.URL}}

	err := s.forward(c)
	assert.Nil(t, err)
	assert.Equal(t, http.StatusFound, rec.Code)
}

// TestForwardHttp tests http protocol.
func TestForwardHttp(t *testing.T) {
	e := echo.New()

	expectedEvent := `{"user":"123","account_id":"789","page":"789","platform":"messenger","event":{"type":"external","value":{"type":"linksniffer:click","url":"http://redcross.org"}}}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Equal(t, expectedEvent, string(data))
		w.WriteHeader(http.StatusOK)
	}))

	q := make(url.Values)
	q.Set("url", "redcross.org")
	q.Set("id", "123")
	q.Set("p", "http")
	q.Set("pageid", "789")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	client := &http.Client{}
	s := &Server{&Eventer{client, ts.URL}}

	err := s.forward(c)
	assert.Nil(t, err)
	assert.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "http://redcross.org", rec.Header().Get("Location"))
}

// TestForwardTel tests tel protocol.
func TestForwardTel(t *testing.T) {
	e := echo.New()

	expectedEvent := `{"user":"123","account_id":"789","page":"789","platform":"messenger","event":{"type":"external","value":{"type":"linksniffer:click","url":"tel:9999999999"}}}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := ioutil.ReadAll(r.Body)
		assert.Nil(t, err)
		assert.Equal(t, expectedEvent, string(data))
		w.WriteHeader(http.StatusOK)
	}))

	q := make(url.Values)
	q.Set("url", "9999999999")
	q.Set("id", "123")
	q.Set("p", "tel")
	q.Set("pageid", "789")
	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	client := &http.Client{}
	s := &Server{&Eventer{client, ts.URL}}

	err := s.forward(c)
	assert.Nil(t, err)
	assert.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "tel:9999999999", rec.Header().Get("Location"))
}

// TestErrorsOnLackingID tests that missing id returns 400.
func TestErrorsOnLackingID(t *testing.T) {
	e := echo.New()

	q := make(url.Values)
	q.Set("url", "redcross.org")

	req := httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	client := &http.Client{}
	s := &Server{&Eventer{client, ""}}

	err := s.forward(c)
	assert.NotNil(t, err)
	assert.Equal(t, 400, err.(*echo.HTTPError).Code)
}
