package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	dingconnect "github.com/vlab-research/go-dingconnect"
)

// Tests for the DingConnect ADAPTER.
//
// Amount resolution, pin verification and the advance/stop cascade are the
// library's behaviour and are tested exhaustively in
// go-dingconnect/payment_test.go. What is tested here is the seam: that vlab's
// snake_case payment block maps onto a PayRequest, that the library's outcome
// maps onto the right Result code and metric, and that the explicit-product
// path is untouched by any of it.
//
// These still run against a stub API rather than a mocked client, so they are
// integration tests over the real library. That is deliberate: a fake client
// would let the two repos drift apart without a test noticing. WHERE A
// GUARANTEE IS ABOUT A SEND THAT MUST NOT HAPPEN, THE ASSERTION IS ON THE CALLS
// MADE, not just the returned Result.

// dingStub is a stub DingConnect that records what it was asked for.
type dingStub struct {
	products  []dingconnect.Product
	lookup    string // GetAccountLookup body; empty means "no operator resolved"
	transfers map[string]stubResp
	fallback  *stubResp

	sends       []dingconnect.SendTransferRequest
	productCall int
	lookupCall  int
}

type stubResp struct {
	status int
	body   string
}

func newDingStub() *dingStub {
	return &dingStub{transfers: map[string]stubResp{}}
}

func (s *dingStub) sentSkus() []string {
	out := make([]string, 0, len(s.sends))
	for _, r := range s.sends {
		out = append(out, r.SkuCode)
	}
	return out
}

// provider wires the stub to a provider. Catalogue caching is disabled so each
// test's fixtures cannot leak into another through a client-held cache.
func (s *dingStub) provider(t *testing.T) *DingConnectProvider {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.HasSuffix(r.URL.Path, "/GetProducts"):
			s.productCall++
			body, _ := json.Marshal(map[string]any{"Items": s.products, "ResultCode": 1, "ErrorCodes": []string{}})
			w.WriteHeader(200)
			w.Write(body)

		case strings.HasSuffix(r.URL.Path, "/GetAccountLookup"):
			s.lookupCall++
			w.WriteHeader(200)
			if s.lookup == "" {
				fmt.Fprint(w, `{"CountryIso":"AR","Items":[],"ResultCode":1,"ErrorCodes":[]}`)
				return
			}
			fmt.Fprint(w, s.lookup)

		case strings.HasSuffix(r.URL.Path, "/SendTransfer"):
			var req dingconnect.SendTransferRequest
			json.NewDecoder(r.Body).Decode(&req)
			s.sends = append(s.sends, req)

			resp, ok := s.transfers[req.SkuCode]
			if !ok {
				if s.fallback == nil {
					w.WriteHeader(500)
					fmt.Fprint(w, `{"ResultCode":5,"ErrorCodes":[{"Code":"OtherError"}]}`)
					return
				}
				resp = *s.fallback
			}
			w.WriteHeader(resp.status)
			fmt.Fprint(w, resp.body)

		default:
			w.WriteHeader(404)
			fmt.Fprint(w, `{"ResultCode":4,"ErrorCodes":[{"Code":"RequestInvalid"}]}`)
		}
	}))
	t.Cleanup(srv.Close)

	return &DingConnectProvider{
		client: dingconnect.New("test_api_key_123",
			dingconnect.WithBaseURL(srv.URL),
			dingconnect.WithCatalogueTTL(0)),
	}
}

// --- fixtures ---------------------------------------------------------------

func dingFixed(sku, provider string, send, receive float64, currency string) dingconnect.Product {
	p := dingconnect.Price{SendValue: send, ReceiveValue: receive, ReceiveCurrencyIso: currency, SendCurrencyIso: "USD"}
	return dingconnect.Product{SkuCode: sku, ProviderCode: provider, Minimum: p, Maximum: p}
}

func arProducts() []dingconnect.Product {
	return []dingconnect.Product{
		dingFixed("CLAR5046", "CLAR", 0.79, 1000, "ARS"),
		dingFixed("TFAR58291", "TFAR", 0.85, 1000, "ARS"),
		dingFixed("PRAR13725", "PRAR", 0.93, 1000, "ARS"),
	}
}

func dingOK(sku string, receive float64, currency string) stubResp {
	return stubResp{200, fmt.Sprintf(`{
		"TransferRecord": {
			"TransferId": {"DistributorRef":"r","TransferRef":"DC1"},
			"SkuCode": %q,
			"Price": {"ReceiveValue": %v, "ReceiveCurrencyIso": %q, "SendCurrencyIso":"USD"},
			"ProcessingState": "Completed"
		},
		"ResultCode": 1, "ErrorCodes": []
	}`, sku, receive, currency)}
}

func dingErrResp(code string) stubResp {
	return stubResp{200, fmt.Sprintf(`{"TransferRecord":null,"ResultCode":5,"ErrorCodes":[{"Code":%q}]}`, code)}
}

func dingLookup(provider string) string {
	return fmt.Sprintf(`{"CountryIso":"AR","AccountNumberNormalized":"5491112345678",
		"Items":[{"ProviderCode":%q,"SkuCodes":["X"]}],"ResultCode":1,"ErrorCodes":[]}`, provider)
}

// The pinned config a survey would author.
const arPinnedDetails = `{
	"id": "p1",
	"account_number": "5491112345678",
	"distributor_ref": "ar_p1",
	"amount": 1000,
	"amount_currency": "ARS",
	"tolerance": 200,
	"operators": {
		"CLAR": {"sku_code": "CLAR5046",  "send_value": 0.79},
		"TFAR": {"sku_code": "TFAR58291", "send_value": 0.85},
		"PRAR": {"sku_code": "PRAR13725", "send_value": 0.93}
	}
}`

// ---------------------------------------------------------------------------
// The seam: snake_case config reaches the wire correctly
// ---------------------------------------------------------------------------

// TestDingDeclaredIntentPaysThroughTheLibrary is the end-to-end happy path, and
// the assertion that matters is the send value: each operator's own price must
// survive the snake_case -> PayRequest -> SendTransferRequest translation.
//
// A shared value here would deliver a different amount depending on the
// respondent's network, silently, reported as a success. That is the defect the
// whole design exists to remove, and this is where a mapping bug would
// reintroduce it.
func TestDingDeclaredIntentPaysThroughTheLibrary(t *testing.T) {
	for operator, want := range map[string]struct {
		sku  string
		send float64
	}{
		"CLAR": {"CLAR5046", 0.79},
		"TFAR": {"TFAR58291", 0.85},
		"PRAR": {"PRAR13725", 0.93},
	} {
		t.Run(operator, func(t *testing.T) {
			stub := newDingStub()
			stub.products = arProducts()
			stub.lookup = dingLookup(operator)
			stub.transfers[want.sku] = dingOK(want.sku, 1000, "ARS")

			res, err := stub.provider(t).Payout(dingEvent(arPinnedDetails))

			assert.Nil(t, err)
			assert.True(t, res.Success)
			assert.Equal(t, "payment:dingconnect", res.Type)
			assert.Equal(t, "p1", res.ID)

			assert.Len(t, stub.sends, 1, "the verified path costs exactly one transfer")
			assert.Equal(t, want.sku, stub.sends[0].SkuCode)
			assert.Equal(t, want.send, stub.sends[0].SendValue,
				"each operator's own send_value must reach the wire")
			assert.Equal(t, "ar_p1", stub.sends[0].DistributorRef,
				"a single send keeps the authored ref")
		})
	}
}

// TestDingResolutionReachesTheResult pins the debugging trace that replybot
// flattens into the respondent's md, so one payment point stays one payment
// event while remaining diagnosable.
func TestDingResolutionReachesTheResult(t *testing.T) {
	stub := newDingStub()
	stub.products = arProducts()
	stub.lookup = dingLookup("TFAR")
	stub.transfers["TFAR58291"] = dingOK("TFAR58291", 1000, "ARS")

	res, err := stub.provider(t).Payout(dingEvent(arPinnedDetails))
	assert.Nil(t, err)

	assert.NotNil(t, res.Resolution)
	assert.Equal(t, "pinned", res.Resolution.Path)
	assert.Equal(t, "TFAR", res.Resolution.Operator)
	assert.Equal(t, "TFAR58291", res.Resolution.SkuCode)
	assert.Equal(t, 0.85, res.Resolution.SendValue)
	assert.Equal(t, 1000.0, res.Resolution.Expected)
	assert.Equal(t, 1000.0, res.Resolution.Delivered)
	assert.Equal(t, "ARS", res.Resolution.Currency)
}

// TestDingDiscoveryTraceIsOnOneResult: several candidates were tried, and it is
// still ONE payment event. The per-candidate outcomes ride along on the
// resolution rather than becoming payment events of their own, which is what
// keeps the payment ledger and the recovery tooling honest.
func TestDingDiscoveryTraceIsOnOneResult(t *testing.T) {
	stub := newDingStub()
	stub.products = arProducts()
	stub.lookup = "" // inconclusive
	stub.transfers["CLAR5046"] = dingErrResp(dingconnect.CodeRechargeNotAllowed)
	stub.transfers["PRAR13725"] = dingErrResp(dingconnect.CodeRechargeNotAllowed)
	stub.transfers["TFAR58291"] = dingOK("TFAR58291", 1000, "ARS")

	res, err := stub.provider(t).Payout(dingEvent(arPinnedDetails))

	assert.Nil(t, err)
	assert.True(t, res.Success)
	assert.Equal(t, []string{"CLAR5046", "PRAR13725", "TFAR58291"}, stub.sentSkus())

	assert.Equal(t, "discovery", res.Resolution.Path)
	assert.Len(t, res.Resolution.Attempts, 3)
	assert.Equal(t, dingconnect.CodeRechargeNotAllowed, res.Resolution.Attempts[0].Code)
	assert.False(t, res.Resolution.Attempts[0].Success)
	assert.True(t, res.Resolution.Attempts[2].Success)

	// Per-candidate refs are derived so candidate 2 is not rejected as a
	// duplicate of candidate 1.
	refs := []string{}
	for _, s := range stub.sends {
		refs = append(refs, s.DistributorRef)
	}
	assert.Equal(t, []string{"ar_p1_CLAR5046", "ar_p1_PRAR13725", "ar_p1_TFAR58291"}, refs)
}

// TestDingRateLimitedStopsWithoutAnotherSend is the guarantee the ticket names,
// asserted at this layer too.
//
// The library owns the policy, but the guarantee is about dinersclub's
// behaviour, so it is pinned on both sides of the seam. The other two products
// are rigged to SUCCEED, so a leaked advance shows up as an unexpected success.
func TestDingRateLimitedStopsWithoutAnotherSend(t *testing.T) {
	stub := newDingStub()
	stub.products = arProducts()
	stub.lookup = ""
	stub.transfers["CLAR5046"] = dingErrResp(dingconnect.CodeRateLimited)
	stub.transfers["PRAR13725"] = dingOK("PRAR13725", 1000, "ARS")
	stub.transfers["TFAR58291"] = dingOK("TFAR58291", 1000, "ARS")

	res, err := stub.provider(t).Payout(dingEvent(arPinnedDetails))

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, dingconnect.CodeRateLimited, res.Error.Code)
	assert.Equal(t, []string{"CLAR5046"}, stub.sentSkus(),
		"RateLimited may be a per-account fraud rule: no further transfer may be sent")

	// And the other half of the guarantee: the worker must not retry it either.
	recovery, known := ClassifyResult(res)
	assert.True(t, known, "RateLimited must be pinned, not left to the unknown-code default")
	assert.NotEqual(t, RecoveryTransient, recovery,
		"backoff.Retry would replay the whole cascade from the first candidate")
}

// ---------------------------------------------------------------------------
// Mapping the library's refusals onto Result codes
// ---------------------------------------------------------------------------

// TestDingResolutionFailuresMapToResultCodes covers the boundary table. Each
// case must also make ZERO transfers: the value of declaring an intent is that
// a stale pin is caught rather than paid.
func TestDingResolutionFailuresMapToResultCodes(t *testing.T) {
	tests := []struct {
		name     string
		products []dingconnect.Product
		lookup   string
		details  string
		wantCode string
		wantMsg  string
	}{
		{
			name:     "pinned sku is gone",
			products: []dingconnect.Product{dingFixed("SOMETHING_ELSE", "CLAR", 0.79, 1000, "ARS")},
			lookup:   dingLookup("CLAR"),
			details:  arPinnedDetails,
			wantCode: codePinDrift,
			wantMsg:  "no longer in the catalogue",
		},
		{
			// The silent-wrong-amount failure, made loud.
			name:     "commission moved so the pin delivers too little",
			products: []dingconnect.Product{dingFixed("CLAR5046", "CLAR", 0.79, 800, "ARS")},
			lookup:   dingLookup("CLAR"),
			details:  arPinnedDetails,
			wantCode: codePinDrift,
			wantMsg:  "now delivers 800",
		},
		{
			name:     "product delivers a different currency",
			products: []dingconnect.Product{dingFixed("CLAR5046", "CLAR", 0.79, 1000, "USD")},
			lookup:   dingLookup("CLAR"),
			details:  arPinnedDetails,
			wantCode: codeAmountCurrencyMismatch,
			wantMsg:  "AmountCurrency is ARS",
		},
		{
			name:     "detected operator is not pinned",
			products: arProducts(),
			lookup:   dingLookup("MOVI"),
			details:  arPinnedDetails,
			wantCode: codeNoPinForOperator,
			wantMsg:  "MOVI",
		},
		{
			name: "nothing satisfies the window",
			products: []dingconnect.Product{
				dingFixed("TINY", "CLAR", 0.05, 50, "ARS"),
				dingFixed("HUGE", "CLAR", 9.99, 20000, "ARS"),
			},
			lookup: dingLookup("CLAR"),
			details: `{"account_number":"5491112345678","distributor_ref":"ar_p1",
				"amount":1000,"amount_currency":"ARS","tolerance":200}`,
			wantCode: codeImpossibleAmount,
			wantMsg:  "between 1000 and 1200 ARS",
		},
		{
			name:     "operator undetectable and nothing pinned",
			products: arProducts(),
			lookup:   "",
			details: `{"account_number":"5491112345678","distributor_ref":"ar_p1",
				"amount":1000,"amount_currency":"ARS","tolerance":200}`,
			wantCode: codeCouldNotDetectOperator,
			wantMsg:  "could not determine the operator",
		},
		{
			// Validation the library performs, surfaced under vlab's code.
			name:     "amount without a currency",
			products: arProducts(),
			lookup:   dingLookup("CLAR"),
			details: `{"account_number":"5491112345678","distributor_ref":"ar_p1",
				"amount":1000,"tolerance":200}`,
			wantCode: codeInvalidPaymentDetails,
			wantMsg:  "AmountCurrency is required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stub := newDingStub()
			stub.products = tt.products
			stub.lookup = tt.lookup
			stub.fallback = &stubResp{200, dingOK("X", 1000, "ARS").body}

			res, err := stub.provider(t).Payout(dingEvent(tt.details))

			assert.Nil(t, err, "a payment rejection is (Result, nil), never an error")
			assert.False(t, res.Success)
			assert.Equal(t, tt.wantCode, res.Error.Code)
			assert.Contains(t, res.Error.Message, tt.wantMsg)
			assert.Empty(t, stub.sends, "nothing may be sent when resolution refused")

			// Every code this path can produce must be classified, or the
			// respondent is told something we never decided to tell them.
			_, known := ClassifyResult(res)
			assert.True(t, known, "%s must be pinned in classify.go", tt.wantCode)
		})
	}
}

// TestDingEveryResolutionReasonIsMapped guards the seam against upstream drift.
//
// A reason added in go-dingconnect and not mapped here would reach a respondent
// as a raw library identifier and be counted as an unclassified code. This
// asserts the table covers the reasons the library actually defines, so the gap
// surfaces at compile-and-test time rather than in production.
func TestDingEveryResolutionReasonIsMapped(t *testing.T) {
	every := []dingconnect.ResolutionReason{
		dingconnect.ReasonInvalidRequest,
		dingconnect.ReasonPinSkuMissing,
		dingconnect.ReasonPinOutOfWindow,
		dingconnect.ReasonCurrencyMismatch,
		dingconnect.ReasonNoPinForOperator,
		dingconnect.ReasonOperatorNotDetermined,
		dingconnect.ReasonImpossibleAmount,
	}

	for _, reason := range every {
		mapped, ok := resolutionReasonToCode[reason]
		assert.True(t, ok, "resolution reason %q has no Result code", reason)

		_, known := Classify(mapped.code)
		assert.True(t, known, "%q maps to %q, which classify.go does not know", reason, mapped.code)
	}
	assert.Len(t, resolutionReasonToCode, len(every),
		"resolutionReasonToCode must not carry a reason the library no longer defines")
}

// TestDingResolutionReasonIsItsOwnField pins the survey-facing contract.
//
// The reason must NOT be folded into error.code. A reason means WE refused to
// send and no money moved; an error code means DingConnect refused. A survey
// tells a respondent different things in those two cases, and merging them
// would force the author to memorise which string came from which side of the
// wire.
//
// The values are the library's, passed through verbatim, so they can be
// branched on without a translation table.
func TestDingResolutionReasonIsItsOwnField(t *testing.T) {
	tests := []struct {
		name       string
		products   []dingconnect.Product
		lookup     string
		details    string
		wantReason string
		wantCode   string
	}{
		{
			name:       "PinSkuMissing",
			products:   []dingconnect.Product{dingFixed("SOMETHING_ELSE", "CLAR", 0.79, 1000, "ARS")},
			lookup:     dingLookup("CLAR"),
			details:    arPinnedDetails,
			wantReason: "PinSkuMissing",
			wantCode:   codePinDrift,
		},
		{
			name:       "PinOutOfWindow",
			products:   []dingconnect.Product{dingFixed("CLAR5046", "CLAR", 0.79, 800, "ARS")},
			lookup:     dingLookup("CLAR"),
			details:    arPinnedDetails,
			wantReason: "PinOutOfWindow",
			wantCode:   codePinDrift,
		},
		{
			name:       "CurrencyMismatch",
			products:   []dingconnect.Product{dingFixed("CLAR5046", "CLAR", 0.79, 1000, "USD")},
			lookup:     dingLookup("CLAR"),
			details:    arPinnedDetails,
			wantReason: "CurrencyMismatch",
			wantCode:   codeAmountCurrencyMismatch,
		},
		{
			name:       "NoPinForOperator",
			products:   arProducts(),
			lookup:     dingLookup("MOVI"),
			details:    arPinnedDetails,
			wantReason: "NoPinForOperator",
			wantCode:   codeNoPinForOperator,
		},
		{
			name:     "OperatorNotDetermined",
			products: arProducts(),
			lookup:   "",
			details: `{"account_number":"5491112345678","distributor_ref":"ar_p1",
				"amount":1000,"amount_currency":"ARS","tolerance":200}`,
			wantReason: "OperatorNotDetermined",
			wantCode:   codeCouldNotDetectOperator,
		},
		{
			name: "ImpossibleAmount",
			products: []dingconnect.Product{
				dingFixed("TINY", "CLAR", 0.05, 50, "ARS"),
			},
			lookup: dingLookup("CLAR"),
			details: `{"account_number":"5491112345678","distributor_ref":"ar_p1",
				"amount":1000,"amount_currency":"ARS","tolerance":200}`,
			wantReason: "ImpossibleAmount",
			wantCode:   codeImpossibleAmount,
		},
		{
			name:     "InvalidRequest",
			products: arProducts(),
			lookup:   dingLookup("CLAR"),
			details: `{"account_number":"5491112345678","distributor_ref":"ar_p1",
				"amount":1000,"tolerance":200}`,
			wantReason: "InvalidRequest",
			wantCode:   codeInvalidPaymentDetails,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stub := newDingStub()
			stub.products = tt.products
			stub.lookup = tt.lookup
			stub.fallback = &stubResp{200, dingOK("X", 1000, "ARS").body}

			res, err := stub.provider(t).Payout(dingEvent(tt.details))
			assert.Nil(t, err)
			assert.False(t, res.Success)

			assert.NotNil(t, res.Resolution, "a refusal must still carry a resolution block")
			assert.Equal(t, tt.wantReason, res.Resolution.Reason,
				"the reason lands in its own field, verbatim from the library")
			assert.Equal(t, tt.wantCode, res.Error.Code)
			assert.NotEqual(t, tt.wantReason, res.Error.Code,
				"the reason must not be folded into the error code")
		})
	}
}

// TestDingResolutionReasonFlattensToItsOwnMdKey pins the exact key a survey
// branches on. Someone is authoring logic against this string, so the JSON
// shape is the contract, not an implementation detail.
func TestDingResolutionReasonFlattensToItsOwnMdKey(t *testing.T) {
	stub := newDingStub()
	stub.products = []dingconnect.Product{dingFixed("CLAR5046", "CLAR", 0.79, 800, "ARS")}
	stub.lookup = dingLookup("CLAR")

	res, err := stub.provider(t).Payout(dingEvent(arPinnedDetails))
	assert.Nil(t, err)

	raw, err := json.Marshal(res)
	assert.Nil(t, err)

	// replybot flattens {"resolution":{"reason":X}} to
	// e_payment_dingconnect_resolution_reason.
	var decoded struct {
		Resolution struct {
			Reason string `json:"reason"`
		} `json:"resolution"`
	}
	assert.Nil(t, json.Unmarshal(raw, &decoded))
	assert.Equal(t, "PinOutOfWindow", decoded.Resolution.Reason)
}

// TestDingDeliveredAndExpectedSurviveIntoTheResult: a pin that verifies but
// delivers less than the catalogue predicted is the exact failure this design
// exists to catch, and it is only visible to a researcher if BOTH numbers reach
// the payment record rather than living only in a counter.
func TestDingDeliveredAndExpectedSurviveIntoTheResult(t *testing.T) {
	stub := newDingStub()
	stub.products = arProducts()
	stub.lookup = dingLookup("CLAR")
	stub.transfers["CLAR5046"] = dingOK("CLAR5046", 940, "ARS") // catalogue predicted 1000

	res, err := stub.provider(t).Payout(dingEvent(arPinnedDetails))
	assert.Nil(t, err)
	assert.True(t, res.Success)

	assert.Equal(t, 1000.0, res.Resolution.Expected, "what the catalogue predicted")
	assert.Equal(t, 940.0, res.Resolution.Delivered, "what actually landed")

	// Both must survive marshalling: a researcher reads them off the payment
	// record, not off a Prometheus counter.
	raw, err := json.Marshal(res)
	assert.Nil(t, err)
	assert.Contains(t, string(raw), `"expected_delivered":1000`)
	assert.Contains(t, string(raw), `"delivered":940`)
}

// TestDingUnsupportedOnDriftIsRejected: on_drift is accepted as config so that
// adding "resolve" later is purely additive, but only "fail" is implemented and
// silently ignoring the other value would be the worst of both.
func TestDingUnsupportedOnDriftIsRejected(t *testing.T) {
	stub := newDingStub()
	stub.products = arProducts()
	stub.lookup = dingLookup("CLAR")

	res, err := stub.provider(t).Payout(dingEvent(`{
		"account_number": "5491112345678", "distributor_ref": "ar_p1",
		"amount": 1000, "amount_currency": "ARS", "on_drift": "resolve"
	}`))

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, codeInvalidPaymentDetails, res.Error.Code)
	assert.Contains(t, res.Error.Message, "Unsupported on_drift")
	assert.Empty(t, stub.sends)
	assert.Equal(t, 0, stub.lookupCall, "an invalid block must not reach the API")
}

// ---------------------------------------------------------------------------
// Config validation the adapter still owns
// ---------------------------------------------------------------------------

func TestDingAdapterValidation(t *testing.T) {
	tests := []struct {
		name    string
		details string
		wantMsg string
	}{
		{"missing account_number", `{"sku_code":"S","send_value":1,"distributor_ref":"r"}`, "Missing account_number"},
		{"missing distributor_ref", `{"sku_code":"S","send_value":1,"account_number":"1"}`, "Missing distributor_ref"},
		{"nothing configured", `{"account_number":"1","distributor_ref":"r"}`, "Missing sku_code"},

		// The shape that matters most: this is what "I tried to share one
		// send_value across several operators" looks like in JSON, and there is
		// no honest precedence rule between an intent and an explicit product.
		{"both forms supplied", `{"account_number":"1","distributor_ref":"r",
			"amount":1000,"amount_currency":"ARS","sku_code":"S","send_value":0.79}`, "not both"},
		{"send_value alongside operators", `{"account_number":"1","distributor_ref":"r",
			"amount":1000,"amount_currency":"ARS","send_value":0.79,
			"operators":{"CLAR":{"sku_code":"C","send_value":0.79}}}`, "not both"},

		{"explicit with zero value", `{"account_number":"1","distributor_ref":"r","sku_code":"S","send_value":0}`, "send_value must be positive"},
		{"explicit with negative value", `{"account_number":"1","distributor_ref":"r","sku_code":"S","send_value":-1}`, "send_value must be positive"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stub := newDingStub()
			stub.fallback = &stubResp{200, dingOK("X", 1000, "ARS").body}

			res, err := stub.provider(t).Payout(dingEvent(tt.details))

			assert.Nil(t, err)
			assert.False(t, res.Success)
			assert.Equal(t, codeInvalidPaymentDetails, res.Error.Code)
			assert.Contains(t, res.Error.Message, tt.wantMsg)
			assert.Empty(t, stub.sends, "invalid details must not reach the API")
			assert.Equal(t, 0, stub.lookupCall)
		})
	}
}

// ---------------------------------------------------------------------------
// The explicit escape hatch stays exactly as it was
// ---------------------------------------------------------------------------

// TestDingExplicitProductPathIsUntouched: naming a product directly must make
// exactly the request it always made -- one transfer, the bare ref, no operator
// lookup, no catalogue fetch, and no resolution block on the Result.
//
// The existing cases in dingconnect_test.go pin the request body itself; this
// pins that none of the resolution machinery intrudes on the path.
func TestDingExplicitProductPathIsUntouched(t *testing.T) {
	stub := newDingStub()
	stub.transfers["US_VERIZON_5GB"] = stubResp{200, dingSuccessResponse}

	res, err := stub.provider(t).Payout(dingEvent(validDingDetails))

	assert.Nil(t, err)
	assert.True(t, res.Success)
	assert.Len(t, stub.sends, 1)
	assert.Equal(t, "US_VERIZON_5GB", stub.sends[0].SkuCode)
	assert.Equal(t, 25.00, stub.sends[0].SendValue)
	assert.Equal(t, "TXN001", stub.sends[0].DistributorRef)

	assert.Equal(t, 0, stub.lookupCall, "the explicit path must not detect an operator")
	assert.Equal(t, 0, stub.productCall, "the explicit path must not read the catalogue")
	assert.Nil(t, res.Resolution, "no resolution block: the Result shape is unchanged")
}

// TestDingExplicitResultHasNoResolutionKey guards the wire shape.
// Result.Resolution is omitempty precisely so no existing survey's md gains new
// keys.
func TestDingExplicitResultHasNoResolutionKey(t *testing.T) {
	stub := newDingStub()
	stub.transfers["US_VERIZON_5GB"] = stubResp{200, dingSuccessResponse}

	res, err := stub.provider(t).Payout(dingEvent(validDingDetails))
	assert.Nil(t, err)

	raw, err := json.Marshal(res)
	assert.Nil(t, err)
	assert.NotContains(t, string(raw), "resolution")
}

// ---------------------------------------------------------------------------
// Post-hoc delivery check
// ---------------------------------------------------------------------------

// TestDingDeliveredMismatchIsRecordedNotFailed: the transfer completed, so the
// respondent WAS paid.
//
// Reporting failure here would both lie and make dean pay them a second time,
// so a realised amount disagreeing with the catalogue is recorded and logged
// rather than turned into a failure.
func TestDingDeliveredMismatchIsRecordedNotFailed(t *testing.T) {
	stub := newDingStub()
	stub.products = arProducts()
	stub.lookup = dingLookup("CLAR")
	stub.transfers["CLAR5046"] = dingOK("CLAR5046", 800, "ARS") // catalogue said 1000

	res, err := stub.provider(t).Payout(dingEvent(arPinnedDetails))

	assert.Nil(t, err)
	assert.True(t, res.Success, "the money moved; reporting failure would cause a second payment")
	assert.Equal(t, 800.0, res.Resolution.Delivered)
	assert.Equal(t, 1000.0, res.Resolution.Expected)
}

// TestDingZeroToleranceIsAcceptedButNarrow documents the hazard rather than
// papering over it.
//
// tolerance defaults to zero, which makes the window [amount, amount] -- an
// exact-equality match. Some currencies round the delivered value down to a
// whole unit, so a pin sitting on a rounding boundary fails as PIN_DRIFT over a
// rounding artefact rather than a real commission change.
//
// dinersclub warns loudly and pays anyway. It must NOT invent a non-zero
// default: widening a window the researcher did not declare would pay an amount
// they never asked for, which is the automagic this whole design removed.
func TestDingZeroToleranceIsAcceptedButNarrow(t *testing.T) {
	const boliviaDetails = `{
		"account_number": "59171234567",
		"distributor_ref": "bo_p1",
		"amount": 5,
		"amount_currency": "BOB",
		"operators": {"ENTL": {"sku_code": "BO_EN_TopUp", "send_value": 0.55}}
	}`

	t.Run("an exact match still pays", func(t *testing.T) {
		stub := newDingStub()
		stub.products = []dingconnect.Product{dingFixed("BO_EN_TopUp", "ENTL", 0.55, 5, "BOB")}
		stub.lookup = `{"CountryIso":"BO","Items":[{"ProviderCode":"ENTL","SkuCodes":["BO_EN_TopUp"]}],"ResultCode":1,"ErrorCodes":[]}`
		stub.transfers["BO_EN_TopUp"] = dingOK("BO_EN_TopUp", 5, "BOB")

		res, err := stub.provider(t).Payout(dingEvent(boliviaDetails))
		assert.Nil(t, err)
		assert.True(t, res.Success)
		assert.Equal(t, []string{"BO_EN_TopUp"}, stub.sentSkus())
	})

	t.Run("a rounding artefact fails the payment, which is the hazard", func(t *testing.T) {
		stub := newDingStub()
		// The catalogue now says 4 BOB where the pin expects 5 -- a whole-unit
		// rounding step, not a commission change anyone authored.
		stub.products = []dingconnect.Product{dingFixed("BO_EN_TopUp", "ENTL", 0.55, 4, "BOB")}
		stub.lookup = `{"CountryIso":"BO","Items":[{"ProviderCode":"ENTL","SkuCodes":["BO_EN_TopUp"]}],"ResultCode":1,"ErrorCodes":[]}`

		res, err := stub.provider(t).Payout(dingEvent(boliviaDetails))
		assert.Nil(t, err)
		assert.False(t, res.Success)
		assert.Equal(t, codePinDrift, res.Error.Code)
		assert.Equal(t, "PinOutOfWindow", res.Resolution.Reason)
		assert.Empty(t, stub.sends)
	})
}
