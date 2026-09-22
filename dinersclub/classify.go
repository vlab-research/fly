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
	// something OUTSIDE the respondent's control -- topping up a wallet,
	// restoring credentials, re-declaring a stale pin, fixing a malformed
	// payment block. It never self-heals, and the respondent has no part to
	// play in the recovery.
	RecoveryPrecondition Recovery = "precondition"

	// RecoveryRespondent: only the respondent can change the outcome, by
	// giving a different number. The operator does not know the number, the
	// line cannot take a top-up, the recipient hit a limit.
	RecoveryRespondent Recovery = "respondent"
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
// So a failure is sent only when being released is useful to the respondent:
// the form asks for another number and the same payment runs again. Every other
// failure is ours or the provider's, and telling the respondent about it asks
// them to fix something they cannot.
//
// Transient and precondition behave identically here. They are kept apart
// because they differ in what a human should do about them, which is what the
// metrics in metrics.go and the rules in devops/alerts/ read.
func (r Recovery) Silent() bool {
	return r != RecoveryRespondent
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
// DingConnect is the exception: its codes reach the table verbatim in
// PascalCase, so a SCREAMING_SNAKE row added "for DingConnect" matches nothing
// and the code silently takes the unknown-code default. Only PIN_DRIFT,
// AMOUNT_CURRENCY_MISMATCH, NO_PIN_FOR_OPERATOR, IMPOSSIBLE_AMOUNT,
// INVALID_PAYMENT_DETAILS, COULD_NOT_AUTO_DETECT_OPERATOR, INVALID_RESPONSE,
// HTTP_REQUEST_FAILED and PAYMENT_FAILED are ours to spell; check
// go-dingconnect/errors.go for the rest.

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

	// Transient against the library's own Retryable(), which excludes
	// ProviderError: observed retries of the identical request succeed. Safe
	// because these carry ProcessingState "Failed" with ReceiveValue 0, so no
	// money moved -- a DistributorRef does not deduplicate.
	"ProviderError":          RecoveryTransient, // dingconnect: operator failed the transfer
	"TransientProviderError": RecoveryTransient, // dingconnect: operator briefly unable

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

	// DingConnect's spellings of the two rows above.
	"InsufficientBalance":  RecoveryPrecondition,
	"AuthenticationFailed": RecoveryPrecondition,

	// Credentials stopped working. Nothing the respondent can do; a
	// researcher re-authorising restores it and the parked payments land.
	"AUTH_ERROR": RecoveryPrecondition, // 219

	// DingConnect's rate limit, which it returns both for genuine throttling
	// and for a per-account-number fraud rule, without saying which. Not
	// transient ON PURPOSE, against (*dingconnect.Error).Retryable():
	// DC.payout's backoff.Retry re-invokes Payout wholesale, so a transient
	// row would replay the whole discovery cascade from the first candidate
	// and undo cascadeDecide, which never advances past RateLimited. See
	// planning/dingconnect-amount-resolution.md §8.
	"RateLimited": RecoveryPrecondition,

	// The survey's payment configuration cannot pay this person, and a
	// different number would not change that.
	"IMPOSSIBLE_AMOUNT":                  RecoveryPrecondition, // 271
	"INVALID_AMOUNT_FOR_RECIPIENT_PHONE": RecoveryPrecondition, // 177
	"INVALID_AMOUNT":                     RecoveryPrecondition, // 59
	"INVALID_AMOUNT_FOR_OPERATOR":        RecoveryPrecondition, // 41
	"INVALID_INPUT_PROVIDED":             RecoveryPrecondition, // 129
	"INVALID_SKU_CODE":                   RecoveryPrecondition, // dingconnect

	// The DingConnect payment block declared an amount the catalogue can no
	// longer honour. The researcher's to fix; PaymentPinDrift is what makes
	// it loud. See planning/dingconnect-amount-resolution.md.
	"PIN_DRIFT":                RecoveryPrecondition, // pinned sku gone, or out of window
	"AMOUNT_CURRENCY_MISMATCH": RecoveryPrecondition, // product delivers a different currency
	"NO_PIN_FOR_OPERATOR":      RecoveryPrecondition, // operator detected, not pinned

	// Malformed on our side of the wire.
	"INVALID_PAYMENT_DETAILS":   RecoveryPrecondition, // 20
	"JSON_SYNTAX_ERROR":         RecoveryPrecondition, // 18
	"INVALID_JSON_FORMAT":       RecoveryPrecondition,
	"INVALID_GIFT_CARD_DETAILS": RecoveryPrecondition,
	"INVALID_PROVIDER":          RecoveryPrecondition,
	"MISSING_SECRET":            RecoveryPrecondition,
	"BAD_HTTP_REQUEST":          RecoveryPrecondition,
	"INVALID_RESPONSE":          RecoveryPrecondition, // dingconnect

	"ParameterInvalid": RecoveryPrecondition, // dingconnect
	"400":              RecoveryPrecondition, // 47
	"404":              RecoveryPrecondition, // 2

	// The provider could not map its upstream's error either, so nothing
	// says the respondent's number is at fault.
	"UNMAPPED_PROVIDER_ERROR_CODE": RecoveryPrecondition, // 47
	"PAYMENT_FAILED":               RecoveryPrecondition, // dingconnect, no code

	// ---- Respondent ------------------------------------------------------
	// A different number is the fix, and only the respondent has one.

	// A different number, the right operator, or simply knowing about a
	// recharge window they can wait out.
	"PHONE_RECENTLY_RECHARGED":       RecoveryRespondent, // 3627
	"COULD_NOT_AUTO_DETECT_OPERATOR": RecoveryRespondent, // 812
	"OPERATOR_NOT_FOUND":             RecoveryRespondent, // 361
	"INVALID_RECIPIENT_PHONE":        RecoveryRespondent, // 275
	"PHONE_BANNED_BY_OPERATOR":       RecoveryRespondent, // 4
	"INVALID_PHONE_NUMBER":           RecoveryRespondent, // 1
	"RECIPIENT_PHONE_INACTIVE":       RecoveryRespondent, // 1
	"INVALID_ACCOUNT_NUMBER":         RecoveryRespondent, // dingconnect

	"AccountNumberInvalid": RecoveryRespondent, // dingconnect

	// The operator refused this number outright, or the recipient hit a
	// limit. Another number can still be paid.
	"TRANSACTION_REJECTED_BY_OPERATOR":   RecoveryRespondent, // 33
	"TRANSACTION_REFUSED_BY_OPERATOR":    RecoveryRespondent, // 2
	"RECIPIENT_REACHED_MAX_TOPUP_NUMBER": RecoveryRespondent, // 15

	// The fake provider's fixture code, used by the payment-failure flow in
	// facebot/testrunner (forms/gk3gt9ag.json). Pinned rather than left to
	// the unknown-code default so that integration test depends on an
	// explicit decision: the unknown-code default withholds, and without this
	// row that test would hang until the harness times out instead of failing
	// on an assertion.
	"FAKE": RecoveryRespondent,

	// Reloadly's dedup rejecting a duplicate submission. NOT REALLY A
	// FAILURE: on production, 1483 of the 2393 states carrying this code also
	// record success=true, so most of these respondents were in fact paid.
	// SENT, THOUGH THE RESPONDENT CANNOT FIX IT. Withholding would park people
	// who were mostly paid, mid-survey, on a re-drive that can only draw the
	// same duplicate again. The honest fix is a stable, event-derived
	// custom_identifier so the duplicate is never sent, which is open work
	// (see dinersclub/README.md, "Payment-safety caveat"). Do not "fix" this
	// by rewriting it to a success: we cannot confirm the payment from this
	// response.
	"CUSTOM_IDENTIFIER_ALREADY_USED": RecoveryRespondent, // 2385
	"DUPLICATE_REFERENCE":            RecoveryRespondent, // dingconnect equivalent

	"DuplicateTransactionPrevented": RecoveryRespondent, // dingconnect
}

// Classify maps a provider error code to how it can recover. ok is false for a
// code that is not in the table.
//
// AN UNKNOWN CODE IS A PRECONDITION, i.e. it is withheld. A code nobody has
// looked at says nothing about the respondent's number, so asking them for
// another one is a guess made in their chat. Withheld, the cost of being wrong
// is a respondent parked until someone reads PaymentUnclassifiedErrorCode and
// adds the row; sent, it is a respondent told to fix something they may not be
// able to.
func Classify(code string) (Recovery, bool) {
	r, ok := recoveryByCode[code]
	if !ok {
		return RecoveryPrecondition, false
	}
	return r, true
}

// ClassifyResult is Classify over a Result. A successful Result, or one with no
// error attached, is not a failure and has no recovery class -- callers must
// check Success before asking.
func ClassifyResult(res *Result) (Recovery, bool) {
	if res == nil || res.Error == nil {
		return RecoveryPrecondition, false
	}
	return Classify(res.Error.Code)
}
