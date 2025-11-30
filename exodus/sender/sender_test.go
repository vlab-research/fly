package sender

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestSendBailout_Success(t *testing.T) {
	// Create mock server that captures the request
	var receivedEvent BailoutEvent
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify request method and content type
		if r.Method != "POST" {
			t.Errorf("Expected POST request, got %s", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Expected Content-Type application/json, got %s", r.Header.Get("Content-Type"))
		}

		// Decode and verify payload
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("Failed to read request body: %v", err)
		}

		err = json.Unmarshal(body, &receivedEvent)
		if err != nil {
			t.Fatalf("Failed to unmarshal request body: %v", err)
		}

		// Return success
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// Create sender and send bailout
	sender := New(server.URL, 0, false)
	ctx := context.Background()

	metadata := map[string]interface{}{
		"reason": "timeout",
		"count":  5,
	}

	err := sender.SendBailout(ctx, "user123", "page456", "exit-form", metadata)
	if err != nil {
		t.Fatalf("SendBailout failed: %v", err)
	}

	// Verify received event structure
	if receivedEvent.User != "user123" {
		t.Errorf("Expected user=user123, got %s", receivedEvent.User)
	}
	if receivedEvent.Page != "page456" {
		t.Errorf("Expected page=page456, got %s", receivedEvent.Page)
	}
	if receivedEvent.Event == nil {
		t.Fatal("Event detail is nil")
	}
	if receivedEvent.Event.Type != "bailout" {
		t.Errorf("Expected event type=bailout, got %s", receivedEvent.Event.Type)
	}
	if receivedEvent.Event.Value == nil {
		t.Fatal("Event value is nil")
	}
	if receivedEvent.Event.Value.Form != "exit-form" {
		t.Errorf("Expected form=exit-form, got %s", receivedEvent.Event.Value.Form)
	}
	if receivedEvent.Event.Value.Metadata == nil {
		t.Fatal("Metadata is nil")
	}
	if receivedEvent.Event.Value.Metadata["reason"] != "timeout" {
		t.Errorf("Expected metadata reason=timeout, got %v", receivedEvent.Event.Value.Metadata["reason"])
	}
}

func TestSendBailout_ServerError(t *testing.T) {
	// Create mock server that returns 500
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	sender := New(server.URL, 0, false)
	ctx := context.Background()

	err := sender.SendBailout(ctx, "user123", "page456", "exit-form", nil)
	if err == nil {
		t.Fatal("Expected error for 500 response, got nil")
	}
}

func TestSendBailout_ContextCancellation(t *testing.T) {
	// Create mock server with delay
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(100 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	sender := New(server.URL, 0, false)

	// Create context that will be cancelled
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	err := sender.SendBailout(ctx, "user123", "page456", "exit-form", nil)
	if err == nil {
		t.Fatal("Expected error for cancelled context, got nil")
	}
}

func TestSendBailouts_RateLimiting(t *testing.T) {
	requestCount := int32(0)
	var requestTimes []time.Time

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		requestTimes = append(requestTimes, time.Now())
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// Use 100ms rate limit for faster test
	rateLimit := 100 * time.Millisecond
	sender := New(server.URL, rateLimit, false)
	ctx := context.Background()

	users := []UserTarget{
		{UserID: "user1", PageID: "page1"},
		{UserID: "user2", PageID: "page2"},
		{UserID: "user3", PageID: "page3"},
	}

	startTime := time.Now()
	count, err := sender.SendBailouts(ctx, users, "exit-form", nil)
	duration := time.Since(startTime)

	if err != nil {
		t.Fatalf("SendBailouts failed: %v", err)
	}
	if count != 3 {
		t.Errorf("Expected 3 successful sends, got %d", count)
	}

	// Verify rate limiting: 3 requests with 100ms delay should take at least 200ms
	// (no delay after the last request)
	expectedMinDuration := rateLimit * 2 // 2 delays for 3 requests
	if duration < expectedMinDuration {
		t.Errorf("Rate limiting not working: expected at least %v, got %v", expectedMinDuration, duration)
	}

	// Verify requests were spaced out
	if len(requestTimes) == 3 {
		gap1 := requestTimes[1].Sub(requestTimes[0])
		gap2 := requestTimes[2].Sub(requestTimes[1])

		// Allow some tolerance (50ms) for timing variations
		minGap := rateLimit - 50*time.Millisecond

		if gap1 < minGap {
			t.Errorf("First gap too short: expected at least %v, got %v", minGap, gap1)
		}
		if gap2 < minGap {
			t.Errorf("Second gap too short: expected at least %v, got %v", minGap, gap2)
		}
	}
}

func TestSendBailouts_DryRun(t *testing.T) {
	// Track whether server was called
	serverCalled := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverCalled = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// Create sender in dry run mode
	sender := New(server.URL, 0, true)
	ctx := context.Background()

	users := []UserTarget{
		{UserID: "user1", PageID: "page1"},
		{UserID: "user2", PageID: "page2"},
	}

	count, err := sender.SendBailouts(ctx, users, "exit-form", map[string]interface{}{"reason": "test"})
	if err != nil {
		t.Fatalf("SendBailouts failed in dry run: %v", err)
	}

	// In dry run mode, we still count "successful" sends
	if count != 2 {
		t.Errorf("Expected 2 successful dry run sends, got %d", count)
	}

	// Verify server was never called
	if serverCalled {
		t.Error("Server should not be called in dry run mode")
	}
}

func TestSendBailouts_PartialFailure(t *testing.T) {
	requestCount := int32(0)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count := atomic.AddInt32(&requestCount, 1)
		// Fail on second request
		if count == 2 {
			w.WriteHeader(http.StatusInternalServerError)
		} else {
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	sender := New(server.URL, 0, false)
	ctx := context.Background()

	users := []UserTarget{
		{UserID: "user1", PageID: "page1"},
		{UserID: "user2", PageID: "page2"},
		{UserID: "user3", PageID: "page3"},
	}

	count, err := sender.SendBailouts(ctx, users, "exit-form", nil)

	// Should have 2 successful sends (user1 and user3)
	if count != 2 {
		t.Errorf("Expected 2 successful sends, got %d", count)
	}

	// Should return an error indicating failure
	if err == nil {
		t.Error("Expected error for partial failure, got nil")
	}
}

func TestSendBailouts_EmptyUsers(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	sender := New(server.URL, 0, false)
	ctx := context.Background()

	users := []UserTarget{}

	count, err := sender.SendBailouts(ctx, users, "exit-form", nil)
	if err != nil {
		t.Errorf("Expected no error for empty users, got %v", err)
	}
	if count != 0 {
		t.Errorf("Expected 0 successful sends, got %d", count)
	}
}

func TestSendBailouts_ContextCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(50 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	sender := New(server.URL, 100*time.Millisecond, false)

	// Create context that will be cancelled after first request
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	users := []UserTarget{
		{UserID: "user1", PageID: "page1"},
		{UserID: "user2", PageID: "page2"},
		{UserID: "user3", PageID: "page3"},
	}

	count, err := sender.SendBailouts(ctx, users, "exit-form", nil)

	// Should complete at least one request before timeout
	if count < 1 {
		t.Errorf("Expected at least 1 successful send before cancellation, got %d", count)
	}

	// Should return error due to context cancellation
	if err == nil {
		t.Error("Expected error for context cancellation, got nil")
	}
}

func TestSendBailout_NilMetadata(t *testing.T) {
	var receivedEvent BailoutEvent
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &receivedEvent)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	sender := New(server.URL, 0, false)
	ctx := context.Background()

	// Send with nil metadata
	err := sender.SendBailout(ctx, "user123", "page456", "exit-form", nil)
	if err != nil {
		t.Fatalf("SendBailout failed: %v", err)
	}

	// Verify metadata field is omitted or empty in JSON
	if receivedEvent.Event.Value.Metadata != nil && len(receivedEvent.Event.Value.Metadata) > 0 {
		t.Errorf("Expected nil or empty metadata, got %v", receivedEvent.Event.Value.Metadata)
	}
}
