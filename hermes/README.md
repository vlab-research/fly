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
4. **Stamp:** Tag events with `source: 'messenger'` + `page_id` (extracted from webhook entry).
5. **Publish:** One message per event to Kafka topic (user-keyed by PSID / page_id pair for partitioning).

### WhatsApp Webhooks (`/whatsapp`)

1. **Verify (GET):** Meta sends `hub.verify_token` + `hub.challenge`. Handler checks token against `WHATSAPP_VERIFY_TOKEN` and echoes challenge (or 401).
2. **Ingest (POST):** Meta sends webhook with `entry[]` array containing `changes[].value.{messages,statuses}[]`.
3. **Process:** Walk `changes[].value.messages` for inbound messages, `changes[].value.statuses` for delivery/read receipts.
4. **Extract phone_number_id:** From `metadata.phone_number_id` in the change value.
5. **Stamp:** Tag events with `source: 'whatsapp'` + `phone_number_id`.
6. **Publish:** One message per item to Kafka topic (user-keyed by phone number / phone_number_id for partitioning).

### Synthetic Events (`/synthetic`)

1. **Ingest:** POST body is a pre-normalized `UniversalEvent` JSON.
2. **Parse:** Extract `user_id` from the event.
3. **Publish:** Kafka message keyed by `user_id`, body is the JSON as-is.
4. **Use case:** Staging tests, manual re-entry simulation, admin tooling (no Meta webhook setup required).

Example:
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
    "referral": { "ref": "form.flysmoke" }
  },
  "raw": {}
}
```

## Source Schema & Account ID Stamping

### Messenger

```json
{
  "source": "messenger",
  "page_id": "<facebook_page_id>",
  "timestamp": <seconds>
}
```

The `page_id` is extracted from the webhook's `entry[].id` field (Meta always sends the page ID in the entry for Messenger webhooks).

### WhatsApp

```json
{
  "source": "whatsapp",
  "phone_number_id": "<phone_number_id>",
  "timestamp": <seconds>
}
```

The `phone_number_id` is extracted from `entry.changes[].value.metadata.phone_number_id` for each message or status.

## Test Layout

`hermes/tests/` contains integration tests exercising `build_router()` (shared with main.rs):
- Signature verification (valid/invalid/missing)
- Token verification (GET /webhooks, GET /whatsapp)
- Event parsing and stamping (Messenger, WhatsApp, synthetic)
- Kafka producer mocking

All tests import and call `build_router(state)` directly, ensuring they exercise the exact same routing as production.

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

- `documentation/platform-abstraction.md` — overall architecture and account-id routing
- `replybot/README.md` — event normalization and state machine
- `message-worker/README.md` — outbound message translation and sending
