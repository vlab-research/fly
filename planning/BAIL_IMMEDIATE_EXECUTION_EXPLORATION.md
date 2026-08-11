# Bail System "Immediate" Execution Mode - Complete Exploration

**Date:** 2026-03-22
**Status:** Complete Investigation
**Audience:** Build engineers, DevOps, technical decision-makers

---

## Executive Summary

The bail system uses a **Kubernetes CronJob that runs every minute** (`* * * * *` in Helm values). For bails configured with `timing: "immediate"`, the executor **unconditionally executes every time the cron job runs**, creating a new `bail_event` record each minute (if users match the conditions).

**This is by design, not a bug.** The "immediate" mode is intentional for real-time, reactive execution. However, there is **zero execution-level deduplication** — no rate limiting, no cooldown, and no prevention of duplicate bailouts to the same users. The system relies entirely on **downstream idempotency** (botserver state tracking) to prevent users from actually receiving duplicate messages.

---

## How Bail "Immediate" Execution Works

### The Core Logic

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/timing.go` (lines 22-23)

```go
func shouldExecute(execution *types.Execution, now time.Time, lastExecution *time.Time) bool {
	switch execution.Timing {
	case "immediate":
		return true  // ← Always returns true, ignores lastExecution
	case "scheduled":
		return shouldExecuteScheduled(execution, now, lastExecution)
	case "absolute":
		return shouldExecuteAbsolute(execution, now, lastExecution)
	}
}
```

**Key observation:** The `immediate` case has **zero branches, zero conditions, zero checks**. It always returns `true`. The `lastExecution` parameter is completely ignored.

### The Execution Loop

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 55-90)

Each minute, the CronJob spawns a pod running `exodus --mode=executor`:

```
Run(ctx context.Context) error
  ↓
  Load all enabled bails from database
  ↓
  For each bail:
    ├─ Parse bail definition JSON
    ├─ Get last successful execution timestamp (from DB)
    ├─ Call shouldExecute(..., timing, lastExecution)
    │
    │  [For immediate timing, this ALWAYS returns true]
    │
    ├─ If shouldExecute returns true:
    │   ├─ Query for matching users
    │   ├─ Send bailouts to botserver (with 1s rate limit per user)
    │   └─ Record execution event (even if zero users matched)
    │
    └─ If shouldExecute returns false:
        └─ Skip the bail (no event recorded)
```

### CronJob Configuration

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/chart/values.yaml` (lines 29-33)

```yaml
executor:
  enabled: true
  schedule: "* * * * *"  # Every minute (literally 60 times per hour)
  concurrencyPolicy: Forbid  # Prevent overlapping runs
  activeDeadlineSeconds: 3600  # 1 hour timeout per run
```

---

## Why "Immediate" Keeps Running Every Minute

### The Event Creation Pipeline

For each **enabled immediate bail**:

1. **Every 60 seconds:** CronJob triggers → new executor pod starts
2. **Execution check:** `shouldExecute()` returns `true` (always, for immediate)
3. **User query:** Execute SQL to find users matching the bail's conditions
4. **Event recording:** Record `bail_event` with:
   - `event_type: "execution"`
   - `users_matched: <count>`
   - `users_bailed: <count>`
   - `execution_results: {"user_ids": ["user1", "user2", ...]}`
   - `definition_snapshot: <full bail definition>`

**Result:** One execution event per minute per enabled immediate bail.

### Event Recording Details

**Files:**
- `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 250-283)

```go
func (e *Executor) recordSuccess(ctx context.Context, dbBail *db.Bail, bailDef *types.BailDefinition, usersMatched int, bailedIDs []string) {
	event := &db.BailEvent{
		BailID:             &dbBail.ID,
		UserID:             dbBail.UserID,
		BailName:           dbBail.Name,
		EventType:          "execution",           // ← Always "execution" for success
		UsersMatched:       usersMatched,          // ← Count of users matching the condition
		UsersBailed:        len(bailedIDs),        // ← Count of users bailed
		DefinitionSnapshot: defJSON,               // ← Full definition at time of execution
		ExecutionResults:   executionResults,      // ← {"user_ids": ["user1", ...]}
	}
	e.store.RecordEvent(ctx, event)  // ← Recorded every time
}
```

**Important note (line 157):** Even if **zero users match**, an execution event is still recorded:
```go
if usersMatched == 0 {
    e.recordSuccess(ctx, dbBail, &bailDef, 0, nil)  // Record event even with 0 users
    return nil
}
```

---

## What "Immediate" Means vs Other Modes

### Three Execution Modes

| Mode | How It Works | Frequency | Use Case |
|------|-------------|-----------|----------|
| **immediate** | Always returns true, executes on every cron tick | ~1 per minute | Real-time reactions, active user redirection |
| **scheduled** | Checks if current time matches HH:MM, AND 24+ hours since last execution | 0–1 per 24 hours | Daily tasks at specific time |
| **absolute** | Executes once when current time >= target datetime, then never again | 0 or 1 total | One-time events, launch dates |

### Timing Configuration Examples

**Immediate:**
```json
{
  "execution": {
    "timing": "immediate"
  }
}
```
No additional fields needed. Executes every minute.

**Scheduled:**
```json
{
  "execution": {
    "timing": "scheduled",
    "time_of_day": "09:00",
    "timezone": "America/New_York"
  }
}
```
Executes daily at 9:00 AM Eastern Time. The 24-hour guard prevents re-execution within 24 hours of the last successful run.

**Absolute:**
```json
{
  "execution": {
    "timing": "absolute",
    "datetime": "2026-03-25T14:30:00Z"
  }
}
```
Executes once when the clock reaches March 25, 2026 at 2:30 PM UTC. The "once guard" (checking `lastExecution != nil`) prevents any re-execution.

---

## Rate Limiting vs Deduplication

### What Exists: Per-User Rate Limiting

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/sender/sender.go` (lines 106-146)

```go
func (s *Sender) SendBailouts(ctx context.Context, users []UserTarget, metadata map[string]interface{}) ([]string, error) {
	var bailedIDs []string
	for i, user := range users {
		err := s.SendBailout(ctx, user.UserID, user.PageID, user.DestinationForm, metadata)
		if err != nil {
			lastError = err
		} else {
			bailedIDs = append(bailedIDs, user.UserID)
		}

		// Apply rate limiting (except after the last user)
		if i < len(users)-1 && s.rateLimit > 0 {
			select {
			case <-time.After(s.rateLimit):  // ← Default: 1 second
			}
		}
	}
	return bailedIDs, nil
}
```

**Configuration:** `/home/nandu/Documents/vlab-research/fly/exodus/chart/values.yaml` (line 24)
```yaml
env:
  - name: EXODUS_RATE_LIMIT
    value: "1s"  # 1 second between sends to each user
```

**What this does:**
- Delays 1 second between sending bailouts to individual users within a **single execution run**
- Prevents overwhelming botserver with 100 simultaneous requests
- Does **NOT** prevent the same user from being bailed multiple times in consecutive minutes

**What this does NOT do:**
- Does NOT prevent re-execution of the same bail
- Does NOT prevent the same user from being bailed twice
- Does NOT deduplicate events at the database level
- Does NOT prevent duplicate bailout messages

### What Does NOT Exist: Execution-Level Deduplication

**Zero deduplication mechanisms:**

1. **No per-bail cooldown:** A bail with `timing: "immediate"` has no way to say "wait N minutes before running again"
2. **No per-user throttling:** No check like "don't bail this user again if we bailed them in the last 5 minutes"
3. **No idempotency keys:** No UUID or fingerprint to prevent duplicate events in the database
4. **No database constraints:** The `bail_events` table has no unique constraint preventing duplicates

**Database schema:**
```sql
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

  -- Indexes for efficient querying, NOT for deduplication
  INDEX idx_bail_events_bail (bail_id, timestamp DESC),
  INDEX idx_bail_events_user (user_id, timestamp DESC),
  INDEX idx_bail_events_timestamp (timestamp DESC)
);
```

**Observation:** No `UNIQUE` constraint on `(bail_id, timestamp)` or similar. Same bail can have unlimited events at the same minute.

---

## What Prevents vs Doesn't Prevent Repeated Execution

### Prevents Repeated Execution (Built-in)

**Scheduled & Absolute modes only:**
- **Scheduled:** 24-hour guard prevents re-execution within 24 hours
- **Absolute:** Once guard (checking if `lastExecution != nil`) prevents any second execution

**For immediate mode:** Nothing prevents re-execution.

### Does NOT Prevent Repeated Execution (Immediate Mode)

1. **No cooldown:** Immediate bails execute every minute without exception
2. **No idempotency:** Same user can be bailed multiple times
3. **No database guard:** Same event can be recorded multiple times
4. **No event deduplication:** Database accepts unlimited duplicates

**Test evidence:**
File: `/home/nandu/Documents/vlab-research/fly/exodus/executor/timing_test.go` (lines 10-50)

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
			want:          true,  // ← Always true
		},
		{
			name:          "executed 1 minute ago",
			lastExecution: timePtr(time.Now().Add(-1 * time.Minute)),
			want:          true,  // ← Ignores lastExecution
		},
		{
			name:          "executed 1 day ago",
			lastExecution: timePtr(time.Now().Add(-24 * time.Hour)),
			want:          true,  // ← Always true regardless
		},
	}
}
```

All test cases return `true`, confirming the `lastExecution` timestamp is completely ignored for immediate timing.

---

## Event Creation and Tracking

### When Events Are Created

**Two types of events:**

#### 1. Execution Event (Success)
**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 250-283)

Created when:
- Bail executes (timing conditions met)
- Query either succeeds or returns zero users
- Bailouts are sent successfully OR partially successfully

Contains:
- `event_type: "execution"`
- `users_matched: <count>`
- `users_bailed: <count of successful sends>`
- `execution_results: {"user_ids": [...]}`
- `definition_snapshot: <full bail JSON>`

#### 2. Error Event
**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 286-311)

Created when:
- Bail definition is invalid JSON
- Query fails
- Bailout sends fail entirely

Contains:
- `event_type: "error"`
- `error: {"message": "...error details..."}`
- Other fields (users_matched, users_bailed) set to 0

### Frequency of Event Creation

**For a single enabled immediate bail with matching users:**

| Time | Action | Events Created |
|------|--------|-----------------|
| Minute 1, 00:00 | CronJob runs, immediate returns true, 5 users match | 1 execution event (users_matched: 5, users_bailed: 5) |
| Minute 1, 00:60 | CronJob runs again, immediate returns true, 5 users match | 1 execution event (total: 2 events) |
| Minute 2, 01:20 | CronJob runs, immediate returns true, 4 users match (one left) | 1 execution event (users_matched: 4, users_bailed: 4, total: 3 events) |

**The events keep accumulating.**

### No Database Constraints Preventing Duplicates

The schema has **no uniqueness constraint** preventing multiple events for the same bail at the same timestamp. Examples of what's allowed:

```sql
-- All of these can coexist in the database
INSERT INTO bail_events (bail_id, user_id, event_type, ...)
  VALUES (bail-123, user-456, 'execution', ...);  -- Minute 1
INSERT INTO bail_events (bail_id, user_id, event_type, ...)
  VALUES (bail-123, user-456, 'execution', ...);  -- Minute 2 (same bail, same user!)
INSERT INTO bail_events (bail_id, user_id, event_type, ...)
  VALUES (bail-123, user-456, 'execution', ...);  -- Minute 3
```

---

## The Scheduling Loop

### CronJob to Pod Lifecycle

```
┌────────────────────────────────────┐
│ Kubernetes CronJob (* * * * *)     │
│ Fires every 60 seconds             │
└────────────────────┬───────────────┘
                     │
                     ↓
        ┌────────────────────────┐
        │ Create Job from spec   │
        │ image: vlabresearch/   │
        │   exodus:latest        │
        │ args: --mode=executor  │
        └────────────┬───────────┘
                     │
                     ↓
        ┌────────────────────────────────┐
        │ Pod starts                     │
        │ Runs exodus main.go            │
        │ Parses mode=executor           │
        │ Calls executor.Run()           │
        └────────────┬───────────────────┘
                     │
                     ↓
        ┌────────────────────────────┐
        │ Load enabled bails (all)   │
        │ For each bail:             │
        │  - shouldExecute() check   │
        │  - Query + Send            │
        │  - Record event            │
        └────────────┬───────────────┘
                     │
                     ↓
        ┌────────────────────────────┐
        │ Pod exits (success or fail)│
        │ Cleanup                    │
        └────────────────────────────┘
                     │
                     ↓
        ┌─────────────────────────────┐
        │ Wait 60 seconds             │
        │ (concurrencyPolicy: Forbid) │
        │ Prevents overlapping runs   │
        └────────────────────────────┘
                     │
                     ↓
        ┌────────────────────────────┐
        │ Repeat (fire next minute)  │
        └────────────────────────────┘
```

### No Cross-Run State

Each pod execution is **completely stateless** except for:
1. Reading the database (enabled bails, last execution times)
2. Writing to the database (new events, updated timestamps)

There is **no in-memory state** carried between runs. A bail that executed at 00:00 and 00:01 has no knowledge of each other — they're separate pod invocations.

---

## Key Source Files and Line Numbers

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Immediate timing check | `/home/nandu/Documents/vlab-research/fly/exodus/executor/timing.go` | 22-23 | Returns `true` unconditionally |
| Scheduled timing check | `/home/nandu/Documents/vlab-research/fly/exodus/executor/timing.go` | 37-74 | Checks HH:MM + 24-hour guard |
| Absolute timing check | `/home/nandu/Documents/vlab-research/fly/exodus/executor/timing.go` | 76-104 | Checks datetime + once guard |
| Main executor loop | `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` | 55-90 | Loads bails, checks timing, processes each |
| Bail processing | `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` | 93-180 | Query, send, record for single bail |
| Event recording (success) | `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` | 250-283 | Records execution event |
| Event recording (error) | `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` | 286-311 | Records error event |
| Rate limiting | `/home/nandu/Documents/vlab-research/fly/exodus/sender/sender.go` | 106-146 | 1s delay per user (per run) |
| CronJob schedule | `/home/nandu/Documents/vlab-research/fly/exodus/chart/values.yaml` | 29-33 | `schedule: "* * * * *"` |
| Rate limit config | `/home/nandu/Documents/vlab-research/fly/exodus/chart/values.yaml` | 23-24 | `EXODUS_RATE_LIMIT: "1s"` |
| DB schema | `/home/nandu/Documents/vlab-research/fly/devops/migrations/06-exodus-bails.sql` | 20-35 | `bail_events` table structure |
| Immediate tests | `/home/nandu/Documents/vlab-research/fly/exodus/executor/timing_test.go` | 10-50 | Confirms always returns true |
| Executor tests | `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor_test.go` | 214-262 | Test for immediate bail execution |

---

## Implications & Answers to Your Questions

### Question 1: How does "immediate" execution work?

**Answer:** The function `shouldExecute()` in `timing.go` line 22-23 unconditionally returns `true` for `timing: "immediate"`. No state is checked; the bail executes every time the cron job runs (every 60 seconds by default). The `lastExecution` timestamp is fetched from the database but never used for immediate bails.

### Question 2: Why does it keep running every minute?

**Answer:** By design. The Kubernetes CronJob runs every minute (`* * * * *` schedule), and immediate bails have no logic to prevent re-execution. The cron loop is simple:
- Load enabled bails
- For each, call `shouldExecute()`
- If true, execute and record event
- Pod exits, wait 60 seconds, repeat

### Question 3: What triggers bail re-execution / the scheduling loop?

**Answer:** Kubernetes CronJob controller triggers every minute. There is no re-execution trigger based on user conditions or business logic. The schedule is hardcoded in Helm values and controlled entirely by CronJob semantics.

### Question 4: What prevents duplicate runs?

**Answer:** **For "immediate" bails: Nothing.** There is zero prevention:
- No cooldown between executions
- No idempotency key system
- No database constraints preventing duplicate events
- No per-user throttling

**Rate limiting exists only per user within a single execution run.** The same user can be bailed in minute 1 and minute 2 if they still match the bail's conditions.

**Prevention is delegated to downstream systems:** Botserver is expected to be idempotent, meaning receiving the same bailout event twice should be a no-op.

---

## Current Behavior Summary

1. **CronJob runs every 60 seconds** with `concurrencyPolicy: Forbid` (no overlaps)
2. **Immediate bails execute unconditionally** on every run
3. **One event per execution** is created, even if zero users match
4. **No deduplication at executor or database level** — relying on botserver idempotency
5. **Events accumulate rapidly** — expect 1,440 events per day per enabled immediate bail (60 per hour × 24 hours)
6. **Same users can be bailed multiple times** if their conditions continue to match
7. **Rate limiting (1s per user) only spreads sends within a single run**, doesn't prevent re-execution

---

## Related Documentation

- **Full findings:** `planning/bail-immediate-execution-findings.md` (previous comprehensive analysis)
- **Quick reference:** `planning/bail-execution-modes-quick-ref.md` (mode comparison table)
- **Architecture:** `planning/bail-system-architecture.md` (condition types, SQL generation)
- **User-facing docs:** `documentation/bail-systems.md` (UI behavior, API endpoints)

