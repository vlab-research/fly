package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// The canonical conversation-identity query params, shared with replybot
// (`replybot/lib/generic-translator.js` IDENTITY_PARAMS), linksniffer and
// moviehouse. `vlab_methods` and `vlab_sig` are bouncer's own: the requested
// verifications, and replybot's HMAC over them and the triple.
const (
	paramUser     = "vlab_user"
	paramAccount  = "vlab_account"
	paramPlatform = "vlab_platform"
	paramMethods  = "vlab_methods"
	paramSig      = "vlab_sig"
)

// The transports a conversation can run on. `platform` is never "synthetic" --
// that is a `source`, not a platform. See documentation/event-envelope.md.
var messagingPlatforms = map[string]bool{
	"messenger": true,
	"whatsapp":  true,
}

// Identity is the conversation a verification belongs to.
type Identity struct {
	User     string
	Account  string
	Platform string
}

// Link is everything a signed bouncer link carries.
type Link struct {
	Identity
	// Methods is the raw `vlab_methods` param exactly as signed.
	Methods string
	Sig     string
}

// parseLink requires every component. bouncer has no legacy URLs in flight,
// so unlike linksniffer there is no fallback chain and nothing is assumed: an
// incomplete link can only be hand-authored or tampered with.
func parseLink(get func(string) string) (Link, error) {
	l := Link{
		Identity: Identity{get(paramUser), get(paramAccount), get(paramPlatform)},
		Methods:  get(paramMethods),
		Sig:      get(paramSig),
	}

	var missing []string
	for _, p := range []struct{ name, value string }{
		{paramUser, l.User},
		{paramAccount, l.Account},
		{paramPlatform, l.Platform},
		{paramMethods, l.Methods},
		{paramSig, l.Sig},
	} {
		if p.value == "" {
			missing = append(missing, p.name)
		}
	}
	if len(missing) > 0 {
		return Link{}, fmt.Errorf("missing %s", strings.Join(missing, ", "))
	}
	if !messagingPlatforms[l.Platform] {
		return Link{}, fmt.Errorf("unknown platform %q -- must be messenger or whatsapp", l.Platform)
	}
	return l, nil
}

// signingInput is the exact string both sides HMAC. The version tag lets the
// scheme change without the two sides disagreeing silently; `|` cannot occur
// in a PSID, a phone number, a page id, a platform name or base64url, so
// distinct links cannot collide. The methods are signed so a participant
// cannot strip a verification out of the URL.
func signingInput(l Link) string {
	return strings.Join([]string{"v2", l.User, l.Account, l.Platform, l.Methods}, "|")
}

// sign must stay byte-identical to replybot's `verificationSignature`. The
// shared test vector in identity_test.go and generic-translator.test.js
// enforces it.
func sign(key []byte, l Link) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingInput(l)))
	return hex.EncodeToString(mac.Sum(nil))
}

func verifySig(key []byte, l Link) bool {
	return hmac.Equal([]byte(sign(key, l)), []byte(strings.ToLower(l.Sig)))
}
