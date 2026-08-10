package media

import (
	"errors"
	"net/http"
	"testing"

	"github.com/minio/minio-go/v7"
)

// Not configuration -- a parser. Getting this wrong makes the service talk
// plaintext to an https endpoint, which fails at connect time in staging but
// would be a silently unencrypted credential in any setup that tolerates it.
func TestParseEndpoint(t *testing.T) {
	tests := []struct {
		in         string
		wantHost   string
		wantSecure bool
		wantErr    bool
	}{
		{in: "https://storage-api.vlab.digital", wantHost: "storage-api.vlab.digital", wantSecure: true},
		{in: "http://minio:9000", wantHost: "minio:9000"},
		{in: "minio:9000", wantHost: "minio:9000"},         // bare host:port, as in-cluster
		{in: "localhost:9000", wantHost: "localhost:9000"}, // dev
		{in: "https://storage-api.vlab.digital/", wantHost: "storage-api.vlab.digital", wantSecure: true},
		{in: "", wantErr: true},
		{in: "https://", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			host, secure, err := parseEndpoint(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseEndpoint(%q) = %q, %v, nil; want an error", tt.in, host, secure)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseEndpoint(%q): %v", tt.in, err)
			}
			if host != tt.wantHost || secure != tt.wantSecure {
				t.Errorf("parseEndpoint(%q) = %q, %v; want %q, %v",
					tt.in, host, secure, tt.wantHost, tt.wantSecure)
			}
		})
	}
}

// An unquoted entity-tag is invalid and caches may ignore it, which would quietly
// undo the whole point of the immutable Cache-Control.
func TestQuoteETag(t *testing.T) {
	tests := []struct{ in, want string }{
		{"d41d8cd98f00b204e9800998ecf8427e", `"d41d8cd98f00b204e9800998ecf8427e"`},
		{`"already-quoted"`, `"already-quoted"`},
		{`W/"weak"`, `W/"weak"`},
		{"", ""},
	}
	for _, tt := range tests {
		if got := quoteETag(tt.in); got != tt.want {
			t.Errorf("quoteETag(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// A miss must arrive at the handler as ErrNotFound (404), and anything else as
// itself (502). Collapsing the two would make a dead MinIO look like a bucket
// full of missing assets -- a quiet outage instead of a loud one.
func TestTranslateError(t *testing.T) {
	notFound := []string{"NoSuchKey", "NoSuchBucket", "NotFound"}
	for _, code := range notFound {
		err := minio.ErrorResponse{Code: code, StatusCode: http.StatusNotFound}
		if got := translateError(err); !errors.Is(got, ErrNotFound) {
			t.Errorf("translateError(%s) = %v, want ErrNotFound", code, got)
		}
	}

	passthrough := []error{
		errors.New("connection refused"),
		minio.ErrorResponse{Code: "AccessDenied", StatusCode: http.StatusForbidden},
		minio.ErrorResponse{Code: "InternalError", StatusCode: http.StatusInternalServerError},
	}
	for _, err := range passthrough {
		if got := translateError(err); errors.Is(got, ErrNotFound) {
			t.Errorf("translateError(%v) collapsed to ErrNotFound", err)
		}
	}
}
