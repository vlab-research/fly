# Incident: Production Facebook traffic leaking into STAGING — Remediation Plan

**Status (2026-07-15):**
- **Bleed stopped** (Helm fix, rev 608, Jul 13 21:10).
- **P1 message recovery: VERIFIED COMPLETE** — no real user messages lost (details in Part 3).
- **P2 state corruption: diagnosed in full.** Split into three categories (Part 3). One category — a surge of **~130 falsely USER_BLOCKED prod participants** (Part 4; now **127**) — is the main open problem and the subject of the remediation plan in **Part 6**.
- **Mitigation applied:** `gbv-dean-spammers` cronjob **suspended** in `vprod` to stop further false blocks (Part 5).
- **`restore_state` machine change: BUILT, DEPLOYED, VALIDATED, and BATCH-EXECUTED.** Clean replybot **v0.0.204** (= v0.0.200 + `restore_state` only) live in vprod, 8/8 healthy.
- **RESCUE COMPLETE (2026-07-17):** all **118** falsely-`USER_BLOCKED` participants restored + re-driven; `USER_BLOCKED` remaining = **0**. 104 reachable (endline delivered/in progress), 14 genuinely unreachable at Facebook (`#551`/`#100`). Full write-up in **Part 6.5-BATCH-RESULTS**. Cleanup done: timeout window reverted to 72h, spammers cron re-enabled.

**Environment:** GKE context `gke_toixotoixo_europe-west1-b_toixo`, namespaces `vstag` (staging) / `vprod` (production), CockroachDB `chatroach`, shared Kafka cluster in `default` namespace.

---

## Part 1 — Incident background & root cause

A Helm deploy error (revision 607, 2026-07-10 19:54) deployed **staging values** to the **production** namespace. The release was marked "failed" (Ingress host conflicts) but the **Deployment env vars were already patched** — all prod services (botserver, replybot, scribble, message-worker, dinersclub) switched from `vlab-prod-*` Kafka topics to `vlab-staging-*` topics.

Because both namespaces share one Kafka cluster (`kafka-headless.default.svc.cluster.local:29092`) and use **identical consumer-group names** (`replybot`, `scribble-messages`, `scribble-states`, `scribble-responses`, `scribble-chat-log`, `message-worker`, `dinersclub`), Kafka split partitions between staging and prod pods. Consequences during the leak window:

1. ~50% of prod webhook events consumed by **staging** replybot (no page credentials → `getPageToken` errors).
2. ~50% of prod messages written to the **staging** DB by staging scribble (other ~50% to prod DB).
3. Staging error **states** UPSERTed into the **prod** DB (overwriting valid prod states).
4. Staging dean retried prod users it found stuck; prod dean later acted on distorted states.

**Root cause timeline:**
- **Rev 606** (Jul 7): prod correctly on `vlab-prod-*`.
- **Rev 607** (Jul 10 19:54, FAILED): `helm upgrade gbv ./devops/vlab -f devops/values/staging.yaml -n vprod` — Deployments patched to `vlab-staging-*`.
- **Rev 608** (Jul 13 21:10, FIX): `helm upgrade gbv ./devops/vlab -f devops/values/production.yaml -n vprod` — restored `vlab-prod-*`. Pods rolled ~22:01 Jul 13.

---

## Part 2 — Critical architectural reframe (READ THIS FIRST)

This reframes the entire remediation. Source: `documentation/states-debugging.md` + code.

**State is a pure fold over the event log.** `replybot/lib/typewheels/machine.js:870`:
```js
function getState(log) {
  return log.reduce((s, e) => apply(s, exec(s, e)), _initialState())
}
```

**Redis is the runtime source of truth; the CockroachDB `states` table is only an observability dump.** Replybot replays state from the event log with Redis as a 24h cache and **never reads the `states` table**. Dean and the dashboard read `states`. Implications:

- The **event log = the `messages` table** is the true source. State can always be **recomputed** by re-folding a user's messages.
- The leaked/corrupted `states` rows do **not** themselves block anyone at runtime — they are stale observability that gets overwritten the next time a user has activity (replybot recomputes and republishes → scribble UPSERTs).
- The **only genuine runtime corruption** is where **prod** replybot itself cached a bad state in **prod Redis** — i.e. the USER_BLOCKED surge (Part 4), which prod dean→prod replybot produced.

**Event load is pointer-based.** `@vlab-research/chatbase-postgres/lib/index.js:21-28` (used by replybot's `StateStore`):
```sql
SELECT * FROM messages
LEFT JOIN (SELECT userid, message_pointer FROM states WHERE userid = $1) USING (userid)
WHERE userid = $1 AND (message_pointer IS NULL OR message_pointer <= timestamp)
ORDER BY timestamp ASC
```
Only events **at/after** the user's `message_pointer` are re-folded. `message_pointer` is a computed column on `states`: `floor((state_json->>'pointer')::INT8 / 1000)::TIMESTAMPTZ`. **This pointer mechanism is central to the fix in Part 6.**

---

## Part 3 — Current data-integrity status (verified this session)

Six affected pages (referenced throughout as **THE 6 PAGES**):

| Page ID | Name |
|---|---|
| `101435865704727` | Our World In Surveys |
| `758018254333043` | Global Health Hub |
| `1855355231229529` | Virtual Lab (prod smoke page) |
| `111108121363615` | Digital Insights |
| `110749071412124` | Listening Project |
| `107718334922830` | Digital Media Experiment |

### 3a. P1 — Messages: ✅ VERIFIED COMPLETE, no action needed
- Method: pulled per-user message counts from staging (source, filtered) and prod (destination) for THE 6 PAGES; compared by exact `(userid, hsh)`.
- Staging filtered total since Jul 10: **60,011**; prod (same userids): **76,216**.
- 441 leaked users. For 54 of them, staging had rows prod didn't — **157 rows total**. Every one is a **synthetic staging-error event** (39 `redo`, 99 `machine_report`, 19 `block_user`, all `source:synthetic`, all `getPageToken`/`Cannot find token` errors). **Zero real user messages missing.** Their absence from prod is correct.
- The Jul 14 02:31 `message-recovery` K8s Job (`default` ns) completed successfully; recovery is confirmed complete by the count comparison above.

### 3b. Prod `messages` pollution: LEAVE AS-IS (user decision)
- Prod's `messages` table absorbed **~10,915** staging-origin error events (`Cannot find token for facebook page`) during the leak (prod scribble's 50% partition share consumed staging replybot's error reports). Log noise, no functional harm.
- **Do NOT delete these** (explicit user instruction — deleting from prod messages is dangerous). They also self-limit: replybot never reads them; dean's spammer path (which they distorted) is now suspended.

### 3c. P2 — Corrupted states, three categories

Counts on THE 6 PAGES, `updated > '2026-07-10'` (measured Jul 14 ~15:30 UTC; BLOCKED/USER_BLOCKED grew during the session as the overnight surge landed):

| Category | Count | Self-heals? | Disposition |
|---|---|---|---|
| **ERROR** — `getPageToken`, `error_tag=INTERNAL` | 13 | ✅ **Yes** | Leave. `error_tag` is in dean's `DEAN_ERROR_TAGS`; only 11/60 retries used; prod has tokens now → next backoff retry (~Jul 15) heals them. See 3d. |
| **BLOCKED** — message-worker `token not found for platform account …`, `fb_error_code=NULL` | 193 | ❌ **No** | Dean's Blocked query requires `fb_error_code = ANY(DEAN_FB_CODES)`; `NULL` never matches → never retried. But these are observability-only (replybot doesn't read `states`); they self-correct on the user's next activity, OR the Part 6 mechanism can cover them too. See Part 7. |
| **USER_BLOCKED** — false spammer blocks | **~130** | ❌ **No (terminal) + was recurring** | **Main problem — Part 4 + Part 6.** |

Also present and **must NOT be touched**: real FB blocks among BLOCKED (`#551 This person isn't available`, `#100 No matching user found`, `#10 outside allowed window`, `#190 session invalidated`) — legitimate prod conditions.

### 3d. Credentials confirmed present
Prod `credentials` table has exactly **1 token row for every one of THE 6 PAGES** (token lookup is `SELECT details->>'access_token' FROM credentials WHERE facebook_page_id=$1 ORDER BY created DESC LIMIT 1`, `replybot/lib/typewheels/tokenstore.js:8`). So prod replybot can process these pages; the residual `getPageToken`/`token-not-found` errors are stale (last genuine `getPageToken` retry Jul 14 01:00; last genuine `token-not-found` retry Jul 13 18:30 — both before/at the tail of the fix; later `updated` bumps are stale Kafka replays).

---

## Part 4 — The USER_BLOCKED false-block surge (the main open problem)

**Finding:** USER_BLOCKED on THE 6 PAGES jumped from ~64 to ~132, with **130 new blocks overnight Jul 14 01:00–08:00** (peak at the 03:30 spammers cron). Baseline is **~1/day** (Jun 27, Jun 29, Jul 10, Jul 11 each had 1). So Jul 14 is a **~130× anomaly** — leak-induced false-blocking of real prod participants.

**Mechanism:** `dean/queries.go:246` `Spammers()` blocks a user when:
```sql
s.current_state != 'USER_BLOCKED' AND (
  s.state_json->'qa'->-1->>0 = s.state_json->'qa'->-25->>0        -- last 25 answers identical
  OR (s.state_json ? 'externalEvents' AND jsonb_array_length(s.state_json->'externalEvents') > $1)  -- $1 = 100
)
```
The leak distorted prod users' states — `externalEvents` inflated by the flood of leaked synthetic events, and/or `qa` stuck repeating because replybot couldn't respond during the leak. The first post-fix spammers run (Jul 14 03:30) evaluated these distorted states and emitted `block_user` for 130 legitimate participants → prod replybot set them USER_BLOCKED (in prod Redis **and** the `states` table).

**Why it's serious:**
- USER_BLOCKED is **terminal** — no dean query retries it; these never self-heal.
- It was **recurring** (next spammers run would block more) — now mitigated by the suspension in Part 5.
- The block wipes conversation position (see Part 6) — but the participants' **survey answers are already safe in the `responses` table** (written separately, `ON CONFLICT (userid, timestamp, question_ref) DO NOTHING`). We are recovering conversation *position/state*, not lost research *data*.

---

## Part 5 — Actions taken this session
- **Suspended the spammers cron** so no further false blocks occur:
  ```bash
  kubectl --context gke_toixotoixo_europe-west1-b_toixo patch cronjob gbv-dean-spammers -n vprod -p '{"spec":{"suspend":true}}'
  ```
  Verified `suspend=true` (was `schedule=30 3 * * *`, `suspend=false`).
  **Reverse with:** `kubectl … patch cronjob gbv-dean-spammers -n vprod -p '{"spec":{"suspend":false}}'` — **do NOT re-enable until the corrupted states are cleaned**, or it will re-block users.
- No other writes performed. All state/message investigation was read-only.

---

## Part 6 — REMEDIATION PLAN: restore the ~130 USER_BLOCKED via a synthetic `restore_state` event

### 6.0 Goal & strategy
Un-block the ~130 false-blocked participants **and restore their full conversation state (`qa`, `forms`, position)**, durably, **without deleting or mutating any existing prod messages** (append-only). Then let dean re-drive them normally.

### 6.1 Why the naive fixes fail (the `qa` problem, and why it's actually solvable)
`BLOCK_USER` (`machine.js:401`) does `action: 'RESET'` with `stateUpdate: { state:'USER_BLOCKED', pointer: nxt.timestamp, forms: state.forms }`. `RESET` apply (`machine.js:607`) is `{ ..._initialState(), ...stateUpdate }` → **`qa` is wiped to `[]`** the instant `block_user` is folded, and `message_pointer` is set to the block time.

Consequences:
- **Just flushing Redis:** reload starts at `message_pointer = block_time`; the first folded event is `block_user`, and from `START` it **noops** (`machine.js:402` `if (state.state === 'START') return _noop()`). So they become `START` (un-blocked) — but with **empty `qa`** (pre-block events are excluded by the pointer) and dormant (no dean query drives `START`).
- **Resetting the pointer before the block** to re-fold `qa`: now `block_user` applies from a mid-survey state → **re-blocks** and re-wipes `qa`. This is the "they'll get blocked again" trap.
- Existing `UNBLOCK` event (`machine.js:390`) only exits `BLOCKED`, not `USER_BLOCKED`, and preserves only what's in the (already-wiped) state.

**But `qa` is not truly lost** — it is a fold over the user's answer events, all of which are **still in `messages`**. It is fully reconstructable by folding the user's log **excluding the `block_user` event**.

### 6.2 The durable mechanism (self-contained state snapshot)
Precedent: `machine_report` events already carry a full state object (`event.value.newState`) in their payload (`machine.js:297`). We use the same idea:

1. **Offline, per user:** fold the user's message log **excluding the `block_user` event** → the exact pre-block state **P** (full `qa`, `forms`, `md`, `question`, `wait`, etc.).
2. **Emit a synthetic `restore_state` event carrying P as payload**, timestamped *now* (`T_now`).
3. New machine handler sets `state = P` and `pointer = T_now` — **unconditionally** (must fire from any state, see 6.3 note).

**Why durable & no re-block:** because the event *carries* the whole state, the pointer can be advanced to `T_now`. On any future Redis-miss reload, the load query (`message_pointer = T_now`) starts **at the `restore_state` event** — it re-hydrates P from the payload and **never re-loads `block_user`** (which is before `T_now`). Full `qa` preserved, block never re-applies, dean sees a real state (RESPONDING/QOUT/WAIT) and re-drives normally.

### 6.3 Machine code change (replybot)
File: `replybot/lib/typewheels/machine.js`. Small, additive diff:

- **`categorizeEvent` (near line 173-180):** add
  ```js
  if (_synth('restore_state', nxt)) return 'RESTORE_STATE'
  ```
- **`exec` switch (add a case):**
  ```js
  case 'RESTORE_STATE': {
    // Recovery-only: overwrite state from a self-contained snapshot payload.
    // Unconditional so it works both live (from USER_BLOCKED) and on reload (from START).
    const restored = nxt.event.value.state
    return { action: 'RESTORE_STATE', stateUpdate: { ...restored, pointer: nxt.timestamp } }
  }
  ```
- **`apply` switch (add a case, near the RESET case ~607):**
  ```js
  case 'RESTORE_STATE':
    return { ..._initialState(), ...output.stateUpdate }
  ```
- **`act()` / responses:** ensure `RESTORE_STATE` produces **no outbound Facebook message** (it has no `response`/`question` to send). Verify the `act()`/`actionsResponses` path no-ops for this action (it should, since the output carries no responses). This is critical — we must not spam users on restore.

**Notes / safety:**
- Keep it **unconditional** (do not gate on `state.state === 'USER_BLOCKED'`), because on reload the fold starts from `START`; a gate on USER_BLOCKED would noop and break durability.
- The power of an unconditional state-overwrite is acceptable because these events are synthetic/internal and only generated by the recovery script for the target users. Consider logging when it fires.
- Add unit tests mirroring `machine.test.js` style: (a) `restore_state` from USER_BLOCKED sets P; (b) from START sets P; (c) no FB send emitted.
- Deploy: build replybot image, bump the tag in `devops/values/production.yaml`, `helm upgrade gbv ./devops/vlab -f devops/values/production.yaml -n vprod`. (Follow existing replybot deploy convention; run `nvm use` in `replybot/` per `replybot/CLAUDE.md`.)

### 6.4 Offline reconstruction + emit script
Base it on `replybot/lib/responses/debugger.js`, which already folds a single user's `messages` through the machine. Modify to:
1. Input: a target `userid` (+ its `pageid`).
2. Load all of that user's `messages` ordered by `timestamp ASC` (debugger's query).
3. **Exclude the `block_user` event(s)** — identify by `content` containing `"type":"block_user"` (equivalently, fold only events with `timestamp < <block_event_timestamp>`). Decide (see 6.6) whether to also exclude other **leak-injected synthetic events** (redo/machine_report/timeout during the leak window) for a cleaner P; recommended first pass is **exclude only `block_user`** (most faithful "undo just the block").
4. Fold the filtered log to produce **P** (reuse the machine the debugger uses; the fold is the same `getState`/`transition` logic).
5. Construct the synthetic event:
   ```json
   {
     "user": "<userid>",
     "page": "<pageid>",
     "event": { "type": "restore_state", "value": { "state": <P> } },
     "source": "synthetic",
     "timestamp": <now_ms>
   }
   ```
6. **Emit it through the normal pipeline** by POSTing to the botserver synthetic endpoint (same mechanism dean uses — `BOTSERVER_URL=http://gbv-botserver/synthetic` from inside the cluster). This flows: botserver → `vlab-prod-chat-events` → prod replybot processes `restore_state` (sets Redis + publishes state) → scribble writes messages + states. Append-only; no deletes.

Run the script from an in-cluster pod (e.g. a one-off Job, or the `gbv-state-debugger` pod) so it has DB + botserver access.

### 6.5 Validation FIRST (one user, then batch)
1. **Prove `qa` recovers (read-only):** pick ONE of the 130. Fold its log excluding `block_user` → P. Confirm `P.qa` is non-empty and complete by **cross-checking against that user's rows in the `responses` table** (their answered `question_ref`s should appear in `P.qa`). If it matches, reconstruction is faithful.
2. **End-to-end on one user (staging first if feasible):** deploy the machine change; run the script for the single validated user; confirm:
   - they leave USER_BLOCKED (states row shows the restored `current_state`, full `qa`);
   - **no** Facebook message was sent;
   - after clearing that user's Redis key (`state:<userid>`), a subsequent event reloads to P (durability holds — block does not re-apply).
3. **Batch the remaining ~129.** The exact userids are the USER_BLOCKED rows on THE 6 PAGES with `updated >= '2026-07-13 21:10'` (see Appendix C query). Re-derive the list at run time (don't rely on a stale snapshot).
4. **Flush Redis if desired** to force everyone else to recompute cleanly (covers 3c category BLOCKED/ERROR observability). The 130 are handled by their `restore_state` events regardless of Redis.

### 6.5-RESULTS — Executed 2026-07-15 (deploy + read-only validation)

**Deploy (done).** The `restore_state` handler is live in prod:
- `replybot/lib/typewheels/machine.js`: `categorizeEvent` → `RESTORE_STATE`; `exec` + `apply` cases set `state = {..._initialState(), ...snapshot, pointer: nxt.timestamp}` (unconditional, so it works live from USER_BLOCKED and on reload from START).
- `replybot/lib/typewheels/transition.js`: `RESTORE_STATE` short-circuits `run()` **exactly like `RESET`** — publishes `newState` to the state topic + Redis with **no `getPageToken`/`getForm`/`getUser` IO and no outbound FB message**. (Cleaner/safer than relying on `act()` to no-op.)
- Tests added to `machine.test.js` + `transition.test.js` (179 passing). Commits `5986b3e` (code) + `4f86f45` (prod values bump) on `main`, tag `replybot-v0.0.203`. Helm rev **609**, 8/8 pods healthy.

**Validation user:** `8915379505159684` / page `101435865704727` (first of the 127; a highly-engaged participant — 223 responses across 10 forms, Feb 2025→Jun 2026). Method: exported the user's full `messages` log (2482 events) byte-exact via base64, folded locally through the **real** `machine.js getState`.

Findings:
1. **The local fold is faithful.** Folding the full log *with* `block_user` reproduces the live DB row exactly: `USER_BLOCKED, qa=0, forms=10`.
2. **Survey answers are safe.** Reconstructed `qa` refs cross-check 4/4 against the `responses` table. (`qa` only ever holds the **current form's** Q&A — it is reset to `[]` on every `SWITCH_FORM` — so the "lost qa" was only the last form's 4 entries, all already in `responses`. **The plan's central 6.1 "qa problem" was overstated.**)
3. **"Exclude only `block_user`" (the 6.6 "faithful first" pass) is INADEQUATE.** It yields **`BLOCKED`**, not a healthy state — the pre-block state is itself leak-distorted (the user's last *real* activity was **Jun 29**; the ~1269 events after are a leak-induced `timeout` flood + error reports + the false block). Genesis re-fold also has a fidelity gap (`forms[0]=null` vs historical `"305"`).
4. **Best P source = the last pre-leak `machine_report.newState`.** For this user, the last `machine_report` before the leak (2026-06-29T06:07Z) records the bot's own authoritative state: **`WAIT_EXTERNAL_EVENT`**, `forms[0]="305"` (correct), `qa=4`, `wait={type:'timeout', value:{relative, '1 month'}}` — i.e. they had **completed the baseline and were waiting one month for the next survey wave**. A pre-leak-cutoff genesis fold (`ts < Jul 10 19:54`) agrees on the essentials (`WAIT_EXTERNAL_EVENT`, qa=4) but is lower fidelity (forms[0]=null, no exact `wait`).

**Implication:** the remediation's real value is **un-blocking so dean re-drives the next wave**, not "recovering lost answers." Restoring to the true pre-leak `WAIT_EXTERNAL_EVENT` puts each user back where dean's timeout cron picks them up normally.

**Multi-user spot-check (2026-07-15, read-only, 10 of 127 sampled evenly).** All 127 USER_BLOCKED-since-fix are on **one page** (`101435865704727`, Our World In Surveys) — a single "Girl Effect" study cohort. For all 10 sampled users, **both** reconstruction methods agree **10/10** on `WAIT_EXTERNAL_EVENT` with `wait={timeout: '1 month'}`; the fold-with-everything reproduces the live `USER_BLOCKED` 10/10. They had all **completed the baseline and were waiting ~1 month for the endline wave** when falsely blocked. Homogeneous, clean cohort; none mid-survey, none plausibly spammers.

**Two data/execution notes for the recovery script:**
- **Invalid-JSON events exist** in stored `content` (e.g. literal `\U00002019` escapes inside some `machine_report` payloads). `parseEvent` (`recursiveJSONParser`) **catches the parse error and returns the raw string → categorized `UNKNOWN` → noop**. So prod silently ignores these on any re-fold. The recovery script MUST tolerate them (lenient parse / skip), and this is why the **pre-leak-cutoff genesis fold is the robust primary** (same noop semantics as prod). `machine_report.newState` is higher fidelity (correct `forms[0]`, exact `wait`) — prefer it when its event parses, fall back to the cutoff fold. Both agreed on state for all 10 here.
- **Consequence of restoring:** these users' `wait` timeout (baseline + 1 month, ≈ Jul 11) is already **past**, so once restored to `WAIT_EXTERNAL_EVENT` dean's timeout cron will **immediately fire the endline survey** to them. That is the intended outcome (it's what would have happened absent the block), but it means a batch restore ⇒ ~127 endline sends. Plan/observe accordingly.

### 6.5-RESULTS-B — End-to-end single-user restore EXECUTED & VERIFIED (2026-07-15)

Ran the full restore on **one** user, `8915379505159684` (page `101435865704727`), P = last pre-leak `machine_report.newState` (`WAIT_EXTERNAL_EVENT`, qa=4, forms=10, wait=1 month; cutoff-fold agreed).

Emit path (exactly as dean does): `POST http://localhost:8899/synthetic` via `kubectl port-forward -n vprod svc/gbv-botserver 8899:80`, body `{user, page, event:{type:'restore_state', value:{state:P}}}` (botserver adds `source:'synthetic'` + `timestamp:Date.now()`). HTTP 200.

Verified:
1. **Un-blocked with full state.** `states` row went `USER_BLOCKED → WAIT_EXTERNAL_EVENT`, `qa 0→4`, `forms 10`, `wait.type=timeout`, **`pointer` 1783827100689 (block) → 1784122167153 (emit)**, within ~4s.
2. **No Facebook message sent.** replybot `REPORT` for the event = `{publish:true, newState:{state:'WAIT_EXTERNAL_EVENT',…}}` with **no `commands` field** (every other user's report in the same log carries `commands:[…]`). The `transition.js` short-circuit fired — no `getForm`/token IO, no send.
3. **Durable.** Replicating replybot's exact pointer-based load query returned just 2 events at/after the new pointer (`[restore_state, machine_report]`); folding them → `WAIT_EXTERNAL_EVENT` (qa=4). The `block_user` (before the pointer) is excluded — **block does not re-apply on reload.**

**BLOCKER found while observing downstream (2026-07-15): dean will NOT re-drive the restored WAIT users.** `gbv-dean-timeouts` (`dean/queries.go:160` `Timeouts`) only fires a timeout whose `calculated_timeout_date` is in the window **`(now − DEAN_TIMEOUT_MAX_PAST, now)`**, and **`DEAN_TIMEOUT_MAX_PAST=72 hours`**. This cohort's `timeout_date` is ~**2026-07-11** (waitStart Jun 11 + `1 month`) — their endline came due **during the leak** — so as of Jul 15 they are ~**104h past**, i.e. **outside the 72h window**. The restored test user sat untouched for ~50 min (`updated` unchanged) confirming this. All 127 share this. (Note `DEAN_TIMEOUT_BLACKLIST` is set, so the query returns *all* in-window matches — no `LIMIT 1` — meaning if the timeouts were in-window, dean would fire them all in one run: the "endline burst" is real *only if* re-armed into the window.)

**Consequence for the plan:** the assumption "restore to pre-leak WAIT, then let dean re-drive normally" is **incomplete**. Restoring the exact pre-leak state leaves them un-blocked/un-corrupted but **stranded** (dean ignores >72h-past timeouts). Options (a research/ops decision — see 6.6-REVISED-B):
- **A. Re-arm the timeout** in the restore snapshot: set `P.waitStart` so `timeout_date` lands within the last 72h (e.g. ~12h ago). Dean then fires each endline on its next run via normal machinery. Cleanest way to *deliver the missed endline* (a few days late). Per-user, no cluster-wide config change.
- **B. Manually fire the timeout** external event per user after restore (do dean's job directly). Direct, but 2 emits/user.
- **C. Temporarily raise `DEAN_TIMEOUT_MAX_PAST`** then revert — **broad**, affects every survey's past-due timeouts cluster-wide, not just these 127. Riskiest.
- **D. Un-block only** (restore as-is): they're corrected but do NOT get a late endline. Correct iff the study considers the endline window closed.

**The restore mechanism itself is fully proven.** What remains is the (D vs A/B) decision about whether/how to actually re-deliver the missed endline. Batch is paused pending that decision.

### 6.5-BATCH-RESULTS — Full batch EXECUTED & VERIFIED (2026-07-17)

Prereq: clean replybot **v0.0.204** (= v0.0.200 + `restore_state` only) built, deployed to vprod, 8/8 healthy (RESTORE_STATE handler live, so restored users reload correctly — the latent v200 reload bug is gone).

**Decision taken: Option C** (widen `DEAN_TIMEOUT_MAX_PAST`), per user. Chosen over A after confirming it was mechanically viable and low-collateral (below).

**Key pre-execution findings (schema/config validated against live prod):**
- Target set re-derived live: **118** `USER_BLOCKED` (down from 127), all on page `101435865704727`, forms `girleffectincentive`/`girleffectendlineincentive`/`hpvincentive`/`hpvendlineincentive`. **None on `DEAN_TIMEOUT_BLACKLIST`.**
- `states.timeout_date` is a **STORED computed column** derived from `state_json.wait`+`waitStart` (`wait.type='timeout'`, relative/absolute, regex-validated interval string). It is NULL while `USER_BLOCKED` (block wiped `wait`) and **auto-repopulates on restore**. `survey_settings.timeouts` is NULL/`[]` for all these forms, but dean's `Timeouts` query prefers the `timeout_date` column (`WHEN s.timeout_date IS NOT NULL THEN s.timeout_date`), so the empty survey_settings is irrelevant.
- Dean fires **all** in-window matches (blacklist set → no `LIMIT 1`), and duplicate timeout rows (many survey versions satisfy `created <= form_start_time`) are **safe**: `machine.js _handleExternalEvent` noops a timeout when `state !== 'WAIT_EXTERNAL_EVENT'`, so only the first advances the user → **one endline send each**.
- Reconstruction: **P = last pre-leak `machine_report.newState`** (`timestamp < 2026-07-10T19:54Z`). All 118 had one; **0 anomalies**. All → `WAIT_EXTERNAL_EVENT`, waits `111×"1 month"` + `7×"1 week"`, `externalEvents < 5`, `timeout_date` clustered **Jul 11–13** (oldest 6.4 d).
- Blast radius of widening (real `Timeouts` CTE, distinct other users): 72h→0, 6d→4, **7d–14d→9 (flat)**. Chose **10 days**: covers oldest with margin at the same 9-user cost.

**Execution (2026-07-17, ~20:40–21:10 UTC):**
1. Emitted **118 `restore_state`** via `port-forward svc/gbv-botserver 8899:80` → `POST /synthetic` — **118/118 HTTP 200**.
2. Verified: **all 118 `USER_BLOCKED → WAIT_EXTERNAL_EVENT`**, `timeout_date` populated on all 118, no FB message (transition short-circuit). Window still 72h so nothing fired prematurely.
3. `kubectl set env cronjob/gbv-dean-timeouts DEAN_TIMEOUT_MAX_PAST='10 days'` (20:42 UTC).
4. Dean drained on the 21:00 run: **not_yet_fired 118 → 0 by 21:08**. One endline send each.
5. Reverted `DEAN_TIMEOUT_MAX_PAST='72 hours'` (21:10 UTC).
6. Re-enabled `gbv-dean-spammers` (`suspend=false`), states now clean.

**Outcome — `USER_BLOCKED` remaining = 0.** Final cohort states: **101 `QOUT` + 3 `WAIT_EXTERNAL_EVENT`** (104 reachable, endline delivered / in progress) + **14 `BLOCKED`** = genuine unreachable FB conditions (**12× `#551` "person isn't available"**, **2× `#100` "no matching user found"**) — not fixable; `#551` will be retried naturally by dean-blocked. Rescue delivered the endline to every reachable participant.

Reconstruction/emit artifacts (session scratchpad, ephemeral): `reconstruct.js`, `batch_events.jsonl` (118), `targets.tsv`, `emit.js`, `monitor.sh` — recreate from this section + §4/§6.4 if needed.

### 6.6 Decisions to make during execution

**REVISED (2026-07-15) — reconstruction source.** Supersedes the original "faithful vs clean" note below. Per 6.5-RESULTS, **do NOT reconstruct by excluding only `block_user`** (yields a leak-distorted `BLOCKED`). Instead build P from the **last `machine_report.newState` with `timestamp < 2026-07-10T19:54:00Z`** (the leak start) — the bot's own authoritative pre-leak snapshot. Fallback for any user lacking a pre-leak `machine_report`: a **pre-leak-cutoff genesis fold** (`getState(events.filter(e => e.timestamp < LEAK_START))`). Set `pointer = T_now` on emit as designed. Recommended next step **before batch**: a small multi-user spot-check (fold ~8–10 of the 127) to confirm most land on a clean, dean-drivable pre-leak state (this user was a completed-baseline waiter; verify others aren't genuinely mid-survey).

**Original note (kept for context):**
- **Faithful vs clean reconstruction:** exclude only `block_user` (simple, faithful — may restore a slightly leak-distorted pre-block state that dean then re-drives) vs. also exclude leak-injected synthetics (cleaner P, more logic to identify them). **Recommend faithful first**, validate, escalate only if needed.
- **Which users:** all 130 in the Jul 14 surge. Baseline is ~1/day, so at most 1–2 of the 130 might be genuine spammers; they would simply be re-blocked once the spammers cron is re-enabled with clean state — acceptable.

### 6.7 Rollback / safety
- Every step is append-only or reversible: the machine change is additive; the events are new synthetic messages; no existing rows deleted.
- If a restore misfires, re-emit a corrected `restore_state` (idempotent overwrite) for that user.
- Keep the spammers cron **suspended** throughout; re-enable only after states are clean (Part 8).

---

## Part 7 — Other categories (decide, likely minimal action)

- **13 ERROR (`getPageToken`):** leave — self-heal via dean on next backoff (Part 3c/3d). Re-check after ~Jul 15 (Appendix C).
- **193 BLOCKED (`fb_error_code=NULL`):** dean won't retry them, but they are observability-only and self-correct on the user's next activity. Options: (a) leave and let natural activity + a Redis flush clean them; (b) if they need active re-drive, apply the **same `restore_state` mechanism** from Part 6 (they are not terminal like USER_BLOCKED, so a simpler nudge — flush Redis so replybot recomputes from the log — may suffice). **Recommend:** confirm empirically that one such user self-corrects on activity before doing anything; otherwise reuse Part 6.
- **290 leaked ERROR/BLOCKED rows generally:** cosmetic/self-correcting per Part 2. No dedicated action; a Redis flush + natural activity cleans them over time.
- **Prod `messages` pollution (~10,915):** leave (user decision).

---

## Part 8 — Follow-ups / prevention
1. **Re-enable spammers cron** only after states are cleaned and verified (un-suspend command in Part 5). Consider first re-running spammers in a dry-run/observe mode if available.
2. **Different consumer-group names** per env (e.g. `replybot-prod` vs `replybot-staging`) so a future topic cross doesn't cause partition competition.
3. **Namespace/values guard** in the deploy path (CI check that the values file matches the target namespace) to prevent staging values → prod namespace.
4. **Botserver hardening:** validate `X-Hub-Signature-256`; page-ID allowlist per env (`botserver/server/handlers.js`).
5. Consider making `restore_state` a permanent, documented recovery tool (it's generally useful for un-blocking or repairing any user's state).
6. **Document** the `restore_state` event + recovery procedure in `documentation/states-debugging.md` after it works.

---

## Appendix A — Code reference map

| What | Location |
|---|---|
| State fold (`getState`) | `replybot/lib/typewheels/machine.js:870` |
| `categorizeEvent` (event types) | `replybot/lib/typewheels/machine.js:163` (UNBLOCK 173, REDO 176, MACHINE_REPORT 178, BLOCK_USER 180) |
| REFERRAL + reset shortcode | `replybot/lib/typewheels/machine.js:258` (reset at 262, `REPLYBOT_RESET_SHORTCODE`) |
| MACHINE_REPORT (carries `newState`) | `replybot/lib/typewheels/machine.js:297` |
| REDO (uses `previousOutput`) | `replybot/lib/typewheels/machine.js:324` |
| UNBLOCK (only from BLOCKED) | `replybot/lib/typewheels/machine.js:390` |
| BLOCK_USER → USER_BLOCKED, wipes qa | `replybot/lib/typewheels/machine.js:401` |
| apply RESET / UNBLOCK | `replybot/lib/typewheels/machine.js:607` / `:667` |
| StateStore (Redis-first, 24h TTL) | `replybot/lib/typewheels/statestore.js:80` (get), `:90` (updateState), TTL default `:17` |
| Pointer-based event load | `@vlab-research/chatbase-postgres/lib/index.js:21-28` (in `replybot/node_modules/…`) |
| Per-user fold tool (basis for recovery script) | `replybot/lib/responses/debugger.js` |
| Stateman / responser (write path) | `replybot/lib/responses/stateman.js`, `responser.js`, `pgstream.js` |
| Token lookup (`credentials`) | `replybot/lib/typewheels/tokenstore.js:8` |
| Dean retry queries | `dean/queries.go` — Respondings 102, Errored 115, Blocked 130, Spammers 246 |
| `states.message_pointer` computed col | `floor((state_json->>'pointer')::INT8 / 1000)::TIMESTAMPTZ` |

---

## Appendix B — Infrastructure & connection workarounds

- **kubectl exec websocket is UNSTABLE** (frequent `read: connection reset by peer` / kubelet `dial timeout` on `:10250`). `kubectl get/logs-via-apiserver` mostly work; `kubectl logs job/…` (kubelet path) often fails. **Always wrap exec DB queries in a retry loop** (5–12 attempts). `kubectl logs` for the recovery job was never retrievable — verify via DB counts instead.
- **zsh gotcha:** `noclobber` blocks `>` overwrite; use `unsetopt noclobber` or `>|` in scripts.
- **Query the DB via:** `kubectl --context gke_toixotoixo_europe-west1-b_toixo exec -i -n <ns> gbv-cockroachdb-0 -- cockroach sql --insecure --database=chatroach --format=records < file.sql`. Staging pod (`vstag/gbv-cockroachdb-0`) is memory-limited (250MiB SQL mem) — keep queries small / one user at a time. Prod (`vprod/gbv-cockroachdb-0..3`) is robust.
- **GC TTL** on `states` = `90000s` (25h) → `AS OF SYSTEM TIME` on the live table works back ~25h only. Pre-leak (before Jul 10 19:54) history needs the **backup** (daily full + `revision_history` PITR, bucket `gs://vlab-research-crdb-backups`; see `documentation/backups.md`). The Part 6 approach does **not** need backups.
- Kafka: 3 brokers in `default` ns (`kafka-0-b4ptl`, `kafka-1-qhbzq`, `kafka-2-522mt`), bootstrap `kafka-headless.default.svc.cluster.local:29092`.
- `BOTSERVER_URL` (synthetic endpoint, in-cluster): `http://gbv-botserver/synthetic`.

---

## Appendix C — Key queries (run inside `gbv-cockroachdb-0`, `--database=chatroach`)

THE 6 PAGES literal: `('101435865704727','758018254333043','1855355231229529','111108121363615','110749071412124','107718334922830')`

```sql
-- Current corrupted-state breakdown (6 pages, since Jul 10)
SELECT current_state, count(*) FROM states
WHERE pageid IN (<6 pages>) AND current_state IN ('ERROR','BLOCKED','USER_BLOCKED')
AND updated > '2026-07-10' GROUP BY current_state;

-- The ~130 false-blocked userids (target set for Part 6)
SELECT userid, pageid FROM states
WHERE pageid IN (<6 pages>) AND current_state='USER_BLOCKED' AND updated >= '2026-07-13 21:10';

-- USER_BLOCKED daily baseline (proves the surge)
SELECT date_trunc('day', updated) AS day, count(*) FROM states
WHERE pageid IN (<6 pages>) AND current_state='USER_BLOCKED'
AND updated > now() - INTERVAL '21 days' GROUP BY 1 ORDER BY 1;

-- Confirm the 13 ERROR getPageToken self-healed (re-check ~Jul 15+)
SELECT count(*) FROM states WHERE pageid IN (<6 pages>) AND current_state='ERROR'
AND state_json->'error'->>'message'='getPageToken';

-- fb_error_code of the stuck BLOCKED (all NULL → dean never retries)
SELECT coalesce(fb_error_code,'<null>'), count(*) FROM states
WHERE pageid IN (<6 pages>) AND current_state='BLOCKED' AND updated>'2026-07-10'
AND state_json->'error'->>'message' LIKE '%token not found%' GROUP BY 1;

-- Validation input: a target user's answers (cross-check reconstructed P.qa)
SELECT question_ref, question_text, response, timestamp FROM responses
WHERE userid = '<target userid>' ORDER BY timestamp ASC;

-- A target user's full event log (for offline fold; exclude block_user)
SELECT timestamp, hsh, content FROM messages WHERE userid = '<target>' ORDER BY timestamp ASC, hsh ASC;
```

---

## Appendix D — Config values (production, deployed)

**Dean (`gbv-dean-respondings` cronjob env, vprod):**
- `DEAN_ERROR_TAGS=NETWORK,INTERNAL,STATE_ACTIONS`
- `DEAN_FB_CODES=2022,613,-1,190,80006,551`
- `DEAN_RETRY_MAX_ATTEMPTS=60`
- `DEAN_ERROR_INTERVAL=48 hours`, `DEAN_BLOCKED_INTERVAL=120 hours`, `DEAN_RESPONDING_INTERVAL=48 hours`
- `DEAN_QUERIES=respondings,blocked,errored`
- `DEAN_SPAMMER_EXTERNAL_EVENTS_MAX=100`
- Spammer criteria: last-25-answers-identical OR `externalEvents` length > 100.
- Cronjobs: `gbv-dean-respondings */30 * * * *`, `gbv-dean-spammers 30 3 * * *` (**currently SUSPENDED**), `gbv-dean-timeouts */10`, `gbv-dean-followups`, `gbv-dean-payments`.

**Kafka topic layout (correct, post-fix):** prod on `vlab-prod-*` (chat-events 48p, state 12p, response 12p, payment 2p, commands 6p, chat-log 12p); staging on `vlab-staging-*`.

**Facebook apps:** prod `699455733740842` (webhook `https://fly-botserver.vlab.digital/webhooks`); staging `790352681363186` (webhook `https://staging.fly-botserver.vlab.digital/webhooks`). Graph API confirmed: all prod pages subscribed only to the prod app — the leak was purely the Kafka topic misconfiguration.

**Helm values:** prod `devops/values/production.yaml`, staging `devops/values/staging.yaml`, chart `devops/vlab/`.

**`states` table schema (key cols):** `userid, pageid, updated, current_state, state_json (JSONB)` + computed `fb_error_code`, `error_tag`, `current_form`, `message_pointer`, `next_retry`, `stuck_on_question`, etc.

**`messages` table:** `content (raw JSON event), userid, timestamp, hsh (INT8 AS fnv64a(content) STORED)`, PK `(hsh, userid)`. Insert path: `INSERT ... ON CONFLICT(hsh,userid) DO NOTHING` (idempotent, append-only).
