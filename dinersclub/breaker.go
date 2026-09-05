package main

import (
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// A circuit breaker over payment *targets*, so one unreachable endpoint cannot
// occupy the worker pool.
//
// WHAT THIS FIXES (VIR-44). On 2026-09-05 00:01-00:12 UTC dinersclub consumed
// nothing for 11 minutes. An endpoint belonging to one study was dropping SYNs,
// so every payment to it cost the full per-call deadline before failing, and
// with POOL_SIZE == BATCH_SIZE == 2 that is the entire throughput of the
// service. Payments for every other study queued behind a host that was never
// going to answer.
//
// Bounding the call (which the same change does, see http_provider.go) caps the
// cost of ONE such payment. It does not stop us paying that cost again for the
// next one, and the next -- the queue still drains at the speed of a dead host.
// The breaker is what makes the second and subsequent payments free.
//
// WHY THIS IS SAFE. A payment skipped by an open breaker is reported as
// CIRCUIT_OPEN, which classify.go maps to RecoveryTransient, which deliver()
// withholds. The respondent stays parked in WAIT_EXTERNAL_EVENT and dean's
// Payments sweep re-drives them for up to 14 days. So the breaker never costs
// anyone their payment; it only defers it to the layer built to outlast an
// outage. That is documentation/payment-recovery.md §2's rule -- "push each
// failure to the shortest layer that can outlast it" -- applied to the one
// failure that was still being handled in the longest.
//
// WHAT TRIPS IT: only a failure to REACH the target. A declined payment does
// not trip it and in fact resets it, because a decline is proof the host is
// alive and answering. See transportFailed.

// breakerConfig is the whole policy. Both values are deliberately generous:
// tripping late costs a bounded amount of throughput, and re-closing late costs
// only a deferral to dean.
type breakerConfig struct {
	Threshold int           // consecutive transport failures before opening
	Cooldown  time.Duration // how long the circuit stays open
}

// hostState is the breaker's memory for one target. The zero value is a healthy
// target that has never been seen, which is what makes the map safe to read
// with a plain index expression.
type hostState struct {
	consecutiveFailures int
	openUntil           time.Time
}

// ---------------------------------------------------------------------------
// Pure core. Every decision the breaker makes is one of these functions:
// no clock, no lock, no map. `now` is a parameter precisely so the tests can
// exercise a cooldown expiring without sleeping through it.
// ---------------------------------------------------------------------------

// breakerAllows reports whether a payment to this target may be attempted.
func breakerAllows(s hostState, now time.Time) bool {
	return !now.Before(s.openUntil)
}

// afterFailure advances state for one transport failure, and reports whether
// this failure is the one that opened the circuit.
//
// The counter resets on trip so that a target which stays dead re-trips after
// another full Threshold attempts once the cooldown lapses, rather than
// re-opening on every single attempt forever.
func afterFailure(s hostState, now time.Time, cfg breakerConfig) (hostState, bool) {
	s.consecutiveFailures++
	if s.consecutiveFailures >= cfg.Threshold {
		return hostState{consecutiveFailures: 0, openUntil: now.Add(cfg.Cooldown)}, true
	}
	return s, false
}

// transportFailed reports whether an attempt failed to REACH the target, as
// opposed to reaching it and being told no.
//
// The distinction is the whole design. A wallet with no money, a bad phone
// number, an operator refusal -- all of those are the remote host working
// correctly, and counting them would open the circuit on a healthy provider and
// stop paying people for a real reason. Only two things count:
//
//	err != nil     payout reached no verdict at all: every attempt was a
//	               system fault (a dial failure, a deadline, a nil response).
//	HTTP_REQUEST_FAILED
//	               http_provider.go's code for "client.Do returned an error",
//	               which it reports as a Result rather than an error.
func transportFailed(res *Result, err error) bool {
	if err != nil {
		return true
	}
	if res == nil || res.Success || res.Error == nil {
		return false
	}
	return res.Error.Code == "HTTP_REQUEST_FAILED"
}

// hostFromURL extracts the host from a payment URL for use as a breaker key.
//
// Deliberately not url.Parse: these URLs carry un-interpolated mustache
// templates ("?api_key=<< api_key >>") at the point we want the key, and a
// parse error there would silently collapse every http payment onto one shared
// breaker key. Manual extraction cannot fail, and a template in the host itself
// would simply produce its own key rather than an error.
func hostFromURL(raw string) string {
	s := raw
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	if i := strings.LastIndex(s, "@"); i >= 0 { // strip userinfo
		s = s[i+1:]
	}
	if i := strings.LastIndex(s, ":"); i >= 0 && !strings.Contains(s[i:], "]") {
		s = s[:i] // strip port, leaving bare IPv6 brackets alone
	}
	return strings.ToLower(s)
}

// TargetHost is implemented by providers whose endpoint varies per payment.
//
// Only the http provider needs it: reloadly, giftcard and dingconnect each talk
// to one fixed host for everyone, so the provider name alone is already the
// right key for them. A provider that does not implement this gets a
// provider-wide breaker, which for a single-host provider is the same thing.
type TargetHost interface {
	TargetHost(event *PaymentEvent) string
}

// TargetHost reports the host this payment will be sent to.
func (p *HttpProvider) TargetHost(event *PaymentEvent) string {
	if event == nil || event.Details == nil {
		return ""
	}
	order := new(HttpPaymentDetails)
	if err := json.Unmarshal(*event.Details, order); err != nil {
		return ""
	}
	return hostFromURL(order.Url)
}

// breakerKey names the target a payment is aimed at.
func breakerKey(pe *PaymentEvent, p Provider) string {
	provider := providerOf(pe)
	if th, ok := p.(TargetHost); ok {
		if host := th.TargetHost(pe); host != "" {
			return provider + "|" + host
		}
	}
	return provider
}

// splitBreakerKey recovers the {provider, host} labels for metrics.
func splitBreakerKey(key string) (string, string) {
	if provider, host, ok := strings.Cut(key, "|"); ok {
		return provider, host
	}
	return key, ""
}

// ---------------------------------------------------------------------------
// Imperative shell: a mutex, a map and a clock around the functions above.
// ---------------------------------------------------------------------------

// Breaker is safe for concurrent use by the worker pool.
//
// In-memory and per-process, which is sufficient because dinersclub runs at
// replicaCount 1 and the state it holds is a performance hint, not a
// correctness invariant: losing it on restart costs one extra round of
// Threshold slow failures, and nothing more.
type Breaker struct {
	mu     sync.Mutex
	cfg    breakerConfig
	states map[string]hostState
	now    func() time.Time
}

func NewBreaker(cfg breakerConfig) *Breaker {
	return &Breaker{cfg: cfg, states: map[string]hostState{}, now: time.Now}
}

// Allow reports whether a payment to this target may be attempted now.
func (b *Breaker) Allow(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return breakerAllows(b.states[key], b.now())
}

// RecordFailure files one transport failure, opening the circuit at Threshold.
func (b *Breaker) RecordFailure(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	next, tripped := afterFailure(b.states[key], b.now(), b.cfg)
	b.states[key] = next
	if tripped {
		recordBreakerTrip(key, b.cfg.Cooldown)
	}
}

// RecordSuccess clears the target. "Success" here means the host answered --
// including answering with a decline. Reaching it is the only thing measured.
//
// A delete rather than a zero-value write, so the map holds only targets that
// are currently failing instead of every host the service has ever paid.
func (b *Breaker) RecordSuccess(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.states, key)
}
