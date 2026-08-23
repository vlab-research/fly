# Multi-platform plan: getting every conversation onto (platform, account_id, user_id)

**THIS FILE IS AUTHORITATIVE FOR ORDERING.** `planning/conversation-identity.md` §5
describes the conversation-identity rollout in depth — the hazards, the gates, the
traps — but the phase order lives here. If the two disagree, this file wins and the
other is stale.

**Status 2026-08-22:** staging fully rolled out; production untouched; Messenger is
the only live transport. Integration suite 61/61, in CI and locally.

---

## Phase 0 · Finish staging — ~1 day

- **0.1 Migration 29** (`DROP messages_userid_timestamp_idx`). Frees 566 MB, cuts
  write amplification 4 indexes → 3. Still unwritten.
  **BLOCKS 0.3**: the backfill rewrites every row (no column families, so `content`
  is rewritten too) → ~2.3 GB of MVCC held for `gc.ttlseconds=14400`, against
  ~700 MB free. Land 29 (+19), or grow the 5 Gi volume.
- **0.2 Migration 19, staging only.** Preconditions met *here*: replybot v0.0.221 is
  deployed and it is a single node. Frees a further 578 MB. Keep one canary until
  0.3 has proven the new index under real traffic.
- **0.3 Run `devops/backfill`.** `--dry-run` → `--rehearse --max-batches 3` → real.
  Never executed anywhere. Only this makes **history** triple-keyed: today 70 of
  162,637 staging rows carry `account_id`.
- **0.4 Extend `smoke-test/form-a.json` to all four paths.** It has moviehouse and
  payment today and **no link field at all**.

  | path | expect |
  |---|---|
  | legacy linksniffer (no `vlab_platform`) | `platform=messenger` (assumed) |
  | new linksniffer (`vlab_platform`) | the stamped value |
  | legacy moviehouse (`pageId`, no platform) | `platform=messenger` (assumed) |
  | new moviehouse (`vlab_*`) | the stamped value |

- **0.5 Cut and deploy linksniffer + moviehouse** with the assume-messenger change,
  so 0.4 tests deployed behaviour rather than source.

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
- **1.4 Soak 24h** on the §5.3 gates. Staging's soak proved little: it is idle
  (1 index read in 5h) and its data is unrepresentative.
- **1.5 Run `devops/backfill` on production.** 101M+ rows; expect hours.

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
