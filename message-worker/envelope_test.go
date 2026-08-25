package messageworker

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

// ---------------------------------------------------------------------------
// The event envelope, producer side.
//
// message-worker is a DIRECT PRODUCER to chat-events. Until 2026-08-17 its
// WhatsApp echo carried neither `account_id` nor `platform`, so every WhatsApp
// send minted a `messages` row with a permanently NULL account -- a row that
// the replay query's temporary `OR account_id IS NULL` clause then matched for
// every one of that participant's conversations. Nothing in the unit suite
// noticed; an integration run did.
//
// These tests are what make that impossible to repeat: the first block pins the
// echo's shape, the second pins the guard that catches ANY future direct
// producer in this service, and the third runs a real WhatsApp send end to end
// through the worker and checks the bytes that actually reach the topic.
// ---------------------------------------------------------------------------

func whatsappSendCommand() types.SendMessageCommand {
	text := "Hello from a survey"
	return types.SendMessageCommand{
		CommandID:         "cmd_echo_1",
		ConversationID:    "conv_1",
		UserID:            "1541347160",
		Platform:          types.PlatformWhatsApp,
		PlatformAccountID: "106540352242922",
		Message: types.MessageContent{
			Type:     types.MessageTypeText,
			Text:     &text,
			Metadata: json.RawMessage(`{"ref":"foo","type":"stitch"}`),
		},
	}
}

func TestBuildWhatsAppEcho_StampsTheEnvelope(t *testing.T) {
	echo := BuildWhatsAppEcho(whatsappSendCommand(), time.UnixMilli(1786647529000))

	if echo.AccountID != "106540352242922" {
		t.Errorf("account_id = %q, want the command's PlatformAccountID", echo.AccountID)
	}
	if echo.Platform != "whatsapp" {
		t.Errorf("platform = %q, want %q", echo.Platform, "whatsapp")
	}

	// `phone_number_id` is retained ALONGSIDE the envelope, not replaced by it:
	// the `messages` backfill reads the account out of historical `content`
	// under the per-shape name, so old and new rows share one extraction path.
	if echo.PhoneNumberID != "106540352242922" {
		t.Errorf("phone_number_id = %q, want it retained", echo.PhoneNumberID)
	}

	if echo.From != "1541347160" || echo.Type != "bot_echo" || echo.Source != "whatsapp" {
		t.Errorf("unexpected echo identity fields: %+v", echo)
	}
	if echo.Timestamp != 1786647529000 {
		t.Errorf("timestamp = %d, want the clock it was given", echo.Timestamp)
	}
}

func TestBuildWhatsAppEcho_IsPure(t *testing.T) {
	cmd := whatsappSendCommand()
	at := time.UnixMilli(1786647529000)

	if !reflect.DeepEqual(BuildWhatsAppEcho(cmd, at), BuildWhatsAppEcho(cmd, at)) {
		t.Error("BuildWhatsAppEcho is not deterministic")
	}
}

func TestBuildWhatsAppEcho_AbsentMetadataIsJSONNull(t *testing.T) {
	cmd := whatsappSendCommand()
	cmd.Message.Metadata = nil

	echo := BuildWhatsAppEcho(cmd, time.UnixMilli(0))
	if string(echo.Metadata) != "null" {
		t.Errorf("metadata = %q, want %q -- an empty RawMessage marshals to invalid JSON", echo.Metadata, "null")
	}

	// And the whole body must still marshal, which is the point of the above.
	if _, err := json.Marshal(echo); err != nil {
		t.Fatalf("marshalling an echo with no metadata failed: %v", err)
	}
}

// THE REGRESSION. The serialized echo must satisfy the same guard every other
// body on the topic does.
func TestBuildWhatsAppEcho_SatisfiesTheEnvelopeGuard(t *testing.T) {
	data, err := json.Marshal(BuildWhatsAppEcho(whatsappSendCommand(), time.Now()))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	if missing := MissingEnvelopeFields(data); missing != nil {
		t.Fatalf("the WhatsApp echo is missing %v from its envelope: %s", missing, data)
	}
}

func TestMissingEnvelopeFields(t *testing.T) {
	tests := []struct {
		name string
		body string
		want []string
	}{
		{
			"complete envelope",
			`{"source":"whatsapp","account_id":"106540352242922","platform":"whatsapp"}`,
			nil,
		},
		{
			"THE BUG: the six-field echo as it shipped before 2026-08-17",
			`{"source":"whatsapp","phone_number_id":"106540352242922","from":"1541347160","type":"bot_echo","metadata":null,"timestamp":1786647529000}`,
			[]string{"account_id", "platform"},
		},
		{
			"per-shape phone_number_id is NOT the envelope",
			`{"phone_number_id":"106540352242922","platform":"whatsapp"}`,
			[]string{"account_id"},
		},
		{"missing platform only", `{"account_id":"106540352242922"}`, []string{"platform"}},
		{
			// An empty string is a poisoned key downstream, not a name. Same
			// rule as hermes' "stamped only when it derives to a non-empty
			// string" and replybot's identityComponent.
			"empty strings are not names",
			`{"account_id":"","platform":""}`,
			[]string{"account_id", "platform"},
		},
		{
			// types.UniversalEvent's shape. `platform` is PRESENT but is an
			// object, which a presence check would pass and which replybot
			// rejects -- so the conversation goes unnamed while looking stamped.
			"a nested platform object does not satisfy the envelope",
			`{"event_id":"evt_1","platform":{"type":"whatsapp","account_id":"106540352242922"}}`,
			[]string{"account_id", "platform"},
		},
		{"numeric account_id is not a name", `{"account_id":123,"platform":"whatsapp"}`, []string{"account_id"}},
		{"null components", `{"account_id":null,"platform":null}`, []string{"account_id", "platform"}},
		{"empty object", `{}`, []string{"account_id", "platform"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := MissingEnvelopeFields([]byte(tt.body))
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("MissingEnvelopeFields = %v, want %v", got, tt.want)
			}
		})
	}
}

// Total: the guard must never panic, whatever bytes a caller hands it. A guard
// that can crash the producer is worse than the omission it guards against.
func TestMissingEnvelopeFields_IsTotal(t *testing.T) {
	junk := [][]byte{
		nil, {}, []byte("not json"), []byte("{"), []byte("[]"), []byte(`"a string"`),
		[]byte("42"), []byte("null"), []byte("true"), []byte(`[{"account_id":"a"}]`),
		{0xff, 0xfe, 0x00},
	}

	for _, b := range junk {
		missing := MissingEnvelopeFields(b)
		if !reflect.DeepEqual(missing, []string{"account_id", "platform"}) {
			t.Errorf("MissingEnvelopeFields(%q) = %v, want both fields reported missing", b, missing)
		}
	}
}

// The UniversalEvent path is dead code today (emitMessageSent's call sites are
// commented out; emitMessageFailed has no caller at all), but it is one
// uncomment away from producing envelope-violating events. Pin that fact so
// whoever revives it is told what is missing rather than discovering it in
// production.
func TestUniversalEvent_DoesNotSatisfyTheEnvelope(t *testing.T) {
	event := types.UniversalEvent{
		EventID:        "evt_1",
		ConversationID: "conv_1",
		UserID:         "1541347160",
		Platform: types.PlatformContext{
			Type:      types.PlatformWhatsApp,
			AccountID: "106540352242922",
		},
		Source:    types.EventSourceMessageWorker,
		EventType: "message_sent",
		Payload:   json.RawMessage("{}"),
	}

	data, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	missing := MissingEnvelopeFields(data)
	if !reflect.DeepEqual(missing, []string{"account_id", "platform"}) {
		t.Fatalf("types.UniversalEvent unexpectedly satisfies the envelope (missing=%v).\n"+
			"If it now carries top-level account_id/platform, delete this test. "+
			"Otherwise it must not be published to chat-events: %s", missing, data)
	}
}

// --- the guard itself -------------------------------------------------------
//
// guardEnvelope touches no Kafka state, so it is exercised against a
// KafkaProducer literal with no underlying librdkafka handle.

func TestGuardEnvelope_ReportsButDoesNotRefuseByDefault(t *testing.T) {
	core, logs := observer.New(zapcore.ErrorLevel)
	kp := &KafkaProducer{topic: "chat-events", logger: zap.New(core)}

	err := kp.guardEnvelope("1541347160", []byte(`{"source":"whatsapp","from":"1541347160"}`))

	// MUST NOT refuse. The echo is what advances the WhatsApp state machine;
	// dropping it stalls the conversation, whereas publishing it unstamped only
	// degrades replybot to an unscoped replay.
	if err != nil {
		t.Fatalf("default mode refused to publish: %v -- this can stall every WhatsApp conversation", err)
	}

	entries := logs.FilterMessage(EnvelopeMissingTag).All()
	if len(entries) != 1 {
		t.Fatalf("expected exactly 1 %s line, got %d", EnvelopeMissingTag, len(entries))
	}
	if entries[0].Level != zapcore.ErrorLevel {
		t.Errorf("%s logged at %s; it is a producer bug and must be loud", EnvelopeMissingTag, entries[0].Level)
	}

	fields := entries[0].ContextMap()
	if !reflect.DeepEqual(fields["missing"], []interface{}{"account_id", "platform"}) {
		t.Errorf("missing field = %v, want both components named", fields["missing"])
	}
	if fields["key"] != "1541347160" || fields["topic"] != "chat-events" {
		t.Errorf("log line does not identify the event: %v", fields)
	}
}

func TestGuardEnvelope_NeverLogsTheBody(t *testing.T) {
	// The body carries participant message content. The guard reports identity
	// only -- key, topic, which fields are missing.
	core, logs := observer.New(zapcore.ErrorLevel)
	kp := &KafkaProducer{topic: "chat-events", logger: zap.New(core)}

	secret := `{"source":"whatsapp","text":{"body":"PARTICIPANT_SECRET"}}`
	kp.guardEnvelope("1541347160", []byte(secret))

	for _, e := range logs.All() {
		for k, v := range e.ContextMap() {
			if s, ok := v.(string); ok && strings.Contains(s, "PARTICIPANT_SECRET") {
				t.Fatalf("guard logged the event body in field %q", k)
			}
		}
	}
}

func TestGuardEnvelope_StrictModeRefuses(t *testing.T) {
	kp := (&KafkaProducer{topic: "chat-events", logger: zap.NewNop()}).WithStrictEnvelope(true)

	err := kp.guardEnvelope("1541347160", []byte(`{"source":"whatsapp"}`))
	if err == nil {
		t.Fatal("strict mode published an event with no envelope")
	}
	if !strings.Contains(err.Error(), EnvelopeMissingTag) {
		t.Errorf("error %q does not carry the greppable tag", err)
	}
}

func TestGuardEnvelope_PassesACompleteEnvelopeInBothModes(t *testing.T) {
	body, err := json.Marshal(BuildWhatsAppEcho(whatsappSendCommand(), time.Now()))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	for _, strict := range []bool{false, true} {
		core, logs := observer.New(zapcore.ErrorLevel)
		kp := (&KafkaProducer{topic: "chat-events", logger: zap.New(core)}).WithStrictEnvelope(strict)

		if err := kp.guardEnvelope("1541347160", body); err != nil {
			t.Errorf("strict=%v: guard rejected a complete envelope: %v", strict, err)
		}
		if n := logs.FilterMessage(EnvelopeMissingTag).Len(); n != 0 {
			t.Errorf("strict=%v: guard logged %d spurious %s lines", strict, n, EnvelopeMissingTag)
		}
	}
}

// --- end to end through the worker -----------------------------------------

// The bytes that actually reach the topic on a real WhatsApp send. This is the
// test that would have caught the shipped bug: it does not inspect the builder,
// it inspects what came out of PublishRawEvent.
func TestProcessSendMessage_WhatsAppEchoOnTheWireCarriesTheEnvelope(t *testing.T) {
	producer := &mockEventProducer{}
	sender := &mockMessageSender{response: &SendMessageResponse{MessageID: "wamid.1", Success: true}}
	bot := newMockBotserver()
	defer bot.Close()

	clients := map[types.PlatformType]MessageSender{types.PlatformWhatsApp: sender}
	worker := NewWorker(clients, producer, bot.URL(), zap.NewNop())

	cmdJSON, _ := json.Marshal(whatsappSendCommand())
	if err := worker.ProcessCommand(context.Background(), cmdJSON); err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	if len(producer.rawEvents) != 1 {
		t.Fatalf("expected exactly 1 raw event (the WhatsApp echo), got %d", len(producer.rawEvents))
	}

	body := producer.rawEvents[0]
	if missing := MissingEnvelopeFields(body); missing != nil {
		t.Fatalf("the echo published to chat-events is missing %v: %s", missing, body)
	}

	var got map[string]interface{}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("published echo is not an object: %v", err)
	}
	if got["account_id"] != "106540352242922" {
		t.Errorf("account_id on the wire = %v, want the account the message was sent from", got["account_id"])
	}
	if got["platform"] != "whatsapp" {
		t.Errorf("platform on the wire = %v, want whatsapp", got["platform"])
	}
}

// Messenger echoes natively (is_echo webhooks via hermes), so message-worker
// must NOT also produce one -- a second producer for a shape hermes already
// stamps is how the topic got a silent second writer in the first place.
func TestProcessSendMessage_MessengerPublishesNothingDirectly(t *testing.T) {
	producer := &mockEventProducer{}
	sender := &mockMessageSender{response: &SendMessageResponse{MessageID: "mid.1", Success: true}}
	bot := newMockBotserver()
	defer bot.Close()

	cmd := whatsappSendCommand()
	cmd.Platform = types.PlatformMessenger
	cmd.PlatformAccountID = "935593143497601"

	clients := map[types.PlatformType]MessageSender{types.PlatformMessenger: sender}
	worker := NewWorker(clients, producer, bot.URL(), zap.NewNop())

	cmdJSON, _ := json.Marshal(cmd)
	if err := worker.ProcessCommand(context.Background(), cmdJSON); err != nil {
		t.Fatalf("ProcessCommand failed: %v", err)
	}

	if len(producer.rawEvents) != 0 || len(producer.events) != 0 {
		t.Fatalf("Messenger send produced %d raw and %d typed events to chat-events; want 0 of each",
			len(producer.rawEvents), len(producer.events))
	}
}
