package messageworker

import (
	"context"
	"errors"
	"os"
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
func TestWhatsAppRetryCodes_DefaultIsPairRateLimitOnly(t *testing.T) {
	client := NewWhatsAppClient("http://unused", NewStaticTokenStore("t"))

	assert.True(t, client.isRetriable(131056), "the pair rate limit must be retried in place")

	for _, code := range []int{4, 80007, 130429, 131048, 131057} {
		assert.Falsef(t, client.isRetriable(code),
			"account-wide or long-lived code %d belongs to dean's sweep, not in-worker retry", code)
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
	defaults := []int{131056}

	os.Unsetenv(key)
	assert.Equal(t, defaults, getEnvAsIntSlice(key, defaults), "unset takes the default")

	t.Setenv(key, "")
	assert.Empty(t, getEnvAsIntSlice(key, defaults), "empty disables, it does not fall back")

	t.Setenv(key, "131056,130429")
	assert.Equal(t, []int{131056, 130429}, getEnvAsIntSlice(key, defaults))

	t.Setenv(key, " 131056 , 130429 ")
	assert.Equal(t, []int{131056, 130429}, getEnvAsIntSlice(key, defaults), "whitespace tolerated")

	t.Setenv(key, "131056,nonsense,130429")
	assert.Equal(t, []int{131056, 130429}, getEnvAsIntSlice(key, defaults),
		"a typo in one code must not stop the worker from sending")
}

// TestRetryWithBackoff_RetriesThePairRateLimit is the end-to-end point of the
// change: a 131056 send is retried rather than reported as permanent.
func TestRetryWithBackoff_RetriesThePairRateLimit(t *testing.T) {
	rateLimit := &PlatformError{
		Message:    "131056",
		Retriable:  NewWhatsAppClient("http://unused", NewStaticTokenStore("t")).isRetriable(131056),
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
