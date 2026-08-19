package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// paymentWait is the wait shape a payment question actually arms in production
// (see documentation/questions.md, "Payment - Reloadly"). Note `type` is
// "external" -- it is `value.type` that says this is a payment, which is the
// whole reason Dean cannot select payment waits by asking what a wait is NOT.
const paymentWait = `"wait": {"type": "external", "value": {"type": "payment:reloadly", "id": "payment_id"}}`

// paymentResultEvent is one payment RESULT as it lands in externalEvents,
// verbatim shape from prod. `ts` is epoch ms, the same unit as waitStart.
//
// This one carries no matching id, so it does NOT fulfill the wait and the
// respondent stays parked -- the real stuck-retry case the cap exists for
// (see the TODO on invalidProviderResult in dinersclub/main.go).
func paymentResultEvent(ts int64) string {
	return fmt.Sprintf(`{"source":"synthetic","timestamp":%v,"event":{"type":"external","value":{"type":"payment:reloadly","success":false,"error":{"code":"INVALID_PROVIDER"}}}}`, ts)
}

// paymentState builds a WAIT_EXTERNAL_EVENT row parked on a payment wait.
func paymentState(waitStartMs int64, externalEvents string) string {
	return fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "waitStart": %v,
                      "question": "q1",
                      "externalEvents": %v,
                      %v}`, waitStartMs, externalEvents, paymentWait)
}

func paymentCfg() *Config {
	return &Config{
		PaymentGrace:       "8 hours",
		PaymentInterval:    "2 days",
		PaymentMaxAttempts: 3,
	}
}

// TestGetPayments_RetriesDespitePriorUnrelatedEvents is the payments-side
// counterpart to TestGetTimeouts_MaturedTimeoutFiresDespitePriorVideoEvents.
//
// Before the fix, Payments gated on the TOTAL length of the shared,
// never-drained externalEvents log, so unrelated moviehouse video events
// falsely exhausted DEAN_PAYMENT_MAX_ATTEMPTS and the respondent silently
// stopped being retried -- biased hardest against respondents furthest through
// a survey, who have accumulated the most events.
func TestGetPayments_RetriesDespitePriorUnrelatedEvents(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	ts := time.Now().UTC().Add(-10 * time.Hour)
	ms := ts.Unix() * 1000

	// 5 moviehouse events (verbatim prod shape) accumulated during this wait.
	// Cap is 3, so under the old total-length gate these alone exhausted it.
	movies := fmt.Sprintf(`[
		{"source":"synthetic","timestamp":%[1]v,"event":{"type":"external","value":{"id":"1195793007","type":"moviehouse:play"}}},
		{"source":"synthetic","timestamp":%[1]v,"event":{"type":"external","value":{"id":"1195793007","type":"moviehouse:heartbeat"}}},
		{"source":"synthetic","timestamp":%[1]v,"event":{"type":"external","value":{"id":"1195793007","type":"moviehouse:heartbeat"}}},
		{"source":"synthetic","timestamp":%[1]v,"event":{"type":"external","value":{"id":"1195793007","type":"moviehouse:seeked"}}},
		{"source":"synthetic","timestamp":%[1]v,"event":{"type":"external","value":{"id":"1195793007","type":"moviehouse:pause"}}}
	]`, ms)

	mustExec(t, pool, insertQuery, "stuck", "bar", ts, "WAIT_EXTERNAL_EVENT", paymentState(ms, movies))
	mustExec(t, pool, insertQuery, "control", "bar", ts, "WAIT_EXTERNAL_EVENT", paymentState(ms, "[]"))

	fired := map[string]bool{}
	for _, e := range getEvents(Payments(paymentCfg(), pool)) {
		fired[e.User] = true
	}

	assert.True(t, fired["control"], "control user with no prior events must be retried")
	assert.True(t, fired["stuck"],
		"payment must still be retried even though prior moviehouse video events sit in "+
			"externalEvents -- they are not payment attempts and must not count")
}

// TestGetPayments_EarlierPaymentResultDoesNotCount pins the other half of the
// scoping. externalEvents is never drained, so a result for an EARLIER payment
// question in the same survey persists into this wait. It must not spend this
// wait's retry budget.
func TestGetPayments_EarlierPaymentResultDoesNotCount(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	ts := time.Now().UTC().Add(-10 * time.Hour)
	ms := ts.Unix() * 1000
	earlier := ms - (24 * 60 * 60 * 1000) // a day before this wait began

	priorResults := fmt.Sprintf(`[%[1]v, %[1]v, %[1]v]`, paymentResultEvent(earlier))

	mustExec(t, pool, insertQuery, "foo", "bar", ts, "WAIT_EXTERNAL_EVENT", paymentState(ms, priorResults))

	events := getEvents(Payments(paymentCfg(), pool))

	assert.Equal(t, 1, len(events),
		"payment results predating waitStart belong to an earlier question and must not "+
			"count against this wait's cap")
}

// TestGetPayments_CapStillStopsAfterMaxResultsForThisWait guards the original
// intent of the gate against the fix: Dean must still stop re-triggering a
// payment that keeps coming back unresolved.
func TestGetPayments_CapStillStopsAfterMaxResultsForThisWait(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	ts := time.Now().UTC().Add(-10 * time.Hour)
	ms := ts.Unix() * 1000

	// 3 unresolved payment results for THIS wait == PaymentMaxAttempts.
	exhausted := fmt.Sprintf(`[%[1]v, %[1]v, %[1]v]`, paymentResultEvent(ms))
	// 2 is still under the cap.
	under := fmt.Sprintf(`[%[1]v, %[1]v]`, paymentResultEvent(ms))

	mustExec(t, pool, insertQuery, "exhausted", "bar", ts, "WAIT_EXTERNAL_EVENT", paymentState(ms, exhausted))
	mustExec(t, pool, insertQuery, "under", "bar", ts, "WAIT_EXTERNAL_EVENT", paymentState(ms, under))

	fired := map[string]bool{}
	for _, e := range getEvents(Payments(paymentCfg(), pool)) {
		fired[e.User] = true
	}

	assert.True(t, fired["under"], "under the cap must still be retried")
	assert.False(t, fired["exhausted"],
		"retry cap must still stop firing after DEAN_PAYMENT_MAX_ATTEMPTS unresolved "+
			"payment results for this wait")
}

// TestGetPayments_SelectsOnlyPaymentWaits is the regression test for the second
// half of the bug: Payments used to select every wait that was not a timeout,
// so Dean fired repeat_payment at respondents parked on videos, link clicks and
// handovers (~521 live states when this was found). replybot then ran
// MAKE_PAYMENT against a question carrying no payment configuration.
func TestGetPayments_SelectsOnlyPaymentWaits(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	ts := time.Now().UTC().Add(-10 * time.Hour)
	ms := ts.Unix() * 1000

	state := func(wait string) string {
		return fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "waitStart": %v, "question": "q1", "externalEvents": [], %v}`, ms, wait)
	}

	// Every non-timeout wait shape that exists in production.
	cases := []struct {
		user string
		wait string
		want bool
	}{
		{"reloadly", `"wait": {"type": "external", "value": {"type": "payment:reloadly", "id": "p"}}`, true},
		{"http", `"wait": {"type": "external", "value": {"type": "payment:http", "id": "p"}}`, true},
		{"giftcard", `"wait": {"type": "external", "value": {"type": "payment:giftcard", "id": "p"}}`, true},
		{"moviehouse", `"wait": {"type": "external", "value": {"type": "moviehouse:play", "id": "v"}}`, false},
		{"linksniffer", `"wait": {"type": "external", "value": {"type": "linksniffer:click", "id": "l"}}`, false},
		{"handover", `"wait": {"type": "handover", "value": {}}`, false},
		{"timeout", `"wait": {"type": "timeout", "value": {"type": "relative", "timeout": "1 week"}}`, false},
		// Composite waits carry no wait->>'type'; excluded before and after.
		{"composite", `"wait": {"op": "or", "vars": [{"type": "external", "value": {"type": "payment:reloadly", "id": "p"}}]}`, false},
	}

	for _, c := range cases {
		mustExec(t, pool, insertQuery, c.user, "bar", ts, "WAIT_EXTERNAL_EVENT", state(c.wait))
	}

	fired := map[string]bool{}
	for _, e := range getEvents(Payments(paymentCfg(), pool)) {
		fired[e.User] = true
	}

	for _, c := range cases {
		assert.Equal(t, c.want, fired[c.user],
			"wait %q: expected fired=%v, got %v", c.user, c.want, fired[c.user])
	}
}
