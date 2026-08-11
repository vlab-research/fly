# Replybot: paginated chatbase-postgres + byte-budget error

## Context

Defense-in-depth complement to `planning/dean-spammers-external-events-quarantine.md`. Dean's proactive spammer catching is the first line of defense against replybot OOMs. This plan adds a runtime safety net: even if some unforeseen bloat pattern slips past Dean, replybot errors instead of OOMing.

Today, `chatbase.get(userid, limit)` (`@vlab-research/chatbase-postgres/lib/index.js:21-37`) runs one query and materializes the full result into `result.rows` before returning. For users with hundreds of MB of message content, node OOMs at the 2 GB heap limit.

**Scope intentionally minimal**: just paginate, count bytes, throw on excess. No quarantine, no rescue, no synthetic block_user. Affected users are dropped at the catch site; ops triages manually if needed. Recovery is rare because Dean is doing the proactive catching.

## Why pagination, not a pre-flight size check

Measured: any per-user size pre-check (`SELECT count(*), sum(length(content))`) reads 1.1 GiB and takes 3 seconds for the worst user. The `messages_userid_idx` has `STORING (content, timestamp)`, so any userid scan reads all content blobs. Pre-checks would double DB load. Streaming + per-row byte counter sidesteps this — same total DB cost as today, but bounded peak node memory and ability to throw mid-stream.

Plain SQL keyset pagination (no `pg-cursor`) — cursor support on Cockroach 24.1 is unverified and unnecessary.

## Files to modify

### `@vlab-research/chatbase-postgres/lib/index.js`

Add `StateLoadTooLargeError` and `getStreaming(key, byteBudget, limit)`. Keep `get` unchanged.

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
  const out = []
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
      out.push(r.content)
    }

    fetched += rows.length
    if (rows.length < pageSize) break
    lastTs = rows[rows.length - 1].timestamp
  }

  return out
}

module.exports = { Chatbase, StateLoadTooLargeError }
```

Bump package version. Tests:
- Returns full result when within budget.
- Throws `StateLoadTooLargeError` with correct counts when budget exceeded mid-page.
- Honors `limit` cap independently of budget.
- Pagination correct across page boundaries. **Important**: if duplicate timestamps are possible for the same user, `timestamp > lastTs` will skip rows. Fall back to `(timestamp, id)` keyset (e.g., `WHERE (timestamp, id) > ($lastTs, $lastId)`) if needed — verify against the schema before implementing.

### `replybot/lib/typewheels/statestore.js`

- Import and re-export `StateLoadTooLargeError` from `@vlab-research/chatbase-postgres`.
- Switch `_getEvents` (line 72-77) to `db.getStreaming(user, BYTE_BUDGET, +STATE_STORE_LIMIT)`.
- New env: `STATE_STORE_BYTE_BUDGET` (default `52428800` = 50 MB raw → ~150 MB peak after `recursiveJSONParser` doubling, well under the 2 GB heap).

### `replybot/lib/index.js`

Update processor catch (lines 83-88) to log the new error type and drop the event:

```js
const { StateLoadTooLargeError } = require('./typewheels/statestore')

// inside _processor catch
catch (e) {
  if (e instanceof StateLoadTooLargeError) {
    console.error('state load too large, dropping event', {
      userid: userId, bytes: e.bytes, count: e.count
    })
    return
  }
  // existing error handling
}
```

### `replybot/lib/responses/stateman.js`

`stateman` also calls `stateStore.getState` (line 33). The existing catch at lines 24-29 logs and continues, which is correct behavior for the new error type too. Verify the bumped chatbase-postgres dep doesn't surface anything weird; no code change expected.

### `devops/values/production.yaml`

Add to replybot env (after `STATE_STORE_LIMIT` at line 533):

```yaml
- name: STATE_STORE_BYTE_BUDGET
  value: "52428800"  # 50 MB
```

Mirror in `devops/values/staging.yaml`.

## What this plan explicitly does NOT do

- No quarantine helper, no warm-cache, no synthetic `block_user` emission.
- No `states` table read in the catch path.
- No state-machine changes.
- Affected users stay broken (every event errors) until ops manually triages them. Acceptable because Dean is the primary catcher.

## Verification

1. Unit tests for `getStreaming` (see test list above).
2. Local integration: seed a synthetic user with >50 MB of message rows, run replybot pointed at local Cockroach, submit an event for that user. Assert: process stays alive, error log line emitted with correct bytes/count.
3. Local integration negative: a normal user (a few hundred KB) processes normally with no error.
4. Staging deploy: verify env var set, watch logs for an hour. No spurious quarantines from normal users.
5. Production deploy: monitor for the new error log lines. If Dean is doing its job, this should rarely fire.

## When to activate this plan

Only after `dean-spammers-external-events-quarantine.md` has shipped and stabilized. This is defensive depth, not the primary fix.

Triggers:
- A new bloat pattern emerges that Dean doesn't catch.
- We see even one OOM after the Dean fix deploys.
- We want to ship something concrete to the "this can never happen again" requirement.

## Open questions for activation time

- Confirm `chatbase` instance plumbing in `replybot/lib/index.js` — is the pool reachable from `_processor`'s closure or does it need wiring through `SpineSupervisor`?
- Verify `(userid, timestamp)` index is sufficient for the keyset pagination path's `ORDER BY timestamp ASC` and `WHERE timestamp > $2` semantics.
