# Dean

Dean is a service that monitors the chatbase database and sends events to the botserver for various timeout and retry scenarios.

## Event Shape & Platform Threading

Dean POSTs `ExternalEvent` JSON to botserver's `/synthetic` endpoint:

```json
{ "user": "<userid>", "page": "<pageid>", "platform": "whatsapp", "event": { "type": "...", "value": null } }
```

Every query (`Respondings`, `Errored`, `Blocked`, `Payments`, `Timeouts`, `FollowUps`, `Spammers`)
selects `COALESCE(states.platform, 'messenger')` and threads it into the emitted event.
`states.platform` is a stored computed column over `state_json->'md'->>'platform'`; legacy rows
without `md.platform` are NULL and report `messenger`. Botserver passes unknown fields through to
Kafka untouched, so replybot receives the platform on synthetic events and can route re-entries
(timeouts, follow-ups, repeat payments) to the correct platform instead of defaulting to Messenger.
See `documentation/platform-abstraction.md` ("Account ID Routing").

`FollowUps` joins states to credentials via `pageid = credentials.key` with
`entity IN ('facebook_page', 'whatsapp_business')` — `states.pageid` holds the platform account id,
which equals `credentials.key` for messaging entities (globally unique via the
`unique_messaging_account` partial index).

## Testing

### Running Tests

To run the tests, you need to first start a local test database:

```bash
# From the project root, start the test database on port 5433
cd devops
make test-db PORT=5433
```

Once the database is running, you can run the tests:

```bash
# Run all tests
cd dean
go test -v

# Run specific test(s) by pattern
go test -v -run TestGetTimeouts
go test -v -run TestGetRespondings
```

### Retry caps must be set in test `Config` literals

Several queries gate on a retry cap that is a **required** env var in
production (`DEAN_PAYMENT_MAX_ATTEMPTS`, `DEAN_TIMEOUT_MAX_ATTEMPTS`,
`DEAN_RETRY_MAX_ATTEMPTS`), so the value is never legitimately zero. A test that
builds a `Config` literal and omits the cap gets Go's zero value, turning e.g.
`Payments`' gate into `jsonb_array_length(externalEvents) < 0` — always false,
so the query silently returns **no rows** and the test fails for a reason that
looks nothing like the cap.

When adding a test for `Payments`, `Timeouts`, or `Respondings`, always set the
relevant `*MaxAttempts` field even when the cap is not what you are testing.

### Stopping the Test Database

```bash
docker stop vlab-cockroach
docker rm vlab-cockroach
```

## Configuration

Dean uses environment variables for configuration. Key variables include:

- `DEAN_TIMEOUT_MAX_PAST`: Maximum duration in the past to trigger timeouts (e.g., "24h", "20d"). Timeouts older than this will be ignored.
- `DEAN_TIMEOUT_BLACKLIST`: Comma-separated list of form shortcodes to exclude from timeout processing
- `DEAN_ERROR_INTERVAL`: Retry interval for error states
- `DEAN_BLOCKED_INTERVAL`: Retry interval for blocked states
- `DEAN_RESPONDING_INTERVAL`: Maximum time to wait for responses
- And more...

See `dean.go` Config struct for the complete list of configuration options.
