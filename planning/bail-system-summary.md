# Bail System - Executive Summary

**Created:** 2026-03-22
**Scope:** Understanding why "immediate" execution creates events every minute
**Status:** Complete investigation

---

## TL;DR

The bail system's exodus executor runs as a Kubernetes CronJob every minute. For bails with `timing: "immediate"`, the executor unconditionally executes them every time it runs, creating one new event per minute per enabled immediate bail. **This is intentional design, not a bug.**

There is **no deduplication or rate limiting at the execution level**. Rate limiting only applies when sending individual bailouts to botserver (1 per second). Duplicate bailouts rely entirely on downstream idempotency.

---

## Architecture at a Glance

### Three Execution Modes

```
"immediate"    → Always execute (every cron tick)
"scheduled"    → Execute at specific time of day (1x per 24 hours max)
"absolute"     → Execute once when time is reached (1x total, then never)
```

### Execution Flow

```
Kubernetes CronJob (every 60 seconds)
  └─ Spawn exodus --mode=executor pod
     └─ Load enabled bails
     └─ For each bail:
        ├─ Check shouldExecute() based on timing mode
        ├─ If true: Query, send bailouts, record event
        └─ If false: Skip, no event
  └─ Pod terminates
```

### Rate Limiting

**What exists:** 1-second delay between individual bailout sends
**What doesn't exist:** Cooldown between bail executions or per-user throttling
**Result:** Same user can be bailed every minute if they match a condition

---

## File Map

### Timing Logic
- **`exodus/executor/timing.go`** (lines 20-35)
  - `shouldExecute()` dispatch function
  - "immediate" returns `true` unconditionally
- **`exodus/executor/timing.go`** (lines 37-74)
  - "scheduled" implementation (time + 24hr guard)
- **`exodus/executor/timing.go`** (lines 76-104)
  - "absolute" implementation (datetime + once guard)

### Execution Loop
- **`exodus/executor/executor.go`** (lines 55-90)
  - `Run()` main loop
- **`exodus/executor/executor.go`** (lines 249-284)
  - `recordSuccess()` creates execution events
- **`exodus/executor/executor.go`** (lines 286-311)
  - `recordError()` creates error events

### Rate Limiting
- **`exodus/sender/sender.go`** (lines 106-146)
  - `SendBailouts()` applies 1s delay per user
- **`exodus/chart/values.yaml`** (line 24)
  - `EXODUS_RATE_LIMIT: "1s"` environment variable

### Deployment
- **`exodus/chart/values.yaml`** (line 31)
  - CronJob schedule: `"* * * * *"` (every minute)
- **`exodus/chart/templates/cronjob.yaml`** (line 10)
  - Uses schedule from values

### Database
- **`devops/migrations/06-exodus-bails.sql`** (lines 20-35)
  - `bail_events` table schema (no deduplication constraints)
- **`devops/migrations/12-bail-event-bailed-userids.sql`**
  - Added `execution_results` column for user IDs

---

## Key Code Snippets

### Why "Immediate" Always Executes

**File:** `exodus/executor/timing.go` lines 22-23
```go
case "immediate":
    return true
```

That's it. No parameters, no state check, always returns `true`.

### How Events Are Created

**File:** `exodus/executor/executor.go` lines 270-279
```go
event := &db.BailEvent{
    BailID:             &dbBail.ID,
    UserID:             dbBail.UserID,
    BailName:           dbBail.Name,
    EventType:          "execution",
    UsersMatched:       usersMatched,
    UsersBailed:        len(bailedIDs),
    DefinitionSnapshot: defJSON,
    ExecutionResults:   executionResults,  // JSON with user IDs
}
```

This is called after every successful execution, regardless of whether it's a repeat.

### Rate Limiting Between Sends

**File:** `exodus/sender/sender.go` lines 131-137
```go
if i < len(users)-1 && s.rateLimit > 0 {
    select {
    case <-ctx.Done():
        return bailedIDs, fmt.Errorf("context cancelled...")
    case <-time.After(s.rateLimit):  // 1 second default
    }
}
```

This delays 1 second between each user's bailout, but does NOT prevent the same bail from running again next minute.

---

## What's NOT There

**No execution-level deduplication:**
- No check like "don't run if we already ran in the last X minutes"
- No cooldown between consecutive executions
- No idempotency key system

**No per-user throttling:**
- No check like "don't bail the same user twice in 1 hour"
- No last-bailout timestamp lookup

**No database constraints:**
- The `bail_events` table has no UNIQUE constraint
- Same bail can have unlimited duplicate events

**No event cleanup:**
- Events accumulate forever
- No archival or retention policy

---

## Design Rationale

This is **intentional**. The system assumes:

1. **Real-time reactivity matters:** Bails with "immediate" timing need frequent checks
2. **Users' states change frequently:** Someone might match a condition in minute 1, get bailed, exit the condition, and re-enter in minute 2
3. **Downstream idempotency is available:** Botserver will recognize duplicate bailout events and handle them safely
4. **Cost of duplication is acceptable:** Sending the same bailout twice is cheaper than missing a user who re-qualified

This is similar to event-driven architectures where idempotency is a downstream concern.

---

## Database Events Growth

For every enabled "immediate" bail with matching users:
- **Events per minute:** 1
- **Events per hour:** 60
- **Events per day:** 1,440

If you have 10 immediate bails:
- **Daily event volume:** 14,400 events (all recorded in `bail_events` table)

This is why the table has indexes on `(bail_id, timestamp DESC)` and `(user_id, timestamp DESC)` — for efficient querying of event history.

---

## How to Verify This Behavior

### Check Event Frequency
```sql
SELECT
  bail_id,
  COUNT(*) as event_count,
  date_trunc('minute', timestamp) as minute
FROM chatroach.bail_events
WHERE event_type = 'execution'
GROUP BY bail_id, minute
ORDER BY minute DESC
LIMIT 100;
```

Expected for "immediate" bails: 1 row per minute per bail

### Check Event Contents
```sql
SELECT
  bail_name,
  timestamp,
  users_matched,
  users_bailed,
  execution_results
FROM chatroach.bail_events
WHERE event_type = 'execution'
ORDER BY timestamp DESC
LIMIT 10;
```

Expected: Different users or same users in sequential minutes, depending on condition matching

### Check for Duplicates
```sql
SELECT
  userid,
  COUNT(*) as bailed_times,
  min(timestamp) as first_time,
  max(timestamp) as last_time
FROM chatroach.bail_events be,
     jsonb_array_elements_text(be.execution_results->'user_ids') as userid
WHERE event_type = 'execution'
GROUP BY userid
HAVING COUNT(*) > 1
LIMIT 20;
```

Expected: Many users bailed multiple times (depending on condition matching)

---

## Implications for Users

### If You Have "Immediate" Bails:
- Expect high event volume (1 per minute)
- Expect some users to be bailed multiple times if conditions remain true
- Ensure botserver/destination forms handle duplicate bailouts safely

### If You Want Lower Event Volume:
- Change `timing` to `"scheduled"` (1 per 24 hours)
- Or use `"absolute"` for one-time events
- Or add logic to disable bails when they've achieved their goal

### If You Need Deduplication:
- Check if destination form can be idempotent (recommended)
- Or add application-level per-user cooldown logic
- Or query last bailout timestamp before executing

---

## Related Documentation

- **Full Technical Analysis:** `planning/bail-immediate-execution-findings.md`
- **Quick Reference Card:** `planning/bail-execution-modes-quick-ref.md`
- **System Architecture:** `planning/bail-system-architecture.md` (condition types, SQL)
- **Dashboard Docs:** `documentation/bail-systems.md` (user-facing features)

