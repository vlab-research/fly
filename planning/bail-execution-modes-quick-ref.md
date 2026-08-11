# Bail Execution Modes - Quick Reference Card

## Execution Modes Summary Table

| Mode | Timing Logic | Min Events | Max Events | Use Case | Cooldown |
|------|--------------|-----------|----------|----------|----------|
| **immediate** | Always true (executes every cron tick) | 1/min | 1/min | Real-time reactions | None |
| **scheduled** | Specific HH:MM daily + 24hr guard | 0-1/day | 1/day | Daily tasks | 24 hours |
| **absolute** | Current time >= datetime + once guard | 0 or 1 | 1 total | One-time events | One execution only |

---

## Immediate Execution Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Kubernetes CronJob ("* * * * *")                            │
│ Triggers every 60 seconds                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ↓
        ┌──────────────────────────┐
        │  Start Exodus Pod        │
        │  --mode=executor         │
        └──────────┬───────────────┘
                   │
                   ↓
      ┌────────────────────────────┐
      │ Load all enabled bails     │
      │ from database              │
      └──────────┬─────────────────┘
                 │
                 ↓
      ┌────────────────────────────────┐
      │ For each bail:                 │
      │ Check shouldExecute()          │
      └──────────┬─────────────────────┘
                 │
    ┌────────────┴────────────┐
    │                         │
    ↓ (immediate: always)     ↓ (scheduled: time+24hr check)
  TRUE                        │
    │                         │
    │                    ┌─────────┬──────────┐
    │                    │         │          │
    ↓                    ↓ TRUE    ↓ FALSE   │
  Execute          Execute     Skip       │
    │                    │       │        │
    ├─ Query users       │       │        │
    ├─ Send bailouts     │       │        │
    └─ Record event ◄────┘       │        │
       (execution or error)      │        │
                                 │        │
                            (continue)   │
                                 │        │
                                 └────────┘
                                      │
                                      ↓
                        ┌──────────────────────────┐
                        │ Pod terminates           │
                        │ Wait 60 seconds          │
                        │ Repeat                   │
                        └──────────────────────────┘
```

---

## "Immediate" Mode Details

### Code Path
```
timing.go line 22-23:
  case "immediate":
      return true
```

### What Gets Checked?
- **Only:** Bail's enabled status + definition validity
- **NOT checked:** Last execution time, time of day, cooldown

### Event Frequency
- **With 1-minute cron:** One event per minute per enabled immediate bail
- **With matching users:** `event_type: "execution"` with user counts
- **With zero users:** Still creates event (users_matched: 0)

### Database Query

The executor queries for matching users using bail's conditions:
```sql
SELECT userid, pageid FROM states WHERE (conditions)
```

Then for each user:
1. Send bailout to botserver (with 1s rate limit)
2. Add user ID to bailed list
3. Record one event with all bailed user IDs

### Rate Limiting

```
SendBailouts(users):
  for each user:
    SendBailout(user)
    sleep(1 second)  ← This rate limit
  return bailedIDs
```

**What this does:** Spreads individual bailouts 1s apart
**What this doesn't do:** Prevents the same user from being bailed in minute 1 AND minute 2

---

## Scheduled Mode Details

### Code Path
```
timing.go line 25-26:
  case "scheduled":
      return shouldExecuteScheduled(execution, now, lastExecution)
```

### Check Logic (timing.go lines 37-74)

```go
shouldExecuteScheduled(exec, now, lastExecution):
  ├─ Parse timezone
  ├─ Convert now to target timezone
  ├─ Parse time_of_day (HH:MM)
  ├─ If now.hour != target.hour: return false
  ├─ If now.minute != target.minute: return false
  ├─ If lastExecution within 24 hours: return false
  └─ return true
```

### Event Frequency
- **Best case:** 0 events (never matches time, or already ran today)
- **Expected case:** 1 event per 24 hours (matches time once, 24hr guard blocks again)
- **Max case:** 1 event per 24 hours per bail

### Example Configuration

```json
{
  "execution": {
    "timing": "scheduled",
    "time_of_day": "09:00",
    "timezone": "America/New_York"
  }
}
```

This executes once per day at 9:00 AM Eastern Time (adjusted for timezone).

### Minute-Precision Matching

The check is at minute precision, so `09:00` matches any second from `09:00:00` to `09:00:59`.

---

## Absolute Mode Details

### Code Path
```
timing.go line 28-29:
  case "absolute":
      return shouldExecuteAbsolute(execution, now, lastExecution)
```

### Check Logic (timing.go lines 76-104)

```go
shouldExecuteAbsolute(exec, now, lastExecution):
  ├─ Parse datetime (ISO 8601)
  ├─ If now < target_datetime: return false
  ├─ If lastExecution exists: return false
  └─ return true
```

### Event Frequency
- **Before trigger time:** 0 events
- **After trigger time (first time):** 1 event
- **After trigger time (every subsequent run):** 0 events (once-guard blocks it)

### Example Configuration

```json
{
  "execution": {
    "timing": "absolute",
    "datetime": "2026-03-25T14:30:00Z"
  }
}
```

This executes exactly once when the current time reaches March 25, 2026 at 2:30 PM UTC.

---

## Event Recording

### When Events Are Created

1. **Execution Event** (`event_type: "execution"`)
   - Recorded after successful bailout sends
   - Contains: users_matched, users_bailed, execution_results (user IDs)
   - Created in `executor.go` lines 270-279

2. **Error Event** (`event_type: "error"`)
   - Recorded when any error occurs during processing
   - Contains: error message, definition_snapshot
   - Created in `executor.go` lines 297-306

### Event Deduplication

**At Executor Level:** NONE
- Same bail can create multiple events in same minute
- Same user can be bailed multiple times

**At Database Level:** NONE
- No uniqueness constraint on (bail_id, timestamp)
- No check preventing duplicate events

**At Downstream Level:** ASSUMED
- Botserver is expected to be idempotent
- Same bailout event sent twice = idempotent operation

---

## Key Takeaways

1. **"Immediate" is HIGH FREQUENCY** — expect 1 event per minute per bail
2. **No built-in deduplication** — relies on downstream idempotency
3. **Rate limiting is per-user** — delays individual bailouts, not bail executions
4. **Events always accumulate** — no cleanup or archival configured
5. **CronJob is simple** — just triggers executor every minute, relies on bail configs for timing

---

## Testing Checklist

To understand the behavior in your system:

- [ ] Query `bail_events` table: `SELECT COUNT(*), date_trunc('minute', timestamp) FROM bail_events GROUP BY 2 ORDER BY 2 DESC;`
  - Expected: One row per minute per enabled immediate bail
- [ ] Check `users_bailed > 0` vs `event_type = 'execution'`
  - Expected: Both present for successful bailouts
- [ ] Look at `execution_results` JSON
  - Expected: Contains array of bailed user IDs
- [ ] Compare timestamps of events for same bail
  - Expected: Approximately 60 seconds apart
- [ ] Check if same users appear in multiple events
  - Expected: Yes, if their conditions still match

---

## Related Files

- **Full Findings:** `planning/bail-immediate-execution-findings.md`
- **Architecture:** `planning/bail-system-architecture.md` (condition types)
- **Source Code:**
  - Timing logic: `exodus/executor/timing.go`
  - Main loop: `exodus/executor/executor.go`
  - Rate limiting: `exodus/sender/sender.go`
  - Config: `exodus/chart/values.yaml`
  - CronJob template: `exodus/chart/templates/cronjob.yaml`

