package messageworker

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRetryWithBackoff_Success(t *testing.T) {
	config := RetryConfig{
		MaxAttempts:    3,
		InitialBackoff: 10 * time.Millisecond,
		MaxBackoff:     100 * time.Millisecond,
	}

	attempts := 0
	fn := func() error {
		attempts++
		return nil
	}

	finalAttempts, err := RetryWithBackoff(context.Background(), config, fn)
	if err != nil {
		t.Errorf("Expected no error, got %v", err)
	}
	if finalAttempts != 1 {
		t.Errorf("Expected 1 attempt, got %d", finalAttempts)
	}
	if attempts != 1 {
		t.Errorf("Function should be called once, was called %d times", attempts)
	}
}

func TestRetryWithBackoff_SuccessAfterRetries(t *testing.T) {
	config := RetryConfig{
		MaxAttempts:    3,
		InitialBackoff: 10 * time.Millisecond,
		MaxBackoff:     100 * time.Millisecond,
	}

	attempts := 0
	fn := func() error {
		attempts++
		if attempts < 3 {
			return &PlatformError{
				StatusCode: 503,
				Message:    "Service unavailable",
				Retriable:  true,
			}
		}
		return nil
	}

	finalAttempts, err := RetryWithBackoff(context.Background(), config, fn)
	if err != nil {
		t.Errorf("Expected no error, got %v", err)
	}
	if finalAttempts != 3 {
		t.Errorf("Expected 3 attempts, got %d", finalAttempts)
	}
	if attempts != 3 {
		t.Errorf("Function should be called 3 times, was called %d times", attempts)
	}
}

func TestRetryWithBackoff_NonRetriableError(t *testing.T) {
	config := RetryConfig{
		MaxAttempts:    3,
		InitialBackoff: 10 * time.Millisecond,
		MaxBackoff:     100 * time.Millisecond,
	}

	attempts := 0
	expectedErr := &PlatformError{
		StatusCode: 400,
		Message:    "Bad request",
		Retriable:  false,
	}

	fn := func() error {
		attempts++
		return expectedErr
	}

	finalAttempts, err := RetryWithBackoff(context.Background(), config, fn)
	if err != expectedErr {
		t.Errorf("Expected error %v, got %v", expectedErr, err)
	}
	if finalAttempts != 3 {
		t.Errorf("Expected 3 as final attempts count, got %d", finalAttempts)
	}
	if attempts != 1 {
		t.Errorf("Function should be called once (non-retriable), was called %d times", attempts)
	}
}

func TestRetryWithBackoff_MaxAttemptsExceeded(t *testing.T) {
	config := RetryConfig{
		MaxAttempts:    3,
		InitialBackoff: 10 * time.Millisecond,
		MaxBackoff:     100 * time.Millisecond,
	}

	attempts := 0
	retriableErr := &PlatformError{
		StatusCode: 503,
		Message:    "Service unavailable",
		Retriable:  true,
	}

	fn := func() error {
		attempts++
		return retriableErr
	}

	finalAttempts, err := RetryWithBackoff(context.Background(), config, fn)
	if err == nil {
		t.Error("Expected error after max attempts, got nil")
	}
	if finalAttempts != 3 {
		t.Errorf("Expected 3 attempts, got %d", finalAttempts)
	}
	if attempts != 3 {
		t.Errorf("Function should be called 3 times, was called %d times", attempts)
	}
}

func TestRetryWithBackoff_ContextCanceled(t *testing.T) {
	config := RetryConfig{
		MaxAttempts:    5,
		InitialBackoff: 100 * time.Millisecond,
		MaxBackoff:     1 * time.Second,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	attempts := 0
	fn := func() error {
		attempts++
		return &PlatformError{
			StatusCode: 503,
			Message:    "Service unavailable",
			Retriable:  true,
		}
	}

	_, err := RetryWithBackoff(ctx, config, fn)
	if err == nil {
		t.Error("Expected context error, got nil")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Expected context.DeadlineExceeded, got %v", err)
	}
	// Should be called at least once
	if attempts < 1 {
		t.Errorf("Function should be called at least once, was called %d times", attempts)
	}
}

func TestRetryWithBackoff_ExponentialBackoff(t *testing.T) {
	config := RetryConfig{
		MaxAttempts:    4,
		InitialBackoff: 50 * time.Millisecond,
		MaxBackoff:     500 * time.Millisecond,
	}

	start := time.Now()
	attempts := 0

	fn := func() error {
		attempts++
		return &PlatformError{
			StatusCode: 503,
			Message:    "Service unavailable",
			Retriable:  true,
		}
	}

	RetryWithBackoff(context.Background(), config, fn)
	duration := time.Since(start)

	// Expected backoffs: 50ms, 100ms, 200ms
	// Total: ~350ms minimum
	minExpectedDuration := 300 * time.Millisecond
	if duration < minExpectedDuration {
		t.Errorf("Expected at least %v duration, got %v", minExpectedDuration, duration)
	}

	if attempts != 4 {
		t.Errorf("Expected 4 attempts, got %d", attempts)
	}
}

func TestIsRetriable(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "nil error",
			err:  nil,
			want: false,
		},
		{
			name: "context canceled",
			err:  context.Canceled,
			want: false,
		},
		{
			name: "context deadline exceeded",
			err:  context.DeadlineExceeded,
			want: false,
		},
		{
			name: "retriable bottleneck error",
			err: &PlatformError{
				StatusCode: 503,
				Message:    "Service unavailable",
				Retriable:  true,
			},
			want: true,
		},
		{
			name: "non-retriable bottleneck error",
			err: &PlatformError{
				StatusCode: 400,
				Message:    "Bad request",
				Retriable:  false,
			},
			want: false,
		},
		{
			name: "generic error",
			err:  errors.New("some error"),
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsRetriable(tt.err)
			if got != tt.want {
				t.Errorf("IsRetriable() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGetErrorCode(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{
			name: "nil error",
			err:  nil,
			want: "",
		},
		{
			name: "bottleneck error",
			err: &PlatformError{
				StatusCode: 400,
				Message:    "INVALID_MESSAGE",
				Retriable:  false,
			},
			want: "INVALID_MESSAGE",
		},
		{
			name: "generic error",
			err:  errors.New("generic error"),
			want: "UNKNOWN",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GetErrorCode(tt.err)
			if got != tt.want {
				t.Errorf("GetErrorCode() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDefaultRetryConfig(t *testing.T) {
	config := DefaultRetryConfig()

	if config.MaxAttempts != 3 {
		t.Errorf("Expected MaxAttempts=3, got %d", config.MaxAttempts)
	}
	if config.InitialBackoff != 100*time.Millisecond {
		t.Errorf("Expected InitialBackoff=100ms, got %v", config.InitialBackoff)
	}
	if config.MaxBackoff != 1*time.Second {
		t.Errorf("Expected MaxBackoff=1s, got %v", config.MaxBackoff)
	}
}
