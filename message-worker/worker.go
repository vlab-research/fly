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

type EventProducer interface {
	PublishEvent(ctx context.Context, event types.UniversalEvent) error
}

type Worker struct {
	clients  map[types.PlatformType]MessageSender
	producer EventProducer
	config   RetryConfig
	bp       *botparty.BotParty
	logger   *zap.Logger
}

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

func (w *Worker) ProcessCommand(ctx context.Context, rawCmd json.RawMessage) error {
	var baseCmd struct {
		Type string `json:"type"`
	}
	json.Unmarshal(rawCmd, &baseCmd)

	switch baseCmd.Type {
	case "send_message":
		var cmd types.SendMessageCommand
		json.Unmarshal(rawCmd, &cmd)
		return w.processSendMessage(ctx, cmd)

	case "handoff":
		var cmd types.HandoffCommand
		json.Unmarshal(rawCmd, &cmd)
		return w.processHandoff(ctx, cmd)

	case "":
		var cmd types.SendMessageCommand
		json.Unmarshal(rawCmd, &cmd)
		switch string(cmd.Message.Type) {
		case "native":
			return w.processNativeMessage(ctx, cmd)
		case "pass_thread_control":
			return w.processLegacyPassThreadControl(ctx, rawCmd)
		default:
			return w.processSendMessage(ctx, cmd)
		}

	default:
		return fmt.Errorf("unknown command type: %s", baseCmd.Type)
	}
}

func (w *Worker) processSendMessage(ctx context.Context, cmd types.SendMessageCommand) error {
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
		return w.reportError(cmd, err)
	}

	client, ok := w.clients[cmd.Platform]
	if !ok {
		err := fmt.Errorf("no client configured for platform: %s", cmd.Platform)
		return w.reportError(cmd, err)
	}

	_, sendErr := RetryWithBackoff(ctx, w.config, func() error {
		_, retryErr := client.SendMessage(ctx, cmd.PlatformAccountID, cmd.UserID, platformMsg, cmd.PlatformContext)
		return retryErr
	})

	if sendErr != nil {
		return w.reportError(cmd, sendErr)
	}

	// Event emission is temporarily disabled - replybot can't parse message_worker event shape
	// return w.emitMessageSent(ctx, cmd, resp.MessageID, 1)
	return nil
}

func (w *Worker) processHandoff(ctx context.Context, cmd types.HandoffCommand) error {
	client, ok := w.clients[cmd.Platform]
	if !ok {
		err := fmt.Errorf("no client configured for platform: %s", cmd.Platform)
		return w.reportError(w.handoffToCmd(cmd), err)
	}

	metadata := string(cmd.Metadata)
	_, handoffErr := RetryWithBackoff(ctx, w.config, func() error {
		return client.PassThreadControl(ctx, cmd.UserID, cmd.PlatformAccountID, cmd.TargetAppID, metadata)
	})

	if handoffErr != nil {
		return w.reportError(w.handoffToCmd(cmd), handoffErr)
	}

	// Event emission is temporarily disabled - replybot can't parse message_worker event shape
	// return w.emitMessageSent(ctx, w.handoffToCmd(cmd), "", 1)
	return nil
}

func (w *Worker) processNativeMessage(ctx context.Context, cmd types.SendMessageCommand) error {
	return fmt.Errorf("legacy native messages are no longer supported; use send_message with platform_context")
}

func (w *Worker) processLegacyPassThreadControl(ctx context.Context, rawCmd json.RawMessage) error {
	var legacy struct {
		CommandID         string             `json:"command_id"`
		IssuedAt          int64              `json:"issued_at"`
		ConversationID    string             `json:"conversation_id"`
		UserID            string             `json:"user_id"`
		Platform          types.PlatformType `json:"platform"`
		PlatformAccountID string             `json:"platform_account_id"`
		Message           struct {
			TargetAppID     string `json:"target_app_id"`
			HandoffMetadata string `json:"handoff_metadata"`
		} `json:"message"`
	}
	if err := json.Unmarshal(rawCmd, &legacy); err != nil {
		return fmt.Errorf("failed to parse legacy pass_thread_control: %w", err)
	}

	handoffCmd := types.HandoffCommand{
		Type:              "handoff",
		CommandID:         legacy.CommandID,
		IssuedAt:          legacy.IssuedAt,
		ConversationID:    legacy.ConversationID,
		UserID:            legacy.UserID,
		Platform:          legacy.Platform,
		PlatformAccountID: legacy.PlatformAccountID,
		TargetAppID:       legacy.Message.TargetAppID,
		Metadata:          json.RawMessage(legacy.Message.HandoffMetadata),
	}
	return w.processHandoff(ctx, handoffCmd)
}

func (w *Worker) handoffToCmd(cmd types.HandoffCommand) types.SendMessageCommand {
	return types.SendMessageCommand{
		CommandID:         cmd.CommandID,
		ConversationID:    cmd.ConversationID,
		UserID:            cmd.UserID,
		Platform:          cmd.Platform,
		PlatformAccountID: cmd.PlatformAccountID,
	}
}

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

	publishErr := w.producer.PublishEvent(ctx, event)
	if publishErr != nil {
		return fmt.Errorf("failed to publish failure event (original error: %v): %w", err, publishErr)
	}

	return nil
}

func generateEventID() string {
	return fmt.Sprintf("evt_%s", uuid.New().String())
}

func IsPlatformError(err error) bool {
	var platformErr *PlatformError
	return errors.As(err, &platformErr)
}

type MachineReportError struct {
	Tag     string `json:"tag"`
	Message string `json:"message"`
	Code    int    `json:"code,omitempty"`
}

type MachineReportValue struct {
	Error     MachineReportError `json:"error"`
	User      string             `json:"user"`
	Page      string             `json:"page"`
	Timestamp int64              `json:"timestamp"`
}

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
