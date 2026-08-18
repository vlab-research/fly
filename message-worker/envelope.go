package messageworker

import (
	"encoding/json"
	"time"

	"github.com/vlab-research/fly/message-worker/types"
)

// The event envelope, producer side.
//
// message-worker is a DIRECT PRODUCER to the chat-events topic. That contradicts
// what `documentation/event-envelope.md` and `planning/conversation-identity.md`
// §4 asserted until 2026-08-17 -- "chat-events has exactly one producer,
// hermes" -- and the correction matters, because every claim about the envelope
// being universally stamped rested on hermes being the only writer. It is not:
// `emitWhatsAppEcho` publishes straight to KAFKA_EVENT_TOPIC (default
// `chat-events`) via EventProducer.PublishRawEvent, bypassing hermes and
// therefore bypassing hermes' derivation entirely.
//
// So the two normalized fields have to be stamped HERE, and the guard below
// exists so that the next direct producer cannot repeat the omission silently.
//
// This file is the functional core: everything in it is pure and total. The
// Kafka-side shell (kafka.go) does the IO and the logging.

// EnvelopeAccountIDField and EnvelopePlatformField are the two normalized
// top-level fields every event body on chat-events carries
// (documentation/event-envelope.md). They are named here rather than inline so
// the guard and the builders cannot drift apart.
const (
	EnvelopeAccountIDField = "account_id"
	EnvelopePlatformField  = "platform"
)

// EnvelopeMissingTag is the greppable literal logged when an event is published
// to chat-events without a complete envelope. It is the counter for "some
// producer in this service is not stamping the conversation", in the same style
// as hermes' [INCOMPLETE_CONVERSATION] and replybot's
// CONVERSATION_TUPLE_MISSING. Nothing else in the codebase may use this string.
const EnvelopeMissingTag = "CHAT_EVENTS_ENVELOPE_MISSING"

// WhatsAppEcho is the replybot-shaped WhatsApp event message-worker emits after
// a successful WhatsApp send. WhatsApp has no native echo webhook (unlike
// Messenger's is_echo), so this is what advances the state machine from
// RESPONDING to QOUT.
//
// It carries the envelope (`account_id`, `platform`) AND the per-shape
// `phone_number_id`. Both, deliberately: the envelope is what every forward
// consumer reads, and `phone_number_id` is what the `messages` backfill reads
// out of historical `content` -- keeping it means old and new rows share one
// extraction path. See documentation/event-envelope.md, "Nothing was removed".
type WhatsAppEcho struct {
	Source        string          `json:"source"`
	AccountID     string          `json:"account_id"`
	Platform      string          `json:"platform"`
	PhoneNumberID string          `json:"phone_number_id"`
	From          string          `json:"from"`
	Type          string          `json:"type"`
	Metadata      json.RawMessage `json:"metadata"`
	Timestamp     int64           `json:"timestamp"`
}

// BuildWhatsAppEcho is pure and total: same command and same clock in, same
// echo out, no IO. `now` is a parameter rather than a time.Now() call precisely
// so the shape is assertable byte-for-byte in a test.
//
// Neither identity component is derived or inferred. `cmd.PlatformAccountID` is
// the account the message was just sent from, and the platform is WhatsApp by
// construction -- emitWhatsAppEcho is only reached under
// `cmd.Platform == types.PlatformWhatsApp`. We stamp `types.PlatformWhatsApp`
// rather than `cmd.Platform` so the value cannot silently become "instagram" if
// this is ever called from the wrong branch; the echo body itself is
// WhatsApp-shaped, so a non-WhatsApp platform on it would be a lie either way.
func BuildWhatsAppEcho(cmd types.SendMessageCommand, now time.Time) WhatsAppEcho {
	metadata := cmd.Message.Metadata
	if len(metadata) == 0 {
		metadata = json.RawMessage("null")
	}

	return WhatsAppEcho{
		Source:        string(types.PlatformWhatsApp),
		AccountID:     cmd.PlatformAccountID,
		Platform:      string(types.PlatformWhatsApp),
		PhoneNumberID: cmd.PlatformAccountID,
		From:          cmd.UserID,
		Type:          "bot_echo",
		Metadata:      metadata,
		Timestamp:     now.UnixMilli(),
	}
}

// MissingEnvelopeFields reports which normalized identity fields an
// already-serialized chat-events body fails to carry, in a stable order. Pure
// and total: it returns nil when the envelope is complete, and never panics or
// errors for any input.
//
// It inspects the SERIALIZED BYTES rather than a typed struct on purpose. That
// is what makes it a chokepoint instead of a convention: it holds for every
// shape this service publishes -- the replybot-shaped echo, types.UniversalEvent,
// and anything a future caller invents -- without any of them having to know the
// guard exists.
//
// A field counts as present only when it is a NON-EMPTY JSON STRING. That is the
// same rule hermes applies ("a field is stamped only when it derives to a
// non-empty string") and the same rule replybot's identityComponent applies on
// the consuming side. Two real shapes fail it in ways a presence check would
// miss:
//
//   - an empty string, which is a poisoned cache key downstream rather than a name;
//   - types.UniversalEvent, whose `platform` marshals as the OBJECT
//     {"type":..., "account_id":...} and which carries no top-level `account_id`
//     at all. Its two emitters are dead today -- emitMessageSent's only call
//     sites are commented out (worker.go:187, :301) and emitMessageFailed has no
//     caller at all -- but they are one uncomment away from producing
//     envelope-violating events, and an object-valued `platform` is worse than an
//     absent one: replybot's conversationFromRawEvent rejects a non-string
//     component, so the conversation would go unnamed while looking stamped.
//
// An unparseable or non-object body names neither field, which is the truthful
// answer and not an error condition: this function's job is to say what the
// event carries, not to validate JSON.
func MissingEnvelopeFields(value []byte) []string {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(value, &fields); err != nil {
		return []string{EnvelopeAccountIDField, EnvelopePlatformField}
	}

	var missing []string
	for _, name := range []string{EnvelopeAccountIDField, EnvelopePlatformField} {
		if !hasIdentityComponent(fields, name) {
			missing = append(missing, name)
		}
	}
	return missing
}

// hasIdentityComponent is pure and total. See MissingEnvelopeFields for why
// only a non-empty JSON string counts.
func hasIdentityComponent(fields map[string]json.RawMessage, name string) bool {
	raw, ok := fields[name]
	if !ok {
		return false
	}

	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return false
	}
	return s != ""
}
