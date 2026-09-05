package main

import (
	"encoding/json"
	"errors"
	"io/ioutil"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dgraph-io/ristretto"
	"github.com/go-playground/validator/v10"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/stretchr/testify/assert"
)

func getDC(ts *httptest.Server) *DC {
	cfg := getConfig()
	pool := getPool(cfg)
	poster := NewHTTPPoster(ts.URL, 0)
	cache, _ := ristretto.NewCache(&ristretto.Config{
		NumCounters: cfg.CacheNumCounters,
		MaxCost:     cfg.CacheMaxCost,
		BufferItems: cfg.CacheBufferItems,
		Metrics:     true,
	})
	cache.Clear()
	return &DC{cfg, pool, poster, cache, getProvider, newTestBreaker(cfg)}
}

func TestDinersClub(t *testing.T) {
	count := 0

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := ioutil.ReadAll(r.Body)
		dat := strings.TrimSpace(string(data))

		// Parse the JSON to check the structure (field names matter, but order and exact formatting don't)
		var parsed map[string]interface{}
		err := json.Unmarshal([]byte(dat), &parsed)
		assert.Nil(t, err)

		// Check the full triple is present
		assert.NotNil(t, parsed["user"])
		assert.NotNil(t, parsed["account_id"])
		assert.NotNil(t, parsed["platform"])
		assert.NotNil(t, parsed["event"])

		// Check request headers
		assert.Equal(t, "dinersclub", r.Header.Get("X-Vlab-Poster"))
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))

		assert.Equal(t, "/", r.URL.Path)
		w.WriteHeader(200)
		count++
	}))

	msgs := makeMessages([]string{
		`{
			"userid": "foo",
			"pageid": "page",
			"timestamp": 1600558963867,
			"provider": "fake",
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
		`{
			"userid": "bar",
			"pageid": "page",
			"timestamp": 1600558963867,
			"provider": "fake",
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
	})

	err := getDC(ts).Process(msgs)
	assert.Nil(t, err)
}

func TestDinersClubErrorsOnMessagesWithMissingFields(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.FailNow(t, "should not call botserver")
	}))

	msgs := makeMessages([]string{
		`{
			"userid": "foo",
			"pageid": "page",
			"timestamp": 1600558963867,
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
	})

	err := getDC(ts).Process(msgs)
	assert.NotNil(t, err)

	// errors.As, not a bare type assertion. Process now collects every
	// message's failure and returns errors.Join, so the returned error is a
	// *errors.joinError wrapping this one -- and a bare assertion panics,
	// which in Go aborts the whole test binary and hides every test after it
	// (see README, "A panic in one test hides every later test"). The
	// contract being asserted is that the chain still carries the concrete
	// validator.ValidationErrors, and errors.As is how you say that.
	var e validator.ValidationErrors
	assert.True(t, errors.As(err, &e))
	assert.Contains(t, e.Error(), "Provider")
}

func TestDinersClubErrorsOnMalformedJSONMessages(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	msgs := makeMessages([]string{
		`{
			"userid": "foo",
			"pageid": "page",
			"timestamp"---> invalid-syntax <-----
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
	})

	err := getDC(ts).Process(msgs)
	assert.NotNil(t, err)

	// Process annotates the parse failure with the offending payload before
	// returning it, so the returned error is a wrapper -- a bare type
	// assertion cannot see through it. errors.As is the assertion that
	// actually expresses the contract: the error chain must still carry the
	// concrete *json.SyntaxError.
	var e *json.SyntaxError
	assert.True(t, errors.As(err, &e))
	assert.Contains(t, e.Error(), "invalid character")

	// The annotation Process adds must survive alongside the wrapped error --
	// this is what makes a malformed message diagnosable in production.
	assert.Contains(t, err.Error(), "Error parsing kakfa message")
}

func TestDinersClubErrorsOnNonExistentProvider(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := ioutil.ReadAll(r.Body)
		dat := strings.TrimSpace(string(data))
		assert.Contains(t, dat, `"code":"INVALID_PROVIDER"`)
		assert.Contains(t, dat, "baz")
		assert.Equal(t, "/", r.URL.Path)
		w.WriteHeader(200)
	}))

	msgs := makeMessages([]string{
		`{
			"userid": "foo",
			"pageid": "page",
			"provider": "baz",
			"timestamp": 1600558963867,
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
	})

	err := getDC(ts).Process(msgs)
	assert.Nil(t, err)
}

func TestDinersClubRepeatsOnServerErrorFromBotserver(t *testing.T) {
	count := 0

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count++

		assert.Equal(t, "/", r.URL.Path)
		w.WriteHeader(500)
	}))

	msgs := makeMessages([]string{
		`{
			"userid": "foo",
			"pageid": "page",
			"timestamp": 1600558963867,
			"provider": "fake",
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
	})

	err := getDC(ts).Process(msgs)
	assert.NotNil(t, err)
	assert.Contains(t, err.Error(), "Botserver")
	assert.Equal(t, 3, count)
}

func TestDinersClubErrorsWhenProviderNotListed(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := ioutil.ReadAll(r.Body)
		dat := strings.TrimSpace(string(data))
		assert.Contains(t, dat, `"code":"INVALID_PROVIDER"`)
		assert.Contains(t, dat, "fake")
		assert.Equal(t, "/", r.URL.Path)
		w.WriteHeader(200)
	}))

	msgs := makeMessages([]string{
		`{
			"userid": "foo",
			"pageid": "page",
			"timestamp": 1600558963867,
			"provider": "fake",
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
	})

	cfg := getConfig()
	cfg.Providers = []string{}
	pool := getPool(cfg)
	poster := NewHTTPPoster(ts.URL, 0)
	cache, _ := ristretto.NewCache(&ristretto.Config{
		NumCounters: cfg.CacheNumCounters,
		MaxCost:     cfg.CacheMaxCost,
		BufferItems: cfg.CacheBufferItems,
		Metrics:     true,
	})
	cache.Clear()
	dc := &DC{cfg, pool, poster, cache, getProvider, newTestBreaker(cfg)}
	err := dc.Process(msgs)
	assert.Nil(t, err)
}

func TestDinersClubErrorsOnMissingUser(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))

	msgs := makeMessages([]string{
		`{
			"userid": "foo",
			"pageid": "invalid-page",
			"timestamp": 1600558963867,
			"provider": "fake",
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
	})

	cfg := getConfig()
	pool := getPool(cfg)
	poster := NewHTTPPoster(ts.URL, 0)
	cache, _ := ristretto.NewCache(&ristretto.Config{
		NumCounters: cfg.CacheNumCounters,
		MaxCost:     cfg.CacheMaxCost,
		BufferItems: cfg.CacheBufferItems,
		Metrics:     true,
	})
	cache.Clear()
	getProvider := func(pool *pgxpool.Pool, event *PaymentEvent) (Provider, error) {
		getUser := func(event *PaymentEvent) (*User, error) {
			return nil, nil
		}
		return NewFakeProvider(getUser, auth)
	}
	dc := &DC{cfg, pool, poster, cache, getProvider, newTestBreaker(cfg)}
	err := dc.Process(msgs)
	assert.NotNil(t, err)
	assert.Equal(t, err.Error(), "User not found for page id: invalid-page")
}

func TestDinersClubCache(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))

	msgs := makeMessages([]string{
		`{
			"userid": "foo",
			"pageid": "page",
			"timestamp": 1600558963867,
			"provider": "fake",
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
		`{
			"userid": "bar",
			"pageid": "page",
			"timestamp": 1600558963867,
			"provider": "fake",
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
		`{
			"userid": "bar",
			"pageid": "page",
			"timestamp": 1600558963867,
			"provider": "fake",
			"details": {
				"result": {
					"type": "foo",
					"success": true
				}
			}
		}`,
	})

	dc := getDC(ts)
	dc.Process(msgs)

	assert.Equal(t, dc.cache.Metrics.Misses(), uint64(1))
	assert.Equal(t, dc.cache.Metrics.Hits(), uint64(2))
}

// TestDinersClubAuthError was here. It asserted that a failed provider Auth
// produced a respondent-facing AUTH_ERROR result, which is no longer true:
// AUTH_ERROR is a precondition, so the Result is withheld and the respondent
// waits for the researcher to restore the credential.
//
// It could not simply be inverted in place, because every one of its
// assertions lived inside the botserver handler -- once nothing was sent, the
// handler stopped running and the test passed without asserting anything at
// all. Its replacement counts requests instead: TestAuthFailureIsWithheld in
// recovery_test.go.

func TestDinersClubHandlesJSONUnmarshalErrorsGracefully(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := ioutil.ReadAll(r.Body)
		dat := strings.TrimSpace(string(data))

		// Verify that we get a proper payment error response
		assert.Contains(t, dat, `"code":"INVALID_JSON_FORMAT"`)
		assert.Contains(t, dat, `"success":false`)
		assert.Contains(t, dat, `"type":"payment:fake"`)
		assert.Contains(t, dat, "Invalid fake payment details format")

		assert.Equal(t, "/", r.URL.Path)
		w.WriteHeader(200)
	}))

	msgs := makeMessages([]string{
		`{
			"userid": "foo",
			"pageid": "page",
			"timestamp": 1600558963867,
			"provider": "fake",
			"details": {
				"result": {
					"type": "foo",
					"success": "this_should_be_boolean_not_string"
				}
			}
		}`,
	})

	err := getDC(ts).Process(msgs)
	assert.Nil(t, err)
}
