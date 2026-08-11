# Bail System Implementation Guide

**Purpose:** Practical guide for working with the bail system based on understanding of immediate execution, events, and rate limiting

---

## When to Use Each Execution Mode

### Use "immediate" When:
- **Goal:** React in real-time to condition changes
- **Example:** User is stuck on form → immediately offer bailout
- **Expect:** High event volume (1 per minute per bail)
- **Assumption:** Downstream can handle duplicate bailouts

**Real-world example:**
```json
{
  "name": "stuck_users_bailout",
  "conditions": {
    "type": "state",
    "value": "WAIT_EXTERNAL_EVENT"
  },
  "execution": {
    "timing": "immediate"
  },
  "action": {
    "destination_form": "offer_alternative"
  }
}
```

This checks every minute: "Who is stuck?" → "Bail all of them to offer_alternative"

### Use "scheduled" When:
- **Goal:** Run daily, weekly, or at specific times
- **Example:** Daily reminder at 9 AM, weekly followup, end-of-month cleanup
- **Expect:** Low event volume (0-1 per 24 hours)
- **Assumption:** Can wait for next scheduled window to recheck conditions

**Real-world example:**
```json
{
  "name": "morning_reminder",
  "conditions": {
    "op": "and",
    "vars": [
      {"type": "form", "value": "survey"},
      {"op": "not", "vars": [{"type": "state", "value": "END"}]}
    ]
  },
  "execution": {
    "timing": "scheduled",
    "time_of_day": "09:00",
    "timezone": "America/New_York"
  },
  "action": {
    "destination_form": "morning_nudge"
  }
}
```

This runs once per day at 9 AM Eastern: "Who hasn't finished?" → "Send morning nudge"

### Use "absolute" When:
- **Goal:** One-time event at a specific moment
- **Example:** Campaign launch, deadline approach, limited-time offer
- **Expect:** Single event (1 total, then nothing)
- **Assumption:** Timing and conditions are fixed at creation time

**Real-world example:**
```json
{
  "name": "campaign_launch",
  "conditions": {
    "type": "form",
    "value": "active_users"
  },
  "execution": {
    "timing": "absolute",
    "datetime": "2026-03-25T15:00:00Z"
  },
  "action": {
    "destination_form": "new_campaign"
  }
}
```

This runs exactly once on March 25 at 3 PM UTC: "Who's active then?" → "Launch campaign"

---

## Handling Duplicate Bailouts

### Scenario 1: User Matches "Immediate" Bail Twice in a Row

```
Minute 1: User is on form X → Execute bail → Bailout sent
Minute 2: User still on form X → Execute bail again → Bailout sent AGAIN
```

**Problem:** User gets bailed twice
**Solution:** Choose one approach below

#### Option A: Make Destination Form Idempotent (Recommended)

**What this means:** Sending the same bailout twice has the same effect as sending it once.

**Implementation in destination form logic:**
```
if (user was bailed to this form < 5 minutes ago) {
  skip (idempotent)
} else {
  process bailout
}
```

**Pros:** Handles all duplicate scenarios
**Cons:** Requires downstream logic

#### Option B: Add Per-User Cooldown in Executor

**Concept:** Don't bail the same user twice within X minutes

**Pseudocode:**
```
For immediate bail:
  Query users matching condition
  For each user:
    Check: Was this user bailed to this form < 60 minutes ago?
    If yes: Skip
    If no: Send bailout
```

**Would require:** New database column or query logic

**Pros:** Prevents duplicates at source
**Cons:** Requires code change to executor

#### Option C: Change to "Scheduled" Execution

**Concept:** Only execute once per 24 hours

**Pros:** Reduces event volume by 99%
**Cons:** May miss users who enter condition between scheduled times

---

### Scenario 2: Same Bail with Different Conditions

If a bail's conditions change between executions:
```
Minute 1: 100 users match → Bail all 100
Minute 2: Conditions updated to exclude old users → 50 new users match → Bail 50
```

**This is fine:** Different user sets, so no duplicate

---

### Scenario 3: CronJob Runs Twice Unexpectedly

If Kubernetes scheduler triggers the cron twice in 1 minute:
```
Execution A starts: Bail 100 users
Execution B starts (concurrent): Bail same 100 users
```

**Prevented by:** `concurrencyPolicy: Forbid` in CronJob config

This ensures only one executor pod runs at a time.

---

## Rate Limiting Behavior

### What Gets Rate Limited

**Between individual user sends:**
```
User 1 → bailout → sleep 1s
User 2 → bailout → sleep 1s
User 3 → bailout → sleep 1s (no sleep after last)
```

This prevents overwhelming botserver with rapid requests.

### What Doesn't Get Rate Limited

**Between bail executions:**
```
Minute 1: Execute bail A → send to 1000 users → takes ~16 minutes with 1s rate limit
Minute 2: Execute bail A again (while still sending from minute 1) → new execution starts
```

The rate limit is per-send within one execution, not between executions.

### Calculating Send Time

```
Total send time = (number_of_users - 1) * rate_limit_seconds

Examples:
- 10 users with 1s rate limit → 9 seconds
- 100 users with 1s rate limit → 99 seconds (~1.6 minutes)
- 1000 users with 1s rate limit → 999 seconds (~16.6 minutes)
```

**Important:** If send time exceeds the cron interval (60 seconds), multiple executions can overlap!

**Example timeline:**
```
T=00:00 - Minute 1 CronJob starts execution, begins sending 1000 users
T=00:30 - Still sending from minute 1...
T=01:00 - Minute 2 CronJob starts execution (minute 1 still sending)
T=16:39 - Minute 1 finishes
T=17:39 - Minute 2 finishes
```

---

## Event Volume Analysis

### Calculating Event Growth

```
Daily events = (number_of_enabled_immediate_bails) * (users_matching_per_run) * 1440

Examples:
- 1 immediate bail, 10 users match → 14,400 events/day
- 5 immediate bails, 50 users match each → 360,000 events/day
- 10 scheduled bails (not immediate) → 0-10 events/day
```

### Database Impact

```
Event size: ~1KB per event (includes JSON snapshots)
Storage growth: 14,400 events × 1KB = 14.4 MB/day for 1 bail

After 30 days: ~432 MB for 1 immediate bail
After 1 year: ~5.2 GB for 1 immediate bail
```

### Query Performance

The `bail_events` table has indexes on:
- `(bail_id, timestamp DESC)` — for getting events for a specific bail
- `(user_id, timestamp DESC)` — for getting events for a user
- `(timestamp DESC)` — for recent events across all bails

These indexes keep queries fast even with large tables.

---

## Configuration Checklist

### Before Creating an "Immediate" Bail

- [ ] **Understand the event volume**
  - Will this bail have 10 users per run? 1000? 100,000?
  - Calculate daily events and consider storage

- [ ] **Ensure idempotency downstream**
  - Can the destination form handle receiving the same bailout twice per minute?
  - Does it track "last bailout time" to prevent duplicate processing?

- [ ] **Set appropriate destination form**
  - Different destination = different bailout flow
  - Right destination = right user experience

- [ ] **Consider rate limit impact**
  - If > 60 users per run, send time exceeds cron interval
  - Multiple executions will overlap
  - Is that acceptable?

- [ ] **Monitor first few runs**
  - Check events table: How many users actually match?
  - Check execution_results: Are they the expected users?
  - Check botserver logs: Are bailouts being processed correctly?

- [ ] **Plan for growth**
  - What happens if conditions match 10x more users next month?
  - Events table will grow 10x faster
  - Queries will still be fast (due to indexes), but storage cost increases

---

## Troubleshooting Guide

### Problem: Too Many Events (Storage Growing Rapidly)

**Diagnosis:**
```sql
SELECT
  COUNT(*) as event_count,
  bail_name,
  date_trunc('hour', timestamp) as hour
FROM chatroach.bail_events
WHERE event_type = 'execution'
GROUP BY bail_name, hour
ORDER BY hour DESC, event_count DESC
LIMIT 20;
```

**Common Causes:**
1. Immediate bail with many matching users
2. Multiple immediate bails all matching > 100 users

**Solutions:**
1. Change to "scheduled" execution (1x per 24 hours)
2. Add more restrictive conditions to reduce user count
3. Move to user_list type with smaller audience
4. Archive old events (not currently implemented)

### Problem: Same User Bailed Multiple Times

**Diagnosis:**
```sql
SELECT
  jsonb_array_elements_text(execution_results->'user_ids') as user_id,
  COUNT(*) as bail_count,
  STRING_AGG(DISTINCT bail_name, ', ') as bail_names
FROM chatroach.bail_events
WHERE event_type = 'execution'
  AND execution_results IS NOT NULL
GROUP BY user_id
HAVING COUNT(*) > 1
ORDER BY bail_count DESC
LIMIT 20;
```

**Common Causes:**
1. Using "immediate" with same condition matching multiple times
2. User conditions become true again after becoming false
3. No idempotency in destination form

**Solutions:**
1. Add user-level cooldown (application logic)
2. Make destination form idempotent
3. Change to "scheduled" so less frequent

### Problem: Bail Not Executing

**Diagnosis:**
```sql
SELECT
  name,
  enabled,
  definition->>'timing' as timing,
  COUNT(*) as event_count,
  MAX(timestamp) as last_event
FROM chatroach.bails
LEFT JOIN chatroach.bail_events ON bails.id = bail_events.bail_id
WHERE enabled = true
GROUP BY bails.id, name, enabled, timing
ORDER BY last_event DESC NULLS FIRST;
```

**Common Causes:**
1. Bail disabled (`enabled: false`)
2. Timing conditions not being met (e.g., scheduled time already passed)
3. No users matching conditions
4. Database connection error in executor

**Solutions:**
1. Check `enabled` column → set to true if needed
2. Verify timing: For scheduled, is time_of_day format correct (HH:MM)?
3. Test with `PREVIEW` API to see if conditions match any users
4. Check executor pod logs: `kubectl logs -l app=exodus --tail=100`

### Problem: Performance Degradation Over Time

**Diagnosis:**
```sql
SELECT
  date_trunc('day', timestamp) as day,
  COUNT(*) as events_per_day,
  AVG(EXTRACT(EPOCH FROM (SELECT MAX(timestamp) - MIN(timestamp)
                          FROM bail_events be2
                          WHERE date_trunc('day', be2.timestamp) = date_trunc('day', be1.timestamp)))) as avg_duration_sec
FROM chatroach.bail_events be1
GROUP BY day
ORDER BY day DESC
LIMIT 30;
```

**Common Causes:**
1. Table growing faster than expected
2. Full table scans (missing index)
3. Lock contention on writes

**Solutions:**
1. Archive or delete old events (requires custom script)
2. Verify indexes exist: `\d bail_events` in psql
3. Monitor database connection pool usage

---

## Best Practices

### 1. Use Specific Conditions
**Bad:**
```json
{"type": "form", "value": "any_form"}
```
Matches everyone on any form → potentially millions of events/day

**Good:**
```json
{
  "op": "and",
  "vars": [
    {"type": "form", "value": "checkout"},
    {"type": "state", "value": "ABANDONED"}
  ]
}
```
Matches only abandoned checkouts → focused, actionable

### 2. Log Execution for Monitoring
Enable detailed executor logs:
```yaml
# In values.yaml or deployment env
- name: LOG_LEVEL
  value: "debug"
```

Then query logs:
```bash
kubectl logs -l app=exodus -c exodus --since=1h | grep "Ready to execute"
```

### 3. Test with Preview API Before Enabling
Use the dashboard or API to preview conditions:
```bash
curl -X POST http://api/users/{userId}/bails/preview \
  -H "Content-Type: application/json" \
  -d '{
    "definition": {
      "conditions": {"type": "form", "value": "test"},
      "execution": {"timing": "immediate"},
      "action": {"destination_form": "dest"}
    }
  }'
```

Check result count before enabling.

### 4. Monitor Event Creation in First Hours
After enabling a bail:
- Check event count every 10 minutes
- Verify users in execution_results are correct
- Ensure no errors in bail_events table
- Monitor destination form processing

### 5. Use Smaller Rate Limits for Fast Systems
If botserver can handle faster rates:
```yaml
env:
  - name: EXODUS_RATE_LIMIT
    value: "100ms"  # Instead of 1s
```

This reduces overall execution time from 16 minutes to 1.6 minutes for 1000 users.

---

## Testing & Validation

### Unit Test Pattern (Go)

```go
func TestImmediateExecutionFrequency(t *testing.T) {
    // Create immediate bail
    bail := createTestBail(uuid.New(), "test", "immediate", nil, nil, nil)

    // Simulate multiple runs
    for run := 0; run < 3; run++ {
        err := executor.Run(context.Background())
        if err != nil {
            t.Fatalf("Run %d failed: %v", run, err)
        }

        events := store.recordedEvents
        if len(events) != (run + 1) {
            t.Errorf("Expected %d events, got %d", run+1, len(events))
        }
    }
}
```

### Integration Test Pattern (SQL)

```sql
-- Create test bail
INSERT INTO chatroach.bails (user_id, name, enabled, definition, destination_form)
VALUES (
  '550e8400-e29b-41d4-a716-446655440000'::UUID,
  'test_immediate',
  true,
  '{"type":"conditions","conditions":{"type":"form","value":"test"},"execution":{"timing":"immediate"},"action":{"destination_form":"dest"}}'::JSONB,
  'dest'
);

-- Simulate 3 executor runs
-- (Would be done via application)

-- Verify 3 events created
SELECT COUNT(*) FROM chatroach.bail_events
WHERE bail_name = 'test_immediate'
  AND event_type = 'execution';
-- Expected: 3
```

---

## Related Documentation

- **Executive Summary:** `planning/bail-system-summary.md`
- **Technical Details:** `planning/bail-immediate-execution-findings.md`
- **Quick Reference:** `planning/bail-execution-modes-quick-ref.md`
- **Architecture Deep Dive:** `planning/bail-system-architecture.md`

