# Bail System "Immediate" Execution - Quick Answers

**Date:** 2026-03-22
**TL;DR:** Immediate execution runs every minute, creates events every minute, has zero built-in deduplication.

---

## Your 4 Key Questions Answered

### 1. How does bail "immediate" execution work?

**Core logic:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/timing.go` line 22-23

```go
case "immediate":
    return true  // Always returns true, period
```

**The flow:**
1. CronJob fires every 60 seconds (`schedule: "* * * * *"` in Helm values)
2. Executor calls `shouldExecute(bail.execution, now, lastExecution)`
3. For immediate timing, this ALWAYS returns `true`
4. Queries for matching users, sends bailouts, records event
5. Pod exits
6. Wait 60 seconds, repeat

**The key insight:** The `lastExecution` timestamp is fetched but never used. Immediate bails ignore history.

---

### 2. Why might it keep running every minute and creating many events?

**It's not a bug — it's the design.**

- **CronJob schedule:** Every 60 seconds (non-negotiable in Helm values)
- **Timing check:** Always returns `true` for immediate (non-negotiable in code)
- **Event recording:** One event per execution run (line 281 in executor.go)

**For a single enabled immediate bail:**
- 1,440 events per day (60 per hour × 24 hours)
- Each event records: users_matched, users_bailed, definition_snapshot
- Events accumulate in `bail_events` table indefinitely (no archival or cleanup)

**This is intentional** because the system assumes:
- Immediate bails are for real-time, reactive execution
- Users may enter/exit matching conditions frequently
- External systems (botserver) will deduplicate/be idempotent

---

### 3. What triggers bail re-execution? The scheduling loop?

**Trigger:** Kubernetes CronJob controller (simple time-based trigger)

**Not a complex scheduler:**
- No job queue
- No event-driven system
- No condition-based re-triggers
- Just "every 60 seconds, start a pod"

**The loop:**
```
CronJob tick (every 60s)
  → Start executor pod
  → Load all enabled bails
  → For each bail: shouldExecute() → if true, execute
  → Record events
  → Pod exits
  → Repeat
```

**Concurrency control:** `concurrencyPolicy: Forbid` prevents overlapping runs. If a run takes longer than 60s, the next tick waits for it to finish.

---

### 4. What prevents/doesn't prevent repeated execution?

| Mechanism | Immediate | Scheduled | Absolute |
|-----------|-----------|-----------|----------|
| **Timing check** | Always true | Hour:minute match + 24hr guard | Once (datetime >= now + never-executed guard) |
| **Repeated execution** | ✗ Cannot prevent | ✓ Prevents (24hr cooldown) | ✓ Prevents (once guard) |
| **Database constraints** | None | None | None |
| **Event deduplication** | None | None | None |
| **Per-user throttling** | None | None | None |

### What EXISTS (Per-User Rate Limiting)

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/sender/sender.go` line 131-137

```go
if i < len(users)-1 && s.rateLimit > 0 {
    select {
    case <-time.After(s.rateLimit):  // Default: 1 second
    }
}
```

**What this does:** Delays 1 second between sending bailouts to **individual users within a single execution run**

**What this does NOT do:** Prevents the same bail from running twice in a row, or the same user from being bailed in minute 1 and minute 2

### What DOES NOT EXIST (Execution-Level Deduplication)

1. No "cooldown" setting like `"min_execution_interval": "5 minutes"`
2. No per-user throttling like "don't bail this user again for 1 hour"
3. No idempotency key system in the database
4. No uniqueness constraint preventing duplicate events
5. No event deduplication logic

**Result:** The same user can be bailed multiple times (in different minutes) if they continue to match the condition.

**Assumption:** Botserver/downstream systems are idempotent and will handle receiving the same bailout event multiple times.

---

## Evidence from Tests

### Immediate Always Returns True

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/timing_test.go` lines 10-50

All test cases return `true`:
```go
{
    name:          "no prior execution",
    lastExecution: nil,
    want:          true,  // Always true
},
{
    name:          "executed 1 minute ago",
    lastExecution: timePtr(time.Now().Add(-1 * time.Minute)),
    want:          true,  // Ignores history
},
{
    name:          "executed 1 day ago",
    lastExecution: timePtr(time.Now().Add(-24 * time.Hour)),
    want:          true,  // Always true regardless
},
```

### Executor Creates One Event Per Run

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/executor_test.go` lines 214-262

```go
func TestExecutor_Run_ExecutesBail(t *testing.T) {
    bail := createTestBail(bailID, "immediate_bail", "immediate", nil, nil, nil)
    // setup...
    err := executor.Run(context.Background())

    // One event per run
    if len(store.recordedEvents) != 1 {
        t.Fatalf("Expected 1 event recorded, got %d", len(store.recordedEvents))
    }
}
```

Each `Run()` call creates exactly 1 event.

---

## Configuration Files

### CronJob Schedule

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/chart/values.yaml` lines 29-33

```yaml
executor:
  enabled: true
  schedule: "* * * * *"  # Every minute
  concurrencyPolicy: Forbid  # No overlaps
  activeDeadlineSeconds: 3600  # 1 hour max per run
```

### Rate Limit Config

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/chart/values.yaml` lines 23-24

```yaml
env:
  - name: EXODUS_RATE_LIMIT
    value: "1s"  # Between users, not between executions
```

### Database Schema (No Deduplication)

**File:** `/home/nandan/Documents/vlab-research/fly/devops/migrations/06-exodus-bails.sql`

```sql
CREATE TABLE chatroach.bail_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bail_id UUID REFERENCES chatroach.bails(id),
  user_id UUID NOT NULL,
  bail_name STRING NOT NULL,
  event_type STRING NOT NULL DEFAULT 'execution',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  users_matched INT NOT NULL DEFAULT 0,
  users_bailed INT NOT NULL DEFAULT 0,
  definition_snapshot JSONB NOT NULL,
  error JSONB,

  INDEX idx_bail_events_bail (bail_id, timestamp DESC),
  INDEX idx_bail_events_user (user_id, timestamp DESC),
  INDEX idx_bail_events_timestamp (timestamp DESC)
  -- NO UNIQUE constraint!
);
```

**Key observation:** No `UNIQUE (bail_id, timestamp)` or similar constraint. Same bail can have unlimited events.

---

## Bottom Line

**Is it a bug?** No. **Is it the design?** Yes.

**What would you need to change to prevent frequent execution?**

Option A: Change timing mode from `immediate` to `scheduled` (daily) or `absolute` (one-time)

Option B: Add cooldown logic at the executor level (new feature):
```go
// Pseudocode
lastExecution := store.GetLastSuccessfulExecution(bailID)
if lastExecution != nil && time.Since(lastExecution) < 5*time.Minute {
    skip()  // Don't execute if run in last 5 minutes
}
```

Option C: Disable the bail via database: `UPDATE bails SET enabled = false WHERE id = ...`

---

## Files to Reference

- **Complete analysis:** `planning/BAIL_IMMEDIATE_EXECUTION_EXPLORATION.md`
- **Previous findings:** `planning/bail-immediate-execution-findings.md`
- **Mode comparison:** `planning/bail-execution-modes-quick-ref.md`
- **Source code:**
  - Timing logic: `/home/nandan/Documents/vlab-research/fly/exodus/executor/timing.go`
  - Executor main: `/home/nandan/Documents/vlab-research/fly/exodus/executor/executor.go`
  - Sender: `/home/nandan/Documents/vlab-research/fly/exodus/sender/sender.go`
  - Config: `/home/nandan/Documents/vlab-research/fly/exodus/chart/values.yaml`

