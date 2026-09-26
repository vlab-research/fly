package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// Method is one verification a survey asks for, as the researcher wrote it
// (after replybot's normalization). Parameters are per type; today only
// `captcha` exists and its only parameter is `provider`.
type Method struct {
	Type     string `json:"type"`
	Provider string `json:"provider,omitempty"`
}

const (
	methodCaptcha   = "captcha"
	providerDefault = "default"
	providerTurn    = "turnstile"

	// `auto` passes with no action from the participant. It exists so the
	// whole signed path (replybot's key, bouncer's checks, the event reaching
	// the survey) can be tested end to end without a real provider, and is
	// refused unless BOUNCER_ALLOW_AUTO is set.
	methodAuto   = "auto"
	providerNone = "none"
)

// The providers a researcher may name for each method type. `default` lets
// us choose (see defaultProvider) so switching providers never means editing
// surveys. Must match replybot's VERIFICATION_METHODS.
var allowedProviders = map[string]map[string]bool{
	methodCaptcha: {providerDefault: true, providerTurn: true},
	methodAuto:    {providerDefault: true},
}

// What `default` means, per method type.
var defaultProvider = map[string]string{
	methodCaptcha: providerTurn,
	methodAuto:    providerNone,
}

// decodeMethods reads the `vlab_methods` param: base64url (unpadded) JSON.
// The signature covers the raw param, not this decoding, so nothing here has
// to reproduce replybot's serialization byte for byte.
func decodeMethods(raw string) ([]Method, error) {
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("methods are not base64url: %v", err)
	}

	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var ms []Method
	if err := dec.Decode(&ms); err != nil {
		return nil, fmt.Errorf("methods are not a valid list: %v", err)
	}
	return ms, validateMethods(ms)
}

func validateMethods(ms []Method) error {
	if len(ms) == 0 {
		return fmt.Errorf("no verification methods")
	}
	seen := map[string]bool{}
	for i, m := range ms {
		providers, ok := allowedProviders[m.Type]
		if !ok {
			return fmt.Errorf("method %d: unknown type %q", i, m.Type)
		}
		if seen[m.Type] {
			return fmt.Errorf("method %d: %q appears twice", i, m.Type)
		}
		seen[m.Type] = true
		if !providers[m.Provider] {
			return fmt.Errorf("method %d: unknown %s provider %q", i, m.Type, m.Provider)
		}
	}
	return nil
}

// resolveMethods replaces `default` with the concrete provider that runs.
func resolveMethods(ms []Method) []Method {
	out := make([]Method, len(ms))
	for i, m := range ms {
		if m.Provider == providerDefault {
			m.Provider = defaultProvider[m.Type]
		}
		out[i] = m
	}
	return out
}

func describeMethods(ms []Method) string {
	parts := make([]string, len(ms))
	for i, m := range ms {
		parts[i] = m.Type + ":" + m.Provider
	}
	return strings.Join(parts, ",")
}
