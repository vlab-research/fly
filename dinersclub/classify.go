package main

// Recovery says whether a failed payment can still succeed, and what has to
// happen first. It is a fact about the failure -- nothing else. It does not say
// who retries, who gets alerted, or what state the respondent ends up in.
//
// The division of labour it respects:
//
//	dinersclub / replybot  move respondents into the correct state
//	dean                   re-drives anything still parked
//	study-health           interprets recorded state for alerting
//
// So there is deliberately no notion of "alert the platform owner" or "alert
// the survey creator" here. dinersclub's job is to record exactly what went
// wrong, in a taxonomy that maps onto the reality of payment failures. Deciding
// that an empty wallet concerns the researcher while an unrecognised code
// concerns us is a separate abstraction built on top of the recorded error, in
// devops/alerts/. Mixing the two would fork the taxonomy: dinersclub would
// start encoding an audience it cannot see.
//
// See planning/payment-failure-handling.md §0 for the decision this implements
// and planning/external-event-taxonomy.md for the long-term contract it
// anticipates.
type Recovery string

const (
	// RecoveryTransient: the same call, made again later, has a real chance
	// of succeeding with nobody doing anything. A provider 5xx, an operator
	// briefly down, a connection reset.
	RecoveryTransient Recovery = "transient"

	// RecoveryPrecondition: the call cannot succeed until a human changes
	// something OUTSIDE the respondent's control -- topping up a Reloadly
	// wallet, restoring credentials. It never self-heals, but it is fully
	// recoverable inside dean's 14-day runway, and the respondent has no
	// part to play in that recovery.
	RecoveryPrecondition Recovery = "precondition"

	// RecoveryPermanent: no retry will ever succeed as configured. A number
	// the operator refuses, an amount that cannot be sent, a malformed
	// payment block.
	RecoveryPermanent Recovery = "permanent"
)

// Silent reports whether dinersclub should withhold the failure Result.
//
// THIS IS THE WHOLE BEHAVIOURAL CONSEQUENCE OF THIS FILE, and it is a binary
// because the state machine only offers a binary. waiting.js matches a wait
// against an event with a SUBSET check over `type` + `id` (see
// planning/external-event-taxonomy.md §1), and `success` is not part of the
// wait condition -- so ANY Result fulfils the wait. Sending and releasing are
// the same act. Not sending is the only way to keep someone parked in
// WAIT_EXTERNAL_EVENT, which is the only way dean's Payments query can find
// them again.
//
// Transient and precondition therefore behave identically here. They are kept
// apart because they differ in what a human should do about them, which is what
// the metrics in metrics.go and the rules in devops/alerts/ read.
func (r Recovery) Silent() bool {
	return r != RecoveryPermanent
}

// recoveryByCode maps a provider error code to how it can recover.
//
// KEYED ON THE PROVIDER ERROR CODE, NEVER THE HTTP STATUS. Providers routinely
// return permanent failures with 5xx: DingConnect sends InsufficientBalance as
// an HTTP 500 (see TestDingConnectPayout_ErrorCodeMapping), and go-reloadly
// synthesises an APIError from ANY non-2xx. A "5xx means transient" rule would
// retry an empty wallet forever.
//
// One table across all providers rather than one per provider. The codes do not
// collide, and where two providers share a name they share a meaning --
// INSUFFICIENT_BALANCE is the same empty wallet whether Reloadly or DingConnect
// says so, and deserves the same answer.
//
// Every non-obvious row below was observed on production: 22,802 recorded
// failures against 48,772 successes over the life of the platform. The counts
// in comments are from that census (2026-08-18) and are NOT maintained -- they
// are here to show which rows carry weight. Codes with no count are documented
// by the provider but unobserved.
var recoveryByCode = map[string]Recovery{
	// ---- Transient -------------------------------------------------------
	// Briefly unable. Retried in-process first (see Job); if the budget runs
	// out the respondent stays parked and dean takes over.
	"TRANSACTION_CANNOT_BE_PROCESSED_AT_THE_MOMENT": RecoveryTransient, // 4562
	"OPERATOR_UNAVAILABLE_OR_CURRENTLY_INACTIVE":    RecoveryTransient, // 1530
	"RECIPIENT_HAS_PENDING_TRANSACTION":             RecoveryTransient, // 151
	"TRANSACTION_FAILED_ON_OPERATOR":                RecoveryTransient, // 116
	"PROVIDER_INTERNAL_ERROR":                       RecoveryTransient, // 89
	"REQUEST_FAILED_ON_PROVIDER":                    RecoveryTransient, // 64
	"CONNECTION_TO_OPERATOR_TEMPORARILY_DOWN":       RecoveryTransient, // 6
	"CONNECTION_TO_OPERATOR_FAILED":                 RecoveryTransient, // 4
	"REQUEST_PROCESSING_FAILED":                     RecoveryTransient, // 3

	// go-reloadly synthesises an APIError carrying the bare HTTP status for
	// any non-2xx it cannot decode, and http_provider.go uses the status as
	// its code by design. 5xx and 429 are the server telling us to come back.
	"500": RecoveryTransient, // 44
	"502": RecoveryTransient,
	"503": RecoveryTransient,
	"504": RecoveryTransient,
	"429": RecoveryTransient,

	// We never reached the provider, so we know nothing about the payment.
	"HTTP_REQUEST_FAILED":  RecoveryTransient,
	"PROVIDER_UNAVAILABLE": RecoveryTransient, // dingconnect: operator down
	"PROVIDER_TIMED_OUT":   RecoveryTransient, // dingconnect: operator slow

	// ---- Precondition ----------------------------------------------------
	// A human outside this system has to act, and once they do, everyone
	// still parked gets paid on dean's next sweep. Telling the respondent it
	// failed forecloses exactly that recovery, which is why these are the
	// codes the silent path exists for.

	// The researcher's Reloadly/DingConnect wallet is empty. 13 accounts
	// across 10 researchers on production -- their account, their top-up.
	// Largest single failure mode on the platform by a wide margin: 34% of
	// all payment failures.
	"INSUFFICIENT_BALANCE": RecoveryPrecondition, // 7687 reloadly + 834 giftcard

	// Credentials stopped working. Nothing the respondent can do; a
	// researcher re-authorising restores it and the parked payments land.
	"AUTH_ERROR": RecoveryPrecondition, // 219

	// ---- Permanent -------------------------------------------------------
	// Will never work as configured. Releasing beats a silent 14-day park on
	// a payment that can never land, and the surveys already handle this
	// path -- it is what every failure does today.

	// The respondent holds the fix: a different number, the right operator,
	// or simply knowing about a recharge window they can wait out.
	"PHONE_RECENTLY_RECHARGED":       RecoveryPermanent, // 3627
	"COULD_NOT_AUTO_DETECT_OPERATOR": RecoveryPermanent, // 812
	"OPERATOR_NOT_FOUND":             RecoveryPermanent, // 361
	"INVALID_RECIPIENT_PHONE":        RecoveryPermanent, // 275
	"PHONE_BANNED_BY_OPERATOR":       RecoveryPermanent, // 4
	"INVALID_PHONE_NUMBER":           RecoveryPermanent, // 1
	"RECIPIENT_PHONE_INACTIVE":       RecoveryPermanent, // 1
	"INVALID_ACCOUNT_NUMBER":         RecoveryPermanent, // dingconnect

	// The operator refused outright, or the recipient hit a limit. Permanent
	// for this number; a retry loop would never clear it.
	"TRANSACTION_REJECTED_BY_OPERATOR":   RecoveryPermanent, // 33
	"TRANSACTION_REFUSED_BY_OPERATOR":    RecoveryPermanent, // 2
	"RECIPIENT_REACHED_MAX_TOPUP_NUMBER": RecoveryPermanent, // 15

	// DingConnect's rate limit. PERMANENT, WHICH CONTRADICTS THE CLIENT
	// LIBRARY ON PURPOSE.
	//
	// (*dingconnect.Error).Retryable() returns true for RateLimited, reading it
	// as transport throttling. It is right about its own question ("could an
	// identical request succeed?") and wrong for ours ("should we send it
	// again?"): DingConnect returns this code both for genuine throttling AND
	// for a per-account-number fraud rule being breached, and the response does
	// not say which. Hammering a flagged number is the outcome we must never
	// risk, so the ambiguity resolves to "stop".
	//
	// THIS ROW IS HALF OF A GUARANTEE. The other half is cascadeDecide, which
	// never advances past RateLimited. Both halves are needed: DC.payout's
	// backoff.Retry re-invokes Payout wholesale, so classifying this transient
	// would replay the entire discovery cascade from the first candidate --
	// undoing the in-cascade stop one layer up. dinersclub never calls
	// Retryable(); worker retry runs off this table alone. See
	// planning/dingconnect-amount-resolution.md §8.
	"RateLimited": RecoveryPermanent,

	// The survey's payment configuration cannot pay this person. The amount
	// is still impossible on the next attempt.
	"IMPOSSIBLE_AMOUNT":                  RecoveryPermanent, // 271
	"INVALID_AMOUNT_FOR_RECIPIENT_PHONE": RecoveryPermanent, // 177
	"INVALID_AMOUNT":                     RecoveryPermanent, // 59
	"INVALID_AMOUNT_FOR_OPERATOR":        RecoveryPermanent, // 41
	"INVALID_INPUT_PROVIDED":             RecoveryPermanent, // 129
	"INVALID_SKU_CODE":                   RecoveryPermanent, // dingconnect

	// The DingConnect payment block declared an amount the catalogue can no
	// longer honour. All three are the researcher's to fix, and all three are
	// PERMANENT because a retry sends the same stale configuration -- parking
	// someone for dean's 14 days would hide the very drift these exist to make
	// loud. See planning/dingconnect-amount-resolution.md.
	"PIN_DRIFT":                RecoveryPermanent, // pinned sku gone, or out of window
	"AMOUNT_CURRENCY_MISMATCH": RecoveryPermanent, // product delivers a different currency
	"NO_PIN_FOR_OPERATOR":      RecoveryPermanent, // operator detected, not pinned

	// Malformed on our side of the wire. A retry sends the same bad bytes.
	"INVALID_PAYMENT_DETAILS":   RecoveryPermanent, // 20
	"JSON_SYNTAX_ERROR":         RecoveryPermanent, // 18
	"INVALID_JSON_FORMAT":       RecoveryPermanent,
	"INVALID_GIFT_CARD_DETAILS": RecoveryPermanent,
	"INVALID_PROVIDER":          RecoveryPermanent,
	"MISSING_SECRET":            RecoveryPermanent,
	"BAD_HTTP_REQUEST":          RecoveryPermanent,
	"INVALID_RESPONSE":          RecoveryPermanent, // dingconnect
	"400":                       RecoveryPermanent, // 47
	"404":                       RecoveryPermanent, // 2

	// The provider could not map its upstream's error either. Its own
	// catch-all, so we cannot claim to know better than it does -- but we
	// also cannot claim it is retryable. Permanent keeps today's behaviour
	// and the code stays visible in metrics; move it if the data says so.
	"UNMAPPED_PROVIDER_ERROR_CODE": RecoveryPermanent, // 47
	"PAYMENT_FAILED":               RecoveryPermanent, // dingconnect, no code

	// The fake provider's fixture code, used by the payment-failure flow in
	// facebot/testrunner (forms/gk3gt9ag.json). Pinned rather than left to
	// the unknown-code default so that integration test depends on an
	// explicit decision: if the default is ever flipped to transient, this
	// row is what keeps the test failing loudly on an assertion instead of
	// hanging until the harness times out.
	"FAKE": RecoveryPermanent,

	// Reloadly's dedup rejecting a duplicate submission. NOT REALLY A
	// FAILURE: on production, 1483 of the 2393 states carrying this code also
	// record success=true, so most of these respondents were in fact paid.
	// It is classified permanent, which preserves today's behaviour exactly
	// -- the honest fix is a stable, event-derived custom_identifier so the
	// duplicate is never sent, which is open work (see dinersclub/README.md,
	// "Payment-safety caveat"). Do not "fix" this by rewriting it to a
	// success: we cannot confirm the payment from this response.
	"CUSTOM_IDENTIFIER_ALREADY_USED": RecoveryPermanent, // 2385
	"DUPLICATE_REFERENCE":            RecoveryPermanent, // dingconnect equivalent
}

// Classify maps a provider error code to how it can recover. ok is false for a
// code that is not in the table.
//
// AN UNKNOWN CODE IS PERMANENT, i.e. it is sent, i.e. it behaves exactly as
// every failure behaves today. This is deliberate and is the conservative
// choice in both directions:
//
//   - Silence is the new behaviour, and new behaviour should apply only where
//     we can name the reason. Defaulting to silence would park respondents for
//     14 days on codes nobody has ever looked at.
//   - The mistake it can make is visible and cheap to correct: the code is
//     recorded by dinersclub_unclassified_error_codes_total, and adding a row
//     above is the fix.
//
// Note this reverses the "unrecognised -> transient" line in
// planning/payment-failure-handling.md §1, which was written before §0 settled
// on "everything not explicitly silenced behaves as it does today".
func Classify(code string) (Recovery, bool) {
	r, ok := recoveryByCode[code]
	if !ok {
		return RecoveryPermanent, false
	}
	return r, true
}

// ClassifyResult is Classify over a Result. A successful Result, or one with no
// error attached, is not a failure and has no recovery class -- callers must
// check Success before asking.
func ClassifyResult(res *Result) (Recovery, bool) {
	if res == nil || res.Error == nil {
		return RecoveryPermanent, false
	}
	return Classify(res.Error.Code)
}
