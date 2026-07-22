# Replybot

Make sure you have a folder called keys at the root of this project, with a single file: "key.json" -- which is the google application credentials keys.

Also make sure you have the .env file at the root of the project. This is currently the SAME for both botserver and replybot, so symlink one to the other!

## Setup local kubernetes

Make sure you install the following on your machine:

* [Virtual Box](https://www.virtualbox.org/wiki/Downloads)
* [kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl/)
* [minikube](https://kubernetes.io/docs/tasks/tools/install-minikube/)
* [helm](https://docs.helm.sh/using_helm/#installing-helm)

Now setup minikube and kubectl:

``` shell
minikube start
kubectl use-context minikube
```

Now, initialize helm in you minikube cluster and install Kafka using helm:

``` shell
helm --kube-context minikube init
helm repo add bitnami https://charts.bitnami.com/bitnami
helm --kube-context minikube install --name spinaltap --values kafka-values-dev.yaml bitnami/kafka
```

Run this in the shell you will be using

``` shell
eval $(minikube docker-env)
```

To reload or start an app (both botserver and replybot), inside the folder run:

NOTE: You will receive warnings the first time due to the fact that the script tries to delete the deployment, which will error if the deployment does not exist. That's ok.

``` shell
./dev.sh
```

You should now see the pods running at:

``` shell
kubectl get po
```

And you can get logs for an individual pod via:

``` shell
kubectl logs [POD_NAME]
```

Or, handily, you can setup the following script (as kube-logs.sh, for example) and alias it to something useful on your computer:

``` shell
NAME=$1
NUM=$2
kubectl logs $(kubectl get pods -l "app=${NAME}" -o jsonpath="{.items[${NUM}].metadata.name}")
```

Which you can then run:

``` shell
alias kubelog=kube-logs.sh
kubelog gbv-replybot 1
```

## Event Normalization (UniversalEvent)

All events entering the replybot are normalized by `lib/event-normalizer.js`
into a `UniversalEvent` (`{ event_id, user_id, timestamp, source, event_type,
payload, raw }`) before the state machine sees them. The machine
(`lib/typewheels/machine.js`) switches only on `event_type` and reads typed
`payload` objects — it never touches raw Messenger fields.

The `lib/chat-log/publisher.js` module publishes chat log entries to a Kafka topic for every visible message in a conversation (both bot echoes and user messages). This feeds the `chat_log` database table via a downstream scribble sink.

Notes on specific shapes:

- **Payload parsing** — Messenger delivers `quick_reply`, `postback`, and
  `optin` payloads as JSON strings; the normalizer parses them to objects
  (`parsePayload`), falling back to the raw string when not valid JSON.
- **Optin** — normalized to `event_type: 'optin'` with
  `payload: { type: 'optin', optin_type: <messenger optin.type, e.g.
  'one_time_notif_req'>, token: <one_time_notif_token>, payload: <parsed
  notify-field ref object> }`. The machine's OPTIN case checks
  `payload.optin_type`, stores the token in `state.tokens`, and answers the
  pending `notify` field (the validator matches `payload.payload.ref` against
  the field ref). After a timeout fulfils a notify wait, the stored token is
  attached to the outgoing message and message-worker sends it with
  `recipient: { one_time_notif_token }` instead of the user id.
- **Handover** — Messenger `pass_thread_control` is normalized to
  `event_type: 'handover'` with `payload: { type: 'handover',
  previous_owner_app_id, new_owner_app_id, metadata }`. The machine's
  `HANDOVER_EVENT` case reads `payload.new_owner_app_id`, and the wait/timeout
  logic (`lib/typewheels/waiting.js`) reads the handover value off the
  normalized `payload` — it consumes normalized events **only**. (The legacy
  raw-`pass_thread_control` fallback in `_normalizeEvent` was removed: every
  event is normalized on ingest by `statestore.js`, and `machine.js` stores the
  normalized event in `externalEvents`, so a raw handover never reaches
  `waiting.js`.)

## Platform Tracking (md.platform)

The conversation's platform (`'messenger'` | `'whatsapp'`) is persisted in
`state.md.platform` at conversation start (`lib/typewheels/utils.js
getMetadata`, via `eventPlatform`). It rides along in the state the replybot
publishes to `VLAB_STATE_TOPIC`, so it lands in the `states` table's
`state_json` — where the computed column `states.platform`
(`devops/migrations/21-states-platform.sql`) exposes it — and in
`responses.metadata` (which is `state.md`).

Why it matters: synthetic re-entry events (dean timeouts, follow-ups,
repeat-payments) have `source.type: 'synthetic'`, not a real platform.
Outbound `SendMessageCommand`s must carry the conversation's actual platform
or message-worker rejects/misroutes them. `transition.js` resolves the
platform for synthetic events as:

1. persisted `state.md.platform` (authoritative; set at conversation start)
2. the event's own hint `source.platform` — synthetic payloads may carry an
   optional top-level `"platform"` field (dean sends it; hermes/botserver pass
   it through; `parseSyntheticEvent` surfaces it as `source.platform`)
3. `'messenger'` — exact for all conversations predating WhatsApp support

Invariant: `md.platform` never holds `'synthetic'` — `eventPlatform`
whitelists real platforms only. Payment events published to
`VLAB_PAYMENT_TOPIC` also carry a top-level `platform` field, read from
`newState.md.platform` (fallback `'messenger'`) and threaded through the
`act()` ctx into `_wrapPayment` (`machine.js`).

Note: `synthetic_conversation_started` is NOT currently categorized as a
REFERRAL by `machine.js categorizeEvent` (it falls through to UNKNOWN/no-op),
so conversations cannot currently start from a synthetic event; the
platform-hint handling in `getMetadata` is nonetheless in place should that
path be wired up. Pre-normalized UniversalEvents injected through
`/synthetic` (parseEvent passes objects with an `event_type` straight
through) DO start conversations and carry their own `source.type`.

## WhatsApp Entry Points

WhatsApp conversations are initiated via three distinct paths, all reaching the same referral-based survey start logic in `machine.js`:

### Entry Point 1: Click-to-WhatsApp (CTWA) Referral Object

Production path for ad-driven conversions. User clicks a Click-to-WhatsApp ad or promotional link that includes a referral object.

**Flow:**
1. User clicks a CTWA ad (configured on Meta's Ad Manager, or a direct click-to-WhatsApp link with referral data)
2. User's first inbound message arrives at Hermes (`POST /whatsapp`) with `messages[].referral: { ref: "form.<SHORTCODE>" }`
3. Replybot's event-normalizer (`categorizeWhatsAppEvent`, line 248-259) recognizes the referral object
4. Returns `event_type: 'conversation_started'`, `payload.referral.ref: "form.flysmoke"`
5. Machine's REFERRAL case calls `getForm(phone_number_id, "flysmoke")` → formcentral resolves user and survey
6. Survey starts with no-retake enforcement

**Key:** The referral object is a Meta-level webhook field; it comes ONLY from CTWA ads or explicit Meta referral links, not from plain wa.me links or manual user typing.

### Entry Point 2: Bare-Text Reference Token

Fallback path for testing and direct wa.me links. Any plain text message matching a specific pattern triggers survey entry.

**Pattern:** Message body (trimmed) must exactly match `/^(?:start\s+)?form\.([A-Za-z0-9_-]+)$/i` (case-insensitive).
- Valid: `form.flysmoke`, `FORM.FLYSMOKE`, `start form.myform`, ` form.flysmoke ` (surrounding whitespace is trimmed before matching)
- Invalid: `tell me form.flysmoke` (extra text—no match), `form.` (no shortcode)

**Flow:**
1. User sends plain text via wa.me link (e.g., `https://wa.me/1023456789?text=form.flysmoke`), manual SMS-like typing, or smoke testing
2. Inbound message arrives with `messages[].text.body = "form.flysmoke"` and NO `referral` field
3. Replybot's event-normalizer (`categorizeWhatsAppEvent`, line 270-287) tests the text against the pattern
4. On match, synthesizes `event_type: 'conversation_started'`, `payload.referral.ref: "form.flysmoke"`
5. Machine's REFERRAL case processes it identically to the CTWA referral path
6. Survey starts with no-retake enforcement

**Why strict full-match:** Prevents mid-survey user replies from accidentally re-triggering a survey entry. An existing user answering a question must not be interrupted if their answer happens to be "form.myform". The pattern is STRICT (anchored, full-match) to ensure only explicit form tokens at message start trigger entry.

**e2e-tested paths:**
- `form.<shortcode>` typed manually or via wa.me?text= prefill
- `start form.<shortcode>` (user explicitly says "start")
- Case-insensitive (user types FORM.MYFORM or Form.MyForm)

### Entry Point 3: Pre-Normalized UniversalEvent (/synthetic)

Staging and testing path. No Meta webhook required; inject a fully-formed UniversalEvent directly.

**Flow:**
1. POST a pre-normalized UniversalEvent JSON to `POST /synthetic` (hermes endpoint)
2. Event includes `source.type: 'whatsapp'`, `event_type: 'conversation_started'`, `payload.referral.ref: "form.<SHORTCODE>"`
3. Hermes publishes to Kafka as-is (no re-parsing needed; `parseEvent` recognizes pre-formed events)
4. Replybot consumes and routes to REFERRAL handler
5. Machine calls `getForm` with WhatsApp account_id and shortcode
6. Survey starts

**Example payload:**
```json
{
  "event_id": "evt_test_001",
  "user_id": "27123456789",
  "timestamp": 1721678400000,
  "source": { "type": "whatsapp", "account_id": "1023456789" },
  "event_type": "conversation_started",
  "payload": {
    "type": "conversation_started",
    "trigger": "referral",
    "referral": { "ref": "form.testform" }
  },
  "raw": {}
}
```

**Use case:** Repeatable testing without Meta webhook setup or CTWA ad configuration.

### Non-Entry: Plain Text Not Matching Reference Pattern

A WhatsApp user sending plain text that does NOT match the form ref pattern (e.g., "hi", "help", "how do I join") with no referral object:
- Normalizes as `event_type: 'user_text'`
- Machine's TEXT handler finds no active conversation and ignores the message (no-op)
- User receives no bot reply

This is intentional: WhatsApp is a customer-service platform, not a broadcast tool. Users must explicitly request a survey via an entry point (CTWA ad, form-ref link, or /synthetic), not stumble into one via casual text. Unlike Messenger (which has a "Get Started" button offering opt-in), WhatsApp conversations are always user-initiated and require explicit entry.

### Testing

`npm test` runs the full mocha suite via the quoted glob `'lib/**/*.test.js'`
(mocha expands it; unquoted, the shell would skip top-level `lib/*.test.js`
files like `event-normalizer.test.js` and `generic-translator.test.js`).
Test fixtures for UniversalEvents live in `lib/typewheels/events.test.js` and
must mirror the normalizer's real output shapes.

(The former chat-log publisher — `lib/chat-log/publisher.js` and
`VLAB_CHAT_LOG_TOPIC` — was removed with the platform abstraction; see
`documentation/chat-message-logging.md`.)
