# Dean

Dean is a service that monitors the chatbase database and sends events to the botserver for various timeout and retry scenarios.

## Event Shape & Platform Threading

Dean POSTs `ExternalEvent` JSON to hermes' `/synthetic` endpoint:

```json
{ "user": "<userid>", "account_id": "<account_id>", "platform": "whatsapp", "event": { "type": "...", "value": null } }
```

All three of `user`, `account_id` and `platform` are **required** — a synthetic event
without them cannot be attributed to a conversation, and hermes rejects an incomplete POST
with 400 once `SYNTHETIC_REQUIRE_CONVERSATION` is enabled. `documentation/event-envelope.md`
is the contract; dean is one of six posters bound by it.

The request carries `X-Vlab-Poster: dean` so hermes can name dean in a rejection log.

**The field is `account_id`, not `page`.** It was renamed to match the rest of the system
(`media_handle`, `message_templates`, migration 22); hermes still accepts `page` as a
deprecated alias for posters that have not migrated. The value is unchanged — it is
`states.pageid`, which holds the platform account id.

Every query (`Respondings`, `Errored`, `Blocked`, `Payments`, `Timeouts`, `FollowUps`, `Spammers`)
selects `COALESCE(states.platform, 'messenger')` and threads it into the emitted event.
`states.platform` is a stored computed column over `state_json->'md'->>'platform'`; legacy rows
without `md.platform` are NULL and report `messenger` — exact for every conversation predating
WhatsApp support, and the reason `platform` is never empty on a dean event. Replybot receives
the platform on synthetic events and routes re-entries (timeouts, follow-ups, repeat payments)
to the correct platform instead of defaulting to Messenger.
See `documentation/event-envelope.md` and `documentation/platform-abstraction.md`
("Account ID Routing").

`FollowUps` joins states to credentials via `pageid = credentials.key` with
`entity IN ('facebook_page', 'whatsapp_business')` — `states.pageid` holds the platform account id,
which equals `credentials.key` for messaging entities (globally unique via the
`unique_messaging_account` partial index).

## `Respondings` and the `redo` event

`Respondings` (`queries.go:108`) selects users sitting in `current_state = 'RESPONDING'`
and emits a `redo`. The intent is rescue: `RESPONDING` is meant to be transient — the state a
user occupies between replybot sending a message and the platform echoing it back — so a user
still there after the grace period probably had a send die mid-flight.

Replybot's `REDO` handler (`replybot/lib/typewheels/machine.js:366`) no-ops for `QOUT` and
`END`, and otherwise replays `state.previousOutput` as `RESPOND_AGAIN`, appending the event
timestamp to `state.retries`.

Two consequences worth knowing before changing anything here:

- **`retries` counts dean redo attempts, not send attempts.** `RESPOND` clears the array (the
  user answered, episode over); `RESPOND_AGAIN` preserves it deliberately.
- **A redo re-sends a real message.** If the original send actually succeeded and only the echo
  was lost, the user receives a duplicate. Dean cannot currently tell those two cases apart.

Because `RESPOND_AGAIN` puts the user back into `RESPONDING`, a user who can never produce an
echo is re-selected on every sweep. With the production schedule (`*/30 * * * *`) and
`DEAN_RESPONDING_GRACE` of 20 minutes, that is a message every 30–60 minutes until a send fails
and the user is marked `BLOCKED` — which is what finally removes them from the predicate.
`DEAN_RETRY_MAX_ATTEMPTS` (60 in production) is high enough that it is not normally what stops
the loop. See "The RESPONDING/Echo Trap" in `documentation/states-debugging.md`.

## `Payments` and the `repeat_payment` event

`Payments` (`queries.go:151`) selects respondents parked in a **payment** wait
past `DEAN_PAYMENT_GRACE` and emits `repeat_payment`, which replybot turns into
`MAKE_PAYMENT` — re-emitting the payment onto `vlab-<env>-payment`.

This is the system's real payment-retry engine. dinersclub only absorbs a
short blip; anything longer is deferred here (prod: grace `2 hours`, every 6h,
up to `14 days` / 30 attempts). See `planning/payment-failure-handling.md`.

### It selects payment waits *positively*

A payment wait looks like this — note `type` is `external`, and it is
`value.type` that makes it a payment:

```json
"wait": {"type": "external", "value": {"type": "payment:reloadly", "id": "PAYMENT_ID"}}
```

The predicate must be `wait->>'type' = 'external' AND wait->'value'->>'type'
LIKE 'payment:%'`. It previously read `wait->>'type' != 'timeout'`, which is a
different set: `external` waits are just as often `moviehouse:play`,
`linksniffer:click` or `handover`. Dean was firing `repeat_payment` at all of
them, driving `MAKE_PAYMENT` against questions carrying no payment config — 199
of the 200 states it selected in the live retry window were **not** payments.

Composite waits (`wait->'op'` / `'vars'`) have a NULL `wait->>'type'` and are
excluded by NULL comparison semantics. That was true before the fix and is kept
deliberately: including them would newly fire payments at ~4k states.

### The retry cap counts payment RESULTS, not Dean's own attempts

`Timeouts` caps retries by counting the `timeout` events Dean itself emitted for
this wait. **`Payments` cannot do the same**, and this is the trap to know
before touching the gate:

> replybot handles `REPEAT_PAYMENT` as `MAKE_PAYMENT` with **no state update**
> (`machine.js` — `REPEAT_PAYMENT` → `MAKE_PAYMENT`). Unlike `timeout`, it never
> goes through `_handleExternalEvent`, so a `repeat_payment` is **never recorded
> in `externalEvents`**. Counting `repeat_payment` there would always yield 0 and
> silently delete the retry cap.

So the gate counts **payment results that came back for this wait and failed to
resolve it**:

```sql
e->'event'->>'type' = 'external'
AND e->'event'->'value'->>'type' LIKE 'payment:%'
AND (e->>'timestamp')::NUMERIC >= (state_json->>'waitStart')::NUMERIC
```

A result carrying the awaited id fulfills the wait and the row leaves the
predicate entirely, so anything counted here is a genuinely stuck retry — e.g.
the `INVALID_PROVIDER` result that omits the id (the TODO on
`invalidProviderResult` in `dinersclub/main.go`). Transient provider failures
that report nothing back deliberately do **not** burn the budget: those are
precisely the ones worth retrying.

The `timestamp` bound scopes the count to *this* wait. `externalEvents` is a
shared, never-drained log, so without it a result from an earlier payment
question in the same survey would spend this wait's budget. Entries lacking a
`timestamp` compare NULL and go uncounted, erring toward retrying — the safe
direction for payments.

This gate previously used a blind `jsonb_array_length(externalEvents)`, the same
bug already fixed in `Timeouts`: unrelated events (moviehouse clips, earlier
payments) falsely exhausted the budget, biased hardest against respondents
furthest through a survey. Regression tests: `payment_scoping_test.go`.

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
