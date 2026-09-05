package main

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"sync/atomic"

	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/stretchr/testify/assert"
)

func testBreakerCfg() breakerConfig {
	return breakerConfig{Threshold: 3, Cooldown: 5 * time.Minute}
}

// at is a fixed clock base, so every assertion below is about elapsed time
// rather than about when the test happened to run.
var at = time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)

func TestBreakerOpensOnlyAtThreshold(t *testing.T) {
	cfg := testBreakerCfg()
	s := hostState{}

	for i := 1; i < cfg.Threshold; i++ {
		var tripped bool
		s, tripped = afterFailure(s, at, cfg)
		assert.False(t, tripped, "failure %d must not open the circuit", i)
		assert.True(t, breakerAllows(s, at), "failure %d must still allow payments", i)
	}

	s, tripped := afterFailure(s, at, cfg)
	assert.True(t, tripped, "the threshold-th failure must open the circuit")
	assert.False(t, breakerAllows(s, at))
}

func TestBreakerClosesAfterCooldown(t *testing.T) {
	cfg := testBreakerCfg()
	s := hostState{}
	for i := 0; i < cfg.Threshold; i++ {
		s, _ = afterFailure(s, at, cfg)
	}

	assert.False(t, breakerAllows(s, at.Add(cfg.Cooldown-time.Second)), "still open one second early")
	assert.True(t, breakerAllows(s, at.Add(cfg.Cooldown)), "closed exactly at the cooldown")
	assert.True(t, breakerAllows(s, at.Add(2*cfg.Cooldown)))
}

// A target that stays dead must not re-open on every single attempt once the
// cooldown lapses -- it must earn another full Threshold first. Otherwise the
// trip counter becomes a per-payment counter and the metric stops meaning
// "an endpoint went down".
func TestBreakerRequiresFullThresholdToReopen(t *testing.T) {
	cfg := testBreakerCfg()
	s := hostState{}
	for i := 0; i < cfg.Threshold; i++ {
		s, _ = afterFailure(s, at, cfg)
	}

	later := at.Add(cfg.Cooldown)
	assert.True(t, breakerAllows(s, later))

	s, tripped := afterFailure(s, later, cfg)
	assert.False(t, tripped, "one failure after re-closing must not re-open")
	assert.True(t, breakerAllows(s, later))
}

// The reason the whole design is safe: a decline proves the host answered.
func TestBreakerSuccessResetsTheCount(t *testing.T) {
	cfg := testBreakerCfg()
	b := NewBreaker(cfg)
	b.now = func() time.Time { return at }

	b.RecordFailure("http|dead.example.com")
	b.RecordFailure("http|dead.example.com")
	b.RecordSuccess("http|dead.example.com")
	b.RecordFailure("http|dead.example.com")
	b.RecordFailure("http|dead.example.com")

	assert.True(t, b.Allow("http|dead.example.com"),
		"a success between failures must reset the run, not merely pause it")
}

func TestBreakerIsolatesTargets(t *testing.T) {
	cfg := testBreakerCfg()
	b := NewBreaker(cfg)
	b.now = func() time.Time { return at }

	for i := 0; i < cfg.Threshold; i++ {
		b.RecordFailure("http|dead.example.com")
	}

	assert.False(t, b.Allow("http|dead.example.com"))
	assert.True(t, b.Allow("http|healthy.example.com"), "one dead host must not stop another")
	assert.True(t, b.Allow("reloadly"), "one dead host must not stop another provider")
}

// transportFailed is the gate on everything above: get this wrong in the
// permissive direction and the breaker never fires; get it wrong in the strict
// direction and a run of declines stops paying people on a healthy provider.
func TestTransportFailedCountsOnlyUnreachableTargets(t *testing.T) {
	result := func(success bool, code string) *Result {
		r := &Result{Success: success}
		if code != "" {
			r.Error = &PaymentError{Code: code}
		}
		return r
	}

	assert.True(t, transportFailed(nil, errors.New("dial tcp: i/o timeout")),
		"a system fault with no verdict is a transport failure")
	assert.True(t, transportFailed(result(false, "HTTP_REQUEST_FAILED"), nil),
		"HTTP_REQUEST_FAILED is the http provider's transport error")

	assert.False(t, transportFailed(result(true, ""), nil), "a success is not a failure")
	assert.False(t, transportFailed(nil, nil), "no result and no error is not a transport failure")

	// Every one of these is the host working correctly and saying no. None of
	// them may open the circuit.
	for _, code := range []string{
		"INSUFFICIENT_BALANCE", "AUTH_ERROR", "IMPOSSIBLE_AMOUNT",
		"MISSING_SECRET", "BAD_HTTP_REQUEST", "400", "404", "500", "503",
	} {
		assert.False(t, transportFailed(result(false, code), nil),
			"a %s decline came FROM the host, so it must not count against reaching it", code)
	}
}

func TestHostFromURL(t *testing.T) {
	cases := map[string]string{
		"https://api.rewards.qafdev.com/v1/pay":        "api.rewards.qafdev.com",
		"https://API.Rewards.QafDev.com/v1/pay":        "api.rewards.qafdev.com",
		"http://api.example.com:8080/pay?x=1":          "api.example.com",
		"https://user:pw@api.example.com/pay":          "api.example.com",
		"https://api.example.com":                      "api.example.com",
		"https://api.example.com?api_key=<< secret >>": "api.example.com",
		// The case url.Parse would have failed on, collapsing every http
		// payment onto one shared breaker key.
		"https://api.example.com/pay?api_key=<< api_key >>&b=<< tok >>": "api.example.com",
		"": "",
	}
	for in, want := range cases {
		assert.Equal(t, want, hostFromURL(in), "hostFromURL(%q)", in)
	}
}

func TestBreakerKeyUsesTargetHostForHTTPAndProviderOtherwise(t *testing.T) {
	details := json.RawMessage(`{"url":"https://api.rewards.qafdev.com/v1/pay","method":"POST"}`)
	pe := &PaymentEvent{Provider: "http", Details: &details}

	assert.Equal(t, "http|api.rewards.qafdev.com", breakerKey(pe, &HttpProvider{}))

	// A provider with one fixed host keys on its name, which is the same
	// granularity.
	fake, err := NewFakeProvider(getUserFromFakePaymentEvent, auth)
	assert.Nil(t, err)
	assert.Equal(t, "fake", breakerKey(&PaymentEvent{Provider: "fake"}, fake))

	// Undecodable details must not error into a shared key silently -- they
	// fall back to the provider-wide breaker, which is safe but coarser.
	bad := json.RawMessage(`not json`)
	assert.Equal(t, "http", breakerKey(&PaymentEvent{Provider: "http", Details: &bad}, &HttpProvider{}))
}

func TestSplitBreakerKey(t *testing.T) {
	p, h := splitBreakerKey("http|api.example.com")
	assert.Equal(t, "http", p)
	assert.Equal(t, "api.example.com", h)

	p, h = splitBreakerKey("reloadly")
	assert.Equal(t, "reloadly", p)
	assert.Equal(t, "", h)
}

// The circuit-open verdict must be withheld, or the breaker becomes a payment
// outage: a sent Result fulfils the wait and dean stops re-driving.
func TestCircuitOpenResultIsWithheldAndRetryable(t *testing.T) {
	res := circuitOpenResult(&PaymentEvent{Provider: "http"})

	assert.Equal(t, "payment:http", res.Type)
	assert.False(t, res.Success)

	recovery, known := ClassifyResult(res)
	assert.True(t, known, "CIRCUIT_OPEN must be a known code, not an unclassified default")
	assert.Equal(t, RecoveryTransient, recovery)
	assert.True(t, recovery.Silent(), "a skipped payment must never reach the respondent")
}

// The two tests below use recovery_test.go's countingProvider, which counts
// Payout calls and echoes the Result embedded in the payment details. The count
// is the assertion that matters: the breaker's whole purpose is that the call
// does not happen.

// posterFunc adapts a function to Poster, so these tests can assert on what was
// SENT without standing up an httptest server. What is not sent is the point:
// a Result of any kind fulfils the wait and ends dean's ability to re-drive.
type posterFunc func(*SyntheticEvent) error

func (f posterFunc) Send(e *SyntheticEvent) error { return f(e) }

func breakerTestDC(t *testing.T, providers []string, attempts *int32, sent *int32) *DC {
	t.Helper()
	return &DC{
		cfg: &Config{
			Providers:     providers,
			RetryProvider: time.Millisecond,
		},
		poster: posterFunc(func(*SyntheticEvent) error {
			atomic.AddInt32(sent, 1)
			return nil
		}),
		breaker: NewBreaker(breakerConfig{Threshold: 3, Cooldown: 5 * time.Minute}),
		getProvider: func(*pgxpool.Pool, *PaymentEvent) (Provider, error) {
			return &countingProvider{attempts: attempts}, nil
		},
	}
}

// This is VIR-44 in miniature: an endpoint that never answers must stop costing
// us worker time, and the payments it would have consumed must be left parked
// for dean rather than failed.
func TestJobStopsCallingAnUnreachableTargetAndWithholdsInstead(t *testing.T) {
	var attempts, sent int32
	dc := breakerTestDC(t, []string{"http"}, &attempts, &sent)

	// Both keys live in one details block: HttpPaymentDetails reads `url` for
	// the breaker key, FakeDetails reads `result` for the verdict.
	details := json.RawMessage(`{
		"url": "https://api.rewards.qafdev.com/v1/pay",
		"result": {
			"type": "payment:http",
			"success": false,
			"error": {"code": "HTTP_REQUEST_FAILED", "message": "dial tcp: i/o timeout"}
		}
	}`)
	ts := JSTimestamp(at)
	pay := func() error {
		return dc.Job(&PaymentEvent{
			Userid: "u1", Pageid: "p1", Provider: "http",
			Timestamp: &ts, Details: &details,
		})
	}

	// Three failures to reach the host, then the circuit opens.
	for i := 0; i < 3; i++ {
		assert.Nil(t, pay(), "a withheld failure is not an error")
	}
	assert.Equal(t, int32(3), atomic.LoadInt32(&attempts))

	// Everything after that costs nothing at all.
	for i := 0; i < 20; i++ {
		assert.Nil(t, pay())
	}
	assert.Equal(t, int32(3), atomic.LoadInt32(&attempts),
		"payments to an open circuit must not reach the provider -- this is the stall VIR-44 describes")

	// And not one respondent was released from their wait, so dean can still
	// pay every one of them.
	assert.Equal(t, int32(0), atomic.LoadInt32(&sent),
		"a skipped payment must send nothing, or the wait is fulfilled and dean stops re-driving")
}

// A provider that is merely declining payments is healthy, and must keep being
// called. Getting this wrong would turn the breaker into the outage it exists
// to prevent -- an empty wallet is 34% of all recorded payment failures.
func TestJobKeepsCallingAProviderThatIsOnlyDeclining(t *testing.T) {
	var attempts, sent int32
	dc := breakerTestDC(t, []string{"fake"}, &attempts, &sent)

	details := json.RawMessage(`{
		"result": {
			"type": "payment:fake",
			"success": false,
			"error": {"code": "INSUFFICIENT_BALANCE", "message": "empty wallet"}
		}
	}`)
	ts := JSTimestamp(at)
	for i := 0; i < 10; i++ {
		assert.Nil(t, dc.Job(&PaymentEvent{
			Userid: "u1", Pageid: "p1", Provider: "fake",
			Timestamp: &ts, Details: &details,
		}))
	}

	assert.Equal(t, int32(10), atomic.LoadInt32(&attempts),
		"an empty wallet is the provider answering, not failing to answer: every payment must still be attempted")
}
