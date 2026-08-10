package media

import (
	"errors"
	"io"
	"net/http"

	"go.uber.org/zap"
)

// Handler is the imperative shell: it calls the pure functions above to decide
// everything, and then does the two impure things -- ask the store, copy bytes.
//
// It has no database and never will. Content-Type comes from object metadata
// precisely so that a slow CockroachDB cannot take the media read path down
// with it (planning/media-abstraction.md §4.4).
type Handler struct {
	Store  ObjectStore
	Prefix string
	Logger *zap.Logger
}

// NewHandler builds a Handler. A nil logger is replaced with a no-op so tests
// and callers never have to supply one.
func NewHandler(store ObjectStore, prefix string, logger *zap.Logger) *Handler {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Handler{Store: store, Prefix: prefix, Logger: logger}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Order matters. Method and path are both checked before the store is
	// touched, so a rejected request costs one regex and never becomes a
	// request to storage. The tests assert this by failing if the stub is
	// called at all.
	if !MethodAllowed(r.Method) {
		writeError(w, http.StatusNotFound)
		return
	}

	assetID, ok := ParseAssetID(r.URL.Path)
	if !ok {
		writeError(w, http.StatusNotFound)
		return
	}

	key := ObjectKeyFor(h.Prefix, assetID)

	if r.Method == http.MethodHead {
		obj, err := h.Store.Stat(r.Context(), key)
		if err != nil {
			h.writeStoreError(w, key, err)
			return
		}
		writeHeaders(w, ResponseHeaders(obj), http.StatusOK)
		return
	}

	obj, err := h.Store.Get(r.Context(), key)
	if err != nil {
		h.writeStoreError(w, key, err)
		return
	}
	defer obj.Body.Close()

	writeHeaders(w, ResponseHeaders(obj), http.StatusOK)

	// Stream. Never buffer a whole object -- assets run to video size and the
	// service runs at two replicas.
	if _, err := io.Copy(w, obj.Body); err != nil {
		// The status line and headers are already on the wire, so there is no
		// way to signal this to the client. Log it and let the truncated
		// response speak for itself.
		h.Logger.Warn("truncated media response",
			zap.String("key", key),
			zap.Error(err))
	}
}

// writeStoreError maps a store failure to a status.
//
// A missing object is a 404 and is not logged as an error: capability URLs get
// pasted into chats and crawled, so misses are ordinary traffic. Anything else
// is the storage backend failing, which is a 502 and is worth waking up for --
// §13 lists media-proxy being down as the one failure that makes handle-less
// media sends fail.
func (h *Handler) writeStoreError(w http.ResponseWriter, key string, err error) {
	if errors.Is(err, ErrNotFound) {
		writeError(w, http.StatusNotFound)
		return
	}
	h.Logger.Error("storage read failed",
		zap.String("key", key),
		zap.Error(err))
	writeError(w, http.StatusBadGateway)
}

// writeError emits a bodiless error response.
//
// Every rejection looks identical from outside: a bare 404 whether the method
// was wrong, the path was malformed, or the asset simply does not exist. That
// uniformity is the point -- see the 404-not-405 note in README.md.
func writeError(w http.ResponseWriter, status int) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", ContentSecurityPolicy)
	// Errors are never cached. A 404 served during a storage blip must not be
	// pinned into a CDN for a year alongside the immutable successes.
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", "0")
	w.WriteHeader(status)
}

func writeHeaders(w http.ResponseWriter, headers http.Header, status int) {
	dst := w.Header()
	for k, vs := range headers {
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
	w.WriteHeader(status)
}
