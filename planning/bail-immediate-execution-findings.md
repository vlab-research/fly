# Bail System: Immediate Execution & Event Creation Analysis

**Date:** 2026-03-22
**Scope:** Understanding "immediate" execution mode, event creation frequency, scheduler/cron logic, and rate limiting/deduplication
**Target Audience:** Build agent investigating why "immediate" execution creates events every minute

---

## Executive Summary

The bail system runs as a **Kubernetes CronJob that executes every minute** (`* * * * *`). For bails with `timing: "immediate"`, the executor will **always execute** every time the cron job runs, creating a new bail event every minute. **No deduplication or rate limiting exists at the executor level** — rate limiting only applies to sending individual bailouts to botserver (1 per second by default).

The root cause of frequent "immediate" events is **by design**: the cron job runs every minute and always executes immediate bails. To prevent duplicate bailouts to the same users, you must rely on **downstream idempotency** (botserver state tracking) or add **application-level deduplication** in the executor.

---

## System Architecture

### Execution Modes (3 Types)

All bails have an `execution` field with a `timing` property. The executor checks timing before executing:

#### 1. "immediate" (Always Execute)
- **Behavior:** Returns `true` unconditionally (see `timing.go` lines 22-23)
- **Database Check:** Only reads the last successful execution timestamp; does NOT use it to prevent re-execution
- **Result:** Executes **every time the cron job runs**
- **Event Generation:** Creates one `execution` event per run (if users match)
- **Real-world Impact:** With 1-minute cron schedule, creates events every 60 seconds

**Code Reference:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/timing.go`
```go
case "immediate":
    return true
```

#### 2. "scheduled" (Daily at Specific Time)
- **Behavior:** Executes only at a specific time of day, maximum once per 24 hours
- **Configuration:** Requires `time_of_day` (HH:MM) and `timezone` (IANA format)
- **Check Logic:**
  - Parse time in target timezone
  - Check if current time's hour and minute match target time (minute precision)
  - Check if last execution was more than 24 hours ago
  - Return `true` only if all conditions met
- **Example:** `{"timing": "scheduled", "time_of_day": "09:00", "timezone": "America/New_York"}`
- **Event Generation:** At most one event per 24 hours per bail

**Code Reference:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/timing.go` lines 37-74

#### 3. "absolute" (One-Time Execution)
- **Behavior:** Executes once when current time >= specified datetime
- **Configuration:** Requires `datetime` (ISO 8601 format)
- **Check Logic:**
  - Parse datetime
  - Check if current time >= target time
  - Check if not already executed (guard: if `lastExecution` exists, return false)
  - Return `true` only if time passed and never executed
- **Example:** `{"timing": "absolute", "datetime": "2026-03-25T14:30:00Z"}`
- **Event Generation:** Exactly once, then never again

**Code Reference:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/timing.go` lines 76-104

---

## Execution Flow

### CronJob Configuration

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/chart/values.yaml` line 31
```yaml
executor:
  enabled: true
  schedule: "* * * * *"  # Every minute
  concurrencyPolicy: Forbid
  activeDeadlineSeconds: 3600  # 1 hour max
```

The Kubernetes CronJob template (`/home/nandan/Documents/vlab-research/fly/exodus/chart/templates/cronjob.yaml`) creates a Job every minute that runs the exodus executor with `--mode=executor` flag.

### Executor Main Loop

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/executor.go` lines 55-90

```
Run(ctx context.Context) error
  ↓
  Load all enabled bails from database
  ↓
  For each bail:
    ├─ Check timing conditions via shouldExecute()
    ├─ If timing allows:
    │   ├─ Parse bail definition JSON
    │   ├─ Get last successful execution timestamp
    │   ├─ Execute query to find matching users
    │   ├─ Send bailouts to botserver (with rate limiting)
    │   └─ Record execution event (success or error)
    └─ If timing doesn't allow:
        └─ Skip this bail (no event recorded)
```

**Key Points:**
- Each Run is independent — no cross-run state
- Event is always recorded if execution attempted (success or error)
- Event recording happens at line 281 (`e.store.RecordEvent(ctx, event)`)

### Event Creation

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` lines 249-284 and 286-311

Two types of events are recorded:

#### Execution Event (Success)
- **Recorded When:** Query executes successfully and bailouts are sent
- **Fields:**
  - `event_type: "execution"`
  - `users_matched`: Count of users matching the condition
  - `users_bailed`: Count of successful bailouts sent
  - `execution_results`: JSON with `{"user_ids": ["user1", "user2", ...]}`
  - `definition_snapshot`: Full bail definition at execution time
- **Example Event (lines 270-279):**
```go
event := &db.BailEvent{
    BailID:             &dbBail.ID,
    UserID:             dbBail.UserID,
    BailName:           dbBail.Name,
    EventType:          "execution",
    UsersMatched:       usersMatched,
    UsersBailed:        len(bailedIDs),
    DefinitionSnapshot: defJSON,
    ExecutionResults:   executionResults,
}
```

#### Error Event
- **Recorded When:** Any error occurs (parse failure, query failure, send failure)
- **Fields:**
  - `event_type: "error"`
  - `error`: JSON with error message
  - Other numeric fields set to 0
- **Note:** Error is recorded at line 308 but is NOT a fatal condition — executor continues with next bail

---

## Rate Limiting & Deduplication

### Rate Limiting (Sender Level Only)

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/sender/sender.go` lines 106-146

The `Sender.SendBailouts()` function applies rate limiting **between individual users**, not between bail executions:

```go
// Apply rate limiting (except after the last user)
if i < len(users)-1 && s.rateLimit > 0 {
    select {
    case <-ctx.Done():
        return bailedIDs, fmt.Errorf("context cancelled during rate limit...")
    case <-time.After(s.rateLimit):
    }
}
```

**Configuration:** `/home/nandu/Documents/vlab-research/fly/exodus/chart/values.yaml` line 24
```yaml
env:
  - name: EXODUS_RATE_LIMIT
    value: "1s"  # 1 second between sends to same user
```

**What This Does:**
- Delays 1 second between each individual user's bailout
- Does NOT prevent the same user from being bailed multiple times in consecutive minutes
- Does NOT prevent the same bail from executing multiple times

### No Execution-Level Deduplication

The executor has **zero built-in deduplication**:

1. **No per-bail cooldown:** No check preventing a bail from running twice within a time window
2. **No per-user throttling:** No check preventing the same user from being bailed twice
3. **No event deduplication:** Every execution creates a new event, even if it bails identical users
4. **No idempotency key system:** No UUID or fingerprinting to avoid duplicate bailout events

**Evidence:**
- `shouldExecute()` for "immediate" timing has **zero input parameters** except the execution config
- No state is passed except `lastExecution` (only used for "scheduled" and "absolute" modes)
- The executor relies entirely on downstream systems (botserver) for idempotency

### Database Schema (No Constraints)

**File:** `/home/nandu/Documents/vlab-research/fly/devops/migrations/06-exodus-bails.sql` lines 20-35

```sql
CREATE TABLE IF NOT EXISTS chatroach.bail_events (
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

  INDEX idx_bail_events_bail (bail_id, timestamp DESC) ...
);
```

**Observations:**
- No uniqueness constraint on `(bail_id, timestamp)` — same bail can have multiple events at same minute
- No check preventing duplicate bailouts within a time window
- Indexes support efficient querying but don't prevent duplicates

---

## Why "Immediate" Creates Events Every Minute

### The Flow

```
Kubernetes CronJob Tick (Every 60 seconds)
  ↓
  Pod starts with exodus --mode=executor
  ↓
  Load enabled bails
  ↓
  For "immediate" bail:
    shouldExecute(..., "immediate", ...) → ALWAYS returns true
    ↓
    Query for matching users
    ↓
    User1 matches → Send bailout → Record event
    ↓
  Pod terminates
  ↓
  1 minute later, repeat
```

### Why This Design

**Intentional:** The system assumes:
1. Bails with "immediate" timing are meant for real-time, reactive execution
2. External systems (botserver, downstream handlers) will be idempotent
3. Users may enter/exit matching conditions frequently, requiring frequent checks
4. The cost of re-processing is lower than the cost of missing users

**NOT a bug:** This is the documented contract of "immediate" timing mode.

---

## Test Coverage

### Immediate Execution Tests

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/timing_test.go` lines 10-50

```go
func TestShouldExecute_Immediate(t *testing.T) {
    tests := []struct {
        name          string
        lastExecution *time.Time
        want          bool
    }{
        {
            name:          "no prior execution",
            lastExecution: nil,
            want:          true,
        },
        {
            name:          "executed 1 minute ago",
            lastExecution: timePtr(time.Now().Add(-1 * time.Minute)),
            want:          true,
        },
        {
            name:          "executed 1 day ago",
            lastExecution: timePtr(time.Now().Add(-24 * time.Hour)),
            want:          true,
        },
    }
}
```

**Key Test:** All scenarios return `true`, confirming that immediate timing ignores the `lastExecution` timestamp.

### Executor Integration Test

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor_test.go` lines 214-250

```go
func TestExecutor_Run_ExecutesBail(t *testing.T) {
    bail := createTestBail(bailID, "immediate_bail", "immediate", nil, nil, nil)

    executor := New(store, query, sender, 100)
    err := executor.Run(context.Background())

    // Should have sent bailouts for both users
    if len(sender.sentBailouts) != 2 {
        t.Errorf("Expected 2 bailouts sent, got %d", len(sender.sentBailouts))
    }

    // Should have recorded a success event
    if len(store.recordedEvents) != 1 {
        t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
    }
}
```

Each `Run()` call creates exactly one event per executed bail.

---

## Bail Definition Example

### Immediate Execution Bail

From tests and API usage:

```json
{
  "type": "conditions",
  "conditions": {
    "type": "form",
    "value": "survey_form"
  },
  "execution": {
    "timing": "immediate"
  },
  "action": {
    "destination_form": "bailout_form",
    "metadata": {
      "reason": "user_stuck",
      "priority": "high"
    }
  }
}
```

**With CronJob running every minute:** This bail will execute every 60 seconds, querying for users on `survey_form` and bailing them to `bailout_form`, creating one event per execution.

---

## Key Files & Line References

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Timing Logic | `exodus/executor/timing.go` | 20-35 | `shouldExecute()` dispatch; immediate returns true |
| Scheduled Check | `exodus/executor/timing.go` | 37-74 | Minute-precision time matching + 24hr guard |
| Absolute Check | `exodus/executor/timing.go` | 76-104 | One-time execution logic |
| Main Loop | `exodus/executor/executor.go` | 55-90 | `Run()` function; iterates bails |
| Event Recording | `exodus/executor/executor.go` | 249-284 | `recordSuccess()` — writes execution event |
| Error Recording | `exodus/executor/executor.go` | 286-311 | `recordError()` — writes error event |
| Rate Limiting | `exodus/sender/sender.go` | 106-146 | `SendBailouts()` applies 1s delay per user |
| Sender Config | `exodus/chart/values.yaml` | 23-24 | EXODUS_RATE_LIMIT env var |
| CronJob Schedule | `exodus/chart/values.yaml` | 30-31 | `schedule: "* * * * *"` |
| CronJob Template | `exodus/chart/templates/cronjob.yaml` | 10 | Uses schedule from values |
| DB Schema | `devops/migrations/06-exodus-bails.sql` | 20-35 | No deduplication constraints |
| Timing Tests | `exodus/executor/timing_test.go` | 10-50 | Confirms immediate always returns true |
| Executor Tests | `exodus/executor/executor_test.go` | 214-250 | Confirms one event per execution |

---

## Answers to Research Questions

### 1. How is "Immediate" Execution Handled?

**Answer:** The `shouldExecute()` function (line 22-23 of `timing.go`) unconditionally returns `true` for `timing: "immediate"`. No state is checked; the bail executes every time the cron job runs.

**Implication:** With a 1-minute cron schedule, immediate bails execute every minute without fail.

### 2. What Creates Bail Events and How Frequently?

**Answer:** An **execution event** is created every time:
1. The CronJob runs (every 60 seconds)
2. A bail's timing conditions are met
3. The executor successfully queries for users (or gets zero users)

For "immediate" bails with matching users:
- **Frequency:** Every 60 seconds (one per cron tick)
- **Event Type:** `"execution"` with user counts and IDs
- **Recorded at:** `executor.go` line 281 in `recordSuccess()`

Error events are created when any step fails (validation, query, send).

### 3. Scheduler/Cron Logic

**Answer:** Simple and non-configurable at the executor level:
- **Trigger:** Kubernetes CronJob with schedule `"* * * * *"` (every minute)
- **Pod Lifecycle:** Each cron tick spawns a new pod running `exodus --mode=executor`
- **No State Carryover:** Each run is stateless; only database is consulted
- **Concurrency:** `concurrencyPolicy: Forbid` prevents overlapping runs
- **Timeout:** `activeDeadlineSeconds: 3600` (1 hour max per run)

### 4. Rate Limiting & Deduplication

**Answer:**

**Rate Limiting (Exists):**
- Applied **per user** when sending bailouts (1 second default)
- Implemented in `sender.go` lines 131-137
- Prevents overwhelming botserver with rapid-fire requests

**Execution-Level Deduplication (Does NOT Exist):**
- No cooldown between consecutive runs of the same bail
- No check preventing the same user from being bailed twice
- No idempotency keys or deduplication signatures
- **Relies entirely on downstream systems** (botserver state tracking)

**Database-Level Deduplication (Does NOT Exist):**
- `bail_events` table has no uniqueness constraint
- Can have unlimited duplicate events for same bail at same timestamp

---

## Implications & Recommendations

### Current Behavior
1. **"Immediate" bails are high-frequency** — expect one execution per minute per bail
2. **Events accumulate rapidly** — the `bail_events` table grows by N events per minute (where N = number of enabled immediate bails)
3. **Duplicate bailouts are possible** — if a user matches a condition in minute 1 and minute 2, they're bailed twice
4. **No built-in protection** — deduplication must happen in botserver or downstream systems

### If You Need to Reduce Event Creation
- Consider changing "immediate" bails to "scheduled" (daily at specific time)
- Or add application-level deduplication in the executor (check last bailout timestamp per user per bail)
- Or disable bails with `enabled: false` in the database

### If You Need to Prevent Duplicate Bailouts
- Ensure botserver is idempotent (already assumes this)
- Implement user-level throttling in the executor (add cooldown: "user was bailed X minutes ago")
- Use different destination forms to trigger different flows

---

## Related Documentation

- **Bail System Architecture:** `planning/bail-system-architecture.md` (condition types, SQL generation)
- **Quick Reference:** `planning/bail-events-quick-reference.md` (API examples, UI patterns)
- **Dashboard Docs:** `documentation/bail-systems.md` (user-facing features)

