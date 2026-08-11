# Bug catalog: replybot OOM and surrounding system issues

This document catalogs every distinct issue surfaced during the May 2026 replybot OOM investigation. Each entry stands alone — separate root cause, separate potential fix. The active fix plans (`dean-spammers-external-events-quarantine.md`, `replybot-pagination-byte-budget.md`, `machine-report-state-embedding.md`) address only a subset. Use this catalog as a backlog for future work.

## OOM mechanics

### B1: `chatbase.get` returns a single buffered result

**File**: `@vlab-research/chatbase-postgres/lib/index.js:21-37`.

`SELECT * FROM messages WHERE userid = $1 ...` returns up to `STATE_STORE_LIMIT=30000` rows in one buffered query. For users with hundreds of MB of content rows, node materializes the whole result before returning.

**Impact**: primary OOM trigger.

**Fix**: paginated streaming + byte budget — see `planning/replybot-pagination-byte-budget.md`.

### B2: `recursiveJSONParser` doubles peak memory

**File**: `replybot/node_modules/@vlab-research/utils/lib/utils.js:4-26`.

The function calls `JSON.parse(obj)` on the input string, then walks the parsed tree calling itself on each value. During traversal, both the original string and the parsed tree are held in memory simultaneously. On a 1 GB input, peak heap is ~2 GB.

**Impact**: amplifies B1 by ~2×. A 50 MB raw load becomes a ~150 MB peak.

**Fix options**: rewrite as non-mutating-of-input (release reference to original string before traversal), or use a streaming parser, or budget around the doubling. Not addressed in current plans.

### B3: `messages_userid_idx` STORES content blob

**File**: `devops/migrations/01-init.sql` (index definitions).

The userid index has `STORING (content, timestamp)`. Any userid scan reads all content blobs even for `count(*)`. There's no userid-keyed index without content.

**Impact**: prevents cheap pre-flight size checks. `SELECT count(*) FROM messages WHERE userid=$1` reads 1.1 GiB / 1.2s for the worst user.

**Fix options**: add a `content_len INT AS (length(content)) STORED` column and a new index `(userid) STORING (content_len, timestamp)` without content. Multi-million-row Cockroach migration; not in scope.

## Bloat sources

### B4: Dean `payments` cron has no retry cap

**File**: `dean/queries.go:145-157`.

```sql
WHERE current_state = 'WAIT_EXTERNAL_EVENT'
  AND state_json->'wait'->>'type' != 'timeout'
  AND waitStart + GRACE < now AND waitStart + INTERVAL > now
```

No `state_json->'retries'` cap (unlike `respondings`/`errored`/`blocked`). Cron fires every 6 hours indefinitely as long as the user is in `WAIT_EXTERNAL_EVENT`.

**Impact**: each retry costs real money via Reloadly. Each retry appends a `repeat_payment` event into the system, which produces a Reloadly callback (`payment:reloadly`), which lands as an external event and gets appended to `state.externalEvents`.

**Fix**: add `AND jsonb_array_length(COALESCE(state_json->'externalEvents','[]'::jsonb)) < $cap` to the WHERE clause, or use the existing `state_json->'retries'` mechanism. Not addressed in current plans.

### B5: `payments` window resets on every retry

**File**: `dean/queries.go:151-152` + state-machine flow.

Each `repeat_payment` event triggers `MAKE_PAYMENT` in the state machine, which re-enters `WAIT_EXTERNAL_EVENT` with a fresh `waitStart`. The 14-day `PAYMENT_INTERVAL` window in `Payments()` is anchored to `waitStart` — so it never expires for an actively-retrying user.

**Impact**: combined with B4, payment retries are truly infinite. Worst observed: 1,424 retries for one user over 1.5 years.

**Fix**: same as B4 — adding any cap stops the loop regardless of waitStart resetting.

### B6: Dean `timeouts` cron has no per-user cap

**File**: `dean/queries.go:159-208`.

Cron fires every 10 minutes. Filter: `calculated_timeout_date < now AND > now - 72h`. For a stuck user past their timeout, 10-min cron × 72h window = up to 432 timeout events. The query has `LIMIT 1` only when no blacklist is set — production has a blacklist (`DEAN_TIMEOUT_BLACKLIST`), so the `LIMIT 1` does not apply.

**Impact**: secondary bloat source. User `25318135341171312` has 3,693 externalEvents starting with type `timeout`, suggesting multiple cycles where survey re-entered waits.

**Fix**: same shape as B4 — add an externalEvents cap.

### B7: `_handleExternalEvent` never trims

**File**: `replybot/lib/typewheels/machine.js:121-160`.

```js
const externalEvents = [...(state.externalEvents || []), nxt]
```

Always appends, in any state, including when the wait IS fulfilled. The array is preserved into successor states forever.

**Impact**: directly produces the `state.externalEvents` bloat that drives B1.

**Fix options**:
- Trim to last N on each call.
- Trim to events newer than `waitStart` when wait resolves.
- Cap at N and emit a give-up transition when cap hit.

Explicitly out of scope per user direction (design decision deferred).

### B8: `machine_report` messages embed full `newState`

**File**: `replybot/lib/index.js:39-42` + `lib/index.js:20-31`.

```js
const message = { userid, pageid, updated, current_state: state.state, state_json: state }
```

Every published `state` Kafka message AND every `machine_report` synthetic event contains the full `newState`. As `state.externalEvents` (or any other field) grows, every published message also grows. The `messages` table thus grows quadratically.

**Impact**: 9,750 messages × growing state = 1.22 GB on disk for one user. Largest single message: 632 KB.

**Fix**: separate investigation in `planning/machine-report-state-embedding.md`.

## USER_BLOCKED gaps

### B9: USER_BLOCKED is not a true noop state

**File**: `replybot/lib/typewheels/machine.js`.

USER_BLOCKED guards exist for:
- TEXT (line 489)
- POSTBACK (line 464)
- QUICK_REPLY (line 474)
- MEDIA (line 505)
- REFERRAL (line 263)

USER_BLOCKED guards are MISSING for:
- **EXTERNAL_EVENT (line 370)** — `_handleExternalEvent` always appends. Dean retries and Reloadly callbacks keep landing on blocked users.
- **ECHO (line 400)** — processes normally, can transition out of USER_BLOCKED to END / WAIT_EXTERNAL_EVENT.
- FOLLOW_UP (line 347), REPEAT_PAYMENT (line 338), REDO (line 320), MACHINE_REPORT (line 293), PLATFORM_RESPONSE (line 282), BLOCK_USER itself (line 389).

**Impact**: blocking a user doesn't actually stop bloat accumulation. Only stops user-facing interaction.

**Fix**: add USER_BLOCKED guards to EXTERNAL_EVENT and ECHO at minimum (in scope of `dean-spammers-external-events-quarantine.md`). Other cases worth a separate review.

### B10: BLOCK_USER not idempotent for already-blocked users

**File**: `replybot/lib/typewheels/machine.js:389-397`.

```js
case 'BLOCK_USER': {
  if (state.state === 'START') return _noop()
  return { action: 'RESET', stateUpdate: { state: "USER_BLOCKED", pointer: nxt.timestamp, ... } }
}
```

No early return for already-USER_BLOCKED state. Each re-emission of `block_user` runs through RESET, advances pointer, re-publishes machine_report.

**Impact**: minor — wasted work, log noise. Not OOM-dangerous.

**Fix**: add `if (state.state === 'USER_BLOCKED') return _noop()` early return. Currently mitigated upstream by Dean spammers query filtering `current_state != 'USER_BLOCKED'` (in scope of the active Dean plan).

## Pointer mechanism

### B11: `pointer` is only advanced by RESET shortcode or BLOCK_USER

**File**: `replybot/lib/typewheels/machine.js:259, 396` (only writers).

For any user who has never typed `reset` and never been blocked, `state_json->>'pointer'` stays NULL forever. Cold load fetches their entire lifetime message history.

**Impact**: every active user is a latent OOM candidate as their history grows. Hits us only because one specific class (payment-loop users) grows fast.

**Fix options**:
- Auto-advance pointer on `END` state transition (after each survey completion).
- Auto-advance on a sliding window (e.g., on every transition, set pointer to `now() - 30 days`).
- Heuristic: if loaded history is > N events, advance pointer to the Nth-newest event.

Architectural change — not addressed in current plans.

### B12: `message_pointer` is a STORED computed column, requires `state_json->>'pointer'` write to update

**File**: `devops/migrations/04-pointers.sql:1`.

```sql
message_pointer TIMESTAMPTZ AS (FLOOR((state_json->>'pointer')::INT/1000)::INT::TIMESTAMPTZ) STORED
```

Pointer mechanism is split between two locations. To advance, you write `state_json.pointer` (millis). The column updates automatically. This is fine but worth noting for ops who want to manually triage.

**Fix**: not a bug, just documentation. Triage SQL in `dean-spammers-external-events-quarantine.md` shows the pattern.

## State persistence

### B13: `states.state_json` is written async by scribble, can lag by up to 128 messages

**File**: `scribble/state.go:55-68`, `devops/values/production.yaml:271-272`.

Scribble batches with `SCRIBBLE_BATCH_SIZE=128` and flushes when full or on poll interval. At low throughput, latency is bounded by the poll interval. At high throughput, up to 128 events can queue.

**Impact**: any code reading `states.state_json` as ground truth (e.g., Dean) sees a slightly stale view.

**Fix**: not directly fixable without changing scribble's batching. Accept and document. Dean's queries should be tolerant of one-batch staleness.

### B14: `replybot/lib/responses/stateman.js` is dev-only, not deployed in production

**File**: `replybot/lib/responses/stateman.js`, `replybot/kube-scratch/stateman.yaml`, NOT in `devops/values/production.yaml`.

The `stateman` consumer in `lib/responses/` looks like a production component but is only deployed in `kube-scratch` / `kube-scratch-dev` k8s manifests. Production replybot runs only `lib/index.js`. Scribble is the actual writer of `states.state_json`.

**Impact**: confusion when reading code. Easy to assume stateman is the writer.

**Fix**: delete stateman.js if truly unused, or document its purpose clearly.

## Operational gaps

### B15: No metrics for state load size

There is no Prometheus counter, gauge, or histogram for the size of cold-loaded state. We had to discover the OOM through process crashes, then investigate via DB queries.

**Fix**: add `replybot_state_load_bytes` histogram, `replybot_state_load_too_large_total` counter (when active plan with byte budget ships), `dean_spammers_caught_total` counter labeled by reason (qa-pattern vs externalEvents).

### B16: No alerting on bloat thresholds

A user crossing 100 externalEvents is invisible until either Dean catches them (after the active plan) or replybot OOMs.

**Fix**: alert on `dean_spammers_caught_total` rate spikes; alert on individual users with >threshold externalEvents on a daily SQL-based dashboard.

### B17: Manual triage of stuck users requires direct DB writes

The pre-deploy triage in `dean-spammers-external-events-quarantine.md` requires running UPDATE statements one user at a time. There's no admin UI, no CLI, no automated tool.

**Fix**: small ops script (Go or shell) that takes a userid, advances pointer, and clears Redis cache. Could live in `dean/` or a new `ops/` directory.

### B18: Spammers cron is once daily, not responsive

**File**: `devops/values/production.yaml:226-228` (current: `30 3 * * *`).

A user crossing the bloat threshold today doesn't get caught for up to 24 hours. The active plan increases this to every 30 minutes.

**Note**: addressed by `dean-spammers-external-events-quarantine.md`.

## Future fix priorities

Suggested order, independent of current plans:
1. **B4 + B5**: Dean payment cap. Largest single source of bloat. ~1 day work.
2. **B6**: Dean timeout cap. Secondary bloat source. ~1 day.
3. **B8**: machine_report state embedding. Big win for messages-table size. Investigation already briefed.
4. **B7**: externalEvents trim policy. Design decision — survey design?
5. **B11**: pointer auto-advance. Architectural — affects every user.
6. **B2**: recursiveJSONParser memory. Worth measuring vs pointer fix.
7. **B15 + B16**: observability/alerting. Cheap, high value.
8. Everything else as opportunity allows.
