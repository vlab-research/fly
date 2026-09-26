package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

type fakeVerifier struct {
	answer SiteverifyResponse
	err    error
	calls  int
}

func (f *fakeVerifier) Verify(token, ip string) (SiteverifyResponse, error) {
	f.calls++
	return f.answer, f.err
}

type fakeSender struct {
	sent []ExternalEvent
	err  error
}

func (f *fakeSender) Send(ev ExternalEvent) error {
	f.sent = append(f.sent, ev)
	return f.err
}

const testHost = "id.vlab.digital"

func newServer(v *fakeVerifier, s *fakeSender) *Server {
	return &Server{
		HMACKey: []byte(vectorKey),
		Turnstile: TurnstileConfig{
			SiteKey:      "site-key",
			ExpectedHost: testHost,
			CheckBinding: true,
			Verifier:     v,
		},
		Sender: s,
	}
}

func passing() *fakeVerifier {
	return &fakeVerifier{answer: SiteverifyResponse{Success: true, Hostname: testHost, CData: vectorSig}}
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

func submitBody(l Link, results ...StepResult) string {
	b, _ := json.Marshal(submitRequest{l.User, l.Account, l.Platform, l.Methods, l.Sig, results})
	return string(b)
}

// signed builds a correctly signed link for arbitrary methods JSON.
func signed(methodsJSON string) Link {
	l := Link{Identity: vectorIdentity, Methods: enc(methodsJSON)}
	l.Sig = sign([]byte(vectorKey), l)
	return l
}

func TestPageRendersResolvedStepsForSignedLink(t *testing.T) {
	rec := getPage(newServer(passing(), &fakeSender{}), linkQuery(vectorLink()))

	assert.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, `data-provider="turnstile"`, "default resolves before rendering")
	assert.Contains(t, body, `"TurnstileSiteKey":"site-key"`)
	assert.Contains(t, body, "challenges.cloudflare.com/turnstile")
	assert.Equal(t, "no-referrer", rec.Header().Get("Referrer-Policy"))
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
}

func TestPageRefusesBadLinks(t *testing.T) {
	stripped := vectorLink()
	stripped.Methods = enc(`[]`)

	badMethods := signed(`[{"type":"otp","provider":"default"}]`)

	badSig := vectorLink()
	badSig.Sig = strings.Repeat("0", 64)

	for name, q := range map[string]string{
		"bad signature":    linkQuery(badSig),
		"methods stripped": linkQuery(stripped),
		"unknown method":   linkQuery(badMethods),
		"incomplete":       "vlab_user=1234567890",
	} {
		t.Run(name, func(t *testing.T) {
			rec := getPage(newServer(passing(), &fakeSender{}), q)
			assert.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Contains(t, rec.Body.String(), "This link isn't working")
			assert.NotContains(t, rec.Body.String(), `class="widget"`)
		})
	}
}

func TestPageEscapesIdentity(t *testing.T) {
	l := Link{Identity: Identity{"</script><script>alert(1)</script>", "a", "messenger"}, Methods: vectorMethods}
	l.Sig = sign([]byte(vectorKey), l)

	rec := getPage(newServer(passing(), &fakeSender{}), linkQuery(l))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.NotContains(t, rec.Body.String(), "<script>alert(1)")
}

func TestSubmitPostsEventOnPass(t *testing.T) {
	sender := &fakeSender{}
	rec := postSubmit(newServer(passing(), sender), submitBody(vectorLink(), StepResult{"tok"}))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"status":"verified"}`, rec.Body.String())
	assert.Equal(t, []ExternalEvent{buildEvent(vectorIdentity, []Method{{methodCaptcha, providerTurn}})}, sender.sent)
}

func TestSubmitRejectsBadSignatureWithoutCallingProvider(t *testing.T) {
	v, sender := passing(), &fakeSender{}
	l := vectorLink()
	l.Sig = strings.Repeat("0", 64)
	rec := postSubmit(newServer(v, sender), submitBody(l, StepResult{"tok"}))

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Equal(t, 0, v.calls)
	assert.Empty(t, sender.sent)
}

func TestSubmitRequiresOneResultPerMethod(t *testing.T) {
	for name, results := range map[string][]StepResult{
		"none":     {},
		"too many": {{"a"}, {"b"}},
	} {
		t.Run(name, func(t *testing.T) {
			v, sender := passing(), &fakeSender{}
			rec := postSubmit(newServer(v, sender), submitBody(vectorLink(), results...))
			assert.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Equal(t, 0, v.calls)
			assert.Empty(t, sender.sent)
		})
	}
}

func TestSubmitRejectsMissingOrOversizedToken(t *testing.T) {
	for name, tok := range map[string]string{"empty": "", "oversized": strings.Repeat("x", maxTokenLength+1)} {
		t.Run(name, func(t *testing.T) {
			v, sender := passing(), &fakeSender{}
			rec := postSubmit(newServer(v, sender), submitBody(vectorLink(), StepResult{tok}))
			assert.Equal(t, http.StatusForbidden, rec.Code)
			assert.Equal(t, 0, v.calls)
			assert.Empty(t, sender.sent)
		})
	}
}

func TestSubmitNoEventWhenChallengeFails(t *testing.T) {
	cases := map[string]SiteverifyResponse{
		"not passed":         {Success: false, ErrorCodes: []string{"invalid-input-response"}},
		"wrong host":         {Success: true, Hostname: "evil.example", CData: vectorSig},
		"other conversation": {Success: true, Hostname: testHost, CData: "someone-else"},
	}
	for name, answer := range cases {
		t.Run(name, func(t *testing.T) {
			sender := &fakeSender{}
			rec := postSubmit(newServer(&fakeVerifier{answer: answer}, sender), submitBody(vectorLink(), StepResult{"tok"}))
			assert.Equal(t, http.StatusForbidden, rec.Code)
			assert.JSONEq(t, `{"status":"failed"}`, rec.Body.String())
			assert.Empty(t, sender.sent)
		})
	}
}

func TestSubmitDummySecretSkipsBinding(t *testing.T) {
	s := newServer(&fakeVerifier{answer: SiteverifyResponse{Success: true, Hostname: "localhost", CData: "test-data"}}, &fakeSender{})
	s.Turnstile.CheckBinding = false

	rec := postSubmit(s, submitBody(vectorLink(), StepResult{"tok"}))
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestSubmitProviderErrorAsksForRetry(t *testing.T) {
	sender := &fakeSender{}
	rec := postSubmit(newServer(&fakeVerifier{err: errors.New("down")}, sender), submitBody(vectorLink(), StepResult{"tok"}))

	assert.Equal(t, http.StatusBadGateway, rec.Code)
	assert.JSONEq(t, `{"status":"retry"}`, rec.Body.String())
	assert.Empty(t, sender.sent)
}

// The event is the product: a failed POST to hermes must never show "verified".
func TestSubmitEventFailureIsNotVerified(t *testing.T) {
	rec := postSubmit(newServer(passing(), &fakeSender{err: errors.New("hermes down")}), submitBody(vectorLink(), StepResult{"tok"}))

	assert.Equal(t, http.StatusBadGateway, rec.Code)
	assert.JSONEq(t, `{"status":"retry"}`, rec.Body.String())
}

func TestSubmitExplicitProvider(t *testing.T) {
	sender := &fakeSender{}
	l := signed(`[{"type":"captcha","provider":"turnstile"}]`)
	rec := postSubmit(newServer(&fakeVerifier{answer: SiteverifyResponse{Success: true, Hostname: testHost, CData: l.Sig}}, sender), submitBody(l, StepResult{"tok"}))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Len(t, sender.sent, 1)
}

func TestEventerPostsExactBody(t *testing.T) {
	expected := `{"user":"1234567890","account_id":"acct-1","page":"acct-1","platform":"whatsapp","event":{"type":"external","value":{"type":"bouncer:verified","methods":[{"type":"captcha","provider":"turnstile"}]}}}`

	var got []byte
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	assert.Nil(t, NewEventer(ts.URL).Send(buildEvent(vectorIdentity, []Method{{methodCaptcha, providerTurn}})))
	assert.Equal(t, expected, string(got))
}

func TestEventerNon200IsError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer ts.Close()

	assert.Error(t, NewEventer(ts.URL).Send(buildEvent(vectorIdentity, nil)))
}

func TestTurnstileClientSendsSecretAndToken(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Nil(t, r.ParseForm())
		assert.Equal(t, "secret", r.PostForm.Get("secret"))
		assert.Equal(t, "tok", r.PostForm.Get("response"))
		assert.Equal(t, "1.2.3.4", r.PostForm.Get("remoteip"))
		_, _ = io.Copy(w, bytes.NewBufferString(`{"success":true,"hostname":"id.vlab.digital","cdata":"c","error-codes":[]}`))
	}))
	defer ts.Close()

	tt := NewTurnstile("secret")
	tt.url = ts.URL
	r, err := tt.Verify("tok", "1.2.3.4")

	assert.Nil(t, err)
	assert.Equal(t, SiteverifyResponse{Success: true, Hostname: "id.vlab.digital", CData: "c", ErrorCodes: []string{}}, r)
}

func TestIsDummySecret(t *testing.T) {
	assert.True(t, isDummySecret("1x0000000000000000000000000000000AA"))
	assert.False(t, isDummySecret("0x4AAAAAAA-real-secret"))
}

func TestAutoIsRefusedUnlessAllowed(t *testing.T) {
	l := signed(`[{"type":"auto","provider":"default"}]`)

	rec := getPage(newServer(passing(), &fakeSender{}), linkQuery(l))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	sender := &fakeSender{}
	rec = postSubmit(newServer(passing(), sender), submitBody(l, StepResult{}))
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Empty(t, sender.sent)
}

func TestAutoVerifiesWhenAllowed(t *testing.T) {
	l := signed(`[{"type":"auto","provider":"default"}]`)
	v, sender := passing(), &fakeSender{}
	s := newServer(v, sender)
	s.AllowAuto = true

	page := getPage(s, linkQuery(l))
	assert.Equal(t, http.StatusOK, page.Code)
	assert.NotContains(t, page.Body.String(), "challenges.cloudflare.com", "auto alone loads no provider script")

	rec := postSubmit(s, submitBody(l, StepResult{}))
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 0, v.calls)
	assert.Equal(t, []ExternalEvent{buildEvent(vectorIdentity, []Method{{methodAuto, providerNone}})}, sender.sent)
}

// auto alongside a real method still requires the real method to pass.
func TestAutoDoesNotExcuseOtherMethods(t *testing.T) {
	l := signed(`[{"type":"auto","provider":"default"},{"type":"captcha","provider":"default"}]`)
	sender := &fakeSender{}
	s := newServer(&fakeVerifier{answer: SiteverifyResponse{Success: false}}, sender)
	s.AllowAuto = true

	rec := postSubmit(s, submitBody(l, StepResult{}, StepResult{"tok"}))
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Empty(t, sender.sent)
}
