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
)

func init() {
	// Set required environment variables for tests that use getConfig()
	os.Setenv("CACHE_TTL", "1h")
	os.Setenv("CACHE_NUM_COUNTERS", "10000")
	os.Setenv("CACHE_MAX_COST", "10000")
	os.Setenv("CACHE_BUFFER_ITEMS", "64")
	os.Setenv("CHATBASE_DATABASE", "chatroach")
	os.Setenv("CHATBASE_HOST", "localhost")
	os.Setenv("CHATBASE_PORT", "26257")
	os.Setenv("CHATBASE_USER", "root")
	os.Setenv("CHATBASE_MAX_CONNECTIONS", "10")
	os.Setenv("KAFKA_BROKERS", "localhost:9092")
	os.Setenv("KAFKA_TOPIC", "vlab-payment")
	os.Setenv("KAFKA_GROUP", "dinersclub")
	os.Setenv("KAFKA_POLL_TIMEOUT", "1s")
	os.Setenv("DINERSCLUB_BATCH_SIZE", "100")
	os.Setenv("DINERSCLUB_PROVIDERS", "fake,reloadly,giftcard,http,dingconnect")
	os.Setenv("DINERSCLUB_POOL_SIZE", "10")
	os.Setenv("DINERSCLUB_RETRY_PROVIDER", "2m")
	os.Setenv("DINERSCLUB_RETRY_BOTSERVER", "2m")
	os.Setenv("RELOADLY_SANDBOX", "true")
	os.Setenv("BOTSERVER_URL", "http://localhost:8080/synthetic")
}

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

	// Verify the API key was set
	p := provider.(*DingConnectProvider)
	assert.Equal(t, "test_api_key_12345", p.apiKey)
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

// TestDingConnectPayout_InvalidJsonDetails verifies malformed JSON in details is handled gracefully.
func TestDingConnectPayout_InvalidJsonDetails(t *testing.T) {
	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: nil,
		pool:   nil,
	}

	// Malformed JSON
	details := json.RawMessage(`{"invalid json}`)
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.NotNil(t, res)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_JSON_FORMAT", res.Error.Code)
	assert.Contains(t, res.Error.Message, "Invalid dingconnect payment details format")
	assert.Equal(t, "payment:dingconnect", res.Type)
}

// TestDingConnectPayout_MissingSkuCode verifies missing sku_code returns INVALID_PAYMENT_DETAILS error.
func TestDingConnectPayout_MissingSkuCode(t *testing.T) {
	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: nil,
		pool:   nil,
	}

	// Missing sku_code
	details := json.RawMessage([]byte(`{
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.NotNil(t, res)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_PAYMENT_DETAILS", res.Error.Code)
	assert.Contains(t, res.Error.Message, "Missing sku_code")
}

// TestDingConnectPayout_MissingAccountNumber verifies missing account_number returns INVALID_PAYMENT_DETAILS error.
func TestDingConnectPayout_MissingAccountNumber(t *testing.T) {
	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: nil,
		pool:   nil,
	}

	// Missing account_number
	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.NotNil(t, res)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_PAYMENT_DETAILS", res.Error.Code)
	assert.Contains(t, res.Error.Message, "Missing account_number")
}

// TestDingConnectPayout_MissingDistributorRef verifies missing distributor_ref returns INVALID_PAYMENT_DETAILS error.
func TestDingConnectPayout_MissingDistributorRef(t *testing.T) {
	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: nil,
		pool:   nil,
	}

	// Missing distributor_ref
	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.NotNil(t, res)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_PAYMENT_DETAILS", res.Error.Code)
	assert.Contains(t, res.Error.Message, "Missing distributor_ref")
}

// TestDingConnectPayout_NegativeSendValue verifies send_value <= 0 returns INVALID_PAYMENT_DETAILS error.
func TestDingConnectPayout_NegativeSendValue(t *testing.T) {
	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: nil,
		pool:   nil,
	}

	// send_value is 0
	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 0,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.NotNil(t, res)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_PAYMENT_DETAILS", res.Error.Code)
	assert.Contains(t, res.Error.Message, "send_value must be positive")
}

// TestDingConnectPayout_SuccessWithResultCode1 verifies successful payout with result_code=1.
func TestDingConnectPayout_SuccessWithResultCode1(t *testing.T) {
	response := `{
		"transfer_record": {
			"transfer_id": {
				"distributor_id": "TXN001",
				"ding_id": "DC123456"
			},
			"sku_code": "US_VERIZON_5GB",
			"price": {
				"send_value": 25.00,
				"receive_value": 5.00,
				"currency_iso": "USD"
			},
			"commission_applied": 5.00,
			"started_utc": "2026-03-01T14:30:00Z",
			"completed_utc": "2026-03-01T14:30:45Z",
			"processing_state": "Completed",
			"receipt_text": "5GB data bundle successfully delivered",
			"account_number": "14155552671"
		},
		"result_code": 1,
		"error_codes": []
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"id": "payment-001",
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.NotNil(t, res)
	assert.True(t, res.Success)
	assert.Equal(t, "payment:dingconnect", res.Type)
	assert.Equal(t, "payment-001", res.ID)
	assert.Nil(t, res.Error)
	assert.NotNil(t, res.Response)
	assert.NotNil(t, res.Timestamp)
	assert.Equal(t, &details, res.PaymentDetails)
}

// TestDingConnectPayout_TransientErrorWithResultCode3 verifies result_code=3 returns retryable error.
func TestDingConnectPayout_TransientErrorWithResultCode3(t *testing.T) {
	response := `{
		"transfer_record": null,
		"result_code": 3,
		"error_codes": [
			{
				"code": "INSUFFICIENT_BALANCE",
				"context": "Required: $25.00, Available: $10.50"
			}
		]
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.NotNil(t, res)
	assert.False(t, res.Success)
	assert.Equal(t, "INSUFFICIENT_BALANCE", res.Error.Code)
	assert.Equal(t, "Required: $25.00, Available: $10.50", res.Error.Message)
}

// TestDingConnectPayout_PermanentFailureWithResultCode2 verifies result_code=2 returns non-retryable error.
func TestDingConnectPayout_PermanentFailureWithResultCode2(t *testing.T) {
	response := `{
		"transfer_record": null,
		"result_code": 2,
		"error_codes": [
			{
				"code": "INVALID_ACCOUNT_NUMBER",
				"context": "Phone number format invalid for this operator"
			}
		]
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "invalid_number",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.NotNil(t, res)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_ACCOUNT_NUMBER", res.Error.Code)
	assert.Contains(t, res.Error.Message, "Phone number format invalid")
}

// TestDingConnectPayout_MapInsufficientBalance verifies INSUFFICIENT_BALANCE error code is mapped correctly.
func TestDingConnectPayout_MapInsufficientBalance(t *testing.T) {
	response := `{
		"transfer_record": null,
		"result_code": 3,
		"error_codes": [
			{
				"code": "INSUFFICIENT_BALANCE",
				"context": "Account balance too low for this transaction"
			}
		]
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "INSUFFICIENT_BALANCE", res.Error.Code)
	assert.Equal(t, "Account balance too low for this transaction", res.Error.Message)
}

// TestDingConnectPayout_MapInvalidAccountNumber verifies INVALID_ACCOUNT_NUMBER error code is mapped correctly.
func TestDingConnectPayout_MapInvalidAccountNumber(t *testing.T) {
	response := `{
		"transfer_record": null,
		"result_code": 3,
		"error_codes": [
			{
				"code": "INVALID_ACCOUNT_NUMBER",
				"context": "Phone number is not valid for US Verizon"
			}
		]
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "invalid",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_ACCOUNT_NUMBER", res.Error.Code)
	assert.Equal(t, "Phone number is not valid for US Verizon", res.Error.Message)
}

// TestDingConnectPayout_HttpRequestFails verifies HTTP request failures are handled gracefully.
func TestDingConnectPayout_HttpRequestFails(t *testing.T) {
	// Create client that returns error
	tc := TestClient(0, "", fmt.Errorf("network error"))

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.NotNil(t, res)
	assert.False(t, res.Success)
	assert.Equal(t, "HTTP_REQUEST_FAILED", res.Error.Code)
	assert.Contains(t, res.Error.Message, "HTTP request failed")
}

// TestDingConnectPayout_MalformedResponseJson verifies malformed JSON response is handled gracefully.
func TestDingConnectPayout_MalformedResponseJson(t *testing.T) {
	// Malformed JSON response
	tc := TestClient(200, `{"invalid json}`, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.NotNil(t, res)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_RESPONSE", res.Error.Code)
	assert.Contains(t, res.Error.Message, "Invalid response format")
}

// TestDingConnectPayout_RequestFormat verifies correct URL, headers, and JSON body are sent.
func TestDingConnectPayout_RequestFormat(t *testing.T) {
	requestCaptured := false
	var capturedBody []byte

	response := `{
		"transfer_record": {
			"transfer_id": {
				"distributor_id": "TXN001",
				"ding_id": "DC123456"
			},
			"sku_code": "US_VERIZON_5GB",
			"price": {
				"send_value": 25.00,
				"receive_value": 5.00,
				"currency_iso": "USD"
			},
			"commission_applied": 5.00,
			"started_utc": "2026-03-01T14:30:00Z",
			"completed_utc": "2026-03-01T14:30:45Z",
			"processing_state": "Completed",
			"receipt_text": "Success",
			"account_number": "14155552671"
		},
		"result_code": 1,
		"error_codes": []
	}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify method
		assert.Equal(t, "POST", r.Method)

		// Verify URL path
		assert.Equal(t, "/api/V1/SendTransfer", r.URL.Path)

		// Verify headers
		assert.Equal(t, "test_api_key_123", r.Header.Get("X-Api-Key"))
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
		assert.Equal(t, "application/json", r.Header.Get("Accept"))

		// Capture and verify body
		body, _ := io.ReadAll(r.Body)
		capturedBody = body

		var requestPayload map[string]interface{}
		err := json.Unmarshal(body, &requestPayload)
		assert.Nil(t, err)

		// Verify required fields are in request
		assert.Equal(t, "US_VERIZON_5GB", requestPayload["sku_code"])
		assert.Equal(t, float64(25.00), requestPayload["send_value"])
		assert.Equal(t, "14155552671", requestPayload["account_number"])
		assert.Equal(t, "TXN001", requestPayload["distributor_ref"])

		requestCaptured = true

		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, response)
	}))
	defer ts.Close()

	provider := &DingConnectProvider{
		apiKey: "test_api_key_123",
		client: &http.Client{},
		pool:   nil,
	}

	// Replace the client with one that routes to test server
	rt := func(req *http.Request) (*http.Response, error) {
		// Rewrite the URL to point to test server
		req.URL.Scheme = ts.URL[:len("http")]
		req.URL.Host = ts.Listener.Addr().String()
		req.RequestURI = ""
		return http.DefaultClient.Do(req)
	}

	provider.client = &http.Client{
		Transport: testTransportFunc(rt),
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.True(t, res.Success)
	assert.True(t, requestCaptured)
	assert.NotEmpty(t, capturedBody)
}

// TestDingConnectPayout_IncludesOptionalFields verifies optional fields are included in request when provided.
func TestDingConnectPayout_IncludesOptionalFields(t *testing.T) {
	optionalFieldsPresent := false

	response := `{
		"transfer_record": {
			"transfer_id": {
				"distributor_id": "TXN001",
				"ding_id": "DC123456"
			},
			"sku_code": "US_VERIZON_5GB",
			"price": {
				"send_value": 25.00,
				"receive_value": 5.00,
				"currency_iso": "USD"
			},
			"commission_applied": 5.00,
			"started_utc": "2026-03-01T14:30:00Z",
			"completed_utc": "2026-03-01T14:30:45Z",
			"processing_state": "Completed",
			"receipt_text": "Success",
			"account_number": "14155552671"
		},
		"result_code": 1,
		"error_codes": []
	}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)

		var requestPayload map[string]interface{}
		json.Unmarshal(body, &requestPayload)

		// Check that optional fields are present
		if val, ok := requestPayload["send_currency_iso"]; ok && val == "USD" {
			optionalFieldsPresent = true
		}
		if _, ok := requestPayload["settings"]; ok {
			optionalFieldsPresent = true
		}

		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, response)
	}))
	defer ts.Close()

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: &http.Client{},
		pool:   nil,
	}

	rt := func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = ts.URL[:len("http")]
		req.URL.Host = ts.Listener.Addr().String()
		req.RequestURI = ""
		return http.DefaultClient.Do(req)
	}

	provider.client = &http.Client{
		Transport: testTransportFunc(rt),
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001",
		"send_currency_iso": "USD",
		"settings": [
			{"name": "setting1", "value": "value1"}
		]
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.True(t, res.Success)
	assert.True(t, optionalFieldsPresent)
}

// TestDingConnectPayout_OmitsOptionalFieldsWhenNotProvided verifies optional fields are NOT included when not provided.
func TestDingConnectPayout_OmitsOptionalFieldsWhenNotProvided(t *testing.T) {
	optionalFieldsAbsent := false

	response := `{
		"transfer_record": {
			"transfer_id": {
				"distributor_id": "TXN001",
				"ding_id": "DC123456"
			},
			"sku_code": "US_VERIZON_5GB",
			"price": {
				"send_value": 25.00,
				"receive_value": 5.00,
				"currency_iso": "USD"
			},
			"commission_applied": 5.00,
			"started_utc": "2026-03-01T14:30:00Z",
			"completed_utc": "2026-03-01T14:30:45Z",
			"processing_state": "Completed",
			"receipt_text": "Success",
			"account_number": "14155552671"
		},
		"result_code": 1,
		"error_codes": []
	}`

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)

		var requestPayload map[string]interface{}
		json.Unmarshal(body, &requestPayload)

		// Check that optional fields are NOT present
		_, hasCurrency := requestPayload["send_currency_iso"]
		_, hasSettings := requestPayload["settings"]

		if !hasCurrency && !hasSettings {
			optionalFieldsAbsent = true
		}

		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, response)
	}))
	defer ts.Close()

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: &http.Client{},
		pool:   nil,
	}

	rt := func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = ts.URL[:len("http")]
		req.URL.Host = ts.Listener.Addr().String()
		req.RequestURI = ""
		return http.DefaultClient.Do(req)
	}

	provider.client = &http.Client{
		Transport: testTransportFunc(rt),
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.True(t, res.Success)
	assert.True(t, optionalFieldsAbsent)
}

// TestDingConnectPayout_IncludesResponseInResult verifies response is included in result.
func TestDingConnectPayout_IncludesResponseInResult(t *testing.T) {
	response := `{
		"transfer_record": {
			"transfer_id": {
				"distributor_id": "TXN001",
				"ding_id": "DC123456"
			},
			"sku_code": "US_VERIZON_5GB",
			"price": {
				"send_value": 25.00,
				"receive_value": 5.00,
				"currency_iso": "USD"
			},
			"commission_applied": 5.00,
			"started_utc": "2026-03-01T14:30:00Z",
			"completed_utc": "2026-03-01T14:30:45Z",
			"processing_state": "Completed",
			"receipt_text": "Success message from DingConnect",
			"account_number": "14155552671"
		},
		"result_code": 1,
		"error_codes": []
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.True(t, res.Success)
	assert.NotNil(t, res.Response)

	// Verify response content
	var responseData DingConnectResponse
	json.Unmarshal(*res.Response, &responseData)
	assert.Equal(t, 1, responseData.ResultCode)
	assert.Equal(t, "Completed", responseData.TransferRecord.ProcessingState)
}

// TestDingConnectPayout_IncludesPaymentDetails verifies payment details are included in result.
func TestDingConnectPayout_IncludesPaymentDetails(t *testing.T) {
	response := `{
		"transfer_record": {
			"transfer_id": {
				"distributor_id": "TXN001",
				"ding_id": "DC123456"
			},
			"sku_code": "US_VERIZON_5GB",
			"price": {
				"send_value": 25.00,
				"receive_value": 5.00,
				"currency_iso": "USD"
			},
			"commission_applied": 5.00,
			"started_utc": "2026-03-01T14:30:00Z",
			"completed_utc": "2026-03-01T14:30:45Z",
			"processing_state": "Completed",
			"receipt_text": "Success",
			"account_number": "14155552671"
		},
		"result_code": 1,
		"error_codes": []
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"id": "payment-123",
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.True(t, res.Success)
	assert.Equal(t, &details, res.PaymentDetails)
}

// TestDingConnectPayout_MissingTransferRecord verifies error when result_code=1 but transfer_record is nil.
func TestDingConnectPayout_MissingTransferRecord(t *testing.T) {
	response := `{
		"transfer_record": null,
		"result_code": 1,
		"error_codes": []
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_RESPONSE", res.Error.Code)
	assert.Contains(t, res.Error.Message, "no transfer record provided")
}

// TestDingConnectPayout_UnexpectedProcessingState verifies error when ProcessingState is not Completed.
func TestDingConnectPayout_UnexpectedProcessingState(t *testing.T) {
	response := `{
		"transfer_record": {
			"transfer_id": {
				"distributor_id": "TXN001",
				"ding_id": "DC123456"
			},
			"sku_code": "US_VERIZON_5GB",
			"price": {
				"send_value": 25.00,
				"receive_value": 5.00,
				"currency_iso": "USD"
			},
			"commission_applied": 5.00,
			"started_utc": "2026-03-01T14:30:00Z",
			"processing_state": "Submitted",
			"account_number": "14155552671"
		},
		"result_code": 1,
		"error_codes": []
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "INVALID_RESPONSE", res.Error.Code)
	assert.Contains(t, res.Error.Message, "Unexpected processing state")
}

// TestDingConnectPayout_TransientErrorWithoutErrorCodes verifies result_code=3 with no error codes.
func TestDingConnectPayout_TransientErrorWithoutErrorCodes(t *testing.T) {
	response := `{
		"transfer_record": null,
		"result_code": 3,
		"error_codes": []
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "TRANSIENT_ERROR", res.Error.Code)
	assert.Equal(t, "Transient error (no details)", res.Error.Message)
}

// TestDingConnectPayout_FailureWithoutErrorCodes verifies failure without error codes.
func TestDingConnectPayout_FailureWithoutErrorCodes(t *testing.T) {
	response := `{
		"transfer_record": null,
		"result_code": 2,
		"error_codes": []
	}`

	tc := TestClient(200, response, nil)

	provider := &DingConnectProvider{
		apiKey: "test_api_key",
		client: tc,
		pool:   nil,
	}

	details := json.RawMessage([]byte(`{
		"sku_code": "US_VERIZON_5GB",
		"send_value": 25.00,
		"account_number": "14155552671",
		"distributor_ref": "TXN001"
	}`))
	event := &PaymentEvent{Details: &details}

	res, err := provider.Payout(event)

	assert.Nil(t, err)
	assert.False(t, res.Success)
	assert.Equal(t, "PAYMENT_FAILED", res.Error.Code)
	assert.Contains(t, res.Error.Message, "result code: 2")
}

// Helper type for testing
type testTransport struct {
	server *httptest.Server
}

func (t *testTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = "http"
	req.URL.Host = t.server.Listener.Addr().String()
	req.RequestURI = ""
	return http.DefaultClient.Do(req)
}

type testTransportFunc func(*http.Request) (*http.Response, error)

func (f testTransportFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
