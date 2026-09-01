package messageworker

import (
	"context"
	"errors"
	"testing"
)

// A token lookup failure must NOT be classified as a *PlatformError.
//
// Regression test for a production incident on 2026-08-25. All three send
// paths used to wrap ErrTokenNotFound in &PlatformError{StatusCode: 0}. That
// made reportError tag the failure "FB", which the state machine turns into
// BLOCKED -- and dean's Blocked retry keys on fb_error_code, which a lookup
// miss does not have. The conversation was stranded permanently, reachable by
// neither retry path, while an *expired* credential recovered fine because
// Facebook returns code 190 and 190 is in DEAN_FB_CODES.
//
// Leaving the error unwrapped keeps reportError's default tag, STATE_ACTIONS,
// which is in DEAN_ERROR_TAGS, so the state goes to ERROR and dean retries it.
func TestTokenLookupFailureIsNotPlatformError(t *testing.T) {
	ctx := context.Background()
	// StaticTokenStore("") returns ErrTokenNotFound from GetToken.
	failing := NewStaticTokenStore("")

	cases := []struct {
		name string
		call func() error
	}{
		{
			name: "MessengerClient.SendMessage",
			call: func() error {
				_, err := NewMessengerClient("http://unused", failing).
					SendMessage(ctx, "acct-1", "user-1", nil, nil)
				return err
			},
		},
		{
			name: "MessengerClient.PassThreadControl",
			call: func() error {
				return NewMessengerClient("http://unused", failing).
					PassThreadControl(ctx, "user-1", "acct-1", "app-1", "")
			},
		},
		{
			name: "WhatsAppClient.SendMessage",
			call: func() error {
				_, err := NewWhatsAppClient("http://unused", failing).
					SendMessage(ctx, "acct-1", "user-1", nil, nil)
				return err
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatal("expected an error when the token lookup fails")
			}
			if IsPlatformError(err) {
				t.Fatalf("token lookup failure must NOT be a *PlatformError -- "+
					"that tags it FB and strands the conversation in BLOCKED "+
					"with no fb_error_code. got: %v", err)
			}
			if !errors.Is(err, ErrTokenNotFound) {
				t.Fatalf("expected the error to wrap ErrTokenNotFound so callers "+
					"can still identify it; got: %v", err)
			}
			// The whole point: it must be retriable via dean, not in-process.
			if IsRetriable(err) {
				t.Fatalf("a missing credential should not be retried in-process; "+
					"dean's Errored path handles it with backoff. got: %v", err)
			}
		})
	}
}
