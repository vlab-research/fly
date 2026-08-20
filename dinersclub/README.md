# DinersClub - Payment Provider Platform

DinersClub is a Kafka-based payment processing service that executes payment transactions through pluggable payment providers. It consumes payment events from Kafka, routes them to the appropriate provider, executes the payment, and — **depending on how the failure can recover** — sends a result back to the botserver.

> **Read `documentation/payment-recovery.md` first if you are here about a
> failed payment.** dinersclub is one of three layers that retry, and the most
> important thing it does with a failure is often *nothing*: a `transient` or
> `precondition` failure sends no event, which is what keeps the respondent
> parked so dean can pay them later. That is deliberate and is explained there.

## Quick Start

### Environment Setup

Required environment variables:

```bash
# Database
export CHATBASE_DATABASE=chatroach
export CHATBASE_HOST=localhost
export CHATBASE_PORT=26257
export CHATBASE_USER=root
export CHATBASE_MAX_CONNECTIONS=10

# Kafka
export KAFKA_BROKERS=localhost:9092
export KAFKA_TOPIC=vlab-payment
export KAFKA_GROUP=dinersclub
export KAFKA_POLL_TIMEOUT=1s
export DINERSCLUB_BATCH_SIZE=100

# Processing
export DINERSCLUB_PROVIDERS=fake,reloadly,giftcard,http,dingconnect
export DINERSCLUB_POOL_SIZE=10
export DINERSCLUB_RETRY_PROVIDER=60s
export DINERSCLUB_RETRY_BOTSERVER=60s
export DINERSCLUB_PROVIDER_TIMEOUT=15s
export BACK_OFF_RANDOM_FACTOR=0.5

# Metrics
export DINERSCLUB_METRICS_PORT=9090

# Caching
export CACHE_TTL=1h
export CACHE_NUM_COUNTERS=10000
export CACHE_MAX_COST=10000
export CACHE_BUFFER_ITEMS=64

# Reloadly (if using reloadly or giftcard providers)
export RELOADLY_SANDBOX=true

# BotServer
export BOTSERVER_URL=http://localhost:8080/synthetic
```

### Running Tests

```bash
# Run all tests
go test ./...

# Run with race detection
go test -race ./...

# Run specific test
go test -run TestHttpProviderPayout ./...
```

### Local Development with Docker Compose

The included `test.yaml` defines a complete development environment:

```bash
docker-compose -f test.yaml up
```

This sets up:
- CockroachDB (test database)
- DinersClub service with database initialization
- All required networking

## Architecture

### Core Concepts

**Provider**: A payment backend that implements the payment processing logic.

```go
type Provider interface {
	GetUserFromPaymentEvent(*PaymentEvent) (*User, error)  // Extract user from event
	Auth(*User, string) error                               // Authenticate with provider
	Payout(*PaymentEvent) (*Result, error)                  // Execute payment
}
```

**PaymentEvent**: A Kafka message representing a payment request.

```json
{
  "userid": "user123",
  "pageid": "fb-page-456",
  "platform": "messenger",
  "timestamp": 1600558963867,
  "provider": "http",
  "key": "custom-api-key",
  "details": {
    "id": "payment-789",
    "method": "POST",
    "url": "https://api.example.com/pay",
    "headers": {"Authorization": "Bearer << token >>"},
    "body": {"amount": 50.00},
    "errorMessage": "error.message",
    "responsePath": "transaction.id"
  }
}
```

`pageid` holds the platform account id (Facebook page_id for Messenger, phone_number_id for
WhatsApp), which equals `credentials.key` for messaging entities. `platform`
(`"messenger" | "whatsapp"`) is optional: when present, `GenericGetUser` resolves the researcher
via the credentials natural key `WHERE entity = $1 AND key = $2` (messenger→facebook_page,
whatsapp→whatsapp_business). When absent (old in-flight events emitted before replybot added the
field), it falls back to `WHERE key = $1 AND entity IN ('facebook_page', 'whatsapp_business')` —
safe because the `unique_messaging_account` partial index keeps account ids globally unique
across messaging platforms. See `documentation/platform-abstraction.md` ("Account ID Routing").

**Result**: Response sent to botserver indicating success or failure.

```json
{
  "type": "payment:http",
  "id": "payment-789",
  "success": true,
  "timestamp": "2024-01-15T10:30:00Z",
  "phone": "+918888000000",
  "payment_details": {...},
  "response": {...}
}
```

The optional `phone` field carries the payout phone number. Providers (and the
fake provider's echoed `result`) can set it so it lands in the user's state
metadata (e.g. `md.e_payment_fake_phone`), where forms can reference it — the
replybot flattens every Result key into `md` as `e_<type>_<key>`.

### Request Flow

```
Kafka Message
    ↓
Parse JSON → Create PaymentEvent
    ↓
Validate required fields
    ↓
Check if provider enabled
    ↓
Instantiate provider
    ↓
Extract user from event
    ↓
Check cache for auth state
    ↓ (if not cached)
Call provider.Auth() → Cache result
    ↓
Call provider.Payout() with exponential backoff retry
    ↓          (a `transient` error code is retried here too, not just
    ↓           a system fault — see "Recovery classes" below)
Classify the result
    ↓
    ├─ success ..................... send to botserver
    ├─ permanent failure ........... send to botserver
    └─ transient / precondition .... SEND NOTHING, record a metric
                                     (respondent stays in WAIT_EXTERNAL_EVENT;
                                      dean re-drives the payment)
```

Every branch commits the Kafka offset. Nothing in dinersclub blocks a partition
waiting for a provider to come back — that is dean's job, and dinersclub
blocking is what caused the 2026-08-17 incident.

### Component Files

| File | Purpose |
|------|---------|
| `main.go` | Application entry point, Kafka consumer loop, payment processing orchestration |
| `provider.go` | Provider interface, PaymentEvent/Result types, generic user lookup |
| `config.go` | Configuration struct and environment parsing |
| `db.go` | Database connection pooling |
| `fake.go` | Test provider that returns pre-configured results |
| `reloadly.go` | Reloadly mobile topup provider |
| `giftcards.go` | Reloadly gift card provider |
| `http_provider.go` | Generic HTTP provider for arbitrary APIs |
| `dingconnect.go` | DingConnect mobile topup provider (global API key, instant mode) |
| `classify.go` | **Pure** mapping from provider error code to recovery class. Decides whether a failure is sent at all |
| `metrics.go` | Prometheus collectors and the `/metrics` endpoint |

## Payment Providers

### Fake Provider

For testing. Returns pre-built results embedded in payment details.

**Configuration**:
```json
{
  "result": {
    "type": "payment:test",
    "success": true,
    "id": "test-123"
  }
}
```

**Enabled via**:
```bash
DINERSCLUB_PROVIDERS=fake
```

### Reloadly Provider

Mobile topup and airtime payments via Reloadly API.

**Configuration**:
```json
{
  "id": "payment-123",
  "number": "+918527562332",
  "amount": 2.5,
  "country": "IN",
  "operator": "BSNL India",
  "tolerance": 30,
  "custom_identifier": "+918527562332"
}
```

**Credentials** (stored in database):
```json
{
  "entity": "reloadly",
  "key": "my-account",
  "details": {
    "id": "reloadly-account-id",
    "secret": "reloadly-secret"
  }
}
```

**Enabled via**:
```bash
DINERSCLUB_PROVIDERS=reloadly
RELOADLY_SANDBOX=true  # or false for production
```

**Error codes**: PHONE_RECENTLY_RECHARGED, TRANSACTION_CANNOT_BE_PROCESSED_AT_THE_MOMENT, IMPOSSIBLE_AMOUNT, etc.

### GiftCard Provider

Gift card purchases via Reloadly.

**Configuration**:
```json
{
  "id": "gift-card-123",
  "productId": 1234,
  "countryCode": "IN",
  "quantity": 1,
  "unitPrice": 50.00,
  "senderName": "John Doe",
  "recipientEmail": "recipient@example.com"
}
```

**Credentials**: Same as Reloadly provider (entity='reloadly')

**Note**: CustomIdentifier is automatically generated as a UUID on each call.

**Enabled via**:
```bash
DINERSCLUB_PROVIDERS=giftcard
RELOADLY_SANDBOX=true
```

### HTTP Provider

Generic HTTP client for calling arbitrary payment APIs.

**Configuration**:
```json
{
  "id": "http-payment-123",
  "method": "POST",
  "url": "https://api.example.com/payments?api_key=<< api_key >>",
  "headers": {
    "Authorization": "Bearer << bearer_token >>",
    "Content-Type": "application/json"
  },
  "body": {
    "amount": 50.00,
    "currency": "USD",
    "recipient": "user@example.com"
  },
  "errorMessage": "errors.0.message",
  "responsePath": "transaction.id"
}
```

**Credentials** (secrets stored per user):
```sql
INSERT INTO credentials(userid, entity, key, details)
VALUES ('user-123', 'secrets', 'api_key', '{"value": "sk_live_abc123"}');

INSERT INTO credentials(userid, entity, key, details)
VALUES ('user-123', 'secrets', 'bearer_token', '{"value": "token_xyz789"}');
```

**Features**:
- **Mustache templating**: Use `<< secret_name >>` to inject secrets from database
- **Response path extraction**: Use JSONPath to extract specific fields from response (e.g., `transaction.id` or `errors.0.message`)
- **Error message extraction**: Extract error message from response using JSONPath
- **Flexible methods**: Supports GET, POST, PUT, DELETE, PATCH
- **60-second timeout**: All requests have 60-second hard timeout

**Error codes**:
- MISSING_SECRET: Template placeholder for non-existent secret
- BAD_HTTP_REQUEST: Invalid URL or request
- HTTP_REQUEST_FAILED: Network error
- HTTP status code (e.g., "400", "500"): From non-2xx response

**Enabled via**:
```bash
DINERSCLUB_PROVIDERS=http
```

### DingConnect Provider

Mobile top-ups via DingConnect API (https://api.dingconnect.com). Covers 850+ mobile operators across 150+ countries.

**Credentials** (stored in database per user):
```sql
INSERT INTO credentials(userid, entity, key, details)
VALUES ('user-uuid', 'dingconnect', 'prod-key', '{"api_key": "dc_live_xxxxx..."}');
```

The `key` field allows multiple DingConnect accounts per user (e.g., 'prod', 'staging', 'test'). The `details` JSON must contain an `api_key` field with the DingConnect API key from your account.

**Payment Details Structure** (JSON in PaymentEvent.Details):
```json
{
  "id": "optional_payment_id",
  "sku_code": "US_VERIZON_5GB",
  "send_value": 25.00,
  "send_currency_iso": "USD",
  "account_number": "14155552671",
  "distributor_ref": "unique_txn_id_20260301_001",
  "settings": [{"name": "setting1", "value": "value1"}]
}
```

**Required Fields**:
- `sku_code` (string): Product SKU from DingConnect GetProducts endpoint
- `account_number` (string): Target phone number or account identifier
- `distributor_ref` (string): Unique ID for deduplication (e.g., `userid-phone` or `timestamp-uuid`). DingConnect uses this to prevent duplicate charges for the same transfer submitted multiple times.
- `send_value` (number): Amount to transfer (must be positive)

**Optional Fields**:
- `send_currency_iso` (string): Currency code (defaults to USD if not provided)
- `id` (string): Payment ID for tracking
- `settings` (array): Provider-specific settings

**Features**:
- **Instant mode only**: Synchronous processing - transfers are completed within 90 seconds
- **Per-user API key**: Credentials stored in database per user and key (matching Reloadly pattern)
- **90-second timeout**: Hard timeout for SendTransfer requests
- **Error code passthrough**: Returns DingConnect error codes directly

**Error codes** (returned from DingConnect API):
- `INSUFFICIENT_BALANCE`: Account balance too low for the transfer
- `INVALID_ACCOUNT_NUMBER`: Phone number format invalid
- `INVALID_SKU_CODE`: Product SKU not found or disabled
- `PROVIDER_UNAVAILABLE`: Mobile operator is down
- `PROVIDER_TIMED_OUT`: Request to operator exceeded 90 seconds
- `DUPLICATE_REFERENCE`: Same distributor_ref submitted twice
- Other codes passed through as-is for display to user

**Enabled via**:
```bash
DINERSCLUB_PROVIDERS=fake,reloadly,giftcard,http,dingconnect
```

**Setup Instructions**:
1. Create DingConnect account at https://www.dingconnect.com
2. Navigate to Account Settings → Developer tab
3. Generate API key
4. Insert credentials into the database for each user that needs DingConnect:
   ```sql
   INSERT INTO credentials(userid, entity, key, details)
   VALUES ('user-uuid', 'dingconnect', 'prod', '{"api_key": "dc_live_xxxxx..."}');
   ```
   Replace `user-uuid` with the actual user ID and `dc_live_xxxxx...` with your DingConnect API key.
5. Include the `key` field in PaymentEvent messages to specify which credentials to use

## Configuration Reference

### Database Configuration

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| CHATBASE_DATABASE | - | Yes | PostgreSQL database name |
| CHATBASE_HOST | - | Yes | PostgreSQL host |
| CHATBASE_PORT | - | Yes | PostgreSQL port |
| CHATBASE_USER | - | Yes | PostgreSQL user |
| CHATBASE_MAX_CONNECTIONS | - | Yes | Connection pool max size |

### Kafka Configuration

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| KAFKA_BROKERS | - | Yes | Comma-separated broker addresses (e.g., `kafka1:9092,kafka2:9092`) |
| KAFKA_TOPIC | - | Yes | Topic to consume payment events from |
| KAFKA_GROUP | - | Yes | Consumer group name |
| KAFKA_POLL_TIMEOUT | - | Yes | How long to wait for new messages (e.g., `1s`, `100ms`) |
| DINERSCLUB_BATCH_SIZE | - | Yes | Number of messages to process as batch |

### Processing Configuration

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| DINERSCLUB_PROVIDERS | - | Yes | Comma-separated list of enabled providers (e.g., `fake,reloadly,http`) |
| DINERSCLUB_POOL_SIZE | - | Yes | Maximum concurrent payment jobs |
| DINERSCLUB_RETRY_PROVIDER | - | Yes | Max **elapsed** duration to retry provider calls with exponential backoff |
| DINERSCLUB_RETRY_BOTSERVER | - | Yes | Max **elapsed** duration to retry botserver calls with exponential backoff |
| DINERSCLUB_PROVIDER_TIMEOUT | 30s | No | Hard timeout on a **single** outbound provider HTTP call. Not the same thing as the retry budgets — see below. Production sets 15s |
| DINERSCLUB_METRICS_PORT | 9090 | No | Port for `/metrics`. Must match `dinersclub.metrics.port` in `devops/values/<env>.yaml`, which is what the Service targets |
| BACK_OFF_RANDOM_FACTOR | 0.5 | No | Randomization factor for backoff (0.0 to 1.0) |

### These are a budget, not independent knobs

`spine` hardcodes `max.poll.interval.ms = 300000` (5 min) in `kafka.go`, and
runs with `enable.auto.commit = false`. If processing one batch outruns 300s,
Kafka evicts the consumer from the group, the in-flight batch is **never
committed**, and on restart the service reads the *same* messages and hangs
again — a crash loop that makes zero progress while lag climbs. See "Provider
call hangs / crash loop" under Common Issues.

**One attempt is up to three calls, not one.** Reloadly's `DoJob` makes
`FindOperator` + `Topup`, and `AutoFallback` can add a second `Topup` on a
refusal. That is why the per-call ceiling has to be much smaller than the
budget that contains it — a budget shorter than one attempt buys nothing at all,
because `backoff` only consults `MaxElapsedTime` *between* attempts.

Worst case for a batch, when `POOL_SIZE == BATCH_SIZE` (messages run
concurrently, so a batch costs roughly what one message costs):

```
auth on cache miss    <= PROVIDER_TIMEOUT                 (1 call)
Payout backoff        <= RETRY_PROVIDER  + 3x PROVIDER_TIMEOUT
sendResult backoff    <= RETRY_BOTSERVER + one in-cluster hermes call
```

At the production values (15s / 60s / 60s) that is ~180s, leaving headroom under
the 300s ceiling. **Raising any of these — or setting `BATCH_SIZE` above
`POOL_SIZE`, which makes the batch serial — must be re-checked against that
ceiling.**

The retry budget is not only for system faults. Since `classify.go`, a provider
error code classified `transient` is retried inside `RETRY_PROVIDER` as well;
60s buys roughly two real attempts. Before that, a declined payment came back as
`(Result, nil)` and the budget never saw it, so a provider answering 503s burned
straight through the queue telling every respondent their payment had failed.

> The 300s ceiling is no longer the thing holding the design together — nothing
> should block long enough to approach it. It is a backstop, and the fact that
> it does not need raising is the sign the budget is right. If you find yourself
> wanting to raise `max.poll.interval.ms`, the answer is almost certainly that
> something is blocking that should have been deferred to dean instead.

### Cache Configuration

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| CACHE_TTL | - | Yes | Time-to-live for authentication cache (e.g., `1h`, `30m`) |
| CACHE_NUM_COUNTERS | - | Yes | Ristretto cache counter capacity |
| CACHE_MAX_COST | - | Yes | Ristretto cache max cost |
| CACHE_BUFFER_ITEMS | - | Yes | Ristretto cache buffer items |

### Provider Configuration

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| RELOADLY_SANDBOX | - | Yes | Boolean - use Reloadly sandbox (true) or production (false) |

### Server Configuration

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| BOTSERVER_URL | - | Yes | URL to botserver for sending payment results |

## Environment Variables

### Deprecated Variables

**DINGCONNECT_API_KEY** - No longer used. API keys are now fetched from the database per-user. Remove this from your environment.

## Database Schema

DinersClub expects the following database structure:

### users table
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email STRING,
  -- other fields as needed
);
```

### credentials table
```sql
CREATE TABLE credentials (
  userid UUID NOT NULL REFERENCES users(id),
  entity STRING NOT NULL,          -- 'facebook_page', 'reloadly', 'secrets', etc.
  key STRING,                       -- Optional identifier within entity type
  details JSONB NOT NULL,          -- JSON data specific to credential type
  PRIMARY KEY (userid, entity, key)
);
```

**Credential types**:

- **facebook_page**: Links Facebook page ID to user
  ```json
  {"id": "facebook-page-123"}
  ```

- **reloadly**: Reloadly API credentials
  ```json
  {"id": "reloadly-id", "secret": "reloadly-secret"}
  ```

- **dingconnect**: DingConnect API key
  ```json
  {"api_key": "dc_live_xxxxx..."}
  ```

- **secrets**: Named secrets for HTTP provider templates
  ```json
  {"value": "actual-secret-value"}
  ```

## Error Handling

### Recovery classes

`classify.go` maps every provider error code to one of three classes. The class
is a **fact about the failure** — it does not encode who retries, who is
alerted, or what state the respondent ends up in. Those are other components'
decisions, and dinersclub cannot see them.

| class | meaning | dinersclub does | examples |
|---|---|---|---|
| `transient` | the same call, later, may just work | retries in-process, then **sends nothing** | provider 5xx, `OPERATOR_UNAVAILABLE_OR_CURRENTLY_INACTIVE`, `TRANSACTION_CANNOT_BE_PROCESSED_AT_THE_MOMENT` |
| `precondition` | a human off-stage must act first | **sends nothing** | `INSUFFICIENT_BALANCE`, `AUTH_ERROR` |
| `permanent` | never going to work as configured | **sends the failure Result** | `INVALID_RECIPIENT_PHONE`, `IMPOSSIBLE_AMOUNT`, `PHONE_RECENTLY_RECHARGED` |

**Sending is releasing.** replybot's wait matcher is a subset check over `type`
and `id` and never looks at `success`, so *any* Result takes the respondent out
of `WAIT_EXTERNAL_EVENT`. Not sending is the only way to keep someone parked,
and being parked is the only way dean's `Payments` sweep can find them again.
This is why the behavioural axis is a binary even though there are three
classes: `transient` and `precondition` are kept apart because they differ in
what a *human* should do, which is what the metrics and alerts read.

**An unrecognised code is `permanent`** — it is sent, exactly as every failure
was sent before classification existed. New behaviour applies only where we can
name the reason, and the mistake is cheap to correct: the code is counted by
`dinersclub_unclassified_error_codes_total` and the
`PaymentUnclassifiedErrorCode` alert asks someone to add a row.

> **Changing a code's class is a decision, not a refactor.** `classify_test.go`
> pins every code in the map with its observed production frequency and asserts
> that the map contains nothing unpinned, so a class cannot drift as a side
> effect of an edit — someone has to come to the test and say so.

Classify on the **error code, never the HTTP status.** DingConnect returns
`InsufficientBalance` with HTTP 500 (`dingconnect_test.go:422` documents it),
and `go-reloadly` synthesises an `APIError` carrying the bare status from any
non-2xx. A "5xx means transient" rule would retry an empty wallet forever.

### Result Error Codes

| Code | Meaning | Class | Next Step |
|------|---------|-------|-----------|
| INVALID_PROVIDER | Provider not in DINERSCLUB_PROVIDERS list | permanent | Check provider name and configuration |
| AUTH_ERROR | Provider authentication failed | **precondition** | Fix credentials; parked payments land on dean's next sweep |
| INSUFFICIENT_BALANCE | Researcher's provider wallet is empty | **precondition** | Top the account up — pages as `PaymentWalletEmpty` |
| INVALID_JSON_FORMAT | Payment details JSON malformed | permanent | Check JSON format of details |
| MISSING_SECRET | HTTP provider missing interpolation secret | permanent | Add secret to credentials table |
| BAD_HTTP_REQUEST | HTTP provider request invalid | permanent | Check URL and headers |
| HTTP_REQUEST_FAILED | Never reached the provider | **transient** | Check network/API availability |
| HTTP 5xx / 429 | Server-side fault or throttling | **transient** | Retried, then deferred to dean |
| HTTP 4xx | Request the provider refused | permanent | Check API response/logs |

The full table, with production frequencies, is `recoveryByCode` in
`classify.go`.

### Failure Modes

**Sent to the respondent** (Result delivered, wait fulfilled, message consumed):
- Successful payments
- `permanent` payment failures, including unrecognised error codes
- Provider not found or not enabled

**Withheld** (nothing sent, respondent stays in `WAIT_EXTERNAL_EVENT`, message
consumed, dean re-drives):
- `transient` payment failures that outlived the retry budget
- `precondition` payment failures
- Provider calls that never produced a verdict at all (every attempt a system
  fault)

**Faults in dinersclub** (nothing sent, message consumed, counted in
`dinersclub_processing_faults_total`, logged loudly):
- Malformed message JSON — the rest of the batch still processes
- Missing required PaymentEvent fields
- Database connectivity error
- Botserver unreachable after max retries

**Fatal** (process exits):
- Kafka faults only (`monitor()`). The consumer has lost its group and nothing
  further will be processed anyway.

### Why nothing else is fatal any more

`spine`'s `SideEffect` commits the batch **immediately after `checkError`
returns**, so `log.Fatalf` was the only thing standing between a fault and a
lost message — and it bought that at the price of never committing anything. On
2026-08-17 that turned a hung Reloadly into a crash loop that made zero progress
for ~50 minutes: the batch was never committed, the pod restarted, read the same
two messages, and hung again.

Committing past a fault is safe **because nothing was sent to the respondent.**
They are still parked, and dean re-drives the payment for up to 14 days.
dinersclub is not the last line of defence and must not behave as though it is.

The cost is that dinersclub can now be failing every message while looking
perfectly healthy to Kubernetes, since there is no restart to notice. That is
what `dinersclub_processing_faults_total` and the `DinersClubProcessingFaults`
alert replace.

## Testing

### Running Tests

```bash
# All tests
go test ./...

# Specific test file
go test -run TestHttpProvider ./...

# Verbose output
go test -v ./...

# With coverage
go test -cover ./...
```

### Test Database

Tests that access the database require it to be running:

```bash
docker-compose -f test.yaml up -d cockroachdb
go test ./...
```

### Test configuration comes from `init()`, not your shell

`getConfig()` parses the process environment and every field is `required`, but
the test binary never reads `.env` or `test-env`. Instead `dingconnect_test.go`
has a package-level `init()` that calls `os.Setenv` for the full config. Two
consequences that have bitten us:

1. **It clobbers your shell.** `os.Setenv` is unconditional, so exporting a
   variable before `go test` has no effect. To point the tests somewhere else
   you must edit that `init()`.
2. **`CHATBASE_PORT` is `26257`, not `5433`.** The tests talk to whichever
   cluster is on host port 26257 — a *different* container from the one on
   5433 that other modules (e.g. `dean`) use. Resetting the database on 5433
   does nothing for these tests. DB-touching tests self-clean via
   `before(t, pool)`, which deletes from `users` and `credentials`.

The processing knobs in that `init()` must mirror `./test-env`, **not** the
production values in `./.env`:

| Variable | Test value | Why |
|---|---|---|
| `DINERSCLUB_POOL_SIZE` | `1` | `TestDinersClubCache` asserts 1 cache miss + 2 hits. `chance.Pool` at size >1 lets all messages race through `cache.Get()` before the first `SetWithTTL` lands, yielding 3 misses / 0 hits. |
| `DINERSCLUB_RETRY_BOTSERVER` | `1s` | `TestDinersClubRepeatsOnServerErrorFromBotserver` asserts exactly 3 attempts. Attempt count is a function of the backoff `MaxElapsedTime`. At the production `2m` the test makes many more attempts and takes ~194s. |
| `DINERSCLUB_RETRY_PROVIDER` | `1s` | Same reasoning for provider-side retries. |
| `BACK_OFF_RANDOM_FACTOR` | `0` | Makes retry counts deterministic; unset it defaults to `0.5`. |

### A panic in one test hides every later test

Go aborts the whole test binary on panic, and `dinersclub_test.go` sorts before
`dingconnect_test.go`. A panic in an early test (historically the bare
`err.(*json.SyntaxError)` assertion in
`TestDinersClubErrorsOnMalformedJSONMessages`) silently prevents everything
after it from running — the suite reports `FAIL` without ever reporting the
tests it never reached. Prefer `errors.As` over bare type assertions in tests so
a mismatch fails one test instead of killing the run.

### Error wrapping contract

`Process()` annotates JSON parse failures with the offending Kafka payload and
wraps with `%w`. Use `%w` (never `%s`) when adding context to an error here:
the package inspects concrete error types to tell a malformed payload apart
from a system fault (see the `*json.SyntaxError` branch in `reloadly.go`), and
`%s` flattens the error to an opaque `*errors.errorString`, silently breaking
`errors.As` / `errors.Is` for every caller.

### Key Test Files

| File | Tests |
|------|-------|
| `dinersclub_test.go` | Integration tests: payment processing flow, caching, error handling |
| `http_provider_test.go` | HTTP provider: secret interpolation, request methods, response parsing |
| `reloadly_test.go` | Reloadly provider: credential lookup, auth, error codes |
| `giftcards_test.go` | Gift card provider: UUID generation, order validation |
| `fake_test.go` | Fake provider: JSON parsing, result injection |
| `provider_test.go` | Shared helpers: JSON unmarshal error handling |

## Deployment

### Docker Build

```bash
# Development image (with hot reload)
docker build -f Dockerfile.dev -t dinersclub:dev .

# Production image
docker build -f Dockerfile -t dinersclub:latest .
```

### Kubernetes Deployment

Uses Helm chart in `chart/` directory:

```bash
# Install
helm install dinersclub ./chart --values chart/values.yaml

# Upgrade
helm upgrade dinersclub ./chart --values chart/values.yaml

# Values to customize
# - image.repository: Docker image repository
# - image.tag: Docker image tag
# - env: Environment variables (Kafka brokers, database, etc.)
# - envFrom: ConfigMap or Secret names for credentials
# - resources: CPU/memory requests and limits
```

## Monitoring and Debugging

### Metrics

dinersclub exposes Prometheus metrics on `DINERSCLUB_METRICS_PORT` at
`/metrics`. It is the **only application service in this repo that Prometheus
scrapes** (`chart/templates/servicemonitor.yaml`).

They are not decorative. A `transient` or `precondition` failure sends no event
and therefore writes **no state**, so the tracking that
`md.e_payment_<provider>_error_code` used to provide disappears for exactly the
failures most worth watching — an empty researcher wallet above all. Deleting
these counters, or setting `metrics.enabled: false`, does not merely lose
observability: it makes the silent path unaccountable and blinds every alert in
`documentation/alerting.md` §12.

| metric | labels | what it answers |
|---|---|---|
| `dinersclub_payment_results_total` | `provider`, `outcome`, `recovery`, `code` | the ledger: every attempt that reached a verdict, once |
| `dinersclub_unclassified_error_codes_total` | `provider`, `code` | which rows are missing from `recoveryByCode` |
| `dinersclub_payment_duration_seconds` | `provider`, `outcome` | are we anywhere near the Kafka poll budget |
| `dinersclub_processing_faults_total` | `stage` | is dinersclub itself broken (replaces "the pod restarted") |
| `dinersclub_up` | — | is anyone scraping this at all |

`recovery != "permanent"` is precisely the set of failures the respondent was
never told about.

**`dinersclub_up` exists because a `CounterVec` with no observations exports no
series.** A healthy dinersclub that has simply had no payments to make publishes
no `dinersclub_payment_results_total` at all, so `absent()` on the payment
counter would alert for quiet rather than for a broken scrape. `dinersclub_up`
is unconditional and is what `DinersClubMetricsMissing` keys on.

The independent cross-check on all of it lives outside this process: a
respondent parked on an ageing `payment:*` wait is visible in state whether or
not any counter here moved.

### Logging

All requests logged to stdout:
- HTTP request dumps (via httputil.DumpRequestOut) for HTTP provider debugging
- Error messages and stack traces
- Kafka consumer metrics

### Cache Metrics

Cache statistics available via Ristretto metrics:
- Hits: Successful cache lookups (authentication cached)
- Misses: Cache lookups that required Auth() call

Enable in tests:
```go
cache, _ := ristretto.NewCache(&ristretto.Config{
    Metrics: true,
})
hits := cache.Metrics.Hits()
misses := cache.Metrics.Misses()
```

### Debugging HTTP Provider

Enable request logging:
```go
// httputil.DumpRequestOut logs full request to stdout
dump, _ := httputil.DumpRequestOut(req, true)
log.Println(string(dump))
```

This includes:
- HTTP method and URL
- All headers
- Request body

## Common Issues

### "User not found for page id: xxx"

The `facebook_page` credential entry wasn't found in the database. Ensure:
1. User exists in `users` table
2. Credential with `entity='facebook_page'` exists for the user
3. The credential details contains the correct page ID

```sql
SELECT * FROM credentials WHERE entity='facebook_page' AND userid='user-id';
```

### "No reloadly credentials were found"

The `reloadly` credential entry wasn't found or key doesn't match. Ensure:
1. Credential with `entity='reloadly'` exists
2. The `key` field in PaymentEvent matches the credential key
3. Details JSON contains `id` and `secret` fields

```sql
SELECT * FROM credentials WHERE entity='reloadly' AND userid='user-id' AND key='key-value';
```

### "failed to lookup XXX" (HTTP provider)

A secret placeholder `<< XXX >>` doesn't exist in the secrets table. Ensure:
1. Secret was added to credentials table
2. Entity is `'secrets'`
3. Key matches the placeholder name

```sql
INSERT INTO credentials(userid, entity, key, details)
VALUES ('user-id', 'secrets', 'XXX', '{"value": "the-secret-value"}');
```

### "HTTP_REQUEST_FAILED"

The HTTP provider couldn't connect to the API. Check:
1. URL is correct and accessible
2. Network/firewall allows outbound connections
3. API server is running
4. Consider increasing `DINERSCLUB_RETRY_PROVIDER` if flaky

### Provider call hangs / crash loop ("Group partition assignment lost")

Signature — the pod restarts on a near-exact 5-minute cycle, and the consumer
group's committed offset never moves while lag climbs:

```
Consumed 2 messages as batch from Kafka
%4|...|MAXPOLL|rdkafka#consumer-1| Application maximum poll interval (300000ms)
      exceeded by 228ms (adjust max.poll.interval.ms ...): leaving group
DinersClub failed from Kafka error: Local: Group partition assignment lost
```

This is **not** a Kafka fault. A provider call is hanging long enough that the
batch outruns spine's 300s poll interval; Kafka evicts the group, the batch is
never committed, `monitor()` calls `log.Fatalf`, and the restarted pod re-reads
the identical messages and hangs again. It cannot self-heal — the alert
`KafkaConsumerStuck` fires for it.

> **This should no longer be reachable.** Every outbound provider call is now
> bounded by `DINERSCLUB_PROVIDER_TIMEOUT`, and a processing fault no longer
> kills the process, so a batch cannot approach 300s and a poison message
> cannot loop. If you see this signature anyway, the interesting question is
> which call escaped the bound — a new provider that builds its own HTTP client
> is the likeliest answer (see "Why provider calls have a hard timeout"). The
> runbook below is kept because the diagnosis is still the right one.

Confirm and diagnose:

```bash
# Is the offset actually frozen? (LAG grows, CURRENT-OFFSET does not move)
kubectl exec -n default <kafka-pod> -c kafka -- env KAFKA_OPTS="" JMX_PORT="" \
  /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:29092 \
  --group dinersclub --describe

# Which messages are wedging it? Read at the frozen CURRENT-OFFSET.
kubectl exec -n default <kafka-pod> -c kafka -- env KAFKA_OPTS="" JMX_PORT="" \
  /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:29092 \
  --topic vlab-prod-payment --partition 0 --offset <CURRENT-OFFSET> --max-messages 3
```

> `KAFKA_OPTS=""  JMX_PORT=""` is required — without it the bundled JMX
> Prometheus agent tries to re-bind the exporter port and the CLI dies with
> `java.net.BindException: Address already in use` before it does anything.

The `--describe` output also tells you whether it's one poison message or a
whole provider: a single frozen partition points at one message, both partitions
frozen points at the upstream provider being down.

Fix the timeout budget (above) rather than deleting the messages — the payments
are real, and the topic retains 31 days, so they can be replayed once the
provider recovers.

### "Botserver failed from Kafka error"

Kafka consumer encountered an error. Check:
1. Kafka brokers are running
2. KAFKA_BROKERS environment variable is correct
3. Kafka topic exists
4. Network/firewall allows Kafka connections

## Architecture Notes

### Why provider calls have a hard timeout

`reloadly.NewTopups()` and `reloadly.NewGiftCards()` both return a `Service`
carrying `http.DefaultClient`, which has **no timeout** — a call that never
answers blocks forever. `NewReloadlyProvider` / `NewGiftCardsProvider` therefore
overwrite `svc.Client` with one bounded by `DINERSCLUB_PROVIDER_TIMEOUT`.

The retry budget cannot do this job. `backoff.Retry` consults `MaxElapsedTime`
only *between* attempts, so a single attempt that never returns is unbounded no
matter how small `DINERSCLUB_RETRY_PROVIDER` is. `checkCache`'s `provider.Auth()`
call isn't inside a backoff at all, so before this change it was unbounded too.

On 2026-08-17 that combination took production down: Reloadly stopped answering
during a ~230-payout burst to Nigeria, batches outran the 300s poll interval,
and dinersclub crash-looped on the same two uncommitted messages for ~50 minutes.

**Do not remove these client overrides**, and prefer a bounded client (or a
`context.WithTimeout`, as `http_provider.go` and `dingconnect.go` do) for any new
provider. A provider that can hang does not just fail its own payment — it wedges
the entire consumer.

> **Payment-safety caveat:** a timeout fires without telling you whether the
> topup was actually executed, and the backoff will then retry it. Reloadly
> dedupes on `customIdentifier`, but the topups provider only forwards one when
> the event supplies `custom_identifier` — most events don't — and the giftcards
> provider generates a *fresh* UUID per call, which does not dedupe either.
> Sending a stable, event-derived identifier is open work.

### Why providers are recreated each request

Providers are instantiated fresh for each PaymentEvent to avoid holding stale state. Authentication is cached separately, so repeated calls from the same user don't re-authenticate.

### Why results are sent asynchronously

Results are sent via botparty API after the Job completes. This allows the Kafka message to be processed atomically - if sending fails, the Job itself fails and the message is reprocessed from Kafka.

### Why caching uses concatenated string keys

Cache key is `provider + key + userid` to handle cases where the same user has multiple credentials for the same provider (identified by `key`).

## Future Improvements

Potential enhancements:
1. **Request ID tracking to prevent duplicate payments.** The highest-value item
   here. `CUSTOM_IDENTIFIER_ALREADY_USED` fired 2,385 times on production and
   1,483 of those states also record `success=true` — Reloadly's dedup works,
   and we mostly do not use it. A stable, event-derived `custom_identifier` on
   every payment would make retries safe by construction, which is what the
   payment-safety caveat above is really asking for.
2. **Name the credential in the metrics.** `PaymentWalletEmpty` can say which
   provider is out of money but not whose account, which is the first question
   anyone asks. Weighed against putting researcher identifiers in metric labels.
3. Configurable HTTP timeouts per provider
4. Audit logging of all payment attempts
5. Support for batch payments
6. Async webhook-based confirmation instead of polling

Shipped, kept here so the list is not read as outstanding: provider-specific
error handling (`classify.go`) and metrics/instrumentation (`metrics.go`).

## Related Components

- **botparty**: Client library for sending events to botserver
- **go-reloadly**: Client library for Reloadly API
- **spine**: Kafka consumer abstraction
- **ristretto**: Cache implementation
- **dean**: re-drives payments for respondents dinersclub deliberately left
  parked. The recovery half of this design — see `dean/README.md`
  ("`Payments` and the `repeat_payment` event")

## Related Documentation

- `documentation/payment-recovery.md` — the cross-component picture: who
  retries, who is told, how a silent failure still gets paid
- `documentation/alerting.md` §12 — runbooks for every payment alert
- `planning/payment-failure-handling.md` — the decision and the reasoning
- `planning/external-event-taxonomy.md` — the event contract this anticipates
