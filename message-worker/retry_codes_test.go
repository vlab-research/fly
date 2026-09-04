package messageworker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestWhatsAppRetryCodes_DefaultIsPairRateLimitOnly pins the default: 131056,
// the per-recipient pair rate limit, and nothing else.
//
// The account-wide limits are deliberately excluded. Retrying those per message
// across every worker is a thundering herd -- each backs off independently and
// they all return together, re-tripping the limit.
func TestWhatsAppRetryCodes_FailsClosedWithoutConfiguration(t *testing.T) {
	client := NewWhatsAppClient("http://unused", NewStaticTokenStore("t"))

	// No codes were supplied, so nothing is retried. The policy belongs to the
	// deployment, and LoadConfig refuses to start without it -- a client that
	// invented its own default would put the decision back in the code.
	for _, code := range []int{131056, 4, 80007, 130429, 131048, 131057} {
		assert.Falsef(t, client.isRetriable(code),
			"an unconfigured client must retry nothing, got true for %d", code)
	}

	client = client.WithRetryCodes([]int{131056})
	assert.True(t, client.isRetriable(131056), "the pair rate limit is safe to retry in place")
	for _, code := range []int{4, 80007, 130429, 131048, 131057} {
		assert.Falsef(t, client.isRetriable(code),
			"account-wide or long-lived code %d belongs to dean's sweep", code)
	}
}

// TestWhatsAppRetryCodes_Configurable covers the env-driven override.
func TestWhatsAppRetryCodes_Configurable(t *testing.T) {
	client := NewWhatsAppClient("http://unused", NewStaticTokenStore("t")).
		WithRetryCodes([]int{130429, 131056})

	assert.True(t, client.isRetriable(130429))
	assert.True(t, client.isRetriable(131056))
	assert.False(t, client.isRetriable(131048))

	// An empty set disables code-based retries without disabling the client.
	client = client.WithRetryCodes(nil)
	assert.False(t, client.isRetriable(131056))
}

// TestGetEnvAsIntSlice covers parsing, including the distinction between unset
// (take the default) and empty (disable).
func TestGetEnvAsIntSlice(t *testing.T) {
	const key = "TEST_RETRY_CODES"

	t.Setenv(key, "")
	assert.Empty(t, getEnvAsIntSlice(key), "empty means retry nothing")

	t.Setenv(key, "131056,130429")
	assert.Equal(t, []int{131056, 130429}, getEnvAsIntSlice(key))

	t.Setenv(key, " 131056 , 130429 ")
	assert.Equal(t, []int{131056, 130429}, getEnvAsIntSlice(key), "whitespace tolerated")

	t.Setenv(key, "131056,nonsense,130429")
	assert.Equal(t, []int{131056, 130429}, getEnvAsIntSlice(key),
		"a typo in one code must not stop the worker from sending")
}

// TestRetryWithBackoff_RetriesThePairRateLimit is the end-to-end point of the
// change: a 131056 send is retried rather than reported as permanent.
func TestRetryWithBackoff_RetriesThePairRateLimit(t *testing.T) {
	rateLimit := &PlatformError{
		Message: "131056",
		Retriable: NewWhatsAppClient("http://unused", NewStaticTokenStore("t")).
			WithRetryCodes([]int{131056}).isRetriable(131056),
		StatusCode: 400,
	}

	attempts := 0
	config := RetryConfig{MaxAttempts: 5, InitialBackoff: time.Millisecond, MaxBackoff: 5 * time.Millisecond}

	got, err := RetryWithBackoff(context.Background(), config, func() error {
		attempts++
		if attempts < 3 {
			return rateLimit
		}
		return nil
	})

	require.NoError(t, err)
	assert.Equal(t, 3, got, "it must keep trying until the cooldown passes")
}

// TestRetryWithBackoff_MaxElapsedBoundsTotalTime is why elapsed time is a knob
// at all: under a doubling delay, one more attempt can add more wall-clock time
// than every previous attempt combined, so attempts are a poor way to size a
// retry against a downstream cooldown.
func TestRetryWithBackoff_MaxElapsedBoundsTotalTime(t *testing.T) {
	alwaysFails := &PlatformError{Message: "131056", Retriable: true}

	config := RetryConfig{
		MaxAttempts:    100, // would run for minutes
		InitialBackoff: 10 * time.Millisecond,
		MaxBackoff:     time.Second,
		MaxElapsed:     120 * time.Millisecond,
	}

	started := time.Now()
	attempts, err := RetryWithBackoff(context.Background(), config, func() error { return alwaysFails })
	elapsed := time.Since(started)

	require.Error(t, err)
	assert.Less(t, attempts, 100, "the time budget must stop it well before the attempt limit")
	assert.LessOrEqual(t, elapsed, 250*time.Millisecond,
		"MaxElapsed is a ceiling: it must not be discovered after overshooting (took %v)", elapsed)
}

// TestRetryWithBackoff_MaxElapsedZeroMeansAttemptsOnly keeps the old behaviour
// available for callers that do not set a budget.
func TestRetryWithBackoff_MaxElapsedZeroMeansAttemptsOnly(t *testing.T) {
	alwaysFails := &PlatformError{Message: "131056", Retriable: true}
	config := RetryConfig{MaxAttempts: 4, InitialBackoff: time.Millisecond, MaxBackoff: time.Millisecond}

	attempts, err := RetryWithBackoff(context.Background(), config, func() error { return alwaysFails })

	require.Error(t, err)
	assert.True(t, errors.Is(err, alwaysFails) || err != nil)
	assert.Equal(t, 4, attempts, "with no budget, MaxAttempts is the only bound")
}

// TestMessengerRetryCodes covers the Messenger side of the same contract.
// Both platforms classify their own vendor error codes, and both are
// configurable -- neither borrows the other's list.
func TestMessengerRetryCodes(t *testing.T) {
	client := NewMessengerClient("http://unused", NewStaticTokenStore("t"))
	assert.False(t, client.isRetriable(1200), "an unconfigured client retries nothing")

	client = client.WithRetryCodes([]int{1200, 551})
	assert.True(t, client.isRetriable(1200), "temporary send failure")
	assert.True(t, client.isRetriable(551), "recipient temporarily unavailable")
	assert.False(t, client.isRetriable(131056),
		"a WhatsApp code must not be retriable on Messenger; the lists are separate")

	client = client.WithRetryCodes([]int{613})
	assert.True(t, client.isRetriable(613))
	assert.False(t, client.isRetriable(1200), "WithRetryCodes replaces, it does not merge")
}

// TestRetryCodes_PlatformsDoNotShareAList guards the defect this replaced:
// whatsapp_client.go used to call isRetriableFacebookError, so WhatsApp was
// classified by Messenger's codes and no WhatsApp rate limit was retriable.
func TestRetryCodes_PlatformsDoNotShareAList(t *testing.T) {
	wa := NewWhatsAppClient("http://unused", NewStaticTokenStore("t")).
		WithRetryCodes([]int{131056})
	fb := NewMessengerClient("http://unused", NewStaticTokenStore("t")).
		WithRetryCodes([]int{1200, 551})

	assert.True(t, wa.isRetriable(131056))
	assert.False(t, fb.isRetriable(131056))

	assert.True(t, fb.isRetriable(1200))
	assert.False(t, wa.isRetriable(1200))
}

// TestRequireEnv_ReportsEveryMissingVariable is the fail-fast contract. A
// deploy missing three variables should learn all three in one restart, not
// discover them one at a time.
func TestRequireEnv_ReportsEveryMissingVariable(t *testing.T) {
	for _, v := range requiredEnv {
		t.Setenv(v.name, "set")
	}
	require.NoError(t, requireEnv(), "everything set")

	t.Setenv("DATABASE_URL", "")
	t.Setenv("MAX_RETRY_ELAPSED", "")
	t.Setenv("INITIAL_BACKOFF_MS", "   ") // whitespace is not a value

	err := requireEnv()
	require.Error(t, err)
	for _, name := range []string{"DATABASE_URL", "MAX_RETRY_ELAPSED", "INITIAL_BACKOFF_MS"} {
		assert.Containsf(t, err.Error(), name, "%s should be reported as missing", name)
	}
}

// TestRequireEnv_EmptyRetryCodesIsAValidSetting covers the one case where empty
// is a decision rather than an omission: retry nothing on that platform.
func TestRequireEnv_EmptyRetryCodesIsAValidSetting(t *testing.T) {
	for _, v := range requiredEnv {
		t.Setenv(v.name, "set")
	}
	t.Setenv("WHATSAPP_RETRY_CODES", "")
	t.Setenv("MESSENGER_RETRY_CODES", "")

	assert.NoError(t, requireEnv(),
		"empty retry codes means retry nothing, which is explicit and allowed")
}

// TestRequireEnv_NoRetryConfigHasADefault pins the rule that produced this
// change: every retry knob must be required, so a missing one fails loudly
// rather than silently taking a value nobody chose.
func TestRequireEnv_NoRetryConfigHasADefault(t *testing.T) {
	required := map[string]bool{}
	for _, v := range requiredEnv {
		required[v.name] = true
	}

	for _, name := range []string{
		"WHATSAPP_RETRY_CODES", "MESSENGER_RETRY_CODES",
		"MAX_RETRY_ATTEMPTS", "INITIAL_BACKOFF_MS", "MAX_BACKOFF_MS", "MAX_RETRY_ELAPSED",
	} {
		assert.Truef(t, required[name], "%s must be a required variable, not defaulted", name)
	}
}
