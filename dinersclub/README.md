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

**Result**: Response POSTed to hermes' `/synthetic` endpoint indicating success or failure.

```jsonc
{
  "user":       "<pe.Userid>",
  "account_id": "<pe.Pageid>",     // the platform account id
  "platform":   "<pe.Platform>",   // "messenger" | "whatsapp"
  "event":      { "type": "external", "value": { /* the Result below */ } }
}
```

All three of `user`, `account_id` and `platform` are **required** by the event envelope
contract (`documentation/event-envelope.md`) — a payment result that cannot be attributed to
a conversation cannot be shown to the participant, and the conversation waits forever for an
external event that never resolves. Hermes rejects an incomplete POST with 400 once
`SYNTHETIC_REQUIRE_CONVERSATION` is enabled. The request carries `X-Vlab-Poster: dinersclub`
so hermes can name dinersclub in a rejection log.

`platform` comes straight from the consumed `PaymentEvent`, which replybot populates from the
conversation's persisted `md.platform`.

**Not botparty.** `dinersclub/synthetic.go` declares a local `SyntheticEvent` struct and a
local `Poster`, because `botparty.ExternalEvent` lives in a separate repo and has no
`Platform` field — publishing and bumping it across two services to add one field is more
coupling than the field is worth, and hermes passes unknown fields through untouched. `dean`
established this pattern. The non-200 error text is preserved verbatim from `botparty.Send`
(`"Non 200 response from Botserver: %v"`) because tests and log greps depend on it.

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
| `dingconnect.go` | DingConnect provider. A **thin adapter**: unmarshal vlab's payment block, call `go-dingconnect`, map the outcome onto `Result` and metrics |
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
- **Bounded by `DINERSCLUB_PROVIDER_TIMEOUT`**: like every other provider except
  DingConnect. This used to read "60-second timeout", which was true of the code
  and wrong about the system: 60s is four times the configured ceiling and equal
  to the whole of `DINERSCLUB_RETRY_PROVIDER`, so one hung call could eat the
  entire retry budget and the documented worst case was not achievable. Fixed
  with VIR-44

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

#### Configuring a payment: declare the intent, pin the resolution

A DingConnect `sku_code` identifies **one operator's** product, and its
`send_value` is a USD amount whose delivered value differs per operator because
commission rates differ. All three of these deliver ARS 1,000:

| Operator | SKU | send_value |
|---|---|---|
| Claro | `CLAR5046` | $0.79 |
| Movistar | `TFAR58291` | $0.85 |
| Personal | `PRAR13725` | $0.93 |

So a bare `send_value` is an uninterpretable magic number: nothing records what
it was *for*, which means nothing can check it. **If a commission rate moves,
$0.79 is still a valid send value — the transfer completes, the result says
success, and the respondent silently receives ARS 800.** Declaring the intent is
what makes the pinned number verifiable; that is the entire reason both exist.

```json
{
  "id": "p1",
  "account_number": "{{field:phone|e164}}",
  "distributor_ref": "ar_{{field:phone|e164}}_p1",

  "amount": 1000,
  "amount_currency": "ARS",
  "tolerance": 200,

  "operators": {
    "CLAR": {"sku_code": "CLAR5046",  "send_value": 0.79},
    "TFAR": {"sku_code": "TFAR58291", "send_value": 0.85},
    "PRAR": {"sku_code": "PRAR13725", "send_value": 0.93}
  }
}
```

| field | meaning |
|---|---|
| `amount` | **Minimum delivered** — a floor on `Price.ReceiveValue`, not on spend |
| `amount_currency` | **Required**, and validated against the product's `ReceiveCurrencyIso` |
| `tolerance` | Headroom **on the delivered amount**, matching Reloadly's `TopupJob.Tolerance`. **Optional, defaults to `0`** — see the warning below |
| `operators` | Optional pin, keyed by operator code (case-insensitive). Looked up, not iterated |
| `operator` | Optional; names the operator directly and skips detection |
| `on_drift` | Optional, `"fail"` (the default and only implemented value) |
| `account_number`, `distributor_ref` | Required on every path |
| `send_currency_iso`, `id`, `settings` | Optional, unchanged |

**The window is on delivered value, not spend.** A study cares that every
respondent receives the same incentive, not that every payment costs the same.

**`amount_currency` is never inferred from the country.** DingConnect's receive
currency is not always local (`2ANG44349` receives USD), so inferring it would
let a catalogue change deliver 1,000 of the wrong unit while reporting success.

**Order is deliberately not expressible in `operators`.** A phone number belongs
to exactly one operator, so there is nothing to arbitrate — the map is a lookup
table, and `AccountLookup` returning several items is a data quirk, not a choice.

> ### ⚠️ `tolerance` defaults to zero, and zero means exact match
>
> Omitting `tolerance` makes the window `[amount, amount]` — the delivered value
> must equal `amount` **exactly**. That is rarely what an author means, and it
> is fragile in a way that is easy to miss:
>
> **Some currencies round the delivered value down to a whole unit.** In
> Bolivia, receive values round down to whole bolivianos. A pin sitting on a
> rounding boundary can therefore flip to `PinOutOfWindow` and **hard-fail the
> payment on a rounding artefact rather than a real commission change** — and
> the failure is permanent, so the respondent is told their payment failed.
>
> dinersclub logs a loud warning for any payment declaring `tolerance: 0` and
> pays anyway. **It does not invent a non-zero default**, deliberately: widening
> a window the researcher never declared would pay an amount they never asked
> for, which is exactly the automagic this design exists to remove. Set a
> tolerance that covers at least one rounding step unless an exact match is
> genuinely intended.

#### How a payment resolves

1. **Operator known** (from `operator`, or from `AccountLookup`) **and pinned** →
   verify the pin against the intent, send once. This is the common path and it
   costs **one POST**.
2. **Operator known, `operators` present, no entry for it** → fails naming both
   the detected operator and the ones you pinned (`NO_PIN_FOR_OPERATOR`).
3. **Operator known, no `operators` map** → resolve from the catalogue: the
   cheapest `SendValue` whose delivered value lands in
   `[amount, amount + tolerance]`. A fixed SKU qualifies only if its single value
   lands in the window; a range SKU is solved for and clamped to its bounds.
4. **Detection inconclusive** (lookup failed, returned nothing, or returned
   several operators) **and pins present** → *discovery*: try the pinned
   candidates until one accepts the number. Exactly one of them is the number's
   operator; sending is what settles it.
5. **Detection inconclusive and no pins** → `COULD_NOT_AUTO_DETECT_OPERATOR`.

Nothing that satisfies the window → `IMPOSSIBLE_AMOUNT`, naming the window and
what was available. **The delivered amount is never outside the window.**

#### Drift

**A contract violation:** the pinned SKU no longer exists, or its delivered value
at the pinned `send_value` no longer falls inside the window. Either is a hard,
loud failure that increments `dinersclub_dingconnect_pin_drift_total`, and **no
money moves** — drift is caught before the send.

**Not drift:** a pin that still satisfies the window but is no longer the
cheapest option. It is honoured silently. A pin overridden over pennies is not a
pin, and payments would become nondeterministic for no benefit.

`on_drift: "resolve"` — re-resolving to a different SKU instead of failing — is
**deliberately not implemented**. It is machinery for a case we expect to be
rare, and it reintroduces the "did something silently change my incentive?" risk
the rest of this design removes. Deferring is safe because it is purely
additive: `on_drift` already defaults to `"fail"`, so adding it later needs no
migration.

#### Cascade contract (the discovery path)

| Outcome | Behaviour |
|---|---|
| Success | Return immediately |
| `RechargeNotAllowed` | Wrong operator for this number — try the next candidate |
| `AccountNumberInvalid` | The number itself is bad — stop; no other SKU will help |
| `RateLimited` | **Stop. Never retried, never advanced past** — may be a per-account fraud rule |
| Transport fault / timeout | Stop. We do not know whether money moved; advancing risks paying twice |
| Unrecognised code | Stop and surface it |
| All candidates exhausted | Return the **last real failure**, never a synthetic code |

**Advance is an allow-list and stop is the default**, in `cascadeDecide`
(`dingconnect_resolve.go`). That is what makes a newly-introduced DingConnect
code unable to cause a send nobody designed. A stop code **anywhere** in the
`ErrorCodes` array wins — `Codes[0]` is never read, because DingConnect can
return `RateLimited` alongside `RechargeNotAllowed`.

`RechargeNotAllowed` is documented against "product/send amount", not explicitly
against operator mismatch. **It is unconfirmed** as the wrong-operator signal.
Because it is only the *advance* signal, being wrong about it degrades discovery
into a single attempt rather than sending money anywhere it should not go.

#### `distributor_ref`

Every **single-send** path (explicit SKU, verified pin, catalogue resolution)
uses the authored `distributor_ref` unchanged. Only **discovery** derives a
per-candidate `<ref>_<sku_code>`, so candidate 2 is not rejected as a duplicate
of candidate 1.

Derivation is deterministic and keyed on the **path, not the candidate count**,
so a payment already parked in production keeps the exact reference it was first
submitted under when dean re-drives it. A derived ref longer than 64 characters
is rejected up front rather than truncated — a mangled ref is unsearchable in
DingConnect's own transfer records.

#### Catalogue cache

Pin verification is a **local lookup**, not a round trip: `go-dingconnect` caches
the product catalogue for 6 hours per client. Because `Auth` builds one client
per researcher credential, that cache is scoped to a single DingConnect account
— commission rates are a property of the distributor account, so sharing a
catalogue across accounts would price one researcher's payment with another's
rates. Effective lifetime is the shorter of the library's TTL and how long
`main.go`'s auth cache keeps the provider alive.

#### Where this logic lives

**Amount resolution is `go-dingconnect`'s, not dinersclub's** (v0.3.0+,
`payment.go`). Operator detection, catalogue fetch and caching, amount selection,
pin verification, the advance/stop cascade and `DistributorRef` derivation are
all library behaviour, and their tests live there.

That split is the rule stated at the top of `dingconnect.go` and in the
library's own `CLAUDE.md`: *all wire-format knowledge and error-code semantics
belong in the client*. It was briefly broken — an earlier version of this work
put the whole cascade here — and moved.

| `go-dingconnect` | `dinersclub` |
|---|---|
| operator detection, catalogue fetch + cache | unmarshalling the snake_case payment block |
| amount selection, pin verification | `Auth` and Generic Secrets |
| the advance/stop cascade policy | mapping outcomes onto `Result`/`PaymentError` |
| `DistributorRef` derivation | `classify.go` recovery classes, Prometheus metrics |

`resolutionReasonToCode` in `dingconnect.go` **is** that boundary: the library
reports a `ResolutionReason` in its own vocabulary and owns no metrics registry;
dinersclub decides what each one means for a respondent and what to count. A
reason added upstream arrives here unmapped and is logged loudly rather than
silently renamed.

**Features**:
- **Instant mode only**: Synchronous processing - transfers are completed within 90 seconds
- **Per-user API key**: Credentials stored in database per user and key (matching Reloadly pattern)
- **90-second timeout for the WHOLE resolution**: lookup, catalogue fetch and every send share one deadline, so a discovery cascade costs no more wall clock than a single payment. See "Why provider calls have a hard timeout"
- **Error code passthrough**: Returns DingConnect error codes directly

**Error codes**: DingConnect's own codes are passed through **verbatim**, in
PascalCase, exactly as `go-dingconnect/errors.go` defines them — the code that
reaches the respondent's `md.e_payment_dingconnect_error_code` is
`AccountNumberInvalid`, not a normalised name.

| code | meaning |
|---|---|
| `InsufficientBalance` | The researcher's DingConnect wallet is empty |
| `AccountNumberInvalid` | The number is not a valid account for this product |
| `RechargeNotAllowed` | The product cannot top this number up (usually the wrong operator) |
| `RateLimited` | Throttled, **or** a per-account fraud rule was breached |
| `DuplicateTransactionPrevented` | This `distributor_ref` was already used — the idempotency guard working |
| `AuthenticationFailed` | The API key is wrong or revoked |
| `TransientProviderError`, `ProviderError` | Operator-side failure |

> **An earlier version of this section listed six SCREAMING_SNAKE codes
> (`INSUFFICIENT_BALANCE`, `INVALID_ACCOUNT_NUMBER`, `INVALID_SKU_CODE`,
> `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMED_OUT`, `DUPLICATE_REFERENCE`) that this
> provider has never emitted.** They were invented, and `classify.go` still
> carries rows for five of them that are therefore unreachable — which means
> DingConnect's real codes fall to the unknown-code default. Tracked as a
> companion ticket **VIR-41**; `RateLimited` is the one row already fixed here,
> because the never-retry guarantee depends on it.

#### What a survey can branch on

A failed payment carries **two independent signals**, and they answer different
questions. Do not conflate them:

| key | means |
|---|---|
| `e_payment_dingconnect_error_code` | **DingConnect refused**, or a transfer failed |
| `e_payment_dingconnect_resolution_reason` | **we refused to send**, and no money moved |

"We would not pay you because our configuration is out of date" is a different
thing to tell a respondent than "your operator declined the top-up". They are
separate fields so a survey author never has to memorise which string came from
which side of the wire.

`resolution_reason` carries the `go-dingconnect` value **verbatim**. The full
value space:

| `resolution_reason` | meaning | maps to `error_code` |
|---|---|---|
| `PinSkuMissing` | the pinned `sku_code` is gone from the catalogue | `PIN_DRIFT` |
| `PinOutOfWindow` | the pin no longer delivers inside the window | `PIN_DRIFT` |
| `CurrencyMismatch` | the product's `ReceiveCurrencyIso` is not `amount_currency` | `AMOUNT_CURRENCY_MISMATCH` |
| `NoPinForOperator` | an operator was detected but is not in `operators` | `NO_PIN_FOR_OPERATOR` |
| `OperatorNotDetermined` | no operator resolved and nothing pinned to try | `COULD_NOT_AUTO_DETECT_OPERATOR` |
| `ImpossibleAmount` | nothing in the catalogue delivers inside the window | `IMPOSSIBLE_AMOUNT` |
| `InvalidRequest` | the payment block itself is not coherent | `INVALID_PAYMENT_DETAILS` |

**Every one of these means no money moved.** A respondent seeing any of them was
not paid and was not partially paid.

The rest of the resolution block is available too:
`e_payment_dingconnect_resolution_{path,operator,country,sku_code,send_value,expected_delivered,delivered,currency}`.

**`expected_delivered` vs `delivered`** is worth branching on or auditing:
`expected_delivered` is what the catalogue predicted, `delivered` is what the
transfer actually reported. A gap between them means a payment **succeeded**
while paying an amount the catalogue did not predict — the exact failure the
declared-intent design exists to catch. It is also counted by
`dinersclub_dingconnect_delivered_out_of_window_total`, but it lives on the
payment record so a researcher can see it per respondent rather than only in
aggregate.

Codes produced by resolution itself, before any transfer is sent:

| code | meaning |
|---|---|
| `PIN_DRIFT` | The pinned SKU is gone, or no longer delivers in-window |
| `AMOUNT_CURRENCY_MISMATCH` | The product's `ReceiveCurrencyIso` is not `amount_currency` |
| `NO_PIN_FOR_OPERATOR` | An operator was detected but the block pins no entry for it |
| `IMPOSSIBLE_AMOUNT` | Nothing in the catalogue delivers inside the window |
| `COULD_NOT_AUTO_DETECT_OPERATOR` | No operator resolved and nothing pinned to try |

**Explicit SKU (the escape hatch)**: `sku_code` + `send_value` still works
exactly as before and is sent as authored, with no intent to verify against.
Mutually exclusive with `amount`/`operators` — supplying both is rejected,
because there is no honest precedence rule between them and it is what "I tried
to share one `send_value` across several operators" looks like in JSON.

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
| DINERSCLUB_BREAKER_THRESHOLD | 3 | No | Consecutive failures to **reach** a target before we stop calling it. See "The circuit breaker" |
| DINERSCLUB_BREAKER_COOLDOWN | 5m | No | How long a target's circuit stays open |
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

### The circuit breaker

The budget above bounds **one** payment. It does not stop the next payment
paying the same cost, which is a different failure and the one that actually
took production down.

On 2026-09-05 00:01-00:12 UTC dinersclub consumed nothing for 11 minutes
(VIR-44). An endpoint belonging to one study was dropping SYNs, so every payment
to it ran to its deadline before failing — and with `POOL_SIZE == BATCH_SIZE ==
2`, two such payments *are* the entire throughput of the service. Payments for
every other study queued behind a host that was never going to answer. Bounding
the call caps each failure; it does not stop them arriving back to back.

`breaker.go` keeps a per-target circuit. After `DINERSCLUB_BREAKER_THRESHOLD`
consecutive failures to reach a target it opens for
`DINERSCLUB_BREAKER_COOLDOWN`, and payments to that target are skipped at a cost
of roughly nothing.

**The target, not the provider.** The key is `provider|host`, where the host
comes from the optional `TargetHost` interface. Only the HTTP provider
implements it, because only it points somewhere different per study; reloadly,
giftcard and dingconnect each talk to one fixed host for everyone, so the
provider name alone is already the right granularity for them.

**Only a failure to reach the target counts** (`transportFailed`): a system
fault with no verdict at all, or `HTTP_REQUEST_FAILED`. A decline — an empty
wallet, a bad number, an operator refusal, any 4xx or 5xx — is proof the host is
alive and answering, and it *resets* the circuit. This is the line to be careful
about: counting declines would open the circuit on a healthy provider and stop
paying people for a reason that has nothing to do with reachability.
`INSUFFICIENT_BALANCE` alone is 34% of all recorded payment failures.

**A skipped payment is withheld, never failed.** It becomes a `CIRCUIT_OPEN`
Result, which `classify.go` maps to `transient`, which `deliver` withholds — so
the respondent stays parked in `WAIT_EXTERNAL_EVENT` exactly as if the call had
been made and had timed out, and dean re-drives them for up to 14 days. The
breaker never costs anyone their payment; it defers it to the layer built to
outlast an outage. If `CIRCUIT_OPEN` is ever reclassified as `permanent`, the
throughput protection silently becomes a payment outage.

**Where it is checked matters.** `Job` consults the breaker *before* `payout`,
not inside it. A circuit-open signal raised inside `payout` would be a transient
result, and `payout` wraps transient results in `backoff.Retry` — so the message
would sleep its way through the whole `RETRY_PROVIDER` budget making no calls at
all, replacing a slow failure with an equally slow one.

State is in-memory and per-process, which is sufficient at `replicaCount: 1` and
is a performance hint rather than a correctness invariant: losing it on restart
costs one extra round of `THRESHOLD` slow failures and nothing else.

`dinersclub_circuit_breaker_trips_total` and `_skips_total` are the
accountability, in the same way `dinersclub_payment_results_total` is the
accountability for a withheld failure — a skipped payment writes nothing to the
respondent's state either. Rising skips with flat trips is one endpoint down for
a long time; the reverse is a flapping one.

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
| `dinersclub_dingconnect_pin_drift_total` | `reason` | a pinned SKU stopped satisfying its declared amount; the pin needs re-researching |
| `dinersclub_dingconnect_delivered_out_of_window_total` | — | a transfer COMPLETED but paid an amount the catalogue did not predict |
| `dinersclub_up` | — | is anyone scraping this at all |

The last two are the DingConnect amount contract. `pin_drift` should be near
zero — the design assumes SKUs and commission rates move a few times a year, and
that is what makes hard-failing on drift affordable. If it fires regularly the
assumption was wrong, and the answer is `on_drift: "resolve"`, not a wider
tolerance. `delivered_out_of_window` should be **exactly** zero: it fires only
after money has moved, so it cannot fail the payment, and it is the sole true
detector of a respondent silently receiving the wrong incentive.

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

- **hermes**: Ingester that receives payment results at `POST /synthetic`. Posted via the
  local `Poster` in `synthetic.go`, **not** via botparty — see *Result* above and
  `documentation/event-envelope.md`.
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
