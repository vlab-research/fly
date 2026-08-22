# Conversation identity: a conversation is (platform, account_id, user_id)

**Status: built on `feature/conversation-identity` (PR #149). Nothing is deployed. No
migration is applied to any production database.**

**Last full pass: 2026-08-20.** This document was rewritten on that date to remove superseded
designs, reverted work and correction archaeology. It describes only what is true and what is
next. For the history — the messaging-account registry, the `DEFER` action, the §0.9
corrections chain — read this file's git history; it is not coming back into the text.

**Who this is for:** whoever picks the work up, and whoever rolls it out. Read §5 before
touching a cluster.

---

## 1. The bug

The Redis state cache, the archived event log and three log tables were all keyed by
**participant** when the thing they describe is a **conversation**. One participant talking to
two of a researcher's accounts shared one state blob, one interleaved replay, and colliding rows.

**Reproduced live, 2026-08-16, deterministic.** An entry on one WhatsApp number wrote
`state:15419799714`. Thirteen minutes later a button press on a *different* number read that
state back, recorded the press as an answer to the other survey's field, and raised:

```
FIELD_NOT_FOUND: Could not find the requested field, b485a02d-…, in our form: xleHnFWa
```

The conversation went to `ERROR` and stayed there — `FIELD_NOT_FOUND` is not in
`DEAN_ERROR_TAGS`, so nothing sweeps it.

**Exposure (production, re-measured 2026-08-20).**

| | |
|---|---|
| participants with 1 account | 1,095,252 |
| participants with 2 accounts | 1,910 |
| with 3 | 1 |
| with 10 | 1 |
| **multi-account participants** | **1,912 (0.174%)** |
| `messages` rows belonging to them | **343,558 of 106,275,818 (0.32%)** |

Small, and the severity is the point rather than the count: for those participants the failure
is a permanently dead conversation, and on Messenger the same key shape has been colliding
since 2020.

---

## 2. The identity model

A conversation is **`(platform, account_id, user_id)`**. All three come **from the event**,
never from the state being loaded — recovering identity from `state.md` is the same defect one
layer down, and it is what routed outbound messages to the wrong account.

Account identity itself is **`(allocator, id)` serialized to one opaque string** — the ratified
2026-07-22 decision in `documentation/platform-abstraction.md`. Platform is an *attribute* of an
account, never part of its identity. Bare-numeric ids are the Meta namespace (page ids and
`phone_number_id`s come from one graph-id space); any future platform whose ids are not Meta
graph ids must be prefixed at hermes ingestion (`sms:`, `tg:`).

**Naming:** `account_id` and `platform`. `pageid` is the legacy column name surviving in
`states`, `responses` and `chat_log`; renaming it is deliberately last and cosmetic (§4).

---

## 3. What is built

All of it is on `feature/conversation-identity` (PR #149). All suites green: **replybot 636 ·
hermes 39 · backfill 24 · scribble · dean · message-worker · facebot/testrunner tsc**.

### 3.1 The event envelope

Every event body on `chat-events` carries top-level `account_id` and `platform`.

- `hermes/src/event.rs` — derives and stamps them for Messenger, WhatsApp and synthetic posts.
  The Messenger rule is the **echo inversion**: the account is `sender.id` when
  `message.is_echo` is boolean `true`, else `recipient.id`.
- `message-worker/envelope.go` — message-worker is a **second direct producer** to
  `chat-events` (`emitWhatsAppEcho` bypasses hermes), so it stamps the envelope itself and
  `MissingEnvelopeFields` guards every publish.
- One shared fixture pins the rule across three languages:
  `testdata/event-envelope/messenger-account-derivation.json` → hermes (Rust),
  `scribble.TestBackfillSQLMatchesGo` (Go), `replybot/lib/event-normalizer.test.js` (JS).

**Backtested on production 2026-08-20, read-only.** Oracle: participants with exactly one
account, where `states.pageid` gives the answer independently of `content`.

```
echo_flag           rows_checked  not_derivable  agrees  DISAGREES
true                     103,854              0  103,854         0
(no is_echo flag)         78,203              0   78,203         0
```

182,057 real rows, zero disagreements. Inverting the echo rule and re-running gives **100%
disagreement**, so the check has power. The sample is effectively uniform: the primary key is
`(hsh, userid)` with `hsh = fnv64a(content)`, so scan order is hash order.

### 3.2 The state cache

`replybot/lib/typewheels/statestore.js` keys Redis as `state:{platform}:{account_id}:{user}`.
`makeKey` is the only place the shape is written; `devops/clear-state-cache.sh` matches it with
`SCAN MATCH state:*:*:<userid>` and the two must agree.

When the triple cannot be named the cache is **bypassed** rather than keyed under a guess, and
one `CONVERSATION_TUPLE_MISSING` line is logged. That log is the rollout canary (§5.3).

### 3.3 The replay path

`replybot/lib/chatbase/chatbase.js` reads the archived log scoped by account:

```sql
WHERE m.userid = $1 AND (m.account_id = $2 OR m.account_id IS NULL)
```

`get()` takes `({ userid, account }, limit)` — a bare string **throws** by design, so an
un-updated caller breaks loudly instead of quietly interleaving two conversations.

`OR account_id IS NULL` is **temporary migration scaffolding**; its removal gate is in
`devops/migrations/26-messages-account.sql` §4.

### 3.4 Refusals

Two events that used to enter `FALLBACK_FORM` wrongly now return `_noop()`:

- **A synthetic event on a conversation that replays as `START`** (`machine.js`
  `_handleExternalEvent`). Every synthetic producer — dean timeout, dinersclub payment,
  linksniffer click, moviehouse heartbeat — requires the conversation to already exist, so none
  can be a first contact. A Messenger **handover** still blank-starts; it genuinely is one.
- **A form-less entry event on a conversation that already has a form** (`machine.js`
  `REFERRAL`). 3,732 historical `states` rows were appended this way, 96% by a bare
  `get_started`.

Neither is logged — a deliberate simplification on 2026-08-20. The rate is not measurable from
pod logs; the `states` detector queries in `documentation/referral-form-resolution.md` are the
substitute.

**`START` is a reachable state of a live conversation, not a contradiction.** `apply`'s `RESET`
returns `{ ..._initialState(), pointer }`, so `?ref=form.reset` leaves a conversation in `START`
with a pointer that truncates the replay. 1,623 production rows are in `START`, 461 with a
pointer. `USER_BLOCKED` and `RESTORE_STATE` set it too.

### 3.5 Schema

| Migration | What | Applied in prod? |
|---|---|---|
| `26-messages-account.sql` | `messages.account_id` + `.platform`, new covering index, old index NOT VISIBLE | **No** |
| `27-chat-log-account-scoped-key.sql` | `chat_log` PK gains `pageid` | **No** |
| `28-responses-account-scoped-key.sql` | `responses` PK gains `pageid` | **No** |

Verified against `vprod` 2026-08-20: none of the columns exist, both PKs are still their
original three columns.

**Migration 26 deliberately does not change the `messages` primary key.** `hsh` is
`fnv64a(content)` and the account is inside that blob in every shape, so `(hsh, userid)` is
already transitively account-scoped. The `ALTER PRIMARY KEY` originally called for would have
been a 384 GiB rewrite peaking at ~96 GiB/node against 127 GiB free on the tightest node.
Rejected with measurements, approved 2026-08-17.

### 3.6 The backfill

`devops/backfill` — a Go tool filling `messages.account_id` and `.platform` from each row's
archived `content`. Replaced a 417-line untested bash script on 2026-08-20.

Expressions run **server-side** (`content` is 384 GiB and never crosses the wire). Walks the
primary key with a cursor; `AND account_id IS NULL` is the guarantee and the cursor is only an
optimization, so restarting from scratch is always correct. `--dry-run` counts; `--rehearse`
runs the real `UPDATE` in a transaction and rolls it back.

24 tests, mutation-checked. See `devops/backfill/README.md`.

**Never run.** Not on staging, not on production.

---

## 4. What is not done

| Item | State |
|---|---|
| **Run the backfill** | Written and tested, never executed anywhere. §5.2 step 5. |
| **`messages.account_id` → NOT NULL** | Needs a sentinel pass first. Full plan: **`planning/messages-account-not-null-todo.md`**. Do not start without reading it. |
| **Migration 29** — drop the superseded `messages_userid_timestamp_idx` | Deliberately unwritten. Migration 26 makes it NOT VISIBLE; 29 comes after a clean soak, following migration 18's pattern on this table. |
| **`platform` on `responses` / `chat_log`** | Columns land in migration 26; **nothing writes them.** `scribble/response.go` and `chatlog.go` read no platform from their shapes. |
| **`pageid` → `account_id` rename** | Untouched, cosmetic, last. Two aliases would go: `chatbase.js`'s `states.pageid AS ...` and dean's join. |
| **hermes account→platform resolution** | Designed, not built, **no path forward.** It was to read an in-memory map from the messaging-account registry, and the registry was reverted (`5c4cab3e`). hermes has no database access, no background tasks and no metrics today. |
| **Restore the `chat_log` producer** | Blocked — see §6. |
| **CI for the Go suites** | **Nothing runs them.** This repo has no Go job at all — `scribble`, `dean`, `message-worker` and now `devops/backfill` have never run in CI, so this is not a regression, but "passes locally" was the whole argument for moving the backfill off bash. The pattern to copy is `.github/workflows/replybot-test.yml`, which already does `make -C ../devops test-db`; a Go job is roughly 15 lines. |

---

## 5. Rollout

Read this whole section before applying anything. The order is not arbitrary.

### 5.1 The one that will bite you

**`scribble` on this branch cannot run against production's schema.**

```go
scribble/response.go:98  ON CONFLICT(userid, pageid, timestamp, question_ref)   // 4 columns
scribble/chatlog.go:91   ON CONFLICT(userid, pageid, timestamp, direction)      // 4 columns
scribble/message.go:77   ON CONFLICT(hsh, userid)                               // unchanged
```

Production's `responses` PK is still `(userid, timestamp, question_ref)`. A 4-column
`ON CONFLICT` against it raises **42P10**, and `scribble.go` treats any write error as
`log.Fatalf` — so the sink **crash-loops** rather than degrading.

**It breaks in both directions.** Apply migration 28 first and the *old* build's 3-column target
is no longer unique — also 42P10. There is a window either way. It must be short and watched.

**What saves you:** offsets are not committed for a failed batch, so a crash-loop is a *stall*,
not data loss. Once schema and build agree the backlog drains. `responses` is live participant
answers, so the stall is still real — do it in a quiet window.

`chat_log` has the same mismatch but its topic is **dormant** (§6), which hides it until the
producer returns. That is why restoring the producer is what detonates it.

`messages` is safe in both directions — migration 26 deliberately left the key alone.

### 5.1b THE BLOCKER FOUND ON 2026-08-22: migration 26's index does not fit

**Migration 26 cannot complete in staging, and on these numbers it cannot complete in
production either.** This is not a code problem; it is a disk problem, and it was not known
when §5 was written.

The index migration 26 creates stores `content`:

```sql
CREATE INDEX messages_userid_account_timestamp_idx
  ON chatroach.messages (userid, account_id, timestamp ASC)
  STORING (content, platform);
```

`STORING (content)` **duplicates the largest column in the database.** Measured in `vstag` on
2026-08-22:

| | |
|---|---|
| `sum(length(content))` in `messages` | **5,517 MB** (162,567 rows) |
| store used / available | **3.40 GB / 0.52 GB** (PVC is 5 Gi, 90% full) |

The index needs roughly as much space as the entire store currently holds, and there is half a
gigabyte free. The backfill job has been retrying since 2026-08-21 21:29 UTC: `num_runs = 11`,
`fraction_completed = 0`, backed off to `next_run` 2026-08-23 07:33.

**Production is the same shape, worse.** `messages.content` there is ~384 GiB, so this index
adds ~384 GiB. §5.2 says applying migration 19 first (freeing ~128 GiB) makes the change "net
disk-negative" — **that arithmetic does not work**: 128 GiB freed against ~384 GiB added leaves
~256 GiB still needed, and §5.2's own note records the tightest node as having 127 GiB free.
Verify against `crdb_internal.kv_store_status` before believing either number, but do not apply
migration 26 to production on the assumption that migration 19 pays for it.

**Options, none of them free:**

1. **Grow the volumes.** `vstag` needs ≳16 Gi to hold the index with headroom; production needs
   a real capacity plan, not a bump.
2. **Drop `STORING (content)`.** The index becomes small, and the covering property is lost —
   `get()` selects `content`, so an account-scoped read costs an index join per row. That is a
   performance decision, and the migration's own comment argues for the covering form.
3. **Store only `platform`.** A middle option: keeps the index cheap, still avoids an index join
   for the platform column, but not for `content`.

Until one is chosen, the rollout stops here.

### 5.1c Current half-applied state of `vstag`

Migration 26 ran twice (the `kubectl run` client lost its attach both times; the SQL still
executed). What landed:

| Statement | State |
|---|---|
| `messages.account_id`, `messages.platform` | **applied** |
| `responses.platform`, `chat_log.platform` | **applied** |
| `CREATE INDEX messages_userid_account_timestamp_idx` | **stuck backfill**, index absent |
| `ALTER INDEX messages_userid_timestamp_idx NOT VISIBLE` | **not run** |
| the primary-key assertion at the foot of the file | **not run** |
| migrations 27 and 28 | **not run** |

The added columns are nullable and unread by the deployed build, so this half-state is inert —
staging behaves exactly as it did before. Nothing needs undoing.

Two things need clearing before a retry, and both are live-state mutations:

- an **idle zombie SQL session** (`10.24.4.150`, idle 18h+) left by the killed migration pod,
  which a second schema change has been blocked behind for 18h23m;
- the **stuck job** itself (`SHOW JOBS`, `NEW SCHEMA CHANGE`, `CREATE INDEX IF NOT EXISTS
  messages_userid_account_timestamp...`) — cancel it rather than waiting out the backoff.

**Use `kubectl exec` into `gbv-cockroachdb-0`, not `devops/run-migration.sh`, until the attach
flakiness is fixed.** The script's `kubectl run -i --rm` client lost its websocket both times and
reported `ERROR: Migration failed` while the SQL had in fact committed — the most dangerous
possible failure mode for a migration runner, because it invites a re-run that assumes nothing
happened.

### 5.2 Order

1. **Migrations 26, 27, 28 → staging.** `bash devops/run-migration.sh vstag migrations/NN-*.sql`
2. **Deploy the branch to staging** — hermes, message-worker, replybot, scribble, dean,
   dinersclub, exodus, linksniffer. Scribble and the migrations land close together (§5.1).
3. **Watch staging 24h.** Gates in §5.3.
4. **Production: migrations 26, 27, 28, then the same deploy**, in a quiet window.
5. **Backfill** — staging to completion first, then production. `--dry-run`, then
   `--rehearse --max-batches 3`, then for real. Procedure in `devops/backfill/README.md`.
6. **Then** the NOT NULL work, as its own effort.

**Apply migration 19 first if you can.** `messages_userid_idx` is still on disk in production at
`visible = f` — ~128 GiB replicated of dead index, armed as a canary 2026-07-22 and never
phase-2'd. Dropping it before migration 26 makes the whole change net disk-negative. The file is
**not on this branch**; it exists untracked in the primary worktree.

### 5.3 Gates

| Signal | Where | Expect |
|---|---|---|
| `CONVERSATION_TUPLE_MISSING` | replybot pod logs | trending to **zero**. Non-zero means an event reached replybot without a full triple. |
| `CHAT_EVENTS_ENVELOPE_MISSING` | message-worker pod logs | **zero**. Non-zero means a producer in that service is not stamping the envelope. |
| `EVENT_ACCOUNT_MISSING` / `EVENT_PLATFORM_GUESSED` | replybot / hermes | zero |
| scribble sink restarts | `kubectl get pods -n <ns>` | flat. A climbing count on `scribble-responses` is §5.1. |

### 5.4 Feature gates, current values

| Gate | staging | production | Notes |
|---|---|---|---|
| `STRICT_EVENT_ENVELOPE` | **`true`** (set 2026-08-20, **not yet applied**) | `false` | Refuses to publish an unstamped event. Staging first: refusing drops the WhatsApp echo, which is the only thing advancing those conversations, so a stall is a test failure there and a hanging participant in production. Flip production only after the tag reads zero in staging for 24h. |
| `SYNTHETIC_REQUIRE_CONVERSATION` | `false` | `false` | hermes-side gate on incoming `/synthetic`. **Do not turn on until moviehouse sends `account_id` and `platform`** — it is served from Netlify, not the cluster, so it cannot roll out in the same apply. Turning it on early 400s every moviehouse event and kills video tracking. |

Staging's `STRICT_EVENT_ENVELOPE` change is committed but needs:

```bash
helm upgrade gbv vlab -f devops/values/staging.yaml -n vstag
kubectl rollout restart deployment/gbv-message-worker -n vstag
```

### 5.5 Rollback

- **Code:** redeploy the previous image tags. The Redis keyspace changes shape, so old and new
  keys coexist harmlessly — a rollback re-reads `state:<userid>`, a roll-forward re-reads the
  triple keys. Neither loses state; each costs one replay per active conversation.
- **Migration 26:** the index is the only heavy part and it is a plain `CREATE INDEX` — drop it.
  `ALTER INDEX ... VISIBLE` instantly restores the superseded one.
- **Migrations 27/28:** `ALTER PRIMARY KEY`. Rolling back means another rewrite. Treat as
  one-way; rehearse on staging.
- **The backfill:** nothing to roll back. It only fills a NULL column.

---

## 6. Gotchas that will cost you a day

**The `chat_log` producer is gone and exports are silently truncated.**
`replybot/lib/chat-log/publisher.js` was deleted in `675c31bd` (2026-07-17) as collateral damage
in the UniversalEvent refactor — not a deprecation. Last row landed **2026-07-27**; production
runs `v0.0.218`, which still contains the deletion. The table was at its highest volume ever when
writes stopped (Jul 606,187 rows; Aug 0; 1,479,724 total). The dashboard still offers "Create
Chat Log Export", the exporter still serves it, and the sink still runs against an empty topic —
**so exports succeed and return data that stops on 2026-07-27, with no error shown.**

Restoring it is **blocked on migration 27 and the matching scribble build both being deployed**
(§5.1). The restored producer must also publish the account on every entry.

**`FALLBACK_FORM` is `305`, and 305 is a real survey — but never another account's.** Shortcodes
are **user-scoped**: `formcentral/db.go:82` resolves by the owner of the account the conversation
is on. Eleven accounts have a survey with shortcode 305, including `nandanmarkrao@gmail.com` and
`worldbank@vlab.digital`. Falling back to it misattributes a participant *inside their own
researcher's account*; it never crosses an account boundary. Do not write that it does.

**linksniffer and moviehouse read a researcher-authored account out of a webview URL.**
`linksniffer/server.go:105` takes it from `account`/`account_id`/`pageid` query params, so a
hand-authored legacy link can name an account the conversation does not live on. The
`link_tracking` and `moviehouse` field types now have replybot build those URLs, which removes it
going forward — legacy links in flight do not fix themselves.

**Replybot never reads the `states` table.** Redis is the runtime source of truth, with the
archived event log as the fallback. `states` is a denormalized dump for dean and the dashboard.
Scribble is its only writer.

**The test harness builds `messages` with indexes production no longer serves**, because
migrations 18 and 19 exist untracked in the primary worktree and are not on this branch. Index
counts will disagree; size against production, not the harness.

---

## 7. Shipped alongside, same branch

- **CTWA autofill refs must be order-independent.** A real ad's `autofill_message` reads
  `ctwaprobe.alpha.creative.Ad1H.form.probetest` — form-last. Anchoring on a leading `form.`
  rejected those and dropped the arrival to `FALLBACK_FORM`. The `form` pair may now sit anywhere
  in the dot-separated list, still on an even token boundary. Reproduced live 2026-08-16.
- **A CTWA referral is not guaranteed to carry `ref`.** Meta's documented fields are
  `source_url`/`source_id`/`ctwa_clid` — none of them ours. When the referral carries no usable
  `ref`, the shortcode is derived from the autofill text instead.
- **scribble and exodus stopped discarding a second account's rows.**
- **`responses.platform` is populated.**

Detail in `documentation/referral-form-resolution.md`.

---

## 8. Where things are

| | |
|---|---|
| Branch | `feature/conversation-identity`, PR #149 |
| Migrations | `devops/migrations/26,27,28` |
| Backfill | `devops/backfill/` (+ its README) |
| NOT NULL plan | `planning/messages-account-not-null-todo.md` |
| Test inventory | `planning/conversation-identity-test-plan.md` |
| Feature docs | `documentation/platform-abstraction.md`, `event-envelope.md`, `referral-form-resolution.md`, `states-debugging.md`, `chat-message-logging.md` |
| Reverted registry | `origin/archive/messaging-accounts-registry` |

---

## 9. Old section numbers

No code cites this document's numbering any more — `3ec2e27a` removed roughly forty such
references, and `grep -rn '§[0-9]'` over the source tree now returns nothing. The map below is
kept for reading the branch's own history and any external notes that still use the old numbers.
**Do not add new `§n.n` references from code** — cite a file and a line, or a heading.

| Old | Was | Now |
|---|---|---|
| §1.1 | the live reproduction | §1 |
| §2.1 / §2.2 | where identity is not carried; consequences | §1, §2 |
| §3.1 | the triple carried everywhere | §2 |
| §4.1 / §4.2 / §4.3 | the event envelope, target shape, consumers | §3.1 |
| §5.2 | the registry's `PRIMARY KEY (platform, account_id)` | **reverted** — `5c4cab3e`, archived on `origin/archive/messaging-accounts-registry` |
| §7.1 | key the state cache by the conversation | §3.2 |
| §7.2 | standalone correctness fixes | §7 |
| §7.3 / §7.3.1 | every event carries the triple; the `/synthetic` contract | §3.1 |
| §7.4 | give the log tables an account and a platform | §3.5, §3.6 |
| §7.5 | move the replay path onto the tuple | §3.3 |
| §7.6 | the messaging account registry | **reverted**, as §5.2 |
| §7.7 | rename `pageid` → `account_id` | §4 |
| §8.3 | deliberately unbuilt | §4 |
| §8.4 | the linksniffer platform assumption | §6 |
| §8.5 | housekeeping | §4, §6 |
| §0.9 (test plan) | corrections to this document | **deleted** — the corrections were applied |
| Appendix A | CTWA autofill ref order-independence | §7 |
| Appendix B | form-less entry may not re-enter | §3.4 |
