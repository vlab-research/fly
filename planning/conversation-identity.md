# Conversation identity: a conversation is (platform, account_id, user_id)

**Status, 2026-08-22: FULLY ROLLED OUT ON STAGING. Nothing is deployed to production and no
migration is applied to a production database.** Branch `feature/conversation-identity`
(PR #149), merged into `staging`.

**If you are picking this up: read `planning/multi-platform-plan.md` — it is the runbook and is authoritative for ordering.** Then §5.1 here for the one hazard most likely to bite you. §5.1b–d are the
diagnostic record of what went wrong getting to staging; read them when something breaks, not
before. §5.1 is still the highest-value five minutes in this document.

**Last full pass: 2026-08-20**, rewritten then to remove superseded designs, reverted work and
correction archaeology; §5 was substantially extended 2026-08-22 with the staging rollout and
production measurements. For the history — the messaging-account registry, the `DEFER` action,
the §0.9 corrections chain — read this file's git history; it is not coming back into the text.

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
| `28a-responses-account-scoped-key.sql` | `responses` PK gains `pageid` (old PK survives as a unique index) | **No** |
| `28b-responses-drop-old-unique-index.sql` | drops that retained index; run only after scribble is deployed and verified | **No** |

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
| **Run the backfill** | Written and tested, never executed anywhere. §5.2 steps S2 / P6. |
| **`messages.account_id` → NOT NULL** | Needs a sentinel pass first. Full plan: **`planning/messages-account-not-null-todo.md`**. Do not start without reading it. |
| **Migration 29** — drop the superseded `messages_userid_timestamp_idx` | Still unwritten; now wanted on staging for disk (§5.2 S3). Migration 26 makes it NOT VISIBLE; 29 comes after a clean soak, following migration 18's pattern on this table. |
| **`platform` on `chat_log`** | Column lands in migration 26; **nothing writes it** — the chat_log producer is gone (§6). `responses.platform` IS populated, by `scribble/response.go` (commit `29403222`); verified live on staging 2026-08-22, 13 of 13 recent rows. |
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

### 5.1b Why migration 26 stalled on 2026-08-22, and the plan

**CORRECTION to an earlier version of this section.** It claimed §5.2's "migration 19 first
makes this net disk-negative" arithmetic "does not work". That was wrong, and it was wrong
because it assumed the new index is a net addition without checking what the existing indexes
already store. They already store `content` — three of them do. §5.2 was right.

#### What is actually on disk

Measured in `vstag`, 2026-08-22, via `SHOW RANGES ... WITH DETAILS, INDEXES`:

| index | logical | **disk** | reads in 6d | stores `content`? |
|---|---|---|---|---|
| `primary` | 5,630 MB | **606 MB** | 1 | yes |
| `messages_userid_idx` | 5,766 MB | **576 MB** | **66** | yes |
| `messages_timestamp_idx` | 5,703 MB | **576 MB** | **0** | yes |
| `messages_userid_timestamp_idx` | 5,980 MB | **564 MB** | **0** | yes |

`content` is stored **four times over**. Compression is ~9.5x, so each copy is ~580 MB on disk
against ~5.7 GB logical. Migration 26's index is a *fifth* copy — the same size as its siblings,
not an outlier.

#### The actual failure

Migration 26 **adds before it retires**. It creates the new index, and only marks
`messages_userid_timestamp_idx` NOT VISIBLE (migration 29 does the DROP, later, after a soak).
So at peak it needs one full index of headroom:

    needed ~580 MB   ·   available 532 MB

It missed by about 50 MB. The backfill then retried 11 times over 19 hours at
`fraction_completed = 0`, silently, while a zombie SQL session from the killed migration client
held a descriptor lease and a second schema change queued behind it for 18h23m.

#### The compounding cause: migrations 18 and 19 were never committed

`git log --all --diff-filter=A -- devops/migrations/1[89]-*` returns nothing. The migration
sequence jumps 17 → 20. Both files exist only as **untracked working-tree files in the primary
worktree**, so they were never deployable and `vstag` never received them. That is why staging
still carries two indexes those migrations were written to remove — ~1.15 GB of the 3.41 GB
store, and far more than the headroom migration 26 needed.

#### The plan: free a copy before adding one

1. **Commit the 18/19 work.** Whatever is in those untracked files needs to become real tracked
   migrations, or be rewritten. Until then the cleanup they describe cannot be applied anywhere.
2. **Drop `messages_timestamp_idx` first.** Zero reads in six days of staging traffic, 576 MB,
   and it is not part of the 26/29 sequence, so dropping it costs nothing that migration 26 was
   relying on. Frees more than the new index needs.
   *Verify read counts in production before dropping there* — staging carries little exporter
   traffic, and a timestamp-ordered scan across all users is exactly the shape an export would
   use.
3. **Then apply 26.** Peak is now comfortable; end state is unchanged.
4. **Soak, then drop the retired copies**: migration 29 drops `messages_userid_timestamp_idx`,
   and 19 drops `messages_userid_idx` once the new index is proven to serve replay.

End state is `primary` + the new index: `content` stored twice instead of four times, and the
staging store roughly halves. **Net strongly disk-negative**, which is what §5.2 said.

**Do not drop `messages_userid_idx` before 26 lands in staging.** It is the only index currently
serving replay there (66 reads). Production differs — there it is already NOT VISIBLE (armed
2026-07-22), so production's reads come from `messages_userid_timestamp_idx` instead, and
phase-2'ing 19 there is the free headroom §5.2 was pointing at.

#### Independently: grow the staging volume

`vstag`'s PVC is **5 Gi at 90% full**. Even with the plan above it will sit near the line, and
the next schema change will wedge the same way — silently, for 19 hours. 16 Gi of pd-ssd is a
rounding error against the cost of that. This is not a substitute for the index cleanup; it is
the headroom that makes the cleanup safe to attempt.

### 5.1c Staging is DONE (2026-08-22)

Superseded the "half-applied" note that was here. `vstag` is fully rolled out.

| | |
|---|---|
| services | 9 on new images, all `Running 1/1` |
| migrations applied | **18, 26, 27, 28, 30** |
| `messages` indexes | `primary` + `messages_userid_account_timestamp_idx` visible; `messages_userid_idx` and `messages_userid_timestamp_idx` NOT VISIBLE |
| account-scoped replay | plans onto the new index (EXPLAIN verified) |
| `responses` / `chat_log` PK | 4-column, account-scoped |
| `CONVERSATION_TUPLE_MISSING`, `EVENT_ACCOUNT_MISSING`, `EVENT_PLATFORM_GUESSED` | 0 |
| `CHAT_EVENTS_ENVELOPE_MISSING` | 0 |
| scribble restarts | 0 across all four sinks |
| `STRICT_EVENT_ENVELOPE` | `"true"`, live, reading zero |

Versions on staging: replybot v0.0.221, hermes v0.0.5, message-worker v0.1.21,
scribble v0.0.34, dean v0.0.47, dinersclub v0.0.48, linksniffer v0.0.8, exodus
v0.2.5, exporter v0.6.12. Production remains on the previous tags throughout.

**Not yet run on staging:** migration 19 (see §5.1d), migration 29, and the
`devops/backfill` account_id backfill.

**Staging disk is tight**: 87% used. The two NOT VISIBLE canaries hold ~1.14 GB
and are reclaimed by 19 and 29. 5 Gi is small for this data; consider growing it.

### 5.1d Production, measured 2026-08-22 (read-only)

Everything below came from range metadata, stored statistics and bounded samples.
No full scan of `messages` was run.

| | staging | **production** |
|---|---|---|
| `messages` rows | 162,567 | **101,118,611+** (stats 2026-02-14, so a floor) |
| avg `content` | 34.8 KB | **1,067 B** older / **1,492 B** last 3 days |
| max `content` | 351 KB | **8.9 KB** older / **35.8 KB** recent |
| `max-sql-memory` | 1GiB | **3000Mi** |
| nodes | 1 | **4**, 234 GB each, 127-133 GB free |
| `range_max_bytes` | 64 MiB (migration 30) | **already 64 MiB** |

**PRODUCTION ROWS ARE ~25x SMALLER THAN STAGING'S. Staging is the outlier, not a
preview.** The default backfill batch there is `50000 x ~1.5 KB` = ~75 MB against
a 3000Mi pool -- a ~40x margin. So the two settings migration 26 needs in staging
are very likely UNNECESSARY in production, including
`use_declarative_schema_changer = 'off'`: the declarative changer only failed in
staging because the batch did not fit.

Recommended anyway as cheap insurance: `bulkio.index_backfill.batch_size = 10000`
(worst case `10000 x 35.8 KB` = ~358 MB, safe under concurrent load). NOT
staging's 200, which would make a 129 GB build needlessly slow.

**Migration 30 is a near no-op in production** -- its range settings are already
the live values. Its `gc.ttlseconds` line was REMOVED because production runs
90000 (25h) and the file would have cut it to 4h as a side effect.

#### Migration 28 will ABORT in production

`responses` has **1,818,162 rows with NULL `pageid`**, and 28 force-errors on any.
Staging had zero, so it passed trivially and proved nothing.

Every one of those rows is from **2020** -- they predate `pageid` being recorded --
so `devops/backfill-responses-pageid.sh`'s `''` sentinel is the right answer and
no recent attribution is lost. ~91 batches at the default 20,000, inside the 200
cap. `chat_log` has 14,834 NULLs, which migration 27 fixes itself.

#### Migration 19: the canary never went dark

`messages_userid_idx` has been NOT VISIBLE since 2026-07-22, yet it is STILL BEING
READ: 45,478 -> 45,483 reads over 75 seconds, about 4/min or ~5,700/day. NOT
VISIBLE stops the optimizer *choosing* an index; explicit hints,
`optimizer_use_not_visible_indexes`, and constraint checks can still reach it.

**This does not mean dropping it is dangerous.** The two indexes are near
substitutes:

| index | keyed on | stores |
|---|---|---|
| `messages_userid_idx` (19 drops this) | `(userid, hsh)` | content, timestamp |
| `messages_userid_timestamp_idx` | `(userid, timestamp, hsh)` | content |

Both are prefixed on `userid`; both cover `content`. The survivor is keyed on
`(userid, timestamp)`, which is **strictly better** for the dominant
`WHERE userid=$1 ORDER BY timestamp` pattern -- 19's own header makes this
argument. Expected impact of the drop is therefore low.

What the reading DOES invalidate is the *soak*: it was supposed to prove life
without this index, and the index never actually left the serving path, so it
proved nothing. Before running 19, identify the ~5,700/day reader and confirm it
tolerates the substitute. (Querying `crdb_internal.statement_statistics` for it
was getting expensive on the live cluster and was abandoned; try it in a quiet
window, filtered to a short time range.)

**RESOLVED 2026-08-24. The reader is scribble's own INSERT, and it is not a read.**
The abandoned `statement_statistics` query does work if you filter it — over 12h,
exactly two fingerprints touch `71@4`, both of them:

    INSERT INTO messages(userid, "timestamp", content)
      VALUES (...) ON CONFLICT (hsh, userid) DO NOTHING     -- 1,954 + 142 execs

`EXPLAIN` on prod shows why. The `DO NOTHING` existence check is an anti-join, and
the optimizer serves it from this index:

    arbiter indexes: primary
    └── cross join (anti)
        └── scan
              table: messages@messages_userid_idx
              spans: [/'<userid>'/<hsh> - /'<userid>'/<hsh>]

`messages_userid_idx` is keyed `(userid)` + PK suffix `(hsh)`, so `(userid, hsh)` is
exactly the point lookup the conflict check wants. **Conflict/uniqueness checks
bypass `NOT VISIBLE`** — that is the "constraint checks can still reach it" clause,
now pinned to a specific statement.

Three consequences:

1. **The soak was structurally incapable of going dark.** Migration 18 hid the index
   from the optimizer, but the counter it was being judged by is driven by the write
   path. Waiting longer would never have changed the reading. It measured nothing.
2. **The fallback is proven, not assumed.** On vstag, where the index is already
   dropped, the identical INSERT plans onto `messages@primary` with an equivalent
   single-key point lookup. Same shape, same cost class.
3. **The rate corroborates it.** ~2.4 index reads/min against ~162 inserts/hr is
   near 1:1, and in the same 75 s window BOTH VISIBLE indexes took **zero** reads.

**Precondition 1 (`SELECT *` -> `SELECT content`) is not a safety gate either.**
Migration 19's own header says the problem is that EXPLAIN emits an index
*recommendation* to recreate the dropped index — churn, not breakage. And replybot's
live plan never touches `71@4`: `SELECT * FROM messages LEFT JOIN ... states`
(1,500 execs/12h) uses `71@3` (primary) + `71@5` (`messages_userid_timestamp_idx`).

Note `chatbase-postgres` is the npm driver package `@vlab-research/chatbase-postgres`,
**not** an external database — prod replybot's `CHATBASE_HOST` is
`gbv-cockroachdb-public`, this same cluster. Earlier wording here implying otherwise
misleads.

**Still true, and worth respecting:** disk does not come back for `gc.ttlseconds`
(25 h on prod), so 19 cannot immediately precede a step that needs the space; and
recreating a ~129 GiB index on prod is a multi-hour backfill, so treat the drop as
one-way.

#### Disk

The new index costs about what `messages_userid_timestamp_idx` costs. Afterwards 19
and 29 reclaim their own indexes. Net strongly negative, as §5.2 always said.

**The GB figures previously here (75.7 / 93.5 GB cluster-wide, ~19 GB/node) look
wrong and were removed.** Measured 2026-08-24: each of the three indexes on `messages`
is ~129 GiB logical (primary 129.19, `messages_userid_idx` 129.14,
`messages_userid_timestamp_idx` 129.15), which migration 19's own header corroborates
at "~131.6 GiB logical". At the measured 3.47x cluster compression that is ~112 GiB
physical per index, not ~76 GB. See the measured table in
`planning/multi-platform-plan.md` and re-derive rather than reusing either set.

### 5.2 Order — see `planning/multi-platform-plan.md`

**The phase order now lives in `planning/multi-platform-plan.md` and that file is
authoritative.** It covers the same rollout plus what comes after it — gate
tightening, scaffolding removal, and the WhatsApp launch checklist — and keeping a
second step list here would only drift out of date, which is exactly what happened
to §4 and the old §5.1c.

Read that file for WHAT to do in WHICH ORDER. Read the rest of §5 for WHY, and for
the hazards: §5.1 (the scribble/`responses` key mismatch, still the most likely
thing to bite), §5.1b-d (what went wrong reaching staging, and the production
measurements), §5.3 (gates), §5.4 (feature gates), §5.5 (rollback).

The traps below are not repeated in the plan file and are the other half of §5.1 —
every one was hit for real during the staging rollout.

#### Known traps, all hit for real

- `devops/run-migration.sh` prints `ERROR: Migration failed` over SQL that
  COMMITTED — its `kubectl run -i --rm` client loses its websocket. **Use
  `kubectl exec -i -n <ns> gbv-cockroachdb-0 -- ./cockroach sql --insecure
  --database=chatroach < <file>` instead**, and always verify against the schema
  rather than trusting the exit code.
- A `CREATE INDEX` client timeout says NOTHING about the server. Check
  `SHOW JOBS`; never re-run on a timeout.
- `CREATE INDEX IF NOT EXISTS` silently no-ops against a cancelled build's
  lingering descriptor and prints success. Drop `IF NOT EXISTS` when retrying.
- A wedged index backfill looks identical to a slow one in SQL: `status=running`,
  `fraction_completed=0`, empty `error`. The real cause is only in the cockroach
  pod log.
- **Scribble restarts are the §5.1 alarm, and they have a common false positive.**
  Before concluding the key mismatch, check whether ALL FOUR sinks terminated at
  about the same moment and then stayed up — that is a shared-dependency blip, not
  §5.1. On vstag 2026-08-23 all four exited 1 between 12:43 and 12:46 because the
  CockroachDB pod had been recreated at 12:34:03 (node event); they restarted once
  and recovered. Real §5.1 looks different: `scribble-responses` **alone**, and
  **crash-looping** rather than restarting once, because `scribble.go` treats any
  write error as `log.Fatalf`. Discriminate with:
      kubectl get pod <crdb-pod> -n <ns> -o jsonpath='{.metadata.creationTimestamp}'
      kubectl logs -n <ns> deployment/gbv-scribble-responses | grep -i 42P10
- Production values still point **scribble and linksniffer at docker.io**, where
  CI does not publish. Not broken today (pinned to tags that exist) but it breaks
  on their next release. Staging is already fixed; production is a separate diff.

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
| `STRICT_EVENT_ENVELOPE` | **`true`, APPLIED and live on vstag since 2026-08-22 18:36 UTC** | `false` | Refuses to publish an unstamped event. Staging first: refusing drops the WhatsApp echo, which is the only thing advancing those conversations, so a stall is a test failure there and a hanging participant in production. Flip production only after the tag reads zero in staging for 24h. |
| `SYNTHETIC_REQUIRE_CONVERSATION` | `false` | `false` | hermes-side gate on incoming `/synthetic`. **Do not turn on until moviehouse sends `account_id` and `platform`** — it is served from Netlify, not the cluster, so it cannot roll out in the same apply. Turning it on early 400s every moviehouse event and kills video tracking. |

**CORRECTED 2026-08-23 — this said "committed but not yet applied", and that was
stale.** The gate is live on vstag: the running `gbv-message-worker` pod was created
2026-08-22T18:36:50Z already carrying `STRICT_EVENT_ENVELOPE=true`. No apply step is
outstanding. `CHAT_EVENTS_ENVELOPE_MISSING` has read **zero** on message-worker since,
so the 24h staging soak this gate owes production is already running — date it from
2026-08-22 18:36, not from whenever it is next looked at.

Verify rather than re-deriving from the values file, which says nothing about what is
running:

```bash
kubectl get pod -n vstag -l app=message-worker \
  -o jsonpath='{.items[0].spec.containers[0].env}' | tr ',' '\n' | grep STRICT
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
