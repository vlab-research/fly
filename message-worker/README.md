# Message Worker Core

Pure Go library for translating platform-agnostic message commands to platform-specific formats (Messenger, WhatsApp, Instagram).

## Overview

This is a production Go service that processes message-sending and thread-control commands from Kafka. It translates platform-agnostic commands to platform-specific API formats, with support for:

1. **Translated messages** (default path): Converts platform-agnostic message types (text, question, media) to platform-specific formats
2. **Native payloads** (`type: "native"`): Pre-formatted Facebook payloads bypassing translation (Phase 1)
3. **Pass thread control** (`type: "pass_thread_control"`): Handoff commands to other apps

**Key Features:**
- Kafka-driven, event-sourced architecture
- Multiple message routing paths by command type
- Retry logic with exponential backoff (100ms → 200ms → 400ms)
- Token caching from PostgreSQL
- Error classification (platform vs non-platform) for proper state transitions
- Comprehensive test coverage with native and handoff tests
- Production-ready for Messenger (stubs for WhatsApp/Instagram)

## Architecture

```
message-worker/
├── cmd/
│   └── message-worker/
│       └── main.go      # Service entry point
├── chart/               # Helm deployment chart
├── types/
│   ├── command.go       # SendMessageCommand, MessageContent (including native & pass_thread_control)
│   ├── errors.go        # Error types
│   ├── events.go        # Event envelope types
│   ├── messenger.go     # Messenger API types
│   ├── whatsapp.go      # WhatsApp API types
│   └── instagram.go     # Instagram API types
├── client.go            # MessageSender interface
├── messenger_client.go  # Messenger API client (SendMessage, SendNativeMessage, PassThreadControl)
├── worker.go            # Worker orchestration with routing by message type
├── translator.go        # Messenger translation
├── translator_whatsapp.go  # WhatsApp translation
├── translator_instagram.go # Instagram translation
├── retry.go             # Retry logic with exponential backoff
├── tokenstore.go        # Token storage/caching
├── kafka.go             # Kafka producer
├── stub_clients.go      # Stub implementations for unimplemented platforms
└── *_test.go            # Comprehensive tests including native and handoff
```

## Usage

### Basic Translation

```go
import (
    messageworker "github.com/vlab-research/fly/message-worker-core"
    "github.com/vlab-research/fly/message-worker-core/types"
)

// Create a command
cmd := types.SendMessageCommand{
    CommandID:      "cmd_123",
    ConversationID: "conv_456",
    UserID:         "user_789",
    Platform:       types.PlatformMessenger,
    Message: types.MessageContent{
        Type: types.MessageTypeText,
        Text: stringPtr("Hello, world!"),
    },
}

// Translate to Messenger format
messengerMsg, err := messageworker.TranslateToMessenger(cmd)
if err != nil {
    log.Fatal(err)
}

// Use messengerMsg to call Bottleneck API
```

### Question with Options

```go
// Messenger (quick replies)
cmd := types.SendMessageCommand{
    Platform: types.PlatformMessenger,
    Message: types.MessageContent{
        Type:         types.MessageTypeQuestion,
        QuestionText: stringPtr("What is your gender?"),
        Options: []types.Option{
            {Value: "male", Label: "Male"},
            {Value: "female", Label: "Female"},
            {Value: "other", Label: "Other"},
        },
    },
}

messengerMsg, _ := messageworker.TranslateToMessenger(cmd)
// Result: text + quick_replies (3 buttons)

// WhatsApp (buttons for ≤3, list for 4-10)
cmd.Platform = types.PlatformWhatsApp
whatsappMsg, _ := messageworker.TranslateToWhatsApp(cmd)
// Result: interactive message with 3 buttons

// Add more options (4+)
cmd.Message.Options = append(cmd.Message.Options, types.Option{Value: "prefer_not", Label: "Prefer not to say"})
whatsappMsg, _ = messageworker.TranslateToWhatsApp(cmd)
// Result: interactive message with list (4 items)
```

### Media Messages

```go
cmd := types.SendMessageCommand{
    Platform: types.PlatformWhatsApp,
    Message: types.MessageContent{
        Type:      types.MessageTypeMedia,
        MediaType: mediaTypePtr(types.MediaTypeImage),
        MediaURL:  stringPtr("https://example.com/image.jpg"),
        Caption:   stringPtr("Check this out!"),
    },
}

whatsappMsg, _ := messageworker.TranslateToWhatsApp(cmd)
// Result: image message with caption
```

### Native Payload (Phase 1 - Messenger only)

```go
// Pre-formatted Facebook API payload - skips translation entirely
cmd := types.SendMessageCommand{
    CommandID:         "cmd_native_123",
    UserID:            "user_456",
    Platform:          types.PlatformMessenger,
    PlatformAccountID: "page_789",
    Message: types.MessageContent{
        Type: types.MessageTypeNative,
        NativePayload: json.RawMessage(`{
            "recipient": {"id": "user_456"},
            "message": {
                "text": "What's your gender?",
                "quick_replies": [
                    {"content_type": "text", "title": "Male", "payload": "male"},
                    {"content_type": "text", "title": "Female", "payload": "female"}
                ]
            }
        }`),
    },
}

// Worker calls SendNativeMessage, which POSTs the payload directly to /me/messages
// No translation occurs - payload is sent as-is
```

### Pass Thread Control (Messenger handoff)

```go
// Hand off conversation to another app
cmd := types.SendMessageCommand{
    CommandID:         "cmd_handoff_123",
    UserID:            "user_456",
    Platform:          types.PlatformMessenger,
    PlatformAccountID: "page_789",
    Message: types.MessageContent{
        Type:            types.MessageTypePassThreadControl,
        TargetAppID:     "263902037430900",  // Target app's ID
        HandoffMetadata: `{"source":"replybot","reason":"live_agent_request"}`,
    },
}

// Worker calls PassThreadControl, which POSTs to /me/pass_thread_control
// Hands off the conversation thread to the target app
```

## Command Routing

The worker routes commands by message type:

### 1. Translated Messages (default path)
Existing message types that go through translation: `text`, `question`, `media`
- Routes to `processTranslatedMessage()`
- Calls appropriate translation function (Messenger/WhatsApp/Instagram)
- Example: Platform-agnostic question with options → platform-specific quick replies/buttons

### 2. Native Passthrough (`type: "native"`)
Pre-formatted platform-specific payloads (Phase 1 - Facebook only)
- Routes to `processNativeMessage()`
- Skips translation entirely
- Forwards `native_payload` (json.RawMessage) directly to Facebook `/me/messages`
- Use case: Replybot sends pre-built Facebook message with exact structure it generated

### 3. Pass Thread Control (`type: "pass_thread_control"`)
Handoff commands for conversation transfer
- Routes to `processPassThreadControl()`
- Calls Facebook `/me/pass_thread_control` endpoint
- Required fields: `target_app_id`, `handoff_metadata`
- Use case: Hand off conversation to live agent or different app

## Translation Logic

### Messenger

| Message Type | Translation |
|-------------|-------------|
| Text | `text` field |
| Question (≤13 options) | `text` + `quick_replies` |
| Question (>13 options) | Error: `ErrTooManyOptions` |
| Media | `attachment` with type and URL |
| Native (phase 1) | Bypass translation, send raw payload |
| Pass Thread Control | Call `/me/pass_thread_control` endpoint |

### WhatsApp

| Message Type | Translation |
|-------------|-------------|
| Text | `type: "text"` with `body` |
| Question (≤3 options) | `type: "interactive"` with buttons |
| Question (4-10 options) | `type: "interactive"` with list |
| Question (>10 options) | Error: `ErrTooManyOptions` |
| Media | Type-specific field (`image`, `video`, `audio`, `document`) |

### Instagram

Same as Messenger (Instagram uses the same API structure).

## Error Handling

The translation functions return clear errors for invalid inputs:

```go
// Missing required fields
ErrMissingTextField
ErrMissingQuestionTextField
ErrMissingOptions
ErrMissingMediaType
ErrMissingMediaURL

// Platform limitations
ErrTooManyOptions         // Exceeded platform's option limit
ErrUnsupportedMediaType   // Media type not supported by platform
ErrUnsupportedMessageType // Unknown message type
```

## Testing

The package includes comprehensive table-driven tests:

```bash
go test -v ./...
```

**Test Coverage:**
- ✅ Text messages
- ✅ Questions with various option counts
- ✅ Option limit boundaries (3, 10, 13)
- ✅ All media types (image, video, audio, file)
- ✅ Error cases (missing fields, too many options)
- ✅ All platforms (Messenger, WhatsApp, Instagram)

**Results:**
```
26 tests, 26 passed, 0 failed
```

## Platform Limits

| Platform | Text | Question Options | Media Types |
|----------|------|-----------------|-------------|
| Messenger | ✅ | ≤13 quick replies | image, video, audio, file |
| WhatsApp | ✅ | ≤3 buttons, ≤10 list | image, video, audio, document |
| Instagram | ✅ | ≤13 quick replies | image, video, audio, file |

## Integration with Message-Worker

This library provides the core translation logic. The full Message-Worker will:

1. Consume `SendMessageCommand` from Kafka
2. Call appropriate translation function based on platform
3. Call Bottleneck API with translated message
4. Retry on failure (2-3 attempts, exponential backoff)
5. Emit `MessageSent` or `MessageFailed` events

```go
// Example integration
func (w *MessageWorker) ProcessCommand(ctx context.Context, cmd types.SendMessageCommand) error {
    // Translate based on platform
    var platformMsg interface{}
    var err error

    switch cmd.Platform {
    case types.PlatformMessenger:
        platformMsg, err = messageworker.TranslateToMessenger(cmd)
    case types.PlatformWhatsApp:
        platformMsg, err = messageworker.TranslateToWhatsApp(cmd)
    case types.PlatformInstagram:
        platformMsg, err = messageworker.TranslateToInstagram(cmd)
    default:
        return fmt.Errorf("unsupported platform: %s", cmd.Platform)
    }

    if err != nil {
        w.emitMessageFailed(ctx, cmd, err)
        return err
    }

    // Call Bottleneck API with retry
    messageID, err := w.bottleneck.SendMessage(ctx, platformMsg)
    if err != nil {
        w.emitMessageFailed(ctx, cmd, err)
        return err
    }

    w.emitMessageSent(ctx, cmd, messageID)
    return nil
}
```

## Components

### Core Translation (Complete)
- Platform-agnostic to platform-specific message translation
- Messenger, WhatsApp, and Instagram support
- Comprehensive validation and error handling
- 26 translation tests, 86.4% coverage

### Bottleneck Client (New)
- HTTP client for Bottleneck API
- Automatic retry for transient failures
- Proper error classification (retriable vs non-retriable)
- 6 comprehensive tests

### Retry Logic (New)
- Exponential backoff (100ms → 200ms → 400ms)
- Context-aware cancellation
- Configurable retry parameters
- 9 comprehensive tests

### Worker Orchestration (New)
- End-to-end command processing
- Event emission (message_sent, message_failed)
- Proper error propagation
- 6 comprehensive tests

## Test Results

**Total:** 41 tests passing, 0 failures
**Coverage:** 78.9%
**Execution Time:** ~470ms

```bash
go test -v ./...
# PASS
# ok      github.com/vlab-research/fly/message-worker-core        0.471s  coverage: 78.9% of statements
```

See [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) for detailed implementation documentation.

## Local Development

### Overview

The dev workflow uses a local Kind cluster. `make dev` (from `devops/`) bootstraps
the full cluster including Kafka, CockroachDB, and redis-ha, then deploys all
services via Helm using `devops/values/integrations/fly.yaml`. The Helm-deployed
replybot is the tagged release image; `dev.sh` scripts replace individual services
with locally-built images.

### Prerequisites

- Kind cluster running: `cd devops && make dev`
- Local registry at `localhost:5000` (created by `make dev` via `kind-with-registry.sh`)
- Facebot deployed: `kubectl apply -f devops/testing/facebot.yaml`

### Deploy message-worker locally

```bash
cd message-worker
./dev.sh
```

This builds the image, pushes to the local Kind registry, and applies `kube-dev/dev.yaml`.

### Deploy replybot locally (required — Helm image lacks message-worker changes)

```bash
cd replybot
./dev.sh
```

The Helm-deployed replybot (`v0.0.168`) still calls Facebook directly. The branch
version publishes to `KAFKA_COMMAND_TOPIC=commands` instead, so this step is required
for the end-to-end flow to work.

### Full local dev workflow

```bash
# 1. Bootstrap cluster (first time or after cluster reset)
cd devops && make dev

# 2. Deploy facebot mock
kubectl apply -f devops/testing/facebot.yaml
kubectl wait --for=condition=available deployment/gbv-facebot --timeout=5m

# 3. Replace replybot with local build
cd replybot && ./dev.sh

# 4. Deploy message-worker
cd message-worker && ./dev.sh

# 5. Run integration tests
cd devops && make start-testrunner
kubectl wait --for=condition=complete job/testrunner --timeout=20m
kubectl logs -l app=testrunner --tail=-1
```

### Kafka topics in dev

The `commands` topic is provisioned by `devops/dev/kafka-topics.yaml` (applied
during `make dev`). Message-worker reads from `commands`; replybot publishes to
`commands` (default for `KAFKA_COMMAND_TOPIC` / `KAFKA_COMMANDS_TOPIC`).

### Environment variables (kube-dev)

| Variable | Value | Notes |
|----------|-------|-------|
| `KAFKA_BROKERS` | `kafka:9092` | Dev cluster Kafka service |
| `KAFKA_COMMAND_TOPIC` | `commands` | Input topic from replybot |
| `KAFKA_EVENT_TOPIC` | `chat-events` | Output topic for message_sent/failed events |
| `DATABASE_URL` | `postgresql://chatroach@db-cockroachdb-public:26257/chatroach?sslmode=disable` | Token lookup |
| `BOTSERVER_URL` | `http://fly-botserver` | Error reporting via `/synthetic` |
| `FACEBOOK_GRAPH_URL` | `http://gbv-facebot` | Points to facebot mock in dev |
| `NUM_WORKERS` | `10` | Reduced from production default of 100 |

## Dependencies

- Go 1.21+
- `github.com/google/uuid` v1.6.0 (UUID generation)
- Standard library (context, net/http, encoding/json, time, errors)

## License

Copyright (c) vlab-research
