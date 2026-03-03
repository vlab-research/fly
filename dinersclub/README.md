# DinersClub - Payment Provider Platform

DinersClub is a Kafka-based payment processing service that executes payment transactions through pluggable payment providers. It consumes payment events from Kafka, routes them to the appropriate provider, executes the payment, and sends results back to the botserver.

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
export DINERSCLUB_RETRY_PROVIDER=2m
export DINERSCLUB_RETRY_BOTSERVER=2m
export BACK_OFF_RANDOM_FACTOR=0.5

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

**Result**: Response sent to botserver indicating success or failure.

```json
{
  "type": "payment:http",
  "id": "payment-789",
  "success": true,
  "timestamp": "2024-01-15T10:30:00Z",
  "payment_details": {...},
  "response": {...}
}
```

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
    ↓
Marshal result to JSON
    ↓
Send to botserver with exponential backoff retry
```

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
| DINERSCLUB_RETRY_PROVIDER | - | Yes | Max duration to retry provider calls with exponential backoff |
| DINERSCLUB_RETRY_BOTSERVER | - | Yes | Max duration to retry botserver calls with exponential backoff |
| BACK_OFF_RANDOM_FACTOR | 0.5 | No | Randomization factor for backoff (0.0 to 1.0) |

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

### Result Error Codes

| Code | Meaning | Retryable | Next Step |
|------|---------|-----------|-----------|
| INVALID_PROVIDER | Provider not in DINERSCLUB_PROVIDERS list | No | Check provider name and configuration |
| AUTH_ERROR | Provider authentication failed | No | Check credentials in database |
| INVALID_JSON_FORMAT | Payment details JSON malformed | No | Check JSON format of details |
| MISSING_SECRET | HTTP provider missing interpolation secret | No | Add secret to credentials table |
| BAD_HTTP_REQUEST | HTTP provider request invalid | No | Check URL and headers |
| HTTP_REQUEST_FAILED | HTTP provider network error | Yes (auto) | Check network/API availability |
| HTTP 4xx/5xx codes | API returned error | No | Check API response/logs |

### Failure Modes

**Hard Failures** (message causes Job to fail, Kafka offset doesn't commit):
- Malformed message JSON
- Missing required PaymentEvent fields
- Database connectivity error
- Botserver unreachable after max retries

**Soft Failures** (result sent to botserver, message consumed):
- Provider not found or not enabled
- User not found in database
- Authentication failure
- Provider-specific errors (captured in Result.Error)

**Transient Failures** (automatic exponential backoff retry):
- provider.Payout() returns error
- Botserver temporarily unavailable

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

### "Botserver failed from Kafka error"

Kafka consumer encountered an error. Check:
1. Kafka brokers are running
2. KAFKA_BROKERS environment variable is correct
3. Kafka topic exists
4. Network/firewall allows Kafka connections

## Architecture Notes

### Why providers are recreated each request

Providers are instantiated fresh for each PaymentEvent to avoid holding stale state. Authentication is cached separately, so repeated calls from the same user don't re-authenticate.

### Why results are sent asynchronously

Results are sent via botparty API after the Job completes. This allows the Kafka message to be processed atomically - if sending fails, the Job itself fails and the message is reprocessed from Kafka.

### Why caching uses concatenated string keys

Cache key is `provider + key + userid` to handle cases where the same user has multiple credentials for the same provider (identified by `key`).

## Future Improvements

Potential enhancements:
1. Request ID tracking to prevent duplicate payments
2. Configurable HTTP timeouts per provider
3. Audit logging of all payment attempts
4. Provider-specific error retry strategies
5. Metrics/instrumentation for monitoring
6. Support for batch payments
7. Async webhook-based confirmation instead of polling

## Related Components

- **botparty**: Client library for sending events to botserver
- **go-reloadly**: Client library for Reloadly API
- **spine**: Kafka consumer abstraction
- **ristretto**: Cache implementation
