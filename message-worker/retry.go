package messageworker

import (
	"context"
	"errors"
	"syscall"
	"time"
)

// RetryConfig defines retry behavior
type RetryConfig struct {
	MaxAttempts    int
	InitialBackoff time.Duration
	MaxBackoff     time.Duration

	// MaxElapsed caps the total time spent retrying, across all attempts.
	// Zero means only MaxAttempts bounds it.
	//
	// It exists because attempts and duration are not interchangeable under
	// exponential backoff: with a doubling delay, one extra attempt can add
	// more wall-clock time than every previous attempt combined. Sizing a
	// retry against a downstream cooldown means bounding the time, and letting
	// the attempt count fall out.
	MaxElapsed time.Duration
}

// DefaultRetryConfig returns the default retry configuration for message sending
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxAttempts:    3,
		InitialBackoff: 100 * time.Millisecond,
		MaxBackoff:     1 * time.Second,
	}
}

// IsRetriable determines if an error should trigger a retry
func IsRetriable(err error) bool {
	if err == nil {
		return false
	}

	// Check for context errors (not retriable)
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	// Check for network errors (retriable)
	if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) {
		return true
	}

	// Check for platform-specific errors
	var platformErr *PlatformError
	if errors.As(err, &platformErr) {
		return platformErr.Retriable
	}

	// Default to non-retriable for unknown errors
	return false
}

// GetErrorCode extracts an error code from an error
func GetErrorCode(err error) string {
	if err == nil {
		return ""
	}

	var platformErr *PlatformError
	if errors.As(err, &platformErr) {
		return platformErr.Message
	}

	return "UNKNOWN"
}

// RetryWithBackoff executes a function with exponential backoff retry logic
func RetryWithBackoff(ctx context.Context, config RetryConfig, fn func() error) (int, error) {
	var lastErr error
	backoff := config.InitialBackoff
	started := time.Now()

	// Counted rather than derived from the loop variable: every break below
	// exits early, and the caller is told how many attempts actually happened.
	attempts := 0

	for attempt := 1; attempt <= config.MaxAttempts; attempt++ {
		attempts = attempt
		err := fn()
		if err == nil {
			return attempt, nil
		}

		lastErr = err

		// Don't retry if error is not retriable or if this was the last attempt
		if !IsRetriable(err) || attempt == config.MaxAttempts {
			break
		}

		// Stop if the next sleep would exceed the time budget. Checked before
		// sleeping rather than after, so the budget is a ceiling on total time
		// rather than something we discover we have overshot.
		if config.MaxElapsed > 0 && time.Since(started)+backoff > config.MaxElapsed {
			break
		}

		// Wait with exponential backoff
		select {
		case <-ctx.Done():
			return attempt, ctx.Err()
		case <-time.After(backoff):
			// Double the backoff for next attempt, but cap at MaxBackoff
			backoff *= 2
			if backoff > config.MaxBackoff {
				backoff = config.MaxBackoff
			}
		}
	}

	return attempts, lastErr
}
