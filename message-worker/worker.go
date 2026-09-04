package messageworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/vlab-research/fly/message-worker/mediaresolve"
	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

// HandledError signals that a command failed to send but the failure was already
// reported to botserver as a machine_report, which is what drives the
// conversation's ERROR/BLOCKED state transition. Re-processing would only
// re-send a message the user may already have received, so the Kafka offset
// should still be committed.
//
// It exists because ProcessCommand's return value was otherwise overloaded: nil
// meant both "sent" and "failed but handled", so the consumer logged "command
// processed successfully" for real send failures. The three outcomes are now
// distinguishable:
//
//	nil             -> the command was sent
//	*HandledError   -> the send failed and was reported; commit the offset
//	any other error -> processing itself failed (bad payload, unknown type)
type HandledError struct {
	underlying error
}

// NewHandledError wraps a send failure that has already been reported.
func NewHandledError(err error) *HandledError {
	return &HandledError{underlying: err}
}

func (he *HandledError) Error() string {
	return he.underlying.Error()
}

// Unwrap exposes the original failure so callers can log it, and so errors.Is /
// errors.As still reach through to the underlying error (e.g. *PlatformError).
func (he *HandledError) Unwrap() error {
	return he.underlying
}

type EventProducer interface {
	PublishEvent(ctx context.Context, event types.UniversalEvent) error
	// PublishRawEvent publishes pre-serialized event bytes under the given
	// partition key. Used to emit replybot-shaped events (whose JSON shape
	// differs from types.UniversalEvent) such as the WhatsApp send echo.
	PublishRawEvent(ctx context.Context, key string, value []byte) error
}

type Worker struct {
	clients  map[types.PlatformType]MessageSender
	producer EventProducer
	config   RetryConfig
	poster   SyntheticPoster
	logger   *zap.Logger

	mediaStore     MediaStore
	mediaHandleUse bool
	mediaMargin    time.Duration
}

func NewWorker(clients map[types.PlatformType]MessageSender, producer EventProducer, botserverURL string, logger *zap.Logger) *Worker {
	poster := NewHTTPSyntheticPoster(botserverURL + "/synthetic")
	return &Worker{
		clients:  clients,
		producer: producer,
		config:   DefaultRetryConfig(),
		poster:   poster,
		logger:   logger,
	}
}

// WithMediaStore enables the media handle layer. A Worker without one sends
// all media by URL -- the handle layer is an optimisation, never a
// requirement.
// WithRetryConfig replaces the worker's retry behaviour. Without it the worker
// uses DefaultRetryConfig, which is what main.go did before the retry
// environment variables were wired through -- they were read into Config and
// then ignored.
func (w *Worker) WithRetryConfig(config RetryConfig) *Worker {
	w.config = config
	return w
}

func (w *Worker) WithMediaStore(store MediaStore, use bool, margin time.Duration) *Worker {
	w.mediaStore = store
	w.mediaHandleUse = use
	w.mediaMargin = margin
	return w
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
	w.resolveMedia(ctx, &cmd)

	var platformMsg interface{}
	var err error

	switch cmd.Platform {
	case types.PlatformMessenger:
		var msg types.MessengerMessage
		msg, err = TranslateToMessenger(cmd)
		if err == nil {
			messagingType, tag := getMessengerSendParams(cmd)
			platformMsg = types.MessengerSendRequest{
				Message:       msg,
				MessagingType: messagingType,
				Tag:           tag,
			}
		}
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

	// WhatsApp has no native message echo (unlike Messenger's is_echo webhook),
	// yet the replybot state machine advances RESPONDING -> QOUT off a
	// bot_message_sent echo carrying the outbound message's metadata. Emit that
	// echo here so the survey progresses. Scoped to WhatsApp so platforms that
	// already echo natively don't get a duplicate.
	//
	// A failed echo is deliberately not a HandledError: the message itself was
	// sent, so reporting it as a send failure would be just as untruthful as
	// the reverse. It is not a hard error either — returning one would replay
	// the command and re-send a message the user already got. The warning above
	// is the signal; it stalls the state machine, not the delivery.
	if cmd.Platform == types.PlatformWhatsApp {
		if err := w.emitWhatsAppEcho(ctx, cmd); err != nil {
			w.logger.Warn("failed to emit whatsapp echo", zap.Error(err))
		}
	}

	// Event emission is temporarily disabled - replybot can't parse message_worker event shape
	// return w.emitMessageSent(ctx, cmd, resp.MessageID, 1)
	return nil
}

// resolveMedia decides, once, how a media message should be addressed on the
// wire, and stashes the decision on cmd.ResolvedMedia for the translators to
// read. See planning/media-abstraction.md §8.3 for the three resolution rules
// (order-sensitive) and §13 for the failure-mode table this implements.
func (w *Worker) resolveMedia(ctx context.Context, cmd *types.SendMessageCommand) {
	msg := &cmd.Message
	if msg.Type != types.MessageTypeMedia {
		return
	}
	// Rule 1 (§8.3): a legacy attachment id wins and is passed through
	// byte-for-byte. Never resolved, never touched.
	if !types.Blank(msg.MediaAttachmentID) {
		return
	}
	if types.Blank(msg.MediaURL) {
		return
	}
	url := *msg.MediaURL

	// Default to a URL send. EVERY early return below leaves this in place,
	// which is what makes the handle layer optional.
	cmd.ResolvedMedia = &types.MediaSendable{Kind: types.MediaByURL, URL: url}

	if !w.mediaHandleUse || w.mediaStore == nil {
		return
	}
	assetID, ok := mediaresolve.ParseAssetID(url)
	if !ok {
		return // third-party URL: no lookup, send as-is
	}

	handle, err := w.mediaStore.GetHandle(ctx, assetID, cmd.PlatformAccountID)
	if err != nil {
		// §13: a lookup failure MUST be logged and treated as a miss. This
		// is what makes "the handle layer can fail entirely" true rather
		// than aspirational.
		w.logger.Warn("media handle lookup failed, sending by URL",
			zap.Error(err),
			zap.String("asset_id", assetID),
			zap.String("platform_account_id", cmd.PlatformAccountID),
		)
		return
	}
	resolved := mediaresolve.Resolve(time.Now(), url, handle, w.mediaMargin)
	cmd.ResolvedMedia = &resolved

	if resolved.Kind == types.MediaByURL {
		// §8.5: the by-URL counter is the health signal for the handle layer.
		// A by-URL send for dashboard-uploaded media (asset URL parsed
		// successfully) is an anomaly and should sit near zero -- if it is
		// not, the fan-out or the reconciler is broken. No metrics
		// infrastructure (promauto/client_golang) exists in message-worker
		// today, so this is a structured log line rather than a counter; see
		// the implementation report for the metrics decision this needs.
		w.logger.Info("media resolved by_url",
			zap.String("kind", resolved.Kind.String()),
			zap.String("asset_id", assetID),
			zap.String("platform_account_id", cmd.PlatformAccountID),
		)
	}
}

// emitWhatsAppEcho publishes a replybot-shaped WhatsApp event (type "bot_echo")
// carrying the outbound message's metadata. The replybot normalizer maps it to
// event_type "bot_message_sent"; its ECHO handler reads payload.metadata (the
// ref/type/wait flags) to move the conversation forward.
//
// THIS WRITES STRAIGHT TO chat-events, bypassing hermes. message-worker is
// therefore a direct producer to that topic and must stamp the envelope
// itself -- nothing upstream will do it for it. See envelope.go for the
// correction this forced to the plan, and BuildWhatsAppEcho for the body.
//
// Until 2026-08-17 the body carried six fields and neither `account_id` nor
// `platform`. Every WhatsApp send therefore minted a `messages` row with a
// permanently NULL account, and the replay query's deliberately temporary
// `AND (account_id = $2 OR account_id IS NULL)` clause -- which exists so
// un-backfilled HISTORICAL rows keep replaying -- matched those NULL rows for
// EVERY account, leaking a participant's echoes across all of their
// conversations. That is the exact bug this effort exists to fix, reproduced
// on the one platform where it is deterministic. It also returned null from
// replybot's conversationFromRawEvent, so the echo could never key the state
// cache and always fell back to a replay.
func (w *Worker) emitWhatsAppEcho(ctx context.Context, cmd types.SendMessageCommand) error {
	data, err := json.Marshal(BuildWhatsAppEcho(cmd, time.Now()))
	if err != nil {
		return err
	}
	return w.producer.PublishRawEvent(ctx, cmd.UserID, data)
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

// reportError POSTs a machine_report to botserver so the state machine can
// transition (FB -> BLOCKED, STATE_ACTIONS -> ERROR), and returns a
// *HandledError wrapping the original failure. Every send path returns that
// error straight through, so the consumer can log the failure truthfully while
// still committing the offset.
//
// Delivering the machine_report is best-effort: if marshalling or the POST
// fails we log it and still return a *HandledError, because retrying the
// command risks re-sending a message that was already delivered. The command
// still failed either way, so it must never be reported as a success.
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
		return NewHandledError(err)
	}

	rawValue := json.RawMessage(valueJSON)
	event := &SyntheticEvent{
		User:      cmd.UserID,
		AccountID: cmd.PlatformAccountID,
		Platform:  string(cmd.Platform),
		Event: &SyntheticEventType{
			Type:  "machine_report",
			Value: &rawValue,
		},
	}

	sendErr := w.poster.Send(event)
	if sendErr != nil {
		w.logger.Error("failed to send machine_report to botserver — best-effort, skipping",
			zap.String("command_id", cmd.CommandID),
			zap.String("user_id", cmd.UserID),
			zap.Error(sendErr),
			zap.NamedError("original_error", err))
		return NewHandledError(err)
	}

	return NewHandledError(err)
}
