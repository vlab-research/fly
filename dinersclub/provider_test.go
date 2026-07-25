package main

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Facebook and WhatsApp credentials are covered by the reloadly/giftcards tests.
// This test exercises the uniform key-based lookup pattern via WhatsApp.
// See devops/migrations/20-messaging-account-unique.sql.
func TestGenericGetUserResolvesWhatsAppCredential(t *testing.T) {
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
		INSERT INTO credentials(userid, entity, key, details)
		VALUES ('00000000-0000-0000-0000-000000000000', 'whatsapp_business', 'wa-phone-id', '{"id": "wa-phone-id"}');
	`
	mustExec(t, pool, insertWhatsAppSql)

	pe := &PaymentEvent{Pageid: "wa-phone-id"}
	user, err := GenericGetUser(pool, pe)

	assert.Nil(t, err)
	assert.Equal(t, "00000000-0000-0000-0000-000000000000", user.Id)
}

// A payment event carrying Platform resolves the credential via the natural
// key (entity, key) — no reliance on the key-only fallback.
func TestGenericGetUserWithPlatformResolvesViaEntityKey(t *testing.T) {
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
		INSERT INTO credentials(userid, entity, key, details)
		VALUES ('00000000-0000-0000-0000-000000000000', 'whatsapp_business', 'wa-phone-id', '{"id": "wa-phone-id"}');
	`
	mustExec(t, pool, insertWhatsAppSql)

	pe := &PaymentEvent{Pageid: "wa-phone-id", Platform: "whatsapp"}
	user, err := GenericGetUser(pool, pe)

	assert.Nil(t, err)
	assert.Equal(t, "00000000-0000-0000-0000-000000000000", user.Id)

	// The entity filter is real: asking for the same account id under the
	// wrong platform finds nothing.
	peWrong := &PaymentEvent{Pageid: "wa-phone-id", Platform: "messenger"}
	userWrong, err := GenericGetUser(pool, peWrong)

	assert.Nil(t, err)
	assert.Nil(t, userWrong)
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
