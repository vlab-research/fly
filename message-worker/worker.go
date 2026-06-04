package messageworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/vlab-research/botparty"
	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

// EventProducer is an interface for emitting events to Kafka
type EventProducer interface {
	PublishEvent(ctx context.Context, event types.UniversalEvent) error
}

// Worker processes SendMessageCommands and emits events
type Worker struct {
	clients  map[types.PlatformType]MessageSender
	producer EventProducer
	config   RetryConfig
	bp       *botparty.BotParty
	logger   *zap.Logger
}

// NewWorker creates a new message worker
func NewWorker(clients map[types.PlatformType]MessageSender, producer EventProducer, botserverURL string, logger *zap.Logger) *Worker {
	bp := botparty.NewBotParty(botserverURL + "/synthetic")
	return &Worker{
		clients:  clients,
		producer: producer,
		config:   DefaultRetryConfig(),
		bp:       bp,
		logger:   logger,
	}
}

// ProcessCommand processes a send message command with retry logic
// Routes by message type:
// - "native" → processNativeMessage() — skip translation, forward pre-formatted payload
// - "pass_thread_control" → processPassThreadControl() — call PassThreadControl endpoint
// - default → processTranslatedMessage() — existing translation path
func (w *Worker) ProcessCommand(ctx context.Context, cmd types.SendMessageCommand) error {
	// Route by message type
	switch cmd.Message.Type {
	case types.MessageTypeNative:
		return w.processNativeMessage(ctx, cmd)
	case types.MessageTypePassThreadControl:
		return w.processPassThreadControl(ctx, cmd)
	default:
		return w.processTranslatedMessage(ctx, cmd)
	}
}

// processTranslatedMessage handles the existing translation path (text, question, media)
func (w *Worker) processTranslatedMessage(ctx context.Context, cmd types.SendMessageCommand) error {
	// Translate platform-agnostic message to platform-specific format
	var platformMsg interface{}
	var err error

	switch cmd.Platform {
	case types.PlatformMessenger:
		platformMsg, err = TranslateToMessenger(cmd)
	case types.PlatformWhatsApp:
		platformMsg, err = TranslateToWhatsApp(cmd)
	case types.PlatformInstagram:
		platformMsg, err = TranslateToInstagram(cmd)
	default:
		err = fmt.Errorf("unsupported platform: %s", cmd.Platform)
	}

	if err != nil {
		// Translation error - report to trigger ERROR state transition
		// This uses STATE_ACTIONS tag since it's not a platform error
		return w.reportError(cmd, err)
	}

	// Get platform-specific client
	client, ok := w.clients[cmd.Platform]
	if !ok {
		// No client configured for this platform - report to trigger ERROR state
		err := fmt.Errorf("no client configured for platform: %s", cmd.Platform)
		return w.reportError(cmd, err)
	}

	// Send message with retry logic
	var resp *SendMessageResponse
	_, sendErr := RetryWithBackoff(ctx, w.config, func() error {
		var retryErr error
		resp, retryErr = client.SendMessage(ctx, cmd.PlatformAccountID, cmd.UserID, platformMsg)
		return retryErr
	})

	if sendErr != nil {
		// Failed after retries - report to trigger state transition
		// IsPlatformError determines tag: FB (→ BLOCKED) or STATE_ACTIONS (→ ERROR)
		return w.reportError(cmd, sendErr)
	}

	// Success
	return w.emitMessageSent(ctx, cmd, resp.MessageID, 1)
}

// processNativeMessage sends a pre-formatted native payload without translation
func (w *Worker) processNativeMessage(ctx context.Context, cmd types.SendMessageCommand) error {
	// Get platform-specific client
	client, ok := w.clients[cmd.Platform]
	if !ok {
		// No client configured for this platform - report to trigger ERROR state
		err := fmt.Errorf("no client configured for platform: %s", cmd.Platform)
		return w.reportError(cmd, err)
	}

	// Send native message with retry logic
	var messageID string
	_, sendErr := RetryWithBackoff(ctx, w.config, func() error {
		var retryErr error
		messageID, retryErr = client.SendNativeMessage(ctx, cmd.UserID, cmd.PlatformAccountID, cmd.Message.NativePayload)
		return retryErr
	})

	if sendErr != nil {
		// Failed after retries - report to trigger state transition
		return w.reportError(cmd, sendErr)
	}

	// Success
	return w.emitMessageSent(ctx, cmd, messageID, 1)
}

// processPassThreadControl sends a pass_thread_control command
func (w *Worker) processPassThreadControl(ctx context.Context, cmd types.SendMessageCommand) error {
	// Get platform-specific client
	client, ok := w.clients[cmd.Platform]
	if !ok {
		// No client configured for this platform - report to trigger ERROR state
		err := fmt.Errorf("no client configured for platform: %s", cmd.Platform)
		return w.reportError(cmd, err)
	}

	// Send pass_thread_control with retry logic
	_, handoffErr := RetryWithBackoff(ctx, w.config, func() error {
		return client.PassThreadControl(ctx, cmd.UserID, cmd.PlatformAccountID, cmd.Message.TargetAppID, cmd.Message.HandoffMetadata)
	})

	if handoffErr != nil {
		// Failed after retries - report to trigger state transition
		return w.reportError(cmd, handoffErr)
	}

	// Success - for pass_thread_control, we emit with empty message_id since there's no message to track
	return w.emitMessageSent(ctx, cmd, "", 1)
}

// emitMessageSent emits a message_sent event
func (w *Worker) emitMessageSent(ctx context.Context, cmd types.SendMessageCommand, messageID string, attempts int) error {
	payload := types.MessageSentPayload{
		Type:              "message_sent",
		CommandID:         cmd.CommandID,
		ConversationID:    cmd.ConversationID,
		UserID:            cmd.UserID,
		PlatformMessageID: &messageID,
		Attempts:          attempts,
	}

	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	event := types.UniversalEvent{
		EventID:        generateEventID(),
		ConversationID: cmd.ConversationID,
		UserID:         cmd.UserID,
		Timestamp:      time.Now().UnixMilli(),
		Platform: types.PlatformContext{
			Type:      cmd.Platform,
			AccountID: cmd.PlatformAccountID,
		},
		Source:    types.EventSourceMessageWorker,
		EventType: "message_sent",
		Payload:   payloadJSON,
	}

	return w.producer.PublishEvent(ctx, event)
}

// emitMessageFailed emits a message_failed event
// When the failure event is successfully published, returns nil to indicate the message
// was handled (the user will be put into an error state). This allows the consumer to
// commit the offset rather than retrying the message.
func (w *Worker) emitMessageFailed(ctx context.Context, cmd types.SendMessageCommand, err error, attempts int, retriable bool) error {
	errorCode := GetErrorCode(err)
	payload := types.MessageFailedPayload{
		Type:           "message_failed",
		CommandID:      cmd.CommandID,
		ConversationID: cmd.ConversationID,
		UserID:         cmd.UserID,
		Error:          err.Error(),
		ErrorCode:      &errorCode,
		Attempts:       attempts,
		Retriable:      retriable,
	}

	payloadJSON, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		return fmt.Errorf("failed to marshal payload: %w", marshalErr)
	}

	event := types.UniversalEvent{
		EventID:        generateEventID(),
		ConversationID: cmd.ConversationID,
		UserID:         cmd.UserID,
		Timestamp:      time.Now().UnixMilli(),
		Platform: types.PlatformContext{
			Type:      cmd.Platform,
			AccountID: cmd.PlatformAccountID,
		},
		Source:    types.EventSourceMessageWorker,
		EventType: "message_failed",
		Payload:   payloadJSON,
	}

	// Publish the failure event - if successful, the error has been "handled"
	// and the user will be put into an error state
	publishErr := w.producer.PublishEvent(ctx, event)
	if publishErr != nil {
		// Only return error if we failed to publish - this will cause a retry
		return fmt.Errorf("failed to publish failure event (original error: %v): %w", err, publishErr)
	}

	// Successfully published failure event - error is handled, return nil
	// to allow the consumer to commit and move on
	return nil
}

// generateEventID creates a new event ID
func generateEventID() string {
	return fmt.Sprintf("evt_%s", uuid.New().String())
}

// IsPlatformError checks if the error is a platform API error (e.g., user blocked bot)
// This is used to determine if we should use the "FB" tag (→ BLOCKED state)
// or "STATE_ACTIONS" tag (→ ERROR state) in the machine_report
func IsPlatformError(err error) bool {
	var platformErr *PlatformError
	return errors.As(err, &platformErr)
}

// MachineReportError represents the error structure for machine_report events
type MachineReportError struct {
	Tag     string `json:"tag"`
	Message string `json:"message"`
	Code    int    `json:"code,omitempty"`
}

// MachineReportValue represents the value field of a machine_report event
// This matches the structure expected by replybot's machine.js:
// { error: { tag: "FB", message: "..." }, user: "...", page: "...", timestamp: ... }
type MachineReportValue struct {
	Error     MachineReportError `json:"error"`
	User      string             `json:"user"`
	Page      string             `json:"page"`
	Timestamp int64              `json:"timestamp"`
}

// reportError sends a machine_report event to botserver /synthetic endpoint
// This triggers the state machine to transition the user to ERROR or BLOCKED state
// - "FB" tag: Platform errors (user blocked bot, etc.) → BLOCKED state
// - "STATE_ACTIONS" tag: Other errors (translation, config, etc.) → ERROR state
// Returns nil on best-effort basis: if botserver is unreachable, the original send
// already failed and reporting is auxiliary — we log the failure rather than
// crash-looping the worker.
func (w *Worker) reportError(cmd types.SendMessageCommand, err error) error {
	tag := "STATE_ACTIONS"
	code := 0
	if IsPlatformError(err) {
		tag = "FB"
		var platformErr *PlatformError
		if errors.As(err, &platformErr) {
			code = platformErr.StatusCode
		}
	}

	reportValue := MachineReportValue{
		Error: MachineReportError{
			Tag:     tag,
			Message: err.Error(),
			Code:    code,
		},
		User:      cmd.UserID,
		Page:      cmd.PlatformAccountID,
		Timestamp: time.Now().UnixMilli(),
	}

	valueJSON, marshalErr := json.Marshal(reportValue)
	if marshalErr != nil {
		w.logger.Error("failed to marshal machine_report value",
			zap.String("command_id", cmd.CommandID),
			zap.Error(marshalErr))
		return nil
	}

	rawValue := json.RawMessage(valueJSON)
	event := botparty.NewExternalEvent(cmd.UserID, cmd.PlatformAccountID, "machine_report", &rawValue)

	sendErr := w.bp.Send(event)
	if sendErr != nil {
		w.logger.Error("failed to send machine_report to botserver — best-effort, skipping",
			zap.String("command_id", cmd.CommandID),
			zap.String("user_id", cmd.UserID),
			zap.Error(sendErr),
			zap.NamedError("original_error", err))
		return nil
	}

	return nil
}
