package auto

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/vlab-research/bouncer/verify"
)

func TestAutoTakesNoParamsAndAlwaysPasses(t *testing.T) {
	st, err := Method{}.Plan(json.RawMessage(`{}`))
	assert.Nil(t, err)
	assert.Equal(t, map[string]string{"type": "auto"}, st.Ran())
	assert.Nil(t, st.Check(verify.Context{}, json.RawMessage(`{}`)))

	_, err = Method{}.Plan(json.RawMessage(`{"provider":"default"}`))
	assert.Error(t, err, "auto has no providers")
}
