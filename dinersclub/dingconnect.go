package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v4/pgxpool"
	dingconnect "github.com/vlab-research/go-dingconnect"
)

// DingConnectProvider implements Provider on top of the dingconnect client.
//
// This type is deliberately thin: it maps a PaymentEvent to a transfer request
// and the transfer result back to a Result. All knowledge of DingConnect's
// wire format, error codes, and retry semantics lives in the dingconnect
// package, which is contract-tested against the live API.
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
type DingConnectPaymentDetails struct {
	ID              string  `json:"id"`                // Payment ID (optional but recommended)
	SkuCode         string  `json:"sku_code"`          // Product SKU from DingConnect (required)
	SendValue       float64 `json:"send_value"`        // Amount to transfer (required)
	SendCurrencyISO string  `json:"send_currency_iso"` // Currency code, optional (defaults to USD)
	AccountNumber   string  `json:"account_number"`    // Target phone/account (required)
	DistributorRef  string  `json:"distributor_ref"`   // Unique reference for deduplication (required)
	Settings        []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"settings"` // Provider-specific settings (optional)
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

// Payout executes a DingConnect transfer and maps the outcome to a Result.
//
// Payment failures are returned as a Result with Success false and a nil
// error; a non-nil error is reserved for faults worth retrying at the worker
// level, matching the other providers.
func (p *DingConnectProvider) Payout(event *PaymentEvent) (*Result, error) {
	details := new(DingConnectPaymentDetails)
	if err := json.Unmarshal(*event.Details, details); err != nil {
		return handleJSONUnmarshalError("dingconnect", err, event.Details), nil
	}

	result := &Result{
		Type: "payment:dingconnect",
		ID:   details.ID,
	}

	// Validate locally so an obviously malformed survey configuration is
	// reported as such rather than as an opaque API rejection.
	switch {
	case details.SkuCode == "":
		return formatDingConnectError(result, event, "Missing sku_code", "INVALID_PAYMENT_DETAILS"), nil
	case details.AccountNumber == "":
		return formatDingConnectError(result, event, "Missing account_number", "INVALID_PAYMENT_DETAILS"), nil
	case details.DistributorRef == "":
		return formatDingConnectError(result, event, "Missing distributor_ref", "INVALID_PAYMENT_DETAILS"), nil
	case details.SendValue <= 0:
		return formatDingConnectError(result, event, "send_value must be positive", "INVALID_PAYMENT_DETAILS"), nil
	}

	if p.client == nil {
		return nil, fmt.Errorf("dingconnect: Payout called before Auth")
	}

	settings := make([]dingconnect.Setting, 0, len(details.Settings))
	for _, s := range details.Settings {
		settings = append(settings, dingconnect.Setting{Name: s.Name, Value: s.Value})
	}

	// DistributorRef comes from the payment event and is stable across retries
	// of that event, which is what makes a retry safe: DingConnect answers a
	// replayed ref with DuplicateTransactionPrevented rather than paying twice.
	req := dingconnect.SendTransferRequest{
		SkuCode:         details.SkuCode,
		SendValue:       details.SendValue,
		SendCurrencyIso: details.SendCurrencyISO,
		AccountNumber:   details.AccountNumber,
		DistributorRef:  details.DistributorRef,
		Settings:        settings,
	}

	ctx, cancel := context.WithTimeout(context.Background(), dingconnect.DefaultTimeout)
	defer cancel()

	res, err := p.client.SendTransfer(ctx, req)

	// The raw response is recorded whatever the outcome -- a declined transfer
	// still carries a TransferRecord worth keeping.
	if raw, mErr := json.Marshal(res); mErr == nil {
		msg := json.RawMessage(raw)
		result.Response = &msg
	}

	if err != nil {
		return dingConnectErrorToResult(result, event, err), nil
	}

	// A success code with a non-Completed state should not happen for the
	// instant transfers this provider sends, but treating it as success would
	// credit a payment that never landed.
	if res.TransferRecord == nil {
		return formatDingConnectError(result, event, "Result code 1 but no transfer record provided", "INVALID_RESPONSE"), nil
	}
	if !res.TransferRecord.Completed() {
		return formatDingConnectError(result, event,
			fmt.Sprintf("Unexpected processing state: %s", res.TransferRecord.ProcessingState), "INVALID_RESPONSE"), nil
	}

	result.Success = true
	result.Timestamp = time.Now().UTC()
	result.PaymentDetails = event.Details
	return result, nil
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
