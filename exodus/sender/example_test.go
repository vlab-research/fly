package sender_test

import (
	"context"
	"log"
	"time"

	"github.com/vlab-research/exodus/sender"
)

// Example demonstrates basic usage of the Sender package
func Example() {
	// Create a new sender
	s := sender.New("http://gbv-botserver/synthetic", 1*time.Second, false)

	ctx := context.Background()

	// Define users to bail out
	users := []sender.UserTarget{
		{UserID: "user123", PageID: "page456"},
		{UserID: "user789", PageID: "page101"},
	}

	// Define metadata for the bailout
	metadata := map[string]interface{}{
		"reason":    "timeout",
		"threshold": 300,
	}

	// Send bailouts with rate limiting
	count, err := s.SendBailouts(ctx, users, "exit-form", metadata)
	if err != nil {
		log.Printf("Bailout completed with errors: %v", err)
	}

	log.Printf("Successfully bailed %d users", count)
}

// Example_dryRun demonstrates using dry run mode for testing
func Example_dryRun() {
	// Create sender in dry run mode
	s := sender.New("http://gbv-botserver/synthetic", 1*time.Second, true)

	ctx := context.Background()

	users := []sender.UserTarget{
		{UserID: "user123", PageID: "page456"},
	}

	// This will log what would be sent without actually sending
	count, err := s.SendBailouts(ctx, users, "test-form", nil)
	if err != nil {
		log.Fatalf("Dry run failed: %v", err)
	}

	log.Printf("Dry run: would have bailed %d users", count)
}

// Example_singleBailout demonstrates sending a single bailout
func Example_singleBailout() {
	s := sender.New("http://gbv-botserver/synthetic", 0, false)

	ctx := context.Background()

	// Send a single bailout
	err := s.SendBailout(ctx, "user123", "page456", "exit-form", map[string]interface{}{
		"reason": "user_requested",
	})
	if err != nil {
		log.Fatalf("Failed to send bailout: %v", err)
	}

	log.Println("Bailout sent successfully")
}
