package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestClassifyPinsEveryProductionCode pins the recovery class of every error
// code observed on production, with its observed frequency.
//
// This table is the contract, not a restatement of the map. A code moving
// between classes changes what a respondent is told and whether dean gets a
// chance to pay them, so it should never move as a side effect of editing
// classify.go -- it should move because someone decided it should, and had to
// come here and say so.
//
// Census taken 2026-08-18: 22,802 recorded failures against 48,772 successes,
// read from md.e_payment_<provider>_error_code across all states.
func TestClassifyPinsEveryProductionCode(t *testing.T) {
	cases := []struct {
		code     string
		n        int // observed on production; 0 = documented but unobserved
		expected Recovery
	}{
		// ---- transient: comes back on its own -------------------------
		{"TRANSACTION_CANNOT_BE_PROCESSED_AT_THE_MOMENT", 4562, RecoveryTransient},
		{"OPERATOR_UNAVAILABLE_OR_CURRENTLY_INACTIVE", 1530, RecoveryTransient},
		{"RECIPIENT_HAS_PENDING_TRANSACTION", 151, RecoveryTransient},
		{"TRANSACTION_FAILED_ON_OPERATOR", 116, RecoveryTransient},
		{"PROVIDER_INTERNAL_ERROR", 89, RecoveryTransient},
		{"REQUEST_FAILED_ON_PROVIDER", 64, RecoveryTransient},
		{"500", 44, RecoveryTransient},
		{"CONNECTION_TO_OPERATOR_TEMPORARILY_DOWN", 6, RecoveryTransient},
		{"CONNECTION_TO_OPERATOR_FAILED", 4, RecoveryTransient},
		{"REQUEST_PROCESSING_FAILED", 3, RecoveryTransient},
		{"502", 0, RecoveryTransient},
		{"503", 0, RecoveryTransient},
		{"504", 0, RecoveryTransient},
		{"429", 0, RecoveryTransient},
		{"HTTP_REQUEST_FAILED", 0, RecoveryTransient},
		{"PROVIDER_UNAVAILABLE", 0, RecoveryTransient},
		{"PROVIDER_TIMED_OUT", 0, RecoveryTransient},

		// ---- precondition: a human off-stage has to act ----------------
		// These two are the entire reason the silent path exists. If either
		// of them is ever reclassified as permanent, 8,700 respondents a
		// cycle go back to being told their payment failed when it was
		// simply waiting for a wallet top-up.
		{"INSUFFICIENT_BALANCE", 8521, RecoveryPrecondition}, // 7687 reloadly + 834 giftcard
		{"AUTH_ERROR", 219, RecoveryPrecondition},

		// ---- permanent: never going to work as configured --------------
		{"PHONE_RECENTLY_RECHARGED", 3627, RecoveryPermanent},
		{"CUSTOM_IDENTIFIER_ALREADY_USED", 2385, RecoveryPermanent},
		{"COULD_NOT_AUTO_DETECT_OPERATOR", 812, RecoveryPermanent},
		{"OPERATOR_NOT_FOUND", 361, RecoveryPermanent},
		{"INVALID_RECIPIENT_PHONE", 275, RecoveryPermanent},
		{"IMPOSSIBLE_AMOUNT", 271, RecoveryPermanent},
		{"INVALID_AMOUNT_FOR_RECIPIENT_PHONE", 177, RecoveryPermanent},
		{"INVALID_INPUT_PROVIDED", 129, RecoveryPermanent},
		{"INVALID_AMOUNT", 59, RecoveryPermanent},
		{"400", 47, RecoveryPermanent},
		{"UNMAPPED_PROVIDER_ERROR_CODE", 47, RecoveryPermanent},
		{"INVALID_AMOUNT_FOR_OPERATOR", 41, RecoveryPermanent},
		{"TRANSACTION_REJECTED_BY_OPERATOR", 33, RecoveryPermanent},
		{"INVALID_PAYMENT_DETAILS", 20, RecoveryPermanent},
		{"JSON_SYNTAX_ERROR", 18, RecoveryPermanent},
		{"RECIPIENT_REACHED_MAX_TOPUP_NUMBER", 15, RecoveryPermanent},
		{"PHONE_BANNED_BY_OPERATOR", 4, RecoveryPermanent},
		{"TRANSACTION_REFUSED_BY_OPERATOR", 2, RecoveryPermanent},
		{"404", 2, RecoveryPermanent},
		{"INVALID_PHONE_NUMBER", 1, RecoveryPermanent},
		{"RECIPIENT_PHONE_INACTIVE", 1, RecoveryPermanent},
		{"INVALID_JSON_FORMAT", 0, RecoveryPermanent},
		{"INVALID_GIFT_CARD_DETAILS", 0, RecoveryPermanent},
		{"INVALID_PROVIDER", 0, RecoveryPermanent},
		{"MISSING_SECRET", 0, RecoveryPermanent},
		{"BAD_HTTP_REQUEST", 0, RecoveryPermanent},
		{"INVALID_ACCOUNT_NUMBER", 0, RecoveryPermanent},
		{"INVALID_SKU_CODE", 0, RecoveryPermanent},
		{"INVALID_RESPONSE", 0, RecoveryPermanent},
		{"PAYMENT_FAILED", 0, RecoveryPermanent},
		{"DUPLICATE_REFERENCE", 0, RecoveryPermanent},
	}

	for _, c := range cases {
		t.Run(c.code, func(t *testing.T) {
			got, known := Classify(c.code)
			assert.True(t, known, "%s must be in recoveryByCode", c.code)
			assert.Equal(t, c.expected, got)
		})
	}

	// Nothing may be in the map that is not pinned above. Adding a code
	// without pinning it is how a class silently drifts.
	assert.Equal(t, len(cases), len(recoveryByCode),
		"every code in recoveryByCode must be pinned in this test")
}

// TestClassifyUnknownCodeIsPermanent pins the default, which is the single
// decision most likely to be changed by accident.
//
// Permanent means "sent", which means an unrecognised code behaves exactly as
// every failure behaved before classification existed. Flipping this default to
// transient would silently park respondents for dean's full 14 days on codes
// nobody has ever read.
func TestClassifyUnknownCodeIsPermanent(t *testing.T) {
	got, known := Classify("SOMETHING_RELOADLY_INVENTED_LAST_WEEK")
	assert.False(t, known)
	assert.Equal(t, RecoveryPermanent, got)
	assert.False(t, got.Silent(), "an unknown code must still reach the respondent")
}

// TestSilentIsTheOnlyBehaviouralAxis pins the mapping from recovery class to
// what dinersclub actually does, which is a binary because the state machine
// only offers a binary (waiting.js matches on type+id and ignores success, so
// sending IS releasing).
func TestSilentIsTheOnlyBehaviouralAxis(t *testing.T) {
	assert.True(t, RecoveryTransient.Silent())
	assert.True(t, RecoveryPrecondition.Silent())
	assert.False(t, RecoveryPermanent.Silent())
}

// TestClassifyResultIgnoresSuccessfulResults guards the nil paths. A Result
// with no Error is not a failure and has no recovery class -- callers must
// check Success before asking, and ClassifyResult must not pretend otherwise.
func TestClassifyResultIgnoresSuccessfulResults(t *testing.T) {
	_, known := ClassifyResult(nil)
	assert.False(t, known)

	_, known = ClassifyResult(&Result{Success: true})
	assert.False(t, known)

	got, known := ClassifyResult(&Result{
		Success: false,
		Error:   &PaymentError{Message: "no money", Code: "INSUFFICIENT_BALANCE"},
	})
	assert.True(t, known)
	assert.Equal(t, RecoveryPrecondition, got)
}

// TestInsufficientBalanceIsNeverSent is the regression test for the incident
// that started this work. It is deliberately separate from the table above:
// the table says what the class is, this says why anyone cares.
//
// An empty researcher wallet is the platform's largest single failure mode
// (34% of all payment failures). The respondent has no part in fixing it, and
// once the researcher tops up, dean's next sweep pays everyone still parked --
// which can only happen if they were never told the payment failed.
func TestInsufficientBalanceIsNeverSent(t *testing.T) {
	got, known := Classify("INSUFFICIENT_BALANCE")
	assert.True(t, known)
	assert.Equal(t, RecoveryPrecondition, got)
	assert.True(t, got.Silent())
}
