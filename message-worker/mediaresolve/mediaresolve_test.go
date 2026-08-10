package mediaresolve

import (
	"testing"
	"time"

	"github.com/vlab-research/fly/message-worker/types"
)

const assetURL = "https://media.vlab.digital/a/550e8400-e29b-41d4-a716-446655440000/welcome.png"

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func ptr(t time.Time) *time.Time { return &t }

// Resolve is the whole decision layer of the handle cache. The margin is the
// only real logic in it, which is why the clock is injected: expiry behaviour is
// asserted by passing a time, never by waiting.
func TestResolve(t *testing.T) {
	now := at("2026-08-09T12:00:00Z")
	const margin = time.Hour

	tests := []struct {
		name     string
		handle   *types.MediaHandle
		wantKind types.MediaSendKind
		wantID   string
	}{
		{
			name:     "no handle degrades to url",
			handle:   nil,
			wantKind: types.MediaByURL,
		},
		{
			// A row with a NULL platform_media_id records a known-dead handle.
			// It must not produce an empty id on the wire.
			name:     "known-dead handle degrades to url",
			handle:   &types.MediaHandle{PlatformMediaID: ""},
			wantKind: types.MediaByURL,
		},
		{
			// Messenger: no known expiry, so the handle is always usable.
			name:     "handle with no expiry sends by id",
			handle:   &types.MediaHandle{PlatformMediaID: "7227581437370475"},
			wantKind: types.MediaByID,
			wantID:   "7227581437370475",
		},
		{
			name:     "handle expiring far in the future sends by id",
			handle:   &types.MediaHandle{PlatformMediaID: "abc", ExpiresAt: ptr(at("2026-09-08T12:00:00Z"))},
			wantKind: types.MediaByID,
			wantID:   "abc",
		},
		{
			name:     "already expired handle degrades to url",
			handle:   &types.MediaHandle{PlatformMediaID: "abc", ExpiresAt: ptr(at("2026-08-09T11:00:00Z"))},
			wantKind: types.MediaByURL,
		},
		{
			// The reconciler has not reached this one yet. Degrade rather than
			// send an id that is about to stop working.
			name:     "handle inside the margin degrades to url",
			handle:   &types.MediaHandle{PlatformMediaID: "abc", ExpiresAt: ptr(at("2026-08-09T12:30:00Z"))},
			wantKind: types.MediaByURL,
		},
		{
			// Boundary: expires_at == now+margin. Falls to ByURL by design --
			// a URL send is always correct, so the conservative side is free.
			name:     "handle exactly at the margin boundary degrades to url",
			handle:   &types.MediaHandle{PlatformMediaID: "abc", ExpiresAt: ptr(at("2026-08-09T13:00:00Z"))},
			wantKind: types.MediaByURL,
		},
		{
			name:     "handle one second past the margin sends by id",
			handle:   &types.MediaHandle{PlatformMediaID: "abc", ExpiresAt: ptr(at("2026-08-09T13:00:01Z"))},
			wantKind: types.MediaByID,
			wantID:   "abc",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Resolve(now, assetURL, tt.handle, margin)

			if got.Kind != tt.wantKind {
				t.Fatalf("Kind = %v, want %v", got.Kind, tt.wantKind)
			}
			switch tt.wantKind {
			case types.MediaByURL:
				if got.URL != assetURL {
					t.Errorf("URL = %q, want %q", got.URL, assetURL)
				}
				if got.ID != "" {
					t.Errorf("ID = %q, want empty on a ByURL result", got.ID)
				}
			case types.MediaByID:
				if got.ID != tt.wantID {
					t.Errorf("ID = %q, want %q", got.ID, tt.wantID)
				}
				if got.URL != "" {
					t.Errorf("URL = %q, want empty on a ByID result", got.URL)
				}
			}
		})
	}
}

// A zero margin must still reject an already-expired handle -- the margin is a
// safety buffer, not the thing that makes expiry work.
func TestResolveZeroMargin(t *testing.T) {
	now := at("2026-08-09T12:00:00Z")

	expired := &types.MediaHandle{PlatformMediaID: "abc", ExpiresAt: ptr(at("2026-08-09T11:59:59Z"))}
	if got := Resolve(now, assetURL, expired, 0); got.Kind != types.MediaByURL {
		t.Errorf("expired handle with zero margin: Kind = %v, want ByURL", got.Kind)
	}

	live := &types.MediaHandle{PlatformMediaID: "abc", ExpiresAt: ptr(at("2026-08-09T12:00:01Z"))}
	if got := Resolve(now, assetURL, live, 0); got.Kind != types.MediaByID {
		t.Errorf("live handle with zero margin: Kind = %v, want ByID", got.Kind)
	}
}

func TestParseAssetID(t *testing.T) {
	const uuid = "550e8400-e29b-41d4-a716-446655440000"

	tests := []struct {
		name string
		url  string
		want string
		ok   bool
	}{
		{
			name: "canonical asset url with filename",
			url:  "https://media.vlab.digital/a/" + uuid + "/welcome.png",
			want: uuid, ok: true,
		},
		{
			name: "asset url without filename",
			url:  "https://media.vlab.digital/a/" + uuid,
			want: uuid, ok: true,
		},
		{
			name: "trailing slash",
			url:  "https://media.vlab.digital/a/" + uuid + "/",
			want: uuid, ok: true,
		},
		{
			// Host-independent by design: a production URL in a survey running
			// on staging must parse, miss the local lookup, and send the prod
			// URL -- which the prod proxy serves.
			name: "different host still parses",
			url:  "https://media.staging.vlab.digital/a/" + uuid + "/welcome.png",
			want: uuid, ok: true,
		},
		{
			name: "http scheme",
			url:  "http://localhost:8080/a/" + uuid,
			want: uuid, ok: true,
		},
		{
			name: "query string is ignored",
			url:  "https://media.vlab.digital/a/" + uuid + "/welcome.png?v=2",
			want: uuid, ok: true,
		},
		{
			name: "fragment is ignored",
			url:  "https://media.vlab.digital/a/" + uuid + "#top",
			want: uuid, ok: true,
		},
		{
			// The filename segment is cosmetic. Two URLs differing only there
			// must resolve to the same asset.
			name: "filename is ignored entirely",
			url:  "https://media.vlab.digital/a/" + uuid + "/anything-at-all.pdf",
			want: uuid, ok: true,
		},
		{
			name: "uppercase uuid normalises to lowercase",
			url:  "https://media.vlab.digital/a/550E8400-E29B-41D4-A716-446655440000",
			want: uuid, ok: true,
		},

		// --- rejections: these all fall through to a plain URL send ---
		{name: "third party url", url: "https://i.imgur.com/ZSHauqq.png"},
		{name: "third party url containing a-slash", url: "https://example.com/a/photo.png"},
		{name: "wrong prefix", url: "https://media.vlab.digital/b/" + uuid},
		{name: "no prefix", url: "https://media.vlab.digital/" + uuid},
		{name: "malformed uuid", url: "https://media.vlab.digital/a/not-a-uuid"},
		{name: "uuid missing a group", url: "https://media.vlab.digital/a/550e8400-e29b-41d4-a716"},
		{name: "uuid with non-hex characters", url: "https://media.vlab.digital/a/550e8400-e29b-41d4-a716-44665544zzzz"},
		{name: "extra path segments", url: "https://media.vlab.digital/a/" + uuid + "/a/b"},
		{name: "traversal attempt", url: "https://media.vlab.digital/a/" + uuid + "/../../etc/passwd"},
		{name: "prefix nested deeper", url: "https://media.vlab.digital/x/a/" + uuid},
		{name: "empty string", url: ""},
		{name: "host with no path", url: "https://media.vlab.digital"},
		{name: "not a url", url: "just some text"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ParseAssetID(tt.url)
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v (got id %q)", ok, tt.ok, got)
			}
			if got != tt.want {
				t.Errorf("id = %q, want %q", got, tt.want)
			}
		})
	}
}

// These strings are the label values on the by-URL counter, which is the health
// signal for the whole handle layer (a by-URL send for dashboard-uploaded media
// is an anomaly). Renaming one silently breaks the dashboard, so pin them.
func TestMediaSendKindString(t *testing.T) {
	if got := types.MediaByURL.String(); got != "by_url" {
		t.Errorf("types.MediaByURL.String() = %q, want %q", got, "by_url")
	}
	if got := types.MediaByID.String(); got != "by_id" {
		t.Errorf("types.MediaByID.String() = %q, want %q", got, "by_id")
	}
}

// A bare path, with no scheme or host, is the shape the media-proxy sees. The
// same parser must accept it so the two sides cannot drift.
func TestParseAssetIDBarePath(t *testing.T) {
	const uuid = "550e8400-e29b-41d4-a716-446655440000"

	if got, ok := ParseAssetID("/a/" + uuid + "/welcome.png"); !ok || got != uuid {
		t.Errorf("bare path: got %q, %v; want %q, true", got, ok, uuid)
	}
}
