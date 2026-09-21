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
    credentials.go     # GetMessagingCredentials: account id -> {entity, owner} from chatroach.credentials
  platform/platform.go # Pure account -> transport resolution: entity mapping, Valid, Resolve, UnresolvedPageIDs, skip reasons. No IO
  query/builder.go     # Translates bail conditions into parameterized SQL against states, joined to the owner's credentials
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

Uses CockroachDB (accessed via pgx). Exodus owns two tables in the `chatroach` schema and
reads four others: `states` and `responses` (who matches a bail), `surveys` (the `surveyid`
condition), and `credentials` — the authoritative map from a messaging account to the
platform it sends on, and to the researcher who connected it. See "Platform resolution".

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
| `users_matched` | INT | Conversations resolved to a reachable account (skipped targets are not counted) |
| `users_bailed` | INT | Users successfully bailed |
| `definition_snapshot` | JSONB | Bail definition at time of execution |
| `error` | JSONB | Error details (null for successful executions) |
| `execution_results` | JSONB | `{"user_ids": [...]}`, plus `"skipped": [{"userid","pageid","reason"}]` when a user list named accounts that did not resolve |

### `chatroach.credentials` (read-only)

One row per connected account. `key` is the account id (`pageid` elsewhere in this service),
`userid` is the researcher who connected it, and `entity` is what it sends on:
`facebook_page` → `messenger`, `whatsapp_business` → `whatsapp`. Migration 20 puts a UNIQUE
index on `key` restricted to those two entities, so an account id matches at most one
credential in the whole database — which is what makes the join single-valued and the
per-account lookup a map.

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

Create, update and preview each refuse a `user_list` definition naming an account the caller
has not connected, with `400 invalid_pageids` and a message listing every offending pageid:

```json
{
  "error": "invalid_pageids",
  "message": "no messaging account owned by this user for pageids: p_gone, p_theirs (each pageid must be a connected facebook_page or whatsapp_business account)"
}
```

The check (`handlers.go#checkUserListAccounts`) runs after the definition validates and
before anything is written, against `GetMessagingCredentials` and the pure
`platform.UnresolvedPageIDs`. It is repeated at execution because a credential can disappear
in between — but only the write path can turn it into an error a researcher sees, which is
why a save is refused rather than allowed to become a batch that silently reaches fewer
people. Preview applies it too, so a CSV can be checked before any bail exists.

### How errors reach the caller

`respondError` (`api/server.go`) writes `{"error": "<code>", "message": "<detail>"}`. The handlers map a missing bail to `404 bail_not_found` and everything else from the database to `500 database_error`, so which one the caller sees depends entirely on the db layer's error being recognisable.

**The db layer signals "no such bail" with the wrapped sentinel `db.ErrBailNotFound`, and handlers must test it with `errors.Is`.** A direct comparison against `pgx.ErrNoRows` does not work: `db/bails.go` converts the driver's `ErrNoRows` into its own error before returning, so an equality check never matches and a missing bail is reported as a 500 database failure. That was a live bug — `GET /users/:userId/bails/:id` for an unknown id answered `500 database_error: bail not found: <uuid>` — and `api/handlers_test.go#TestHandlers_UnknownBailIsNotFound` exists to keep it fixed. Test doubles for `DBInterface` must return the same wrapped sentinel; a mock returning a bare `pgx.ErrNoRows` is what hid the bug from the suite.

Callers rely on this. dashboard-server's `api/bails/bails.service.js` relays any Exodus response below 500 to the user (and to an MCP agent) verbatim as an expected error, and turns a 500 into a generic "failed unexpectedly". `invalid_pageids` depends on that relay for its whole value: the list of bad pageids is only useful if it reaches the person who typed them, so dashboard-server deliberately does not re-implement the ownership rule and instead passes the message through (`dashboard-server/README.md`, "Bail systems").

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

Keeping an answer bound to its account is necessary but not sufficient: the account itself
must also belong to the bail's owner, which is what the credentials join in the main SELECT
decides. See "Platform on conditions-based bails", property 3.

`responses.pageid` was nullable until
`devops/migrations/28a-responses-account-scoped-key.sql`, which made it `NOT NULL` — it is part
of the primary key now — and backfilled the 1.82M historical NULLs to the empty-string
"account unknown" sentinel. Either way those rows stay inert for bail targeting, since no real
account id is `''`. In practice this is not a live concern: every response written since
September 2020 carries a real pageid.

### Generated SQL Shape

The query builder produces SQL of this form:

```sql
[WITH cte_0 AS (...), cte_1 AS (...)]        -- one per elapsed_time / question_response
SELECT DISTINCT s.userid, s.pageid,
  CASE WHEN c.entity = 'facebook_page' THEN 'messenger'
       WHEN c.entity = 'whatsapp_business' THEN 'whatsapp'
  END AS platform
FROM states s
INNER JOIN credentials c ON c.key = s.pageid
  AND c.entity IN ('facebook_page','whatsapp_business')
  AND c.userid = $N                          -- the bail's owner
[LEFT JOIN cte_N alias ON s.userid = alias.userid AND s.pageid = alias.pageid]
WHERE [condition clauses]
LIMIT 100000
```

`BuildQuery(def, ownerID)` binds the owner **after** the conditions, so `$N` is always one
past the last condition parameter and adding the join left every existing parameter index
untouched. A `form`+`state` bail is `[$form, $state, $owner]`; an `elapsed_time` bail is
`[$form, $question_ref, $duration, $owner]`.

The default query limit of 100,000 is a safety cap.

CTE joins are `LEFT JOIN`, not `JOIN`. An inner join gives every CTE-backed condition AND
semantics regardless of the operator that combines them, which silently broke `OR` over two
`question_response` conditions (they can never both hold for the same question). The
`IS NOT NULL` test in the WHERE clause is what actually enforces the match. The credentials
join is the one INNER join, and is inner deliberately: it does not express a condition, it
decides which accounts exist for this bail at all.

### Duration Format

PostgreSQL interval format: `"<number> <unit>"` where unit is one of: `seconds`, `minutes`, `hours`, `days`, `weeks`, `months`, `years`.

## Executor Flow

1. Load all enabled bails from `chatroach.bails`
2. For each bail (with panic recovery and error isolation):
   a. Parse and validate the JSON definition
   b. Check timing (`shouldExecute`): immediate always fires; scheduled checks time-of-day in timezone with 24h dedup; absolute fires once after target datetime
   c. Resolve the bail's targets, each type its own way:
      - **conditions**: `query.BuildQuery(def, bail.UserID)`, then execute it. Every row is
        `(userid, pageid, platform)`, already owner-scoped by the credentials join. A row
        whose platform is unusable fails the whole bail (see "Platform resolution").
      - **user_list**: `resolveUserList` collects the distinct pageids, loads one credential
        each via `GetMessagingCredentials`, and calls `platform.Resolve` to split the entries
        into targets and skips.
   d. Apply `MaxBailUsers` limit
   e. Send bailout events to botserver via HTTP POST with rate limiting, including the
      conversation triple
   f. Record a `bail_events` row with `user_id` (execution or error), carrying the bailed user
      ids and any skipped targets in `execution_results`
3. Individual bail failures are logged and recorded but do not stop processing of other bails

A run that resolves nobody and skipped nobody records nothing — there is no news in it. A run
in which **every** target was skipped does record an execution event, with `users_matched: 0`,
`"user_ids": []` and the full `skipped` list: the skips are the entire story of that run, and
without an event the bail's history would be indistinguishable from one that never fired.

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

### Platform resolution

**One source of truth: `credentials.entity`, looked up by `credentials.key = pageid`.** It is
the same map the token lookup uses, so a platform exodus resolves is a platform the sending
side can act on. Neither bail type carries a platform in from outside, and neither guesses
one.

- **Conditions bails** resolve it in SQL. The query joins `credentials` on the account and
  reads the entity in the same pass (see "Generated SQL Shape"). The join is owner-scoped and
  INNER, so every returned row already has both a platform and an account this bail is
  entitled to reach.
- **User_list bails** resolve it in Go. `UserListEntry` is `{userid, pageid, shortcode}` —
  there is no platform field on the wire. The executor loads one credential per distinct
  pageid (`db.GetMessagingCredentials`) and hands the map to `platform.Resolve`, which
  partitions the entries into resolved targets and skipped ones.

`states.platform` is not consulted by either path. It is NULL for the great majority of rows,
and NULL again for a blocked conversation whose `md` was erased — exactly the population a
recovery bail exists to reach.

The two paths differ in what an unresolvable account means, and the difference is deliberate:

|  | Conditions | User list |
|---|---|---|
| Account not owned / not messaging | excluded by the join; never appears | skipped, recorded with a reason |
| Unusable platform on a returned row | **fails the whole bail**, loudly | n/a |

A conditions bail cannot name an account, so an account it cannot resolve is simply not part
of the population — reporting it would mean listing other researchers' participants in this
owner's event log, every tick. A user list *does* name accounts, one by one, so an account
that does not resolve is news the owner needs, and it is recorded rather than dropped. And
because the query's INNER JOIN guarantees a credential per row, a row that still arrives with
an unusable platform means the SQL and the executor disagree: a defect in this binary, not a
property of one participant, so `queryUsers` returns an error and the bail records none of it
rather than quietly reaching fewer people.

The skip reasons (`platform.Reason*`) are `credential_not_found`, `credential_not_owned` and
`credential_not_messaging` — the last of which should be unreachable, since the lookup filters
on the two messaging entities; it exists so that a filter and a mapping drifting apart produce
a recorded skip rather than an empty platform. They are written to
`bail_events.execution_results.skipped` as
`{"userid", "pageid", "reason"}`. `users_matched` counts resolved targets only, and a run in
which everything was skipped still records an execution event — see "Executor Flow".

The `platform` package holds the rules as pure functions over plain data (`ForEntity`,
`Valid`, `Resolve`, `UnresolvedPageIDs`), with no database, context or IO; fetching the
credentials is `db/credentials.go`, and it is deliberately not owner-scoped, because the
caller is the one that distinguishes "no such account" from "not yours". That split is what
lets the API's write-time check and the executor's run-time resolution share one definition
of "resolvable" while doing their own lookups.

`SendBailout` refuses outright a target whose platform is neither `messenger` nor `whatsapp`,
before building the event or touching the network. It is a backstop rather than a working
path — both bail types resolve a platform first — but it is the one place that guarantees
exodus never puts an un-named event on the wire. An un-named bailout is worse than no
bailout: the receiver falls back to Messenger, a WhatsApp participant silently loses the form
switch, and even on Messenger the event lands on replybot's degraded path, where the state
that records the switch is never written. `documentation/bail-systems.md`, "Why an un-named
bailout is never sent", has the failure in full.

### Rate Limiting and Error Handling

Sends are rate-limited (configurable via `EXODUS_RATE_LIMIT`). Failures for individual users are logged but do not stop remaining sends. Supports dry-run mode (`DRY_RUN=true`), which logs what it would send instead of actually POSTing to botserver.

### Platform on conditions-based bails

The SELECT emits the whole conversation identity, and four properties of it are load-bearing.
Each was verified rather than assumed:

1. **The `AS platform` alias is required, not cosmetic.** `executor/executor.go:queryUsers`
   reads the value as `row["platform"]`. Unaliased, the `CASE` lands under a generated key,
   the lookup misses, and targets would go out unnamed.
   `TestBuildQuery_SelectsPlatformAliasedForTheExecutor` guards this.
2. **The entity, not `states.platform`.** `states.platform` is a computed column over
   `state_json->'md'->>'platform'` (migration `21-states-platform.sql`) and is NULL for
   **1,068,371 of 1,092,078 production rows, 97.8%** — and NULL again, this time wrongly, for
   a blocked conversation whose `md` was erased. Defaulting those to `messenger` sends a
   WhatsApp participant to the Messenger client, which has no `facebook_page` token for their
   account. `credentials.entity` is a fact about the account instead of a value carried on a
   row, so it is right for both populations.
3. **The join is INNER and owner-scoped.** Conditions match on shortcodes, and a shortcode is
   not unique across users: without `c.userid = $owner`, a bail naming `survey_common`
   matched every `states` row on that shortcode, including another researcher's participants
   on their own accounts. INNER (rather than LEFT plus a skip list) keeps those rows out of
   the result entirely, so no other owner's participant ids can reach this owner's event log.
4. **Adding a column to a `SELECT DISTINCT` cannot double-bail anyone.** It normally could —
   a new column changes what counts as a duplicate. It is safe here by construction, not
   because the data happens to be clean: `states` is `PRIMARY KEY (userid, pageid)` (verified
   in production: 1,092,078 rows, 1,092,078 distinct pairs) and migration 20's unique index
   means at most one credential row joins per pageid, so `platform` is functionally dependent
   on the `DISTINCT` key and cannot subdivide a group.

Two consequences an operator should expect. A bail reaches only accounts its owner has
connected, so **disconnecting an account removes its participants from the bail** — they stop
matching rather than being bailed on an account that can no longer send. And a bail's
population can shrink the first time this join is applied: run
`planning/vir-60-predeploy-check.sql` (read-only) beforehand to see, per enabled bail, exactly
which `(bail, pageid)` populations drop out and whether each dropped account belongs to
another researcher or to nobody.

`TestIntegration_ConditionsBail_CarriesPlatform` covers this end-to-end against CockroachDB:
a conversation on a `whatsapp_business` account bails as `whatsapp`, one on a `facebook_page`
account as `messenger`, and a row whose `state_json` claims the wrong platform still bails on
the one its credential says. `TestIntegration_ConditionsBail_CrossTenantShortcode` is the
regression test for the shortcode collision — two owners, one shortcode, each bail seeing
only its own participants.

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

No database required. Tests verify SQL string structure for all condition types and operators, and test the sender's pure event-building function and HTTP communication logic. `platform/` is entirely pure, so its resolution rules — the entity mapping, the partition into resolved and skipped, and the ordering of the three skip reasons — are covered by table tests with no fixtures at all.

```bash
make test-unit
# or: go test -count=1 ./...
```

### Integration Tests

Tests in `query/db_integration_test.go` execute generated SQL against a real CockroachDB instance and assert on returned rows. They cover OR, AND, NOT, and no-match scenarios for `question_response` conditions — including a regression test for the LEFT JOIN fix that makes OR semantics work correctly, and `*_AccountScoped` regression tests proving that answers recorded on one messaging account cannot qualify a participant for a bail targeted at another (see "Bail targeting is account-scoped"). `TestIntegration_ConditionsBail_CarriesPlatform` and `TestIntegration_ConditionsBail_CrossTenantShortcode` cover the credentials join against a real database; `db/credentials_test.go` covers the lookup itself.

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

- **CockroachDB**: Primary data store. Uses the `chatroach` schema: writes `bails` and `bail_events`, reads `states`, `responses`, `surveys` and `credentials`.
- **Botserver**: Receives bailout events at `/synthetic` endpoint. Botserver then redirects the user to the destination form in their next interaction.
