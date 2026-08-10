package media

import (
	"context"
	"errors"
	"io"
	"time"
)

// ErrNotFound is returned by an ObjectStore when the key does not exist.
//
// It is the store's job to translate its backend's not-found error into this
// one, so the handler never needs to know what backend it is talking to. That
// is the cloud-agnostic rule of planning/media-abstraction.md §4.1 expressed as
// a type: nothing above this line mentions S3.
var ErrNotFound = errors.New("object not found")

// Object is a stored object as the proxy needs it.
//
// ContentType and ContentDisposition come from object metadata written at
// PutObject time by dashboard-server. They are never sniffed at serve time and
// never taken from the client -- that is what makes the proxy safe to run with
// no database, and it is why an uploaded HTML file cannot talk its way into
// being served as text/html unless the uploader already decided so.
type Object struct {
	ContentType        string
	ContentDisposition string
	ContentLength      int64
	ETag               string
	LastModified       time.Time

	// Body is nil for a Stat (HEAD) result. When non-nil the caller owns it and
	// must Close it. It is streamed, never buffered.
	Body io.ReadCloser
}

// ObjectStore is the proxy's entire dependency on the outside world.
//
// One interface, two methods, no bucket in the signature and no S3 vocabulary.
// The handler depends on this and nothing else, which is what lets the whole
// security-critical suite run with a stub and no MinIO.
type ObjectStore interface {
	// Get returns the object with its Body open for streaming.
	Get(ctx context.Context, key string) (*Object, error)
	// Stat returns the object's metadata with no Body, for HEAD. HEAD must not
	// pull bytes out of storage only to throw them away.
	Stat(ctx context.Context, key string) (*Object, error)
}
