package main

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics for dinersclub.
//
// WHY THIS FILE EXISTS AT ALL. Since classify.go landed, a transient or
// precondition failure sends no event, so it leaves NO trace in the
// respondent's state -- the tracking that `md.e_payment_<provider>_error_code`
// used to provide disappears for exactly the failures we most want to watch.
// That trade is only acceptable because it is instrumented here. Deleting or
// disabling these counters does not merely lose observability, it makes the
// silent path unaccountable. See planning/payment-failure-handling.md §0.2.
//
// dinersclub is the FIRST application service in this repo to expose /metrics
// (devops/alerts/values.yaml said so in the mediaHandles block, and this is
// what changes it). There is therefore no in-repo Go precedent to copy; the
// scrape wiring is dinersclub/chart/templates/{service,servicemonitor}.yaml.
//
// The cross-check on all of it lives outside this process: a respondent parked
// on a `payment:*` wait, ageing, is visible in state to sql_exporter whether or
// not any counter here moved.

const (
	outcomeSuccess = "success"
	outcomeFailure = "failure"

	// codeUnclassified stands in for a provider error code that Classify does
	// not know, so that an unrecognised code cannot grow the label space of
	// the main counter without bound. The real code is recorded by
	// unclassifiedErrorCodes below, which is the one metric here whose
	// cardinality is not closed -- drop it first if a provider ever starts
	// emitting free-form codes.
	codeUnclassified = "unclassified"
)

var (
	// paymentResults is the ledger: every payment attempt that reached a
	// verdict lands here exactly once, whether or not a Result was sent.
	//
	// For a success, recovery and code are empty. For a failure, recovery is
	// the class from classify.go and code is the provider's error code (or
	// codeUnclassified). `recovery != "permanent"` is precisely the set of
	// failures the respondent was NOT told about.
	paymentResults = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "dinersclub_payment_results_total",
		Help: "Payment attempts by provider, outcome, recovery class and provider error code.",
	}, []string{"provider", "outcome", "recovery", "code"})

	// unclassifiedErrorCodes records codes missing from recoveryByCode. Every
	// increment here is a row that should be added to that table: until it
	// is, the code defaults to permanent and the respondent is told the
	// payment failed, which may or may not be true.
	unclassifiedErrorCodes = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "dinersclub_unclassified_error_codes_total",
		Help: "Provider error codes that classify.go does not recognise. Each one is a missing row in recoveryByCode.",
	}, []string{"provider", "code"})

	// paymentDuration measures the whole payout step for one message --
	// including in-process retries, since what matters for the Kafka poll
	// interval is how long the message occupied a worker, not how long one
	// HTTP call took.
	//
	// The buckets are chosen against DINERSCLUB_PROVIDER_TIMEOUT and
	// DINERSCLUB_RETRY_PROVIDER, not against a generic latency scale: the
	// question these answer is "are we anywhere near the budget", and the top
	// bucket is deliberately above the budget so a breach is visible rather
	// than clipped into +Inf.
	paymentDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "dinersclub_payment_duration_seconds",
		Help:    "Wall time spent in the payout step for one payment, including in-process retries.",
		Buckets: []float64{0.5, 1, 2.5, 5, 10, 15, 30, 45, 60, 90, 120},
	}, []string{"provider", "outcome"})

	// up is 1 for as long as the process is alive and scrapable.
	//
	// IT EXISTS BECAUSE A CounterVec WITH NO OBSERVATIONS EXPORTS NOTHING. A
	// healthy dinersclub that has simply had no payments to make publishes no
	// dinersclub_payment_results_total series at all -- which is the normal
	// state at this traffic (~8 active users/hr platform-wide). Alerting on
	// the absence of that counter would therefore page for quiet, not for
	// broken.
	//
	// This gauge is unconditional, so absent(dinersclub_up) means exactly one
	// thing: nobody is scraping dinersclub. That is what
	// DinersClubMetricsMissing needs to know, because every payment alert
	// reads this endpoint and the failures they watch write no state anywhere
	// else -- a scrape that stops does not make those alerts loud, it makes
	// them impossible.
	// A GaugeFunc rather than a Gauge someone has to remember to Set: there is
	// no state to hold and no code path that should ever be able to publish a
	// different answer. If the handler can respond, the process is alive.
	up = promauto.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "dinersclub_up",
		Help: "1 while dinersclub is running. Exists so the absence of a scrape is distinguishable from the absence of payments.",
	}, func() float64 { return 1 })

	// pinDrift counts DingConnect payments rejected because a pinned SKU no
	// longer matches the intent the survey declared.
	//
	// This is the counter behind the alert, and the design assumes it almost
	// never fires: SKUs and commission rates move a few times a year, which is
	// why a hard failure on drift is affordable. If it starts firing regularly
	// the assumption was wrong, and the answer is on_drift: "resolve" (deferred
	// out of v1), not a wider tolerance.
	pinDrift = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "dinersclub_dingconnect_pin_drift_total",
		Help: "DingConnect payments failed because a pinned sku_code no longer satisfies the declared amount. Each one needs the pin re-researched.",
	}, []string{"reason"})

	// deliveredOutOfWindow counts transfers that COMPLETED but delivered an
	// amount outside the declared window.
	//
	// The realised TransferRecord price is the only thing that knows what
	// actually landed, so this is the sole true detector of the failure the
	// declared-intent design exists to prevent: a commission rate moving so the
	// transfer succeeds while paying the respondent the wrong incentive. It
	// cannot fail the payment -- the money has already moved -- so it is a
	// counter and a loud log, and it should be zero.
	deliveredOutOfWindow = promauto.NewCounter(prometheus.CounterOpts{
		Name: "dinersclub_dingconnect_delivered_out_of_window_total",
		Help: "Completed DingConnect transfers whose realised delivered amount differed from what the catalogue predicted.",
	})

	// breakerTrips counts circuit openings: one increment is one target we
	// stopped calling. Paired with breakerSkips below, which counts the
	// payments that opening then deferred to dean.
	//
	// These are the accountability for the breaker in exactly the way
	// paymentResults is the accountability for a withheld failure -- a skipped
	// payment writes nothing to the respondent's state either. A rising
	// breakerSkips with a flat breakerTrips is one endpoint down for a long
	// time; the reverse is a flapping one.
	breakerTrips = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "dinersclub_circuit_breaker_trips_total",
		Help: "Circuit breaker openings by payment target. Each one is an endpoint we stopped calling after consecutive transport failures.",
	}, []string{"provider", "host"})

	breakerSkips = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "dinersclub_circuit_breaker_skips_total",
		Help: "Payments not attempted because the target's circuit was open. Each one is withheld and left for dean to re-drive.",
	}, []string{"provider", "host"})

	// processingFaults counts failures that are ours rather than a payment's:
	// a malformed Kafka message, a database that will not answer, a botserver
	// that never accepted the Result.
	//
	// Before this existed every one of these called log.Fatalf, so the metric
	// was "the pod restarted" and a poison message was an unbounded crash
	// loop (2026-08-17). The counter is the replacement signal, and it is the
	// thing to alert on if dinersclub ever goes quiet for a bad reason.
	processingFaults = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "dinersclub_processing_faults_total",
		Help: "Faults in dinersclub itself, by stage. Not payment failures -- see dinersclub_payment_results_total for those.",
	}, []string{"stage"})
)

// providerOf names the provider for a metric label. It reads the PaymentEvent
// rather than Result.Type so that a fault before any Result exists is still
// attributed, and so an unset provider is never an empty label.
func providerOf(pe *PaymentEvent) string {
	if pe == nil || pe.Provider == "" {
		return "unknown"
	}
	return pe.Provider
}

// recordResult files one finished payment attempt.
func recordResult(pe *PaymentEvent, res *Result) {
	provider := providerOf(pe)

	if res != nil && res.Success {
		paymentResults.WithLabelValues(provider, outcomeSuccess, "", "").Inc()
		return
	}

	recovery, known := ClassifyResult(res)
	code := codeUnclassified
	if res != nil && res.Error != nil && known {
		code = res.Error.Code
	}
	if !known && res != nil && res.Error != nil {
		unclassifiedErrorCodes.WithLabelValues(provider, res.Error.Code).Inc()
	}
	paymentResults.WithLabelValues(provider, outcomeFailure, string(recovery), code).Inc()
}

// _ keeps the always-on gauge referenced at package scope.
var _ = up

// recordPinDrift files a DingConnect pin that no longer satisfies its intent.
func recordPinDrift(reason string) {
	pinDrift.WithLabelValues(reason).Inc()
}

// recordDeliveredOutOfWindow files a completed transfer that paid the wrong amount.
func recordDeliveredOutOfWindow() {
	deliveredOutOfWindow.Inc()
}

// recordFault files a fault in dinersclub itself.
func recordFault(stage string) {
	processingFaults.WithLabelValues(stage).Inc()
}

// observePayout records how long the payout step took.
func observePayout(pe *PaymentEvent, res *Result, d time.Duration) {
	outcome := outcomeFailure
	if res != nil && res.Success {
		outcome = outcomeSuccess
	}
	paymentDuration.WithLabelValues(providerOf(pe), outcome).Observe(d.Seconds())
}

// serveMetrics exposes /metrics.
//
// Failures here are logged and swallowed rather than fatal: losing metrics is
// bad, and losing payments because the metrics port was taken would be worse.
// Run it in a goroutine.
func serveMetrics(port int) {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())

	addr := fmt.Sprintf(":%d", port)
	log.Printf("DinersClub serving metrics on %s/metrics", addr)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Printf("DinersClub metrics server stopped: %v", err)
	}
}

// recordBreakerTrip files one circuit opening.
func recordBreakerTrip(key string, cooldown time.Duration) {
	provider, host := splitBreakerKey(key)
	breakerTrips.WithLabelValues(provider, host).Inc()
	log.Printf("DinersClub opened the circuit for %s (host %q) for %s: consecutive failures to reach it. Payments to this target are withheld and left for dean until it closes.",
		provider, host, cooldown)
}

// recordBreakerSkip files one payment deferred by an open circuit.
func recordBreakerSkip(key string) {
	provider, host := splitBreakerKey(key)
	breakerSkips.WithLabelValues(provider, host).Inc()
}
