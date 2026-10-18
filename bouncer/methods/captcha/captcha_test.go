package captcha

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/vlab-research/bouncer/verify"
)

type fakeProvider struct {
	name  string
	token string
	err   error
}

func (f *fakeProvider) Name() string          { return f.name }
func (f *fakeProvider) Client() verify.Client { return verify.Client{Runner: "captcha/" + f.name} }
func (f *fakeProvider) Check(ctx verify.Context, token string) error {
	f.token = token
	return f.err
}

func plan(t *testing.T, m Method, params string) verify.Step {
	st, err := m.Plan(json.RawMessage(params))
	assert.Nil(t, err)
	return st
}

func TestProviderSelection(t *testing.T) {
	def, other := &fakeProvider{name: "first"}, &fakeProvider{name: "second"}
	m := New(def, other)

	assert.Equal(t, "first", plan(t, m, `{}`).Ran()["provider"], "no provider means the default")
	assert.Equal(t, "first", plan(t, m, `{"provider":"default"}`).Ran()["provider"])
	assert.Equal(t, "second", plan(t, m, `{"provider":"second"}`).Ran()["provider"])
	assert.Equal(t, "captcha", plan(t, m, `{}`).Ran()["type"])

	_, err := m.Plan(json.RawMessage(`{"provider":"recaptcha"}`))
	assert.Error(t, err, "unknown provider")
	_, err = m.Plan(json.RawMessage(`{"provder":"second"}`))
	assert.Error(t, err, "unknown parameter")
}

func TestStepChecksTheTokenWithItsProvider(t *testing.T) {
	p := &fakeProvider{name: "p"}
	st := plan(t, New(p), `{}`)

	assert.Nil(t, st.Check(verify.Context{}, json.RawMessage(`{"token":"tok"}`)))
	assert.Equal(t, "tok", p.token)

	assert.Error(t, st.Check(verify.Context{}, json.RawMessage(`{}`)), "no token")
	assert.Error(t, st.Check(verify.Context{}, json.RawMessage(`"tok"`)), "not an object")
}

// --- Turnstile -------------------------------------------------------------

type fakeAPI struct {
	answer SiteverifyResponse
	err    error
	calls  int
}

func (f *fakeAPI) Verify(token, ip string) (SiteverifyResponse, error) {
	f.calls++
	return f.answer, f.err
}

const host = "id.vlab.digital"

func turnstileWith(api *fakeAPI) *Turnstile {
	return &Turnstile{SiteKey: "site-key", ExpectedHost: host, CheckBinding: true, API: api}
}

func TestTurnstileClient(t *testing.T) {
	c := turnstileWith(&fakeAPI{}).Client()
	assert.Equal(t, "captcha/turnstile", c.Runner)
	assert.Equal(t, "site-key", c.Config["sitekey"])
	assert.Contains(t, string(c.JS), "bouncerRunners['captcha/turnstile']")
}

func TestTurnstileCheck(t *testing.T) {
	ctx := verify.Context{Binding: "sig"}

	pass := &fakeAPI{answer: SiteverifyResponse{Success: true, Hostname: host, CData: "sig"}}
	assert.Nil(t, turnstileWith(pass).Check(ctx, "tok"))

	for name, answer := range map[string]SiteverifyResponse{
		"not passed":         {Success: false, ErrorCodes: []string{"invalid-input-response"}},
		"wrong host":         {Success: true, Hostname: "evil.example", CData: "sig"},
		"other conversation": {Success: true, Hostname: host, CData: "someone-else"},
	} {
		t.Run(name, func(t *testing.T) {
			err := turnstileWith(&fakeAPI{answer: answer}).Check(ctx, "tok")
			assert.Error(t, err)
			assert.False(t, errors.Is(err, verify.ErrUnavailable), "the participant failed, not us")
		})
	}
}

func TestTurnstileOversizedTokenNeverReachesCloudflare(t *testing.T) {
	api := &fakeAPI{}
	assert.Error(t, turnstileWith(api).Check(verify.Context{}, string(make([]byte, maxTokenLength+1))))
	assert.Equal(t, 0, api.calls)
}

func TestTurnstileUnreachableIsUnavailable(t *testing.T) {
	err := turnstileWith(&fakeAPI{err: errors.New("down")}).Check(verify.Context{}, "tok")
	assert.True(t, errors.Is(err, verify.ErrUnavailable))
}

func TestTurnstileDummySecretSkipsBinding(t *testing.T) {
	tt := NewTurnstile("1x00000000000000000000AA", "1x0000000000000000000000000000000AA", host)
	assert.False(t, tt.CheckBinding)
	tt.API = &fakeAPI{answer: SiteverifyResponse{Success: true, Hostname: "localhost", CData: "test-data"}}
	assert.Nil(t, tt.Check(verify.Context{Binding: "sig"}, "tok"))

	assert.True(t, NewTurnstile("k", "0x4AAAAAAA-real-secret", host).CheckBinding)
}

func TestSiteverifyClientSendsSecretAndToken(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Nil(t, r.ParseForm())
		assert.Equal(t, "secret", r.PostForm.Get("secret"))
		assert.Equal(t, "tok", r.PostForm.Get("response"))
		assert.Equal(t, "1.2.3.4", r.PostForm.Get("remoteip"))
		_, _ = io.Copy(w, bytes.NewBufferString(`{"success":true,"hostname":"id.vlab.digital","cdata":"c","error-codes":[]}`))
	}))
	defer ts.Close()

	c := &siteverifyClient{ts.Client(), ts.URL, "secret"}
	r, err := c.Verify("tok", "1.2.3.4")

	assert.Nil(t, err)
	assert.Equal(t, SiteverifyResponse{Success: true, Hostname: "id.vlab.digital", CData: "c", ErrorCodes: []string{}}, r)
}
