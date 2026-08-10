package media

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testUUID = "550e8400-e29b-41d4-a716-446655440000"

// stubStore stands in for MinIO. The suite that guards the security boundary
// must not need a storage backend to run -- if it did, it would be skipped in
// CI the first time a container was slow, and the boundary would go unguarded.
//
// It records every key it is asked for, which is what makes "rejected before
// reaching storage" an assertion rather than a claim.
type stubStore struct {
	getKeys  []string
	statKeys []string

	obj *Object
	err error
}

func (s *stubStore) calls() int { return len(s.getKeys) + len(s.statKeys) }

func (s *stubStore) Get(_ context.Context, key string) (*Object, error) {
	s.getKeys = append(s.getKeys, key)
	if s.err != nil {
		return nil, s.err
	}
	out := *s.obj
	out.Body = io.NopCloser(strings.NewReader(s.body()))
	return &out, nil
}

func (s *stubStore) Stat(_ context.Context, key string) (*Object, error) {
	s.statKeys = append(s.statKeys, key)
	if s.err != nil {
		return nil, s.err
	}
	out := *s.obj
	out.Body = nil
	return &out, nil
}

func (s *stubStore) body() string { return "PNGBYTES" }

func storeWithObject() *stubStore {
	return &stubStore{obj: &Object{
		ContentType:        "image/png",
		ContentDisposition: `inline; filename="welcome.png"`,
		ContentLength:      int64(len("PNGBYTES")),
		ETag:               `"d41d8cd98f00b204e9800998ecf8427e"`,
		LastModified:       time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC),
	}}
}

func serve(h *Handler, method, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://media.vlab.digital"+path, nil)
	// httptest.NewRequest parses the target, which for the malformed paths
	// below can normalise things. Pin the raw path so the handler is tested,
	// not net/url.
	req.URL.Path = pathOnly(path)
	req.URL.RawQuery = queryOnly(path)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func pathOnly(p string) string {
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		return p[:i]
	}
	return p
}

func queryOnly(p string) string {
	if i := strings.Index(p, "?"); i >= 0 {
		return p[i+1:]
	}
	return ""
}

// The happy path: a valid asset URL streams the object under the derived key.
func TestServesCanonicalAssetPath(t *testing.T) {
	store := storeWithObject()
	h := NewHandler(store, "a/", nil)

	rec := serve(h, http.MethodGet, "/a/"+testUUID+"/welcome.png")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != store.body() {
		t.Errorf("body = %q, want %q", got, store.body())
	}
	if len(store.getKeys) != 1 || store.getKeys[0] != "a/"+testUUID {
		t.Errorf("Get keys = %v, want [a/%s]", store.getKeys, testUUID)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q, want the STORED type image/png", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != `inline; filename="welcome.png"` {
		t.Errorf("Content-Disposition = %q, want the stored disposition", got)
	}
}

// The filename segment is cosmetic. This is the test that makes that provable
// rather than merely documented: many filenames, one object key.
func TestFilenameSegmentIsIgnored(t *testing.T) {
	paths := []string{
		"/a/" + testUUID,
		"/a/" + testUUID + "/",
		"/a/" + testUUID + "/welcome.png",
		"/a/" + testUUID + "/a-completely-different-name.pdf",
		"/a/" + testUUID + "/welcome.png?v=2",
		"/a/" + strings.ToUpper(testUUID) + "/welcome.png",
	}

	store := storeWithObject()
	h := NewHandler(store, "a/", nil)

	for _, p := range paths {
		if rec := serve(h, http.MethodGet, p); rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", p, rec.Code)
		}
	}

	if len(store.getKeys) != len(paths) {
		t.Fatalf("got %d Get calls, want %d", len(store.getKeys), len(paths))
	}
	for i, key := range store.getKeys {
		if key != "a/"+testUUID {
			t.Errorf("%s -> key %q, want a/%s", paths[i], key, testUUID)
		}
	}
}

// Everything the path contract rejects must 404 WITHOUT the store being
// touched. The assertion that matters here is store.calls() == 0: a 404 that
// was produced by asking MinIO and getting a miss would look identical from
// outside while being a completely different, and much worse, system.
func TestRejectedPathsNeverReachStorage(t *testing.T) {
	paths := []string{
		"/",
		"/health/../a/" + testUUID,
		"/a/" + testUUID + "/../../exports/respondents.csv",
		"/a/../exports/respondents.csv",
		"/../etc/passwd",
		"/exports/" + testUUID,                    // the other bucket's data
		"/media/a/" + testUUID,                    // bucket name smuggled into the path
		"/b/" + testUUID,                          // a different prefix
		"/" + testUUID,                            // no prefix
		"/a/" + testUUID + "/sub/file",            // extra depth
		"/a//" + testUUID,                         // empty prefix segment
		"/a/",                                     // no id
		"/a/not-a-uuid",                           // malformed id
		"/a/550e8400-e29b-41d4-a716",              // truncated id
		"/a/550e8400-e29b-41d4-a716-44665544zzzz", // non-hex id
		"/a/" + testUUID + testUUID,               // over-long id
		"/A/" + testUUID,                          // prefix case
		"/favicon.ico",
	}

	for _, p := range paths {
		t.Run(p, func(t *testing.T) {
			store := storeWithObject()
			h := NewHandler(store, "a/", nil)

			rec := serve(h, http.MethodGet, p)

			if rec.Code != http.StatusNotFound {
				t.Errorf("status = %d, want 404", rec.Code)
			}
			if store.calls() != 0 {
				t.Errorf("storage was reached %d times for a rejected path (get=%v stat=%v)",
					store.calls(), store.getKeys, store.statKeys)
			}
			if rec.Body.Len() != 0 {
				t.Errorf("body = %q, want empty", rec.Body.String())
			}
		})
	}
}

// GET and HEAD only. Rejected on the method, before the path is even parsed,
// so a write verb at a perfectly valid asset URL still never reaches storage.
//
// The status is 404, not 405 -- deliberately, and consistently. See README.md.
func TestNonReadMethodsRejectedBeforeStorage(t *testing.T) {
	methods := []string{
		http.MethodPost, http.MethodPut, http.MethodDelete,
		http.MethodPatch, http.MethodOptions, http.MethodTrace,
	}

	for _, m := range methods {
		t.Run(m, func(t *testing.T) {
			store := storeWithObject()
			h := NewHandler(store, "a/", nil)

			rec := serve(h, m, "/a/"+testUUID+"/welcome.png")

			if rec.Code != http.StatusNotFound {
				t.Errorf("status = %d, want 404", rec.Code)
			}
			if store.calls() != 0 {
				t.Errorf("storage was reached for a %s request", m)
			}
			// A 405 would carry Allow and would therefore confirm that this
			// exact asset exists. Nothing here may distinguish a real asset
			// from an invented one.
			if got := rec.Header().Get("Allow"); got != "" {
				t.Errorf("Allow = %q, want absent (it is an existence oracle)", got)
			}
		})
	}
}

// HEAD answers with headers and no body, and does it via Stat -- it must not
// pull an object's bytes out of storage only to discard them.
func TestHeadReturnsHeadersWithoutBody(t *testing.T) {
	store := storeWithObject()
	h := NewHandler(store, "a/", nil)

	rec := serve(h, http.MethodHead, "/a/"+testUUID+"/welcome.png")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("body = %q, want empty on HEAD", rec.Body.String())
	}
	if len(store.getKeys) != 0 {
		t.Errorf("HEAD fetched bytes: Get keys = %v", store.getKeys)
	}
	if len(store.statKeys) != 1 || store.statKeys[0] != "a/"+testUUID {
		t.Errorf("Stat keys = %v, want [a/%s]", store.statKeys, testUUID)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("nosniff missing on HEAD, got %q", got)
	}
}

// nosniff and the CSP appear on EVERY response, success or rejection. An
// uploaded HTML or SVG payload is neutralised by these two headers, so a path
// that could omit them is a hole.
func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
		store  *stubStore
	}{
		{"success", http.MethodGet, "/a/" + testUUID + "/x.png", storeWithObject()},
		{"head", http.MethodHead, "/a/" + testUUID, storeWithObject()},
		{"rejected path", http.MethodGet, "/etc/passwd", storeWithObject()},
		{"rejected method", http.MethodPost, "/a/" + testUUID, storeWithObject()},
		{"missing object", http.MethodGet, "/a/" + testUUID, &stubStore{err: ErrNotFound}},
		{"storage failure", http.MethodGet, "/a/" + testUUID, &stubStore{err: errors.New("connection refused")}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHandler(tc.store, "a/", nil)
			rec := serve(h, tc.method, tc.path)

			if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
				t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
			}
			if got := rec.Header().Get("Content-Security-Policy"); got != ContentSecurityPolicy {
				t.Errorf("Content-Security-Policy = %q, want %q", got, ContentSecurityPolicy)
			}
		})
	}
}

// A successful response is cacheable forever -- the URL is the identity, so it
// can never go stale. An error response is never cacheable, or a 404 served
// during a storage blip would be pinned for a year.
func TestCacheControl(t *testing.T) {
	h := NewHandler(storeWithObject(), "a/", nil)
	if got := serve(h, http.MethodGet, "/a/"+testUUID).Header().Get("Cache-Control"); got != CacheControl {
		t.Errorf("success Cache-Control = %q, want %q", got, CacheControl)
	}

	missing := NewHandler(&stubStore{err: ErrNotFound}, "a/", nil)
	if got := serve(missing, http.MethodGet, "/a/"+testUUID).Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("404 Cache-Control = %q, want no-store", got)
	}
}

// A missing object is ordinary traffic (capability URLs get crawled) and is a
// 404. A storage backend that is failing is a 502 -- a different thing, which
// must be distinguishable in metrics even though both are invisible to clients
// as anything but "no media".
func TestStoreErrorsMapToStatus(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{"not found", ErrNotFound, http.StatusNotFound},
		{"wrapped not found", errWrap{ErrNotFound}, http.StatusNotFound},
		{"backend failure", errors.New("connection refused"), http.StatusBadGateway},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := NewHandler(&stubStore{err: tt.err}, "a/", nil)
			for _, m := range []string{http.MethodGet, http.MethodHead} {
				if rec := serve(h, m, "/a/"+testUUID); rec.Code != tt.want {
					t.Errorf("%s: status = %d, want %d", m, rec.Code, tt.want)
				}
			}
		})
	}
}

type errWrap struct{ err error }

func (e errWrap) Error() string { return "wrapped: " + e.err.Error() }
func (e errWrap) Unwrap() error { return e.err }

// The content type on the wire is the one stored at upload, whatever it is --
// never sniffed from the bytes, never taken from the request. A stored
// text/html is served as text/html (and defanged by the CSP); it is not
// upgraded or downgraded here.
func TestContentTypeComesFromStoredMetadata(t *testing.T) {
	tests := []struct {
		stored, want string
	}{
		{"image/png", "image/png"},
		{"video/mp4", "video/mp4"},
		{"application/pdf", "application/pdf"},
		{"text/html", "text/html"},
		{"", DefaultContentType}, // never sniffed; octet-stream renders as nothing
	}

	for _, tt := range tests {
		t.Run(tt.stored, func(t *testing.T) {
			store := storeWithObject()
			store.obj.ContentType = tt.stored
			h := NewHandler(store, "a/", nil)

			// A request that tries to dictate the type must have no effect.
			req := httptest.NewRequest(http.MethodGet, "http://media.vlab.digital/a/"+testUUID, nil)
			req.Header.Set("Content-Type", "text/html")
			req.Header.Set("Accept", "text/html")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if got := rec.Header().Get("Content-Type"); got != tt.want {
				t.Errorf("Content-Type = %q, want %q", got, tt.want)
			}
		})
	}
}

// The prefix is configuration, but the invariant that the key is prefix+id and
// contains no filename is logic. Pin it.
func TestPrefixIsAppliedToTheKey(t *testing.T) {
	store := storeWithObject()
	h := NewHandler(store, "assets", nil) // no trailing slash

	serve(h, http.MethodGet, "/a/"+testUUID+"/welcome.png")

	if len(store.getKeys) != 1 || store.getKeys[0] != "assets/"+testUUID {
		t.Errorf("Get keys = %v, want [assets/%s]", store.getKeys, testUUID)
	}
}

func TestResponseHeaderDefaults(t *testing.T) {
	h := ResponseHeaders(&Object{})

	if got := h.Get("Content-Type"); got != DefaultContentType {
		t.Errorf("Content-Type = %q, want %q", got, DefaultContentType)
	}
	if got := h.Get("Content-Disposition"); got != DefaultContentDisposition {
		t.Errorf("Content-Disposition = %q, want %q", got, DefaultContentDisposition)
	}
	if got := h.Get("Content-Length"); got != "" {
		t.Errorf("Content-Length = %q, want absent for an unknown size", got)
	}
	if got := h.Get("ETag"); got != "" {
		t.Errorf("ETag = %q, want absent when the store gave none", got)
	}
	if got := h.Get("Last-Modified"); got != "" {
		t.Errorf("Last-Modified = %q, want absent when the store gave none", got)
	}
}

func TestResponseHeadersPassThroughValidators(t *testing.T) {
	h := ResponseHeaders(&Object{
		ContentLength: 42,
		ETag:          `"abc"`,
		LastModified:  time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC),
	})

	if got := h.Get("Content-Length"); got != "42" {
		t.Errorf("Content-Length = %q, want 42", got)
	}
	if got := h.Get("ETag"); got != `"abc"` {
		t.Errorf("ETag = %q, want quoted abc", got)
	}
	if got := h.Get("Last-Modified"); got != "Sun, 09 Aug 2026 12:00:00 GMT" {
		t.Errorf("Last-Modified = %q", got)
	}
}
