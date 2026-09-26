// Package auto is a verification method that passes with no action from the
// participant. It exists so the whole signed path -- replybot's key, bouncer's
// checks, the event reaching the survey -- can be tested end to end without a
// real provider. bouncer registers it only when BOUNCER_ALLOW_AUTO is set, so
// anywhere else a link asking for it is refused like any unknown method.
package auto

import (
	"encoding/json"
	"html/template"

	"github.com/vlab-research/bouncer/verify"
)

type Method struct{}

// auto takes no parameters and has no providers.
func (Method) Plan(raw json.RawMessage) (verify.Step, error) {
	var none struct{}
	if err := verify.DecodeParams(raw, &none); err != nil {
		return nil, err
	}
	return step{}, nil
}

type step struct{}

func (step) Ran() map[string]string { return map[string]string{"type": "auto"} }

func (step) Client() verify.Client {
	return verify.Client{
		Runner: "auto",
		JS:     template.JS(`window.bouncerRunners['auto'] = function (el, cfg, done) { done({}); };`),
	}
}

func (step) Check(verify.Context, json.RawMessage) error { return nil }
