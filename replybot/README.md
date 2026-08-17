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

## Entering a conversation

A referral is not the only way in. Any event arriving on a `START` state blank-starts a
survey on `FALLBACK_FORM` via `_blankStart`, which stamps the `md` the rest of the
pipeline depends on: `startTime` (needed by `getForm` to resolve the form version),
`form`, `pageid` and `seed`.

`TEXT` and `MEDIA` always did this. `QUICK_REPLY`, `POSTBACK` and external events
(`_handleExternalEvent`) did not — they fell through to `RESPOND`, so `apply()` computed
`md: { ...undefined, ...undefined }` = `{}`. That husk is truthy, so it passed the
`!newState.md` guard in `transition.js` and then threw inside `getForm` on the missing
`startTime`. 277 production states were trapped that way, mostly users whose first event
was a quick_reply or a "Get Started" postback. All five paths now share the same
`state.state === 'START'` check.

Note this covers users who arrive without a conversation. A user who *had* one and lost
their `md` — `block_user` drops it — is damaged rather than new, and is not blank-started:
that would append the fallback form and silently reassign a real participant mid-survey.
See `planning/blocked-user-durability-handoff.md`.

## Transient state fields — error episodes and retries

`apply()` in `lib/typewheels/machine.js` enforces an invariant: **transient
fields exist only in the states that own them.** Left lying around they show a
healthy participant as broken in the Monitor tab's `state_json` viewer and in
the `error_tag`/`fb_error_code` computed columns that StatesList filters on.

| Field | Lives in |
|---|---|
| `error` | `ERROR`, `BLOCKED` |
| `wait` / `waitStart` | `WAIT_EXTERNAL_EVENT` |
| `retries` | `RESPONDING`, `ERROR`, `BLOCKED` |
| `errorOnset` | `RESPONDING` (only while a retry is in flight) |

### An error is an episode, not an event

`state.error.ts` is the **onset** of an error episode, not the timestamp of the
most recent failure — it is what the `errored_at` computed column
(`devops/migrations/23-states-errored-at.sql`) exposes, so that the
current-error population can be aged by when a user actually broke rather than
by `updated`, which Dean re-warms on every retry. See
`documentation/error-events.md` §2.

An episode ends on **recovery**, not on **retry attempt**. That distinction is
what `errorOnset` exists for:

- A Dean retry (`REDO` → `RESPOND_AGAIN`) blips the user through `RESPONDING`.
  The `error` is dropped there — a `RESPONDING` state must never carry one —
  but the onset is parked on `state.errorOnset`: a bare epoch-ms number, no
  `tag`/`code`, so it is invisible to the error computed columns. It has the
  same lifetime as `retries`, the other piece of retry bookkeeping that
  `RESPONDING` legitimately keeps.
- **Retry re-fails** → `exec` reads the onset back (`episodeOnset`) and stamps
  the new, thinner error with the *original* `ts`. Same episode; content updates
  to the latest failure, onset does not move.
- **Retry succeeds** → whichever transition proves it (`WAIT_RESPONSE`,
  `HANDOFF`, `WAIT_EXTERNAL_EVENT`, `END`, or the user answering via `RESPOND`)
  clears `errorOnset` along with the other transient fields. The next failure is
  a new episode with a fresh onset.

Every transition reachable from `RESPONDING` either consumes `errorOnset` (into
`error.ts` on `ERROR`/`BLOCKED`) or clears it, so it cannot leak.

## Repeats (`_gatherResponses`)

Every re-send of a question — follow-up nudge, failed validation, repeat
referral — funnels through `_gatherResponses` in `lib/typewheels/machine.js`,
which fires on `metadata.repeat`. It emits the nudge/error line first and then
the question re-rendered by `repeatField` (the normal translator, stamped
`metadata.isRepeat`).

The one exception is a `utility_message` field, where the nudge is dropped and
only the template is re-sent: the nudge is free-form text and would be rejected
out-of-window with `(#10)`, blocking exactly the users a utility message exists
to reach, and approved template copy cannot carry the nudge anyway. See
`documentation/utility-messages.md` § "Repeats and follow-ups".

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
2. User's first inbound message arrives at Hermes (`POST /whatsapp`, handlers.rs:124) with `messages[].referral: { ref: "form.<SHORTCODE>", source, source_id, ctwa_clid, headline, body }`
3. Hermes stamps with `source: "whatsapp"` and `phone_number_id` (event.rs:73-97), publishes raw event to Kafka unchanged
4. Replybot's event-normalizer (`categorizeWhatsAppEvent`, line 257-265) recognizes `data.referral`
5. Returns `event_type: 'conversation_started'`, `payload.referral: data.referral` (preserves entire referral object)
6. `getMetadata(event)` (utils.js) extracts form shortcode from `payload.referral.ref`
7. Machine's REFERRAL case resolves survey by shortcode via formcentral
8. Survey starts with no-retake enforcement

**Referral object structure (from a real production webhook, 2026-08-16):**
```javascript
{
  // NOTE: no `ref`. Every field here is Meta-assigned; the form shortcode
  // arrives separately, on the autofill message's text.body.
  "source_url": "https://fb.me/9nJxtZGUu",
  "source_id": "120254866237980150",    // ad id when source_type is "ad";
                                        // a POST id when it is not
  "source_type": "ad",                  // "ad" | "post" | ...
  "headline": "Virtual Lab survey",
  "body": "ad body text",
  "media_type": "image",
  "image_url": "https://scontent-....fbcdn.net/...",
  "ctwa_clid": "AfiIcrJAS9Ee...",       // click tracking ID (Conversions API)
  "welcome_message": { "text": "..." }
}
```

Earlier revisions of this README showed `"source": "ads"` here. That spelling
appears in no production payload, hermes type, or test fixture in this repo — it
looks like a transcription of *Messenger's* referral `source` field (`"ADS"`,
`"SHORTLINK"`). The real WhatsApp key is `source_type`, value `"ad"`.

**What is and is not mapped into `state.md`:**

- **Form + targeting metadata**: `form`, plus arbitrary `key.value` pairs. Since
  `v0.0.217` these ride in on the ad's **autofill message** (`text.body`), not on
  the referral, giving CTWA the same targeting transport as
  `m.me?ref=form.ABC.key.value`. The older claim that WhatsApp had "no mechanism
  to pass targeted metadata" is retired — the real constraint is that the token
  is authored per ad *creative* rather than per click.
- **`ad_id`**: from `source_id`, but **only when `source_type` says the arrival
  came from an ad**. On an organic reshare of a page post, `source_id` is a post
  id; capturing it would write post ids into the ad_id field, where they can
  never match vlab's `(network, ad_id)` mapping. See
  `documentation/referral-form-resolution.md` § "Ad identity (`md.ad_id`)".
- **Not mapped**: `ctwa_clid`, `headline`, `body`, `media_type`, `source_url`,
  `image_url`, `welcome_message` are preserved on the raw event but do not reach
  state metadata. (`ctwa_clid` in particular is deliberately deferred.)

**Key:** The referral object is a Meta-level webhook field; it comes ONLY from CTWA ads or explicit Meta referral links, not from plain wa.me links or manual user typing.

### Entry Point 2: Bare-Text Reference Token

Fallback path for testing and direct wa.me links. Any plain text message matching a specific pattern triggers survey entry.

**Pattern:** Message body (trimmed) must exactly match
`/^(?:start\s+)?form\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/i` (case-insensitive).
- Valid: `form.flysmoke`, `FORM.FLYSMOKE`, `start form.myform`, ` form.flysmoke ` (surrounding whitespace is trimmed before matching)
- Valid with metadata (since v0.0.217): `form.flysmoke.creative.3b.gender.men` → `md` gets `creative`/`gender`, matching `m.me?ref=` on Messenger
- Invalid: `tell me form.flysmoke` (extra text—no match), `form.` (no shortcode)

Only the literal `form.` prefix is lowercased; the shortcode and all metadata
tokens keep the case as typed. An odd token count (`form.ABC.creative`) matches
deliberately — `_group` leaves the dangling key `undefined` rather than throwing,
so the survey still starts.

**Encoding caveat for link authors:** raw `&` and `#` inside a `wa.me?text=`
value silently truncate the prefilled message. Percent-encode them (`%26`, `%23`)
if a targeting value could ever contain one.

**Flow:**
1. User sends plain text via wa.me link (e.g., `https://wa.me/1023456789?text=form.flysmoke`), manual SMS-like typing, or smoke testing
2. Inbound message arrives with `messages[].text.body = "form.flysmoke"` and NO `referral` field
3. Hermes stamps and publishes raw event to Kafka
4. Replybot's event-normalizer (`categorizeWhatsAppEvent`, line 277-293) tests the text against the pattern when no referral is present
5. On match, **synthesizes** `event_type: 'conversation_started'`, `payload.referral: { ref: "form.flysmoke" }`
6. `getMetadata(event)` extracts form shortcode from synthesized referral
7. Machine's REFERRAL case processes identically to CTWA referral path
8. Survey starts with no-retake enforcement

**Why strict full-match:** Prevents mid-survey user replies from accidentally re-triggering a survey entry. An existing user answering a question must not be interrupted if their answer happens to be "form.myform". The pattern is STRICT (anchored, full-match) to ensure only explicit form tokens at message start trigger entry (event-normalizer.js:280-281).

**Shortcode extraction and case:**
- Pattern regex captures shortcode in group 1: `match[1]` (line 284)
- Case is preserved exactly as typed (line 284)
- Example: `FORM.MyForm` captures as `MyForm`, ref becomes `form.MyForm`

**e2e-tested paths** (event-normalizer.test.js:567-651):
- `form.<shortcode>` typed manually or via wa.me?text= prefill
- `start form.<shortcode>` (user explicitly says "start")
- Case-insensitive regex but case-preserving shortcode (user types FORM.MYFORM or Form.MyForm)
- Whitespace tolerance (leading/trailing spaces stripped before matching, line 279)
- Underscore and hyphen in shortcode allowed
- Rejects mid-text refs (line 601-604)
- Rejects bare `form.` without shortcode (line 606-609)

### Entry Point 3: Pre-Normalized UniversalEvent (/synthetic)

Staging and testing path. No Meta webhook required; inject a fully-formed UniversalEvent directly.

**Flow:**
1. POST a pre-normalized UniversalEvent JSON to `POST /synthetic` (hermes handlers.rs:297+)
2. Event includes `source.type: 'whatsapp'`, `event_type: 'conversation_started'`, `payload.referral.ref: "form.<SHORTCODE>"`
3. Hermes publishes to Kafka as-is (no re-parsing needed; `parseEvent` recognizes pre-formed events with `event_type` field)
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
- Normalizes as `event_type: 'user_text'` (event-normalizer.js:328-336)
- Machine's TEXT handler finds no active conversation and ignores the message (no-op)
- User receives no bot reply

This is intentional: WhatsApp is a customer-service platform, not a broadcast tool. Users must explicitly request a survey via an entry point (CTWA ad, form-ref link, or /synthetic), not stumble into one via casual text. Unlike Messenger (which has a "Get Started" button offering opt-in), WhatsApp conversations are always user-initiated and require explicit entry.

### Metadata Extraction (`getMetadata` in utils.js)

All three entry paths converge on the same `getMetadata(event)` function:
- Only `event_type: 'conversation_started'` events extract metadata (line 80-87)
- Parses the `referral.ref` string by splitting on `.` and grouping pairs via `_group()` (line 85-86)
- **Messenger example:** `form.ABC.creative.x.gender.men` → `{ form: "ABC", creative: "x", gender: "men" }`
- **WhatsApp CTWA example:** `form.ABC123` → `{ form: "ABC123" }` (only the shortcode; extra CTWA fields not parsed or mapped)
- **WhatsApp bare-text example:** synthesized as `{ ref: "form.ABC123" }` → `{ form: "ABC123" }`

**Platform tracking (line 99):** `md.platform = eventPlatform(event)` persists `'messenger'` or `'whatsapp'` with the conversation state, so synthetic re-entry events (dean timeouts, follow-ups) recover the correct platform.

### Testing

`npm test` runs the full mocha suite via the quoted glob `'lib/**/*.test.js'`
(mocha expands it; unquoted, the shell would skip top-level `lib/*.test.js`
files like `event-normalizer.test.js` and `generic-translator.test.js`).
Test fixtures for UniversalEvents live in `lib/typewheels/events.test.js` and
must mirror the normalizer's real output shapes.

(The former chat-log publisher — `lib/chat-log/publisher.js` and
`VLAB_CHAT_LOG_TOPIC` — was removed with the platform abstraction; see
`documentation/chat-message-logging.md`.)
