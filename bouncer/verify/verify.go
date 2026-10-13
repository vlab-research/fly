// Package verify is the contract between bouncer's server and its
// verification methods. The server knows only this package: it asks a
// Registry to plan the methods a link requests, renders each Step's Client,
// and hands each Step back its proof. Everything specific to a method --
// its parameters, its providers, which provider is its default, how a proof
// is checked -- lives in that method's own package (bouncer/methods/...).
package verify

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
)

// Method is one kind of verification (`captcha`, ...). Plan validates the
// parameters a survey gave it and returns the step to run. params is the
// method's JSON object with `type` removed; a method rejects any parameter it
// does not understand.
type Method interface {
	Plan(params json.RawMessage) (Step, error)
}

// Step is one planned verification for one participant.
type Step interface {
	// Ran describes what actually runs, e.g. {"type":"captcha","provider":"turnstile"}.
	// It is reported in the `bouncer:verified` event.
	Ran() map[string]string
	// Client is what the page needs to run this step in the browser.
	Client() Client
	// Check verifies the proof the page submitted for this step. Return an
	// error wrapping ErrUnavailable when the failure is ours (a provider was
	// unreachable) rather than the participant's.
	Check(ctx Context, proof json.RawMessage) error
}

// Client is a step's browser half. Runner names a function the step's JS
// registers on `window.bouncerRunners`; the page calls it with Config and a
// `done(proof)` callback. JS is that registration, embedded by the method.
type Client struct {
	Runner string            `json:"runner"`
	Config map[string]string `json:"config"`
	JS     template.JS       `json:"-"`
}

// Context is what a check may bind a proof to.
type Context struct {
	RemoteIP string
	// Binding is unique to this link (its signature). A provider that can
	// carry data through the challenge should bind the proof to it, so a proof
	// earned on one conversation's page cannot be spent on another's.
	Binding string
}

// ErrUnavailable marks a check that could not be completed on our side.
var ErrUnavailable = errors.New("verification provider unavailable")

// Registry is the methods this deployment offers, by name.
type Registry map[string]Method

// Plan turns a link's decoded method list into steps, in order. Each entry is
// an object with a `type`; the rest of the object is that method's parameters.
func (r Registry) Plan(requests []json.RawMessage) ([]Step, error) {
	if len(requests) == 0 {
		return nil, fmt.Errorf("no verification methods")
	}

	steps := make([]Step, len(requests))
	seen := map[string]bool{}
	for i, raw := range requests {
		typ, params, err := splitType(raw)
		if err != nil {
			return nil, fmt.Errorf("method %d: %v", i, err)
		}
		m, ok := r[typ]
		if !ok {
			return nil, fmt.Errorf("method %d: %q is not offered here", i, typ)
		}
		if seen[typ] {
			return nil, fmt.Errorf("method %d: %q appears twice", i, typ)
		}
		seen[typ] = true

		if steps[i], err = m.Plan(params); err != nil {
			return nil, fmt.Errorf("method %d (%s): %v", i, typ, err)
		}
	}
	return steps, nil
}

// splitType separates an entry's `type` from its parameters.
func splitType(raw json.RawMessage) (string, json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return "", nil, fmt.Errorf("not an object")
	}
	var typ string
	if err := json.Unmarshal(fields["type"], &typ); err != nil || typ == "" {
		return "", nil, fmt.Errorf("missing a string `type`")
	}
	delete(fields, "type")
	params, _ := json.Marshal(fields)
	return typ, params, nil
}

// DecodeParams is how a method reads its parameters: strictly, so a typo in a
// survey (`provder`) is an error rather than a silently ignored setting.
func DecodeParams(params json.RawMessage, into interface{}) error {
	dec := json.NewDecoder(bytes.NewReader(params))
	dec.DisallowUnknownFields()
	return dec.Decode(into)
}
