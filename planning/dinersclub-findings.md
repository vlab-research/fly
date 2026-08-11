# DinersClub Payment Provider System - Investigation Findings

## Executive Summary

DinersClub is a Kafka-based payment processing service that implements a pluggable provider architecture. It consumes payment events from Kafka, validates them, routes them to the appropriate payment provider based on provider type, handles authentication through a cached credential system, and sends results back via botparty API calls to a botserver. The system currently supports four provider implementations: `fake` (testing), `reloadly` (mobile topups), `giftcard` (Reloadly gift cards), and `http` (generic HTTP API).

## Architecture Overview

### Entry Point and Main Loop

**File**: `/home/nandan/Documents/vlab-research/fly/dinersclub/main.go`

The application runs a continuous Kafka consumer loop:
1. Consumes payment events from a Kafka topic (configured via `KAFKA_TOPIC`, `KAFKA_BROKERS`, `KAFKA_GROUP`)
2. Batches messages for parallel processing
3. For each message, creates a `PaymentEvent` struct and calls `dc.Job()`
4. Uses exponential backoff with configurable retry logic
5. Results are sent back to botserver via botparty API

Key components:
- `DC` struct (line 19-25): Main controller holding config, database pool, botparty client, cache, and provider getter function
- `Process()` (line 35-61): Processes batches of Kafka messages using concurrent pool of workers
- `Job()` (line 122-170): Core payment processing logic for individual events
- `getProvider()` (line 190-202): Provider factory function - routes provider selection by name
- `main()` (line 214-237): Sets up config, database, cache, botparty, and starts Kafka consumer

### Core Provider Interface

**File**: `/home/nandan/Documents/vlab-research/fly/dinersclub/provider.go`

```go
type Provider interface {
	GetUserFromPaymentEvent(*PaymentEvent) (*User, error)
	Auth(*User, string) error
	Payout(*PaymentEvent) (*Result, error)
}
```

Every provider must implement three methods:
1. **GetUserFromPaymentEvent**: Extract user from payment event (typically via database lookup using facebook_page_id)
2. **Auth**: Authenticate/authorize the user with credentials (stores secrets in cache for template interpolation)
3. **Payout**: Execute the actual payment and return a result

### Data Structures

**PaymentEvent** (provider.go, line 27-34):
- `userid`: User identifier
- `pageid`: Facebook page identifier (used to look up user)
- `timestamp`: JavaScript timestamp (milliseconds since epoch)
- `provider`: Provider name (required)
- `key`: Optional provider-specific key/credential identifier
- `details`: JSON blob containing provider-specific payment data

**Result** (provider.go, line 46-54):
- `type`: Result type (e.g., "payment:http", "payment:reloadly")
- `id`: Payment ID
- `success`: Boolean success flag
- `timestamp`: When result was created
- `error`: Optional PaymentError
- `payment_details`: Original payment details echoed back
- `response`: JSON response from provider

**PaymentError** (provider.go, line 36-44):
- `message`: Human-readable error message
- `code`: Error code string (e.g., "INVALID_PROVIDER", "AUTH_ERROR", "MISSING_SECRET")
- `payment_details`: Original payment details for context

## Payment Provider Implementations

### 1. FakeProvider

**File**: `/home/nandan/Documents/vlab-research/fly/dinersclub/fake.go`

Purpose: Testing provider that returns pre-configured results.

Implementation details:
- Takes custom `GetUserFromPaymentEvent` and `Auth` functions as constructor parameters for test flexibility
- `Payout()` expects details to contain a `FakeDetails` struct with a pre-built `Result`
- Returns the embedded result with 10ms sleep (simulating network delay)
- Used in tests to verify payment processing flow without external dependencies

Usage pattern:
```json
{
  "result": {
    "type": "foo",
    "success": true
  }
}
```

### 2. ReloadlyProvider

**File**: `/home/nandan/Documents/vlab-research/fly/dinersclub/reloadly.go`

Purpose: Handles mobile topup payments via Reloadly API.

Key features:
- Supports both production and sandbox modes (via `RELOADLY_SANDBOX` config)
- Uses go-reloadly library for API interaction
- **GetUserFromPaymentEvent**: Uses generic user lookup (facebook_page_id → userid)
- **Auth**:
  - Requires a key (fatal if missing)
  - Looks up credentials from database: `SELECT details FROM credentials WHERE entity='reloadly' AND userid=$1 AND key=$2`
  - Credentials JSON structure: `{"id": "reloadly_id", "secret": "reloadly_secret"}`
  - Initializes reloadly service with ID/secret pair
- **Payout**:
  - Unmarshals details into `reloadly.TopupJob` struct
  - Validates job structure
  - Calls reloadly TopupWorker
  - Returns detailed error codes from reloadly API (e.g., PHONE_RECENTLY_RECHARGED, PROVIDER_INTERNAL_ERROR)
  - Sets result.Timestamp from transaction date

Error handling: Distinguishes between reloadly.APIError, reloadly.ReloadlyError, validator.ValidationErrors, and json.SyntaxError.

### 3. GiftCardsProvider

**File**: `/home/nandan/Documents/vlab-research/fly/dinersclub/giftcards.go`

Purpose: Handles gift card purchases via Reloadly gift cards API.

Implementation:
- Extends ReloadlyProvider (embedded composition)
- Uses same database credential lookup but queries `entity='reloadly'` and credential key
- **Payout**:
  - Unmarshals details into `reloadly.GiftCardOrder`
  - Calls `FormatOrder()` helper which generates a random UUID for `CustomIdentifier`
  - Validates order structure
  - Calls reloadly GiftCards().Order() method
  - Returns transaction timestamp from reloadly response

Note: The `FormatOrder()` function always overwrites the CustomIdentifier with a new UUID (lines 27-34), even if one was provided.

### 4. HttpProvider

**File**: `/home/nandan/Documents/vlab-research/fly/dinersclub/http_provider.go`

Purpose: Generic HTTP client that calls arbitrary external payment APIs with templated secrets.

This is the most flexible provider and deserves detailed explanation.

#### Configuration Structure (HttpPaymentDetails)

```go
type HttpPaymentDetails struct {
	ID             string            `json:"id"`              // Payment ID
	Method         string            `json:"method"`          // HTTP method (GET, POST, etc.)
	Url            string            `json:"url"`             // URL with optional secret placeholders
	Body           *json.RawMessage  `json:"body"`            // Request body (string)
	Headers        map[string]string `json:"headers"`         // Request headers with optional placeholders
	ErrorMessage   string            `json:"errorMessage"`    // JSONPath to error message in response
	ResponsePath   string            `json:"responsePath"`    // JSONPath to extract response data
}
```

#### Secret Interpolation

**Interpolate()** (line 72-77):
- Uses mustache templating with `<< >>` delimiters (not standard `{{ }}`)
- Secrets are loaded in `Auth()` from database
- Example: `"url": "https://api.example.com?token=<< api_token >>"`
- Throws error if placeholder references missing secret (MISSING_SECRET error code)

**Auth()** (line 34-60):
- Queries database for all secrets: `SELECT key, details->>'value' FROM credentials WHERE entity='secrets' AND userid=$1`
- Builds map of secret name → secret value for use in interpolation
- Multiple secrets can be stored per user, keyed by the `key` column

#### Request Execution (Payout)

**Payout()** (line 104-193):

1. **Unmarshal and validate**: Parse details JSON and extract ID
2. **Interpolate URL and headers**: Replace all `<< placeholder >>` with secret values
3. **Build request**:
   - Interpolate body if present
   - Create HTTP request with 60-second timeout
   - Add Accept: application/json header
   - Add all interpolated headers
4. **Make request**: Use http.DefaultClient
5. **Parse response**:
   - Check status code (2xx = success)
   - Read response body
   - Extract data from response using JSONPath specified in `ResponsePath` (uses tidwall/gjson)
   - If no path specified, return entire body as JSON
6. **Error handling**:
   - HTTP request errors → HTTP_REQUEST_FAILED
   - Bad request (invalid URL) → BAD_HTTP_REQUEST
   - Missing secrets → MISSING_SECRET
   - Non-2xx status codes: Extract error message from response using `ErrorMessage` JSONPath

#### Key Implementation Details

- **Response handling** (line 172-192):
  - `GetFromJson()` function uses gjson.GetBytes() to extract data at path
  - If path is empty string, returns entire response body
  - Wraps response string in JSON quotes to ensure valid JSON (e.g., `"hello"` becomes `"hello"` in JSON)
  - If extracted value is empty, returns empty JSON string `""`
  - Handles non-JSON responses gracefully (returns empty string)

- **Logging**: Dumps full HTTP request (including headers/body) via httputil.DumpRequestOut for debugging

- **Timeout**: 60-second hard timeout on all HTTP requests

## Provider Registration and Runtime Selection

**In main.go, getProvider() function (line 190-202)**:

```go
func getProvider(pool *pgxpool.Pool, event *PaymentEvent) (Provider, error) {
	switch event.Provider {
	case "fake":
		return NewFakeProvider(getUserFromFakePaymentEvent, auth)
	case "reloadly":
		return NewReloadlyProvider(pool)
	case "giftcard":
		return NewGiftCardsProvider(pool)
	case "http":
		return NewHttpProvider(pool)
	}
	return nil, nil
}
```

Provider selection is based on the `provider` field in the PaymentEvent. The factory returns a new provider instance each time.

**Provider enablement** is controlled by the `DINERSCLUB_PROVIDERS` environment variable (config.go, line 29):
- Comma-separated list of provider names
- In Job() (main.go, line 129), there's a check: `if !contains(dc.cfg.Providers, pe.Provider)`
- If provider not in enabled list, returns INVALID_PROVIDER error
- This prevents instantiation even if getProvider() would normally support it

## Configuration

**File**: `/home/nandan/Documents/vlab-research/fly/dinersclub/config.go`

All configuration is environment variable driven via caarlos0/env library:

### Database Configuration
- `CHATBASE_DATABASE`: PostgreSQL database name
- `CHATBASE_HOST`: PostgreSQL host
- `CHATBASE_PORT`: PostgreSQL port
- `CHATBASE_USER`: PostgreSQL user
- `CHATBASE_MAX_CONNECTIONS`: Connection pool max size

### Kafka Configuration
- `KAFKA_BROKERS`: Comma-separated broker addresses
- `KAFKA_TOPIC`: Topic to consume from (e.g., "vlab-payment")
- `KAFKA_GROUP`: Consumer group name
- `KAFKA_POLL_TIMEOUT`: How long to wait for messages before processing
- `KAFKA_BATCH_SIZE`: Number of messages to batch together
- `DINERSCLUB_BATCH_SIZE`: Alias for KAFKA_BATCH_SIZE (duplicate config)

### Processing Configuration
- `DINERSCLUB_POOL_SIZE`: Maximum concurrent jobs (line 28)
- `DINERSCLUB_PROVIDERS`: Enabled providers (comma-separated)
- `DINERSCLUB_RETRY_PROVIDER`: Max duration to retry provider calls (exponential backoff)
- `DINERSCLUB_RETRY_BOTSERVER`: Max duration to retry botserver calls (exponential backoff)
- `BACK_OFF_RANDOM_FACTOR`: Randomization factor for backoff (default 0.5)

### Caching Configuration
- `CACHE_TTL`: Time-to-live for cached authentication
- `CACHE_NUM_COUNTERS`: Ristretto cache counter capacity
- `CACHE_MAX_COST`: Ristretto cache max cost
- `CACHE_BUFFER_ITEMS`: Ristretto cache buffer items

### Reloadly Configuration
- `RELOADLY_SANDBOX`: Boolean - if true, uses sandbox API

### Server Configuration
- `BOTSERVER_URL`: URL to botserver for sending results

## Caching Strategy

**In main.go, checkCache() (line 105-120)**:

- Provider instances are cached after successful authentication
- Cache key: `provider + key + userid` (line 108)
- TTL: `CACHE_TTL` (default 1 hour in test config)
- Only cache after successful `Auth()` call
- Avoids re-authenticating for repeated payments from same user with same provider+key combination

Cache usage pattern:
1. Get provider instance
2. Check if (provider + key + userid) in cache
3. If not in cache: call `provider.Auth(user, key)`, then cache if successful
4. Use (possibly cached) provider for Payout

## Request Flow

1. **Kafka consumption**: Messages arrive on vlab-payment topic
2. **Parsing**: Unmarshal JSON to PaymentEvent, validate required fields
3. **Provider instantiation**: Call getProvider() to get fresh provider instance
4. **User extraction**: Call provider.GetUserFromPaymentEvent() to look up user in database
5. **Authentication & Caching**: Call provider.Auth() (with cache check), populate provider state
6. **Payout execution**: Call provider.Payout() with exponential backoff retry
7. **Result sending**: Marshal Result to JSON, send via botparty API with exponential backoff retry
8. **Error handling**: At any step, errors are caught and either retried or converted to Result with PaymentError

## Error Handling and Recovery

### Error Codes

| Code | Meaning | Retryable |
|------|---------|-----------|
| INVALID_PROVIDER | Provider not in DINERSCLUB_PROVIDERS list | No (sends result) |
| AUTH_ERROR | provider.Auth() failed | No (sends result) |
| INVALID_JSON_FORMAT | PaymentEvent details malformed | No (sends result) |
| MISSING_SECRET | HTTP provider missing interpolation secret | No (sends result) |
| BAD_HTTP_REQUEST | HTTP provider URL invalid | No (sends result) |
| HTTP_REQUEST_FAILED | HTTP provider network error | Yes (exponential backoff) |
| Other (provider-specific) | Varies by provider (e.g., PHONE_RECENTLY_RECHARGED from Reloadly) | Varies |

### Retry Logic

Two levels of backoff:
1. **Provider retries** (line 164): `backoff.Retry(op, backoffTime(dc.cfg.RetryProvider, ...))`
   - Retries the `provider.Payout()` call
   - Max duration: `DINERSCLUB_RETRY_PROVIDER`
   - Used for transient provider failures

2. **Botserver retries** (line 83): `backoff.Retry(op, backoffTime(dc.cfg.RetryBotserver, ...))`
   - Retries sending result back to botserver
   - Max duration: `DINERSCLUB_RETRY_BOTSERVER`
   - If botserver unreachable, the Job() itself fails and triggers Kafka reprocessing

### Failure Modes

**Non-retryable failures** (result sent to botserver):
- Provider instantiation fails (returns nil)
- User not found in database
- Auth fails
- JSON parsing errors in provider details

**Retryable failures** (triggers exponential backoff):
- Provider.Payout() returns transient error
- Botserver is unreachable

**Hard failures** (Job fails, Kafka offsets don't commit):
- Message JSON is malformed
- Required PaymentEvent fields missing
- User lookup database error
- Botserver permanently unavailable after max retries

## Testing Coverage

**File**: `/home/nandan/Documents/vlab-research/fly/dinersclub/*_test.go`

### Test Organization

Tests are split by component:
- **provider_test.go**: Tests for `handleJSONUnmarshalError()` helper function
- **fake_test.go**: FakeProvider tests (JSON parsing, valid data)
- **http_provider_test.go**: HttpProvider tests (16 tests covering 95% of functionality)
- **reloadly_test.go**: ReloadlyProvider tests (error handling, credential lookup, auth)
- **giftcards_test.go**: GiftCardsProvider tests (UUID generation, error handling)
- **dinersclub_test.go**: Integration tests with Kafka and botserver mocking

### Key Test Scenarios

**HTTP Provider (16 tests)**:
1. Secret interpolation with mustache templates
2. GET and POST requests with/without body
3. Response path extraction (nested JSON, arrays)
4. Error message extraction from responses
5. Missing secret error handling
6. Non-JSON responses
7. Status code handling (2xx success, 4xx/5xx errors)

**Reloadly Provider**:
1. Bad payment details JSON
2. API errors with error codes
3. Successful topup result
4. Missing user
5. Missing credentials
6. Missing key requirement
7. Key-based credential lookup

**GiftCards Provider**:
1. Bad order JSON
2. API errors
3. UUID generation for CustomIdentifier
4. Success response with transaction timestamp

**DinersClub Integration**:
1. Successful fake provider payment
2. Invalid provider name
3. Malformed message JSON
4. Missing required fields
5. Non-existent provider in config
6. Missing user
7. Auth errors
8. Cache hits/misses (verified via cache metrics)
9. Botserver unavailability (retry behavior)
10. JSON unmarshal error handling

### Test Infrastructure

**test_helpers.go**:
- `TestClient()`: Creates mock HTTP client with custom response
- `makeMessages()`: Helper to create Kafka messages from JSON strings
- `mustExec()`: Helper for test database setup
- `before()`: Cleans up test database tables (users, credentials)
- `TestTransport`: Custom http.RoundTripper for mocking

### Database Setup for Tests

Tests that need database access:
1. Create test user with UUID `00000000-0000-0000-0000-000000000000`
2. Insert facebook_page credentials entry with entity='facebook_page'
3. Insert provider credentials (reloadly, secrets, etc.)
4. Clean up tables after test with `before()` call

## Undocumented Implementation Details

### JSTimestamp Custom Type (provider.go, line 13-23)

PaymentEvent uses custom JSTimestamp for the timestamp field:
- Unmarshals from milliseconds (JavaScript epoch)
- Converts to microseconds (Go epoch)
- Stores as time.Time in UTC

```go
type JSTimestamp time.Time
func (t *JSTimestamp) UnmarshalJSON(b []byte) error {
	var i int64
	json.Unmarshal(b, &i)
	*t = JSTimestamp(time.Unix(0, i*1000000).UTC())
	return nil
}
```

### Concurrent Processing

**chancequity.Pool()** (line 51, main.go):
- Executes Work() function concurrently on batched tasks
- Pool size controlled by `DINERSCLUB_POOL_SIZE`
- All workers must complete before batch processing returns

### Provider State

Providers are stateless except for:
- HttpProvider: Holds secrets map after Auth()
- ReloadlyProvider: Holds initialized reloadly.Service

This means providers can be reused after Auth() for multiple Payout() calls.

## Database Schema Dependencies

The system expects these tables/columns to exist:

### users table
- id (uuid/string): User identifier

### credentials table
- userid: Foreign key to users
- entity: Type of credential (e.g., 'facebook_page', 'reloadly', 'secrets')
- key: Optional identifier within entity type
- details: JSON blob containing credential data
- For facebook_page entity: Query finds page ID from details JSON
- For reloadly/giftcard entity: Stores `{"id": "...", "secret": "..."}`
- For secrets entity: Stores `{"value": "..."}`

Query patterns used:
1. Get user from page: `SELECT userid FROM credentials WHERE facebook_page_id=$1`
2. Get credentials by entity+key: `SELECT details FROM credentials WHERE entity=? AND userid=? AND key=?`
3. Get secrets: `SELECT key, details->>'value' FROM credentials WHERE entity='secrets' AND userid=?`

## Known Issues and TODOs

From code comments:

1. **provider.go line 25-26**: Missing payment ID tracking - system doesn't track payment ID for deduplication
2. **main.go line 86-88**: Result doesn't provide ID from PaymentEvent, causing system to wait forever for external event that never comes
3. **main.go line 226**: TODO about maximum poll interval for long retries
4. **reloadly.go line 33-50**: TODO about catching 500 errors and special retry error codes (PHONE_RECENTLY_RECHARGED, etc.)
5. **http_provider.go line 143**: Context timeout created but never canceled (resource leak, though minor in practice)
6. **http_provider.go line 160**: TODO about retrying transient HTTP errors instead of failing immediately

## Architecture Strengths

1. **Pluggable provider system**: Easy to add new payment methods
2. **Generic HTTP provider**: Handles diverse external APIs without code changes
3. **Template-based secrets**: Flexible credential handling for different auth schemes
4. **Caching**: Reduces authentication round-trips
5. **Graceful error handling**: Converts various error types into standardized PaymentError codes
6. **Retry logic**: Exponential backoff with randomization for resilience
7. **Test coverage**: Comprehensive unit and integration tests

## Architecture Concerns

1. **Provider state management**: Providers are created fresh for each event, then cached after Auth - inconsistent lifecycle
2. **Error deduplication**: No request ID tracking could cause duplicate payment attempts if botserver doesn't receive result
3. **Hard-coded timeout**: 60-second HTTP timeout isn't configurable
4. **Cache key collision risk**: Using concatenated strings (provider + key + userid) could theoretically collide
5. **Parallel processing of batches**: If one worker fails, whole batch fails (no partial completion)
6. **Secret storage**: Secrets stored as plaintext in database (encrypted at rest would be better)
7. **No audit logging**: Who made what payment when not tracked
