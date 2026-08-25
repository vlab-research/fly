# Hermes — Webhook Ingestion & Event Routing

Rust-based webhook server replacing the JavaScript botserver for inbound event handling. Ingests webhooks from Meta (Messenger, WhatsApp), stamps them with source and account info, and publishes to Kafka for downstream processing by replybot and other consumers.

## Purpose

**Hermes** bridges Meta webhooks and the Vlab event stream:
1. Receives Messenger and WhatsApp webhooks from Meta's Graph API
2. Verifies webhook tokens and payload signatures (HMAC-SHA256)
3. Stamps events with source platform and account IDs (page_id for Messenger, phone_number_id for WhatsApp)
4. Publishes to Kafka for replybot consumption
5. Provides health/readiness probes for orchestration

Designed as a stateless Rust service for simplicity and performance; Kafka is the source of truth for all event state.

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhooks` | GET | Messenger webhook verification (hub.verify_token, hub.challenge) |
| `/webhooks` | POST | Messenger webhook ingestion (signature verified when FB_APP_SECRET set) |
| `/whatsapp` | GET | WhatsApp webhook verification (separate WHATSAPP_VERIFY_TOKEN) |
| `/whatsapp` | POST | WhatsApp webhook ingestion (signature verified when FB_APP_SECRET set) |
| `/synthetic` | POST | Pre-normalized UniversalEvent injection (internal, no signature check) |
| `/health` | GET | Readiness probe — 200 when Kafka producer ready, 503 otherwise |

## Environment Variables

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `VERIFY_TOKEN` | Yes | — | Messenger webhook token (hub.verify_token must match) |
| `WHATSAPP_VERIFY_TOKEN` | No | — | WhatsApp webhook token (separate from Messenger). If absent, /whatsapp verification always fails. |
| `FB_APP_SECRET` | No | — | Meta app secret for payload signature verification (X-Hub-Signature-256, HMAC-SHA256). Applied to both `/webhooks` and `/whatsapp` POST. If unset, signature checks are bypassed (local dev, testrunner). |
| `KAFKA_BROKERS` | Yes | — | Comma-separated Kafka broker addresses (e.g., `kafka:9092` in dev, `broker1:9092,broker2:9092` in prod) |
| `BOTSERVER_EVENT_TOPIC` | No | `events` | Kafka topic for publishing events. Alias: `VLAB_EVENT_TOPIC`. |
| `SYNTHETIC_REQUIRE_CONVERSATION` | No | `false` | When `true`/`1`, `POST /synthetic` returns 400 if `account_id` or `platform` is missing. Off means accept-and-log. See *The conversation triple*. Declared explicitly in `devops/values/{production,staging}.yaml` so flipping it is a committed-file edit, not a live mutation. |
| `PORT` | No | `3000` | HTTP listen port |
| `DASHBOARD_URL` | No | — | Unused (placeholder for future template status polling) |
| `AUTH0_DASHBOARD_SECRET` | No | — | Unused (placeholder for future auth) |

## Webhook Signature Verification

**When `FB_APP_SECRET` is set:**
- Middleware `require_meta_signature` extracts `X-Hub-Signature-256` header
- Computes HMAC-SHA256 of the raw request body using `FB_APP_SECRET`
- Compares computed signature to header value
- Returns 401 Unauthorized if mismatch; proceeds to handler if valid
- Applied to both `POST /webhooks` and `POST /whatsapp`

**When `FB_APP_SECRET` is unset:**
- No-op; unsigned payloads accepted
- Typical for local dev and integration tests (facebot mock)

**Note:** Meta does NOT sign GET verification handshakes (`/webhooks?hub.verify_token=...`). Signature middleware is skipped for GET requests.

## Handler Flow

### Messenger Webhooks (`/webhooks`)

1. **Verify (GET):** Meta sends `hub.verify_token` + `hub.challenge`. Handler checks token against `VERIFY_TOKEN` and echoes challenge (or 401).
2. **Ingest (POST):** Meta sends webhook with `entry[]` array containing `messaging[]` and `messaging_handovers[]` events.
3. **Process:** Walk `entry.changes[field=message_template_status_update]` for template approval/rejection updates; forward to template status handler.
4. **Stamp:** `source: 'messenger'`, a normalized ms `timestamp`, `platform: 'messenger'`, and `account_id` derived from the echo rule — `sender.id` on an echo, `recipient.id` otherwise. **Not** from `entry[].id`; the account is per-event, because an echo inverts sender and recipient.
5. **Publish:** One message per event to the Kafka topic, keyed by the **user id** (the PSID — `recipient.id` on an echo, `sender.id` otherwise).

### WhatsApp Webhooks (`/whatsapp`)

1. **Verify (GET):** Meta sends `hub.verify_token` + `hub.challenge`. Handler checks token against `WHATSAPP_VERIFY_TOKEN` and echoes challenge (or 401).
2. **Ingest (POST):** Meta sends webhook with `entry[]` array containing `changes[].value.{messages,statuses}[]`.
3. **Process:** Walk `changes[].value.messages` for inbound messages, `changes[].value.statuses` for delivery/read receipts.
4. **Extract phone_number_id:** From `metadata.phone_number_id` in the change value.
5. **Stamp:** `source: 'whatsapp'`, `phone_number_id`, a normalized ms `timestamp` (WhatsApp sends seconds, as a string), `platform: 'whatsapp'`, and `account_id` = `phone_number_id`.
6. **Publish:** One message per item to the Kafka topic, keyed by the **user id** — `from` on a message, `recipient_id` on a status, so both partition to the same participant.

### Synthetic Events (`/synthetic`)

Internal endpoint for events that did not arrive from Meta — dean's timeouts and
follow-ups, dinersclub's payment results, replybot's and message-worker's
`machine_report`s, linksniffer's click events, exodus' bails. Also the entry point for
staging tests and admin tooling, since it needs no Meta webhook setup.

**The body is NOT a UniversalEvent.** Normalization happens downstream in replybot's
`event-normalizer.js`. Hermes takes a flat envelope, stamps `source`, `timestamp` and the
conversation fields onto it, and publishes it as-is. Unknown fields pass through
untouched, which is why a poster can add a field without hermes changing.

```jsonc
POST /synthetic
Headers: X-Vlab-Poster: <service name>      // for attributing rejections
{
  "user":       "<user_id>",                // required
  "account_id": "<account_id>",             // required; `page` accepted as a deprecated alias
  "platform":   "messenger" | "whatsapp",   // required
  "event":      { "type": "...", "value": ... }
}
```

1. **Validate:** `user`, `account_id`, `platform`. A missing `user` is always 400. A
   missing `account_id`/`platform` is 400 only when `SYNTHETIC_REQUIRE_CONVERSATION` is
   on — see *The conversation triple* below.
2. **Stamp:** `source: "synthetic"`, `timestamp: now_ms`, plus `account_id` and
   `platform` when derivable.
3. **Publish:** Kafka message keyed by `user`, body is the stamped JSON.

## Source Schema & Account ID Stamping

Every event hermes publishes — all three shapes — carries two normalized top-level fields
identifying the conversation it belongs to:

```jsonc
{
  "account_id": "<account>",              // the messaging account
  "platform":   "messenger" | "whatsapp"  // the conversation's transport
}
```

`documentation/event-envelope.md` is the full contract. Derivation, per shape:

| Shape | `account_id` | `platform` |
|---|---|---|
| Messenger | `sender.id` if `message.is_echo` else `recipient.id` | `"messenger"` |
| WhatsApp | `phone_number_id` (from `entry.changes[].value.metadata`) | `"whatsapp"` |
| Synthetic | POSTed `account_id`, else `page` (deprecated) | POSTed `platform` |

A field is stamped **only when it derives to a non-empty string** — never `null`, never
`""`. Absent is safe: the consumer treats a missing component as "do not touch the state
cache" and replays from the event log. An empty string would be a poisoned conversation
key, which is not safe.

`platform` is stamped unconditionally on Messenger and WhatsApp, independently of whether
`account_id` derives — the transport is known there regardless.

**On Messenger the account is echo-dependent.** An echo is a message the *page* sent, so
the roles invert and the page is the `sender`. That rule is duplicated in JS in
`replybot/lib/event-normalizer.js` `parseMessengerEvent`, and is the only two-language
logic in this work, so it is pinned by a shared fixture —
`testdata/event-envelope/messenger-account-derivation.json`, loaded by
`hermes/src/event.rs` tests via `include_str!` and by
`replybot/lib/event-normalizer.test.js` via `require`. Change the rule in one language and
the other language's suite fails. The fixture is safe at the repo root despite the
per-service Docker build contexts, because the Rust loader sits in a `#[cfg(test)]` module
that `cargo build --release` never compiles.

### `source` is not `platform`

Both fields exist, both stay, and they are not synonyms.

- **`source`** — where the event came *in from*: `messenger` | `whatsapp` | `synthetic`.
- **`platform`** — what transport the *conversation* runs on: `messenger` | `whatsapp`.
  **Never `synthetic`.**

They differ exactly on synthetic events, which is the whole reason `platform` must be sent
explicitly rather than inferred from `source`: a payment result arrives with
`source: "synthetic"`, which says nothing about how to reach the participant.

### Nothing was removed

`phone_number_id`, `page`, `recipient.id` and `sender.id` keep their names and meanings
alongside the new fields. The `messages` backfill reads the account out of historical
`messages.content` under those per-shape names, so keeping them lets old and new rows
share one extraction path.

## The conversation triple

A synthetic event without a platform cannot be attributed to a conversation, so accepting
it silently reproduces the cross-account state-bleed bug the envelope exists to prevent.
Hermes rejects an incomplete `/synthetic` POST with **400**, logging the poster identity
(`X-Vlab-Poster`, falling back to `User-Agent`) and the event type so the culprit is
findable.

This is **gated**, because hermes must accept-but-not-require until every poster is
deployed — otherwise in-flight posters 400 mid-rollout:

| `SYNTHETIC_REQUIRE_CONVERSATION` | Behaviour |
|---|---|
| absent, or anything but `true`/`1` — the default | accept, stamp what derives, log the gap |
| `true` or `1` (case-insensitive) | 400, produce nothing |

Greppable log tags, deliberately distinct so "the poster did not send it" is never confused
with "hermes could not derive it":

| Tag | Meaning |
|---|---|
| `[NO_USER]` | `/synthetic` with no `user`. Always 400. |
| `[NO_CONVERSATION]` | `/synthetic` missing `account_id`/`platform`, gate **on**. 400. |
| `[INCOMPLETE_CONVERSATION]` | same, gate **off**. Accepted — this is the rollout counter. |
| `[NO_CONVERSATION_MESSENGER]` | `account_id` not derivable from a Messenger webhook |
| `[NO_CONVERSATION_WHATSAPP]` | `phone_number_id` empty on a WhatsApp webhook |

**Do not turn the gate on yet.** Two of the six synthetic posters — `linksniffer` and
`exodus` — do not send the triple. See `documentation/event-envelope.md` for why
linksniffer cannot without a change to how replybot builds webview URLs.

## Test Layout

`hermes/tests/` contains integration tests exercising `build_router()` (shared with main.rs):
- Signature verification (valid/invalid/missing)
- Token verification (GET /webhooks, GET /whatsapp)
- Event parsing and stamping (Messenger, WhatsApp, synthetic)
- Kafka producer mocking

All tests import and call `build_router(state)` directly, ensuring they exercise the exact same routing as production.

Unit tests for the pure derivation live in `src/event.rs`'s `#[cfg(test)] mod tests`. The
Messenger echo rule is exercised there against the **shared cross-language fixture** at
`testdata/event-envelope/messenger-account-derivation.json` (loaded with `include_str!`),
which `replybot/lib/event-normalizer.test.js` also loads. Do not restate that rule in a
hand-written Rust test — add a vector to the fixture instead, so both languages get it.

## Template Status Updates

`handle_template_status_update` (handlers.rs) processes Messenger template approval/rejection webhooks:
- Listens for `entry.changes[field=message_template_status_update]`
- Extracts template name, language, and status from the change value
- **Note:** WhatsApp template status updates arrive as a different webhook field; future work may add WhatsApp support here.

## Performance & Scaling

- **Stateless:** No in-process state; all routing via Kafka
- **Async I/O:** Tokio runtime, non-blocking all I/O
- **Kafka Producer:** Buffered publish; retries on broker-transient errors
- **Request Body Limit:** 5 MB (configurable via RequestBodyLimitLayer)
- **CORS:** Permissive (tower-http CorsLayer)

Scales horizontally by increasing replicas; no affinity required.

## Local Development

### Prerequisites

- Rust 1.70+ (check `hermes/Cargo.toml` for MSRV)
- Kafka running (e.g., via devops `make dev`)

### Build & Run

```bash
cd hermes
cargo build --release
VERIFY_TOKEN=dev_token KAFKA_BROKERS=localhost:9092 cargo run
```

Or via Docker:
```bash
docker build -t hermes:dev .
docker run -e VERIFY_TOKEN=dev_token -e KAFKA_BROKERS=kafka:9092 hermes:dev
```

### Testing

```bash
cargo test
```

Tests use a mock `StubProducer` (thread-safe in-memory queue) instead of real Kafka.

### Connecting a Real Webhook

1. Ensure `/whatsapp` is routable from the internet (e.g., via ngrok: `ngrok http 3000`)
2. Configure Meta webhook in the Facebook App Dashboard → Webhooks → Messenger:
   - Callback URL: `https://<your-domain>/whatsapp`
   - Verify token: must match `WHATSAPP_VERIFY_TOKEN`
3. Meta will send a GET verification request; if token matches, Hermes echoes the challenge and Meta subscribes
4. Inbound messages trigger POST to the same URL; payload is signature-verified and published to Kafka

## Deployment (Kubernetes)

See `hermes/chart/` for Helm chart. Key values:

```yaml
hermes:
  replicaCount: 2
  image: vlab-research/hermes:v1.0.0
  env:
    VERIFY_TOKEN: <from_meta_app_settings>
    WHATSAPP_VERIFY_TOKEN: <from_meta_app_settings>
    FB_APP_SECRET: <from_meta_app_settings>
    KAFKA_BROKERS: kafka-broker-1:9092,kafka-broker-2:9092
    PORT: 3000
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
```

Readiness probe: `GET /health` (200 = ready, 503 = waiting for Kafka).

## Kafka Topic & Partitioning

Events are published to the topic specified by `BOTSERVER_EVENT_TOPIC` (default `events`). **Key:** User ID or phone number (PSID for Messenger, phone_number for WhatsApp).

Partitioning ensures all events for a user route to the same partition, so downstream consumers (replybot) process a user's events in order without needing distributed coordination.

## Troubleshooting

| Symptom | Likely Cause |
|---------|--------------|
| 401 on GET /webhooks | `VERIFY_TOKEN` env var doesn't match Meta's configured token. Check Facebook App Dashboard → Settings → Basic → Verify Token. |
| 401 on GET /whatsapp | `WHATSAPP_VERIFY_TOKEN` not set or doesn't match Meta's token. |
| 401 on POST /webhooks or /whatsapp | Signature verification failed. Check `FB_APP_SECRET` matches Meta app secret, and X-Hub-Signature-256 header is present. |
| Connection refused to Kafka | `KAFKA_BROKERS` misconfigured or Kafka not running. Check `kafka:9092` resolves and is listening. |
| Health check returns 503 | Kafka producer not yet connected. Check logs and broker connectivity. |
| Events not appearing in Kafka | Webhook URL not reachable by Meta (if public); check Meta webhook logs in app dashboard. Use `/synthetic` for local testing without Meta setup. |

## See Also

- `documentation/event-envelope.md` — the event envelope contract: the two normalized fields, the derivation table, the posters, and the 400 gate
- `documentation/platform-abstraction.md` — overall architecture and account-id routing
- `replybot/README.md` — event normalization and state machine
- `message-worker/README.md` — outbound message translation and sending
