package media

import "testing"

// This table is copied from message-worker's mediaresolve_test.go on purpose.
//
// The worker decides "is this URL one of ours?" and the proxy decides "is this
// path one I serve?". If those two answers ever differ, a survey gets a URL the
// worker treats as an asset and the proxy refuses, or worse the reverse. The
// regexes are duplicated across module boundaries (see path.go), so this shared
// table is the thing that keeps them honest -- any change to one side must be
// made here too, and the diff is visible in review.
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
			name: "filename is ignored entirely",
			url:  "https://media.vlab.digital/a/" + uuid + "/anything-at-all.pdf",
			want: uuid, ok: true,
		},
		{
			name: "uppercase uuid normalises to lowercase",
			url:  "https://media.vlab.digital/a/550E8400-E29B-41D4-A716-446655440000",
			want: uuid, ok: true,
		},

		// --- rejections ---
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

// The proxy always sees a bare path, never a full URL. These are the shapes
// that actually arrive on the wire, including the ones an attacker sends.
func TestParseAssetIDBarePath(t *testing.T) {
	const uuid = "550e8400-e29b-41d4-a716-446655440000"

	accepted := []string{
		"/a/" + uuid,
		"/a/" + uuid + "/",
		"/a/" + uuid + "/welcome.png",
		"/a/" + uuid + "/a file with spaces.png",
		"/a/" + uuid + "?download=1",
	}
	for _, path := range accepted {
		t.Run("accept "+path, func(t *testing.T) {
			if got, ok := ParseAssetID(path); !ok || got != uuid {
				t.Errorf("ParseAssetID(%q) = %q, %v; want %q, true", path, got, ok, uuid)
			}
		})
	}

	rejected := []string{
		"/",
		"",
		"/health",
		"/a/",
		"/a",
		"/a//" + uuid,
		"/A/" + uuid,                       // the prefix is not case-insensitive
		"/exports/" + uuid,                 // the other bucket's prefix
		"/a/" + uuid + "/../../exports/x",  // traversal out of the prefix
		"/a/../" + uuid,                    // traversal in the id position
		"/a/" + uuid + "/sub/dir/file.png", // extra depth
		"/a/" + uuid + uuid,                // id longer than the shape
		"/a/" + uuid[:len(uuid)-1],         // id shorter than the shape
		"/a/" + uuid + "%2F..%2Fexports",   // pre-decoding escape attempt
		"/media/a/" + uuid,                 // bucket name smuggled into the path
		"//a/" + uuid,                      // protocol-relative style
		"/a/00000000-0000-0000-0000-00000000000g", // non-hex
	}
	for _, path := range rejected {
		t.Run("reject "+path, func(t *testing.T) {
			if got, ok := ParseAssetID(path); ok {
				t.Errorf("ParseAssetID(%q) = %q, true; want rejected", path, got)
			}
		})
	}
}

// The key is the prefix and the id, and nothing else. In particular the
// filename never appears in it -- that is what makes a rename free.
func TestObjectKeyFor(t *testing.T) {
	const uuid = "550e8400-e29b-41d4-a716-446655440000"

	tests := []struct {
		name, prefix, want string
	}{
		{"canonical prefix", "a/", "a/" + uuid},
		{"prefix without slash is normalised", "a", "a/" + uuid},
		{"empty prefix", "", uuid},
		{"nested prefix", "media/a/", "media/a/" + uuid},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ObjectKeyFor(tt.prefix, uuid); got != tt.want {
				t.Errorf("ObjectKeyFor(%q, uuid) = %q, want %q", tt.prefix, got, tt.want)
			}
		})
	}
}

func TestMethodAllowed(t *testing.T) {
	allowed := []string{"GET", "HEAD"}
	for _, m := range allowed {
		if !MethodAllowed(m) {
			t.Errorf("MethodAllowed(%q) = false, want true", m)
		}
	}
	rejected := []string{
		"POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT",
		"get", "head", // case matters; net/http does not normalise methods
		"", "GETX",
	}
	for _, m := range rejected {
		if MethodAllowed(m) {
			t.Errorf("MethodAllowed(%q) = true, want false", m)
		}
	}
}
