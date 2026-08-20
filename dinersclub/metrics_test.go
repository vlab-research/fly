package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/stretchr/testify/assert"
)

// The alert rules in devops/alerts/templates/payment-health.yaml select on
// exact metric and label names. A rename here is a silently dead alert there --
// and these particular alerts guard failures that write nothing anywhere else,
// so a dead one is not a gap in a dashboard, it is an empty wallet draining
// dean's 14-day window unnoticed. This test scrapes the real handler and pins
// the strings both sides agree on.
func TestMetricsExposeWhatTheAlertsSelectOn(t *testing.T) {
	pe := &PaymentEvent{Provider: "reloadly"}

	recordResult(pe, &Result{Success: true})
	recordResult(pe, &Result{
		Success: false,
		Error:   &PaymentError{Message: "no money", Code: "INSUFFICIENT_BALANCE"},
	})
	recordResult(pe, &Result{
		Success: false,
		Error:   &PaymentError{Message: "who knows", Code: "A_BRAND_NEW_CODE"},
	})
	recordFault("payout")

	ts := httptest.NewServer(promhttp.Handler())
	defer ts.Close()

	res, err := http.Get(ts.URL)
	assert.Nil(t, err)
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	assert.Nil(t, err)
	page := string(body)

	// PaymentWalletEmpty selects exactly this series.
	assert.Contains(t, page,
		`dinersclub_payment_results_total{code="INSUFFICIENT_BALANCE",outcome="failure",provider="reloadly",recovery="precondition"} 1`)

	// A success carries no recovery class and no code.
	assert.Contains(t, page,
		`dinersclub_payment_results_total{code="",outcome="success",provider="reloadly",recovery=""} 1`)

	// An unknown code is counted as permanent under a fixed `unclassified`
	// label, so one unrecognised provider code cannot grow the label space of
	// the main counter. The real code goes to its own counter, which is what
	// PaymentUnclassifiedErrorCode reads.
	assert.Contains(t, page,
		`dinersclub_payment_results_total{code="unclassified",outcome="failure",provider="reloadly",recovery="permanent"} 1`)
	assert.Contains(t, page,
		`dinersclub_unclassified_error_codes_total{code="A_BRAND_NEW_CODE",provider="reloadly"} 1`)
	assert.NotContains(t, page,
		`dinersclub_payment_results_total{code="A_BRAND_NEW_CODE"`)

	// DinersClubProcessingFaults.
	assert.Contains(t, page, `dinersclub_processing_faults_total{stage="payout"} 1`)

	// DinersClubMetricsMissing keys on dinersclub_up, NOT on the payment
	// counter, and this is the assertion that says why: a CounterVec with no
	// observations exports no series at all. At this platform's traffic an
	// hour with no payments is ordinary, so absent() on the payment counter
	// would page for quiet rather than for a broken scrape.
	assert.Contains(t, page, "dinersclub_up 1")
}

// serveMetrics must publish dinersclub_up before anything is observed --
// that is the whole point of it.
func TestUpIsPublishedBeforeAnyPayment(t *testing.T) {
	ts := httptest.NewServer(promhttp.Handler())
	defer ts.Close()

	res, err := http.Get(ts.URL)
	assert.Nil(t, err)
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	assert.Contains(t, string(body), "dinersclub_up")
}

// A payment event with no provider must still be attributable. An empty label
// value would silently merge unrelated series in every `by (provider)` alert.
func TestProviderLabelIsNeverEmpty(t *testing.T) {
	assert.Equal(t, "unknown", providerOf(nil))
	assert.Equal(t, "unknown", providerOf(&PaymentEvent{}))
	assert.Equal(t, "giftcard", providerOf(&PaymentEvent{Provider: "giftcard"}))
}
