# Blocking without a pointer, and a loud history cap

**Status:** implemented 2026-09-05 — PR #168 (`fix/block-without-pointer`), with
§9 steps 1–5 done and the `WATERMARK` guard added (§12a below). Staging and
production rollout (§9 steps 6–8) pending. `48e12233` is PR #167
(`fix/restore-state-short-circuit`); PR #166 closed.
**Replaces:** PR #166 (`fix/husk-restore-state`, snapshot-in-log). Its first
commit, `48e12233` (restore the `RESTORE_STATE` short-circuit in `run()`), is an
independent regression fix and ships on its own. Its second commit,
`fca55375` (snapshot event + `MISSING_METADATA`), is dropped.
**Context:** `planning/blocked-user-durability-handoff.md`,
`planning/platform-guess-expiry.md` §2 Bug 1 and §7 Tasks D/E,
`documentation/states-debugging.md` § "Blocking a participant destroys `md`".

---

## 1. The problem, restated

- Replybot state is `fold(log)`. The Redis cache is an optimisation with a 24h
  idle TTL; on a miss the state is rebuilt from `messages`, truncated at
  `states.message_pointer`.
- The pointer is set in exactly three places, all in `exec()` in
  `replybot/lib/typewheels/machine.js`:
  - line 333, tester reset (`REFERRAL` with `REPLYBOT_RESET_SHORTCODE`) → `START`
  - line 421, `RESTORE_STATE` → the state carried in the event
  - line 519, `BLOCK_USER` → `USER_BLOCKED`
- The first two are sound: the state after the pointer is derivable from the
  event alone. The third is not: `USER_BLOCKED` is only reachable from a live
  state, and the refold from the pointer starts at `START`, where `BLOCK_USER`
  no-ops. The block evaporates into a husk with no `md`, the next event throws
  in `getForm`, Dean pages it as `INTERNAL` and retries it every 30 minutes.
- Every fix that keeps the pointer on the block has to smuggle the blocked
  state into the log or into a side channel. That is the complexity in PR #166.

## 2. The reframing

- "Blocked" only needs to mean: the machine no-ops everything from this user
  until a human restores them. It does not need a snapshot, a special read
  path, or a pointer.
- If the block is a plain transition with no pointer, the fold rebuilds it from
  the log like any other state. The invariant `state = fold(log)` holds again.
- What the pointer was protecting against, an unbounded log, is a separate
  concern and gets a separate, honest mechanism: a hard cap on how many events
  we will fold. Over the cap, we stop talking to the conversation, loudly,
  until a human resets or restores it.

## 3. Production data (vprod, 2026-09-05)

Events per conversation, `messages` grouped by `(userid, account_id)`, joined
to `states`:

| group | conversations | max events | >1k | >2.5k | >5k | >10k | >30k |
|---|---|---|---|---|---|---|---|
| `USER_BLOCKED` | 13,469 | 6,209 | 98 | 15 | 2 | 0 | 0 |
| everything else | 1,188,311 | 284,977 | 2,505 | 458 | 312 | 36 | 14 |

- Blocked users have short logs. A full replay of a blocked user is a few
  thousand rows at most, once per 24h of idleness. The pointer bought nothing
  measurable.
- Fourteen conversations already exceed the current `STATE_STORE_LIMIT=30000`
  and are being silently folded from their oldest 30,000 events today. Their
  state is stale and nothing logs it.
- Cap chosen: **10,000**. Thirty-six conversations are above it. Identify them
  before the production rollout (query in §9).

## 4. Design

### 4.1 Block is a plain transition

- `BLOCK_USER` returns `RESET` with `{ state: 'USER_BLOCKED', forms, md }`.
  No `pointer`.
- The `state.state === 'START'` guard is removed. Blocking a `START` user is a
  real block. This is required for the already-blocked population (§7) and is
  what Dean intended anyway.
- All existing `USER_BLOCKED` guards in `exec()` are untouched. The refold
  replays post-block events as no-ops.
- Unblock is unchanged: a manual `restore_state`, which sets its own pointer.

### 4.2 The loud cap

- Lives in `StateStore._getEvents` (`replybot/lib/typewheels/statestore.js`).
- Reads `STATE_STORE_LIMIT` as today. Unset stays unlimited: `+undefined` is
  `NaN`, `NaN + 1` is `NaN`, and `chatbase.get` applies the limit under
  `if (limit)`, so an unset value skips both the SQL limit and the cap check.
- With a limit `N`, ask `chatbase.get` for `N + 1` rows. **Trigger: the raw
  result has strictly more than `N` rows**, i.e. all `N + 1` came back. A
  conversation with exactly `N` archived events folds normally.
- The check runs on the raw rows, before `_resolve` appends the current event.
  Replybot and scribble consume in parallel, so the current event may or may
  not be archived yet; at the exact boundary that makes the cap fire one event
  earlier or later. Harmless.
- The count is already pointer-truncated because the pointer filter is inside
  the same query. A restored or reset user's history starts at their pointer,
  which is exactly the escape hatch.
- Cap applies only to account-scoped replays (`conv.account` present). The
  unscoped no-account fallback keeps today's behaviour; it already reads across
  every account the participant ever messaged and is documented as degraded.
- On overflow, do not fold. Return a **capped state**:

  ```js
  {
    state: 'USER_BLOCKED',
    qa: [],
    forms: [],
    error: { tag: 'HISTORY_LIMIT', message: `history exceeds ${N} events`, ts: event.timestamp }
  }
  ```

  - `USER_BLOCKED` because the machine already no-ops everything in it and
    Dean already skips it. No new guard sites, no new Dean query.
  - No `md`. Safe: every `USER_BLOCKED` handler returns before
    `actionsResponses`, which is the only place that dereferences `md`.
  - The tag surfaces through the stored column
    `states.error_tag = state_json->'error'->>'tag'`, so capped users are
    distinguishable from spammers and filterable.
  - The machine runs the incoming event against it, no-ops, and `index.js`
    publishes and caches it like any other state. So the `N + 1` read happens
    once per Redis miss, not once per event.
- Log exactly one greppable line per overflow, tagged `HISTORY_LIMIT`, with
  the conversation tuple and `N`. Same discipline as `CONVERSATION_TUPLE_MISSING`.
- Why a returned state and not a thrown error: the processor's catch only
  logs. Nothing would be persisted or cached, and the next event would repeat
  the oversized read. Fail loud has to leave a mark.

### 4.3 What the pointer is for after this

- Tester reset and `restore_state` only. Both are derivable from the event.
- Nothing about `chatbase.get`, `states.message_pointer`, or migration 04
  changes.

## 5. Code changes

### `replybot/lib/typewheels/machine.js`
- `BLOCK_USER` case (currently lines 507–521): delete the `START` guard; delete
  `pointer: nxt.timestamp` from `stateUpdate`; keep the comment explaining why
  `forms` and `md` are carried.

### `replybot/lib/typewheels/statestore.js`
- Add `const HISTORY_LIMIT_TAG = 'HISTORY_LIMIT'` next to `TUPLE_MISSING_TAG`;
  export it.
- Add a pure helper `_cappedState(limit, event)` returning the shape in §4.2.
- `_getEvents(conv, user, event)`:
  - compute `limit = +STATE_STORE_LIMIT` (may be `NaN`)
  - `res = await this.db.get({ userid, account }, limit ? limit + 1 : limit)`
  - if `account !== null && limit && res.length > limit`: log the tagged line
    and return a sentinel (e.g. `{ capped: true }`) — or split: have
    `_getEvents` return `{ events, capped }` and let `getState` decide.
- `getState`: on `capped`, return `_cappedState(limit, event)` instead of
  `getState(events)`. Both the named path and the account-present degraded
  path go through this.

### `replybot/lib/responses/debugger.js`
- No change. `emptyBase.get` accepts the limit argument and returns `[]`.

### `replybot/lib/chatbase/chatbase.js`
- No change. `get(conv, limit)` already does what is needed.

## 6. Tests

### `replybot/lib/typewheels/machine.test.js`
- Existing test at line 339, "keeps forms, pointer and md": becomes "keeps
  forms and md, sets no pointer". Assert `state.pointer` is `undefined`.
- New: `block_user` on a `START` state yields `USER_BLOCKED`.
- New: fold a full log `[referral, text, echo, answer, block_user, text,
  postback, external_event]` from scratch; final state is `USER_BLOCKED`,
  `md` and `forms` intact, no pointer.
- New: fold the same log, then apply a `synthetic_restore_state` to a live
  state; state is restored and carries a pointer (the unblock path).

### `replybot/lib/typewheels/statestore.test.js`
- Mock db `get` records the limit it was called with; assert it is `N + 1`.
- Exactly `N` rows → folds normally, `db.get` called with `N + 1`.
- `N + 1` rows → returns capped state: `state === 'USER_BLOCKED'`,
  `error.tag === 'HISTORY_LIMIT'`, `md` undefined; one log line with the tag.
- `N + 1` rows with `conv.account === null` (unscoped path) → folds, not capped.
- `STATE_STORE_LIMIT` unset → `db.get` called with a falsy limit, never capped.
- Capped state is written by `updateState` and served from Redis on the next
  `getState` without touching the db.

### `replybot/lib/chatbase/chatbase.test.js`
- Existing "honours the limit" test at line 327 already covers the SQL side.

## 7. The already-blocked population: no backfill

- 13,469 rows are `USER_BLOCKED` with a pointer in `state_json`.
  - First Redis miss after deploy: replay truncated at the old pointer, block
    event lands on `START`, guard is gone, state is `USER_BLOCKED` with empty
    `forms` and no `md`, and **no pointer**. Scribble persists it with
    `message_pointer = NULL`.
  - Second Redis miss: full replay, block lands on the real state, `forms` and
    `md` recovered.
- ~165 rows already husked into `ERROR` have no pointer today. First Redis miss
  after deploy: full replay, block applies, `USER_BLOCKED` with `md`. Their
  Redis entry only refreshes on a successful publish, so it expires within 24h
  of the deploy on its own.
- Nothing needs `restore_state`, and Task D in `platform-guess-expiry.md` is
  no longer needed.

## 8. Config

- `devops/values/staging.yaml` line 437 and `devops/values/production.yaml`
  line 841: `STATE_STORE_LIMIT: "10000"`.
- Applied with the image bump for this change, staging first.

## 9. Rollout

1. Worktree `../fly-block-without-pointer`, branch `fix/block-without-pointer`
   off `main`.
2. Cherry-pick `48e12233` onto its own branch, open as its own PR. Close #166.
3. Implement §5 and §6. Full replybot suite green.
4. Sanity check with the state debugger against a real blocked user's log:
   refold lands on `USER_BLOCKED` with `md`.
5. Docs commit (§10), separate from the code commit.
6. Staging: image tag + `STATE_STORE_LIMIT` in `values/staging.yaml`, helm
   upgrade, rollout restart.
7. Before production, list the conversations above the cap so nobody is
   surprised when they go quiet:

   ```
   kubectl exec -n vprod gbv-cockroachdb-0 -c db -i -- ./cockroach sql --insecure \
     --host=gbv-cockroachdb-public --database=chatroach --format=table -e \
     "SELECT m.userid, m.account_id, s.current_state, s.platform, s.current_form,
             count(*) AS n, max(m.timestamp) AS last_event
      FROM messages m LEFT JOIN states s ON s.userid = m.userid AND s.pageid = m.account_id
      GROUP BY 1,2,3,4,5 HAVING count(*) > 10000 ORDER BY n DESC"
   ```

8. Production: same as staging.

## 10. Documentation updates (separate step, after the code)

- `replybot/README.md` § "Conversation state cache (`StateStore`)": the pointer
  is set only by tester reset and `restore_state`; a block is a plain
  transition; the cap, its trigger (`> N` with an `N + 1` fetch), the capped
  state, the `HISTORY_LIMIT` tag, and that the unscoped path is exempt.
- `documentation/states-debugging.md` § "Blocking a participant destroys `md`":
  rewrite as resolved, keep the forensic history, add a new subsection for
  `HISTORY_LIMIT` (how to find them, how to restore one).
- `planning/blocked-user-durability-handoff.md`: Gap 3 resolved by this plan;
  record why snapshot-in-log was abandoned.
- `planning/platform-guess-expiry.md`: Task E resolved here, Task D withdrawn.
- `CLAUDE.md` "Work Currently In Flight": the incident sentence about `md`
  erasure can be updated once this is live.

## 11. What to watch after deploy

- `HISTORY_LIMIT` log lines, and
  `SELECT count(*) FROM states WHERE error_tag = 'HISTORY_LIMIT'`. Expect the
  36, then a trickle.
- `INTERNAL` errors from `getForm` on blocked users stop.
- `states.platform IS NULL` for `USER_BLOCKED` rows falls as they refold a
  second time.
- Any capped conversation that turns out to be a real participant gets a
  manual `restore_state`, which sets a pointer and cuts the history off.

## 12. Known edges, accepted

- **Reset shortcode beats the block.** In `REFERRAL`, the
  `REPLYBOT_RESET_SHORTCODE` check runs before the `USER_BLOCKED` guard, so a
  blocked user who sends the tester reset referral resets themselves. Pre-
  existing; spammers do not know the shortcode. Left as is.
- **Boundary nondeterminism.** Whether the current event is already archived
  moves the cap by one event. Harmless.
- **Blocked spammers keep accruing events.** A blocked user who keeps
  messaging will eventually cross the cap and flip from `USER_BLOCKED` (no tag)
  to `USER_BLOCKED` with `HISTORY_LIMIT`. Same behaviour, different label.
- **Unscoped replays are not capped.** Only events with no account take that
  path, which is moviehouse heartbeats by design; it was already degraded and
  is out of scope here.

## 12a. Addition found during implementation: `WATERMARK` needs a guard

§4.2 claims the capped state's missing `md` is safe because "every `USER_BLOCKED`
handler returns before `actionsResponses`". True of the guarded handlers, but
`WATERMARK` had no `USER_BLOCKED` guard and returns a real action when the mark
advances — and a capped state has no `read`/`delivery` marks, so the first late
read receipt for a pre-cap message would have fallen into `actionsResponses`,
hit the `!newState.md` throw, and converted the capped state into a
`STATE_ACTIONS` ERROR that dean retries every 30 minutes: the exact loop this
plan kills. Nothing outside that `case` reads the marks, so `WATERMARK` now
no-ops on `USER_BLOCKED`. `transition.test.js` pins that text, postback, quick
reply, read, delivery and echo on a capped state all no-op without calling
`getForm`. The other unguarded cases (`PLATFORM_RESPONSE`, `MACHINE_REPORT`,
`OPTIN`, `BAILOUT`, `REPEAT_PAYMENT`) are either dean-driven (dean skips
`USER_BLOCKED`) or need a message we no longer send; left as is.

## 13. Alternatives considered and rejected

- **Snapshot in the log (PR #166).** Second HTTP round trip per block, ordering
  against botserver outages, a loop guard, a new error tag, a ~11.5k-row
  backfill, and every refold still reads all post-block spam. Solves the wrong
  layer.
- **Freeze: read `states.state_json` on a Redis miss when `current_state =
  'USER_BLOCKED'`.** Works and needs no backfill, but adds a second source of
  truth for state next to the log and a scribble-lag race on unblock. Dropping
  the pointer achieves the same with the log as the only source.
- **Remove only the `START` guard, keep the pointer.** Durable, but every
  blocked row refolds to a husk with no `md` and no `forms` forever.
- **A Dean-written blocklist table checked at ingress.** Cross-component,
  touches the highest-traffic path mid-migration, and does nothing for the
  13.5k already-blocked states.

## Appendix: conversations above the 10,000 cap (vprod, 2026-09-05, §9 step 7)

Read-only run of the §9 query. Thirty-six rows. **The `n` column is the raw row count
and overstates what the cap sees**: the cap counts pointer-truncated rows, and a live
conversation with a pointer replays only from it. The four `QOUT` rows with events
this week (`26454786857469026`, `24548331401532124`, `6360780904035130`,
`4453475708012278`) are all **internal tester accounts** on the vlab team's pages
(`worldbank@vlab.digital`) and the Upswell Bauchi page: dozens of distinct test forms
each (`test_url_enforcement2`, `passthreadcontroltest`, `utilitymessagetest`,
`form.FORMNAME`...), `form.reset` referrals (123 for `4453475708012278`), and every one
carries a pointer from a recent reset. Their pointer-truncated history is **20 to 515
events**, so none of them will be capped. Their raw logs are big because each is
years of re-running surveys: roughly half the rows are `machine_report` events, a
quarter are echoes of bot messages, and the daily 05:00/11:00 tail is dean
`follow_up`/`bailout` churn with zero human input since mid-August. `5949070365165277`
(85k events, `ERROR`, no pointer) is one of the three no-`block_user` husks named in
`documentation/states-debugging.md` and will be capped, which stops its retries.
Everything else last moved in 2025 or earlier.

```
       userid       |    account_id    | current_state | platform  |    current_form     |   n    |         last_event
--------------------+------------------+---------------+-----------+---------------------+--------+-----------------------------
   6172131806131613 | 1855355231229529 | BLOCKED       | NULL      | unicefpaytrturkish  | 284977 | 2024-03-03 18:13:42.249+00
   5949070365165277 |  106964348279583 | ERROR         | NULL      | NULL                |  85632 | 2026-09-05 13:30:05.818+00
   4508322405882740 | 1855355231229529 | END           | NULL      | nghcpost1           |  69724 | 2023-10-11 00:06:32.336+00
   6075413449177589 | 1855355231229529 | BLOCKED       | NULL      | unicefpaytrturkish  |  64624 | 2024-02-13 18:38:36.367+00
   4902770643113340 | 1855355231229529 | END           | NULL      | nghcbaseline        |  64580 | 2023-08-18 18:53:56.996+00
  26454786857469026 |  101435865704727 | QOUT          | messenger | hpvbailendline      |  47831 | 2026-09-05 11:00:06.534+00
   5043654402388492 | 1855355231229529 | END           | NULL      | nghcbaseline        |  39773 | 2022-05-03 14:43:43.954+00
   3337504222988716 | 1855355231229529 | ERROR         | NULL      | NULL                |  37355 | 2020-12-19 08:57:44.811+00
   3073358766120536 | 1855355231229529 | BLOCKED       | NULL      | mnm_endlinehin      |  36866 | 2021-09-12 18:00:13.792+00
   3817088528307628 | 1855355231229529 | ERROR         | NULL      | mnm_endlinehin      |  35678 | 2021-08-14 05:30:14.356+00
   3565198563510832 | 1855355231229529 | ERROR         | NULL      | mnm_endlinehin      |  34426 | 2021-08-03 06:00:13.291+00
   4072261642844063 | 1855355231229529 | QOUT          | NULL      | mnm_endlinehin      |  34220 | 2021-08-01 17:00:20.338+00
   3272101606220688 |  106248114503554 | ERROR         | NULL      |                 305 |  32536 | 2020-12-19 08:58:01.81+00
   5985848994792099 | 1855355231229529 | BLOCKED       | NULL      | unicefpaytrturkish  |  32100 | 2024-06-08 00:00:15.775+00
   4548102908607086 | 1855355231229529 | QOUT          | NULL      | nghcpost1           |  26467 | 2025-06-11 21:15:52.654+00
   3019051374877859 |  100450211748271 | BLOCKED       | NULL      | mnm_endlinehin      |  24279 | 2020-12-15 22:31:06.848+00
   9096921400347889 | 1855355231229529 | BLOCKED       | NULL      | unicefpaytrturkish  |  24201 | 2024-02-11 18:08:21.66+00
   4115449651860146 |  100450211748271 | BLOCKED       | NULL      | mnm_endlinehin      |  23489 | 2020-12-15 22:31:14.515+00
   5555019144619954 | 1855355231229529 | BLOCKED       | NULL      | unicefpaytrturkish  |  23199 | 2024-03-20 06:08:11.686+00
   6954198871279386 | 1855355231229529 | BLOCKED       | NULL      | unicefpaytrturkish  |  22616 | 2024-08-02 00:00:25.856+00
   3281201208636665 |  100450211748271 | BLOCKED       | NULL      | mnm_endlineodi      |  22341 | 2020-12-15 22:31:26.615+00
   3255326744567955 |  103760978380374 | BLOCKED       | NULL      |                 305 |  21445 | 2021-03-13 07:39:31.698+00
   5998772416828405 | 1855355231229529 | BLOCKED       | NULL      | unicefpaytrturkish  |  21242 | 2024-02-14 14:35:55.391+00
   5223713570983857 | 1855355231229529 | END           | NULL      | nghcbaseline        |  20527 | 2022-05-02 11:52:26.289+00
   6360780904035130 |  111108121363615 | QOUT          | messenger | ecdenglish          |  19430 | 2026-09-03 11:00:13.468+00
   7993821270643561 | 1855355231229529 | BLOCKED       | NULL      | reset               |  18119 | 2023-05-26 13:59:24.788+00
   4453475708012278 |  758018254333043 | QOUT          | messenger | ENGbauchiMNCHend    |  16163 | 2026-09-03 05:04:19.413+00
   6393314760719482 | 1855355231229529 | RESPONDING    | NULL      | NULL                |  15984 | 2025-01-28 04:00:01.149+00
   4844772915640142 | 1855355231229529 | END           | NULL      | nghcbaseline        |  15279 | 2023-07-10 15:01:50.973+00
   2809033675789023 | 1855355231229529 | END           | NULL      | smlinterventiontest |  14844 | 2024-11-21 15:22:08.828+00
  24548331401532124 |  101435865704727 | QOUT          | messenger | hpvbailendline      |  14026 | 2026-09-05 11:00:05.026+00
  24952491944409262 |  881943064995558 | BLOCKED       | NULL      | hpvbailendline      |  13378 | 2026-05-24 12:00:24.802+00
   6886379814718978 |  111108121363615 | START         | NULL      | NULL                |  12210 | 2026-07-24 15:34:10.213+00
   3339284346091941 | 1855355231229529 | BLOCKED       | NULL      | mnm_endlinehin      |  11886 | 2020-12-15 22:25:56.935+00
   4346016308838546 |  102096262181249 | START         | NULL      | NULL                |  11586 | 2025-01-28 05:24:28.893+00
   3452447998101501 |  100450211748271 | BLOCKED       | NULL      | mnm_endlineeng      |  10167 | 2020-12-15 22:30:42.427+00
```
