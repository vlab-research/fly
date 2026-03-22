package sender

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// BailoutEvent is sent to botserver to trigger a form bailout
type BailoutEvent struct {
	User  string       `json:"user"`
	Page  string       `json:"page"`
	Event *EventDetail `json:"event"`
}

// EventDetail contains the event type and value
type EventDetail struct {
	Type  string     `json:"type"`
	Value *BailValue `json:"value"`
}

// BailValue contains the destination form and optional metadata
type BailValue struct {
	Form     string                 `json:"form"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// Sender handles posting bailout events to botserver
type Sender struct {
	botserverURL string
	client       *http.Client
	rateLimit    time.Duration // Delay between sends (e.g., 1 second)
	dryRun       bool
}

// UserTarget represents a user to be bailed
type UserTarget struct {
	UserID          string
	PageID          string
	DestinationForm string // always set by caller; resolved before passing to sender
}

// New creates a new Sender instance
func New(botserverURL string, rateLimit time.Duration, dryRun bool) *Sender {
	return &Sender{
		botserverURL: botserverURL,
		client:       &http.Client{},
		rateLimit:    rateLimit,
		dryRun:       dryRun,
	}
}

// SendBailout sends a single bailout event
func (s *Sender) SendBailout(ctx context.Context, userID, pageID, destinationForm string, metadata map[string]interface{}) error {
	event := &BailoutEvent{
		User: userID,
		Page: pageID,
		Event: &EventDetail{
			Type: "bailout",
			Value: &BailValue{
				Form:     destinationForm,
				Metadata: metadata,
			},
		},
	}

	if s.dryRun {
		log.Printf("[DRY RUN] Would bail user=%s page=%s to form=%s with metadata=%v",
			userID, pageID, destinationForm, metadata)
		return nil
	}

	// Marshal event to JSON
	body, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("failed to marshal bailout event: %w", err)
	}

	// Create request with context
	req, err := http.NewRequestWithContext(ctx, "POST", s.botserverURL, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	// Send request
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send bailout to botserver: %w", err)
	}
	defer resp.Body.Close()

	// Check response status
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("botserver returned non-200 status: %d", resp.StatusCode)
	}

	log.Printf("Successfully bailed user=%s page=%s to form=%s", userID, pageID, destinationForm)
	return nil
}

// SendBailouts sends multiple bailout events with rate limiting
// Returns the IDs of successfully bailed users and any error encountered
func (s *Sender) SendBailouts(ctx context.Context, users []UserTarget, metadata map[string]interface{}) ([]string, error) {
	var bailedIDs []string
	var lastError error

	for i, user := range users {
		// Check context cancellation
		select {
		case <-ctx.Done():
			return bailedIDs, fmt.Errorf("context cancelled after %d successful sends: %w", len(bailedIDs), ctx.Err())
		default:
		}

		// Send bailout for this user using their destination form
		err := s.SendBailout(ctx, user.UserID, user.PageID, user.DestinationForm, metadata)
		if err != nil {
			log.Printf("Failed to bail user=%s page=%s: %v", user.UserID, user.PageID, err)
			lastError = err
			// Continue with remaining users even if one fails
		} else {
			bailedIDs = append(bailedIDs, user.UserID)
		}

		// Apply rate limiting (except after the last user)
		if i < len(users)-1 && s.rateLimit > 0 {
			select {
			case <-ctx.Done():
				return bailedIDs, fmt.Errorf("context cancelled during rate limit after %d successful sends: %w", len(bailedIDs), ctx.Err())
			case <-time.After(s.rateLimit):
			}
		}
	}

	// If we had any failures, return the last error along with bailed IDs
	if lastError != nil && len(bailedIDs) < len(users) {
		return bailedIDs, fmt.Errorf("failed to bail %d users, last error: %w", len(users)-len(bailedIDs), lastError)
	}

	return bailedIDs, nil
}
