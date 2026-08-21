# Exodus

Bail systems service for automated user bailouts in surveys. When users get stuck, time out, or hit error states during chatbot-driven surveys, exodus identifies them via configurable conditions and redirects them to a destination form.

## Architecture

Exodus is a single Go binary that runs in two modes:

- **Executor** (`--mode=executor`): Runs once, processes all enabled bails, then exits. Deployed as a Kubernetes CronJob (every minute). Queries the `states` table for users matching bail conditions, then sends bailout events to botserver.
- **API** (`--mode=api`): Long-running HTTP server for CRUD management of bail configurations. Deployed as a Kubernetes Deployment. Used by the dashboard.

Both modes share the same database connection and config. The executor is the workhorse; the API is the management plane.

## Directory Structure

```
exodus/
  main.go              # Entry point, mode switching (api/executor)
  config/config.go     # Environment variable parsing (caarlos0/env)
  types/types.go       # Domain types: Bail (with user_id), BailDefinition, Condition, Execution, Action
  db/
    db.go              # Connection pool, generic Query method
    bails.go           # CRUD for chatroach.bails table (GetBailsByUser, CreateBail, UpdateBail, DeleteBail)
    events.go          # Insert/query for chatroach.bail_events table (user-scoped)
  query/builder.go     # Translates bail conditions into parameterized SQL against states table
  executor/
    executor.go        # Orchestrates bail processing: load -> query -> send -> record
    timing.go          # Determines if a bail should fire based on timing config
  sender/sender.go     # HTTP client that POSTs bailout events to botserver
  api/
    server.go          # Echo HTTP server setup and route registration (user-scoped routes)
    handlers.go        # Handler implementations for all endpoints (user-scoped)
    types.go           # Request/response structs
  chart/               # Helm chart (CronJob + Deployment)
  Dockerfile           # Multi-stage build (golang:1.23-alpine -> alpine)
```

## Configuration

All config is via environment variables (parsed by `caarlos0/env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `CHATBASE_DATABASE` | `chatroach` | CockroachDB database name |
| `CHATBASE_HOST` | `localhost` | Database host |
| `CHATBASE_PORT` | `5433` | Database port |
| `CHATBASE_USER` | `root` | Database user |
| `CHATBASE_PASSWORD` | (empty) | Database password |
| `BOTSERVER_URL` | `http://localhost:8080/synthetic` | Botserver synthetic event endpoint |
| `EXODUS_RATE_LIMIT` | `1s` | Delay between bailout sends |
| `EXODUS_MAX_BAIL_USERS` | `100000` | Max users to bail per bail definition per run |
| `PORT` | `8080` | API server port (api mode only) |
| `DRY_RUN` | `false` | Log bailouts without sending to botserver |

Validation is mode-specific: executor requires `BOTSERVER_URL`, api requires `PORT`.

## Database

Uses CockroachDB (accessed via pgx). Two tables in the `chatroach` schema:

### `chatroach.bails`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key (auto-generated) |
| `user_id` | UUID | Owning user (FK to users table) |
| `name` | TEXT | Human-readable name |
| `description` | TEXT | Optional description |
| `enabled` | BOOL | Whether executor processes this bail |
| `definition` | JSONB | Full bail definition (conditions, execution timing, action) |
| `destination_form` | TEXT | Shortcode of the form to bail users into (denormalized from definition.action) |
| `created_at` | TIMESTAMPTZ | Auto-set on insert |
| `updated_at` | TIMESTAMPTZ | Auto-set on insert and update |

### `chatroach.bail_events`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key (auto-generated) |
| `bail_id` | UUID | FK to bails (nullable for orphaned events) |
| `user_id` | UUID | Owning user context |
| `bail_name` | TEXT | Bail name at time of event |
| `event_type` | TEXT | `"execution"` or `"error"` |
| `timestamp` | TIMESTAMPTZ | Auto-set on insert |
| `users_matched` | INT | Users that matched conditions |
| `users_bailed` | INT | Users successfully bailed |
| `definition_snapshot` | JSONB | Bail definition at time of execution |
| `error` | JSONB | Error details (null for successful executions) |

## API Endpoints

All bail endpoints are scoped under `/users/:userId`. A bail belongs to a user and can reference any form shortcode in its conditions.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/users/:userId/bails` | List all bails for a user (includes last event) |
| `POST` | `/users/:userId/bails` | Create a new bail |
| `POST` | `/users/:userId/bails/preview` | Dry-run a bail definition, returns matching users |
| `GET` | `/users/:userId/bails/:id` | Get a single bail (includes last event) |
| `PUT` | `/users/:userId/bails/:id` | Update a bail (partial updates supported) |
| `DELETE` | `/users/:userId/bails/:id` | Delete a bail |
| `GET` | `/users/:userId/bails/:id/events` | Get event history for a bail |
| `GET` | `/users/:userId/bail-events?limit=N` | Get recent events for a user (default 100, max 1000) |

## Query DSL

Bail conditions are JSON objects that translate to parameterized SQL against the `states` table. Conditions can be composed with logical operators.

### Condition Types

| Type | Fields | SQL Generated |
|------|--------|---------------|
| `form` | `value` | `s.current_form = $N` |
| `state` | `value` | `s.current_state = $N` |
| `error_code` | `value` | `s.state_json->'error'->>'code' = $N` |
| `current_question` | `value` | `s.state_json->>'question' = $N` |
| `elapsed_time` | `since`, `duration` | CTE join on `responses` table, checks `response_time + interval < NOW()` |
| `question_response` | `form`, `question_ref`, optional `response` | CTE join on `responses` table, checks the participant answered that question (with that value, if given) |
| `surveyid` | `value` | `s.current_form IN (SELECT shortcode FROM surveys WHERE id = $N)` |

### Logical Operators

Conditions can be combined with `and`, `or`, and `not`:

| Operator | Children | SQL Generated |
|----------|----------|---------------|
| `and` | 1 or more | `(child1 AND child2 AND ...)` |
| `or` | 1 or more | `(child1 OR child2 OR ...)` |
| `not` | exactly 1 | `NOT (child)` |

Example with `and`:

```json
{
  "op": "and",
  "vars": [
    {"type": "form", "value": "survey_a"},
    {"type": "state", "value": "QOUT"},
    {"type": "elapsed_time", "duration": "4 weeks", "since": {
      "event": "response",
      "details": {"question_ref": "q1", "form": "survey_a"}
    }}
  ]
}
```

Example with `not` (negate a single condition):

```json
{"op": "not", "vars": [{"type": "state", "value": "END"}]}
```

Generates: `NOT (s.current_state = $1)`

Example with `not` wrapping a group:

```json
{
  "op": "not",
  "vars": [{
    "op": "and",
    "vars": [
      {"type": "form", "value": "survey_v1"},
      {"type": "state", "value": "END"}
    ]
  }]
}
```

Generates: `NOT ((s.current_form = $1 AND s.current_state = $2))`

**Constraint**: The `not` operator cannot wrap `elapsed_time` conditions (directly or transitively). This is rejected at validation time because negating elapsed_time would require LEFT JOIN + IS NULL handling to correctly include users who never responded.

The `elapsed_time` condition generates a CTE that joins the `responses` table to find when a user last answered a specific question, then checks if that time plus the duration is before now.

Operators nest arbitrarily. The builder wraps each group in parentheses for correct SQL precedence.

### Bail targeting is account-scoped

**A conversation is the tuple `(platform, account_id, user_id)` — a user id alone is not an
identity.** `account_id` is the legacy column name `pageid`; `chatroach.states` is keyed
`PRIMARY KEY (userid, pageid)` precisely because the same participant id can hold two
entirely independent conversations on two different messaging accounts, and those accounts
may belong to two different researchers.

Every response-derived CTE therefore projects `pageid` and is joined to `states` on the full
conversation identity:

```sql
LEFT JOIN response_times_0    rt0 ON s.userid = rt0.userid AND s.pageid = rt0.pageid
LEFT JOIN question_responses_0 qr0 ON s.userid = qr0.userid AND s.pageid = qr0.pageid
```

`response_times_N` additionally aggregates per account (`GROUP BY userid, pageid`), so a
response on one account cannot set the elapsed-time clock for another.

Joining on `userid` alone — as the builder did before this was fixed — aggregates `responses`
across *all* accounts and attaches them to account-scoped `states` rows. A participant's
answers on account A then qualify them for a bail targeted at account B: both a correctness
bug (the wrong people get bailed) and a cross-researcher data leak (researcher B's bail
fires on researcher A's data). The regression tests for this live in
`query/builder_test.go` (SQL shape) and `query/db_integration_test.go` (behaviour against a
real database).

The join uses strict equality, so a response row with no real account matches no conversation
at all. This is deliberate — an unattributable response must not qualify anyone.

`responses.pageid` was nullable until
`devops/migrations/28-responses-account-scoped-key.sql`, which made it `NOT NULL` — it is part
of the primary key now — and backfilled the 1.82M historical NULLs to the empty-string
"account unknown" sentinel. Either way those rows stay inert for bail targeting, since no real
account id is `''`. In practice this is not a live concern: every response written since
September 2020 carries a real pageid.

### Generated SQL Shape

The query builder produces SQL of this form:

```sql
[WITH cte_0 AS (...), cte_1 AS (...)]        -- one per elapsed_time / question_response
SELECT DISTINCT s.userid, s.pageid
FROM states s
[LEFT JOIN cte_N alias ON s.userid = alias.userid AND s.pageid = alias.pageid]
WHERE [condition clauses]
LIMIT 100000
```

The default query limit of 100,000 is a safety cap.

CTE joins are `LEFT JOIN`, not `JOIN`. An inner join gives every CTE-backed condition AND
semantics regardless of the operator that combines them, which silently broke `OR` over two
`question_response` conditions (they can never both hold for the same question). The
`IS NOT NULL` test in the WHERE clause is what actually enforces the match.

### Duration Format

PostgreSQL interval format: `"<number> <unit>"` where unit is one of: `seconds`, `minutes`, `hours`, `days`, `weeks`, `months`, `years`.

## Executor Flow

1. Load all enabled bails from `chatroach.bails`
2. For each bail (with panic recovery and error isolation):
   a. Parse and validate the JSON definition
   b. Check timing (`shouldExecute`): immediate always fires; scheduled checks time-of-day in timezone with 24h dedup; absolute fires once after target datetime
   c. Build SQL from conditions via `query.BuildQuery`
   d. Execute query against CockroachDB, get `(userid, pageid)` pairs and platform when available
   e. Apply `MaxBailUsers` limit
   f. Send bailout events to botserver via HTTP POST with rate limiting, including the conversation triple
   g. Record a `bail_events` row with `user_id` (execution or error)
3. Individual bail failures are logged and recorded but do not stop processing of other bails

## Sender

Sends HTTP POST requests to botserver's `/synthetic` endpoint, posting the required synthetic event triple: `user`, `account_id`, and `platform`. Each bailout is a JSON payload that conforms to the event envelope contract (see `documentation/event-envelope.md`):

```json
{
  "user": "<userid>",
  "account_id": "<pageid>",
  "page": "<pageid>",
  "platform": "messenger|whatsapp",
  "event": {
    "type": "bailout",
    "value": {
      "form": "<destination_form>",
      "metadata": {}
    }
  }
}
```

The `page` field is a deprecated alias for `account_id` retained for backward compatibility; both carry the same value (the account where the conversation is happening).

### Platform Data Sources

Platform comes from two sources depending on the bail type:

- **Conditions-based bails**: Platform comes from the query result, which selects
  `COALESCE(s.platform, 'messenger') AS platform` from `states` (`BuildQuery`). See
  "Platform on conditions-based bails" below for why both the `COALESCE` and the alias
  are load-bearing.
- **User_list bails**: Platform is supplied explicitly in each `user_list.users[].platform` field by the caller.

Both paths now satisfy the event envelope contract.

### Rate Limiting and Error Handling

Sends are rate-limited (configurable via `EXODUS_RATE_LIMIT`). Failures for individual users are logged but do not stop remaining sends. Supports dry-run mode (`DRY_RUN=true`), which logs what it would send instead of actually POSTing to botserver.

### Platform on conditions-based bails

`BuildQuery` selects the whole conversation identity:

```sql
SELECT DISTINCT s.userid, s.pageid, COALESCE(s.platform, 'messenger') AS platform
FROM states s
...
```

It previously selected only `(s.userid, s.pageid)`, so conditions-based bails posted an
**empty** `platform` while user_list bails carried one — exodus was half-compliant with the
event envelope contract. Hermes tolerates an empty platform only while
`SYNTHETIC_REQUIRE_CONVERSATION` is off (the default); with the gate on it returns HTTP 400.

Three properties of that expression are load-bearing, and each was verified rather than
assumed:

1. **The `AS platform` alias is required, not cosmetic.** `executor/executor.go:queryUsers`
   reads the value as `row["platform"]`. Unaliased, a `COALESCE` lands under the key
   `coalesce`, the lookup misses, and the platform silently stays empty — the change would
   appear to ship and do nothing. `TestBuildQuery_SelectsPlatformAliasedForTheExecutor`
   guards this.
2. **`COALESCE`, not a bare `s.platform`.** `states.platform` is a computed column over
   `state_json->'md'->>'platform'` (migration `21-states-platform.sql`) and is NULL for every
   row predating that persistence — **1,068,371 of 1,092,078 production rows, 97.8%**. A bare
   column returns SQL NULL for those, and since the executor type-asserts the value to
   `string`, they arrive with an empty platform *and* log
   `Warning: Invalid platform type in query result: <nil>` once per target. Defaulting to
   `messenger` is the consumer contract migration 21 documents, and it is exact here: every
   `states` row on a `whatsapp_business` account carries `platform='whatsapp'` (verified in
   production), so all NULLs are Messenger.
3. **Adding a column to a `SELECT DISTINCT` cannot double-bail anyone.** It normally could —
   a new column changes what counts as a duplicate. It is safe here by construction, not
   because the data happens to be clean: `states` is `PRIMARY KEY (userid, pageid)` (verified
   in production: 1,092,078 rows, 1,092,078 distinct pairs), so `platform` is functionally
   dependent on the `DISTINCT` key and cannot subdivide a group.

`TestIntegration_ConditionsBail_CarriesPlatform` covers both real cases end-to-end against
CockroachDB: a conversation whose `state_json` carries `md.platform` bails as `whatsapp`, and
a legacy row without it bails as `messenger` rather than empty.

## Known Limitations

### Test packages share one database and wipe each other

`go test ./...` runs test *packages* in parallel, and `query/` and `db/` both `DELETE FROM`
the same tables in their setup helpers. Run against a shared database without `-p 1`, they
truncate each other's fixtures mid-test. The failures look like real bugs but are pure
interference, and they move around between runs:

```
--- FAIL: TestRecordErrorEvent            Expected 1 event, got 0
--- FAIL: TestIntegration_AND_QuestionResponse
    insertResponseFull: ERROR: insert on table "responses" violates foreign key
    constraint "responses_surveyid_fkey" (SQLSTATE 23503)
```

That FK violation means another package deleted `surveys` between this test's `insertSurvey`
and its response insert — not that the query under test is wrong. **Always `-p 1`.** The same
run with `-p 1` on an isolated database is fully green.

Two traps worth knowing, because both have produced a false "green" in this repo:

- `integrationPool` calls `t.Skipf` when the database is unreachable, so a missing or
  wrong-port database makes the integration tests **skip silently** while `go test` still
  exits 0. Check the skip count, not just the exit status.
- The default DSN is port 5433, and a database there may lack `chatroach.bail_events` (it is
  created by `devops/migrations/06-exodus-bails.sql`). Use a database built from
  `devops/migrations/*.sql`, as `make test-db` does.

The real fix is per-package schemas or transaction-scoped fixtures; neither is done.

### Legacy field naming

Note that `UserTarget.PageID` still carries the legacy name while the field it populates is
`account_id`. Renaming it would ripple into `query/` and `api/` and was deliberately left out
here to avoid colliding with the in-flight CTE work; it is a candidate for the §7.7 rename.

## Deployment

### Docker

Multi-stage build: `golang:1.23-alpine` for compilation, `alpine` for runtime. Default entrypoint runs executor mode.

```
docker build -t vlabresearch/exodus .
docker run vlabresearch/exodus --mode=executor
docker run vlabresearch/exodus --mode=api
```

### Helm Chart

Located in `chart/`. Deploys two resources from the same image:

- **CronJob** (`executor.enabled: true`): Runs every minute, `concurrencyPolicy: Forbid`, 1h deadline. Default.
- **Deployment** (`api.enabled: false`): ClusterIP service on port 80 -> container port 8080. Disabled by default until dashboard integration is ready.

See `chart/values.yaml` for resource limits and environment variable configuration.

## Testing

### Unit Tests

No database required. Tests verify SQL string structure for all condition types and operators, and test the sender's pure event-building function and HTTP communication logic.

```bash
make test-unit
# or: go test -count=1 ./...
```

### Integration Tests

Tests in `query/db_integration_test.go` execute generated SQL against a real CockroachDB instance and assert on returned rows. They cover OR, AND, NOT, and no-match scenarios for `question_response` conditions — including a regression test for the LEFT JOIN fix that makes OR semantics work correctly, and `*_AccountScoped` regression tests proving that answers recorded on one messaging account cannot qualify a participant for a bail targeted at another (see "Bail targeting is account-scoped").

The `query/` integration tests skip automatically when no database is reachable
(`integrationPool` calls `t.Skipf`). The `db/` package tests do **not** — `db/test_helpers.go`
calls `log.Fatal` on a failed connection, so `go test ./...` fails the `db` package outright
without a database. `make test-unit` therefore needs the test database running too, despite
its name.

```bash
# Start test database (CockroachDB on port 5433 with all migrations applied)
make test-db       # delegates to devops/Makefile

# Run everything — use -p 1 to avoid races on the shared database
make test
# or: go test -count=1 -p 1 ./...

# Integration tests only
make test-integration
```

`-p 1` runs test packages sequentially. Without it, packages run in parallel and can race on the shared database (e.g., one package's cleanup truncates rows another package just inserted).

To override the database URL (e.g. in CI):

```bash
TEST_DATABASE_URL=postgres://root@myhost:5433/chatroach make test
```

## Dependencies

### Go Modules

- `github.com/jackc/pgx/v4` -- PostgreSQL driver (CockroachDB compatible)
- `github.com/labstack/echo/v4` -- HTTP framework (API mode)
- `github.com/caarlos0/env/v6` -- Environment variable config parsing
- `github.com/google/uuid` -- UUID generation and parsing

### External Services

- **CockroachDB**: Primary data store. Uses `chatroach` schema with `states`, `responses`, `bails`, and `bail_events` tables.
- **Botserver**: Receives bailout events at `/synthetic` endpoint. Botserver then redirects the user to the destination form in their next interaction.
