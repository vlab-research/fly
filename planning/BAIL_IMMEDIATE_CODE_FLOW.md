# Bail System "Immediate" Execution - Code Flow Reference

**Date:** 2026-03-22
**Purpose:** Visual reference for code paths, execution flow, and event creation

---

## Entry Point: Main CronJob Execution

```
Kubernetes CronJob Controller (wallclock every 60 seconds)
│
└─→ Create Job from CronJob spec
    │
    └─→ Pod: vlabresearch/exodus:latest
        │
        └─→ exodus --mode=executor
            │
            └─→ main.go (parses flags)
                │
                └─→ executor.Run(ctx) ← Entry to our code
```

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/executor.go` line 55

```go
func (e *Executor) Run(ctx context.Context) error {
    now := time.Now()
    log.Printf("Starting bail execution run at %s", now.Format(time.RFC3339))

    // Load enabled bails
    bails, err := e.store.GetEnabledBails(ctx)
    if err != nil {
        return fmt.Errorf("failed to load enabled bails: %w", err)
    }

    // Process each bail
    for _, bail := range bails {
        if err := e.processBail(ctx, bail, now); err != nil {
            log.Printf("Error processing bail %s (%s): %v", bail.Name, bail.ID, err)
            // Continue with next bail
        }
    }

    log.Printf("Completed bail execution run")
    return nil
}
```

---

## Core Decision Point: shouldExecute()

```
For each enabled bail from database:
│
├─→ processBail(ctx, bail, now)
    │
    ├─→ Parse bail.Definition JSON
    ├─→ Get lastExecution timestamp from DB
    │
    └─→ shouldExecute(&bail.Execution, now, lastExecution) ← DECISION
        │
        ├─ If timing == "immediate"  ──→ return true ← ALWAYS
        │
        ├─ If timing == "scheduled"  ──→ Check HH:MM + 24hr guard
        │
        └─ If timing == "absolute"   ──→ Check datetime >= now + never-executed guard
```

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/timing.go` line 20-35

```go
func shouldExecute(execution *types.Execution, now time.Time, lastExecution *time.Time) bool {
    switch execution.Timing {
    case "immediate":
        return true  // ← THIS IS IT - Always executes

    case "scheduled":
        return shouldExecuteScheduled(execution, now, lastExecution)

    case "absolute":
        return shouldExecuteAbsolute(execution, now, lastExecution)

    default:
        return false
    }
}
```

**The key insight:** The `lastExecution` parameter is available but not used for "immediate". It's completely ignored.

---

## Execution Path: After shouldExecute Returns true

```
If shouldExecute() returns true:
│
└─→ processBail() continues (executor.go line 144)
    │
    ├─→ queryUsers(ctx, bail, &bailDef)
    │   │
    │   ├─ If conditions-based:
    │   │   └─→ Build SQL query from conditions
    │   │       └─→ Execute query against states/responses tables
    │   │           └─→ Return list of matching UserTarget structs
    │   │
    │   └─ If user_list-based:
    │       └─→ Convert pre-defined users to UserTarget structs
    │           └─→ Return (skip query execution)
    │
    ├─→ Check if any users matched
    │   │
    │   └─ If 0 users:
    │       └─→ recordSuccess(ctx, bail, def, 0, nil) ← Event recorded even with zero users!
    │           └─→ Return nil (success, but no bailouts sent)
    │
    ├─→ Apply limit if configured
    │
    ├─→ sender.SendBailouts(ctx, users, metadata)
    │   │
    │   ├─→ For each user in list:
    │   │   ├─→ SendBailout(ctx, userID, pageID, destinationForm, metadata)
    │   │   │   └─→ POST to botserver/synthetic with JSON payload
    │   │   │
    │   │   └─→ If not last user:
    │   │       └─→ time.After(1s) ← Rate limit between users
    │   │
    │   └─→ Return bailedIDs list
    │
    └─→ recordSuccess(ctx, bail, &bailDef, usersMatched, bailedIDs) ← Always called
        │
        └─→ store.RecordEvent(ctx, &BailEvent{...})
            │
            └─→ INSERT into bail_events table
```

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/executor.go` lines 144-179

---

## Event Creation: recordSuccess()

```
recordSuccess(ctx, dbBail, bailDef, usersMatched, bailedIDs)
│
├─→ Marshal bailDef back to JSON
│   └─→ Store as definition_snapshot in event
│
├─→ Build execution_results JSON
│   └─→ {"user_ids": ["user1", "user2", ...]}
│
└─→ Create BailEvent struct:
    │
    ├─ event_type: "execution"
    ├─ users_matched: <count of matched users>
    ├─ users_bailed: <count of successful bailouts>
    ├─ definition_snapshot: <full bail definition JSON>
    └─ execution_results: {"user_ids": [...]}
        │
        └─→ store.RecordEvent(ctx, event) ← INSERT into bail_events
            │
            └─→ Database query:
                INSERT INTO chatroach.bail_events (
                    id, bail_id, user_id, bail_name, event_type,
                    users_matched, users_bailed, definition_snapshot,
                    execution_results, timestamp
                ) VALUES (...)
```

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` lines 250-283

```go
func (e *Executor) recordSuccess(ctx context.Context, dbBail *db.Bail, bailDef *types.BailDefinition, usersMatched int, bailedIDs []string) {
    defJSON, _ := json.Marshal(bailDef)

    var executionResults *json.RawMessage
    if bailedIDs != nil {
        raw, _ := json.Marshal(map[string]interface{}{"user_ids": bailedIDs})
        msg := json.RawMessage(raw)
        executionResults = &msg
    }

    event := &db.BailEvent{
        BailID:             &dbBail.ID,
        UserID:             dbBail.UserID,
        BailName:           dbBail.Name,
        EventType:          "execution",           // ← Always this for success
        UsersMatched:       usersMatched,
        UsersBailed:        len(bailedIDs),
        DefinitionSnapshot: defJSON,
        ExecutionResults:   executionResults,
    }

    if err := e.store.RecordEvent(ctx, event); err != nil {
        log.Printf("Warning: Failed to record success event for bail %s: %v", dbBail.Name, err)
    }
}
```

---

## Error Path: recordError()

```
If any error occurs at any step:
│
├─ Parse failure
├─ Query failure
├─ Send failure (partial or complete)
│
└─→ recordError(ctx, dbBail, err)
    │
    └─→ Create BailEvent struct:
        │
        ├─ event_type: "error"
        ├─ users_matched: 0
        ├─ users_bailed: 0
        ├─ error: {"message": "...error details..."}
        │
        └─→ store.RecordEvent(ctx, event) ← INSERT into bail_events
            │
            └─→ Database query:
                INSERT INTO chatroach.bail_events (...) VALUES (...)
```

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` lines 286-311

```go
func (e *Executor) recordError(ctx context.Context, dbBail *db.Bail, execErr error) {
    errorJSON := json.RawMessage(fmt.Sprintf(`{"message": "%s"}`, execErr.Error()))

    defJSON := json.RawMessage("{}")
    if dbBail.Definition != nil {
        defJSON = dbBail.Definition
    }

    event := &db.BailEvent{
        BailID:             &dbBail.ID,
        UserID:             dbBail.UserID,
        BailName:           dbBail.Name,
        EventType:          "error",                // ← Always "error" for failures
        UsersMatched:       0,
        UsersBailed:        0,
        DefinitionSnapshot: defJSON,
        Error:              &errorJSON,
    }

    if err := e.store.RecordEvent(ctx, event); err != nil {
        log.Printf("Warning: Failed to record error event for bail %s: %v", dbBail.Name, err)
    }
}
```

---

## Skip Path: Bail Not Ready to Execute

```
If shouldExecute() returns false (e.g., scheduled timing not at right time):
│
└─→ processBail() returns early (executor.go line 133)
    │
    ├─→ log.Printf("Bail %s not ready to execute (timing conditions not met)")
    │
    └─→ return nil
        │
        └─→ NO EVENT IS RECORDED
            (This is the only case where no event is created)
```

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` lines 131-134

```go
if !shouldExecute(&bailDef.Execution, now, lastExecution) {
    log.Printf("Bail %s not ready to execute (timing conditions not met)", dbBail.Name)
    return nil  // ← Exit early, no event recorded
}
```

---

## Rate Limiting: Per-User Spacing

```
When sending bailouts to multiple users:

SendBailouts(ctx, [user1, user2, user3, ...], metadata)
│
├─→ For i, user := range users {
    │
    ├─→ SendBailout(ctx, user.UserID, user.PageID, user.DestinationForm, metadata)
    │   │
    │   └─→ POST to botserver/synthetic
    │
    └─→ If i < len(users)-1 AND rateLimit > 0:
        │
        └─→ time.After(rateLimit)  ← Default 1 second
            │
            └─→ Sleep 1 second before next user
```

**This spacing is WITHIN a single execution run.** It doesn't prevent the same bail from running again in the next minute, or the same user from being bailed twice.

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/sender/sender.go` lines 131-137

```go
// Apply rate limiting (except after the last user)
if i < len(users)-1 && s.rateLimit > 0 {
    select {
    case <-ctx.Done():
        return bailedIDs, fmt.Errorf("context cancelled during rate limit: %w", ctx.Err())
    case <-time.After(s.rateLimit):  // ← 1 second default
    }
}
```

---

## Timeline Example: One "Immediate" Bail with 5 Matching Users

```
Time: 00:00 UTC
├─ CronJob ticks
├─ Pod starts
├─ shouldExecute() → true (immediate always)
├─ Query returns 5 users
├─ SendBailouts sends 5 bailouts:
│   ├─ user1 → botserver (0s)
│   ├─ wait 1s
│   ├─ user2 → botserver (1s)
│   ├─ wait 1s
│   ├─ user3 → botserver (2s)
│   ├─ wait 1s
│   ├─ user4 → botserver (3s)
│   ├─ wait 1s
│   └─ user5 → botserver (4s)
├─ recordSuccess() writes event to bail_events
└─ Pod exits
    │
    └─ Event in DB:
        event_type: "execution"
        users_matched: 5
        users_bailed: 5
        execution_results: {"user_ids": ["user1", "user2", "user3", "user4", "user5"]}
        timestamp: 2026-03-22 00:00:XX

Time: 00:01 UTC (60 seconds later)
├─ CronJob ticks again
├─ Pod starts
├─ shouldExecute() → true (immediate always, ignores last exec at 00:00)
├─ Query returns same 5 users (they still match the condition)
├─ SendBailouts sends 5 bailouts (same users again!)
├─ recordSuccess() writes ANOTHER event to bail_events
└─ Pod exits
    │
    └─ NEW event in DB (second event):
        event_type: "execution"
        users_matched: 5
        users_bailed: 5
        execution_results: {"user_ids": ["user1", "user2", "user3", "user4", "user5"]}
        timestamp: 2026-03-22 00:01:XX

Time: 00:02 UTC
├─ CronJob ticks again
├─ shouldExecute() → true (immediate always)
├─ Query returns 4 users (user1 left the condition)
├─ recordSuccess() writes THIRD event
└─ NEW event in DB:
    event_type: "execution"
    users_matched: 4
    users_bailed: 4
    execution_results: {"user_ids": ["user2", "user3", "user4", "user5"]}
    timestamp: 2026-03-22 00:02:XX

... continues every minute indefinitely until bail is disabled ...

After 1 day: 1,440 events in bail_events table
After 1 week: 10,080 events
After 1 month: ~43,200 events
```

**Note:** These are the **actual bailout events** going to botserver, not just database records. Each event is an HTTP POST.

---

## Database State After Multiple Runs

```sql
SELECT COUNT(*), event_type FROM bail_events GROUP BY event_type;

count | event_type
------+----------
1440  | execution  -- One per minute for 24 hours
   3  | error      -- Example: 3 errors on certain minutes

SELECT * FROM bail_events
WHERE bail_id = '...'
ORDER BY timestamp DESC
LIMIT 5;

id                                     | bail_id | user_id | event_type | users_matched | users_bailed | timestamp
------                                 +------   +------   +----------  +---------------+--------------+------
12345678-1234-1234-1234-123456789abc  | ...     | ...     | execution  | 5             | 5            | 2026-03-22 00:01:00
87654321-4321-4321-4321-987654321fed  | ...     | ...     | execution  | 5             | 5            | 2026-03-22 00:00:00
11111111-1111-1111-1111-111111111111  | ...     | ...     | execution  | 4             | 4            | 2026-03-21 23:59:00
```

**Key observation:** No uniqueness constraint. Different events can have identical (bail_id, users_matched, users_bailed) at different times.

---

## Configuration That Controls Timing

### CronJob Schedule (Helm)

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/chart/values.yaml`

```yaml
executor:
  schedule: "* * * * *"  # Every minute (cannot be changed per-bail)
```

Every * is (minute, hour, day-of-month, month, day-of-week)

Examples:
- `* * * * *` = Every minute (1,440 times per day)
- `*/5 * * * *` = Every 5 minutes (288 times per day)
- `0 * * * *` = Every hour on the :00 (24 times per day)
- `0 0 * * *` = Daily at midnight (1 time per day)

### Rate Limit (Environment Variable)

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/chart/values.yaml`

```yaml
env:
  - name: EXODUS_RATE_LIMIT
    value: "1s"
```

Controls spacing between users within a single run, not between runs.

---

## What Changes Between Runs

```
RUN 1 (00:00 UTC)
├─ lastExecution = nil (first run for this bail)
├─ Query returns [user1, user2, user3, user4, user5]
└─ Records event #1

RUN 2 (00:01 UTC)
├─ lastExecution = 2026-03-22 00:00:XX (from DB)
├─ [IGNORED FOR IMMEDIATE] ← This is the critical point
├─ Query returns [user1, user2, user3, user4, user5]
└─ Records event #2

RUN 3 (00:02 UTC)
├─ lastExecution = 2026-03-22 00:01:XX (updated in DB)
├─ [IGNORED FOR IMMEDIATE]
├─ Query returns [user2, user3, user4, user5] (user1 left)
└─ Records event #3
```

The `lastExecution` timestamp is retrieved from the database in every run, but for immediate timing, it's never consulted in the `shouldExecute()` function.

---

## Test Coverage for Immediate

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/timing_test.go` lines 10-50

```go
func TestShouldExecute_Immediate(t *testing.T) {
    tests := []struct {
        name          string
        lastExecution *time.Time
        want          bool
    }{
        { name: "no prior execution", lastExecution: nil, want: true },
        { name: "executed 1 minute ago", lastExecution: timePtr(time.Now().Add(-1 * time.Minute)), want: true },
        { name: "executed 1 hour ago", lastExecution: timePtr(time.Now().Add(-1 * time.Hour)), want: true },
        { name: "executed 1 day ago", lastExecution: timePtr(time.Now().Add(-24 * time.Hour)), want: true },
    }
}
```

**All scenarios return `true`**, demonstrating that immediate execution is unconditional.

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor_test.go` lines 214-262

```go
func TestExecutor_Run_ExecutesBail(t *testing.T) {
    bail := createTestBail(bailID, "immediate_bail", "immediate", nil, nil, nil)
    // ...
    executor.Run(context.Background())
    // ...
    if len(store.recordedEvents) != 1 {
        t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
    }
}
```

Each `Run()` creates exactly 1 event for each executed bail.

