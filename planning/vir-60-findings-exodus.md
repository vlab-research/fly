# VIR-60 Findings: Exodus Platform Resolution

## Summary

**Key Fact**: Exodus handles platform resolution differently for two bail types. Conditions-based bails resolve platform correctly (COALESCE to `messenger` as fallback), but **user_list bails pass through the `platform` field unvalidated from the caller** (`exodus/executor/executor.go:267`). UserListEntry.Platform is not required by validation (`types/types.go:132-141`), so omitting it produces `"platform": ""` in the synthetic event, which replybot misinterprets as `messenger` — causing WhatsApp users to land in ERROR/STATE_ACTIONS.

**Problem Scope**: 
- **User list bails**: The `platform` field is copied directly from caller-supplied `UserListEntry.Platform` without validation, destination, or enforcement. Three columns parse from CSV (userid, pageid, shortcode); platform is never present (`dashboard-client/CsvUpload.js:24-25`). The MCP schema also omits it (`mcp.core.js` user_list.users items have no platform property).
- **Conditions bails**: Already correct — `COALESCE(s.platform, 'messenger') AS platform` is projected by the query builder (`query/builder.go:82`), and the comment block at lines 55–81 documents why all three parts (alias, COALESCE, DISTINCT safety) are load-bearing. Conditions bails cannot send empty platform.

**Recommended Fix Shape**: 
1. Resolve platform from `credentials.entity` keyed by `pageid` (account_id = `credentials.key`). Single-valued: `UNIQUE INDEX unique_messaging_account (key ASC) ... WHERE entity IN ('facebook_page','whatsapp_business')` (`documentation/platform-resolution.md:192-204`).
2. For user_list bails: validate that each entry's `platform` either matches the credential's transport or is validated/required upfront. Reject if pageid has no credential or if entry claims an incompatible platform.
3. For conditions bails: leave COALESCE intact (already safe).
4. Make validation refuse empty platform on all paths; never produce `"platform": ""` in sender output.

**Open Risks**:
- No per-target failure isolation today; if some credentials are missing, does whole bail fail or do resolvable targets proceed?
- Migration of existing user_list bails with empty platform: how to handle them? (Measure first.)
- Cross-repo scope: dashboard-client CSV upload, MCP tools, and REST API all pass through to exodus unfiltered.

---

## 1. Full Data Flow of a Bail Run

**Orchestration** (`exodus/executor/executor.go:55-90`):
1. `executor.Run(ctx)` called by CronJob (every 1 minute, `devops/values/production.yaml` schedule `* * * * *`)
2. Load all enabled bails: `e.store.GetEnabledBails(ctx)` → `db/bails.go`
3. For each bail, call `e.processBail(ctx, bail, now)`

**Single Bail Processing** (`executor.go:93-189`):
1. **Line 111-116**: Parse `bail.Definition` (JSONB) as `types.BailDefinition`
2. **Line 119**: Validate definition (`bailDef.Validate()` → `types/types.go:20-57`)
3. **Line 126**: Get last execution time for deduplication (`GetLastSuccessfulExecution`)
4. **Line 134**: Check if should execute (`shouldExecute(&bailDef.Execution, now, lastExecution)` → `executor/timing.go`)
5. **Line 148-152**: Determine bail type (default `"conditions"` for backward compat)
6. **Line 154**: Query users: `e.queryUsers(ctx, dbBail, bailDef, bailType)` → branches on type

**User Query** (`executor.go:194-257`):
- **For user_list** (line 196-201):
  - Call `userListToTargets(bailDef.UserList)` → **line 261-272**
  - Extract platform directly from `entry.Platform` (line 267: `Platform: entry.Platform`)
  - No resolution, no validation; empty string propagates
  
- **For conditions** (line 204-256):
  - Build SQL: `query.BuildQuery(bailDef)` → `query/builder.go:35-100`
  - **Line 82 projects**: `COALESCE(s.platform, 'messenger') AS platform`
  - Execute query: `e.query.Query(ctx, sql, params...)`
  - Loop rows (line 221-246): extract userid, pageid, **platform from row["platform"]** (line 240-246)
  - Type-assert to string; warn if nil (line 244)
  - Append `UserTarget` struct (line 248-254) with resolved platform

**Platform at Sender** (`executor.go:177`, `sender/sender.go:14-75`):
- `e.sender.SendBailouts(ctx, users, bailDef.Action.Metadata)`
- For each `UserTarget`:
  - Build `BailoutEvent` (`sender.go:62-75`)
  - JSON fields: `User`, `AccountID`, `Page` (deprecated alias, same as AccountID), **`Platform`** (line 18)
  - No omitempty; empty platform produces `"platform": ""`
  - HTTP POST to `BOTSERVER_URL` (`sender.go:95`)

**Event Recording** (`executor.go:274-308`):
- `e.recordSuccess(ctx, dbBail, bailDef, usersMatched, bailedIDs)`
- Stores `BailEvent` row in `chatroach.bail_events`:
  - `event_type: "execution"` (line 297)
  - `definition_snapshot: defJSON` (line 300, for audit trail)
  - `execution_results: {"user_ids": [...]}`

**Error Recording** (`executor.go:310-336`):
- On any error, `e.recordError(ctx, dbBail, execErr)`
- `event_type: "error"` (line 324)
- Error message interpolated unescaped (line 313: `fmt.Sprintf`), so timing errors with quotes fail JSON insert (documented in `documentation/bail-systems.md:1112`, "Failed executions leave no event")

---

## 2. Query Builder Implementation

**Entry Point** (`query/builder.go:35-100`):
```go
func BuildQuery(def *types.BailDefinition) (string, []interface{}, error)
```
- Creates `QueryBuilder` (line 36)
- Builds WHERE clause from `def.Conditions` (line 39)
- Constructs final SELECT (line 45-99)

**Generated SQL Shape** (line 82):
```sql
[WITH cte_0 AS (...), cte_1 AS (...)]
SELECT DISTINCT s.userid, s.pageid, COALESCE(s.platform, 'messenger') AS platform
FROM states s
[LEFT JOIN cte_N alias ON s.userid = alias.userid AND s.pageid = alias.pageid]
WHERE [condition clauses]
LIMIT 100000
```

**Comment Block** (`query/builder.go:54-81`) — **Three Load-Bearing Properties**:
1. **`AS platform` alias is required, not cosmetic** (line 61-66): executor.go reads as `row["platform"]`; without alias, COALESCE lands as `"coalesce"`, lookup misses, platform silently empty — fix appears to ship and does nothing. Test: `TestBuildQuery_SelectsPlatformAliasedForTheExecutor`.
2. **COALESCE, not bare `s.platform`** (line 68-75): `states.platform` is a computed column (migration 21, `(state_json->'md')->>'platform' STORED`), NULL for 1,068,371 of 1,092,078 production rows (97.8%). A bare column would return SQL NULL, executor type-asserts to string, and targets arrive with empty platform + `"Invalid platform type in query result: <nil>"` log. Defaulting to `'messenger'` is the consumer contract migration 21 documents.
3. **Adding a column to SELECT DISTINCT cannot double-bail anyone** (line 77-81): normally, new column could split groups. Safe here: `states PRIMARY KEY (userid, pageid)` in production (1,092,078 rows, 1,092,078 distinct pairs), so `platform` is functionally dependent on DISTINCT key.

**CTE Construction** (`query/builder.go:177-231`, `234-277`):
- elapsed_time: `response_times_N` CTE aggregates per `(userid, pageid)` — not userid alone (line 218: `GROUP BY userid, pageid`)
- question_response: same (line 261-270)
- Both use `LEFT JOIN` (line 225, 275) so OR conditions work correctly; `IS NOT NULL` enforces the match (line 277)

**Testing**:
- Unit: `query/builder_test.go` — SQL string matching (e.g., `TestBuildQuery_SelectsPlatformAliasedForTheExecutor`)
- Integration: `query/db_integration_test.go` — execute against real CockroachDB; test account-scoped CTE joins, OR semantics, regression guards
- Run: `make test` (needs DB on port 5433 with migrations applied); `-p 1` required to avoid race on shared test DB (`exodus/README.md` §Known Limitations)

---

## 3. DB Access Patterns & Interfaces

**Connection** (`db/db.go:16-29`):
- `New(connString string)` creates DB struct with `pgxpool.Pool`
- Uses jackc/pgx driver for CockroachDB

**Query Interface** (`db/db.go:36-72`):
```go
func (d *DB) Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error)
```
- Executes parameterized SQL, returns rows as maps (string → interface{})
- Used by executor for dynamic queries

**BailStore Interface** (`executor.go:18-22`):
```go
type BailStore interface {
  GetEnabledBails(ctx context.Context) ([]*db.Bail, error)
  GetLastSuccessfulExecution(ctx context.Context, bailID uuid.UUID) (*time.Time, error)
  RecordEvent(ctx context.Context, event *db.BailEvent) error
}
```

**QueryExecutor Interface** (`executor.go:25-27`):
```go
type QueryExecutor interface {
  Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error)
}
```

**BailSender Interface** (`executor.go:30-32`):
```go
type BailSender interface {
  SendBailouts(ctx context.Context, users []sender.UserTarget, metadata map[string]interface{}) ([]string, error)
}
```

**Pure/Impure Split**:
- **Pure**: query builder (`query/builder.go:35-100`, all logic is side-effect-free)
- Sender's pure core: `sender.go:62-75` `buildBailoutEvent` (pure function for testability)
- **Impure shell**: DB queries, HTTP posts, file I/O live outside interfaces
- For testing: mock interfaces (executor tests do this; see `api/handlers_test.go` for mock DB)

**Natural Home for `ResolvePlatforms(ctx, pageids []string) (map[string]string, error)`**:
- Would live in `db/` package or as a method on DB
- Could be faked for tests via the `QueryExecutor` interface (pass a mock that returns pre-baked rows)
- Example test double: mock `Query` to return rows with `entity='whatsapp_business'` for test pageids

---

## 4. Validation

**BailDefinition.Validate** (`types/types.go:20-57`):
- Delegates to type-specific validators
- Line 27-43: Switch on Type (default `"conditions"`)
- For `"user_list"`: line 36-41 calls `bd.UserList.Validate()`
- Also validates Execution (line 46) and Action if not user_list (line 51-55)

**UserList.Validate** (`types/types.go:124-144`):
- Checks array size: 1–1000 users (line 126-130)
- Per-user checks (line 132-141): 
  - **userid required** (line 134-135)
  - **pageid required** (line 136-137)
  - **shortcode required** (line 138-139)
  - **platform NOT checked** — comment explicitly says line 115 is a comment-only declaration; no validation
- Entry type annotation (`types/types.go:112-117`): Platform field exists but is unvalidated

**API-Side Validation**:
- **REST** (`api/handlers.go:149`): Calls `req.Definition.Validate()` on all bails (line 149, line 240)
- **MCP** (`dashboard-server/api/mcp/mcp.core.js`):
  - Validates JSON Schema against `validateAgainstSchema` (line 144-196)
  - Validates timing format (function `validateBailDefinition`, lines ~1610–1670)
  - **Does NOT validate platform** — user_list.users items in schema (lines ~1360–1370) have no platform property, so additionalProperties=false would reject it if sent
  - User_list CSV upload (`dashboard-client/CsvUpload.js:24`): Parses exactly **3 columns** — userid, pageid, shortcode — and rejects if != 3; **platform never present**

**Preview/Dry-Run**:
- `api/handlers.go:PreviewBail` — calls `query.BuildQuery` for conditions, returns `query.BuildQuery` SQL
- For user_list: no query, returns user list directly (documented in `documentation/bail-systems.md:822-835`)
- Preview does not report platform resolution problems; it would need to resolve credentials to do so (out of scope for current validation)

---

## 5. Failure Semantics

**Panic Recovery** (`executor.go:93-106`):
- `processBail` wrapped in `defer/recover` (line 95)
- Any panic caught, logged, recorded as error event (line 98-104)
- Panic does not stop executor; next bail processed

**Error Isolation**:
- **Bail-level** (line 82-85): Loop continues on error; one bad bail doesn't stop others
- **Timing check failure** (line 135-137): Recorded as error event; bail skipped for this tick
- **Query failure** (line 155-158): Recorded as error event; bail skipped
- **Send failure** (line 177-184): 
  - If some sends fail but some succeed: `lastError` tracked, event still recorded with `usersMatched` and `usersBailed` counts
  - Partial success is allowed; event reflects actual bailed count
  - Return error to caller if any sends failed, but continue processing other bails

**Per-Target Failure**:
- Current code: sender loops targets (line 123-149 `SendBailouts`); one target's send failure logged but does not stop others
- Bailed IDs collected (line 138: `bailedIDs = append(...)`)
- Last error tracked; return all bailed IDs + error (line 152-156)

**Example Sequence** (immediate bail, first tick):
1. Load bail
2. Timing check passes (immediate = always ready)
3. Query 1000 users
4. Send to 999 (success), 1 fails (network error)
5. Record event with `users_matched: 1000, users_bailed: 999, no error field` (success event, not error event)
6. Return error to caller (line 152-154) but continue to next bail

**Re-execution on Failure**:
- Immediate bail: fires again next tick (no deduplication)
- Scheduled bail: skipped for the rest of the 24h window (line 101 `GetLastSuccessfulExecution` checks dedup)
- Absolute bail: fires next tick if timing still matches (only once after target datetime)
- On repeated failure, no backoff; immediate bails retry every minute

---

## 6. Tests

**Test Files**:
- `types/types_test.go` — validation of conditions, user lists, execution timing
- `query/builder_test.go` — SQL generation (string matching, no DB needed)
- `query/db_integration_test.go` — execute SQL against live DB; tests account-scoped CTEs, OR semantics, regression guards for LEFT JOIN fix
- `query/example_test.go` — golden-file style examples
- `db/bails_test.go`, `db/events_test.go` — CRUD operations (needs DB)
- `db/test_helpers.go:35` — `testPool()` creates connection to `postgres://root@localhost:5433/chatroach` (hardcoded; override with `TEST_DATABASE_URL`)
- `executor/executor_test.go` — executor logic (mocks db/query/sender)
- `sender/sender_test.go` — sender (mocks HTTP)
- `api/handlers_test.go` — REST handlers (mocks DB)
- `examples_test.go` — JSON marshaling round-trip

**Style**:
- Table-driven tests (e.g., `query/builder_test.go`)
- Mock interfaces for testability (executor uses BailStore, QueryExecutor, BailSender interfaces)
- Integration tests skip automatically when DB unreachable (`query/db_integration_test.go` calls `t.Skipf`)
- **Trap**: `db/test_helpers.go` calls `log.Fatal` on DB error, so `db` package tests fail hard without DB (unlike `query` which skips)

**Running Tests**:
```bash
# Start test DB (CockroachDB on 5433, migrations applied)
make test-db

# Run unit tests (no DB needed)
go test ./... -skip TestIntegration

# Run all tests (-p 1 required; packages race on shared DB)
make test
# or: go test -count=1 -p 1 ./...

# Integration only
make test-integration

# Override DB URL (e.g., in CI)
TEST_DATABASE_URL=postgres://root@myhost:5433/chatroach make test
```

**All Passing** (2026-09-19, read-only run):
- `examples_test.go`: 6 JSON marshaling examples — PASS
- `api/*_test.go`: 13 handler tests (mocked DB) — PASS
- `executor/executor_test.go`: 2 unit tests — PASS
- `query/*_test.go`: skipped (no DB on test system)
- `db/*_test.go`: skipped (no DB on test system)

---

## 7. Other Code Paths Constructing Platform or UserList

**Dean** (`dean/queries.go`):
- Constructs synthetic events with platform (`dean/queries.go:12` `SyntheticEvent` has `Platform` field)
- Does NOT use `UserListEntry`; dean is a producer, not a bail creator
- Relevant to VIR-60 only as a *consumer* of exodus (posts bail definitions? No, dean reads bail_events for audit only)

**Dashboard Client**:
- **CSV Upload** (`dashboard-client/src/components/CsvUpload/CsvUpload.js:24`): Parses exactly 3 columns (userid, pageid, shortcode). No 4th column for platform. Rejects rows with wrong column count.
- **BailForm** (`dashboard-client/src/containers/BailSystems/BailForm.js`): Builds `definition.type: 'user_list', user_list: { users: userList }` from CSV-parsed users. No platform injection.

**Dashboard Server**:
- **REST Controller** (`dashboard-server/api/bails/bails.controller.js`): Proxies to exodus via `BailsUtil`. No platform validation or injection.
- **MCP** (`dashboard-server/api/mcp/mcp.core.js`):
  - `user_list.users` schema (lines ~1360–1370) has properties for userid, pageid, shortcode only
  - `additionalProperties: false` on user_list items, so a platform field would be rejected by MCP schema validation
  - `validateBailDefinition` function does NOT check platform
  - `buildBailRequest` (lines ~1520–1550) does NOT inject or validate platform

**Other Services** (grep for UserListEntry usage):
- Only exodus/types/types.go defines it
- Only exodus/executor/executor.go uses it (userListToTargets)
- No other service in the repo constructs UserListEntry directly

**Conclusion**: Platform for user_list bails can only come from:
1. Direct JSON POST to exodus `/users/:userId/bails` endpoint (only path that doesn't drop enabled flag; see `documentation/bail-systems.md:709-719`)
2. Nowhere else in the dashboard or MCP layer

---

## 8. Stored Bail Definitions & Existing Data

**Schema** (`devops/migrations/06-exodus-bails.sql:4-18`):
```sql
CREATE TABLE IF NOT EXISTS chatroach.bails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
  name STRING NOT NULL,
  description STRING,
  enabled BOOL NOT NULL DEFAULT true,
  definition JSONB NOT NULL,
  destination_form STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_bail_per_user UNIQUE (user_id, name),
  ...
);
```

**No Existing Bails in Repo**: Migration creates empty table; no seed data committed.

**Production Data Inaccessible**: Cannot inspect `vprod` via read-only tools. Would need:
```sql
SELECT COUNT(*) FROM chatroach.bails;
SELECT definition FROM chatroach.bails WHERE definition->'type' = '"user_list"' LIMIT 5;
-- Check for empty platform in user_list entries:
SELECT definition FROM chatroach.bails 
WHERE definition->'user_list'->'users'->0->>'platform' = '';
```

**Audit Trail** (`devops/migrations/06-exodus-bails.sql:20-35`):
- `bail_events` table has `definition_snapshot JSONB NOT NULL` (line 29)
- Captures full bail definition at execution time (exodus executor records it on every run)
- Can inspect historical bail configs via event history, but requires production DB access

---

## Doc Gaps

1. **exodus/README.md § Sender** (`README.md:261-279`):
   - States "Platform Data Sources" but doesn't warn that user_list platform is **unvalidated caller input**
   - Should document: user_list platform must be set by caller; conditions-based bails resolve it from states.platform with COALESCE fallback
   - Clarify that empty platform produces `"platform": ""` in synthetic event (currently just says "from query result" or "explicitly in user_list")

2. **documentation/bail-systems.md § "platform is required in practice"** (`§8, line 105-123`):
   - Documents the user_list platform gap well
   - But does not document that validation accepts omitting it (types/types.go doesn't check it)
   - Should clarify: validation passes, but downstream failure is certain for WhatsApp

3. **No mention of platform resolution hazard in exodus/README.md**:
   - Should note that conditions-based bails already handle platform correctly via COALESCE
   - User_list bails require caller to supply platform; no validation

