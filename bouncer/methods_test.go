package main

import (
	"encoding/base64"
	"testing"

	"github.com/stretchr/testify/assert"
)

func enc(json string) string { return base64.RawURLEncoding.EncodeToString([]byte(json)) }

func TestDecodeMethods(t *testing.T) {
	ms, err := decodeMethods(vectorMethods)
	assert.Nil(t, err)
	assert.Equal(t, []Method{{methodCaptcha, providerDefault}}, ms)

	ms, err = decodeMethods(enc(`[{"type":"captcha","provider":"turnstile"}]`))
	assert.Nil(t, err)
	assert.Equal(t, []Method{{methodCaptcha, providerTurn}}, ms)
}

func TestDecodeMethodsRejects(t *testing.T) {
	cases := map[string]string{
		"not base64":         "%%%",
		"not a list":         enc(`{"type":"captcha"}`),
		"empty list":         enc(`[]`),
		"unknown type":       enc(`[{"type":"otp","provider":"default"}]`),
		"auto with provider": enc(`[{"type":"auto","provider":"turnstile"}]`),
		"unknown provider":   enc(`[{"type":"captcha","provider":"recaptcha"}]`),
		"missing provider":   enc(`[{"type":"captcha"}]`),
		"unknown parameter":  enc(`[{"type":"captcha","provider":"default","provder":"x"}]`),
		"duplicate type":     enc(`[{"type":"captcha","provider":"default"},{"type":"captcha","provider":"turnstile"}]`),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := decodeMethods(raw)
			assert.Error(t, err)
		})
	}
}

func TestResolveMethods(t *testing.T) {
	in := []Method{{methodCaptcha, providerDefault}}
	assert.Equal(t, []Method{{methodCaptcha, providerTurn}}, resolveMethods(in))
	assert.Equal(t, providerDefault, in[0].Provider, "input is not mutated")

	explicit := []Method{{methodCaptcha, providerTurn}}
	assert.Equal(t, explicit, resolveMethods(explicit))
}

// Every provider a researcher may name must resolve to one checkStep can run.
func TestEveryAllowedProviderResolvesToACheckedOne(t *testing.T) {
	for typ, providers := range allowedProviders {
		for p := range providers {
			r := resolveMethods([]Method{{typ, p}})[0]
			assert.NotEqual(t, providerDefault, r.Provider, "%s default must resolve", typ)
			err := (&Server{Turnstile: TurnstileConfig{Verifier: &fakeVerifier{}}}).checkStep(r, StepResult{}, vectorLink(), "")
			if err != nil {
				assert.NotContains(t, err.Error(), "no checker", "%s:%s has no checker", typ, r.Provider)
			}
		}
	}
}
