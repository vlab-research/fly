# Exodus Test Infrastructure Improvements Roadmap

## Current State Assessment

**Strengths:**
- 40+ database integration tests with real DB
- Solid helper functions (`TestPool`, `Before`, `SetupTestUser`)
- Unit tests with mocks (executor, sender, API)
- Good error handling patterns
- No external testing framework dependencies

**Weaknesses:**
- Hard-coded test database connection (localhost:5433)
- No transaction-based test isolation
- No CI/CD pipeline
- No docker-compose for local testing
- Tests must run sequentially (shared database)
- No automated migration running

## Improvement Roadmap

### Phase 0: Understand Current Gap (DONE)
✅ Document test patterns and database setup
✅ Create integration test quick-start guide
✅ Identify missing pieces

### Phase 1: Make Tests Database-Agnostic (Priority: HIGH)

**Goal:** Allow tests to run against any database (local, CI, cloud)

#### Change 1.1: Configurable Test Database Connection

**File:** `db/test_helpers.go`

**Current:**
```go
func TestPool() *pgxpool.Pool {
    config, err := pgxpool.ParseConfig("postgres://root@localhost:5433/chatroach")
    // ...
}
```

**Proposed:**
```go
func TestPool() *pgxpool.Pool {
    host := os.Getenv("TEST_DB_HOST")
    if host == "" {
        host = "localhost"
    }
    port := os.Getenv("TEST_DB_PORT")
    if port == "" {
        port = "5433"
    }
    database := os.Getenv("TEST_DB_NAME")
    if database == "" {
        database = "chatroach"
    }
    user := os.Getenv("TEST_DB_USER")
    if user == "" {
        user = "root"
    }
    password := os.Getenv("TEST_DB_PASSWORD")

    var connStr string
    if password != "" {
        connStr = fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable",
            user, password, host, port, database)
    } else {
        connStr = fmt.Sprintf("postgres://%s@%s:%s/%s?sslmode=disable",
            user, host, port, database)
    }

    config, err := pgxpool.ParseConfig(connStr)
    if err != nil {
        log.Fatal(err)
    }

    ctx := context.Background()
    pool, err := pgxpool.ConnectConfig(ctx, config)
    if err != nil {
        log.Fatal(err)
    }

    return pool
}
```

**Environment Variables:**
- `TEST_DB_HOST` (default: localhost)
- `TEST_DB_PORT` (default: 5433)
- `TEST_DB_NAME` (default: chatroach)
- `TEST_DB_USER` (default: root)
- `TEST_DB_PASSWORD` (default: empty)

**Benefits:**
- CI can point to test database
- Local tests can use any CockroachDB instance
- No code changes needed to run against different databases

#### Change 1.2: Transaction-Based Test Isolation

**File:** `db/test_helpers.go` (new function)

**Add:**
```go
// TestTx wraps a test transaction that auto-rolls back after test
type TestTx struct {
    t   testing.TB
    ctx context.Context
    tx  pgx.Tx
    pool *pgxpool.Pool
}

// Begin starts a transaction for the test
func BeginTestTx(t testing.TB, pool *pgxpool.Pool) *TestTx {
    ctx := context.Background()
    tx, err := pool.Begin(ctx)
    if err != nil {
        t.Fatalf("Failed to begin transaction: %v", err)
    }

    // Register cleanup
    t.Cleanup(func() {
        if err := tx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
            t.Logf("Failed to rollback transaction: %v", err)
        }
    })

    return &TestTx{
        t:    t,
        ctx:  ctx,
        tx:   tx,
        pool: pool,
    }
}

// Pool returns a pool-like interface backed by the transaction
func (tt *TestTx) Exec(ctx context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error) {
    return tt.tx.Exec(ctx, sql, args...)
}

func (tt *TestTx) Query(ctx context.Context, sql string, args ...interface{}) (pgx.Rows, error) {
    return tt.tx.Query(ctx, sql, args...)
}

func (tt *TestTx) QueryRow(ctx context.Context, sql string, args ...interface{}) pgx.Row {
    return tt.tx.QueryRow(ctx, sql, args...)
}
```

**Usage:**
```go
func TestBailCreation(t *testing.T) {
    pool := TestPool()
    defer pool.Close()

    // Start transaction, auto-rollback on cleanup
    testTx := BeginTestTx(t, pool)

    // Use transaction as normal pool
    db := &DB{pool: testTx}
    // ... test code ...
    // Transaction auto-rolls back after test
}
```

**Benefits:**
- Each test runs in isolation
- No data persists between tests
- Tests can run in parallel
- No manual cleanup needed
- Automatic on test failure

**Caveat:** DB methods need to accept an interface, not *pgxpool.Pool. Alternative: Create a "TransactionAwareBail" wrapper.

**Simpler alternative:** Keep current `Before()` but wrap it in a transaction:
```go
func BeforeWithTx(pool *pgxpool.Pool, txFunc func() error) error {
    ctx := context.Background()
    tx, err := pool.Begin(ctx)
    if err != nil {
        return err
    }
    defer tx.Rollback(ctx)

    // Run test function
    err = txFunc()
    if err != nil {
        return err
    }

    // Auto-rollback on defer
    return nil
}
```

### Phase 2: Local Test Environment (Priority: HIGH)

**Goal:** Allow developers to run tests locally without manual setup

#### Change 2.1: Docker Compose for Tests

**File:** `exodus/test.docker-compose.yml`

```yaml
version: '3.8'

services:
  cockroachdb:
    image: cockroachdb/cockroach:latest
    ports:
      - "5433:26257"  # SQL interface
    command: start-single-node --insecure
    environment:
      COCKROACH_SKIP_ENABLING_DIAGNOSTIC_REPORTING: 'true'
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health?ready=1"]
      interval: 1s
      timeout: 1s
      retries: 10
    volumes:
      - cockroach_data:/cockroach/cockroach-data

  initdb:
    image: cockroachdb/cockroach:latest
    depends_on:
      cockroachdb:
        condition: service_healthy
    volumes:
      - ../devops/migrations:/migrations:ro
    command: |
      /bin/bash -c '
      set -e
      echo "Creating database..."
      cockroach sql --insecure --host=cockroachdb --port=26257 < /migrations/01-init.sql || true
      echo "Running exodus migrations..."
      cockroach sql --insecure --host=cockroachdb --port=26257 < /migrations/06-exodus-bails.sql || true
      cockroach sql --insecure --host=cockroachdb --port=26257 < /migrations/12-bail-event-bailed-userids.sql || true
      echo "Database initialized!"
      '

volumes:
  cockroach_data:
```

**Usage:**
```bash
# Start test database
cd exodus/
docker compose -f test.docker-compose.yml up -d

# Run tests
go test ./db -v

# Cleanup
docker compose -f test.docker-compose.yml down
```

**Benefits:**
- Single command to start test database
- Migrations run automatically
- No manual setup
- Clean shutdown
- Works in CI and locally

#### Change 2.2: Makefile for Common Tasks

**File:** `exodus/Makefile`

```makefile
.PHONY: test-up test-down test test-race test-coverage clean

TEST_COMPOSE := docker compose -f test.docker-compose.yml

# Start test database
test-up:
	$(TEST_COMPOSE) up -d
	@sleep 2  # Give database time to initialize
	@echo "Test database ready on localhost:5433"

# Stop test database
test-down:
	$(TEST_COMPOSE) down -v

# Run tests
test: test-up
	@go test ./... -v
	@$(MAKE) test-down

# Run tests with race detector
test-race: test-up
	@go test ./... -v -race
	@$(MAKE) test-down

# Run tests with coverage
test-coverage: test-up
	@go test ./... -v -coverprofile=coverage.out
	@go tool cover -html=coverage.out -o coverage.html
	@$(MAKE) test-down
	@echo "Coverage report: coverage.html"

# Build binary
build:
	go build -o exodus .

# Clean build artifacts and coverage
clean:
	rm -f exodus coverage.out coverage.html
```

**Usage:**
```bash
make test           # Start DB, run tests, stop DB
make test-race      # Run with race detector
make test-coverage  # Generate coverage report
make test-up        # Start DB and leave running
make test-down      # Stop running DB
make build          # Build exodus binary
```

### Phase 3: Fixture Data & Seed Scripts (Priority: MEDIUM)

**Goal:** Reusable test data for common scenarios

#### Change 3.1: Fixture Files

**Directory:** `exodus/testdata/`

**File:** `exodus/testdata/fixtures.go`

```go
package testdata

import (
    "context"
    "encoding/json"
    "testing"

    "github.com/google/uuid"
    "github.com/jackc/pgx/v4/pgxpool"
    "github.com/vlab-research/exodus/db"
)

// Fixture holds reusable test data
type Fixture struct {
    UserID1 uuid.UUID
    UserID2 uuid.UUID
    BailID1 uuid.UUID
    BailID2 uuid.UUID
}

// Setup creates test data and returns fixture
func Setup(t testing.TB, pool *pgxpool.Pool) *Fixture {
    ctx := context.Background()
    d := &db.DB{pool: pool}

    fixture := &Fixture{
        UserID1: uuid.New(),
        UserID2: uuid.New(),
        BailID1: uuid.New(),
        BailID2: uuid.New(),
    }

    // Create users
    _, err := pool.Exec(ctx, `
        INSERT INTO chatroach.users (id, email) VALUES ($1, $2), ($3, $4)
    `, fixture.UserID1, "user1@example.com", fixture.UserID2, "user2@example.com")
    if err != nil {
        t.Fatalf("Failed to create users: %v", err)
    }

    // Create bails
    def := map[string]interface{}{
        "conditions": map[string]interface{}{"type": "form", "value": "test"},
        "execution":  map[string]interface{}{"timing": "immediate"},
        "action":     map[string]interface{}{"destination_form": "exit"},
    }
    defJSON, _ := json.Marshal(def)

    bail1 := &db.Bail{
        ID:              fixture.BailID1,
        UserID:          fixture.UserID1,
        Name:            "bail-1",
        Definition:      defJSON,
        DestinationForm: "exit-1",
        Enabled:         true,
    }
    bail2 := &db.Bail{
        ID:              fixture.BailID2,
        UserID:          fixture.UserID2,
        Name:            "bail-2",
        Definition:      defJSON,
        DestinationForm: "exit-2",
        Enabled:         true,
    }

    if err := d.CreateBail(ctx, bail1); err != nil {
        t.Fatalf("Failed to create bail 1: %v", err)
    }
    if err := d.CreateBail(ctx, bail2); err != nil {
        t.Fatalf("Failed to create bail 2: %v", err)
    }

    return fixture
}
```

**Usage:**
```go
func TestMultiBailScenario(t *testing.T) {
    pool := TestPool()
    defer pool.Close()
    Before(pool)

    fixture := testdata.Setup(t, pool)

    // Now you have ready-to-use bail IDs, user IDs, etc.
    // No ad-hoc setup needed
}
```

### Phase 4: CI/CD Pipeline (Priority: MEDIUM)

**Goal:** Automated testing on every push

#### Change 4.1: GitHub Actions Workflow

**File:** `.github/workflows/exodus-test.yml`

```yaml
name: Exodus Tests

on:
  push:
    branches: [main, develop]
    paths:
      - 'exodus/**'
      - '.github/workflows/exodus-test.yml'
  pull_request:
    branches: [main, develop]
    paths:
      - 'exodus/**'

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      cockroachdb:
        image: cockroachdb/cockroach:latest
        options: >-
          --health-cmd="curl -f http://localhost:8080/health?ready=1"
          --health-interval=1s
          --health-timeout=1s
          --health-retries=10
        ports:
          - 5433:26257
        env:
          COCKROACH_SKIP_ENABLING_DIAGNOSTIC_REPORTING: 'true'

    steps:
      - uses: actions/checkout@v3

      - name: Set up Go
        uses: actions/setup-go@v4
        with:
          go-version: '1.23'

      - name: Initialize database
        run: |
          docker run --rm \
            --network host \
            -v ${{ github.workspace }}/devops/migrations:/migrations:ro \
            cockroachdb/cockroach:latest \
            sql --insecure --host=localhost --port=5433 \
            < /migrations/06-exodus-bails.sql

          docker run --rm \
            --network host \
            -v ${{ github.workspace }}/devops/migrations:/migrations:ro \
            cockroachdb/cockroach:latest \
            sql --insecure --host=localhost --port=5433 \
            < /migrations/12-bail-event-bailed-userids.sql

      - name: Run tests
        working-directory: exodus
        run: go test ./... -v -race -coverprofile=coverage.out
        env:
          TEST_DB_HOST: localhost
          TEST_DB_PORT: 5433

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v3
        with:
          files: ./exodus/coverage.out
          flags: exodus
          fail_ci_if_error: false
```

**Usage:** Automatically runs on every push/PR to exodus/

### Phase 5: Test Coverage Targets (Priority: LOW)

**Goal:** Maintain and improve code coverage

#### Change 5.1: Coverage Baseline

**File:** `exodus/.coveragerc` (or Makefile target)

```makefile
test-coverage-check:
	@go test ./... -coverprofile=coverage.out
	@go tool cover -func=coverage.out | grep total | awk '{print $$3}' > coverage.txt
	@threshold=80; \
	coverage=$$(cat coverage.txt | sed 's/%//'); \
	if [ "$$(echo "$$coverage < $$threshold" | bc)" -eq 1 ]; then \
	  echo "Coverage $$coverage% below threshold $$threshold%"; \
	  exit 1; \
	fi
	@echo "Coverage: $$coverage% (threshold: $$threshold%)"
```

**Target:** 80% coverage for db/ package

### Phase 6: Parallel Test Safety (Priority: LOW)

**Goal:** Enable `go test -parallel N` for faster testing

**Approach:**
- Ensure test isolation via transactions (Phase 1.2)
- Add build flag for parallel tests: `make test-parallel`

**Makefile:**
```makefile
test-parallel: test-up
	@go test ./... -v -parallel 4 -race
	@$(MAKE) test-down
```

---

## Implementation Priority Matrix

| Phase | Feature | Priority | Effort | Impact | Owner |
|-------|---------|----------|--------|--------|-------|
| 1.1 | Configurable DB connection | HIGH | 30min | Enable CI | Next PR |
| 1.2 | Transaction isolation | HIGH | 2-3h | Safety + parallelism | Future feature |
| 2.1 | Docker Compose | HIGH | 1h | Local testing | Next PR |
| 2.2 | Makefile | HIGH | 30min | Convenience | Next PR |
| 3.1 | Fixture data | MEDIUM | 2h | Less boilerplate | Future feature |
| 4.1 | CI/CD workflow | MEDIUM | 2h | Automation | Next PR |
| 5.1 | Coverage targets | LOW | 1h | Quality gate | Future feature |
| 6.0 | Parallel tests | LOW | 1h | Speed | Future feature |

---

## Recommended Execution Order

### Week 1: Enable Local & CI Testing
1. Implement Phase 1.1 (configurable DB)
2. Implement Phase 2.1 (docker-compose)
3. Implement Phase 2.2 (Makefile)
4. Add Phase 4.1 (GitHub Actions)

**Result:** Developers can run `make test` locally, CI runs on every PR

### Week 2: Improve Test Quality
1. Implement Phase 1.2 (transaction isolation)
2. Implement Phase 3.1 (fixtures)
3. Add Phase 5.1 (coverage targets)

**Result:** Better test isolation, reusable data, coverage tracking

### Week 3+: Polish
1. Implement Phase 6.0 (parallel tests)
2. Document all changes
3. Update test README

---

## Estimated Total Effort

- Phase 1.1: 30 minutes
- Phase 1.2: 2-3 hours (requires careful testing)
- Phase 2.1: 1 hour
- Phase 2.2: 30 minutes
- Phase 3.1: 2 hours
- Phase 4.1: 2 hours
- Phase 5.1: 1 hour
- Phase 6.0: 1 hour

**Total: 10-11 hours** for complete testing infrastructure

---

## Files to Create/Modify

### New Files
- `exodus/test.docker-compose.yml`
- `exodus/Makefile`
- `exodus/testdata/fixtures.go`
- `.github/workflows/exodus-test.yml`

### Modified Files
- `exodus/db/test_helpers.go` (add configurable connection, transaction wrapper)

### Documentation
- `exodus/README.md` (update testing section)
- `planning/exodus-test-infrastructure-findings.md` (this file)

---

## Success Criteria

✅ Developers can run `make test` without manual setup
✅ Tests run in CI on every PR
✅ Tests support database configuration via env vars
✅ Tests can run in parallel
✅ Code coverage is tracked
✅ New developers can add tests easily

Once completed, the exodus test infrastructure will be on par with modern Go projects.
