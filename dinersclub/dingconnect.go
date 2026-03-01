package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v4/pgxpool"
)

// DingConnectProvider implements the Provider interface for DingConnect API integration.
type DingConnectProvider struct {
	apiKey string
	client *http.Client
	pool   *pgxpool.Pool
}

// DingConnectPaymentDetails represents the payment configuration for a DingConnect transfer.
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

// DingConnectTransferId represents both the distributor and DingConnect transfer IDs.
type DingConnectTransferId struct {
	DistributorId string `json:"distributor_id"`
	DingId        string `json:"ding_id"`
}

// DingConnectPrice represents pricing information in the response.
type DingConnectPrice struct {
	SendValue    float64 `json:"send_value"`
	ReceiveValue float64 `json:"receive_value"`
	CurrencyISO  string  `json:"currency_iso"`
}

// DingConnectTransferRecord represents the transfer details in a successful response.
type DingConnectTransferRecord struct {
	TransferId        DingConnectTransferId `json:"transfer_id"`
	SkuCode           string                `json:"sku_code"`
	Price             DingConnectPrice      `json:"price"`
	CommissionApplied float64               `json:"commission_applied"`
	StartedUtc        string                `json:"started_utc"`
	CompletedUtc      string                `json:"completed_utc,omitempty"`
	ProcessingState   string                `json:"processing_state"`
	ReceiptText       string                `json:"receipt_text,omitempty"`
	AccountNumber     string                `json:"account_number"`
}

// DingConnectError represents a single error from the DingConnect API.
type DingConnectError struct {
	Code    string `json:"code"`
	Context string `json:"context"`
}

// DingConnectResponse represents the full response from the DingConnect SendTransfer endpoint.
type DingConnectResponse struct {
	TransferRecord *DingConnectTransferRecord `json:"transfer_record"`
	ResultCode     int                        `json:"result_code"`
	ErrorCodes     []DingConnectError         `json:"error_codes"`
}

// NewDingConnectProvider creates a new DingConnect provider instance.
// It loads the API key from the DINGCONNECT_API_KEY environment variable.
func NewDingConnectProvider(pool *pgxpool.Pool) (Provider, error) {
	apiKey := os.Getenv("DINGCONNECT_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("DINGCONNECT_API_KEY environment variable not set")
	}
	return &DingConnectProvider{
		apiKey: apiKey,
		client: http.DefaultClient,
		pool:   pool,
	}, nil
}

// GetUserFromPaymentEvent extracts the user from a PaymentEvent using the generic user lookup.
func (p *DingConnectProvider) GetUserFromPaymentEvent(event *PaymentEvent) (*User, error) {
	return GenericGetUser(p.pool, event)
}

// Auth validates authentication for DingConnect (stateless no-op since API key is global).
// The API key is loaded at provider creation time and validated by actual API calls.
func (p *DingConnectProvider) Auth(user *User, key string) error {
	return nil
}

// Payout executes a DingConnect SendTransfer request and returns the result.
// It handles the full request/response lifecycle including error mapping.
func (p *DingConnectProvider) Payout(event *PaymentEvent) (*Result, error) {
	// Step 1: Parse payment details
	details := new(DingConnectPaymentDetails)
	err := json.Unmarshal(*event.Details, &details)
	if err != nil {
		return handleJSONUnmarshalError("dingconnect", err, event.Details), nil
	}

	result := &Result{}
	result.Type = "payment:dingconnect"
	result.ID = details.ID

	// Step 2: Validate required fields
	if details.SkuCode == "" {
		return formatDingConnectError(result, event, "Missing sku_code", "INVALID_PAYMENT_DETAILS"), nil
	}
	if details.AccountNumber == "" {
		return formatDingConnectError(result, event, "Missing account_number", "INVALID_PAYMENT_DETAILS"), nil
	}
	if details.DistributorRef == "" {
		return formatDingConnectError(result, event, "Missing distributor_ref", "INVALID_PAYMENT_DETAILS"), nil
	}
	if details.SendValue <= 0 {
		return formatDingConnectError(result, event, "send_value must be positive", "INVALID_PAYMENT_DETAILS"), nil
	}

	// Step 3: Build SendTransfer request
	reqPayload := map[string]interface{}{
		"sku_code":        details.SkuCode,
		"send_value":      details.SendValue,
		"account_number":  details.AccountNumber,
		"distributor_ref": details.DistributorRef,
	}

	// Add optional fields
	if details.SendCurrencyISO != "" {
		reqPayload["send_currency_iso"] = details.SendCurrencyISO
	}
	if len(details.Settings) > 0 {
		reqPayload["settings"] = details.Settings
	}

	// Only use instant mode - never set X-Option: DeferTransfer
	reqBody, err := json.Marshal(reqPayload)
	if err != nil {
		return formatDingConnectError(result, event, fmt.Sprintf("Failed to marshal request: %s", err.Error()), "INVALID_PAYMENT_DETAILS"), nil
	}

	// Step 4: Make HTTP request
	url := "https://api.dingconnect.com/api/V1/SendTransfer"

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(reqBody))
	if err != nil {
		return formatDingConnectError(result, event, fmt.Sprintf("Failed to create request: %s", err.Error()), "BAD_HTTP_REQUEST"), nil
	}

	// Add required headers
	req.Header.Set("X-Api-Key", p.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	// Execute request
	resp, err := p.client.Do(req)
	if err != nil {
		return formatDingConnectError(result, event, fmt.Sprintf("HTTP request failed: %s", err.Error()), "HTTP_REQUEST_FAILED"), nil
	}
	defer resp.Body.Close()

	// Step 5: Parse response
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return formatDingConnectError(result, event, fmt.Sprintf("Failed to read response: %s", err.Error()), "HTTP_REQUEST_FAILED"), nil
	}

	var dingResp DingConnectResponse
	err = json.Unmarshal(bodyBytes, &dingResp)
	if err != nil {
		return formatDingConnectError(result, event, fmt.Sprintf("Invalid response format: %s", err.Error()), "INVALID_RESPONSE"), nil
	}

	// Step 6: Check ResultCode and map to PaymentError
	switch dingResp.ResultCode {
	case 1:
		// Success - process transfer record
		if dingResp.TransferRecord == nil {
			return formatDingConnectError(result, event, "Result code 1 but no transfer record provided", "INVALID_RESPONSE"), nil
		}

		// Verify processing state is Completed (instant mode should always complete or fail immediately)
		if dingResp.TransferRecord.ProcessingState != "Completed" {
			return formatDingConnectError(result, event, fmt.Sprintf("Unexpected processing state: %s", dingResp.TransferRecord.ProcessingState), "INVALID_RESPONSE"), nil
		}

		// Success case
		result.Success = true
		result.Timestamp = time.Now().UTC()
		result.PaymentDetails = event.Details

		// Include response
		response := json.RawMessage(bodyBytes)
		result.Response = &response

		return result, nil

	case 3:
		// Transient error - retry may succeed
		// Map first error code if available
		if len(dingResp.ErrorCodes) > 0 {
			return formatDingConnectError(result, event, dingResp.ErrorCodes[0].Context, dingResp.ErrorCodes[0].Code), nil
		}
		return formatDingConnectError(result, event, "Transient error (no details)", "TRANSIENT_ERROR"), nil

	default:
		// Other result codes indicate failure
		// Map error codes to PaymentError
		if len(dingResp.ErrorCodes) > 0 {
			errMsg := dingResp.ErrorCodes[0].Context
			errCode := dingResp.ErrorCodes[0].Code
			return formatDingConnectError(result, event, errMsg, errCode), nil
		}
		return formatDingConnectError(result, event, fmt.Sprintf("Payment failed (result code: %d)", dingResp.ResultCode), "PAYMENT_FAILED"), nil
	}
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
