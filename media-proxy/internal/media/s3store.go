package media

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Store is the only file in this service that names a storage protocol.
//
// Cloud-agnostic by construction (planning/media-abstraction.md §4.1): the S3
// API and nothing else. No AWS SDK, no GCP SDK, no cloud identity system.
// minio-go is used because it is first-party for MinIO and speaks plain S3, so
// pointing MEDIA at any other S3-compatible endpoint is an env change.
type S3Store struct {
	client *minio.Client
	bucket string
}

// S3Config is the connection detail, all of it from the environment (§4.7).
type S3Config struct {
	Endpoint        string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
}

// NewS3Store dials the endpoint.
//
// The credential here is a MinIO service account scoped to read the media
// bucket only (§4.3). It is deliberately not the root credential and must not
// be able to reach the exports bucket, which holds respondent data.
func NewS3Store(cfg S3Config) (*S3Store, error) {
	endpoint, secure, err := parseEndpoint(cfg.Endpoint)
	if err != nil {
		return nil, err
	}

	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
		Secure: secure,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("s3 client: %w", err)
	}

	return &S3Store{client: client, bucket: cfg.Bucket}, nil
}

// parseEndpoint splits an S3_ENDPOINT into host:port plus a TLS flag.
//
// A bare "minio:9000" is accepted as plaintext, matching how the exporter and
// the in-cluster service address are configured; an https:// URL turns TLS on.
func parseEndpoint(endpoint string) (host string, secure bool, err error) {
	if endpoint == "" {
		return "", false, fmt.Errorf("S3_ENDPOINT is required")
	}
	if !strings.Contains(endpoint, "://") {
		return endpoint, false, nil
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", false, fmt.Errorf("S3_ENDPOINT %q: %w", endpoint, err)
	}
	if u.Host == "" {
		return "", false, fmt.Errorf("S3_ENDPOINT %q has no host", endpoint)
	}
	return u.Host, u.Scheme == "https", nil
}

// Get opens the object for streaming. minio-go's Object is a lazy reader: this
// call does not pull bytes, io.Copy in the handler does.
func (s *S3Store) Get(ctx context.Context, key string) (*Object, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, translateError(err)
	}
	// GetObject defers the request, so a missing key surfaces here rather than
	// above. Stat first, then hand back the still-unread reader.
	info, err := obj.Stat()
	if err != nil {
		obj.Close()
		return nil, translateError(err)
	}
	out := objectFromInfo(info)
	out.Body = obj
	return out, nil
}

// Stat fetches metadata only, for HEAD.
func (s *S3Store) Stat(ctx context.Context, key string) (*Object, error) {
	info, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return nil, translateError(err)
	}
	return objectFromInfo(info), nil
}

func objectFromInfo(info minio.ObjectInfo) *Object {
	return &Object{
		// Both come from metadata written at PutObject by dashboard-server.
		// Nothing here inspects the bytes.
		ContentType:        info.ContentType,
		ContentDisposition: info.Metadata.Get("Content-Disposition"),
		ContentLength:      info.Size,
		ETag:               quoteETag(info.ETag),
		LastModified:       info.LastModified,
	}
}

// quoteETag restores the quotes minio-go strips. An unquoted ETag is not a
// valid entity-tag and caches are entitled to ignore it.
func quoteETag(etag string) string {
	if etag == "" || strings.HasPrefix(etag, `"`) || strings.HasPrefix(etag, `W/`) {
		return etag
	}
	return `"` + etag + `"`
}

// translateError maps S3 vocabulary to this package's one error, so nothing
// above s3store.go has to know what a NoSuchKey is.
func translateError(err error) error {
	switch minio.ToErrorResponse(err).Code {
	case "NoSuchKey", "NoSuchBucket", "NotFound":
		return ErrNotFound
	}
	return err
}
