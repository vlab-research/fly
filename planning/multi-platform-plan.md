# Multi-platform plan: getting every conversation onto (platform, account_id, user_id)

**THIS FILE IS AUTHORITATIVE FOR ORDERING.** `planning/conversation-identity.md` §5
describes the conversation-identity rollout in depth — the hazards, the gates, the
traps — but the phase order lives here. If the two disagree, this file wins and the
other is stale.

**Status 2026-08-24:** staging fully rolled out; production untouched; Messenger is
the only live transport. Integration suite 61/61, in CI and locally.

**Phase 0: 0.1, 0.2, 0.4, 0.5 DONE. 0.3 is the only step left** — dry-run and
rehearsal both pass and agree exactly; only the real run remains, one command,
see 0.3. Nothing else blocks Phase 1.

---

## Start here if you are new to this

Read in this order, and do not skip the first one:

1. **This file** — authoritative for WHAT and in WHICH ORDER.
2. **`planning/conversation-identity.md` §5.1** — the scribble/`responses` key
   mismatch. Still the single most likely thing to break Phase 1, and it breaks in
   *both* directions (old build + new schema, or new build + old schema).
3. **`planning/conversation-identity.md` §5.2 "Known traps"** — every one was hit
   for real. `run-migration.sh` lying about success is the big one.
4. `§5.3` gates, `§5.4` feature gates, `§5.5` rollback.

`§5.1b–d` are diagnostic history. Do not read them unless something breaks.

**Working rule that this project keeps re-learning:** verify against the source or
the live cluster, cite `file:line`, and say UNVERIFIED rather than reasoning from
plausibility. Several confident numbers in these docs have been wrong — including
two of mine, corrected in place at 0.1/0.3. Staging validated less than it looks:
its rows are ~25x fatter than production's, its `responses` had zero NULL `pageid`
where production has 1,818,162, and its single CRDB node hides the multi-node case.
**Re-measure on production. Inherit nothing.**

### State of the world, 2026-08-24

| | staging (`vstag`) | production (`vprod`) |
|---|---|---|
| migrations 26/27/28/30 | applied | **none applied** |
| migration 29, 19 | applied — `messages` is `primary` + `messages_userid_account_timestamp_idx` only | not applied |
| `devops/backfill` | rehearsed, real run pending (0.3) | never run |
| linksniffer | **v0.0.9** | older; still pointed at docker.io in values |
| moviehouse | `staging` branch deploy, current | `main` deploy, **assume-messenger NOT shipped** |
| `STRICT_EVENT_ENVELOPE` | `true`, live since 2026-08-22 18:36 | `false` |
| `SYNTHETIC_REQUIRE_CONVERSATION` | `false` | `false` |
| smoke-test form-a | deployed to Typeform, 42 fields | same form (shared) |

Production is **completely untouched**. Messenger is the only live transport;
WhatsApp is a handful of test users.

---

## Phase 0 · Finish staging — ~1 day

- **0.1 Migration 29** (`DROP messages_userid_timestamp_idx`). **WRITTEN AND APPLIED
  TO vstag 2026-08-23**, verified against the schema. Cuts write amplification
  4 indexes → 3.
- **0.2 Migration 19, staging only. APPLIED TO vstag 2026-08-23.** Preconditions
  verified here rather than assumed: `visible=f`; both read paths EXPLAIN onto
  `messages_userid_account_timestamp_idx`; `SELECT content` shipped in the deployed
  replybot v0.0.221; single CRDB pod, so no replica co-location risk. Unlike
  production's canary it had genuinely gone dark — `total_reads` static at 48 over
  80 minutes while the replacement advanced.
  **`chatroach.messages` is now exactly `primary` + `messages_userid_account_timestamp_idx`,
  the end state migration 26 designed.**

  ⚠️ **The "keep one canary until 0.3" advice was overtaken.** 0.1 and 0.2 together
  drop both canaries, and the disk gate below required both. There is no instant
  rollback left: if the backfill regresses the read path, roll **forward**. Recreating
  either index on vstag needs migration 26's two settings TOGETHER or it wedges
  silently at `fraction_completed = 0`.
- **0.3 Run `devops/backfill`. UNBLOCKED, REHEARSED, NOT YET RUN FOR REAL.**

  The disk gate is CLEARED. Both GC jobs from 0.1/0.2 read `succeeded` and the
  space came back: **3.1G used / 1.8G free (64%)**, from 4.2G/688M. `messages` is
  **11,055 MB logical**, exactly half its former 22,110 MB — the two dropped
  indexes were a quarter each, as measured.

  ⚠️ **A physical-size correction worth keeping.** An earlier note here predicted
  the two drops would free ~2.1 GB. They freed **~1.1 GB**. The logical halving was
  right; the physical extrapolation was not, because the 5.3x compression ratio it
  used came from dividing total logical by *total volume used*, which includes
  every other table plus WAL. The marginal ratio for `messages` is nearer **10x**.
  Use the marginal ratio when sizing, and re-measure on production rather than
  reusing either number.

  **Verified 2026-08-24, in the plan's own order:**

  | step | result |
  |---|---|
  | `--dry-run` | **153,776 rows, 9 batches, reached END** |
  | `--rehearse --max-batches 3` | 56,701 rows, batch counts identical to the dry-run |
  | rollback check | `count(account_id)` still 124 — nothing persisted |

  **8,791 rows are permanently unattributable here** (162,567 needing a backfill
  minus 153,776 attributable): synthetic events carrying no account in `content`.
  That is far more than the ~3,000 this doc cites for production, because staging's
  data is synthetic-heavy. It does NOT transfer — re-derive it on production, and
  see `planning/messages-account-not-null-todo.md`.

  **The remaining command** (port-forward first; the tool is resumable and every
  batch carries `AND account_id IS NULL`, so re-running is a no-op):

  ```bash
  kubectl port-forward -n vstag pod/gbv-cockroachdb-0 5457:26257 &
  cd devops/backfill && go run . \
    --dsn "postgres://root@localhost:5457/chatroach?sslmode=disable" \
    --sql-dir "$PWD/../sql" --yes
  ```

  Expect ~9 batches. Counting runs ~100 s/batch; real `UPDATE`s are slower, so
  budget 20–40 min. Watch disk while it runs — the churn is ~1.1 GB against 1.8 GB
  free, which fits but is not roomy:
  `kubectl exec -n vstag gbv-cockroachdb-0 -- df -h /cockroach/cockroach-data`

  **Two traps, both hit for real on 2026-08-24:**
  - `--sql-dir` defaults to a path resolved against **cwd**, not the binary, so
    running from `devops/backfill` fails with
    `open devops/sql/messages-account-id-expr.sql: no such file`. Pass it explicitly.
  - The README's example DSN uses **port 5455, which is the LOCAL DEV CockroachDB**
    in Docker and is very likely already listening. Forward staging to a different
    port and *prove* which database you reached before pointing a write tool at it:
    `SELECT count(*), count(account_id) FROM chatroach.messages;` must match what
    `kubectl exec` reports in-cluster.

- **0.4 Extend `smoke-test/form-a.json` to all four paths. DONE 2026-08-23.**
  Added a `test_links` gate → `link_new` (`link_tracking`) → `link_legacy_prod` /
  `link_legacy_staging` (hand-authored `webview`) → `movie_new` (`moviehouse`) →
  `confirm_links`, inserted between `movie_timeout` and `stitch_statement`.
  Path 3 needed no new field — the existing `movie_webview_*` already hardcode
  `pageId` and send no platform, which is exactly the legacy shape.

  Only the legacy fields are environment-split. `link_tracking` and `moviehouse`
  are field *types* whose URL replybot owns, base from `LINKSNIFFER_URL` /
  `MOVIEHOUSE_URL`, so one field covers both environments.

  Verified by translating the real fields through
  `replybot/lib/generic-translator.js`, not by eyeballing the JSON:

      link_new    .../?url=example.com&p=https&vlab_user=U&vlab_account=A&vlab_platform=messenger
      movie_new   .../?vlab_video=164118668&vlab_user=U&vlab_account=A&vlab_platform=messenger
      link_legacy .../?id={{hidden:id}}&pageid={{hidden:pageid}}&url=example.com&p=https

  **Paths 1 and 2 are already proven end to end on vstag.** Probing the deployed
  linksniffer wrote real rows, and `chatroach.messages` stored `platform=messenger`
  for the legacy shape and `platform=whatsapp` for the stamped one, both with
  `account_id`. Paths 3 and 4 still need a human to run the survey and tap a video.

  The survey cannot assert the platform itself — nothing a participant sees reveals
  it — so `smoke-test/README.md` now carries the verification query and the
  `LINKSNIFFER_PLATFORM_*` log cross-check.

  **DEPLOYED TO TYPEFORM 2026-08-24** (`form_a: updated id=QJ6d4JHE`, live form now
  42 fields / 23 logic rules). Both documented pre-flight checks passed first: no
  `DELETED BY PUSH`, no `PROPERTY LOST`, and no title/description drift on any of
  the 36 pre-existing fields — so nobody had edited the live form outside the repo
  and the wholesale replace destroyed nothing. Every logic target resolves on the
  live form, and every choice the logic references has an explicit `ref`.

  Note `smoke-test/.env` and `.ids` are gitignored and therefore absent from a
  fresh worktree; they were copied in from the primary worktree. **Paths 1 and 2
  are already proven end to end** (see the table above); paths 3 and 4 still need a
  human to walk `m.me/<PAGE>?ref=form.flysmoke`, pick **Staging**, and press play.

  | path | expect |
  |---|---|
  | legacy linksniffer (no `vlab_platform`) | `platform=messenger` (assumed) |
  | new linksniffer (`vlab_platform`) | the stamped value |
  | legacy moviehouse (`pageId`, no platform) | `platform=messenger` (assumed) |
  | new moviehouse (`vlab_*`) | the stamped value |

- **0.5 Cut and deploy linksniffer + moviehouse. DONE 2026-08-23.**
  - **linksniffer v0.0.9** cut (`5c687072` + `99b57048`, neither in the deployed
    v0.0.8), `devops/values/staging.yaml:42` bumped, `helm upgrade` → revision 86.
    Verified against the deployed pod: absent platform → 302 +
    `LINKSNIFFER_PLATFORM_ASSUMED`; `vlab_platform=whatsapp` → 302, nothing assumed;
    `vlab_platform=sms` → **400** + `LINKSNIFFER_PLATFORM_INVALID`; no id → 400.
  - **moviehouse needed no action — it was already deployed.** The `staging` branch
    deploy of Netlify site `virtuallab-videos` (base `moviehouse`) has served
    `80d0dc25` since 01:22, and its `identity.js` is byte-identical to
    `moviehouse/src/identity.js`. Earlier notes saying this was "deployed nowhere"
    were stale.

  **Netlify deploys listed as `error` on this site are usually NOT failures.** Most
  are `Canceled build due to no content change` — Netlify skipping a build because
  nothing under the `moviehouse` base directory changed. Read `error_message` before
  concluding a deploy broke.

  Staging's moviehouse points at the **branch** deploy
  (`MOVIEHOUSE_URL: https://staging--virtuallab-videos.netlify.app`,
  `devops/values/staging.yaml:411`); the site's production branch is `main`. So a
  staging moviehouse deploy cannot touch production.

## Phase 1 · Production rollout — ~1 week

- **1.1 `bash devops/backfill-responses-pageid.sh vprod`.**
  **HARD BLOCKER for 1.2**: `responses` has **1,818,162** NULL `pageid` rows (all
  from 2020); migration 28 force-errors on any. ~91 batches at the default 20,000.
- **1.2 Migrations 26, 27, 28.** Re-measure row width first and size
  `bulkio.index_backfill.batch_size` (~10000 — **not** staging's 200; prod rows are
  1.1–1.5 KB against staging's 34.8 KB). Migration 30 is a no-op there (prod already
  runs 64 MiB ranges). Use `kubectl exec`, **not** `run-migration.sh`.
- **1.3 Deploy every service, including linksniffer and moviehouse.** Quiet window,
  scribble close behind 1.2 (§5.1: the 4-column `ON CONFLICT` against a 3-column PK
  crash-loops the sink). Netlify ships in the same window — confirmed not a
  constraint, which is why the old "close the envelope gaps" phase folds in here.

  **Concretely, from the staging rollout — production still needs all of these:**
  - **linksniffer**: tag `linksniffer-vX.Y.Z` → CI publishes to ghcr → bump
    `versionLinksniffer` in `devops/values/production.yaml` → `helm upgrade`.
    Staging runs **v0.0.9**; production is behind. Behaviour change to announce: an
    *invalid* `vlab_platform` now returns **400** instead of coercing to messenger.
    Absent is still assumed messenger.
  - **moviehouse**: Netlify site `virtuallab-videos`, base dir `moviehouse`,
    **production branch is `main`** — so shipping it to production means merging to
    `main`, not a branch deploy. Staging uses the `staging` branch deploy at
    `https://staging--virtuallab-videos.netlify.app`.
    ⚠️ Deploys listed as `error` on that site are usually
    `Canceled build due to no content change` — Netlify skipping a build because
    nothing under `moviehouse/` changed. **Read `error_message` before concluding a
    deploy failed.** Verify by fetching the deployed asset and diffing it against
    the source, not by trusting the dashboard:
    `diff <(curl -s https://<host>/identity.js) moviehouse/src/identity.js`
  - **values drift**: production still points **scribble and linksniffer at
    docker.io**, where CI does not publish. Not broken today (pinned to tags that
    exist) but it breaks on their next release. Staging is already fixed; this is a
    separate production diff and 1.3 is when it bites.
- **1.4 Soak 24h** on the §5.3 gates. Staging's soak proved little: it is idle
  (1 index read in 5h) and its data is unrepresentative.
- **1.5 Run `devops/backfill` on production.** 101M+ rows; expect hours.

  Sequence it exactly as staging did — `--dry-run`, then
  `--rehearse --max-batches 3`, then real — and check the rehearsal's counts match
  the dry-run's before committing. It is resumable (`--start-hsh` / `--start-userid`,
  printed every batch and on failure) and every batch carries `AND account_id IS NULL`,
  so re-running is a no-op, not a hazard.

  **Do not reuse staging's numbers for anything.** Staging attributed 153,776 of
  162,567 and left 8,791 unattributable; production's ratio will differ because
  staging's data is synthetic-heavy.

  **Disk is the thing to size, and the earlier arithmetic here was wrong once
  already.** `messages` has no column families, so setting `account_id` rewrites the
  whole row — `content` included — into every index, and that MVCC garbage is held
  for `gc.ttlseconds` (production: **90000s / 25h**, far longer than staging's 4h,
  so garbage accumulates much longer during a run that takes hours). Size against
  the *marginal* compression ratio for this table (~10x on staging), not against
  total-logical ÷ total-volume-used, which mixes in every other table and WAL.

  Two operational traps, both hit on 2026-08-24:
  - `--sql-dir` resolves against **cwd**, not the binary. Pass it explicitly.
  - The README's example DSN port **5455 is the local dev CockroachDB**. Forward to
    a different port and prove which database you reached before pointing a write
    tool at it.

## Phase 2 · Tighten the gates — ~2 days

- **2.1 production `STRICT_EVENT_ENVELOPE` → `"true"`**, once
  `CHAT_EVENTS_ENVELOPE_MISSING` reads zero for 24h. Lower risk than §5.4 implies
  while WhatsApp is test-only: refusing drops the WhatsApp echo, and there is barely
  any WhatsApp traffic. **That reprieve expires at W3.**
- **2.2 `SYNTHETIC_REQUIRE_CONVERSATION` → `"true"`.** Unblocked by assume-messenger:
  every synthetic producer now emits a full triple. Verify against live traffic
  first. After this an unstamped event cannot enter the system at all.

## Phase 3 · Remove the scaffolding — ~1 week

- **3.1 Drop `OR account_id IS NULL`** from `chatbase.get()`. Gate: the REMOVAL GATE
  query at the foot of migration 26 returns 0. Delete B8-5a and B8-6 and tighten
  B8-5b **in the same change**.
- **3.2 `messages.account_id` → NOT NULL.** See
  `planning/messages-account-not-null-todo.md`. Needs a `''` sentinel pass for the
  ~3,000 permanently unattributable rows.
- **3.3 Migration 19 on production.** ONLY after 1.3 — precondition 1 needs the
  `SELECT *` → `SELECT content` change shipped in replybot v0.0.221, and prod runs
  v0.0.219 on the external `chatbase-postgres`. Precondition 2 (replica
  co-location) is **satisfied**: 4 pods on 4 distinct nodes, verified 2026-08-22.
  Identify the ~5,700/day reader of the hidden index first.
- **3.4 `pageid` → `account_id` rename.** Cosmetic, last, its own PR.

## Out of scope

**`platform` NOT NULL is not achievable — drop it as a goal.** Only synthetic events
can lack a platform; both real transports derive it with certainty from payload
shape. `devops/sql/messages-platform-expr.sql` refuses to guess by design, so even a
complete backfill leaves them NULL. `platform` is descriptive, not a key, so a
sentinel buys far less than `account_id`'s did.

## WhatsApp launch checklist

Assume-messenger is correct **only while Messenger is the only live transport**. It
buys backwards compatibility by borrowing against a future WhatsApp launch, and the
debt comes due at a knowable moment. Before WhatsApp carries production traffic:

- **W1** Legacy moviehouse/linksniffer URLs must be gone, **or** platform must come
  from a lookup rather than an assumption. A legacy moviehouse URL clicked by a
  WhatsApp participant reproduces the **2026-08-13** incident exactly: a play event
  addressed to a Messenger page, at one heartbeat per 30s, leaving a phantom
  conversation BLOCKED in production.
- **W2** The lookup exists and is deterministic, not a guess: `credentials.entity`
  maps account → transport (`facebook_page` 62 keys, `whatsapp_business` 2, measured
  on prod 2026-08-22), and formcentral already resolves surveys through it.
  Caveat: `credentials` CASCADES on user delete, so **resolve and store**, never
  derive at read time. hermes has no DB access today — this is real work.
- **W3** Re-check 2.1. The WhatsApp echo is the only thing advancing those
  conversations, so the "low risk" of `STRICT_EVENT_ENVELOPE` expires here.

## What actually unlocks multi-platform

Phases 1–2 make the triple **true and enforced**. After 2.2, adding a transport is:
a hermes parser, an event-normalizer parser, and a `credentials` entity. Instagram is
the near case — B10-3 already pins that one page id may carry both `messenger` and
`instagram` conversations, and no inbound path exists today.

**Open, answered in conversation but never in code:** does a `facebook_page`
credential also serve Instagram?

## Non-negotiable sequencing

| | why |
|---|---|
| 1.1 → 1.2 | `responses` NULLs abort migration 28 |
| 1.2 → 1.3 | schema before scribble, closely (§5.1) |
| 1.3 → 3.3 | migration 19 needs replybot v0.0.221 in prod |
| 0.5 → 0.4 | test the deployed services, not the source |
| 1.3 → 2.2 | the gate cannot precede the producers it would reject |
| 0.1/0.2 → 0.3 | staging lacks disk for the backfill's MVCC churn |
