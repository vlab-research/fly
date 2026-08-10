// Package media is the media-proxy's core: the path contract, the response
// headers, and a thin handler over an ObjectStore.
//
// Everything in path.go and headers.go is PURE -- no network, no storage, no
// clock, no environment. That is deliberate: the path contract is the security
// boundary of the whole read path (planning/media-abstraction.md §4.4, §10), so
// it must be exhaustively testable without a MinIO anywhere in sight.
package media

import (
	"regexp"
	"strings"
)

// assetPath is the ONLY path shape this service serves: /a/<uuid>, optionally
// followed by a single cosmetic filename segment.
//
// It is character-for-character the regex in message-worker's mediaresolve
// package. The two are deliberately duplicated rather than shared: the worker
// module and this module are built and shipped independently (each Dockerfile
// copies only its own directory), so an import would couple two deploy units
// for one line of regex. The parity is instead pinned by tests -- see the
// shared table in path_test.go, which is copied from mediaresolve_test.go.
//
// Properties this expresses, each of which is load-bearing:
//
//   - Exactly one prefix, "a/", is reachable. No other object in the bucket can
//     be addressed through this service, whatever else lives beside it.
//   - The uuid is matched as a fixed 8-4-4-4-12 hex shape, so the segment that
//     becomes part of an object key cannot contain "..", "/", or any other
//     character with meaning to a storage backend. Traversal is impossible by
//     construction rather than by escaping.
//   - The filename segment is matched but NOT captured. It is cosmetic: two
//     URLs differing only in filename address the same object. That is what
//     lets a researcher rename a file without touching storage.
var assetPath = regexp.MustCompile(
	`^/a/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:/[^/]*)?/?$`,
)

// ParseAssetID extracts an asset UUID from a request path, reporting whether
// the path is one we serve.
//
// It accepts a bare path (what an HTTP handler sees) as well as a full URL, so
// it takes exactly the same inputs as mediaresolve.ParseAssetID and cannot
// drift from it. Anything it rejects must never reach storage.
func ParseAssetID(rawURL string) (string, bool) {
	// Cheap reject before any allocation: every asset path contains this.
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
	// Normalise: gen_random_uuid() emits lowercase, so the stored key is
	// lowercase. An uppercase URL must not address a different object.
	return strings.ToLower(m[1]), true
}

// ObjectKeyFor derives the storage key for an asset id.
//
// The key is prefix + uuid and nothing else -- no filename, no user id, no
// date. Because the id has already been validated by ParseAssetID as pure hex
// and dashes, the result cannot escape the prefix.
func ObjectKeyFor(prefix, assetID string) string {
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix + assetID
}

// MethodAllowed reports whether a request method may be served at all.
//
// GET and HEAD only. This is a read path; nothing else has a meaning here, and
// rejecting on the method before the path is parsed means a POST never reaches
// storage even at a valid asset URL.
func MethodAllowed(method string) bool {
	return method == "GET" || method == "HEAD"
}
