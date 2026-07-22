package main

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Legacy-shaped credentials (no platform/account_id) are covered by the
// reloadly/giftcards tests via the facebook_page_id dual-read fallback.
// This covers the new first-class (platform, account_id) pattern
// (see devops/migrations/20-platform-abstraction.sql).
func TestGenericGetUserResolvesFirstClassPlatformCredential(t *testing.T) {
	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	before(t, pool)

	insertUserSql := `
		INSERT INTO users(id, email)
		VALUES ('00000000-0000-0000-0000-000000000000', 'test@test.com');
	`
	mustExec(t, pool, insertUserSql)

	insertWhatsAppSql := `
		INSERT INTO credentials(userid, entity, key, platform, account_id, details)
		VALUES ('00000000-0000-0000-0000-000000000000', 'whatsapp_business', 'wa-phone-id', 'whatsapp', 'wa-phone-id', '{"id": "wa-phone-id"}');
	`
	mustExec(t, pool, insertWhatsAppSql)

	pe := &PaymentEvent{Pageid: "wa-phone-id"}
	user, err := GenericGetUser(pool, pe)

	assert.Nil(t, err)
	assert.Equal(t, "00000000-0000-0000-0000-000000000000", user.Id)
}

func TestHandleJSONUnmarshalError(t *testing.T) {
	// Create a sample JSON details
	details := json.RawMessage(`{"test": "data"}`)

	// Test the helper function
	result := handleJSONUnmarshalError("fake", assert.AnError, &details)

	// Verify the result structure
	assert.Equal(t, "payment:fake", result.Type)
	assert.False(t, result.Success)
	assert.NotNil(t, result.Error)
	assert.Equal(t, "INVALID_JSON_FORMAT", result.Error.Code)
	assert.Contains(t, result.Error.Message, "Invalid fake payment details format")
	assert.Contains(t, result.Error.Message, assert.AnError.Error())
	assert.Equal(t, &details, result.Error.PaymentDetails)
}

func TestHandleJSONUnmarshalErrorWithDifferentProvider(t *testing.T) {
	// Create a sample JSON details
	details := json.RawMessage(`{"amount": "0.83"}`)

	// Test with a different provider
	result := handleJSONUnmarshalError("reloadly", assert.AnError, &details)

	// Verify the result structure
	assert.Equal(t, "payment:reloadly", result.Type)
	assert.False(t, result.Success)
	assert.NotNil(t, result.Error)
	assert.Equal(t, "INVALID_JSON_FORMAT", result.Error.Code)
	assert.Contains(t, result.Error.Message, "Invalid reloadly payment details format")
	assert.Equal(t, &details, result.Error.PaymentDetails)
}

func TestHandleJSONUnmarshalErrorWithRealError(t *testing.T) {
	// Simulate the exact error from the user's scenario
	// This JSON has amount as string "0.83" instead of float64
	details := json.RawMessage(`{"number":"+918527562332","amount":"0.83","country":"IN","operator":"BSNL India","tolerance":30,"custom_identifier":"+918527562332","id":"firstpayment"}`)

	// Create a simple error that simulates the real JSON unmarshaling error
	mockError := &json.SyntaxError{
		Offset: 0,
	}

	// Test the helper function
	result := handleJSONUnmarshalError("reloadly", mockError, &details)

	// Verify the result structure
	assert.Equal(t, "payment:reloadly", result.Type)
	assert.False(t, result.Success)
	assert.NotNil(t, result.Error)
	assert.Equal(t, "INVALID_JSON_FORMAT", result.Error.Code)
	assert.Contains(t, result.Error.Message, "Invalid reloadly payment details format")
	assert.Equal(t, &details, result.Error.PaymentDetails)
}
