package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// The shared test vector. replybot/lib/generic-translator.test.js asserts the
// same key, link and signature; if either side's signing changes, one of the
// two tests breaks. vectorMethods is base64url of
// [{"type":"captcha","provider":"default"}].
const (
	vectorKey     = "bouncer-test-vector-key"
	vectorMethods = "W3sidHlwZSI6ImNhcHRjaGEiLCJwcm92aWRlciI6ImRlZmF1bHQifV0"
	vectorSig     = "c0a8ef438ad169bcc0eda1faf601c89b76ce5482ae042c06db452d8361cef1fd"
)

var vectorIdentity = Identity{"1234567890", "acct-1", "whatsapp"}

func vectorLink() Link {
	return Link{Identity: vectorIdentity, Methods: vectorMethods, Sig: vectorSig}
}

func TestSignMatchesSharedVector(t *testing.T) {
	assert.Equal(t, vectorSig, sign([]byte(vectorKey), vectorLink()))
}

func TestVerifySig(t *testing.T) {
	key := []byte(vectorKey)
	assert.True(t, verifySig(key, vectorLink()))

	user := vectorLink()
	user.User = "1234567891"
	assert.False(t, verifySig(key, user), "a different user must not verify")

	// Stripping or swapping a method must break the signature.
	methods := vectorLink()
	methods.Methods = "W10" // []
	assert.False(t, verifySig(key, methods), "different methods must not verify")

	assert.False(t, verifySig([]byte("other-key"), vectorLink()), "a different key must not verify")

	empty := vectorLink()
	empty.Sig = ""
	assert.False(t, verifySig(key, empty), "an empty signature must not verify")
}

func TestSigningInputCannotCollide(t *testing.T) {
	a := Link{Identity: Identity{"12", "3", "messenger"}, Methods: "m"}
	b := Link{Identity: Identity{"1", "23", "messenger"}, Methods: "m"}
	assert.NotEqual(t, signingInput(a), signingInput(b))
}

func getter(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func fullParams() map[string]string {
	return map[string]string{
		paramUser: "u", paramAccount: "a", paramPlatform: "messenger",
		paramMethods: "m", paramSig: "s",
	}
}

func TestParseLink(t *testing.T) {
	l, err := parseLink(getter(fullParams()))
	assert.Nil(t, err)
	assert.Equal(t, Link{Identity: Identity{"u", "a", "messenger"}, Methods: "m", Sig: "s"}, l)

	for _, missing := range []string{paramUser, paramAccount, paramPlatform, paramMethods, paramSig} {
		t.Run("missing "+missing, func(t *testing.T) {
			m := fullParams()
			delete(m, missing)
			_, err := parseLink(getter(m))
			if assert.Error(t, err) {
				assert.Contains(t, err.Error(), missing)
			}
		})
	}

	for _, bad := range []string{"synthetic", "Messenger", "sms"} {
		t.Run("rejects platform "+bad, func(t *testing.T) {
			m := fullParams()
			m[paramPlatform] = bad
			_, err := parseLink(getter(m))
			if assert.Error(t, err) {
				assert.Contains(t, err.Error(), "unknown platform")
			}
		})
	}
}
