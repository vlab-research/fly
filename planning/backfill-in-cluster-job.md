# Run `devops/backfill` as an in-cluster Job (Phase 1.5)

**Status 2026-08-26:** the packaging is BUILT AND TESTED; the backfill has not
been run. Everything 1.5 depends on is DONE and verified on production; this is
the last step of the conversation-identity rollout.

| the work | state |
|---|---|
| `devops/backfill/Dockerfile` (+ `devops/.dockerignore`) | written; **image built and smoke-tested locally against a real CockroachDB** |
| `.github/workflows/release.yml` | `backfill` case + the `file:` input it needs |
| `devops/vlab/templates/messages-backfill-job.yaml` | written; renders and validates against the vprod API schema |
| `devops/vlab/values.yaml` / `devops/values/production.yaml` | `messagesBackfill`, **`enabled: false`** |
| durable cursor (the open question below) | **DONE** — `--cursor-key`, `devops/migrations/31-backfill-cursor.sql`, 10 new tests, mutation-checked |
| image published to ghcr | **DONE** — `ghcr.io/vlab-research/backfill:v0.1.0`, and the `*-expr.sql` inside it diff clean against the repo |
| migration 31 applied to **vstag** | **DONE** — schema verified, `hsh`/`userid` nullable as designed |
| the Job **rehearsed in-cluster on vstag** | **DONE, PASSED** — see below |
| migration 31 applied to **vprod** | **NO** |
| the backfill itself | **NOT RUN** |

### The in-cluster rehearsal, vstag 2026-08-26 (helm revision 87)

The delivery mechanism has now been exercised end to end in a real cluster. It
was deliberately a **no-op run**: vstag was backfilled for real on 2026-08-24 and
its remaining 8,791 NULL rows are the permanently-unattributable synthetic ones,
so every `UPDATE` was excluded by `AND account_id IS NULL`.

```
batch 1..8: updated 0 rows ...
batch 9:    updated 0 rows (total 0) cursor END
DONE: reached the end of the table. 0 rows updated across 9 batches.
```

**9 batches — the same count 0.3's real run reported.** Job succeeded in 108s.

| check | result |
|---|---|
| Job status | `1 succeeded, 0 failed` |
| image pull from ghcr into the cluster | worked, `IfNotPresent` |
| `root` DSN against `gbv-cockroachdb-public` from a pod | connected |
| `--sql-dir=/app/sql`, `--yes` | correct — no startup failure, no prompt hang |
| cursor row afterwards | `9 batches, rows_updated 0, done=t` — **written as root from inside the cluster** |
| `chatroach.messages` afterwards | 162,691 / 153,900 / 8,791 — **unchanged** |
| helm prune on `enabled: false` (revision 88) | Job deleted cleanly, cluster healthy |

**What it did NOT prove, and must not be read as proving:** a committed `UPDATE`
to `messages` from in-cluster (there was nothing left to update, so root's write
privilege on `messages` still rests on `SHOW GRANTS` plus the cursor-table write
the Job did perform), and anything at all about duration, disk churn or scale.
vstag's rows are ~25x fatter and it runs one CockroachDB node. Re-measure on
production; inherit nothing.

**One thing the upgrade surfaced that was not ours:** vstag's message-worker was
on v0.1.21 while `staging.yaml` said v0.1.22 — drift from commit `d4f21927`,
which was applied to prod and never to staging. The upgrade corrected it, which
is the values file's own desired state and was already prod-proven.

**One precondition the plan did not have, found while wiring the Job.** Every
service in the chart connects as `chatroach`, and that user holds only `INSERT`
and `SELECT` on `chatroach.messages` — `SHOW GRANTS`, vprod, 2026-08-26. A Job
reusing the services' DSN would connect cleanly, print a healthy banner, and fail
on its **first** `UPDATE`. **The Job connects as `root`.** The host is still
reused from `.Values.chatbaseHost` rather than restated, which was the part of
the "reuse existing values" advice that actually mattered.

**A second deviation, deliberate.** "Running it" below says
`--set messagesBackfill.enabled=true`. **Do not.** Helm prunes what a release no
longer renders, so a Job that exists only because of a command-line flag is
deleted by the next `helm upgrade` anyone runs from the values file — plausibly
30 hours into a 41-hour run, by someone shipping something unrelated. `enabled`
is therefore committed in `devops/values/production.yaml`, and flipping it to
`true` and applying IS the start command. (A Job's `spec.template` and
`backoffLimit` are also immutable after creation: re-rendering identical YAML
patches to a no-op, but changing a setting while the Job exists fails the upgrade
loudly, which is the right outcome.)

**Re-verified on vprod 2026-08-26 before any of this was written:**

| check | result |
|---|---|
| `count(*)` / `count(account_id)` | 106,994,949 / **8,800** — producers stamping forward, up from 1,288 |
| indexes on `messages` | 3: `primary`, `messages_userid_account_timestamp_idx`, `messages_userid_timestamp_idx` (NOT VISIBLE) — as the sizing assumes |
| disk, all four nodes | 124 / 127 / 125 / 126 GiB free (~502 GB) — the ~466 GiB the sizing assumes, still there |

**Why this exists:** the tool was designed to run locally against a
`kubectl port-forward`, and its README says so. That is fine for staging, which
finished in ~25 minutes. It is not fine for production. **Measured on vprod
2026-08-26: ~41 hours.** A port-forward held open for two days is not a
deployment strategy.

---

## MEASURED FOR REAL ON PRODUCTION, 2026-08-26 (bounded first pass)

The 41-hour projection came from a `--rehearse`, which rolls its work back. This
is what committed writes actually cost, from a deliberately bounded
`--max-batches=20` run on vprod (helm revision 651):

| | |
|---|---|
| rows committed | **399,779** across 20 batches |
| wall clock | **603 s** |
| per batch | **30.1 s** — against the rehearsal's 28 s, i.e. **1.08x** |
| per row | 1.508 ms |
| batches remaining | ~5,329 |
| **projected remaining** | **~44.6 h (1.86 days)** |

**The rehearsal was a good proxy.** Real commits cost 8% more than rolled-back
ones, not 2x — so the plan's "41 hours, and that is a FLOOR" was right and the
floor is close to the ceiling.

Verified afterwards rather than trusted:

| check | result |
|---|---|
| `count(account_id)` | 410,139 = 10,310 before + 399,779 backfilled + ~50 new arrivals ✓ |
| cursor row | `20 batches, 399,779 rows, done=f`, resume point recorded ✓ |
| Job | `1 succeeded, 0 failed` |
| disk after | **538.36 GiB available** across the four nodes — better than the 466 GiB the sizing assumed, because 28a/28b's GC is still returning space. ~335 GiB projected garbage leaves **~203 GiB margin**. |

**An early signal for Phase 3.2, not a conclusion.** 221 of the 400,000 rows in
this slice were unattributable (0.055%). Extrapolated naively that is ~59,000
across the table — **20x the "~3,000 by an older count"** that
`planning/messages-account-not-null-todo.md` is written around. This slice is the
low end of the `hsh` keyspace and may not be representative, so re-derive the
real number at the end. Do not plan the `''` sentinel pass around 3,000.

## The measurement that forces this

Rehearsal on production (`--rehearse --max-batches 3`, real `UPDATE`s rolled back):

```
batch 1: rehearsed (rolled back) 19992 rows
batch 2: rehearsed (rolled back) 19995 rows
batch 3: rehearsed (rolled back) 19987 rows
3 batches in 83.7s  ->  ~28 s/batch
```

| | |
|---|---|
| rows in `chatroach.messages` | **106,987,437** |
| already carrying `account_id` | **1,288** (everything written since the 1.3 deploy) |
| batches at the default 20,000 | **~5,350** |
| **projected duration** | **~41 hours** — and that is a FLOOR, because a rehearsal rolls back and real commits add replication cost |

**Do not try to fix this with a bigger `--batch-size`.** The cost is per-row —
scan, rewrite into three indexes, replicate — so total work is roughly constant
however it is sliced. Larger batches buy fewer round trips against a cost that is
not round trips.

One thing the duration helps: `gc.ttlseconds` on `messages` is 90000 (25 h), so on
a 41-hour run the first ~16 hours of MVCC garbage is collected *during* the run.
Peak disk will land below the ~335 GiB the sizing below assumes.

---

## Preconditions — all already satisfied, do not redo them

Verified on production 2026-08-25/26. Re-check cheaply, but none of this is
outstanding work:

| precondition | state |
|---|---|
| migrations 26, 27, 28a, 28b | applied, guards passed |
| migration 19 | applied, **GC completed** — the space came back |
| 1.1 `responses` pageid backfill | 1,818,162 rows, verified zero remaining |
| 1.3 deploy | all nine services at staging parity |
| producers stamping | new rows arrive WITH `account_id` — confirmed live |
| disk headroom | see below |

**Disk, measured after migration 19's GC:**

```
node0 122G avail   node1 127G avail   node2 125G avail   node3 126G avail
                                            total ~500 GB (466 GiB)
```

Sizing: `messages` is **387.65 GiB logical** across 3 indexes (`primary`,
`messages_userid_timestamp_idx` NOT VISIBLE, `messages_userid_account_timestamp_idx`).
A full rewrite is `387.65 x 3 replicas / 3.47 compression` = **~335 GiB physical**
of garbage against ~466 GiB available — **~131 GiB margin**, before counting the
18 GC jobs still draining from 28a/28b. This is the check that was *40 GiB short*
before migration 19; dropping that index is what made 1.5 possible.

---

## The work

### 1. `devops/backfill/Dockerfile`

Model on `dean/Dockerfile` — same shape, Go build then alpine runtime:

```dockerfile
FROM golang:1.24-alpine AS build
WORKDIR /app
ADD backfill/go.mod backfill/go.sum ./
RUN go mod download
ADD backfill/ /app/
RUN go build -o main .

FROM alpine
WORKDIR /app
COPY --from=build /app/main /app/
COPY sql/ /app/sql/
ENTRYPOINT ["/app/main"]
```

⚠️ **The build context must be `devops/`, not `devops/backfill/`.** The tool needs
`--sql-dir` to point at `devops/sql/messages-account-id-expr.sql` and
`messages-platform-expr.sql`, which live OUTSIDE the backfill directory. Docker
cannot reach above its context.

**Do not "fix" this by moving the SQL files into `devops/backfill/`.** They are
shared: `scribble`'s `TestBackfillSQLMatchesGo` asserts the Go and the SQL agree
(see the comment at `devops/backfill/backfill.go:7`). Moving them breaks that test
and creates a second copy that can silently diverge — which is the whole failure
mode this rollout exists to fix.

`go:embed` is also not a shortcut here: it cannot reach outside the module
directory, and the module root is `devops/backfill`.

### 2. `.github/workflows/release.yml`

Add a case to the service→context map (~line 30-50):

```
backfill)       CTX=devops             ; IMG=backfill        ;;
```

⚠️ **This needs one more change.** The workflow currently passes only
`context:` to `docker/build-push-action@v5`, so the Dockerfile is assumed to be at
`<context>/Dockerfile`. With `CTX=devops` that resolves to `devops/Dockerfile`,
which is wrong. Add a `file:` input:

```yaml
      - uses: docker/build-push-action@v5
        with:
          context: ${{ steps.resolve.outputs.context }}
          file: ${{ steps.resolve.outputs.dockerfile }}
```

and emit `dockerfile=devops/backfill/Dockerfile` from the resolve step, defaulting
to `<context>/Dockerfile` for every existing service so nothing else changes.

Then `git tag backfill-v0.1.0 && git push origin backfill-v0.1.0` publishes
`ghcr.io/vlab-research/backfill:v0.1.0`. The tag pattern the workflow matches is
`*-v[0-9]+.[0-9]+.[0-9]+`.

### 3. A Job template in the umbrella chart

`devops/vlab/templates/messages-backfill-job.yaml`, gated on
`.Values.messagesBackfill.enabled` (default **false** — this must never run by
accident on a `helm upgrade`).

Model it on `devops/vlab/templates/media-reconciler-cronjob.yaml`, and follow that
file's stated reasoning: **reuse existing values rather than restating the database
host.** A second copy of the DSN is a second copy that can disagree.

A `Job`, not a `CronJob`. Required settings for a 41-hour run:

```yaml
spec:
  backoffLimit: 0            # NEVER auto-restart: a fresh start redoes ~40h of work
  activeDeadlineSeconds: ~   # leave UNSET, or >200000. The default is no deadline;
                             # setting a small one kills the job mid-run.
  template:
    spec:
      restartPolicy: Never
```

`backoffLimit: 0` is the important one. The tool is idempotent (`AND account_id IS
NULL` on every batch) so a restart is *safe*, but it restarts from the beginning
of the keyspace unless given a cursor — hours of scanning to reach where it was.

Resource requests should be modest: the process issues `UPDATE`s and moves a
cursor. Per the README, *"the expressions run server-side; `content` never crosses
the wire."* The database does the work.

---

## Running it

Edit `devops/values/production.yaml` — `messagesBackfill.enabled: true` — and
apply. **Not `--set`; see the deviation note at the top.**

```bash
helm upgrade gbv vlab -f values/production.yaml -n vprod
```

First, once each:

```bash
bash devops/run-migration.sh vprod devops/migrations/31-backfill-cursor.sql
git tag backfill-v0.1.0 && git push origin backfill-v0.1.0
```

Then watch. Do NOT tail it interactively for two days:

```bash
kubectl logs -n vprod job/gbv-messages-backfill -f --tail=20
kubectl get job -n vprod gbv-messages-backfill -w
```

⚠️ **Capture the final log lines BEFORE setting `enabled: false` afterwards.**
Turning it off makes helm prune the Job, which takes its pod and its logs with
it — as it did on vstag at revision 88. There is no `ttlSecondsAfterFinished` so
nothing else deletes it, but the values flip does.

Progress query — cheap, uses no table scan of consequence:

```sql
SELECT count(account_id) AS filled FROM chatroach.messages;
```

Watch disk across all four nodes periodically. The margin is ~131 GiB, which is
comfortable, but this is a 41-hour write:

```bash
for p in 0 1 2 3; do kubectl exec -n vprod gbv-cockroachdb-$p -- \
  df -h /cockroach/cockroach-data | tail -1; done
```

### If the pod dies

The tool prints its cursor on **every batch** and on failure:

```
resume with: --start-hsh=<n> --start-userid="<s>"
```

With `--cursor-key` set — which the Job passes — you no longer need to. The pod
resumes by itself, and `backoffLimit: 3` lets Kubernetes do it for you. Check
where it is:

```sql
SELECT * FROM chatroach.backfill_cursor;
```

The log-scrape path remains as the manual override: recover the last cursor line
and set it in `messagesBackfill.extraArgs` as `--start-hsh=` / `--start-userid=`,
which take precedence over the stored position. Do not restart from scratch.

---

## The open design question — RESOLVED, the cursor is now durable

It was: *the cursor lives only in stdout, so recovery depends on scraping a log
line from a pod that may have been garbage-collected.* It is now persisted, and
`backoffLimit` is 3 rather than 0 as a result.

**A table, not a ConfigMap.** The process already holds a connection to this
database and already has write privileges on it. A ConfigMap would need a
ServiceAccount, a Role, a RoleBinding and a Kubernetes client in a tool whose
entire dependency list is pgx — new failure modes, none in the direction of the
actual risk.

`devops/migrations/31-backfill-cursor.sql` creates `chatroach.backfill_cursor`;
`--cursor-key <name>` turns it on. A restart with no `--start-*` flags resumes by
itself; explicit `--start-*` still override; a completed run exits immediately
instead of re-walking the table; totals accumulate across restarts so an operator
watching for two days does not see them reset to zero when a pod is replaced.

Three decisions worth keeping:

- **The cursor is written after the batch, never before.** Ahead of its work it
  would make a restart skip that batch's rows, and a skipped row is never
  revisited. One batch stale is harmless — `AND account_id IS NULL` — so lagging
  is the correct direction to fail in.
- **Not in the batch's transaction, deliberately.** Each batch is one statement,
  which CockroachDB runs as an implicit transaction and can retry at the gateway.
  An explicit `BEGIN`/`COMMIT` would push retryable 40001s out to a client with no
  retry loop: a harmless race traded for a new way to abort a two-day job.
- **`--dry-run`/`--rehearse` never move it.** A rehearsal rolls its work back; a
  rehearsal that advanced the cursor would make the next real run skip every
  range it rehearsed.

A missing table or grant is fatal at **startup** — the tool reads the cursor and
writes a probe row before doing any work — so a broken sink cannot be discovered
40 hours in. A write failure mid-run is a loud warning and the run continues.

**Verified, not assumed.** 10 new tests, and the two mutations that matter both
fail: removing the dry-run/rehearse guard fails two tests, and moving the save
ahead of its batch fails with rows left NULL — the silent-skip signature.

The whole lifecycle was also driven through the built image against a real
CockroachDB: a run stopped at `--max-batches=1`, a restart with no flags that
printed `RESUMING from the stored cursor`, and a third that printed
`ALREADY DONE` — with cumulative totals (3 batches / 4 rows) matching what the
dry-run predicted.

---

## Traps, all hit for real

- **Port 5455 is the LOCAL DEV CockroachDB** and is very likely listening. Proven
  again 2026-08-26: it answered `SELECT count(*) FROM chatroach.messages` with
  **3**. This matters less for an in-cluster Job, which talks to
  `gbv-cockroachdb-public` directly — but it will bite anyone who reaches for the
  README's port-forward instructions out of habit.
- **`--sql-dir` resolves against CWD, not the binary.** Default is the literal
  relative path `devops/sql` (`main.go:73-74`). In the image, pass
  `--sql-dir=/app/sql` explicitly.
- **`--yes` is required** or the job blocks forever on a confirmation prompt that
  no one can answer. The prompt makes you type `vprod` when the DSN looks like
  production; a Job has no stdin.
- **`SHOW JOBS` truncates `description` to 69 characters**, so filtering CRDB jobs
  by name silently matches nothing. Pin `job_id`. See
  `planning/conversation-identity.md` §5.2.

## Verifying it worked

```sql
SELECT count(*) AS total, count(account_id) AS with_acct,
       count(*) - count(account_id) AS still_null
  FROM chatroach.messages;
```

`still_null` will NOT reach zero. Some rows are permanently unattributable —
synthetic events carrying no account in `content`. Staging left **8,791** of
162,567, but staging is synthetic-heavy and that ratio does **not** transfer;
production's was estimated at ~3,000 by an older count. Re-derive it, and see
`planning/messages-account-not-null-todo.md`, which needs that number for the
`''` sentinel pass before `account_id` can go NOT NULL (Phase 3.2).

`platform` will also stay largely NULL. That is by design, not a shortfall —
`devops/sql/messages-platform-expr.sql` refuses to guess, and `platform` NOT NULL
is explicitly out of scope. See the "Out of scope" section of
`planning/multi-platform-plan.md`.
