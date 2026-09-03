package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v4/pgxpool"
	dingconnect "github.com/vlab-research/go-dingconnect"
)

// DingConnectProvider implements Provider on top of the dingconnect client.
//
// This type is deliberately thin: it maps a PaymentEvent to a request and the
// outcome back to a Result. All knowledge of DingConnect's wire format, error
// codes, amount resolution, and retry semantics lives in the dingconnect
// package, which is contract-tested against the live API.
//
// That rule is load-bearing and was briefly broken. An earlier version of the
// amount-resolution work lived here, which put cascade error-code semantics in
// a consumer of the library that owns them. It now lives in
// go-dingconnect/payment.go. If you find yourself about to add a rule here
// about what a DingConnect error code MEANS, it belongs there instead.
//
// What stays here: unmarshalling vlab's own payment-details format,
// credentials, mapping outcomes onto Result/PaymentError, and recording the
// resolution the library hands back as metrics.
type DingConnectProvider struct {
	pool   *pgxpool.Pool
	client *dingconnect.Client
	// opts are passed to the client built during Auth. Tests use this to
	// point at an httptest server.
	opts []dingconnect.Option
}

// DingConnectPaymentDetails is the researcher-facing payment configuration,
// as authored in a survey and delivered in PaymentEvent.Details.
//
// These names are snake_case because that is vlab's own event contract, and
// existing survey configurations depend on them. They are NOT DingConnect's
// wire format, which is PascalCase -- the mapping between the two happens in
// Payout. Do not "align" these tags with the API.
//
// There are two mutually exclusive ways to configure a payment:
//
//   - DECLARED INTENT: amount + amount_currency + tolerance, optionally with an
//     `operators` pin. This is the one to use. The declared amount is what makes
//     a pinned send_value verifiable -- on its own a send_value is a magic
//     number that nothing can check, so a commission-rate change silently
//     delivers the wrong incentive and still reports success.
//   - EXPLICIT PRODUCT: sku_code + send_value, sent as authored. The escape
//     hatch for naming a product directly. Unverified, by definition.
type DingConnectPaymentDetails struct {
	ID string `json:"id"` // Payment ID (optional but recommended)

	// --- explicit product (the escape hatch) ---
	SkuCode   string  `json:"sku_code"`   // Product SKU from DingConnect
	SendValue float64 `json:"send_value"` // Amount to transfer, in send currency

	// --- declared intent ---
	Amount         float64 `json:"amount"`          // MINIMUM DELIVERED, a floor on Price.ReceiveValue
	AmountCurrency string  `json:"amount_currency"` // Required with amount; validated against ReceiveCurrencyIso
	Tolerance      float64 `json:"tolerance"`       // Headroom on the DELIVERED amount, matching Reloadly
	// Operators pins what we currently believe each operator's product and
	// price to be. Keyed by operator, because it is looked up rather than
	// iterated: order is deliberately not expressible.
	Operators map[string]DingConnectOperatorPin `json:"operators"`
	Operator  string                            `json:"operator"` // Names the operator directly, skipping detection
	OnDrift   string                            `json:"on_drift"` // "fail" (default); see onDriftFail

	SendCurrencyISO string `json:"send_currency_iso"` // Currency code, optional (defaults to USD)
	AccountNumber   string `json:"account_number"`    // Target phone/account (required)
	DistributorRef  string `json:"distributor_ref"`   // Unique reference for deduplication (required)
	Settings        []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"settings"` // Provider-specific settings (optional)
}

// DingConnectOperatorPin is one entry of the `operators` map.
//
// A local type rather than dingconnect.OperatorPin because the JSON tags are
// vlab's snake_case contract, not the library's wire format. The two are
// converted in payRequest.
type DingConnectOperatorPin struct {
	SkuCode   string  `json:"sku_code"`
	SendValue float64 `json:"send_value"`
}

// onDriftFail is the only implemented drift mode.
//
// on_drift is accepted as config so that adding "resolve" later -- re-resolving
// to a product that satisfies the intent instead of failing -- is purely
// additive and needs no migration. v1 deliberately does not build it.
const onDriftFail = "fail"

// Result error codes produced by this provider. All are permanent in
// classify.go: they are configuration faults a retry cannot clear, and parking
// someone for dean's 14 days on one would hide it.
const (
	codePinDrift               = "PIN_DRIFT"
	codeAmountCurrencyMismatch = "AMOUNT_CURRENCY_MISMATCH"
	codeNoPinForOperator       = "NO_PIN_FOR_OPERATOR"
	codeImpossibleAmount       = "IMPOSSIBLE_AMOUNT"
	codeInvalidPaymentDetails  = "INVALID_PAYMENT_DETAILS"
	codeCouldNotDetectOperator = "COULD_NOT_AUTO_DETECT_OPERATOR"
)

// Drift reasons, used as the `reason` label on dinersclub_dingconnect_pin_drift_total.
const (
	driftSkuMissing       = "sku_missing"
	driftOutOfWindow      = "out_of_window"
	driftCurrencyMismatch = "currency_mismatch"
)

// resolutionReasonToCode maps the library's reason for declining to send onto
// a vlab Result code and, where it is drift, onto a metric label.
//
// This table IS the boundary between the two repos. go-dingconnect reports what
// happened in its own vocabulary and owns no metrics registry; dinersclub
// decides what that means for a respondent and what to count. Adding a reason
// upstream shows up here as an unmapped code, which fails loudly below rather
// than being silently renamed.
var resolutionReasonToCode = map[dingconnect.ResolutionReason]struct {
	code  string
	drift string
}{
	dingconnect.ReasonInvalidRequest:        {codeInvalidPaymentDetails, ""},
	dingconnect.ReasonPinSkuMissing:         {codePinDrift, driftSkuMissing},
	dingconnect.ReasonPinOutOfWindow:        {codePinDrift, driftOutOfWindow},
	dingconnect.ReasonCurrencyMismatch:      {codeAmountCurrencyMismatch, driftCurrencyMismatch},
	dingconnect.ReasonNoPinForOperator:      {codeNoPinForOperator, ""},
	dingconnect.ReasonOperatorNotDetermined: {codeCouldNotDetectOperator, ""},
	dingconnect.ReasonImpossibleAmount:      {codeImpossibleAmount, ""},
}

// DingConnectResolution records how a payment point was resolved, for debugging
// a single respondent without emitting a second payment event.
//
// replybot's _eventMetadata flattens every Result key into the respondent's md,
// so this lands as e_payment_dingconnect_resolution_*. It is omitempty and
// absent on the explicit-product path, so no existing config and no other
// provider changes shape.
type DingConnectResolution struct {
	Path string `json:"path"`
	// Reason is the library's ResolutionReason, passed through VERBATIM, and it
	// is deliberately NOT folded into error.code.
	//
	// The two answer different questions and a survey branches differently on
	// them. A reason here means WE refused to send and no money moved -- our
	// pin is stale, our config is wrong. An error.code means DingConnect
	// refused. "We would not pay you because our configuration is out of date"
	// is a different thing to tell a respondent than "your operator declined",
	// and merging them would force a survey author to memorise which string
	// came from which side of the wire.
	//
	// Lands in state as e_payment_dingconnect_resolution_reason. Value space is
	// the library's, listed in README.md.
	Reason    string           `json:"reason,omitempty"`
	Operator  string           `json:"operator,omitempty"`
	Country   string           `json:"country,omitempty"`
	SkuCode   string           `json:"sku_code,omitempty"`
	SendValue float64          `json:"send_value,omitempty"`
	Expected  float64          `json:"expected_delivered,omitempty"`
	Delivered float64          `json:"delivered,omitempty"`
	Currency  string           `json:"currency,omitempty"`
	Attempts  []DingAttemptLog `json:"attempts,omitempty"`
}

// DingAttemptLog is one candidate's outcome on the discovery path.
type DingAttemptLog struct {
	SkuCode string `json:"sku_code"`
	Code    string `json:"code,omitempty"`
	Success bool   `json:"success"`
}

// NewDingConnectProvider creates a new DingConnect provider instance.
// The API key is loaded from the database during Auth.
func NewDingConnectProvider(pool *pgxpool.Pool) (Provider, error) {
	return &DingConnectProvider{pool: pool}, nil
}

// GetUserFromPaymentEvent extracts the user from a PaymentEvent using the generic user lookup.
func (p *DingConnectProvider) GetUserFromPaymentEvent(event *PaymentEvent) (*User, error) {
	return GenericGetUser(p.pool, event)
}

// Auth resolves the researcher's DingConnect API key and builds the client
// that Payout will use.
//
// The key is a Generic Secret, named by the survey's `payment.key`. DingConnect
// deliberately has no credential entity or dashboard screen of its own: its
// credential is a single opaque string, which is exactly what Generic Secrets
// already model, and a bespoke entity would be unwritable until someone built a
// screen for it. See secretForUser.
//
// The client also carries the product-catalogue cache, which is therefore
// scoped to one researcher's credential -- commission rates are a property of
// the distributor account, so sharing a catalogue across accounts would price
// one researcher's payment with another's rates. Its lifetime is bounded by
// both the library's TTL and how long main.go's auth cache keeps this provider
// alive, whichever is shorter.
func (p *DingConnectProvider) Auth(user *User, key string) error {
	if key == "" {
		return fmt.Errorf(`No key provided for DingConnect provider. Set "key" in your survey's payment block to the name of the Generic Secret holding your DingConnect API key.`)
	}

	apiKey, err := secretForUser(p.pool, user.Id, key)
	if err != nil {
		return err
	}

	p.client = dingconnect.New(apiKey, p.opts...)
	return nil
}

// Payout executes a payment and maps the outcome to a Result.
//
// Payment failures are returned as a Result with Success false and a nil
// error; a non-nil error is reserved for faults worth retrying at the worker
// level, matching the other providers. That convention is load-bearing --
// DC.payout reads a non-nil error as "no verdict exists at all".
func (p *DingConnectProvider) Payout(event *PaymentEvent) (*Result, error) {
	details := new(DingConnectPaymentDetails)
	if err := json.Unmarshal(*event.Details, details); err != nil {
		return handleJSONUnmarshalError("dingconnect", err, event.Details), nil
	}

	result := &Result{
		Type: "payment:dingconnect",
		ID:   details.ID,
	}

	if details.AccountNumber == "" {
		return formatDingConnectError(result, event, "Missing account_number", codeInvalidPaymentDetails), nil
	}
	if details.DistributorRef == "" {
		return formatDingConnectError(result, event, "Missing distributor_ref", codeInvalidPaymentDetails), nil
	}

	declared := details.Amount > 0 || details.AmountCurrency != "" || len(details.Operators) > 0 || details.Operator != ""
	explicit := details.SkuCode != "" || details.SendValue != 0

	switch {
	case declared && explicit:
		// There is no honest precedence rule between a declared intent and an
		// explicit product, and supplying both is what "I tried to share one
		// send_value across several operators" looks like in JSON.
		return formatDingConnectError(result, event,
			"Supply either amount/operators or sku_code/send_value, not both", codeInvalidPaymentDetails), nil
	case !declared && !explicit:
		// Preserve today's message: this is what an empty payment block has
		// always reported and surveys may be matching on it.
		return formatDingConnectError(result, event, "Missing sku_code", codeInvalidPaymentDetails), nil
	}

	if p.client == nil {
		return nil, fmt.Errorf("dingconnect: Payout called before Auth")
	}

	// ONE DEADLINE FOR THE WHOLE RESOLUTION. Pay may make an account lookup, a
	// catalogue fetch and several transfers, and it takes a single context for
	// all of them.
	//
	// Not one per call. dingconnect.DefaultTimeout is 90s and this provider is
	// deliberately not bounded by DINERSCLUB_PROVIDER_TIMEOUT (see
	// devops/values/production.yaml). N sequential 90s sends against spine's
	// hardcoded 300s max.poll.interval.ms, at POOL_SIZE=2, is exactly how the
	// 2026-08-17 incident went: the batch outran the poll interval, Kafka
	// evicted the consumer, the uncommitted batch was redelivered, and the pod
	// crash-looped making zero progress.
	ctx, cancel := context.WithTimeout(context.Background(), dingconnect.DefaultTimeout)
	defer cancel()

	if explicit {
		return p.payExplicit(ctx, event, result, details), nil
	}
	return p.payDeclared(ctx, event, result, details), nil
}

// payExplicit sends a product the survey named directly.
//
// This is the pre-existing path and it is deliberately untouched: one
// SendTransfer, the authored DistributorRef, and a Result with no resolution
// block. A payment already parked in production keeps the exact reference it
// was first submitted under when dean re-drives it.
func (p *DingConnectProvider) payExplicit(ctx context.Context, event *PaymentEvent, result *Result, details *DingConnectPaymentDetails) *Result {
	if details.SkuCode == "" {
		return formatDingConnectError(result, event, "Missing sku_code", codeInvalidPaymentDetails)
	}
	if details.SendValue <= 0 {
		return formatDingConnectError(result, event, "send_value must be positive", codeInvalidPaymentDetails)
	}

	res, err := p.client.SendTransfer(ctx, dingconnect.SendTransferRequest{
		SkuCode:         details.SkuCode,
		SendValue:       details.SendValue,
		SendCurrencyIso: details.SendCurrencyISO,
		AccountNumber:   details.AccountNumber,
		DistributorRef:  details.DistributorRef,
		Settings:        dingSettings(details),
	})

	// The raw response is recorded whatever the outcome -- a declined transfer
	// still carries a TransferRecord worth keeping.
	recordRawResponse(result, res)

	if err != nil {
		return dingConnectErrorToResult(result, event, err)
	}
	if res.TransferRecord == nil {
		return formatDingConnectError(result, event, "Result code 1 but no transfer record provided", "INVALID_RESPONSE")
	}
	if !res.TransferRecord.Completed() {
		return formatDingConnectError(result, event,
			fmt.Sprintf("Unexpected processing state: %s", res.TransferRecord.ProcessingState), "INVALID_RESPONSE")
	}

	return dingSuccess(result, event)
}

// payDeclared resolves and pays against a declared intent, delegating all of
// the policy to the library.
func (p *DingConnectProvider) payDeclared(ctx context.Context, event *PaymentEvent, result *Result, details *DingConnectPaymentDetails) *Result {
	if details.OnDrift != "" && details.OnDrift != onDriftFail {
		return formatDingConnectError(result, event,
			fmt.Sprintf("Unsupported on_drift %q: only %q is implemented", details.OnDrift, onDriftFail),
			codeInvalidPaymentDetails)
	}

	warnOnExactMatchWindow(event, details)

	req := dingconnect.PayRequest{
		AccountNumber:   details.AccountNumber,
		DistributorRef:  details.DistributorRef,
		Amount:          details.Amount,
		AmountCurrency:  details.AmountCurrency,
		Tolerance:       details.Tolerance,
		Operator:        details.Operator,
		SendCurrencyIso: details.SendCurrencyISO,
		Settings:        dingSettings(details),
	}
	if len(details.Operators) > 0 {
		req.Operators = make(map[string]dingconnect.OperatorPin, len(details.Operators))
		for op, pin := range details.Operators {
			req.Operators[op] = dingconnect.OperatorPin{SkuCode: pin.SkuCode, SendValue: pin.SendValue}
		}
	}

	res, err := p.client.Pay(ctx, req)

	recordRawResponse(result, res.Response)
	result.Resolution = toDingResolution(res.Resolution)

	if err != nil {
		return p.resolutionFailure(result, event, err)
	}

	p.checkDelivered(event, res)
	return dingSuccess(result, event)
}

// resolutionFailure maps a failed Pay onto a Result.
func (p *DingConnectProvider) resolutionFailure(result *Result, event *PaymentEvent, err error) *Result {
	if re, ok := dingconnect.IsResolutionError(err); ok {
		mapped, known := resolutionReasonToCode[re.Reason]
		if !known {
			// Fail loud rather than inventing a code. A reason added upstream
			// arrives here unmapped, and pretending to understand it would
			// classify it by accident.
			log.Printf("DinersClub dingconnect saw an unmapped resolution reason %q for user %s: %s. Add it to resolutionReasonToCode.",
				re.Reason, event.Userid, re.Message)
			setResolutionReason(result, re.Reason)
			return formatDingConnectError(result, event, re.Message, string(re.Reason))
		}
		if mapped.drift != "" {
			recordPinDrift(mapped.drift)
			log.Printf("DinersClub dingconnect PIN DRIFT (%s) for user %s: %s", mapped.drift, event.Userid, re.Message)
		}
		setResolutionReason(result, re.Reason)
		return formatDingConnectError(result, event, re.Message, mapped.code)
	}
	return dingConnectErrorToResult(result, event, err)
}

// checkDelivered compares what actually landed against what was declared.
//
// This is the only true detector of the failure the declared-intent design
// exists to prevent -- a commission rate moving so the transfer succeeds while
// delivering the wrong incentive. It runs after the money has moved, so it
// CANNOT fail the payment: the respondent was paid, and reporting failure would
// both lie to them and make dean pay them a second time. Loud log plus a
// counter is the honest response.
func (p *DingConnectProvider) checkDelivered(event *PaymentEvent, res dingconnect.PayResult) {
	expected, delivered := res.Resolution.Expected, res.Resolution.Delivered
	if expected == 0 || delivered == 0 {
		return
	}
	if delivered < expected-0.001 || delivered > expected+0.001 {
		recordDeliveredOutOfWindow()
		log.Printf("DinersClub dingconnect DELIVERED %v %s for user %s but expected %v from sku %s at send_value %v. The catalogue and the realised price disagree.",
			delivered, res.Resolution.Currency, event.Userid, expected,
			res.Resolution.SkuCode, res.Resolution.SendValue)
	}
}

// toDingResolution converts the library's trace into the vlab-facing shape that
// lands in the respondent's state metadata.
func toDingResolution(r dingconnect.Resolution) *DingConnectResolution {
	out := &DingConnectResolution{
		Path:      string(r.Path),
		Operator:  r.Operator,
		Country:   r.CountryIso,
		SkuCode:   r.SkuCode,
		SendValue: r.SendValue,
		Expected:  r.Expected,
		Delivered: r.Delivered,
		Currency:  r.Currency,
	}
	for _, a := range r.Attempts {
		code := ""
		if len(a.Codes) > 0 {
			code = a.Codes[0]
		}
		out.Attempts = append(out.Attempts, DingAttemptLog{
			SkuCode: a.SkuCode,
			Code:    code,
			Success: a.Completed,
		})
	}
	return out
}

// setResolutionReason records why we declined to send, on the resolution block
// rather than on the error code. A resolution can be absent when the library
// rejected the request before building one.
func setResolutionReason(result *Result, reason dingconnect.ResolutionReason) {
	if result.Resolution == nil {
		result.Resolution = &DingConnectResolution{}
	}
	result.Resolution.Reason = string(reason)
}

// warnOnExactMatchWindow flags a payment block whose window is a single point.
//
// tolerance defaults to zero, which makes the window [amount, amount] -- an
// exact-equality match on the delivered value. That is almost always an
// authoring oversight rather than an intent, and it is fragile in a way that is
// easy to miss: some currencies round the receive value down to a whole unit,
// so a pin sitting on a rounding boundary flips to PinOutOfWindow and hard-fails
// a payment over a rounding artefact rather than a real commission change.
//
// A warning, not a rejection, and no default is invented. An exact match is a
// legitimate thing to ask for, and silently widening the window would be
// exactly the automagic this design removed -- the researcher would then be
// paying an amount they never declared.
func warnOnExactMatchWindow(event *PaymentEvent, details *DingConnectPaymentDetails) {
	if details.Tolerance > 0 {
		return
	}
	log.Printf("DinersClub dingconnect payment for user %s declares amount %v %s with tolerance 0, so only an exact delivered match is accepted. If a rounding rule or a commission change moves the delivered value by any amount, this payment fails as PIN_DRIFT. Set a tolerance unless an exact match is genuinely intended.",
		event.Userid, details.Amount, details.AmountCurrency)
}

func dingSettings(details *DingConnectPaymentDetails) []dingconnect.Setting {
	settings := make([]dingconnect.Setting, 0, len(details.Settings))
	for _, s := range details.Settings {
		settings = append(settings, dingconnect.Setting{Name: s.Name, Value: s.Value})
	}
	return settings
}

func recordRawResponse(result *Result, res dingconnect.SendTransferResponse) {
	if raw, err := json.Marshal(res); err == nil {
		msg := json.RawMessage(raw)
		result.Response = &msg
	}
}

func dingSuccess(result *Result, event *PaymentEvent) *Result {
	result.Success = true
	result.Timestamp = time.Now().UTC()
	result.PaymentDetails = event.Details
	return result
}

// dingConnectErrorToResult maps a client error onto a failed Result, preferring
// DingConnect's own error code so operators can look it up directly.
func dingConnectErrorToResult(result *Result, event *PaymentEvent, err error) *Result {
	var e *dingconnect.Error
	if !errors.As(err, &e) {
		return formatDingConnectError(result, event, err.Error(), "HTTP_REQUEST_FAILED")
	}

	if code := e.Code(); code != "" {
		msg := code
		if e.Codes[0].Context != "" {
			msg = e.Codes[0].String()
		}
		return formatDingConnectError(result, event, msg, code)
	}

	// No error code: either a transport failure or a response we could not
	// decode. Both are system faults rather than payment rejections.
	if e.ResultCode == 0 {
		return formatDingConnectError(result, event, e.Error(), "HTTP_REQUEST_FAILED")
	}
	return formatDingConnectError(result, event,
		fmt.Sprintf("Payment failed (result code: %d)", e.ResultCode), "PAYMENT_FAILED")
}

// formatDingConnectError creates a standardized error result for DingConnect payment failures.
func formatDingConnectError(result *Result, event *PaymentEvent, message, code string) *Result {
	result.Success = false
	result.Error = &PaymentError{
		Message:        message,
		Code:           code,
		PaymentDetails: event.Details,
	}
	return result
}
