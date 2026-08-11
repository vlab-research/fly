# Dean spammers: catch high-externalEvents users + manual triage

## Context

Replybot OOMs on cold-load of users with bloated `state.externalEvents`. Worst observed: 1.22 GB of message content for one user (`8563270007096163`) after 1,400+ repeated payment retries from Dean's `payments` cron with no termination condition. 155 users currently have >100 externalEvents; 13 have >1000.

Replybot's state-machine `BLOCK_USER` case (`replybot/lib/typewheels/machine.js:389-397`) sets `state.pointer` which truncates future cold-loads to ~0 messages. So if we can catch bloating users early — before their loaded history exceeds replybot's heap — `BLOCK_USER` is sufficient to stop the OOM.

Dean's existing `spammers` cron emits `block_user` for users whose last 25 QA entries are the same question. The proposal: extend that query to also catch users with too-many externalEvents, and increase the cron frequency.

Bloat rate from Dean-driven loops is ~4 events/day (payments cron at 6h cadence). Threshold of 100 externalEvents gives ~25 days of headroom — Dean catches problem users long before they reach OOM territory.

## Files to modify

### `dean/queries.go`

Replace `Spammers` (line 243-252):

```go
func Spammers(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
    query := `
              SELECT s.userid, s.pageid
              FROM states s
              WHERE
                s.current_state != 'USER_BLOCKED'
                AND (
                  s.state_json->'qa'->-1->>0 = s.state_json->'qa'->-25->>0
                  OR jsonb_array_length(COALESCE(s.state_json->'externalEvents','[]'::jsonb)) > $1
                )
        `
    return get(conn, getBlockUser, query, cfg.SpammerExternalEventsMax)
}
```

Two behavioral changes vs current:
1. `current_state != 'USER_BLOCKED'` filter — stops re-emitting `block_user` for already-blocked users on every cron run.
2. `OR jsonb_array_length(...) > $1` — proactively catches bloated users.

### `dean/dean.go` (Config)

Add `SpammerExternalEventsMax int` to the `Config` struct. Parse from env `DEAN_SPAMMER_EXTERNAL_EVENTS_MAX` following the existing pattern used by `RetryMaxAttempts`.

### `dean/queries_test.go`

Add tests:
- Returns user with externalEvents above threshold (non-blocked).
- Does NOT return user with `current_state='USER_BLOCKED'` even if both inner conditions match.
- Returns user with last-25-same-question (existing behavior preserved).
- Does NOT return user with normal state.

### `replybot/lib/typewheels/machine.js`

USER_BLOCKED guards needed so blocked users actually stop accumulating events. Current gaps confirmed by exploration:

- **EXTERNAL_EVENT case (line 370)**: add `if (state.state === 'USER_BLOCKED') return _noop()` before `_handleExternalEvent`. Stops Dean retries / Reloadly callbacks from appending to `externalEvents` after BLOCK_USER.
- **ECHO case (line 400)**: add the same guard at the top. Stops bot echoes from triggering further state transitions on a blocked user.

Pattern to follow: existing REFERRAL guard at `machine.js:263`.

### `replybot/lib/typewheels/machine.test.js`

Tests asserting `_noop()` returned for EXTERNAL_EVENT and ECHO when state is USER_BLOCKED. Find existing USER_BLOCKED test patterns by grep.

### `devops/values/production.yaml`

Two changes in the `dean` block:

1. After `DEAN_TIMEOUT_MAX_PAST` (around line 196), add:
   ```yaml
   - name: DEAN_SPAMMER_EXTERNAL_EVENTS_MAX
     value: "100"
   ```

2. Change spammers cron (line 226-232) from daily to every 30 minutes:
   ```yaml
   - name: spammers
     queries: "spammers"
     schedule: "*/30 * * * *"
     resources:
       requests:
         cpu: 10m
         memory: 10Mi
   ```

Mirror in `devops/values/staging.yaml`.

## Pre-deploy DB triage

The 13 users with >1000 externalEvents will OOM replybot if Dean's `block_user` event triggers a cold load on them. Need to advance their pointer first.

**Step 1: Get the current full list (run via MCP or psql):**

```sql
SELECT userid, jsonb_array_length(state_json->'externalEvents') AS n
FROM chatroach.public.states
WHERE jsonb_array_length(COALESCE(state_json->'externalEvents','[]'::jsonb)) > 1000
ORDER BY n DESC;
```

**Step 2: For each userid, advance pointer (one at a time, with explicit approval):**

```sql
UPDATE chatroach.public.states
SET state_json = jsonb_set(state_json, '{pointer}', to_jsonb((extract(epoch from now()) * 1000)::bigint))
WHERE userid = $1;
```

**Step 3: Clear that user's Redis cache so the next event triggers a clean cold-load with the new pointer:**

```bash
redis-cli -h gbv-redis-master -a "$REDIS_PASSWORD" del "state:$userid"
```

After triage, Dean's next 30-min run catches them and emits `block_user` cleanly (loaded history is now ~0 messages).

## Verification

1. Dean unit tests pass.
2. Replybot unit tests pass for the new USER_BLOCKED guards.
3. Local integration: seed a synthetic `states` row with >100 externalEvents in non-blocked state, run Dean's spammers cron, assert it POSTs `block_user` for that user to the synthetic endpoint.
4. Staging deploy: confirm `DEAN_SPAMMER_EXTERNAL_EVENTS_MAX` env present, watch Dean spammers logs for 30 minutes, no false positives.
5. Production deploy:
   - Run pre-deploy triage SQL on the 13 worst users.
   - Deploy Dean changes (queries.go + dean.go + production.yaml).
   - Deploy replybot changes (machine.js + tests).
   - Monitor for: no replybot OOMs, Dean spammer catches in logs, blocked users' externalEvents arrays stop growing.
6. Post-deploy: spot-check via MCP that newly-quarantined users have `current_state='USER_BLOCKED'` and externalEvents stable across a few hours.

## What this does NOT fix

- Root cause of bloat (Dean payments/timeouts have no termination). Tracked separately.
- Already-bloated `state_json` for blocked users — stays bloated in the row, just stops growing. Cleanup is a separate decision.
- Defense-in-depth runtime safety net in replybot. See `planning/replybot-pagination-byte-budget.md`.
