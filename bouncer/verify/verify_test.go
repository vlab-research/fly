package verify

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
)

// recorder is a method that records the params it was planned with.
type recorder struct{ got []string }

func (r *recorder) Plan(params json.RawMessage) (Step, error) {
	r.got = append(r.got, string(params))
	return nil, nil
}

type refuses struct{}

func (refuses) Plan(json.RawMessage) (Step, error) { return nil, fmt.Errorf("bad params") }

func list(entries ...string) []json.RawMessage {
	out := make([]json.RawMessage, len(entries))
	for i, e := range entries {
		out[i] = json.RawMessage(e)
	}
	return out
}

func TestPlanHandsEachMethodItsParamsWithoutType(t *testing.T) {
	a, b := &recorder{}, &recorder{}
	r := Registry{"a": a, "b": b}

	steps, err := r.Plan(list(`{"type":"a","x":1}`, `{"type":"b"}`))
	assert.Nil(t, err)
	assert.Len(t, steps, 2)
	assert.Equal(t, []string{`{"x":1}`}, a.got)
	assert.Equal(t, []string{`{}`}, b.got)
}

func TestPlanRejects(t *testing.T) {
	r := Registry{"a": &recorder{}, "bad": refuses{}}
	for name, entries := range map[string][]json.RawMessage{
		"empty list":        list(),
		"not an object":     list(`"a"`),
		"null entry":        list(`null`),
		"no type":           list(`{"x":1}`),
		"non-string type":   list(`{"type":1}`),
		"not offered":       list(`{"type":"otp"}`),
		"twice":             list(`{"type":"a"}`, `{"type":"a"}`),
		"method refuses it": list(`{"type":"bad"}`),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := r.Plan(entries)
			assert.Error(t, err)
		})
	}
}

func TestDecodeParamsIsStrict(t *testing.T) {
	var p struct {
		Provider string `json:"provider"`
	}
	assert.Nil(t, DecodeParams(json.RawMessage(`{"provider":"x"}`), &p))
	assert.Equal(t, "x", p.Provider)
	assert.Error(t, DecodeParams(json.RawMessage(`{"provder":"x"}`), &p))
}
