package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/vlab-research/dingconnect"
)

func init() {
	// Set required environment variables for tests that use getConfig()
	os.Setenv("CACHE_TTL", "1h")
	os.Setenv("CACHE_NUM_COUNTERS", "10000")
	os.Setenv("CACHE_MAX_COST", "10000")
	os.Setenv("CACHE_BUFFER_ITEMS", "64")
	os.Setenv("CHATBASE_DATABASE", "chatroach")
	os.Setenv("CHATBASE_HOST", "localhost")
	// 5433 is the canonical test database: `make test-db` in devops/ creates it
	// (devops/Makefile PORT=5433) and every other module targets it. 26257 came
	// from ./.env, i.e. the production port -- pointing the suite at whatever
	// happened to be listening there.
	os.Setenv("CHATBASE_PORT", "5433")
	os.Setenv("CHATBASE_USER", "root")
	os.Setenv("CHATBASE_MAX_CONNECTIONS", "10")
	os.Setenv("KAFKA_BROKERS", "localhost:9092")
	os.Setenv("KAFKA_TOPIC", "vlab-payment")
	os.Setenv("KAFKA_GROUP", "dinersclub")
	os.Setenv("KAFKA_POLL_TIMEOUT", "1s")
	os.Setenv("DINERSCLUB_BATCH_SIZE", "100")
	os.Setenv("DINERSCLUB_PROVIDERS", "fake,reloadly,giftcard,http,dingconnect")
	// Processing knobs below must match ./test-env, NOT the production values
	// in ./.env. Two tests depend on them:
	//   - TestDinersClubCache asserts 1 cache miss + 2 hits, which only holds
	//     when the worker pool is serial. At pool size 10 all three messages
	//     race through cache.Get() before the first SetWithTTL lands, giving
	//     3 misses / 0 hits.
	//   - TestDinersClubRepeatsOnServerErrorFromBotserver asserts exactly 3
	//     botserver attempts. Attempt count is governed by the backoff's
	//     MaxElapsedTime (= RETRY_BOTSERVER) and its randomization factor, so
	//     it needs the 1s budget and a factor of 0, not the production 2m/0.5.
	os.Setenv("DINERSCLUB_POOL_SIZE", "1")
	os.Setenv("DINERSCLUB_RETRY_PROVIDER", "1s")
	os.Setenv("DINERSCLUB_RETRY_BOTSERVER", "1s")
	os.Setenv("BACK_OFF_RANDOM_FACTOR", "0")
	os.Setenv("RELOADLY_SANDBOX", "true")
	os.Setenv("BOTSERVER_URL", "http://localhost:8080/synthetic")
}

// dingProvider returns a provider whose client talks to a stub API.
//
// Note what this replaces: the previous version of these tests rewrote request
// URLs through a custom RoundTripper, which meant the stub never saw the real
// request the provider would have sent in production. Pointing the client's
// base URL at an httptest server keeps the request path honest.
func dingProvider(t *testing.T, h http.HandlerFunc) *DingConnectProvider {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &DingConnectProvider{
		client: dingconnect.New("test_api_key_123", dingconnect.WithBaseURL(srv.URL)),
	}
}

// dingRespond writes a canned response body.
func dingRespond(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}
}

// event builds a PaymentEvent from researcher-facing (snake_case) details.
func dingEvent(details string) *PaymentEvent {
	d := json.RawMessage([]byte(details))
	return &PaymentEvent{Details: &d}
}

const validDingDetails = `{
	"id": "PAY001",
	"sku_code": "US_VERIZON_5GB",
	"send_value": 25.00,
	"account_number": "14155552671",
	"distributor_ref": "TXN001"
}`

// successResponse is a realistic SendTransfer success body. Every field is
// PascalCase, matching the live API.
const dingSuccessResponse = `{
	"TransferRecord": {
		"TransferId": {"DistributorRef": "TXN001", "TransferRef": "DC123456"},
		"SkuCode": "US_VERIZON_5GB",
		"Price": {"SendValue": 25.00, "ReceiveValue": 5.00, "SendCurrencyIso": "USD", "ReceiveCurrencyIso": "USD"},
		"CommissionApplied": 5.00,
		"StartedUtc": "2026-03-01T14:30:00Z",
		"CompletedUtc": "2026-03-01T14:30:45Z",
		"ProcessingState": "Completed",
		"ReceiptText": "Success",
		"AccountNumber": "14155552671"
	},
	"ResultCode": 1,
	"ErrorCodes": []
}`

// TestDingConnectAuth_FetchesFromDatabase verifies that Auth() fetches credentials from the database.
func TestDingConnectAuth_FetchesFromDatabase(t *testing.T) {
	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	before(t, pool)

	// Insert test user
	insertUserSql := `
		INSERT INTO users(id, email)
		VALUES ('00000000-0000-0000-0000-000000000000', 'test@test.com');
	`
	mustExec(t, pool, insertUserSql)

	// Insert DingConnect credentials
	insertDingConnectSql := `
		INSERT INTO credentials(userid, entity, key, details)
		VALUES ('00000000-0000-0000-0000-000000000000', 'dingconnect', 'test-key', '{"api_key": "test_api_key_12345"}');
	`
	mustExec(t, pool, insertDingConnectSql)

	provider, err := NewDingConnectProvider(pool)
	assert.Nil(t, err)
	assert.NotNil(t, provider)

	user := &User{Id: "00000000-0000-0000-0000-000000000000"}
	err = provider.Auth(user, "test-key")
	assert.Nil(t, err)

	// Auth builds the client from the stored key.
	p := provider.(*DingConnectProvider)
	assert.NotNil(t, p.client)
}

// TestDingConnectAuth_MissingCredentials verifies error when credentials not found.
func TestDingConnectAuth_MissingCredentials(t *testing.T) {
	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	before(t, pool)

	// Insert test user but no credentials
	insertUserSql := `
		INSERT INTO users(id, email)
		VALUES ('00000000-0000-0000-0000-000000000000', 'test@test.com');
	`
	mustExec(t, pool, insertUserSql)

	provider, err := NewDingConnectProvider(pool)
	assert.Nil(t, err)

	user := &User{Id: "00000000-0000-0000-0000-000000000000"}
	err = provider.Auth(user, "test-key")
	assert.NotNil(t, err)
	assert.Contains(t, err.Error(), "No dingconnect credentials were found for user")
}

// TestDingConnectAuth_EmptyKey verifies error when key parameter is empty.
func TestDingConnectAuth_EmptyKey(t *testing.T) {
	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	before(t, pool)

	provider, err := NewDingConnectProvider(pool)
	assert.Nil(t, err)

	user := &User{Id: "00000000-0000-0000-0000-000000000000"}
	err = provider.Auth(user, "")
	assert.NotNil(t, err)
	assert.Contains(t, err.Error(), "No key provided for DingConnect provider")
}

// TestDingConnectAuth_InvalidJSON verifies error when credentials JSON is missing the api_key field.
func TestDingConnectAuth_InvalidJSON(t *testing.T) {
	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	before(t, pool)

	// Insert test user
	insertUserSql := `
		INSERT INTO users(id, email)
		VALUES ('00000000-0000-0000-0000-000000000000', 'test@test.com');
	`
	mustExec(t, pool, insertUserSql)

	// Insert DingConnect credentials with valid JSON but missing the required api_key field
	insertDingConnectSql := `
		INSERT INTO credentials(userid, entity, key, details)
		VALUES ('00000000-0000-0000-0000-000000000000', 'dingconnect', 'test-key', '{"wrong_field": "value"}');
	`
	mustExec(t, pool, insertDingConnectSql)

	provider, err := NewDingConnectProvider(pool)
	assert.Nil(t, err)

	user := &User{Id: "00000000-0000-0000-0000-000000000000"}
	err = provider.Auth(user, "test-key")
	assert.NotNil(t, err)
}

// TestDingConnectRequestFormat is the regression test for the two defects that
// made every production DingConnect payout fail: the provider authenticated on
// the X-Api-Key header, which DingConnect rejects with HTTP 401, and it sent
// snake_case field names, which DingConnect silently ignores.
//
// The details a researcher writes stay snake_case -- that is vlab's own event
// contract. Only the outbound request must be PascalCase.
func TestDingConnectRequestFormat(t *testing.T) {
	var gotPath, gotMethod string
	var gotHeaders http.Header
	var gotBody map[string]interface{}

	p := dingProvider(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod, gotHeaders = r.URL.Path, r.Method, r.Header
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &gotBody)
		dingRespond(200, dingSuccessResponse)(w, r)
	})

	res, err := p.Payout(dingEvent(validDingDetails))
	assert.Nil(t, err)
	assert.True(t, res.Success)

	assert.Equal(t, "POST", gotMethod)
	assert.Equal(t, "/SendTransfer", gotPath)

	// Authentication is the api_key header, not X-Api-Key.
	assert.Equal(t, "test_api_key_123", gotHeaders.Get("api_key"))
	assert.Empty(t, gotHeaders.Get("X-Api-Key"), "X-Api-Key is rejected by DingConnect with HTTP 401")
	assert.Equal(t, "application/json", gotHeaders.Get("Content-Type"))
	assert.Equal(t, "application/json", gotHeaders.Get("Accept"))

	// The wire format is PascalCase.
	assert.Equal(t, "US_VERIZON_5GB", gotBody["SkuCode"])
	assert.Equal(t, 25.00, gotBody["SendValue"])
	assert.Equal(t, "14155552671", gotBody["AccountNumber"])
	assert.Equal(t, "TXN001", gotBody["DistributorRef"])

	// snake_case keys are silently ignored by DingConnect, so their presence
	// would mean a request that looks fine but does nothing.
	for _, k := range []string{"sku_code", "send_value", "account_number", "distributor_ref"} {
		_, present := gotBody[k]
		assert.False(t, present, "request must not contain snake_case key %q", k)
	}
}

// TestDingConnectPayout_Success verifies a completed transfer.
func TestDingConnectPayout_Success(t *testing.T) {
	p := dingProvider(t, dingRespond(200, dingSuccessResponse))

	res, err := p.Payout(dingEvent(validDingDetails))

	assert.Nil(t, err)
	assert.True(t, res.Success)
	assert.Equal(t, "payment:dingconnect", res.Type)
	assert.Equal(t, "PAY001", res.ID)
	assert.Nil(t, res.Error)
	assert.NotNil(t, res.PaymentDetails)
	assert.NotNil(t, res.Response)
}

// TestDingConnectPayout_OptionalFields verifies currency and settings reach the wire.
func TestDingConnectPayout_OptionalFields(t *testing.T) {
	var gotBody map[string]interface{}
	p := dingProvider(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &gotBody)
		dingRespond(200, dingSuccessResponse)(w, r)
	})

	res, err := p.Payout(dingEvent(`{
		"sku_code": "NG_4X_TopUp",
		"send_value": 25.00,
		"send_currency_iso": "USD",
		"account_number": "14155552671",
		"distributor_ref": "TXN001",
		"settings": [{"name": "MeterId", "value": "123456"}]
	}`))

	assert.Nil(t, err)
	assert.True(t, res.Success)
	assert.Equal(t, "USD", gotBody["SendCurrencyIso"])

	settings, ok := gotBody["Settings"].([]interface{})
	assert.True(t, ok, "Settings must be present")
	assert.Len(t, settings, 1)
	first := settings[0].(map[string]interface{})
	assert.Equal(t, "MeterId", first["Name"])
	assert.Equal(t, "123456", first["Value"])
}

// TestDingConnectPayout_OmitsOptionalFields keeps absent options off the wire.
func TestDingConnectPayout_OmitsOptionalFields(t *testing.T) {
	var gotBody map[string]interface{}
	p := dingProvider(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &gotBody)
		dingRespond(200, dingSuccessResponse)(w, r)
	})

	_, err := p.Payout(dingEvent(validDingDetails))
	assert.Nil(t, err)

	for _, k := range []string{"SendCurrencyIso", "Settings", "ValidateOnly"} {
		_, present := gotBody[k]
		assert.False(t, present, "%q must be omitted when not set", k)
	}
}

// TestDingConnectPayout_ValidationErrors covers malformed survey configuration,
// which is reported without a network call.
func TestDingConnectPayout_ValidationErrors(t *testing.T) {
	tests := []struct {
		name    string
		details string
		wantMsg string
	}{
		{"missing sku_code", `{"send_value": 25.0, "account_number": "1", "distributor_ref": "r"}`, "Missing sku_code"},
		{"missing account_number", `{"sku_code": "S", "send_value": 25.0, "distributor_ref": "r"}`, "Missing account_number"},
		{"missing distributor_ref", `{"sku_code": "S", "send_value": 25.0, "account_number": "1"}`, "Missing distributor_ref"},
		{"zero send_value", `{"sku_code": "S", "send_value": 0, "account_number": "1", "distributor_ref": "r"}`, "send_value must be positive"},
		{"negative send_value", `{"sku_code": "S", "send_value": -5, "account_number": "1", "distributor_ref": "r"}`, "send_value must be positive"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			p := dingProvider(t, func(w http.ResponseWriter, r *http.Request) {
				called = true
				dingRespond(200, dingSuccessResponse)(w, r)
			})

			res, err := p.Payout(dingEvent(tt.details))

			assert.Nil(t, err)
			assert.False(t, res.Success)
			assert.Equal(t, "INVALID_PAYMENT_DETAILS", res.Error.Code)
			assert.Equal(t, tt.wantMsg, res.Error.Message)
			assert.False(t, called, "invalid details must not reach the API")
		})
	}
}

// TestDingConnectPayout_InvalidJsonDetails verifies malformed JSON is handled gracefully.
func TestDingConnectPayout_InvalidJsonDetails(t *testing.T) {
	p := dingProvider(t, dingRespond(200, dingSuccessResponse))

	res, err := p.Payout(dingEvent(`{invalid json`))

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_JSON_FORMAT", res.Error.Code)
}

// TestDingConnectPayout_ErrorCodeMapping checks that DingConnect's own error
// code reaches the Result, so an operator can look the failure up directly.
//
// InsufficientBalance is the important row: DingConnect returns it with HTTP
// 500 despite it being permanent, so it must not be mistaken for a transient
// server fault.
func TestDingConnectPayout_ErrorCodeMapping(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		body     string
		wantCode string
	}{
		{
			"insufficient balance arrives as HTTP 500",
			500,
			`{"TransferRecord":{"SkuCode":"S","ProcessingState":"Failed"},"ResultCode":5,"ErrorCodes":[{"Code":"InsufficientBalance"}]}`,
			"InsufficientBalance",
		},
		{
			"invalid account number",
			200,
			`{"TransferRecord":null,"ResultCode":4,"ErrorCodes":[{"Code":"AccountNumberInvalid"}]}`,
			"AccountNumberInvalid",
		},
		{
			"transient provider error",
			200,
			`{"TransferRecord":null,"ResultCode":3,"ErrorCodes":[{"Code":"TransientProviderError"}]}`,
			"TransientProviderError",
		},
		{
			"recharge not allowed",
			200,
			`{"TransferRecord":null,"ResultCode":5,"ErrorCodes":[{"Code":"RechargeNotAllowed"}]}`,
			"RechargeNotAllowed",
		},
		{
			"duplicate transaction prevented",
			200,
			`{"TransferRecord":null,"ResultCode":5,"ErrorCodes":[{"Code":"DuplicateTransactionPrevented"}]}`,
			"DuplicateTransactionPrevented",
		},
		{
			"authentication failed",
			401,
			`{"ResultCode":4,"ErrorCodes":[{"Code":"AuthenticationFailed"}]}`,
			"AuthenticationFailed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := dingProvider(t, dingRespond(tt.status, tt.body))

			res, err := p.Payout(dingEvent(validDingDetails))

			assert.Nil(t, err, "payment failures are Results, not errors")
			assert.False(t, res.Success)
			assert.Equal(t, tt.wantCode, res.Error.Code)
			assert.NotNil(t, res.Error.PaymentDetails)
		})
	}
}

// TestDingConnectPayout_FailureWithoutErrorCodes covers non-success results
// that carry no error code at all, for both the transient and permanent
// classes. Falling back to the result code keeps the failure attributable
// instead of silently empty.
func TestDingConnectPayout_FailureWithoutErrorCodes(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{"permanent failure", `{"TransferRecord":null,"ResultCode":5,"ErrorCodes":[]}`, "result code: 5"},
		{"transient failure", `{"TransferRecord":null,"ResultCode":3,"ErrorCodes":[]}`, "result code: 3"},
		{"partial result", `{"TransferRecord":null,"ResultCode":2,"ErrorCodes":[]}`, "result code: 2"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := dingProvider(t, dingRespond(200, tt.body))

			res, err := p.Payout(dingEvent(validDingDetails))

			assert.Nil(t, err)
			assert.False(t, res.Success)
			assert.Equal(t, "PAYMENT_FAILED", res.Error.Code)
			assert.Contains(t, res.Error.Message, tt.want)
		})
	}
}

// TestDingConnectPayout_PartialResultIsNotSuccess pins that ResultCode 2
// ("nearest match") never counts as a completed payment. It means DingConnect
// did something other than what was asked, which for a transfer must not be
// reported as success.
func TestDingConnectPayout_PartialResultIsNotSuccess(t *testing.T) {
	p := dingProvider(t, dingRespond(200, `{
		"TransferRecord": {"SkuCode": "S", "ProcessingState": "Completed", "AccountNumber": "1"},
		"ResultCode": 2, "ErrorCodes": [{"Code": "NearestMatch"}]
	}`))

	res, err := p.Payout(dingEvent(validDingDetails))

	assert.Nil(t, err)
	assert.False(t, res.Success, "a nearest-match transfer must not be reported as success")
	assert.Equal(t, "NearestMatch", res.Error.Code)
}

// TestDingConnectPayout_MissingTransferRecord guards against reporting success
// when the API claims success but returns nothing to prove it.
func TestDingConnectPayout_MissingTransferRecord(t *testing.T) {
	p := dingProvider(t, dingRespond(200, `{"TransferRecord":null,"ResultCode":1,"ErrorCodes":[]}`))

	res, err := p.Payout(dingEvent(validDingDetails))

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_RESPONSE", res.Error.Code)
}

// TestDingConnectPayout_UnexpectedProcessingState guards the same way against a
// success code paired with a state that is not Completed. Treating that as a
// success would credit a payment that never landed.
func TestDingConnectPayout_UnexpectedProcessingState(t *testing.T) {
	p := dingProvider(t, dingRespond(200, `{
		"TransferRecord": {"SkuCode": "S", "ProcessingState": "Submitted", "AccountNumber": "1"},
		"ResultCode": 1, "ErrorCodes": []
	}`))

	res, err := p.Payout(dingEvent(validDingDetails))

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_RESPONSE", res.Error.Code)
	assert.Contains(t, res.Error.Message, "Submitted")
}

// TestDingConnectPayout_MalformedResponseJson covers an undecodable body.
func TestDingConnectPayout_MalformedResponseJson(t *testing.T) {
	p := dingProvider(t, dingRespond(200, `{not json at all`))

	res, err := p.Payout(dingEvent(validDingDetails))

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "HTTP_REQUEST_FAILED", res.Error.Code)
}

// TestDingConnectPayout_HttpRequestFails covers a dead endpoint.
func TestDingConnectPayout_HttpRequestFails(t *testing.T) {
	p := &DingConnectProvider{
		// Port 1 is reserved and never listening.
		client: dingconnect.New("k", dingconnect.WithBaseURL("http://127.0.0.1:1")),
	}

	res, err := p.Payout(dingEvent(validDingDetails))

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "HTTP_REQUEST_FAILED", res.Error.Code)
}

// TestDingConnectPayout_RecordsResponseOnFailure verifies the raw response is
// retained for failed payments, since a declined transfer still carries a
// record worth keeping.
func TestDingConnectPayout_RecordsResponseOnFailure(t *testing.T) {
	p := dingProvider(t, dingRespond(500,
		`{"TransferRecord":{"SkuCode":"US_VERIZON_5GB","ProcessingState":"Failed"},"ResultCode":5,"ErrorCodes":[{"Code":"InsufficientBalance"}]}`))

	res, err := p.Payout(dingEvent(validDingDetails))

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.NotNil(t, res.Response)
	assert.Contains(t, string(*res.Response), "US_VERIZON_5GB")
}
