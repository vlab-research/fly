# Why a minority of WhatsApp conversations have no `md.platform`

**Answers open question 5 of `planning/platform-guess-expiry.md` §9.**
Investigated 2026-09-04 against `vprod`. Read-only; no mutations were made.

> **2026-09-04, later the same day: §6's corrections have been APPLIED.**
> `planning/platform-guess-expiry.md` was rewritten around the two-bug framing
> this document established — erasure (this file) manufacturing the input to
> fabrication (the platform guess) — with §8's gates replaced for exactly the
> reasons §6 gives. The erasure fix is now **Task E** there, spec'd against
> `planning/blocked-user-durability-handoff.md`'s snapshot-in-log rather than
> §7's "narrow fix" (that doc rejects not-advancing-the-pointer explicitly:
> *"replaying 30k spam events in order to then trim them is precisely the OOM the
> pointer exists to prevent"*). This file remains the **evidence base** — §1's
> enumeration of every writer of `md`, §3's per-participant trace, and §5's four
> rejected hypotheses are not repeated there.
>
> Two numbers below have moved and are re-measured in that file: the reservoir is
> **11,492** (not 11,493), and §7's *"~10–30/hour"* is a **row-update churn**
> measure — Dean rewrites the same rows every sweep — not a participant-arrival
> rate, which runs ~40/day.
>
> §0's *"not a second bug… a third, older bug"* is right about provenance and is
> phrased against the old plan's numbering. In the current framing it is **bug 1**,
> and it is the generator.

<!-- Search aliases: md.platform NULL, states.platform NULL asymmetry,
     User without metadata, husk state, message_pointer truncation, block_user
     pointer, 61 of 14433, vlpulseng, second bug, STATE_ACTIONS alternating,
     token not found alternating, dean redo loop. -->

---

## 0. Verdict, up front

**Not a second bug, and not a consequence of the platform guess. It is a
*third*, older bug that was already diagnosed and documented — and only
half-fixed.**

The 61 (now 71) NULL-`platform` rows on account `1203867182815254` are **husks**:
states whose entire `md` object was destroyed by a windowed event-log re-fold,
the failure mode written up in `documentation/states-debugging.md` § "the husk".
`md.platform` is not missing on its own — the whole `md` is gone. `states.platform`
is NULL because `md` is NULL.

The causal arrow runs **opposite** to the hypothesis in the task brief. The
assume-messenger guess did not strip `md`. The husk destroys `md` first; the
resulting NULL `states.platform` is then what feeds Dean's
`COALESCE(platform, 'messenger')`. The two defects are **coupled downstream**
into a 30-minute alternating loop (§4), but the platform guess is not the cause.

| | |
|---|---|
| **Second bug?** | No — it is `documentation/states-debugging.md`'s husk bug, first documented 2026-07-30. |
| **Consequence of the assume-messenger guess?** | No. Hypothesis explicitly tested and **rejected** (§5). |
| **Benign?** | No. It is actively minting new husks on `vprod` at ~10–30/hour on this one account, from an at-risk pool of **11,493** conversations. |
| **Needs its own fix?** | **Yes**, and it is independent of Tasks A–D. See §7. |

**Correction the plan needs (§6):** `platform-guess-expiry.md` §4/§8 treat the
NULL-platform ERROR rows and the `token not found` ERROR rows as two populations.
They are the **same conversations in alternating 30-minute phases**. Task B will
not clear them; it converts a two-faced loop into a one-faced one.

---

## 1. Every writer of `md.platform`

Asked for explicitly. `states.platform` is a **computed column** — `(state_json->'md')->>'platform'`,
`devops/migrations/21-states-platform.sql` — so there is no writer of the column
itself, and `states` has exactly one writer (scribble; see
`documentation/states-debugging.md` § "Correction", which records that
`stateman.js` was dev-only and is deleted). Everything below is a write to
`state.md` inside replybot.

**Created in exactly one place:**

| site | what |
|---|---|
| `replybot/lib/typewheels/utils.js:399` | `md.platform = eventPlatform(event)` inside `getMetadata()`. **The only creator.** |
| `replybot/lib/typewheels/utils.js:164-177` | `eventPlatform()` — `source.type`, then `source.platform`, then the logged `messenger` guess. |

**`getMetadata()` is reached only through `_blankStart()`** (`machine.js:244-249`,
`md: getMetadata(event)`), which `exec()` returns from six places — all of them
"this conversation is starting":

| `machine.js` | case |
|---|---|
| 152 | `_handleExternalEvent` when `state.state === 'START'` |
| 375 | `REFERRAL` (`conversation_started`) |
| 597 / 612 / 627 / 641 | `POSTBACK` / `QUICK_REPLY` / `TEXT` / `MEDIA`, only when `state.state === 'START'` |

**Carried forward (merges — cannot regenerate a lost `md`):**

| `machine.js` | action | expression |
|---|---|---|
| 267 | `_stitch` → `SWITCH_FORM` | `{ ...state.md, ...stitch.metadata, startTime }` |
| 161 / 180 | `_handleExternalEvent` | `{ ...state.md, ...md }` |
| 694 | `apply` `RESPOND` | `{ ...state.md, ...output.md }` |
| 758 / 772 | `apply` `HANDOFF` / `WAIT_EXTERNAL_EVENT` | `{ ...state.md, ...output.md }` |
| 519 | `BLOCK_USER` → `RESET` | `md: state.md`, added deliberately by `fc89b37b` |

**Sites that can lose `md`:**

| `machine.js` | action | note |
|---|---|---|
| 723 | `apply` `RESPOND_AGAIN` | rebuilds `{...state, ...}` and **never names `md`** — harmless when `state.md` exists, fatal when it does not. This is the Dean-redo path. |
| 736 | `apply` `SWITCH_FORM` | `..._initialState()` then `md: output.md` — always rewritten, never lost. |
| 717 | `apply` `RESTORE_STATE` | `..._initialState()` + the event's snapshot; `md` is whatever the snapshot carried. |
| 705 | `apply` `RESPOND_AND_RESET` | `..._initialState()` with no `md`. **Dead code — no `exec()` site produces this action** (verified: the string appears only at `machine.js:705` and `:836`). |

`{ ...undefined, ...undefined }` is `{}`, which is why a merge onto a missing
`md` yields an empty object rather than restoring anything. Both shapes appear in
production (§3).

---

## 2. What actually distinguishes the 71

The brief's numbers had already moved by the time I measured. Reproduced on
`vprod`, 2026-09-04 ~23:10 UTC:

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE platform IS NULL) AS platform_null,
       count(*) FILTER (WHERE platform='whatsapp') AS wa,
       count(*) FILTER (WHERE platform='messenger') AS ms,
       count(*) FILTER (WHERE state_json->'md' IS NULL) AS md_absent,
       count(*) FILTER (WHERE state_json->'md' IS NOT NULL AND platform IS NULL) AS md_empty
FROM states WHERE pageid='1203867182815254';
```

```
total  platform_null  wa      ms  md_absent  md_empty
14485  71             14414   0   60         11
```

**The `md` key is entirely absent on 60 of the 71.** This is not a `platform`
field that failed to be written into an otherwise healthy `md` — it is a state
with no metadata at all. The remaining 11 have `md = {}` (an empty object), the
`{...undefined, ...undefined}` shape from §1.

```sql
SELECT (state_json->'md' IS NULL) AS md_absent, current_state, error_tag,
       count(*), min(updated), max(updated)
FROM states WHERE pageid='1203867182815254' AND platform IS NULL
GROUP BY 1,2,3 ORDER BY 4 DESC;
```

```
md_absent  current_state  error_tag      count  first_upd             last_upd
t          ERROR          STATE_ACTIONS  53     2026-09-04 14:00:48   2026-09-04 23:00:35
f          ERROR          INTERNAL       11     2026-08-31 22:44:20   2026-09-04 23:13:09
t          ERROR          REF_DECODE     7      2026-08-31 22:51:00   2026-09-02 13:33:02
```

**Every NULL-platform row is in `ERROR`.** There is no NULL-platform row in any
healthy state. That alone rules out "a cohort of conversations that started
before the `md.platform` deploy": such a cohort would be spread across `END`,
`QOUT`, `USER_BLOCKED` like everything else.

The correlations the brief asked about, ruled out one by one:

| candidate | ruled out because |
|---|---|
| **creation-date / deploy cutover** | `md.platform` has been written since `0a130a7a` (2026-07-22, shipped in the 1.3 deploy 2026-08-25). Every affected conversation **started after** that: e.g. userid `2349021041155` entered on 2026-08-31 with `r.AQl2bHB1bHNlbmfryTC5uw`, and its own event log shows `"md": {"form": "vlpulseng", ..., "platform": ...}` on machine reports through 2026-08-31 22:49. It **had** `md.platform` and lost it. Not a cutover. |
| **synthetic (Dean / dinersclub) vs genuine inbound entry** | All 71 entered genuinely, via WhatsApp text refs. Synthetic events are the *amplifier*, not the entry. |
| **referral vs organic** | Both affected and unaffected conversations enter the same way. |
| **`current_state`** | Correlated, but as an effect: `ERROR` is where the husk lands, not where it comes from. |
| **form / survey** | Single form (`vlpulseng`) on this account; no discrimination available. |

The actual discriminator is **a prior `block_user` event**, §3.

---

## 3. The mechanism, traced per row

`documentation/states-debugging.md` § "the husk" describes this. What follows is
the 2026-09-04 WhatsApp instance of it, confirmed end-to-end on three
participants from the durable log in `messages`.

### The chain

1. **Dean's `Spammers()` sweep publishes `block_user`** (`dean/queries.go:103`,
   `getBlockUser`). On this account that happened *en masse* around 2026-09-01:
   11,493 conversations.

2. **`BLOCK_USER` sets a pointer.** `machine.js:507-520` returns
   `action: 'RESET'` with
   `stateUpdate: { state: 'USER_BLOCKED', pointer: nxt.timestamp, forms: state.forms, md: state.md }`.
   `md` is preserved — that is `fc89b37b` (2026-08-01, replybot v0.0.214),
   the fix for the *primary* husk path. **But `pointer` is still advanced**, and
   it becomes `states.message_pointer` (`floor(pointer/1000)`,
   `devops/migrations/04-pointers.sql`).

3. **The Redis entry expires.** `state:whatsapp:<account>:<user>`, 24 h TTL.
   The blocked conversation is silent, so it simply ages out ~2026-09-02.

4. **Any later event is a cache miss, and the re-fold is truncated by the
   pointer.** `StateStore.getState` → `_getEvents`
   (`replybot/lib/typewheels/statestore.js:99-104`) → `chatbase.get`
   (`replybot/lib/chatbase/chatbase.js:82-88`):

   ```sql
   AND (s.message_pointer IS NULL OR s.message_pointer <= m.timestamp)
   ```

   The window therefore starts at the block, and the `conversation_started` that
   created `md` is outside it. Confirmed for a currently-blocked row using the
   doc's own recipe:

   ```sql
   SELECT count(*) AS events_after_pointer,
          count(*) FILTER (WHERE content LIKE '%conversation_started%'
                              OR content LIKE '%"referral"%') AS referrals_after_pointer
   FROM messages m
   WHERE m.userid='919217530196' AND m.account_id='1203867182815254'
     AND m."timestamp" >= (SELECT message_pointer FROM states
                           WHERE userid='919217530196' AND pageid='1203867182815254');
   -- 2 | 0
   ```

   Zero referrals in the replay window → the re-fold **provably cannot** rebuild
   `md`. The fold restarts from `_initialState()` = `{state:'START', qa:[], forms:[]}`
   (`machine.js:1022`), the `block_user` inside the window hits its own
   `if (state.state === 'START') return _noop()` guard (`machine.js:508`), and
   what comes out is a husk.

5. **The waking event.** In every case traced it was an ordinary WhatsApp
   delivery/read status webhook arriving days late — a `WATERMARK`, which
   `apply` handles as `{ ...state, ...output.update }` (`machine.js:678`), giving
   `{"forms":[],"qa":[],"read":<ts>,"state":"START"}`. Verbatim from the log,
   userid `2348146474963`, 2026-09-04 20:11:33:

   ```
   {"forms": [], "qa": [], "read": 1788552691000, "state": "START"}
   ```

6. **`actionsResponses` throws, untagged.** `transition.js:47-49`:

   ```js
   if (!newState.md) {
     throw new Error(`User without metadata: ${userId}. State: ${util.inspect(newState, null, 8)}`)
   }
   ```

   `transition.js:205` gives an untagged error `STATE_ACTIONS`, and
   `documentation/study-error-alerting.md` classifies that as a platform fault →
   a page. The very next log line, 20:11:33.338:

   ```
   {"error": {"message": "User without metadata: 2348146474963. State: { state: 'START', qa: [], forms: [], read: 1788552691000 ...
   ```

7. **The husk overwrites the `states` row** — and with it, `pointer` is gone, so
   `message_pointer` becomes NULL and `platform` becomes NULL.

### The two observed sub-populations

- **53 × `ERROR`/`STATE_ACTIONS`, `md` absent** — the state reached by Dean's
  redo. `REDO` → `RESPOND_AGAIN` (`machine.js:432-448` → `apply` at `:723`)
  never names `md`, so it stays absent, `newState.md` is falsy, and
  `transition.js:48` throws "User without metadata".
- **11 × `ERROR`/`INTERNAL`, `md = {}`** — the state reached when a *real user
  text* lands on the husk. `TEXT` on a non-`START` state returns `RESPOND`
  (`machine.js:622-636`), and `apply` `RESPOND` (`:694`) computes
  `{...undefined, ...undefined}` = `{}`. That empty object is **truthy**, so it
  passes the `transition.js:48` guard; `const { startTime } = newState.md` is
  `undefined`, `getForm(pageId, undefined, undefined)` throws, and
  `iowrap('getForm', 'INTERNAL', ...)` relabels it `INTERNAL`. Confirmed for
  userid `2348106749658`, whose log shows a `text` at 2026-09-04 23:13:09
  immediately before its row went to `INTERNAL`/`getForm`.
- The 7 × `REF_DECODE` are a **separate, smaller entry** into the same husk shape:
  `RefDecodeError` (`replybot/lib/errors.js:29-32`, thrown from
  `utils.js:307-342`, deliberately outside `getMetadata`'s catch) escapes
  `_blankStart` before `apply` runs, so the `ERROR` lands on a pristine
  `_initialState()`. These arise because WhatsApp entry refs come off
  **user-editable message text** (`event-normalizer.js:344-357`, `_refFromText`),
  and users mangle them. Corroborating evidence on the same account — 65
  `FORM_NOT_FOUND` rows with visibly corrupted shortcodes: `vlpulsung`,
  `vlpelsung`, `slpHlseng`, `v?pHlseng`, `6l`, `?l`.

### Per-participant confirmation

`messages` has `messages_userid_account_timestamp_idx (userid, account_id, timestamp) STORING (content, platform)`,
so a single conversation's whole log is a cheap indexed read. Three traced,
all identical in shape:

| userid | entered | `block_user` | first husk | current tag |
|---|---|---|---|---|
| `2349021041155` | 2026-08-31 22:26 (`r.AQl2bHB1bHNlbmfryTC5uw`, decoded fine, reached `age`) | 2026-09-01 15:26:59 | 2026-09-04 21:25:12 (`read` watermark) | `STATE_ACTIONS` |
| `2348146474963` | 2026-09-01 07:14 | 2026-09-01 15:20:25 | 2026-09-04 20:11:32 (`read` watermark) | `STATE_ACTIONS` |
| `2348106749658` | 2026-08-31 23:14 | 2026-09-01 01:12:43 | 2026-09-04 20:30 | `INTERNAL` (a real `text` at 23:13:09) |

---

## 4. Why the guess and the husk look like one bug

They are coupled, and it is worth stating precisely because §6's correction
depends on it. Verbatim from `messages`, userid `2348146474963`:

```
20:11:32  whatsapp   read         -> husk written, states.platform now NULL
20:30:23  messenger  redo         -> "failed to get token: token not found ..."
21:01:08  whatsapp   redo         -> "User without metadata: 2348146474963 ..."
21:30:35  messenger  redo         -> "failed to get token ..."
22:00:53  whatsapp   redo         -> "User without metadata ..."
22:30:47  messenger  redo         -> "failed to get token ..."
23:00:31  whatsapp   redo         -> "User without metadata ..."
```

Each 30-minute Dean sweep flips the row, because the two platform-keyed Redis
identities hold **different states** and both write the same `(userid, pageid)`
row:

- **whatsapp phase.** Row `platform` = NULL → Dean emits `messenger`.
- **messenger phase.** `state:messenger:...` is a miss. The husk write in the
  previous phase *removed the pointer*, so this re-fold is **untruncated**, reads
  the log from the start, and correctly rebuilds `md` with `platform: 'whatsapp'`
  (visible in the log: `{"errorOnset": ..., "forms": ["vlpulseng"], "md": {"form": "vlpulseng", ..., "platform": ...`).
  But `transition.js:37` takes the outbound platform from **the event**, which
  Dean stamped `messenger` — so `message-worker` picks the Messenger client
  (`messenger_client.go:63`, hardcoded `types.PlatformMessenger`), queries
  `entity='facebook_page'`, and fails. That `ERROR` state carries `md`, so the
  row's `platform` is `whatsapp` again → Dean's next sweep emits `whatsapp` →
  back to the cached husk. Repeat.

This is why the two symptoms appear as disjoint populations at any instant
(53 `STATE_ACTIONS` + 100 `token not found` on this account) while being the same
~153 participants observed half a cycle apart.

It also explains a detail the plan reads the other way: the `token not found`
rows have `states.platform = 'whatsapp'`, not NULL —

```sql
SELECT platform, error_tag,
  CASE WHEN state_json->'error'->>'message' LIKE '%token not found%' THEN 'token_not_found'
       WHEN state_json->'error'->>'message' LIKE 'User without metadata%' THEN 'user_without_md'
       ELSE left(state_json->'error'->>'message', 40) END AS msg, count(*)
FROM states WHERE pageid='1203867182815254' AND current_state='ERROR' GROUP BY 1,2,3 ORDER BY 4 DESC;
-- whatsapp | STATE_ACTIONS | token_not_found  | 100
-- NULL     | STATE_ACTIONS | user_without_md  |  53
-- whatsapp | FORM_NOT_FOUND| Survey with shortcode 6l ... |  46
-- NULL     | INTERNAL      | getForm          |  11
-- NULL     | REF_DECODE    | ref_decode       |   7
-- whatsapp | REF_DECODE    | ref_decode       |   7
-- (+ 12 more FORM_NOT_FOUND rows with corrupted shortcodes)
```

The credential is unambiguous and correct — one row, `whatsapp_business`,
`userid 10383123-…`, created 2026-08-05 — so a `whatsapp`-stamped send would
have succeeded. The failures are `messenger`-stamped ones.

---

## 5. The "did the platform guess strip `md`?" hypothesis — tested and rejected

The brief asked for this to be tested explicitly rather than waved away.

**Test 1 — can any code path on the guess's route delete `md`?** Enumerated every
`apply()` case (§1). The redo route is `REDO` → `RESPOND_AGAIN` → `apply:723`,
which spreads `...state` and never touches `md`. It cannot remove what is there.
The only `apply()` cases that rebuild from `_initialState()` are `RESET`
(names `md: state.md` explicitly, `machine.js:519`), `RESTORE_STATE` (takes the
event's snapshot), and `RESPOND_AND_RESET` (**no producer — dead code**).
**Conclusion: no.**

**Test 2 — is `RESTORE_STATE` responsible?** It sets `pointer: nxt.timestamp`
(`machine.js:420`). None of the 60 `md`-absent rows has a `pointer` in
`state_json` at all (`has_pointer = f` for all 60; measured). **Ruled out.**

**Test 3 — direction of the arrow, from the log.** For all three traced
participants, the **first** husk-producing event is a genuine WhatsApp `read`
watermark on the `whatsapp`-keyed conversation, and it *precedes* the first
`messenger`-stamped Dean redo by 19–55 minutes (20:11:32 vs 20:30:23 for
`2348146474963`). The NULL exists before the guess can act on it.
**The husk causes the NULL; the NULL triggers the guess. Not the reverse.**

**Test 4 — is it a version cutover?** No. `md.platform` first written by
`0a130a7a` ("feat(platform): thread platform through the whole pipeline",
2026-07-22), shipped in the 1.3 deploy 2026-08-25 (`documentation/platform-abstraction.md`).
Every affected conversation started **after** that and is *observed in its own
event log* carrying `md.platform` before losing it. **Ruled out.**

---

## 6. What this means for `planning/platform-guess-expiry.md`

I did not edit that file (per instruction). These are the corrections it needs.

1. **§4's table and §8's baseline query conflate two symptoms.** The
   `whatsapp_business | ERROR | 61` row is *not* the token-not-found incident;
   it is the husk population. They alternate on the same rows every 30 minutes
   (§4 above). §8's gate #1 (`platform IS NULL … target: zero whatsapp_business rows`)
   **will not reach zero after Task B**, because Task B does not create `md`.
   After B, those rows stop alternating and sit permanently on
   `User without metadata` / `STATE_ACTIONS` — still NULL, still swept, still
   paging.
2. **§8's gate #2** filters `error->>'message' LIKE '%token not found%'` and so
   counts only the half of the population that happens to be in its messenger
   phase at query time. It will *appear* to drain after Task B while the same
   participants remain broken.
3. **Task D will not recover these participants.** Clearing the Redis cache
   drops the cached husk, but the *next* re-fold is untruncated only if the
   pointer is already gone; where the row still carries a pointer the re-fold
   reproduces the husk. `devops/clear-state-cache.sh` is the right tool for the
   phantom-key half and is inert against this half.
4. **§9 Q5's premise is slightly off** and worth restating when it is closed:
   it is not that these conversations "lose `md.platform`", it is that they lose
   `md` entirely, and the fix lives in replybot's replay, not in Dean.

---

## 7. Recommendation: it does need its own fix

Independent of Tasks A–D. It is not blocked by them and does not block them.

**It is live and growing.** New husks are appearing on this account at roughly
10–30/hour, a steady trickle rather than a wave (`states` updates on 2026-09-04
by hour: 6, 10, 11, 12, 29, 23, 13 `ERROR` rows/hour from 17:00 to 23:00). It is
not a Redis restart — `gbv-redis-master-0` has 7 d uptime, `expired_keys 16450`,
ordinary TTL expiry.

**The at-risk pool is large and overwhelmingly WhatsApp** — which is the answer
to "why WhatsApp?":

```sql
SELECT c.entity, count(*) AS user_blocked_with_pointer, count(DISTINCT s.pageid) AS accounts
FROM states s JOIN credentials c ON c.key=s.pageid AND c.entity IN ('facebook_page','whatsapp_business')
WHERE s.current_state='USER_BLOCKED' AND s.message_pointer IS NOT NULL GROUP BY 1;
-- facebook_page     |  2012 | 34 accounts
-- whatsapp_business | 11493 |  1 account
```

Every one of those 11,493 becomes a husk the moment (a) its Redis entry has aged
out and (b) any event arrives. WhatsApp makes (b) far likelier than Messenger
does, because status webhooks (`sent`/`delivered`/`read`) keep arriving for old
messages long after the participant has gone quiet. The asymmetry is not
"WhatsApp writes `md.platform` badly" — it is "WhatsApp has 5.7× more
pointer-carrying blocked conversations than all of Messenger combined, and more
ways to wake them."

**Suggested shape (not a decision — this is Plan's call):**

- **The narrow fix: do not advance `pointer` in `BLOCK_USER`.** `fc89b37b`
  correctly stopped `md` being dropped from the live state, but left the pointer
  that makes the same `md` unrecoverable from the log. `machine.js:519`'s own
  comment reasons only about the in-memory merge; it does not consider the
  re-fold. Removing `pointer` there costs a longer replay window for blocked
  users and buys back recoverability. This is one line plus a
  `machine.test.js`/`statestore` regression test that folds a blocked
  conversation from a *truncated* window and asserts `md` survives.
- **The defensive fix: make `RESPOND_AGAIN` refuse a state with no `md`.** A
  redo onto a husk cannot succeed by construction; right now it burns
  `DEAN_RETRY_MAX_ATTEMPTS` (60, `devops/values/production.yaml:415`) per state
  and pages on every attempt. `_noop()` there, or a tagged non-`STATE_ACTIONS`
  error, stops the paging without hiding the problem.
- **Tag the guard.** `transition.js:48`'s `throw new Error(...)` is untagged and
  therefore becomes `STATE_ACTIONS` — "platform fault", which pages the on-call
  for a data problem, *and* puts it in `DEAN_ERROR_TAGS` so Dean amplifies it.
  Giving it its own tag (e.g. `LOST_METADATA`) both stops the page and removes
  it from the retry set. Note the counter-argument already recorded in
  `documentation/states-debugging.md` § "An `ERROR` state with a retryable tag
  was considered and is worse" — that discussion is about a *different* refusal
  and should be re-read before acting, but the conclusion there (a new tag means
  nothing sweeps it) is the desired outcome here, not a hazard.
- **Do not special-case anything.** The doc's 2026-07-30 warning still holds:
  25% of the cases it traced were not handover-driven, and the WhatsApp cases
  here are watermark- and text-driven.

**Do not** backfill `md` into these rows. Same reasoning as
`platform-guess-expiry.md` §4: it buys days and leaves the generator intact. The
generator here is the pointer, not the platform guess.

---

## 8. Queries run (all read-only, all bounded)

Every query above was run as
`kubectl exec -n vprod gbv-cockroachdb-0 -- ./cockroach sql --insecure -d chatroach -e "…"`.
Predicates were kept on `pageid` (14,485 rows) or on an indexed
`(userid, account_id)` lookup into `messages`; the two full-`states` aggregates
(1.1 M rows) match the shape the plan already runs in §8. Migration 26's REMOVAL
GATE query was **not** run. No mutation of any kind was issued — no `patch`,
`edit`, `apply`, `delete`, `helm`, or SQL write.

## 9. Gaps and things marked UNVERIFIED

- **Why 11,493 conversations on one account were blocked around 2026-09-01** is
  not established here. `dean/queries.go` `Spammers()` is the publisher
  (`getBlockUser`, line 103); the two selectors are 25 identical QA answers or
  `externalEvents > DEAN_SPAMMER_EXTERNAL_EVENTS_MAX`. Which one fired, and
  whether 79% of an account's conversations *should* be blocked, is
  **UNVERIFIED** and looks like its own investigation.
- **The exact `apply()` hop for the 7 `REF_DECODE` husks** is inferred from the
  code path (`RefDecodeError` escaping `_blankStart` before `apply` runs) plus
  the co-located corrupted-shortcode `FORM_NOT_FOUND` rows. I did not trace one
  of those 7 through `messages` the way I traced the three `block_user` cases.
  **Partially verified.**
- **Whether the same husk trickle is occurring on other WhatsApp accounts** is
  not measurable here: this is the only `whatsapp_business` account in
  `credentials` with a `USER_BLOCKED` population.
- **`documentation/states-debugging.md` is now partly stale** on one point: it
  says `BLOCK_USER`'s `stateUpdate` is `{ state, pointer, forms }` and that `md`
  "is silently dropped". Since `fc89b37b` the code reads
  `{ state, pointer, forms, md: state.md }`. The doc's *conclusion* still holds
  via the replay path, but the sentence describing the code no longer matches it.
  Fixing that belongs in a documentation pass, not here.
