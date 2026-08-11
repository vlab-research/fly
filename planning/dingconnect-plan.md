# DingConnectProvider Implementation Plan

**Date**: March 1, 2026
**Status**: Ready for Implementation
**Target Files**: dinersclub package

---

## Executive Summary

This document provides a detailed, step-by-step implementation plan for adding a new `DingConnectProvider` to the DinersClub payment processing system. DingConnect is a B2B mobile top-up API that complements the existing Reloadly provider, offering coverage in different markets and potentially better rates for certain operators.

The implementation follows the existing DinersClub provider architecture pattern and will integrate seamlessly with the Kafka-based payment processing pipeline.

---

## Required Reading Before Implementation

Before beginning implementation, read these documents in order:

1. **`/home/nandan/Documents/vlab-research/fly/planning/dinersclub-findings.md`**
   - Provides detailed overview of the entire DinersClub architecture
   - Explains Provider interface, data flow, error handling
   - Maps existing providers (Reloadly, HttpProvider, FakeProvider) to understand patterns

2. **`/home/nandan/Documents/vlab-research/fly/planning/dingconnect-api-findings.md`**
   - Official DingConnect API reference documentation
   - Critical sections:
     - Section 1: Authentication (X-Api-Key header)
     - Section 2.2: SendTransfer endpoint (POST /api/V1/SendTransfer)
     - Section 3: Response structure and ResultCode values
     - Section 4: Processing modes (only use Instant mode, not Deferred)
     - Section 9: SDK reference (for type definitions)

---

## Provider Interface Requirements

All providers in DinersClub must implement this interface (defined in `provider.go`):

```go
type Provider interface {
	GetUserFromPaymentEvent(*PaymentEvent) (*User, error)
	Auth(*User, string) error
	Payout(*PaymentEvent) (*Result, error)
}
```

### Method Signatures

1. **GetUserFromPaymentEvent(*PaymentEvent) (*User, error)**
   - Extract user from payment event
   - For DingConnect: Can use `GenericGetUser()` helper (looks up user by facebook_page_id)
   - Returns *User with Id field populated, or (nil, error) on database error

2. **Auth(*User, string) error**
   - Authenticate/authorize the user with DingConnect credentials
   - Parameter: `key` string (optional but typically required for multi-account users)
   - For DingConnect: API key is stateless - this can validate the key exists or be a no-op
   - Implementation detail: Store API key in provider state for use in Payout()

3. **Payout(*PaymentEvent) (*Result, error)**
   - Execute the actual payment transaction
   - Must return (*Result, nil) for all cases - errors mapped to Result.Error
   - Only return non-nil error for system errors (database, JSON unmarshal, etc.)
   - Never return (nil, error) for payment-specific failures

---

## Configuration & Environment Variables

### New Environment Variable Required

Add this to `.env`:

```bash
DINGCONNECT_API_KEY=<actual_api_key_from_dingconnect_account>
```

The API key is:
- Generated in DingConnect Account Settings → Developer tab
- Used in X-Api-Key header
- Global to the service (not per-user like Reloadly credentials)

### Config Struct

The existing `Config` struct in `config.go` does NOT need modification. The DingConnect API key will be loaded via environment variable in the provider's constructor, similar to how HttpProvider loads secrets.

---

## Struct Definitions

### DingConnectProvider Struct

```go
type DingConnectProvider struct {
	apiKey string
	client *http.Client
	pool   *pgxpool.Pool
}
```

**Fields**:
- `apiKey`: The X-Api-Key header value (loaded from env in constructor)
- `client`: HTTP client for making requests to DingConnect API
- `pool`: Database connection pool (for future use if needed)

### DingConnectPaymentDetails Struct

```go
type DingConnectPaymentDetails struct {
	ID              string  `json:"id"`              // Payment ID (optional but recommended)
	SkuCode         string  `json:"sku_code"`        // Product SKU from DingConnect (required)
	SendValue       float64 `json:"send_value"`      // Amount to transfer (required)
	SendCurrencyIso string  `json:"send_currency_iso"` // Currency code, optional (defaults to USD)
	AccountNumber   string  `json:"account_number"`  // Target phone/account (required)
	DistributorRef  string  `json:"distributor_ref"` // Unique reference for deduplication (required)
	Settings        []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"settings"` // Provider-specific settings (optional)
}
```

**Field Mapping from PaymentEvent Details**:
- These fields come from the `PaymentEvent.Details` JSON blob, unmarshaled in Payout()
- `sku_code`: Must be obtained from DingConnect GetProducts endpoint in advance (not from PaymentEvent)
- `account_number`: Target phone number or account identifier
- `distributor_ref`: Unique ID within distributor system (use to prevent duplicate charges)

### DingConnect Response Structures

Used internally for parsing responses:

```go
type DingConnectTransferId struct {
	DistributorId string `json:"distributor_id"`
	DingId        string `json:"ding_id"`
}

type DingConnectPrice struct {
	SendValue  float64 `json:"send_value"`
	ReceiveValue float64 `json:"receive_value"`
	CurrencyIso string `json:"currency_iso"`
}

type DingConnectTransferRecord struct {
	TransferId      DingConnectTransferId `json:"transfer_id"`
	SkuCode         string                `json:"sku_code"`
	Price           DingConnectPrice      `json:"price"`
	CommissionApplied float64             `json:"commission_applied"`
	StartedUtc      string                `json:"started_utc"`
	CompletedUtc    string                `json:"completed_utc,omitempty"`
	ProcessingState string                `json:"processing_state"`
	ReceiptText     string                `json:"receipt_text,omitempty"`
	AccountNumber   string                `json:"account_number"`
}

type DingConnectError struct {
	Code    string `json:"code"`
	Context string `json:"context"`
}

type DingConnectResponse struct {
	TransferRecord *DingConnectTransferRecord `json:"transfer_record"`
	ResultCode     int                        `json:"result_code"`
	ErrorCodes     []DingConnectError         `json:"error_codes"`
}
```

---

## Implementation Details

### Constructor: NewDingConnectProvider()

```go
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
```

**Key points**:
- Load API key from environment variable (stateless, single key per service)
- Use `http.DefaultClient` for HTTP requests
- Return error if API key is missing (fatal at startup)

### GetUserFromPaymentEvent Implementation

```go
func (p *DingConnectProvider) GetUserFromPaymentEvent(event *PaymentEvent) (*User, error) {
	return GenericGetUser(p.pool, event)
}
```

**Rationale**: DingConnect doesn't require user-specific credentials (API key is global), so we can use the generic user lookup helper that queries the database by facebook_page_id.

### Auth Implementation

**Decision: Lightweight validation or no-op?**

Two acceptable approaches:

**Option A: Stateless No-op** (Simplest, matches DingConnect's stateless API key model)
```go
func (p *DingConnectProvider) Auth(user *User, key string) error {
	return nil
}
```

**Option B: Validate API Key** (More defensive)
```go
func (p *DingConnectProvider) Auth(user *User, key string) error {
	// Validate that API key is set (it was already checked in constructor)
	// This is a no-op at runtime since API key is loaded at startup
	// Could add a GetBalance call here to validate key is active, but that adds latency
	return nil
}
```

**Recommendation**: Use Option A (no-op). The API key is validated at startup in the constructor. Each Payout() call will attempt the SendTransfer and fail with a clear error if the key is invalid.

### Payout Implementation - Step by Step

The Payout method is the core of the provider. Here's the detailed implementation:

#### Step 1: Parse Payment Details

```go
func (p *DingConnectProvider) Payout(event *PaymentEvent) (*Result, error) {
	details := new(DingConnectPaymentDetails)
	err := json.Unmarshal(*event.Details, &details)
	if err != nil {
		return handleJSONUnmarshalError("dingconnect", err, event.Details), nil
	}

	result := &Result{}
	result.Type = "payment:dingconnect"
	result.ID = details.ID
	// ...
}
```

**Details**:
- Use standard JSON unmarshaling to parse event.Details
- Handle JSON parse errors using the existing `handleJSONUnmarshalError()` helper
- Always return (*Result, nil) for payment-specific errors - never (nil, error)

#### Step 2: Validate Required Fields

```go
	// Validate required fields
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
```

**Helper function to add to dingconnect.go**:

```go
func formatDingConnectError(result *Result, event *PaymentEvent, message, code string) *Result {
	result.Success = false
	result.Error = &PaymentError{
		Message:        message,
		Code:           code,
		PaymentDetails: event.Details,
	}
	return result
}
```

#### Step 3: Build SendTransfer Request

```go
	// Build request payload
	reqPayload := map[string]interface{}{
		"sku_code":      details.SkuCode,
		"send_value":    details.SendValue,
		"account_number": details.AccountNumber,
		"distributor_ref": details.DistributorRef,
	}

	// Optional fields
	if details.SendCurrencyIso != "" {
		reqPayload["send_currency_iso"] = details.SendCurrencyIso
	}
	if len(details.Settings) > 0 {
		reqPayload["settings"] = details.Settings
	}

	// Only use instant mode - never set X-Option: DeferTransfer
	reqBody, err := json.Marshal(reqPayload)
	if err != nil {
		return formatDingConnectError(result, event, fmt.Sprintf("Failed to marshal request: %s", err.Error()), "INVALID_PAYMENT_DETAILS"), nil
	}
```

**Key decision**: Only support Instant mode (synchronous processing). The Deferred mode would require webhook handling outside the scope of this provider. All DingConnect requests omit the `X-Option: DeferTransfer` header, so responses include ProcessingState = "Completed" or "Failed".

#### Step 4: Make HTTP Request

```go
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
```

**Key decisions**:
- Use 90-second timeout (matches DingConnect API timeout)
- Add `X-Api-Key` header with the API key (this is how DingConnect authenticates)
- Always include Content-Type and Accept headers
- Never use `X-Option: DeferTransfer` header (instant mode only)
- Return HTTP_REQUEST_FAILED error if request fails

#### Step 5: Parse Response

```go
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return formatDingConnectError(result, event, fmt.Sprintf("Failed to read response: %s", err.Error()), "HTTP_REQUEST_FAILED"), nil
	}

	var dingResp DingConnectResponse
	err = json.Unmarshal(bodyBytes, &dingResp)
	if err != nil {
		return formatDingConnectError(result, event, fmt.Sprintf("Invalid response format: %s", err.Error()), "INVALID_RESPONSE"), nil
	}
```

**Key decisions**:
- Always parse response body, even on HTTP errors
- Response must be valid JSON (DingConnect always returns JSON)
- Store raw response for later inclusion in result.Response

#### Step 6: Check ResultCode and Map to PaymentError

This is the critical business logic section:

```go
	// Check result_code (primary indicator of success/failure)
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
```

**ResultCode Mapping** (from DingConnect API docs):
- `1`: Success → Return Result with Success=true
- `3`: Transient error (temporary issue) → Return Result with error code (will be retried by DinersClub)
- Other values: Permanent failure → Return Result with error code (will not be retried)

**ErrorCode Mapping** (from DingConnect API):
Common error codes from DingConnect that may appear:
- `INSUFFICIENT_BALANCE`: Account balance too low
- `INVALID_ACCOUNT_NUMBER`: Phone number format invalid
- `PROVIDER_UNAVAILABLE`: Mobile operator is down
- `PROVIDER_TIMED_OUT`: Request to operator exceeded 90 seconds
- `DUPLICATE_REFERENCE`: Same distributor_ref submitted twice
- `INVALID_SKU_CODE`: Product SKU not found
- (Others as returned by DingConnect API)

Pass these through as-is in the PaymentError.Code field. DinersClub/botserver will handle displaying them.

#### Step 7: Complete Payout Method

The full method signature:

```go
func (p *DingConnectProvider) Payout(event *PaymentEvent) (*Result, error) {
	// ... all steps above ...
	// Always return (*Result, nil) except for catastrophic failures
	// Return (*Result, error) only for: database errors, context issues, etc.
}
```

---

## Files to Create/Modify

### 1. **NEW FILE: dinersclub/dingconnect.go**

Location: `/home/nandan/Documents/vlab-research/fly/dinersclub/dingconnect.go`

Contents:
- `DingConnectProvider` struct definition
- `DingConnectPaymentDetails` struct definition
- DingConnect response structs (TransferRecord, Error, Response)
- `NewDingConnectProvider()` constructor
- `GetUserFromPaymentEvent()` implementation
- `Auth()` implementation
- `Payout()` implementation (all 7 steps above)
- `formatDingConnectError()` helper function

Imports needed:
```go
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
```

Approximate line count: 250-300 lines

### 2. **NEW FILE: dinersclub/dingconnect_test.go**

Location: `/home/nandan/Documents/vlab-research/fly/dinersclub/dingconnect_test.go`

Contents: Comprehensive unit tests for DingConnectProvider

See "Test Strategy" section below for detailed test cases.

Approximate line count: 400-500 lines

### 3. **MODIFY: dinersclub/main.go**

Location: `/home/nandan/Documents/vlab-research/fly/dinersclub/main.go`

Change the `getProvider()` function (currently lines 190-202):

**Current code**:
```go
func getProvider(pool *pgxpool.Pool, event *PaymentEvent) (Provider, error) {
	switch event.Provider {
	case "fake":
		return NewFakeProvider(getUserFromFakePaymentEvent, auth)
	case "reloadly":
		return NewReloadlyProvider(pool)
	case "giftcard":
		return NewGiftCardsProvider(pool)
	case "http":
		return NewHttpProvider(pool)
	}
	return nil, nil
}
```

**Updated code**:
```go
func getProvider(pool *pgxpool.Pool, event *PaymentEvent) (Provider, error) {
	switch event.Provider {
	case "fake":
		return NewFakeProvider(getUserFromFakePaymentEvent, auth)
	case "reloadly":
		return NewReloadlyProvider(pool)
	case "giftcard":
		return NewGiftCardsProvider(pool)
	case "http":
		return NewHttpProvider(pool)
	case "dingconnect":
		return NewDingConnectProvider(pool)
	}
	return nil, nil
}
```

**Explanation**: Add a new case for "dingconnect" provider type that calls NewDingConnectProvider.

### 4. **MODIFY: dinersclub/.env**

Location: `/home/nandan/Documents/vlab-research/fly/dinersclub/.env`

Add this line:
```bash
DINGCONNECT_API_KEY=your_api_key_here
```

This should be added AFTER existing configuration. The actual API key will come from DingConnect account settings.

### 5. **OPTIONAL: Update dinersclub/README.md**

Location: `/home/nandan/Documents/vlab-research/fly/dinersclub/README.md`

In the provider configuration section, add documentation for DingConnect provider:

```markdown
#### DingConnect Provider

Sends mobile top-ups via DingConnect API (https://api.dingconnect.com)

**Configuration**:
- Environment variable: `DINGCONNECT_API_KEY` (required)
- Provider name: `dingconnect`

**Payment Details Structure** (JSON in PaymentEvent.Details):
```json
{
  "id": "optional_payment_id",
  "sku_code": "US_VERIZON_5GB",
  "send_value": 25.00,
  "send_currency_iso": "USD",
  "account_number": "14155552671",
  "distributor_ref": "unique_txn_id_20260301_001",
  "settings": [{"name": "setting1", "value": "value1"}]
}
```

**Supported Fields**:
- `sku_code` (required): Product SKU from DingConnect GetProducts endpoint
- `account_number` (required): Target phone number or account identifier
- `distributor_ref` (required): Unique ID for deduplication
- `send_value` (required): Amount to transfer (must be positive)
- `send_currency_iso` (optional): Currency code (defaults to USD)
- `id` (optional): Payment ID for tracking
- `settings` (optional): Provider-specific settings

**Processing Mode**: Instant mode only (synchronous)

**Error Codes**: Returns DingConnect error codes directly (e.g., INSUFFICIENT_BALANCE, INVALID_ACCOUNT_NUMBER)
```

---

## Test Strategy

### Test Organization

Create `dinersclub/dingconnect_test.go` with the following test categories:

### Category 1: JSON Parsing Tests

**Test: TestDingConnectPayout_InvalidJsonDetails**
- Input: Malformed JSON in event.Details
- Expected: handleJSONUnmarshalError returns INVALID_JSON_FORMAT error
- Setup: None (no DB needed)

**Test: TestDingConnectPayout_MissingRequiredFields**
- Input: Valid JSON but missing sku_code, account_number, or distributor_ref
- Expected: Result with error code INVALID_PAYMENT_DETAILS
- Setup: None

**Test: TestDingConnectPayout_NegativeSendValue**
- Input: send_value is 0 or negative
- Expected: Result with error code INVALID_PAYMENT_DETAILS
- Setup: None

### Category 2: HTTP Request Tests

**Test: TestDingConnectPayout_SendsPostRequest**
- Input: Valid payment details
- Mock: HTTP server that verifies request structure
- Expected: Verify request has:
  - Method: POST
  - URL: https://api.dingconnect.com/api/V1/SendTransfer
  - Header: X-Api-Key with correct API key
  - Header: Content-Type: application/json
  - Body: Correctly marshaled JSON
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_IncludesOptionalFields**
- Input: Payment details with send_currency_iso and settings
- Mock: HTTP server that captures request
- Expected: Verify optional fields are included in request JSON
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_OmitsOptionalFields**
- Input: Payment details without send_currency_iso or settings
- Mock: HTTP server that captures request
- Expected: Verify optional fields are NOT in request JSON
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_HttpRequestFails**
- Input: Valid payment details
- Mock: HTTP client returns network error
- Expected: Result with error code HTTP_REQUEST_FAILED
- Setup: Mock HTTP client that returns error

### Category 3: Response Parsing Tests

**Test: TestDingConnectPayout_SuccessWithResultCode1**
- Input: Valid payment details
- Mock: HTTP 200 with result_code=1, transfer_record with ProcessingState="Completed"
- Expected: Result.Success=true, response included, timestamp set
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_InvalidJsonResponse**
- Input: Valid payment details
- Mock: HTTP 200 with malformed JSON response
- Expected: Result with error code INVALID_RESPONSE
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_MissingTransferRecord**
- Input: Valid payment details
- Mock: HTTP 200 with result_code=1 but transfer_record=null
- Expected: Result with error code INVALID_RESPONSE
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_TransientErrorWithResultCode3**
- Input: Valid payment details
- Mock: HTTP 200 with result_code=3, error_codes array
- Expected: Result.Success=false, error code from error_codes[0].Code
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_FailureWithErrorCodes**
- Input: Valid payment details
- Mock: HTTP 200 with result_code=2 (or other non-1, non-3), error_codes array
- Expected: Result.Success=false, error code from error_codes[0].Code
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_FailureWithNoErrorCodes**
- Input: Valid payment details
- Mock: HTTP 200 with result_code=2, empty error_codes array
- Expected: Result.Success=false, error code "PAYMENT_FAILED"
- Setup: Mock HTTP client

### Category 4: Authentication Tests

**Test: TestNewDingConnectProvider_MissingApiKey**
- Input: DINGCONNECT_API_KEY not set in environment
- Expected: NewDingConnectProvider returns error
- Setup: Clear environment variable before test

**Test: TestDingConnectProviderAuth_IsNoOp**
- Input: Any user and key
- Expected: Auth returns nil (no-op)
- Setup: Create provider with valid API key

**Test: TestDingConnectProviderGetUser_UsesGenericLookup**
- Input: PaymentEvent with pageid
- Mock: Database with user/facebook_page mapping
- Expected: User is returned from database
- Setup: Insert test data, use real connection pool

### Category 5: Error Code Mapping Tests

**Test: TestDingConnectPayout_MapsInsufficientBalance**
- Input: Valid payment details
- Mock: HTTP 200 with result_code=3, error_codes=[{"code":"INSUFFICIENT_BALANCE","context":"Required: $25, Available: $10"}]
- Expected: Result.Error.Code="INSUFFICIENT_BALANCE", Result.Error.Message includes context
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_MapsInvalidAccountNumber**
- Input: Valid payment details
- Mock: HTTP 200 with result_code=3, error_codes=[{"code":"INVALID_ACCOUNT_NUMBER","context":"..."}]
- Expected: Result.Error.Code="INVALID_ACCOUNT_NUMBER"
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_MapsProviderUnavailable**
- Input: Valid payment details
- Mock: HTTP 200 with error_codes=[{"code":"PROVIDER_UNAVAILABLE","context":"..."}]
- Expected: Result.Error.Code="PROVIDER_UNAVAILABLE"
- Setup: Mock HTTP client

### Category 6: Response Field Extraction Tests

**Test: TestDingConnectPayout_IncludesResponseInResult**
- Input: Valid payment details with success response
- Mock: HTTP 200 with result_code=1 and large transfer_record JSON
- Expected: Result.Response includes full response body as JSON
- Setup: Mock HTTP client

**Test: TestDingConnectPayout_IncludesPaymentDetails**
- Input: Valid payment details
- Mock: HTTP 200 with result_code=1
- Expected: Result.PaymentDetails equals original event.Details
- Setup: Mock HTTP client

---

## Test Implementation Patterns

Use these patterns when writing tests:

### Pattern 1: Mock HTTP Client

```go
func TestDingConnectPayout_ExampleTest(t *testing.T) {
	// Create mock response
	response := `{
		"transfer_record": {
			"transfer_id": {"distributor_id": "test", "ding_id": "123"},
			"sku_code": "US_VERIZON_5GB",
			"processing_state": "Completed",
			"account_number": "14155552671"
		},
		"result_code": 1,
		"error_codes": []
	}`

	tc := TestClient(200, response, nil)

	p := &DingConnectProvider{
		client: tc,
		apiKey: "test_key",
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))

	event := &PaymentEvent{Details: &details}

	res, err := p.Payout(event)

	assert.Nil(t, err)
	assert.True(t, res.Success)
	// Additional assertions...
}
```

### Pattern 2: Database Setup

```go
func TestDingConnectProviderGetUser(t *testing.T) {
	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()
	before(t, pool)  // Clean up DB

	// Insert test user
	insertUserSql := `
		INSERT INTO users(id, email)
		VALUES ('00000000-0000-0000-0000-000000000000', 'test@test.com');
	`
	mustExec(t, pool, insertUserSql)

	// Insert facebook_page credential
	insertCredsSQL := `
		INSERT INTO credentials(userid, facebook_page_id)
		VALUES ('00000000-0000-0000-0000-000000000000', 'page123');
	`
	mustExec(t, pool, insertCredsSQL)

	p := &DingConnectProvider{pool: pool}
	event := &PaymentEvent{Pageid: "page123"}

	user, err := p.GetUserFromPaymentEvent(event)

	assert.Nil(t, err)
	assert.NotNil(t, user)
	assert.Equal(t, "00000000-0000-0000-0000-000000000000", user.Id)
}
```

### Pattern 3: Error Assertion

```go
func TestDingConnectPayout_ErrorCase(t *testing.T) {
	// ... setup ...

	res, err := p.Payout(event)

	assert.Nil(t, err)  // Payout never returns error for payment failures
	assert.NotNil(t, res)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_ACCOUNT_NUMBER", res.Error.Code)
	assert.True(t, len(res.Error.Message) > 0)
}
```

---

## Acceptance Criteria

A complete implementation must satisfy all of these criteria:

### Code Criteria

1. **Files created**: `dingconnect.go` and `dingconnect_test.go` exist in dinersclub package
2. **Files modified**: `main.go` includes dingconnect case in getProvider() switch statement
3. **Imports correct**: All imports in dingconnect.go resolve without errors
4. **No compilation errors**: `go build ./dinersclub/` runs successfully
5. **All tests pass**: `go test ./dinersclub/...` passes all tests
6. **No warnings**: `golangci-lint run ./dinersclub/` produces no issues
7. **Interface implemented**: DingConnectProvider implements Provider interface completely

### Functional Criteria

1. **Auth method**: Can be called without error (returns nil)
2. **GetUserFromPaymentEvent method**: Queries database correctly using facebook_page_id
3. **Payout method**: Accepts PaymentEvent, returns Result with proper structure
4. **Success path**: When API returns result_code=1, Result.Success=true
5. **Error mapping**: When API returns error_codes, they're mapped to PaymentError.Code
6. **Transient errors**: When API returns result_code=3, error is mapped as retryable
7. **JSON parsing**: Handles malformed details JSON gracefully
8. **HTTP errors**: Network failures return HTTP_REQUEST_FAILED error code
9. **API key**: X-Api-Key header is included in all requests

### Integration Criteria

1. **Provider registration**: "dingconnect" can be added to DINERSCLUB_PROVIDERS env var
2. **Database integration**: GenericGetUser works correctly with real database
3. **Kafka flow**: Provider can be invoked from PaymentEvent with provider="dingconnect"
4. **Error handling**: Errors are sent to botserver with correct format
5. **Caching**: Provider can be cached after Auth() call (provider remains stateless after Auth)

### Testing Criteria

1. **Unit test coverage**: All public methods have tests
2. **Error cases**: At least 5 error scenarios tested
3. **Success case**: Happy path tested with mock response
4. **Edge cases**: Empty fields, optional fields, missing data tested
5. **Response parsing**: JSON parsing and error code mapping tested
6. **Database**: At least one test uses real database pool

### Documentation Criteria

1. **Code comments**: All exported types and functions have comments
2. **Struct fields**: All struct fields have `json` tags
3. **Constants**: Magic values (e.g., 90-second timeout) explained
4. **Error codes**: Mapping between DingConnect and PaymentError codes documented

---

## Integration Testing End-to-End

After implementation, verify the full flow works:

### Manual Integration Test Steps

1. **Setup environment**:
   ```bash
   cd /home/nandan/Documents/vlab-research/fly/dinersclub
   export DINGCONNECT_API_KEY="<real_key_from_dingconnect>"
   export DINERSCLUB_PROVIDERS="fake,reloadly,giftcard,http,dingconnect"
   ```

2. **Build application**:
   ```bash
   go build -o dinersclub .
   ```

3. **Create test Kafka message**:
   ```json
   {
     "userid": "test-user-123",
     "pageid": "page123",
     "timestamp": 1704067200000,
     "provider": "dingconnect",
     "key": "",
     "details": {
       "id": "test-payment-001",
       "sku_code": "US_VERIZON_5GB",
       "send_value": 25.00,
       "account_number": "14155552671",
       "distributor_ref": "TXN20260301_001"
     }
   }
   ```

4. **Verify provider selection**:
   - Message is routed to DingConnect provider (check logs)
   - User is looked up from database correctly
   - Auth is called and succeeds

5. **Verify API call**:
   - Request is sent to https://api.dingconnect.com/api/V1/SendTransfer
   - X-Api-Key header is present with correct value
   - Request body has all required fields

6. **Verify response handling**:
   - Response is parsed correctly
   - result_code is checked
   - Result is sent to botserver

---

## Known Limitations & Future Work

### Current Implementation Scope

- **Instant mode only**: No webhook/deferred processing support
- **Single API key**: No per-user credential management (unlike Reloadly)
- **No preprocessing**: Assumes sku_code is provided in PaymentEvent.Details (no automatic lookup from GetProducts)
- **Error codes passed through**: No translation layer for DingConnect codes to generic codes

### Potential Enhancements

1. **Add validation caching**: Cache available sku_codes from GetProducts
2. **Implement balance checking**: Optional GetBalance call before Payout
3. **Add retry logic for transient errors**: Handle result_code=3 with exponential backoff
4. **Support deferred mode**: Add webhook handler for batch/deferred transfers
5. **Implement reconciliation**: Add ListTransferRecords query for daily settlement

---

## Rollback Plan

If implementation has critical bugs:

1. **Remove from DINERSCLUB_PROVIDERS**: Remove "dingconnect" from env var
2. **Revert changes**: `git revert` commits that added dingconnect support
3. **Delete files**: Remove dingconnect.go and dingconnect_test.go
4. **Verify**: Run tests, ensure other providers still work

This ensures the system continues operating with existing providers while the new provider is fixed.

---

## References

- **DinersClub Architecture**: `/home/nandan/Documents/vlab-research/fly/planning/dinersclub-findings.md`
- **DingConnect API Docs**: `/home/nandan/Documents/vlab-research/fly/planning/dingconnect-api-findings.md`
- **Existing Provider Examples**:
  - HttpProvider: `/home/nandan/Documents/vlab-research/fly/dinersclub/http_provider.go` (generic HTTP)
  - ReloadlyProvider: `/home/nandan/Documents/vlab-research/fly/dinersclub/reloadly.go` (SDK-based)
  - FakeProvider: `/home/nandan/Documents/vlab-research/fly/dinersclub/fake.go` (testing)
- **Provider Interface**: `/home/nandan/Documents/vlab-research/fly/dinersclub/provider.go`
- **Main Loop**: `/home/nandu/Documents/vlab-research/fly/dinersclub/main.go`

---

## Status Summary

- **Plan created**: March 1, 2026
- **Next steps**: Ready for implementation by fullstack-engineer
- **Estimated effort**: 4-6 hours (including tests and integration verification)
- **Complexity**: Medium (straightforward HTTP API integration following established patterns)
- **Risk**: Low (similar to HttpProvider, with clearer API contract than Reloadly)
