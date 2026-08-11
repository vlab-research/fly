# Exodus Test Infrastructure Findings

**Date**: 2026-03-22
**Scope**: Complete analysis of test setup, patterns, and database integration testing requirements

## Executive Summary

The exodus codebase has **solid integration tests** with real database connections, but **no CI/CD pipeline** or docker-compose test infrastructure. All database tests assume a test database running at `localhost:5433`. Tests use the standard Go testing library with custom test helpers, mock implementations, and unit-level tests. No external testing frameworks (testify, ginkgo, etc.) are used.

## 1. Test Files Overview

### Database Integration Tests (Real DB Required)
- `/home/nandan/Documents/vlab-research/fly/exodus/db/events_test.go` - 462 lines
  - `TestRecordEvent()` - Tests event recording with execution results
  - `TestRecordErrorEvent()` - Tests error event storage
  - `TestGetEventsByBailID()` - Tests event retrieval filtered by bail
  - `TestGetEventsByUser()` - Tests user-scoped event retrieval with limit
  - `TestGetLastSuccessfulExecution()` - Tests last execution timestamp tracking

- `/home/nandu/Documents/vlab-research/fly/exodus/db/bails_test.go` - 277 lines
  - `TestCreateAndGetBail()` - CRUD test for bail creation and retrieval
  - `TestGetEnabledBails()` - Tests enabled/disabled filtering
  - `TestUpdateBail()` - Tests update with timestamp refresh
  - `TestDeleteBail()` - Tests deletion and error handling for non-existent records
  - `TestGetBailsByUser()` - Tests user-scoped bail retrieval

### Unit Tests (No DB Required)
- `/home/nandan/Documents/vlab-research/fly/exodus/types/types_test.go` - ~300 lines
  - JSON marshaling/unmarshaling of conditions
  - Simple condition tests (form, state, error_code)
  - Logical operator tests (and, or, not)
  - Round-trip serialization tests

- `/home/nandan/Documents/vlab-research/fly/exodus/query/builder_test.go` - ~150+ lines
  - SQL query generation from bail definitions
  - Tests for form, state, error_code, elapsed_time conditions
  - Logical operator SQL generation
  - Parameter binding validation

- `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor_test.go` - ~150+ lines
  - Mock implementations: `mockBailStore`, `mockQueryExecutor`, `mockBailSender`
  - Test helpers for creating test bail definitions
  - Timing-based execution tests

- `/home/nandu/Documents/vlab-research/fly/exodus/executor/timing_test.go` - Unit tests for timing logic

- `/home/nandu/Documents/vlab-research/fly/exodus/sender/sender_test.go` - ~200+ lines
  - `TestSendBailout_Success()` - Uses `httptest.Server` for mock HTTP endpoint
  - `TestSendBailout_ServerError()` - Error handling tests
  - `TestSendBailout_ContextCancellation()` - Context timeout tests

- `/home/nandu/Documents/vlab-research/fly/exodus/api/handlers_test.go` - ~100+ lines
  - Mock DB implementation for API testing
  - Request/response validation tests

- `/home/nandu/Documents/vlab-research/fly/exodus/examples_test.go` - ~119 lines
  - `TestExamplesJSONParsing()` - Validates example bail definitions
  - `TestExamplesPrettyPrint()` - Example introspection

### Query Tests
- `/home/nandu/Documents/vlab-research/fly/exodus/query/example_test.go` - Example-based tests
- `/home/nandu/Documents/vlab-research/fly/exodus/sender/example_test.go` - Example-based sender tests

## 2. Test Database Configuration

### Test Database Connection (`test_helpers.go`)

```go
// Hard-coded to localhost:5433
func TestPool() *pgxpool.Pool {
    config, err := pgxpool.ParseConfig("postgres://root@localhost:5433/chatroach")
    // ...
}
```

**Key observations:**
- Port `5433` is used (not the default `5432`)
- Database name: `chatroach`
- User: `root`
- No password authentication
- Assumes database is already running and accessible

### Helper Functions in `db/test_helpers.go`

| Function | Purpose |
|----------|---------|
| `TestPool()` | Creates a connection pool to test database |
| `MustExec()` | Executes SQL with test failure on error |
| `ResetDB()` | Clears data from specified tables |
| `Before()` | Resets exodus tables (bail_events, bails, surveys, users) before each test |
| `SetupTestUser()` | Creates a test user with generated UUID and email |
| `SetupTestSurvey()` | Creates test user + survey (backward compatibility) |
| `CreateTestBailDefinition()` | Returns a valid JSON bail definition for testing |

**Database cleanup pattern:**
```go
func Before(pool *pgxpool.Pool) {
    err := ResetDB(pool, []string{"bail_events", "bails", "surveys", "users"})
}
```

This pattern is used at the start of each integration test, but **cleanup is not atomic** - no transaction wrapping across test setup.

## 3. Testing Patterns & Conventions

### Pattern 1: Pool Setup + Cleanup
```go
func TestXxx(t *testing.T) {
    pool := TestPool()
    defer pool.Close()
    Before(pool)  // Reset tables

    // Create DB wrapper
    db := &DB{pool: pool}

    // Test...
}
```

**Used in:** All db integration tests
**Risk:** If test panics before `defer`, database is left dirty. No transaction rollback.

### Pattern 2: Manual Error Checking (No testify)
```go
if err != nil {
    t.Fatalf("Operation failed: %v", err)
}
if retrieved.ID != expected {
    t.Errorf("Expected %v, got %v", expected, retrieved.ID)
}
```

**Advantages:**
- Minimal dependencies
- Clear error paths
- Go standard library only

**Disadvantages:**
- Verbose assertions
- No helpful diffs on complex objects
- Hard to write assertion helpers

### Pattern 3: Mock Implementations
Executor and API tests define local mock types:
```go
type mockBailStore struct {
    bails         []*db.Bail
    recordedEvents []*db.BailEvent
    getBailsError  error
}

func (m *mockBailStore) GetEnabledBails(ctx context.Context) ([]*db.Bail, error) {
    if m.getBailsError != nil {
        return nil, m.getBailsError
    }
    return m.bails, nil
}
```

**Used for:** Unit testing executor and API logic without hitting the database

### Pattern 4: Table-Driven Tests
Used in `types_test.go` and `query/builder_test.go`:
```go
tests := []struct {
    name     string
    jsonStr  string
    wantErr  bool
    checkVal func(*Condition) bool
}{
    {"form condition", `{"type": "form", "value": "survey-123"}`, false, ...},
    // ...
}

for _, tt := range tests {
    t.Run(tt.name, func(t *testing.T) {
        // ...
    })
}
```

### Pattern 5: HTTP Mock Testing
Sender tests use Go's built-in `httptest.Server`:
```go
server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    // Capture and validate request
    body, _ := io.ReadAll(r.Body)
    json.Unmarshal(body, &receivedEvent)
    w.WriteHeader(http.StatusOK)
}))
defer server.Close()

sender := New(server.URL, 0, false)
err := sender.SendBailout(ctx, "user123", "page456", "exit-form", nil)
```

**No external mock libraries used** - just the standard library.

## 4. Go Dependencies (go.mod)

```
github.com/caarlos0/env/v6     v6.10.1  - Environment config parsing
github.com/google/uuid         v1.6.0   - UUID generation
github.com/jackc/pgconn        v1.14.3  - PostgreSQL connection protocols
github.com/jackc/pgx/v4        v4.18.3  - PostgreSQL driver (main)
github.com/labstack/echo/v4    v4.13.4  - HTTP framework (API mode)
```

**No testing framework dependencies:**
- ✅ No testify (assert, require, mock)
- ✅ No ginkgo/gomega (BDD)
- ✅ No sqlc or testcontainers (test DB setup)

## 5. Database Schema (Relevant Migrations)

### Migration 06: Initial Bails and Events Tables
**File:** `/home/nandu/Documents/vlab-research/fly/devops/migrations/06-exodus-bails.sql`

```sql
CREATE TABLE chatroach.bails (
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
  INDEX idx_bails_user (user_id) ...,
  INDEX idx_bails_enabled (enabled, user_id) ...
);

CREATE TABLE chatroach.bail_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bail_id UUID REFERENCES chatroach.bails(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  bail_name STRING NOT NULL,
  event_type STRING NOT NULL DEFAULT 'execution',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  users_matched INT NOT NULL DEFAULT 0,
  users_bailed INT NOT NULL DEFAULT 0,
  definition_snapshot JSONB NOT NULL,
  error JSONB,
  INDEX idx_bail_events_bail (bail_id, timestamp DESC) ...,
  INDEX idx_bail_events_user (user_id, timestamp DESC) ...,
  INDEX idx_bail_events_timestamp (timestamp DESC) ...
);
```

### Migration 12: Added execution_results Column
**File:** `/home/nandu/Documents/vlab-research/fly/devops/migrations/12-bail-event-bailed-userids.sql`

```sql
ALTER TABLE chatroach.bail_events
  ADD COLUMN IF NOT EXISTS execution_results JSONB;
```

**Schema observations:**
- `bails` has soft-delete via `enabled` flag, not hard delete
- `bail_events` are immutable logs (no UPDATE/DELETE in code)
- `execution_results` column added but not yet documented in README
- Indexes are well-designed for common queries (by bail, by user, by timestamp)

## 6. Database Access Patterns

### CRUD Methods in `db/bails.go`

```go
func (d *DB) GetEnabledBails(ctx context.Context) ([]*Bail, error)
func (d *DB) GetBailByID(ctx context.Context, id uuid.UUID) (*Bail, error)
func (d *DB) GetBailsByUser(ctx context.Context, userID uuid.UUID) ([]*Bail, error)
func (d *DB) CreateBail(ctx context.Context, bail *Bail) error
func (d *DB) UpdateBail(ctx context.Context, bail *Bail) error
func (d *DB) DeleteBail(ctx context.Context, id uuid.UUID) error
```

**Pattern:**
- All methods accept `context.Context` (respects cancellation)
- Error wrapping with `fmt.Errorf` + `%w` (supports error chaining)
- `pgx.ErrNoRows` explicitly checked and converted to custom "not found" messages
- Parameters passed to `pool.Query()` / `pool.QueryRow()` (auto-escaped)
- Helper functions `scanBail()` and `scanBails()` reduce code duplication

### Event Methods in `db/events.go`

```go
func (d *DB) RecordEvent(ctx context.Context, event *BailEvent) error
func (d *DB) GetEventsByBailID(ctx context.Context, bailID uuid.UUID) ([]*BailEvent, error)
func (d *DB) GetEventsByUser(ctx context.Context, userID uuid.UUID, limit int) ([]*BailEvent, error)
func (d *DB) GetLastSuccessfulExecution(ctx context.Context, bailID uuid.UUID) (*time.Time, error)
```

**Pattern:**
- Immutable event log (only INSERT and SELECT)
- Optional JSONB fields (`error`, `execution_results`) stored as `*json.RawMessage`
- Last execution query filters on `event_type = 'execution'` to ignore errors

### Query Method (Generic)

```go
func (d *DB) Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error) {
    rows, err := d.pool.Query(ctx, sql, args...)
    // ... scan into []map[string]interface{}
}
```

**Used by:** Executor to run dynamically-built queries against `states` table
**Note:** Returns untyped maps, allowing schema flexibility but losing compile-time safety

## 7. Database Connection Configuration

### Config Source (`config/config.go`)

```go
type Config struct {
    DbName     string `env:"CHATBASE_DATABASE" envDefault:"chatroach"`
    DbHost     string `env:"CHATBASE_HOST" envDefault:"localhost"`
    DbPort     int    `env:"CHATBASE_PORT" envDefault:"5433"`
    DbUser     string `env:"CHATBASE_USER" envDefault:"root"`
    DbPassword string `env:"CHATBASE_PASSWORD" envDefault:""`
}

func (c *Config) ConnectionString() string {
    if c.DbPassword != "" {
        return fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=disable",
            c.DbUser, c.DbPassword, c.DbHost, c.DbPort, c.DbName)
    }
    return fmt.Sprintf("postgres://%s@%s:%d/%s?sslmode=disable",
        c.DbUser, c.DbHost, c.DbPort, c.DbName)
}
```

**Key observations:**
- Default port `5433` (unusual - CockroachDB default is `26257`)
- `sslmode=disable` hardcoded (development-only)
- No retry/timeout configuration
- `caarlos0/env` parses environment variables with defaults

### Test Database Hardcoding

**ISSUE:** Tests hardcode connection to `localhost:5433` in `TestPool()`:
```go
func TestPool() *pgxpool.Pool {
    config, err := pgxpool.ParseConfig("postgres://root@localhost:5433/chatroach")
    // ...
}
```

**Problem:**
- Cannot override test database host/port via environment variables
- Tests fail if database is running on different host or port
- No way to run tests against CI database

## 8. Current CI/CD Setup

**Status: None Detected**

- No `.github/workflows/` CI configuration
- No `Makefile` with test targets
- No `test.yaml` or `docker-compose.test.yml` for exodus
- Parent directory has `test.sh` script that expects `{app}/test.yaml` but exodus has no such file

**Deployment structure:**
- Multi-stage `Dockerfile` (builds and runs exodus binary)
- Helm chart in `exodus/chart/` for Kubernetes deployment
- No local test orchestration layer

## 9. Missing Infrastructure for Integration Testing

### 1. Test Database Setup
**What's needed:**
- Docker Compose file (`test.docker-compose.yml`) with:
  - CockroachDB service on port 5433
  - Database initialization script to run migrations 06-12
  - Option to seed test data

**Why:** Currently tests assume database is already running. No local environment can spin up a fresh test DB.

### 2. Fixture/Seed Data
**What's missing:**
- No seed data scripts for `users` or `surveys` tables
- `SetupTestUser()` creates users ad-hoc (OK for unit tests, not optimal for integration suites)
- No fixtures for complex test scenarios (multi-user, multi-survey)

**Recommendation:**
- Create `testdata/` directory with JSON fixtures
- Load fixtures in setup/teardown hooks (could use `Before()` enhancement)

### 3. Test Isolation
**Current approach:**
- Manual table deletion via `ResetDB()` before each test
- Not atomic - if one test fails, subsequent tests run on dirty data
- No transaction rollback per test

**Better approach:**
- Wrap each test in a transaction
- Rollback after test completion (even on failure)
- Guarantees isolation without manual cleanup

### 4. Database Migrations in Tests
**What's missing:**
- No way to run migrations (06-12) as part of test setup
- Assumes schema already exists at `localhost:5433/chatroach`
- No migration runner in Go code (using raw SQL files)

**Recommendation:**
- Vendor migration files into codebase
- Add migration runner in test setup (e.g., golang-migrate or custom)

### 5. CI/CD Pipeline
**What's missing:**
- No GitHub Actions workflow to run tests
- No Docker build + push to registry
- No Helm chart deployment testing

**Needed for:**
- Automated test runs on PRs
- Building docker image on push
- Verifying Helm chart validity

## 10. Testing Best Practices Currently Followed

✅ **Good patterns:**
1. Integration tests use real database (not mocks) for db/ package
2. Unit tests use mocks for business logic (executor, sender)
3. Helper functions reduce duplication (`SetupTestUser`, `CreateTestBailDefinition`)
4. Table-driven tests for parametrized cases
5. HTTP testing uses standard library `httptest` (no external mocks)
6. Defer pool.Close() pattern prevents connection leaks
7. Error wrapping with context (`%w` verb)
8. Function-level context.Context for cancellation

❌ **Areas for improvement:**
1. No test database isolation (transaction-based or otherwise)
2. No CI/CD pipeline
3. Hard-coded database connection in tests
4. No `testify` or equivalent assertion helpers
5. No docker-compose for local test environment
6. No migration running as part of test setup
7. No seed data/fixtures beyond ad-hoc creation
8. Tests assume database exists (fail fast if not)
9. No parallel test execution safety (shared database)
10. No test coverage reporting

## 11. Running Tests Today

### Prerequisites
1. Start CockroachDB on `localhost:5433`
2. Create `chatroach` database
3. Run migrations 01-12 (from `/devops/migrations/`)

### Command
```bash
cd /home/nandu/Documents/vlab-research/fly/exodus
go test ./...
```

### Current Issues
- Tests will fail if database is not running
- Error messages are generic (not helpful if migrations are missing)
- No way to run tests in isolated environment
- Parallel test runs will conflict on shared database

## 12. Database Access Interface Summary

The `DB` type in `db/db.go` is used as:

1. **Bail CRUD** (API + executor use):
   - `GetEnabledBails()`, `GetBailByID()`, `GetBailsByUser()`
   - `CreateBail()`, `UpdateBail()`, `DeleteBail()`

2. **Event Recording** (executor use):
   - `RecordEvent()` - log execution or error
   - `GetEventsByBailID()` - retrieve event history per bail
   - `GetEventsByUser()` - retrieve user's recent events
   - `GetLastSuccessfulExecution()` - timing check before running bail

3. **Dynamic Queries** (executor use):
   - `Query()` - run dynamically-built SQL against `states` table

All methods follow the pattern: `func (d *DB) Method(ctx context.Context, ...) (..., error)`

---

## Recommendations for Adding Database Integration Tests

### Phase 1: Fix Test Isolation (Quick Win)
1. Modify `TestPool()` to accept host/port as parameters
2. Add environment variable overrides for test DB connection
3. Wrap each test in a transaction that rolls back after completion

### Phase 2: Add Docker Compose for Local Testing
1. Create `exodus/test.docker-compose.yml` with CockroachDB service
2. Add migration runner to init container
3. Update Makefile or test.sh to use it

### Phase 3: Add Integration Test Fixtures
1. Create `exodus/testdata/` directory with JSON fixtures
2. Add fixture loading utilities
3. Create test scenarios (multi-bail, multi-user)

### Phase 4: CI/CD Pipeline
1. Add GitHub Actions workflow for:
   - Running go test ./...
   - Building Docker image
   - Testing Helm chart
2. Set up test database on-demand in CI

### Phase 5: Improve Test Coverage
1. Add table-driven tests for edge cases
2. Test error scenarios more thoroughly
3. Add parallel-safe database tests

---

## Files Requiring Changes for Better Testing

| File | Change | Benefit |
|------|--------|---------|
| `db/test_helpers.go` | Make `TestPool()` configurable, add transaction wrapper | Isolation + flexibility |
| `db/db_test.go` (new) | Integration test suite with fixtures | Comprehensive coverage |
| `test.docker-compose.yml` (new) | Local test environment | Reproducible testing |
| `Makefile` (new) | Test targets and CI commands | Easy local testing |
| `testdata/` (new) | JSON fixtures and seed data | Consistent test data |
| `.github/workflows/test.yml` (new) | GitHub Actions CI pipeline | Automated testing |

---

## Conclusion

Exodus has **good foundation for testing** with integration tests, mocks, and table-driven test patterns. However, it lacks:
- Test environment automation (docker-compose, CI/CD)
- Test database isolation (transactions)
- Flexible configuration for test DB connections

Adding these would make the codebase more maintainable and enable safe parallel test execution. The absence of external testing frameworks (testify, ginkgo) keeps dependencies minimal but requires more verbose assertions.
