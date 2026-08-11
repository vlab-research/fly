# Replybot byte-budget + quarantine (Plan: A + γ)

## Goal

Replybot must `error` long before OOMing on cold-load of an oversized user history, and the offending user must be quarantined (USER_BLOCKED) so future events stop hitting the failure path.

## Background

See conversation context. Two-line summary:
- `chatbase.get(userid, limit)` returns ALL messages for a user filtered by `message_pointer`. For users with bloated `state.externalEvents` (1.4k+ payment retries), the result is hundreds of MB. `recursiveJSONParser` doubles peak. Replybot OOMs at the 2 GB heap limit.
- The OOM is on cache miss only. With a Redis cache hit (TTL 24h), no DB load happens. Stuck users OOM after their cache expires.

Active heavy users with `message_pointer IS NULL`: `8563270007096163` (1.22 GB), `25318135341171312` (1.0 GB), `28450029531308165` (564 MB), and the long tail (155 users with >100 externalEvents, 30 with >500, 13 with >1000).

## Design choice

Two parts:

### Part A: keyset pagination + per-byte-budget abort in `chatbase.get`

Replace today's single buffered query with paginated reads that track cumulative bytes. When bytes exceed `STATE_STORE_BYTE_BUDGET`, throw `StateLoadTooLargeError(userid, bytes, count)`. Same total DB load as today; bounded peak node memory; can throw mid-stream before loading the rest.

Why not pre-flight `sum(length(content))`: measured 3 s and 1.1 GiB read for the stuck user. The userid index has `STORING (content)` so any userid scan reads all content blobs. Pre-check would double DB load.

Why not `pg-cursor`: extra dependency, untested on this Cockroach 24.1 cluster, no upside vs plain keyset pagination.

### Part γ: catch handler reads persisted state_json, warms Redis, publishes synthetic block_user

When `StateLoadTooLargeError` propagates to the processor catch:

1. `SELECT state_json FROM chatroach.public.states WHERE userid = $1` — single point lookup, ~10 ms even for 700 KiB rows (verified).
2. `redis.setex('state:'+userid, ttl, JSON.stringify(state_json))` — warm cache so in-flight events for this user don't also throw.
3. POST synthetic block_user to `BOTSERVER_URL/synthetic` for this user.
4. Drop current event.

When the synthetic `block_user` arrives via Kafka:
- `getState` cache HIT (we warmed it) → returns persisted state with `forms` intact.
- State machine `BLOCK_USER` case applies cleanly: `state=USER_BLOCKED`, `pointer=event.timestamp`, `forms=state.forms` preserved.
- `updateState` writes USER_BLOCKED state to Redis. Future events: cache hit → noop'd by state machine.
- `stateman.js` (separate consumer) processes the same block_user event and UPSERTs the new state_json into `states`. `message_pointer` (computed column) updates → future cold loads truncate to ~0 messages.
- Recovery is durable.

Why this beats α (direct UPSERT in catch): preserves `state.forms` AND keeps the event-sourced flow AND recovers in-flight events for the same user during the recovery window.

Why this beats β (empty-state fallback): doesn't lose `forms`/`qa`/`md`.

Caveat: relying on `states.state_json` as a fallback truth source acknowledges that the materialized view (written async by stateman) is acceptable for catastrophic recovery. Slightly stale (one or two events behind) but immaterial here — we're about to BLOCK_USER anyway. The pointer-as-app-logic precedent (Dean's queries already read state_json fields) means this barrier was already crossed.

## Components changed

### 1. `@vlab-research/chatbase-postgres` (npm package)

Add new method `getStreaming(key, byteBudget, limit)` and `StateLoadTooLargeError` class. Don't change `get` — keep it for any other consumers.

```js
class StateLoadTooLargeError extends Error {
  constructor(userid, bytes, count) {
    super(`state load too large for ${userid}: ${bytes} bytes across ${count} messages`)
    this.name = 'StateLoadTooLargeError'
    this.userid = userid
    this.bytes = bytes
    this.count = count
  }
}

async getStreaming(key, byteBudget, limit) {
  const PAGE = 1000
  const results = []
  let bytes = 0
  let lastTs = new Date(0)
  let fetched = 0

  while (true) {
    const remaining = limit ? limit - fetched : PAGE
    if (limit && remaining <= 0) break
    const pageSize = Math.min(PAGE, remaining)

    const { rows } = await this.pool.query(`
      SELECT content, timestamp
      FROM messages
      LEFT JOIN (SELECT userid, message_pointer FROM states WHERE userid = $1) USING (userid)
      WHERE userid = $1
        AND (message_pointer IS NULL OR message_pointer <= timestamp)
        AND timestamp > $2
      ORDER BY timestamp ASC
      LIMIT $3
    `, [key, lastTs, pageSize])

    for (const r of rows) {
      bytes += r.content.length
      if (byteBudget && bytes > byteBudget) {
        throw new StateLoadTooLargeError(key, bytes, fetched + 1)
      }
      results.push(r.content)
    }

    fetched += rows.length
    if (rows.length < pageSize) break
    lastTs = rows[rows.length - 1].timestamp
  }

  return results
}

module.exports = { Chatbase, StateLoadTooLargeError }
```

Bump package version. Tests:
- Returns rows when within budget.
- Throws `StateLoadTooLargeError` with correct counts when budget exceeded mid-page.
- Honors `limit` parameter (caps at N rows even if budget not hit).
- Pagination works correctly across page boundaries.

### 2. `replybot/lib/typewheels/statestore.js`

- Switch `_getEvents` to use `db.getStreaming(user, BYTE_BUDGET, +STATE_STORE_LIMIT)`.
- New env: `STATE_STORE_BYTE_BUDGET` (default e.g. `52428800` = 50 MB).
- Re-export `StateLoadTooLargeError` for processor to import.
- Add helper `warmCache(userid, stateJson)` that does `redis.setex` with normal TTL.

### 3. `replybot/lib/index.js` (processor)

In the catch handler, distinguish `StateLoadTooLargeError`:

```js
catch (e) {
  if (e instanceof StateLoadTooLargeError) {
    try {
      await quarantineUser(chatbase, stateStore, userId, event, e)
      metrics.quarantined.inc({ bytes: e.bytes, count: e.count })
    } catch (qe) {
      console.error('quarantine failed', { userid: userId, err: qe.message })
    }
    return  // drop current event
  }
  // ...existing error handling
}
```

`quarantineUser` (new helper, e.g. in `lib/quarantine.js`):

```js
async function quarantineUser(chatbase, stateStore, userid, event, err) {
  const { rows } = await chatbase.pool.query(
    `SELECT state_json FROM states WHERE userid = $1`, [userid])

  if (rows.length === 0) {
    // No persisted state — nothing to rescue. Just publish block_user; load fallback elsewhere handles it.
    return publishSyntheticBlockUser(userid, getPageFromEvent(parseEvent(event)))
  }

  await stateStore.warmCache(userid, rows[0].state_json)

  const pageid = getPageFromEvent(parseEvent(event))
  return publishSyntheticBlockUser(userid, pageid)
}

async function publishSyntheticBlockUser(userid, pageid) {
  return r2.post(`${process.env.BOTSERVER_URL}/synthetic`, {
    json: {
      user: userid,
      page: pageid,
      event: { type: 'block_user', value: null }
    }
  }).response
}
```

### 4. `replybot/lib/responses/stateman.js`

Stateman also uses `stateStore.getState` (line 33). Same `StateLoadTooLargeError` will propagate. Stateman's catch (lines 24-29) currently logs and continues — that's fine for stateman; no quarantine needed here because the main processor will quarantine the user. Stateman just needs to not crash.

No change needed beyond bumping the chatbase-postgres dep, but verify the existing catch handles the new error type cleanly.

### 5. Configuration (`devops/values/production.yaml`)

Add to replybot `env`:
```yaml
- name: STATE_STORE_BYTE_BUDGET
  value: "52428800"  # 50 MB
```

50 MB raw → ~150 MB peak after `recursiveJSONParser` doubling, well under the 2 GB heap. Tunable.

### 6. Metrics

Add to replybot's existing prom-client setup (or introduce one):
- `replybot_state_load_too_large_total{}` counter
- `replybot_quarantine_attempted_total{outcome="success|failed"}` counter
- `replybot_state_load_bytes` histogram on cold loads

Alert: any `state_load_too_large > 0` rate sustained means we have an actively bloating user.

## Pre-deploy: manual triage of currently-stuck users

Before deploying, advance `pointer` on the worst-currently-stuck users so their cold loads succeed once the new code rolls out (otherwise the byte budget would immediately quarantine them en masse on first cache miss).

For the 13 users with >1000 externalEvents (the byte budget would catch them; we'd rather they enter the new code already truncated):

```sql
-- For each worst-N user, set pointer to current time. Targeted, single user per statement.
UPDATE chatroach.public.states
SET state_json = jsonb_set(state_json, '{pointer}', to_jsonb((extract(epoch from now()) * 1000)::bigint))
WHERE userid = $1;

-- Then DEL their Redis cache so they cold-load with the new pointer.
```

Run this list:
- `25318135341171312`
- `28450029531308165`
- `8563270007096163`
- `25294659363495789`
- `9909122355827004`
- `25417699357883920`
- `25532540779710436`
- `25646313211664858`
- `25241690522157611`
- `32832302759718182`
- (3 more from the >1000 bucket — pull full list before deploy)

Confirm the SQL with the user before running.

## Sequencing

1. **Trace USER_BLOCKED handling** in `replybot/lib/typewheels/machine.js` — confirm what TEXT/POSTBACK/etc events do when `state.state === 'USER_BLOCKED'`. Need to know whether they noop or process. If they don't noop, our quarantine doesn't actually stop processing — only stops OOM. Decide if that's acceptable or if we need additional handling.

2. **Implement chatbase-postgres changes**: add `getStreaming`, `StateLoadTooLargeError`, tests. Publish new package version.

3. **Implement replybot changes**: bump dep, update statestore, update processor with catch handler and quarantine helper, add metrics. Tests.

4. **Pre-deploy DB triage**: manually advance pointer on the worst N users (with user approval).

5. **Deploy to staging first** (`devops/values/staging.yaml` parallel changes). Verify metric appears, no spurious quarantines.

6. **Deploy to production**. Watch the quarantine metric.

7. **Followup work** (separate PRs): Dean retry caps (already discussed), state-embedding investigation (already briefed in `planning/machine-report-state-embedding.md`).

## Success criteria

- No replybot OOM crashes after deploy.
- `state_load_too_large_total` metric has known-good value (zero or matches the already-stuck users we expect to catch).
- Stuck users observably end up in `current_state='USER_BLOCKED'` after their next cache miss.
- Normal users see no latency regression (paginated queries within ~50ms for typical message counts).

## Open questions before final implementation

1. **USER_BLOCKED noop semantics** — see sequencing step 1. Affects whether quarantine durably stops processing or just bounds memory.
2. **Confirm prod `STATE_STORE_LIMIT=30000` interacts with byte budget correctly** — getStreaming honors both: stops at first one hit. Test both paths.
3. **stateman vs scribble** — user mentioned scribble writes states async. But `replybot/lib/responses/stateman.js` ALSO writes states. Trace which is the actual prod writer. (If both, do they conflict?) This affects fallback freshness assumptions — should be one targeted code-read.
4. **Failure mode of synthetic publish** — if `BOTSERVER_URL/synthetic` is down, quarantine emit fails. Catch handler logs and moves on. Next event for same user re-attempts (cache is warmed for ttl, so they'd cache-hit and process normally until ttl expires — at which point cold load would throw again, re-quarantining). Verify this loop is acceptable.
5. **Per-message size limit** — should we ALSO refuse to enqueue a single message > N bytes (e.g., 1 MB)? Defense in depth against future bugs producing giant messages. Out of scope for this PR but worth noting.
