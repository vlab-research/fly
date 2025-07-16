package main

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFakeProviderPayoutWithJSONUnmarshalError(t *testing.T) {
	// Create a fake provider
	provider := &FakeProvider{
		getUserFromPaymentEvent: func(event *PaymentEvent) (*User, error) {
			return &User{Id: "test-user"}, nil
		},
		auth: func(user *User, key string) error {
			return nil
		},
	}

	// Create a payment event with malformed JSON details
	// The FakeDetails struct expects a Result field, but we'll send a string instead
	malformedDetails := json.RawMessage(`{"result": "this_should_be_an_object_not_string"}`)

	event := &PaymentEvent{
		Userid:   "test-user",
		Pageid:   "test-page",
		Provider: "fake",
		Details:  &malformedDetails,
	}

	// Call the Payout method
	result, err := provider.Payout(event)

	// Verify that no error is returned (the error is handled gracefully)
	assert.Nil(t, err)
	assert.NotNil(t, result)

	// Verify the result structure
	assert.Equal(t, "payment:fake", result.Type)
	assert.False(t, result.Success)
	assert.NotNil(t, result.Error)
	assert.Equal(t, "INVALID_JSON_FORMAT", result.Error.Code)
	assert.Contains(t, result.Error.Message, "Invalid fake payment details format")
	assert.Contains(t, result.Error.Message, "json: cannot unmarshal")
	assert.Equal(t, &malformedDetails, result.Error.PaymentDetails)
}

func TestFakeProviderPayoutWithValidJSON(t *testing.T) {
	// Create a fake provider
	provider := &FakeProvider{
		getUserFromPaymentEvent: func(event *PaymentEvent) (*User, error) {
			return &User{Id: "test-user"}, nil
		},
		auth: func(user *User, key string) error {
			return nil
		},
	}

	// Create a payment event with valid JSON details
	validDetails := json.RawMessage(`{"result": {"type": "test", "success": true}}`)

	event := &PaymentEvent{
		Userid:   "test-user",
		Pageid:   "test-page",
		Provider: "fake",
		Details:  &validDetails,
	}

	// Call the Payout method
	result, err := provider.Payout(event)

	// Verify that no error is returned
	assert.Nil(t, err)
	assert.NotNil(t, result)

	// Verify the result structure
	assert.Equal(t, "test", result.Type)
	assert.True(t, result.Success)
}
