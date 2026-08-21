package messageworker

import (
	"encoding/json"
	"time"

	"github.com/vlab-research/fly/message-worker/types"
)

// The event envelope, producer side.
//
// message-worker is a DIRECT PRODUCER to chat-events: emitWhatsAppEcho publishes
// straight to KAFKA_EVENT_TOPIC, bypassing hermes and its derivation. So the two
// normalized fields are stamped here, and the guard below exists so the next
// direct producer cannot repeat the omission silently.
//
// Functional core: everything here is pure and total. kafka.go does the IO.

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

// MissingEnvelopeFields reports which of the two normalized identity fields an
// already-serialized chat-events body fails to carry, in a stable order. Pure
// and total: nil when the envelope is complete, never panics or errors.
//
// It inspects the SERIALIZED BYTES rather than a typed command on purpose. That
// is what makes it a chokepoint instead of a convention: it holds for every shape
// this service publishes -- and for whatever a future direct producer invents --
// without any of them having to know the guard exists. Today the only live
// producer is emitWhatsAppEcho; emitMessageSent's call sites are commented out
// (worker.go:187, :298) and emitMessageFailed has no caller.
//
// A field counts as present only when it is a NON-EMPTY JSON STRING -- the rule
// hermes stamps by and replybot reads by. An empty string is a poisoned cache key
// downstream rather than a name, and types.UniversalEvent marshals `platform` as
// an object, which replybot's conversationFromRawEvent rejects: the conversation
// would go unnamed while looking stamped.
//
// An unparseable or non-object body names both fields, which is the truthful
// answer and not an error condition.
func MissingEnvelopeFields(value []byte) []string {
	var body struct {
		AccountID json.RawMessage `json:"account_id"`
		Platform  json.RawMessage `json:"platform"`
	}
	if err := json.Unmarshal(value, &body); err != nil {
		return []string{EnvelopeAccountIDField, EnvelopePlatformField}
	}

	var missing []string
	if !isNonEmptyString(body.AccountID) {
		missing = append(missing, EnvelopeAccountIDField)
	}
	if !isNonEmptyString(body.Platform) {
		missing = append(missing, EnvelopePlatformField)
	}
	return missing
}

// isNonEmptyString is pure and total. A missing field, a null, a number and an
// object all answer false -- only a JSON string with content is a name.
func isNonEmptyString(raw json.RawMessage) bool {
	var s string
	return json.Unmarshal(raw, &s) == nil && s != ""
}
