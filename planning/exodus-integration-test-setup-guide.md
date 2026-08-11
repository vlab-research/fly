# Exodus Integration Test Setup Guide

Quick reference for adding database integration tests to exodus.

## Current State

- Integration tests: `db/events_test.go` and `db/bails_test.go` (40+ test cases)
- Test DB: Hardcoded to `localhost:5433` in `TestPool()`
- Helper functions available: `TestPool()`, `Before()`, `SetupTestUser()`, `CreateTestBailDefinition()`
- **NO** test isolation (tests share database, delete tables between runs)
- **NO** CI/CD pipeline
- **NO** docker-compose setup

## What You Need to Know

### 1. Running Existing Tests

**Prerequisites:**
```bash
# Start CockroachDB on port 5433
docker run -d -p 5433:26257 cockroachdb/cockroach:latest start-single-node --insecure

# Create database and run migrations
psql postgres://root@localhost:5433/ < devops/migrations/06-exodus-bails.sql
psql postgres://root@localhost:5433/ < devops/migrations/12-bail-event-bailed-userids.sql
```

**Run tests:**
```bash
cd exodus/
go test ./db -v
```

### 2. Test Database Setup Pattern (Current)

```go
func TestXxx(t *testing.T) {
    // Create pool to localhost:5433/chatroach
    pool := TestPool()
    defer pool.Close()

    // Delete data from tables
    Before(pool)

    // Create DB wrapper
    db := &DB{pool: pool}

    // Create test user
    userID := SetupTestUser(t, pool)

    // Test code...
}
```

**Issues:**
1. Not atomic - if test panics, data stays in database
2. Hard-coded host/port - can't use CI database
3. Manual cleanup - error-prone
4. No transaction isolation - parallel tests would conflict

### 3. Database Tables Used in Tests

**Required for tests to pass:**
- `chatroach.users` - FK referenced by bails
- `chatroach.bails` - Main test table
- `chatroach.bail_events` - Event logging table
- `chatroach.surveys` - FK referenced by users (legacy, optional)

**Schema defined in:**
- `devops/migrations/06-exodus-bails.sql`
- `devops/migrations/12-bail-event-bailed-userids.sql`

### 4. Key Helper Functions

#### `TestPool()` - Gets database connection
```go
func TestPool() *pgxpool.Pool
// Returns: pgxpool.Pool to localhost:5433/chatroach
// Panics on connection failure
```

#### `Before()` - Resets test tables
```go
func Before(pool *pgxpool.Pool)
// Deletes from: bail_events, bails, surveys, users
// No transaction - not atomic
```

#### `SetupTestUser()` - Creates test user
```go
func SetupTestUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID
// Returns: uuid.UUID of created user
// Inserts into users table with generated email
```

#### `CreateTestBailDefinition()` - Valid JSON definition
```go
func CreateTestBailDefinition() json.RawMessage
// Returns: Valid bail definition JSON
// Structure: {conditions, execution, action}
```

#### `MustExec()` - Execute SQL with error handling
```go
func MustExec(t testing.TB, pool *pgxpool.Pool, sql string, args ...interface{}) pgconn.CommandTag
// Fails test if SQL fails
// Use for ad-hoc setup queries
```

### 5. Common Test Patterns

#### Pattern 1: Create and retrieve bail
```go
func TestCreateBail(t *testing.T) {
    pool := TestPool()
    defer pool.Close()
    Before(pool)

    userID := SetupTestUser(t, pool)
    db := &DB{pool: pool}

    bail := &Bail{
        UserID:           userID,
        Name:             "test-bail",
        Definition:       CreateTestBailDefinition(),
        DestinationForm:  "exit-form",
        Enabled:          true,
    }

    err := db.CreateBail(context.Background(), bail)
    if err != nil {
        t.Fatalf("CreateBail failed: %v", err)
    }

    retrieved, err := db.GetBailByID(context.Background(), bail.ID)
    if err != nil {
        t.Fatalf("GetBailByID failed: %v", err)
    }

    if retrieved.Name != bail.Name {
        t.Errorf("Expected name %s, got %s", bail.Name, retrieved.Name)
    }
}
```

#### Pattern 2: Record and retrieve events
```go
func TestRecordEvent(t *testing.T) {
    pool := TestPool()
    defer pool.Close()
    Before(pool)

    userID := SetupTestUser(t, pool)
    db := &DB{pool: pool}

    // Create bail first
    bail := &Bail{UserID: userID, Name: "test", ...}
    db.CreateBail(context.Background(), bail)

    // Record event
    event := &BailEvent{
        BailID:             &bail.ID,
        UserID:             userID,
        BailName:           bail.Name,
        EventType:          "execution",
        UsersMatched:       10,
        UsersBailed:        8,
        DefinitionSnapshot: bail.Definition,
    }

    err := db.RecordEvent(context.Background(), event)
    if err != nil {
        t.Fatalf("RecordEvent failed: %v", err)
    }

    // Verify ID and timestamp were generated
    if event.ID == uuid.Nil {
        t.Error("Expected event ID to be generated")
    }
    if event.Timestamp.IsZero() {
        t.Error("Expected timestamp to be generated")
    }
}
```

#### Pattern 3: Test error handling
```go
func TestDeleteNonexistentBail(t *testing.T) {
    pool := TestPool()
    defer pool.Close()
    Before(pool)

    db := &DB{pool: pool}

    err := db.DeleteBail(context.Background(), uuid.New())
    if err == nil {
        t.Error("Expected error for non-existent bail")
    }
}
```

### 6. Database Types

#### Bail
```go
type Bail struct {
    ID              uuid.UUID
    UserID          uuid.UUID  // FK to users
    Name            string     // Unique per user
    Description     string
    Enabled         bool
    Definition      json.RawMessage  // Bail definition JSON
    DestinationForm string
    CreatedAt       time.Time
    UpdatedAt       time.Time
}
```

#### BailEvent
```go
type BailEvent struct {
    ID                 uuid.UUID
    BailID             *uuid.UUID       // FK to bails, nullable
    UserID             uuid.UUID
    BailName           string           // Denormalized
    EventType          string           // "execution" or "error"
    Timestamp          time.Time
    UsersMatched       int
    UsersBailed        int
    DefinitionSnapshot json.RawMessage
    Error              *json.RawMessage // Null if no error
    ExecutionResults   *json.RawMessage // Added in migration 12
}
```

### 7. Common Assertions (No testify)

Since the codebase doesn't use testify, use standard Go testing:

```go
// Check error
if err != nil {
    t.Fatalf("Operation failed: %v", err)
}

// Check value equality
if result != expected {
    t.Errorf("Expected %v, got %v", expected, result)
}

// Check nil
if value == nil {
    t.Fatal("Expected non-nil value")
}

// Check slice length
if len(items) != 3 {
    t.Errorf("Expected 3 items, got %d", len(items))
}

// Check boolean
if !result {
    t.Error("Expected true")
}

// Check timestamp
if !timestamp.Equal(expected) {
    t.Errorf("Expected %v, got %v", expected, timestamp)
}
```

### 8. Database Methods You Can Test

**Bail CRUD:**
- `GetEnabledBails(ctx)` - Returns bails with enabled=true
- `GetBailByID(ctx, id)` - Single bail lookup
- `GetBailsByUser(ctx, userID)` - User's bails
- `CreateBail(ctx, bail)` - Insert, sets ID and timestamps
- `UpdateBail(ctx, bail)` - Update mutable fields, refreshes updated_at
- `DeleteBail(ctx, id)` - Delete, returns error if not found

**Event Logging:**
- `RecordEvent(ctx, event)` - Insert, sets ID and timestamp
- `GetEventsByBailID(ctx, bailID)` - Events for a bail, ordered by timestamp DESC
- `GetEventsByUser(ctx, userID, limit)` - User's recent events
- `GetLastSuccessfulExecution(ctx, bailID)` - Timestamp of last execution event (not error)

### 9. What NOT to Test

✅ **Do test:**
- Database CRUD operations (Create, Read, Update, Delete)
- Query filters (GetEnabledBails returns only enabled)
- Error cases (not found, constraint violations)
- Timestamp generation
- JSON serialization
- User scoping

❌ **Don't test:**
- SQL library behavior (pgx is well-tested)
- Network timeouts (use unit tests with mocks)
- Database connection pooling internals

### 10. Tips for Reliable Tests

1. **Always call `pool.Close()`** - Use defer to prevent connection leaks
2. **Call `Before()` first** - Resets tables before each test
3. **Create users before bails** - Bails have FK to users
4. **Use uuid.New()** - Don't hardcode UUIDs
5. **Use generated IDs** - Don't assume ID=1, test returns the generated ID
6. **Check timestamps** - Don't use `==`, use `.Equal()` or `time.Since()`
7. **Use context.Background()** - Tests should be quick, not test cancellation
8. **Don't assume data persists** - Each test starts with `Before()` reset

### 11. Example: Adding a New Test

**Scenario:** Test that UpdateBail increments updated_at

```go
func TestUpdateBailRefreshesTimestamp(t *testing.T) {
    pool := TestPool()
    defer pool.Close()
    Before(pool)

    userID := SetupTestUser(t, pool)
    db := &DB{pool: pool}

    // Create bail
    bail := &Bail{
        UserID:           userID,
        Name:             "original",
        Description:      "Original description",
        Enabled:          true,
        Definition:       CreateTestBailDefinition(),
        DestinationForm:  "exit-form",
    }
    err := db.CreateBail(context.Background(), bail)
    if err != nil {
        t.Fatalf("CreateBail failed: %v", err)
    }
    originalUpdatedAt := bail.UpdatedAt

    // Wait a bit to ensure timestamp difference
    time.Sleep(10 * time.Millisecond)

    // Update bail
    bail.Name = "updated"
    bail.Description = "Updated description"
    err = db.UpdateBail(context.Background(), bail)
    if err != nil {
        t.Fatalf("UpdateBail failed: %v", err)
    }

    // Verify timestamp changed
    if bail.UpdatedAt.Equal(originalUpdatedAt) {
        t.Error("Expected updated_at to change after update")
    }
    if !bail.UpdatedAt.After(originalUpdatedAt) {
        t.Errorf("Expected updated_at to be after original: %v vs %v",
            bail.UpdatedAt, originalUpdatedAt)
    }
}
```

---

## Quick Checklist for Adding Tests

- [ ] Import `context`, `testing`, `github.com/google/uuid`
- [ ] Create pool with `TestPool()`
- [ ] Defer `pool.Close()`
- [ ] Call `Before(pool)` to reset
- [ ] Create `DB` wrapper with pool
- [ ] Use `SetupTestUser()` for test user
- [ ] Use `CreateTestBailDefinition()` for bail JSON
- [ ] Use `context.Background()` for context
- [ ] Check errors with `if err != nil`
- [ ] Don't use hardcoded UUIDs
- [ ] Use `.Equal()` for timestamps, not `==`
- [ ] Clean up assertions (wrap in appropriate error prefix)

---

## Resources

- **Full findings**: `exodus-test-infrastructure-findings.md`
- **Test file examples**: `db/events_test.go`, `db/bails_test.go`
- **Database schema**: `devops/migrations/06-exodus-bails.sql`
- **Go documentation**: https://pkg.go.dev/testing
- **pgx documentation**: https://pkg.go.dev/github.com/jackc/pgx/v4
