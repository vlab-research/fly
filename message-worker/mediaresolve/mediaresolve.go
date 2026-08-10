// Package mediaresolve decides how a media message should be sent: by a
// cached platform media id, or by the asset's public URL.
//
// It is the functional core of the media handle layer -- pure, clock-injected,
// no IO. The impure lookup lives in mediastore; the worker resolves once and
// passes the resulting Sendable into the (already pure) translators.
//
// The invariant this package exists to preserve: a handle is always an
// optimisation, never a requirement. Every path that cannot produce a usable id
// degrades to ByURL rather than failing, so the handle layer can fail entirely
// and messages still send.
package mediaresolve

import (
	"regexp"
	"strings"
	"time"

	"github.com/vlab-research/fly/message-worker/types"
)

// Resolve decides how to send an asset.
//
// url is the asset's public URL and is always required -- it is the fallback
// that makes every other branch safe.
//
// A handle is used only when it exists, carries an id, and is not within margin
// of expiring. The margin absorbs clock skew between us and the platform, and
// covers the window where a handle has expired but the reconciler has not yet
// replaced it: such a handle degrades to a URL send instead of a failed message.
func Resolve(now time.Time, url string, h *types.MediaHandle, margin time.Duration) types.MediaSendable {
	byURL := types.MediaSendable{Kind: types.MediaByURL, URL: url}

	if h == nil || h.PlatformMediaID == "" {
		return byURL
	}
	// Treat "expires at or before now+margin" as already expired. The boundary
	// falls to ByURL deliberately: sending by URL is always correct, so the
	// conservative side of an off-by-one costs nothing.
	if h.ExpiresAt != nil && !h.ExpiresAt.After(now.Add(margin)) {
		return byURL
	}
	return types.MediaSendable{Kind: types.MediaByID, ID: h.PlatformMediaID}
}

// assetPath matches the one path shape we serve: /a/<uuid>, optionally followed
// by a single cosmetic filename segment. The filename is ignored -- the object
// key is a/<uuid> -- so it can change without touching storage.
var assetPath = regexp.MustCompile(
	`^/a/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:/[^/]*)?/?$`,
)

// ParseAssetID extracts an asset UUID from a media URL, reporting whether the
// URL is one of ours.
//
// Matching is deliberately HOST-INDEPENDENT: only the path shape is inspected.
// A production media URL pasted into a survey that then runs on staging parses
// fine, finds no asset row in staging's database, misses, and sends by the
// production URL -- which the production proxy serves. Pinning the host would
// turn that into a broken image.
//
// A third-party URL simply fails to match and is sent as-is, with no lookup.
func ParseAssetID(rawURL string) (string, bool) {
	// Cheap reject before any allocation: every asset URL contains this.
	if !strings.Contains(rawURL, "/a/") {
		return "", false
	}

	path := rawURL
	// Strip scheme://host without a full URL parse -- we only care about the
	// path, and url.Parse would accept shapes the regex rejects anyway.
	if i := strings.Index(path, "://"); i >= 0 {
		rest := path[i+3:]
		slash := strings.Index(rest, "/")
		if slash < 0 {
			return "", false
		}
		path = rest[slash:]
	}
	// Drop query and fragment; neither participates in identity.
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}

	m := assetPath.FindStringSubmatch(path)
	if m == nil {
		return "", false
	}
	// Normalise: gen_random_uuid() emits lowercase, so the column is lowercase.
	return strings.ToLower(m[1]), true
}
