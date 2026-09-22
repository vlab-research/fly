# Multi-platform plan: getting every conversation onto (platform, account_id, user_id)

<!-- Search aliases, so this file is found however you spell it: multiplatform
     migration, multi-platform migration, conversation identity rollout,
     conversation-identity migration, account_id migration, pageid to account_id,
     platform migration status, migration status, where are we in the migration.
     This file is the AUTHORITATIVE answer to all of those. -->

**THIS FILE IS AUTHORITATIVE FOR ORDERING.** `planning/conversation-identity.md` §5
describes the conversation-identity rollout in depth — the hazards, the gates, the
traps — but the phase order lives here. If the two disagree, this file wins and the
other is stale.

**Status 2026-09-04:** **Phase 1 is COMPLETE.** 1.5 — the production backfill —
finished **2026-08-29 00:20:53 UTC**: 5,351 batches, 106,931,189 rows,
`chatroach.backfill_cursor done=t` (verified against the cursor row on vprod,
2026-09-04, not from the tool's output). Its close-out is done too: logs captured
to `devops/backfill-logs/`, `messagesBackfill.enabled: false` **applied** at helm
revision 660 (2026-09-04 21:07:43) and the Job pruned. Production runs the full
nine-service stack at staging parity; migrations 19/26/27/28a/28b/31 applied and
verified; new rows arrive stamped with `account_id`.

**Next human action: Phase 2.1** — but read its entry first. Its recorded risk
assessment was written when WhatsApp was test-only and is now **inverted**:
WhatsApp is 90% of live conversations. That is a human decision, not a
bookkeeping correction.

**Also live, and not part of this plan's phases:** an incident on `vprod` since
2026-09-02 in which a blocked conversation's `md` is erased by a
pointer-truncated replay and Dean then fabricates `messenger` over the resulting
NULL `states.platform`. That is the W2 hazard this file names, arriving early.
Spec and gates: **`planning/platform-guess-expiry.md`**.

**Phase 0 is COMPLETE (0.3 finished 2026-08-24).** All of 0.1-0.5 are done and
verified. **Phase 1 is COMPLETE (1.5 finished 2026-08-29).** Phase 1 was
entirely production work and production has now had all of it.

---

## Start here if you are new to this

**Shortcut, for the backfill:** it is done and closed out. If you are here for
the record of what 1.5 actually did — timings, the pod chain, the three `57P01`
restarts, what the runbook got wrong — go to
`planning/backfill-in-cluster-job.md` (its "YOU ARE HERE" is now the close-out)
and `devops/backfill-logs/README.md` (the captured logs and their
reconciliation). Neither is something you need to act on. Come back here for
what Phase 2 needs.

Otherwise read in this order, and do not skip the first one:

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

### State of the world, 2026-08-26 (backfill rows updated 2026-09-04)

| | staging (`vstag`) | production (`vprod`) |
|---|---|---|
| migrations 26/27/28a/28b/30 | applied | **applied, guards passed** |
| migration 29, 19 | applied — `messages` is `primary` + `messages_userid_account_timestamp_idx` only | **19 applied 2026-08-25, GC completed**; 29 not applied. 3 indexes, one NOT VISIBLE |
| migration 31 (backfill cursor) | applied 2026-08-26 | **applied 2026-08-26** |
| `devops/backfill` | **run for real 2026-08-24, verified**; Job rehearsed in-cluster 2026-08-26 | **COMPLETE 2026-08-29 00:20:53 UTC** — 5,351 batches, 106,931,189 rows, `done=t`, 48.8 h wall clock |
| `messagesBackfill` (helm) | `false` (rehearsed, then disarmed at rev 88) | **`false` — disarmed AND APPLIED**, helm rev 660 (2026-09-04 21:07:43); Job `gbv-messages-backfill` is `NotFound`, pruned |
| linksniffer | **v0.0.9** | **v0.0.9**, on ghcr |
| moviehouse | `staging` branch deploy, current | shipped to `main` |
| `STRICT_EVENT_ENVELOPE` | `true`, live since 2026-08-22 18:36 | `false` — **this is 2.1, the next phase** |
| `SYNTHETIC_REQUIRE_CONVERSATION` | `false` | `false` |
| smoke-test form-a | deployed to Typeform, 42 fields | **still the OLD 38-field form** — see 1.3 |

Production now runs the full nine-service stack at staging parity.

⚠️ **"Messenger is the only live transport; WhatsApp is a handful of test users"
stood here until 2026-09-04 and is FALSE.** It stopped being true without any
code changing, and several judgements in this file still rest on it. Measured on
vprod, conversations updated in the last 7 days:

| `states.platform` | 2026-09-03 | 2026-09-05 |
|---|---|---|
| `whatsapp` | 14,374 (**90%**) | 14,412 (**90%**) |
| `messenger` | 1,515 | 1,584 |
| NULL | 70 | 83 |

```sql
SELECT coalesce(platform,'NULL'), count(*) FROM states
 WHERE updated > now() - INTERVAL '7 days' GROUP BY 1;
```

**WhatsApp is the dominant transport.** Anywhere below that reasons from "WhatsApp
is test-only" — 2.1 in particular — is reasoning from a dead premise. The moment
was knowable and nobody was watching for it; see the WhatsApp launch checklist
and `planning/platform-guess-expiry.md` §5.

**The "re-measure on production" rule above kept earning its keep.** Two examples
from 1.5 alone: the `chatroach` service user turned out to hold only
`INSERT`/`SELECT` on `messages`, so the Job had to connect as `root`; and the
unattributable-row count came out ~16x the sampled estimate. Neither was
predictable from staging or from the docs.

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
- **0.3 Run `devops/backfill`. DONE 2026-08-24 — RAN FOR REAL, VERIFIED.**

  `DONE: reached the end of the table. 153776 rows updated across 9 batches.`
  (exit 0) — **the dry-run predicted 153,776 rows / 9 batches / reached END, and the
  real run matched all three exactly.** Verified against the table afterwards, not
  just from the tool's own output:

  | check | result |
  |---|---|
  | `count(account_id)` | **153,900** = 124 pre-existing + 153,776 backfilled ✓ |
  | rows still NULL | **8,791** — exactly the predicted unattributable count ✓ |
  | `platform` populated | 9,793 (9,792 `messenger`, 1 `whatsapp`) |
  | disk at completion | 4.1G used / **836M free** (84%), alarm at 600M never tripped |

  The 152,898 NULL `platform` rows are expected, not a shortfall — see "Out of
  scope": `messages-platform-expr.sql` refuses to guess, and `platform` NOT NULL is
  explicitly not a goal.

  Both documented traps were live hazards, not hypotheticals: port **5455 was
  listening locally**, so the README's DSN would have pointed a write tool at the
  local dev CockroachDB; and `--sql-dir` had to be passed explicitly. Target was
  proved before writing — `162,691 / 124` via the port-forward matched `kubectl exec`
  in-cluster exactly.

  Historical detail from before the run, kept for the production sizing:

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
  It does NOT transfer — re-derive it on production, and see
  `planning/messages-account-not-null-todo.md`.

  ⚠️ *This paragraph used to end "far more than the ~3,000 this doc cites for
  production, because staging's data is synthetic-heavy." **Production's figure
  is ~55,000** (`null_count 54,960` from `SHOW STATISTICS FOR TABLE messages`,
  created 2026-09-03; a statistics estimate, not an exact count). The ~3,000 came
  from a 300,000-row sample that counted two specific causes rather than every row
  the extraction rule returns NULL for. Staging is still proportionally
  synthetic-heavier — 5.4% against production's 0.05% — but the "~3,000" half of
  the comparison was wrong by 18x. See 3.2.*

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
  - **moviehouse: HOLD LIFTED 2026-08-25, shipping in this window.** It was held
    earlier the same day on the reasoning that nothing in production referenced
    it — verified true at the time: **zero** production surveys used the
    `moviehouse` or `link_tracking` field types, and prod replybot had neither
    `MOVIEHOUSE_URL` nor `LINKSNIFFER_URL` set.

    **What changed:** 1.3 deployed replybot v0.0.221, which owns first-party URLs
    and now has `MOVIEHOUSE_URL` set. The moment the updated smoke form reaches
    production, `movie_new` renders a `vlab_*`-stamped moviehouse URL — and
    production's moviehouse had **no `identity.js` at all** (HTTP 404, against
    200 on staging), so it cannot read those params. The play event lands
    unstamped. That is exactly the shape of the 12 stale `moviehouse:play` rows
    on vstag: `account_id` on all 12, `platform` NULL on all 12.

    So the hold was correct while nothing referenced moviehouse, and stopped
    being correct the moment 1.3 landed. Ship it before bringing the updated
    form into production, or `movie_new` fails in a way that reads as a code bug
    rather than a missing deploy.

    Mechanics: Netlify site `virtuallab-videos`, base dir `moviehouse`,
    production branch `main`. Staging already serves it from the `staging`
    branch deploy. `main` is a clean **fast-forward** from `staging` (zero
    main-only commits), and `main` takes changes by **pull request** — every
    recent commit there is a PR merge. Only moviehouse actually redeploys:
    `dashboard-client/` has zero diff against `main`, and the only workflows on
    `main` are tests, not image publishing.

    **Still outstanding after this ships:** production's `flysmoke` survey is the
    OLD form — created 2026-08-11, 38 fields, no `link_new`/`movie_new`. The
    42-field 0.4 update went to Typeform 2026-08-24 but production's copy
    predates it, which is why a full prod smoke run still exercises only the
    legacy paths.


  - **values drift**: production still points **scribble and linksniffer at
    docker.io**, where CI does not publish. Not broken today (pinned to tags that
    exist) but it breaks on their next release. Staging is already fixed; this is a
    separate production diff and 1.3 is when it bites.
- **1.4 Soak 24h** on the §5.3 gates. Staging's soak proved little: it is idle
  (1 index read in 5h) and its data is unrepresentative.
- **1.5 Run `devops/backfill` on production. DONE — COMPLETED 2026-08-29
  00:20:53 UTC. Closed out 2026-09-04. See `planning/backfill-in-cluster-job.md`
  and `devops/backfill-logs/`.**

  | | |
  |---|---|
  | batches | **5,351** |
  | rows updated | **106,931,189** |
  | cursor | `done = t`, `2026-08-29 00:20:53.957156+00` |
  | wall clock | **48.8 h** (Job created 2026-08-26 23:30:40, completed 2026-08-29 00:20:58) |
  | Job status | `succeeded: 1`, **`failed: 3`** — three `57P01 server is shutting down`, each resumed automatically from the cursor |

  ```sql
  SELECT batches, rows_updated, done, updated_at FROM chatroach.backfill_cursor;
  ```

  That is the source of the four figures, read back from vprod rather than taken
  from the tool's output — and the captured pod logs reconcile to it exactly
  (`devops/backfill-logs/README.md` § Reconciliation). **Do not read the last
  pod's `DONE:` line as the run total**: it reports only that pod's own counters
  and under-reports by 40x.

  **Sustained cost was 32.8 s/batch, not the 26.4–30.1 s/batch projected.** The
  projection was built on the bounded pass plus the first 47 batches of the full
  run and was ~10 h optimistic. The sentinel pass in 3.2 will be sized by the same
  method; size it off the sustained figure, not off an early sample.

  **Close-out, all four steps (2026-09-04):**

  | step | state |
  |---|---|
  | 1. capture the logs | **done** — `devops/backfill-logs/`. ⚠️ One pod's log was garbage-collected by routine k8s GC *before* capture, losing per-batch detail for batches 1–5090 (~95%, ~44 h). Unrecoverable; it predates the capture. Totals still reconcile exactly. |
  | 2. migration 26 §4 removal gate | **deliberately NOT RUN.** Costed at **399.3 GiB / 16,532 ranges**, no writes. `statement_timeout` is `0` (unlimited) on this cluster and all three pod failures were node restarts, so an unbatched run risks hours and returns nothing on a restart. Recommendation on record: slice it over the `hsh` keyspace and sum. **Do not run it casually.** |
  | 3. disarm | **done AND applied** — `messagesBackfill.enabled: false` at `devops/values/production.yaml:1415`, `helm upgrade` → **revision 660** (2026-09-04 21:07:43). Job `gbv-messages-backfill` is `NotFound`. |
  | 4. record the unattributable count | **done** — and it is **~55,000, not ~3,000**. See 3.2 and `planning/messages-account-not-null-todo.md`. |

  Historical record of how it was packaged and run follows.

  **PACKAGING DONE 2026-08-26.**

  The delivery mechanism it needed now exists and is tested: a Dockerfile whose
  build context is `devops/`, the `release.yml` change that lets the workflow
  express that (a `file:` input — `backfill` is the only service whose Dockerfile
  is not at `<context>/Dockerfile`), and
  `devops/vlab/templates/messages-backfill-job.yaml` gated on
  `messagesBackfill.enabled`. That flag was flipped to `true` to start the run
  and is **back to `false` and applied** as of 2026-09-04 (helm rev 660).
  *(An earlier version of this file said "false" here while the "State of the
  world" table said "true — disarm when the run ends". Both were describing
  different moments of the same flag; both are now moot.)*

  The recommended cursor persistence was done rather than skipped:
  `--cursor-key` writes the position to `chatroach.backfill_cursor`
  (`devops/migrations/31-backfill-cursor.sql`) after every committed batch, so a
  restarted pod resumes by itself and `backoffLimit` is 3 instead of 0. 10 new
  tests, mutation-checked; the whole lifecycle — partial run, self-resume,
  already-done — was driven through the built image against a real CockroachDB.

  **Two things the plan did not have, both found while wiring it:**
  - **The Job must connect as `root`.** `chatroach`, the user every service in
    the chart uses, holds only `INSERT` and `SELECT` on `chatroach.messages`
    (`SHOW GRANTS`, vprod, 2026-08-26). A Job reusing the services' DSN would
    connect cleanly, print a healthy banner, and fail on its first `UPDATE`.
  - **`enabled` is committed to `production.yaml`, not passed as `--set`.** Helm
    prunes what a release no longer renders, so a Job that exists only because of
    a command-line flag is deleted by the next `helm upgrade` anyone runs from
    the values file — plausibly 30 hours into a 41-hour run.

  **Rehearsed in-cluster on vstag 2026-08-26 (helm revision 87), passed.** A
  deliberate no-op — vstag is already backfilled — so it proved the delivery
  mechanism, not the backfill: image pull from ghcr, the `root` DSN from a pod,
  `--sql-dir`/`--yes`, the cursor table written as root from inside the cluster,
  9 batches to END (the same count 0.3 reported), Job succeeded in 108s, and
  `messages` unchanged at 162,691 / 153,900 / 8,791 afterwards. Turned back off
  at revision 88 and pruned cleanly. It proves nothing about duration or disk.

  **The full run started 2026-08-26 23:30:24 UTC**, helm revision 652, and
  **finished 2026-08-29 00:20:53 UTC** — 48.8 h against a projection of
  2026-08-28 ~14:40–20:00 UTC. The projection came from the bounded pass's
  30.1 s/batch and the full run's first 47 batches at 26.4; the run sustained
  **32.8 s/batch**, so the projection was ~10 h optimistic. Migration 31 is
  applied to vprod; the image is published as
  `ghcr.io/vlab-research/backfill:v0.1.0`.

  **It ran unattended, as designed, and needed it.** The cursor is durable and
  `backoffLimit: 3` restarted it three times — each a `57P01 server is shutting
  down` from a CockroachDB node restart, not a tool defect. ⚠️ Four pods are all
  `backoffLimit: 3` permits and exactly four ran: one more restart would have
  marked the Job `Failed` 261 batches from the end. Give a future one-shot more
  headroom — resume is free and idempotent.

  A bounded `--max-batches=20` pass went first, to measure what a rehearsal
  cannot: **399,779 rows in 603 s = 30.1 s/batch for committed writes**, only
  1.08x the rehearsal's rolled-back 28 s. The 41-hour floor held. The full run
  then RESUMED from the stored cursor across a Job deletion, beginning
  immediately past batch 20's boundary — no gap, no overlap.

  **The close-out runbook is `planning/backfill-in-cluster-job.md` § "WHEN IT
  FINISHES"; all four steps are recorded above.** The one that mattered beyond
  bookkeeping was step 4, the unattributable count. Two independent methods now
  agree on its magnitude: the bounded pass extrapolated **~48,800**, and
  `SHOW STATISTICS FOR TABLE messages` reports **54,960** NULL `account_id` rows
  (`created 2026-09-03 15:47:18+00`) — **~55,000, 18x the ~3,000 that
  `planning/messages-account-not-null-todo.md` was written around.** That file
  now leads with the correction. Note the 54,960 is a **statistics estimate**,
  not an exact count; the exact number needs migration 26's removal gate, which
  is deliberately unrun.

  Everything 1.5 depends on is done and verified: migrations 26/27/28a/28b, the
  1.3 deploy, and migration 19 whose GC has completed and returned the space.
  Disk headroom is ~131 GiB against a projected ~335 GiB of MVCC garbage.

  **What changed the approach: it is ~41 hours, not "hours".** Measured on vprod
  2026-08-26 by rehearsing 3 real batches — 83.7s for 3 batches, ~28 s/batch,
  ~5,350 batches at the default 20,000. That is a floor: a rehearsal rolls back,
  and real commits add replication cost. A bigger `--batch-size` does not help,
  because the cost is per-row, not per-round-trip.

  The tool was designed to run locally against a `kubectl port-forward`, which is
  right for staging (~25 minutes) and wrong for a two-day production run. So 1.5
  is now: package it as an image, run it as a k8s `Job`, then run the backfill.
  The linked plan has the Dockerfile, the `release.yml` change it needs (the build
  context must be `devops/`, and the workflow currently cannot express that), the
  Job settings that matter for a 41-hour run, and the recovery path.

  Sequence it as staging did once it is running — the rehearsal is already done and
  passed: 3 batches, 59,974 rows, counts consistent. It is resumable
  (`--start-hsh` / `--start-userid`, printed every batch) and every batch carries
  `AND account_id IS NULL`, so re-running is a no-op, not a hazard.

  **Do not reuse staging's attribution numbers.** Staging attributed 153,776 of
  162,567 and left 8,791 unattributable; production's ratio will differ because
  staging's data is synthetic-heavy.


## Phase 2 · Tighten the gates — ~2 days

- **2.1 production `STRICT_EVENT_ENVELOPE` → `"true"`**, once
  `CHAT_EVENTS_ENVELOPE_MISSING` reads zero for 24h.

  > 🛑 **THE RISK ASSESSMENT BELOW IS INVERTED. A HUMAN MUST RE-JUDGE THIS BEFORE
  > 2.1 SHIPS.** It is left in place rather than quietly rewritten, because the
  > judgement was someone's and only they should change it.
  >
  > The recorded reasoning was: *"Lower risk than §5.4 implies while WhatsApp is
  > test-only: refusing drops the WhatsApp echo, and there is barely any WhatsApp
  > traffic. That reprieve expires at W3."*
  >
  > **The premise is dead.** WhatsApp is **90%** of conversations updated in the
  > last 7 days (14,374 of ~15,959, vprod 2026-09-03; 14,412 on 2026-09-05 — see
  > "State of the world" above). "Refusing drops the WhatsApp echo" now describes
  > the dominant transport, so what was argued as a small blast radius is a large
  > one. Whether that makes 2.1 *more* urgent or *less* safe is a call, not a
  > correction — the same flip that raises the cost of a wrong envelope also
  > raises the cost of tolerating one.
  >
  > **W3 is "re-check 2.1", and W3 is the thing that already came due.** Do 2.1's
  > risk assessment and W3 as one piece of work, against measured traffic, not
  > against this paragraph. See the WhatsApp launch checklist below and
  > `planning/platform-guess-expiry.md` §5.

- **2.2 `SYNTHETIC_REQUIRE_CONVERSATION` → `"true"`.** Unblocked by assume-messenger:
  every synthetic producer now emits a full triple. Verify against live traffic
  first. After this an unstamped event cannot enter the system at all.

  ⚠️ **That is a PRESENCE gate, and presence is not correctness.** It closes
  *missing* platform. It does nothing about *wrong* platform, and wrong platform
  is what actually broke production: Dean's events were fully stamped — with
  `messenger`, on a WhatsApp account — so they satisfy 2.2 completely and still
  send the conversation to a credential that cannot exist
  (`planning/platform-guess-expiry.md` §3). Two producers have now done this;
  `devops/values/production.yaml:113-127` records the first (dinersclub,
  2026-08-25).

  **Closing the mis-stamping class is W2, not Phase 2.** Do not read a green 2.2
  as "unstamped and mis-stamped events can no longer enter the system" — only the
  first half is true.

## Phase 3 · Remove the scaffolding — ~1 week

- **3.1 Drop `OR account_id IS NULL`** from `chatbase.get()`. Gate: the REMOVAL GATE
  query at the foot of migration 26 returns 0. Delete B8-5a and B8-6 and tighten
  B8-5b **in the same change**.
- **3.2 `messages.account_id` → NOT NULL.** See
  `planning/messages-account-not-null-todo.md`. Needs a `''` sentinel pass for the
  permanently unattributable rows — **~55,000 of them, not ~3,000.**
  `SHOW STATISTICS FOR TABLE messages` gives `{account_id} | row_count
  108,074,354 | null_count 54,960 | created 2026-09-03 15:47:18+00`, and the
  bounded backfill pass independently extrapolated ~48,800. **This is a
  statistics estimate, not an exact count**; the exact number needs migration 26's
  removal gate (a scheduled 399 GiB scan, deliberately unrun). At this magnitude
  the sentinel `UPDATE` must be batched, and `''` becomes a ~55k-row population
  every consumer of `messages` has to tolerate.
- **3.3 Migration 19 on production. DONE 2026-08-25 00:44 UTC — ran EARLY, ahead of
  Phase 1, and verified.** This is a deliberate departure from the original phase
  order; the reasoning is below and the preconditions were resolved first.

  Applied with `bash devops/run-migration.sh vprod devops/migrations/19-drop-message-userid-idx.sql`
  (the script reported success honestly this time; the schema was checked anyway).

  | verification | result |
  |---|---|
  | `SHOW INDEXES` | 13 rows → **9**: only `primary` + `messages_userid_timestamp_idx` ✓ |
  | scribble `ON CONFLICT` check | now plans onto **`messages@primary`** — the predicted fallback, confirmed on prod ✓ |
  | replybot read path | **unchanged**: `messages_userid_timestamp_idx` → index join `primary` → lookup join `states` ✓ |
  | sink / replybot restarts | none attributable; all counts timestamped ~36h before the change |
  | GC job | `1204382092598476802`, `waiting for MVCC GC` — ~112 GiB expected back ~2026-08-26 01:44 UTC |

  **Why it was safe to run early.** The blocker was "identify the ~5,700/day reader".
  It is **scribble's own `ON CONFLICT (hsh, userid) DO NOTHING`** — a write-path
  anti-join, not a consumer. Conflict checks bypass `NOT VISIBLE`, so the canary
  could never have gone dark and the soak measured nothing. Precondition 1
  (`SELECT *` → `SELECT content`, replybot v0.0.221) was never a safety gate:
  migration 19's header says the issue is an EXPLAIN index *recommendation*, and
  replybot's plan used `71@3` + `71@5`, never `71@4` — now confirmed unchanged after
  the drop. Precondition 2 (replica co-location) was satisfied. Evidence in
  `planning/conversation-identity.md` §5.1d.

  **Effect on the 1.5 disk problem.** This is what makes the backfill fit. Once GC
  completes, `messages` is 2 indexes / 258.34 GiB logical. After 1.2 adds the account
  index it is 3 / 387.49 GiB, so 1.5 rewrites ~335.0 GiB of garbage against ~518.8
  GiB available — **~184 GiB margin**, where before it was ~40 GiB short.

  ⚠️ **Do not start 1.5 until the GC job has actually completed and `df` confirms the
  space.** The 25 h TTL is the gate, not the DROP.


- **3.4 `pageid` → `account_id` rename.** Cosmetic, last, its own PR.

## Doc hygiene — what can be deleted, and when

`planning/` is temporary by convention (`CLAUDE.md`), but this rollout's docs are
**not** disposable yet: Phases 2 and 3 still consume them.

**Deleted 2026-08-26**, after verifying each had no referrer outside its own
island:

- the **pageid investigation** — `pageid-*.md` and `PAGEID_*.md`, 9 files from
  2026-03-22, all concluding "COMPLETE / NO ISSUES FOUND". Entirely superseded by
  the account_id work, which restructured what they mapped. `pageid-code-reference.md`
  looked useful for 3.4's rename and is the opposite: a five-month-old code map,
  written before the message-worker extraction, platform abstraction and
  conversation identity all moved the code. `grep` beats it.
- **`platform-abstraction-plan.md`** (110 KB) and
  **`platform-abstraction-plan-consolidated.md`** — pure implementation
  scaffolding ("Files to Create / Modify / Delete", "Implementation Order"). Spent
  by construction: the repo is now the answer. The durable content is
  `documentation/platform-abstraction.md`.

**Deliberately KEPT, with the reason, so nobody re-litigates it:**

| kept | why |
|---|---|
| `conversation-identity.md` | §5.1–5.5 are cited by name in this file's "Start here" |
| `messages-account-not-null-todo.md` | it *is* Phase 3.2's spec |
| `backfill-in-cluster-job.md` | was the 1.5 runbook; since 2026-09-04 it is the close-out record — what the run actually cost, and the three things the runbook did not anticipate. Paired with `devops/backfill-logs/`. |
| `event-envelope-contract.md` | the wire contract 2.1/2.2's gates enforce; cited by `documentation/event-envelope.md` |
| `moviehouse-conversation-identity.md` | **referenced from code** — `moviehouse/src/identity.js`, `replybot/lib/generic-translator.js`, `form.js` |
| `whatsapp-webview-exposure.md` | the exposure picture W1–W3 rests on |
| `whatsapp-plan.md` | cited from `devops/migrations/20-*.sql`; names remaining work |
| `staging-rollout-runbook.md` | `whatsapp-plan.md` lists it as **remaining**, not done — its 2026-07-22 date is misleading |
| `platform-threading-{replybot,writers}-findings.md` | cited by `whatsapp-plan.md` in `{a,b}` brace shorthand, which a naive grep for the filename does not find |
| `whatsapp-trackA/trackB-findings.md` | cited by `documentation/whatsapp-onboarding.md` |

**When the rest becomes deletable:** after Phase 3 lands. At that point
`conversation-identity.md`, `event-envelope-contract.md`,
`messages-account-not-null-todo.md`, `backfill-in-cluster-job.md` and this file
can collapse into whatever `documentation/` needs to keep. Not before — and check
for `{a,b}` brace references and code references before deleting anything, because
both defeat a plain filename grep.

## Out of scope

**`platform` NOT NULL is not achievable — drop it as a goal.** Only synthetic events
can lack a platform; both real transports derive it with certainty from payload
shape. `devops/sql/messages-platform-expr.sql` refuses to guess by design, so even a
complete backfill leaves them NULL. `platform` is descriptive, not a key, so a
sentinel buys far less than `account_id`'s did.

## WhatsApp launch checklist

> ## 🛑 THE PRECONDITION HAS EXPIRED. THIS CHECKLIST IS OVERDUE, NOT PENDING.
>
> "Before WhatsApp carries production traffic" was the trigger. **WhatsApp
> carries 90% of production traffic** (14,374 of ~15,959 conversations updated in
> the last 7 days, vprod 2026-09-03; 14,412 on 2026-09-05). W1–W3 were never
> done, and the debt has now been called **twice**:
>
> 1. **2026-08-25 — dinersclub.** Recorded at
>    `devops/values/production.yaml:113-127`: v0.0.46 emitted payment events in
>    the legacy shape with no platform, assume-messenger kicked in, and a WhatsApp
>    participant went BLOCKED. That note names the diagnosis itself — *"This is
>    exactly the W1 hazard in planning/multi-platform-plan.md"* — and was fixed by
>    threading the real platform through one producer.
> 2. **2026-09-02 onward — Dean.** The same bug through a different producer,
>    still firing, currently paging. `planning/platform-guess-expiry.md` is the
>    spec and the gates; **its Task B is W2 for Dean specifically.**
>
> **Fixing producers one at a time does not converge** — there are eight hops and
> seven synthetic posters. The general case is W2.

Assume-messenger is correct **only while Messenger is the only live transport**. It
buys backwards compatibility by borrowing against a future WhatsApp launch, and the
debt comes due at a knowable moment. That moment has passed.

- **W1 — NOT CLOSEABLE. Assessed 2026-09-04:
  `planning/w1-legacy-webview-audit.md`.** Legacy moviehouse/linksniffer URLs must
  be gone, **or** platform must come from a lookup rather than an assumption. A
  legacy moviehouse URL clicked by a WhatsApp participant reproduces the
  **2026-08-13** incident exactly: a play event addressed to a Messenger page, at
  one heartbeat per 30s, leaving a phantom conversation BLOCKED in production.

  The audit found **802 legacy hand-authored `webview` fields across 131 current
  surveys**, of which 110 fields / 53 surveys are on a live host, 92 carry a
  literal hardcoded account id, and 49 `wait` on the tracked event (so they hang
  rather than degrade). **Zero of the 802 carry any platform parameter**, and
  there is a confirmed still-stuck WhatsApp casualty. So the first branch of W1
  cannot be satisfied by cleanup on any near horizon — **W1 has to be met by the
  lookup, i.e. by W2.**

- **W2** The lookup exists and is deterministic, not a guess: `credentials.entity`
  maps account → transport (`facebook_page` 62 keys, `whatsapp_business` 2, measured
  on prod 2026-08-22 and unchanged 2026-09-05), and formcentral already resolves
  surveys through it. The `unique_messaging_account` partial unique index on `key`
  (`WHERE entity IN ('facebook_page','whatsapp_business')`) makes the join
  single-valued.

  **`planning/platform-guess-expiry.md` is W2's spec**, written against the live
  incident. Its Task B removes the guess from Dean's seven sweep queries and is
  committed unpushed.

  Caveat, still standing: `credentials` CASCADES on user delete, so **resolve and
  store**, never derive at read time. Task B derives at read time — it stops the
  incident and is a mitigation with a known lifetime, not the end state. hermes
  has no DB access today; that half is still real work.

- **W3 — this is the one that already came due.** Re-check 2.1. The reasoning
  recorded at 2.1 assumes barely any WhatsApp traffic and is inverted at 90%. Do
  W3 and 2.1's risk assessment as one piece of work.

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
| 1.1 → 1.2 | `responses` NULLs abort migration 28a's guard |
| 1.2 → 1.3 | schema before scribble (§5.1). **The 28a/28b split removes the window** — after 28a both the old and new build have a valid `ON CONFLICT` arbiter, so the deploy is no longer a race. 28b closes the overlap afterwards. |
| **1.3 → 1.5** | **the backfill must not run behind a writer still producing NULLs.** After 1.3 the new code stamps `account_id` on every new row, so 1.5 only fills historical gaps and `AND account_id IS NULL` makes it idempotent. Reversed, you would backfill forever. |
| 3.3 → 1.5 | migration 19 frees the disk 1.5 needs — **and it must be a completed GC, not just a completed DROP** (25h TTL) |
| migration 31 → 1.5 | the Job passes `--cursor-key`, and the tool fails at STARTUP if `chatroach.backfill_cursor` is missing — deliberately, so a broken cursor is not discovered 40 hours in |
| 0.5 → 0.4 | test the deployed services, not the source |
| 1.3 → 2.2 | the gate cannot precede the producers it would reject |
| 0.1/0.2 → 0.3 | staging lacks disk for the backfill's MVCC churn |

~~1.3 → 3.3~~ is **retired**: migration 19 never needed replybot v0.0.221, and it
was applied to production on 2026-08-25 ahead of Phase 1. See 3.3.
