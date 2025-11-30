# Sender Package

The `sender` package provides functionality to send bailout events to the botserver's synthetic events endpoint.

## Overview

The sender package implements a rate-limited HTTP client for sending bailout events that trigger form transitions in the botserver. It follows the patterns established in the dean service and provides both single-send and batch-send capabilities.

## Key Features

- **Single and Batch Operations**: Send individual bailouts or multiple bailouts with one call
- **Rate Limiting**: Configurable delay between sends to avoid overwhelming the botserver
- **Dry Run Mode**: Test bailout logic without actually sending events
- **Context Support**: Full context cancellation support for graceful shutdowns
- **Error Handling**: Continues processing remaining users even if individual sends fail
- **Comprehensive Logging**: Logs all bailout attempts with details

## Usage

### Basic Usage

```go
package main

import (
    "context"
    "log"
    "time"

    "github.com/vlab-research/exodus/sender"
)

func main() {
    // Create sender with 1 second rate limit
    s := sender.New("http://gbv-botserver/synthetic", 1*time.Second, false)

    ctx := context.Background()

    // Define users to bail
    users := []sender.UserTarget{
        {UserID: "user123", PageID: "page456"},
        {UserID: "user789", PageID: "page101"},
    }

    // Send bailouts
    count, err := s.SendBailouts(ctx, users, "exit-form", map[string]interface{}{
        "reason": "timeout",
    })

    if err != nil {
        log.Printf("Completed with errors: %v", err)
    }
    log.Printf("Successfully bailed %d users", count)
}
```

### Dry Run Mode

```go
// Create sender in dry run mode for testing
s := sender.New("http://gbv-botserver/synthetic", 1*time.Second, true)

// This will log what would be sent without making HTTP requests
count, err := s.SendBailouts(ctx, users, "test-form", nil)
```

### Single Bailout

```go
// Send a single bailout event
err := s.SendBailout(ctx, "user123", "page456", "exit-form", map[string]interface{}{
    "reason": "user_requested",
    "timestamp": time.Now().Unix(),
})
```

## Types

### BailoutEvent

The complete event structure sent to botserver:

```go
type BailoutEvent struct {
    User  string       `json:"user"`
    Page  string       `json:"page"`
    Event *EventDetail `json:"event"`
}

type EventDetail struct {
    Type  string     `json:"type"`
    Value *BailValue `json:"value"`
}

type BailValue struct {
    Form     string                 `json:"form"`
    Metadata map[string]interface{} `json:"metadata,omitempty"`
}
```

### UserTarget

Represents a user to be bailed out:

```go
type UserTarget struct {
    UserID string  // The user's ID
    PageID string  // The Facebook page ID
}
```

## Configuration

### Constructor Parameters

- **botserverURL**: Full URL to botserver's synthetic events endpoint (e.g., `http://gbv-botserver/synthetic`)
- **rateLimit**: Duration to wait between sends (e.g., `1*time.Second`). Set to 0 for no rate limiting.
- **dryRun**: Boolean flag. When true, logs bailouts without sending HTTP requests.

## Error Handling

The sender uses a "fail fast and loud" approach:

- Errors are logged immediately when they occur
- `SendBailouts` continues processing remaining users even if individual sends fail
- Returns both success count and the last error encountered
- Context cancellation is checked between each send

## Testing

The package includes comprehensive tests with 91.7% code coverage:

```bash
go test ./sender
go test -cover ./sender
```

Test scenarios include:
- Successful bailouts
- Server errors (500 responses)
- Context cancellation
- Rate limiting verification
- Dry run mode
- Partial failures (some users succeed, others fail)
- Empty user lists
- Nil metadata handling

## Integration

This package is designed to work with:
- **botserver**: Expects POST requests to `/synthetic` endpoint
- **exodus service**: Used by the executor to send bailout events
- **bailer-job**: Event format matches bailer-job's output structure

## Logging

The sender logs:
- Successful bailouts: `Successfully bailed user=X page=Y to form=Z`
- Failed bailouts: `Failed to bail user=X page=Y: error details`
- Dry run events: `[DRY RUN] Would bail user=X page=Y to form=Z with metadata=...`

## Performance Considerations

- Rate limiting is applied between sends (not after the last send)
- HTTP client reuses connections via the same `http.Client` instance
- Context cancellation is checked before each send and during rate limit delays
- Failed sends don't stop processing of remaining users
