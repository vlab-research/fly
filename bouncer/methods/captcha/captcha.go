// Package captcha is the `captcha` verification method. It owns its
// providers and which one `default` means; bouncer's server knows none of it.
//
//	{"type": "captcha"}                          -> the default provider
//	{"type": "captcha", "provider": "turnstile"} -> that provider
package captcha

import (
	"encoding/json"
	"fmt"

	"github.com/vlab-research/bouncer/verify"
)

// Provider is one captcha service.
type Provider interface {
	Name() string
	Client() verify.Client
	Check(ctx verify.Context, token string) error
}

// Method is the `captcha` method. Default names the provider used when a
// survey asks for `default` or names none; changing it switches every such
// survey without editing any of them.
type Method struct {
	Providers map[string]Provider
	Default   string
}

func New(defaultProvider Provider, others ...Provider) Method {
	m := Method{Providers: map[string]Provider{}, Default: defaultProvider.Name()}
	for _, p := range append([]Provider{defaultProvider}, others...) {
		m.Providers[p.Name()] = p
	}
	return m
}

type params struct {
	Provider string `json:"provider"`
}

func (m Method) Plan(raw json.RawMessage) (verify.Step, error) {
	var p params
	if err := verify.DecodeParams(raw, &p); err != nil {
		return nil, err
	}

	name := p.Provider
	if name == "" || name == "default" {
		name = m.Default
	}
	provider, ok := m.Providers[name]
	if !ok {
		return nil, fmt.Errorf("unknown provider %q", p.Provider)
	}
	return step{provider}, nil
}

type step struct{ provider Provider }

func (s step) Ran() map[string]string {
	return map[string]string{"type": "captcha", "provider": s.provider.Name()}
}

func (s step) Client() verify.Client { return s.provider.Client() }

// A captcha's proof is the token its widget produced.
type proof struct {
	Token string `json:"token"`
}

func (s step) Check(ctx verify.Context, raw json.RawMessage) error {
	var p proof
	if err := json.Unmarshal(raw, &p); err != nil || p.Token == "" {
		return fmt.Errorf("no token")
	}
	return s.provider.Check(ctx, p.Token)
}
