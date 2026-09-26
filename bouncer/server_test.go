package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/vlab-research/bouncer/verify"
)

func enc(json string) string { return base64.RawURLEncoding.EncodeToString([]byte(json)) }

// The server is tested against a fake method, so these tests say nothing
// about captcha and would not change if every real method did.
type fakeMethod struct {
	checkErr error
	checked  []json.RawMessage
	binding  string
}

func (f *fakeMethod) Plan(params json.RawMessage) (verify.Step, error) {
	var p struct{}
	if err := verify.DecodeParams(params, &p); err != nil {
		return nil, err
	}
	return fakeStep{f}, nil
}

type fakeStep struct{ m *fakeMethod }

func (s fakeStep) Ran() map[string]string { return map[string]string{"type": "captcha"} }
func (s fakeStep) Client() verify.Client {
	return verify.Client{Runner: "fake", Config: map[string]string{"key": "public"}, JS: template.JS(`/*fake-runner*/`)}
}
func (s fakeStep) Check(ctx verify.Context, proof json.RawMessage) error {
	s.m.checked = append(s.m.checked, proof)
	s.m.binding = ctx.Binding
	return s.m.checkErr
}

type fakeSender struct {
	sent []ExternalEvent
	err  error
}

func (f *fakeSender) Send(ev ExternalEvent) error {
	f.sent = append(f.sent, ev)
	return f.err
}

func newServer(m *fakeMethod, s *fakeSender) *Server {
	return &Server{
		HMACKey: []byte(vectorKey),
		Methods: verify.Registry{"captcha": m},
		Sender:  s,
	}
}

func linkQuery(l Link) string {
	q := url.Values{}
	q.Set(paramUser, l.User)
	q.Set(paramAccount, l.Account)
	q.Set(paramPlatform, l.Platform)
	q.Set(paramMethods, l.Methods)
	q.Set(paramSig, l.Sig)
	return q.Encode()
}

func getPage(s *Server, query string) *httptest.ResponseRecorder {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/verify?"+query, nil)
	rec := httptest.NewRecorder()
	_ = s.page(e.NewContext(req, rec))
	return rec
}

func postSubmit(s *Server, body string) *httptest.ResponseRecorder {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/verify/submit", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	_ = s.submit(e.NewContext(req, rec))
	return rec
}

func submitBody(l Link, results ...string) string {
	raw := make([]json.RawMessage, len(results))
	for i, r := range results {
		raw[i] = json.RawMessage(r)
	}
	b, _ := json.Marshal(submitRequest{l.User, l.Account, l.Platform, l.Methods, l.Sig, raw})
	return string(b)
}

// signed builds a correctly signed link for arbitrary methods JSON.
func signed(methodsJSON string) Link {
	l := Link{Identity: vectorIdentity, Methods: enc(methodsJSON)}
	l.Sig = sign([]byte(vectorKey), l)
	return l
}

func TestPageRendersStepsFromTheirClients(t *testing.T) {
	rec := getPage(newServer(&fakeMethod{}, &fakeSender{}), linkQuery(vectorLink()))

	assert.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, `"runner":"fake"`)
	assert.Contains(t, body, `"key":"public"`)
	assert.Contains(t, body, `"binding":"`+vectorSig+`"`, "every step gets the link binding")
	assert.Contains(t, body, `/*fake-runner*/`)
	assert.Equal(t, "no-referrer", rec.Header().Get("Referrer-Policy"))
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
}

func TestPageRefusesBadLinks(t *testing.T) {
	stripped := vectorLink()
	stripped.Methods = enc(`[]`)

	badSig := vectorLink()
	badSig.Sig = strings.Repeat("0", 64)

	for name, q := range map[string]string{
		"bad signature":      linkQuery(badSig),
		"methods stripped":   linkQuery(stripped),
		"method not offered": linkQuery(signed(`[{"type":"otp"}]`)),
		"bad parameter":      linkQuery(signed(`[{"type":"captcha","provder":"x"}]`)),
		"incomplete":         "vlab_user=1234567890",
	} {
		t.Run(name, func(t *testing.T) {
			rec := getPage(newServer(&fakeMethod{}, &fakeSender{}), q)
			assert.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Contains(t, rec.Body.String(), "This link isn't working")
			assert.NotContains(t, rec.Body.String(), `class="widget"`)
		})
	}
}

func TestPageEscapesIdentity(t *testing.T) {
	l := Link{Identity: Identity{"</script><script>alert(1)</script>", "a", "messenger"}, Methods: vectorMethods}
	l.Sig = sign([]byte(vectorKey), l)

	rec := getPage(newServer(&fakeMethod{}, &fakeSender{}), linkQuery(l))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.NotContains(t, rec.Body.String(), "<script>alert(1)")
}

func TestSubmitChecksEachProofAndPostsEvent(t *testing.T) {
	m, sender := &fakeMethod{}, &fakeSender{}
	rec := postSubmit(newServer(m, sender), submitBody(vectorLink(), `{"token":"tok"}`))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"status":"verified"}`, rec.Body.String())
	assert.Equal(t, []json.RawMessage{json.RawMessage(`{"token":"tok"}`)}, m.checked, "the step gets its proof verbatim")
	assert.Equal(t, vectorSig, m.binding)
	assert.Equal(t, []ExternalEvent{buildEvent(vectorIdentity, []map[string]string{{"type": "captcha"}})}, sender.sent)
}

func TestSubmitRejectsBadSignatureWithoutChecking(t *testing.T) {
	m, sender := &fakeMethod{}, &fakeSender{}
	l := vectorLink()
	l.Sig = strings.Repeat("0", 64)
	rec := postSubmit(newServer(m, sender), submitBody(l, `{}`))

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Empty(t, m.checked)
	assert.Empty(t, sender.sent)
}

func TestSubmitRequiresOneResultPerMethod(t *testing.T) {
	for name, results := range map[string][]string{
		"none":     {},
		"too many": {`{}`, `{}`},
	} {
		t.Run(name, func(t *testing.T) {
			m, sender := &fakeMethod{}, &fakeSender{}
			rec := postSubmit(newServer(m, sender), submitBody(vectorLink(), results...))
			assert.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Empty(t, m.checked)
			assert.Empty(t, sender.sent)
		})
	}
}

func TestSubmitFailedCheckSendsNothing(t *testing.T) {
	sender := &fakeSender{}
	rec := postSubmit(newServer(&fakeMethod{checkErr: errors.New("nope")}, sender), submitBody(vectorLink(), `{}`))

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.JSONEq(t, `{"status":"failed"}`, rec.Body.String())
	assert.Empty(t, sender.sent)
}

func TestSubmitUnavailableProviderAsksForRetry(t *testing.T) {
	sender := &fakeSender{}
	err := fmt.Errorf("%w: down", verify.ErrUnavailable)
	rec := postSubmit(newServer(&fakeMethod{checkErr: err}, sender), submitBody(vectorLink(), `{}`))

	assert.Equal(t, http.StatusBadGateway, rec.Code)
	assert.JSONEq(t, `{"status":"retry"}`, rec.Body.String())
	assert.Empty(t, sender.sent)
}

// The event is the product: a failed POST to hermes must never show "verified".
func TestSubmitEventFailureIsNotVerified(t *testing.T) {
	rec := postSubmit(newServer(&fakeMethod{}, &fakeSender{err: errors.New("hermes down")}), submitBody(vectorLink(), `{}`))

	assert.Equal(t, http.StatusBadGateway, rec.Code)
	assert.JSONEq(t, `{"status":"retry"}`, rec.Body.String())
}

func TestEventerPostsExactBody(t *testing.T) {
	expected := `{"user":"1234567890","account_id":"acct-1","page":"acct-1","platform":"whatsapp","event":{"type":"external","value":{"type":"bouncer:verified","methods":[{"provider":"turnstile","type":"captcha"}]}}}`

	var got []byte
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	ran := []map[string]string{{"type": "captcha", "provider": "turnstile"}}
	assert.Nil(t, NewEventer(ts.URL).Send(buildEvent(vectorIdentity, ran)))
	assert.Equal(t, expected, string(got))
}

func TestEventerNon200IsError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer ts.Close()

	assert.Error(t, NewEventer(ts.URL).Send(buildEvent(vectorIdentity, nil)))
}
