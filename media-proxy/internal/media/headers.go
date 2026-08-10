package media

import (
	"net/http"
	"strconv"
)

const (
	// CacheControl is a year, immutable. Safe because the URL is the identity:
	// an asset id addresses exactly one set of bytes forever (§5 -- there is no
	// update path for an asset, only new assets), so a cached response can
	// never be stale.
	CacheControl = "public, max-age=31536000, immutable"

	// ContentSecurityPolicy neutralises an uploaded HTML or SVG payload: even
	// served as text/html it can load nothing, run nothing and reach nothing.
	// Combined with media.vlab.digital being a separate origin from the
	// dashboard (§4.6), an uploaded document has no session to reach.
	ContentSecurityPolicy = "default-src 'none'"

	// DefaultContentType is used when the stored object carries no type. We do
	// NOT sniff -- guessing is exactly the behaviour nosniff exists to stop, and
	// application/octet-stream renders as nothing anywhere.
	DefaultContentType = "application/octet-stream"

	// DefaultContentDisposition applies when the object carries none. inline is
	// the useful default (images and video must render in a preview and in
	// Meta's fetchers), and it is safe here only because nosniff and the CSP
	// above already remove the payload class that would make it dangerous.
	// dashboard-server sets an explicit attachment disposition for file assets.
	DefaultContentDisposition = "inline"
)

// ResponseHeaders computes the complete header set for a successful response.
//
// Pure: an Object in, a header map out. No writer, no request, no clock. Every
// security header is unconditional, so there is no branch on which a response
// can leave without them -- and the test that asserts they are present on every
// response is a test of one function rather than of every path.
func ResponseHeaders(obj *Object) http.Header {
	contentType := obj.ContentType
	if contentType == "" {
		contentType = DefaultContentType
	}
	disposition := obj.ContentDisposition
	if disposition == "" {
		disposition = DefaultContentDisposition
	}

	h := http.Header{}
	h.Set("Content-Type", contentType)
	h.Set("Content-Disposition", disposition)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", ContentSecurityPolicy)
	h.Set("Cache-Control", CacheControl)

	if obj.ContentLength > 0 {
		h.Set("Content-Length", strconv.FormatInt(obj.ContentLength, 10))
	}
	if obj.ETag != "" {
		h.Set("ETag", obj.ETag)
	}
	if !obj.LastModified.IsZero() {
		h.Set("Last-Modified", obj.LastModified.UTC().Format(http.TimeFormat))
	}
	return h
}
