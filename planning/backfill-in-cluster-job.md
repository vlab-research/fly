# Run `devops/backfill` as an in-cluster Job (Phase 1.5)

**Status 2026-09-04: THE PRODUCTION BACKFILL IS COMPLETE AND CLOSED OUT.**
It finished **2026-08-29 00:20:53 UTC** — 5,351 batches, 106,931,189 rows,
`chatroach.backfill_cursor done=t`, **48.8 h wall clock**. Phase 1 of the
conversation-identity rollout is done; **2.1 is next**
(`planning/multi-platform-plan.md`).

**There is nothing to do here.** This file is now a record, not a runbook.

**If you are picking this up cold:** read
[YOU ARE HERE](#-you-are-here--close-out-2026-09-04) — it has the outcome, the
state of all four close-out steps, and the three things this runbook did not
anticipate. The captured pod logs and their reconciliation live in
`devops/backfill-logs/README.md`. Everything else below is the record of how it
was built and why, kept because the next one-shot Job in this chart will hit the
same traps — reference, not instructions.

| the work | state |
|---|---|
| `devops/backfill/Dockerfile` (+ `devops/.dockerignore`) | written; **image built and smoke-tested locally against a real CockroachDB** |
| `.github/workflows/release.yml` | `backfill` case + the `file:` input it needs |
| `devops/vlab/templates/messages-backfill-job.yaml` | written; renders and validates against the vprod API schema |
| `devops/vlab/values.yaml` / `devops/values/production.yaml` | `messagesBackfill` — chart default `false`; **production is currently `true`** and must be set back to `false` when the run ends |
| durable cursor (the open question below) | **DONE** — `--cursor-key`, `devops/migrations/31-backfill-cursor.sql`, 10 new tests, mutation-checked |
| image published to ghcr | **DONE** — `ghcr.io/vlab-research/backfill:v0.1.0`, and the `*-expr.sql` inside it diff clean against the repo |
| migration 31 applied to **vstag** | **DONE** — schema verified, `hsh`/`userid` nullable as designed |
| the Job **rehearsed in-cluster on vstag** | **DONE, PASSED** — see below |
| migration 31 applied to **vprod** | **DONE 2026-08-26** — 7 columns, `hsh`/`userid` nullable, `root` ALL, no grant to the service user |
| bounded first pass on vprod (`maxBatches: 20`) | **DONE** — 399,779 rows, measured 30.1 s/batch for committed writes |
| **the backfill itself** | **DONE — 2026-08-26 23:30:24 → 2026-08-29 00:20:53 UTC**, 5,351 batches, 106,931,189 rows, `done=t` |
| disarming it afterwards | **DONE 2026-09-04** — `enabled: false` applied at helm revision 660; Job pruned, `NotFound` |

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

## ✅ YOU ARE HERE — close-out, 2026-09-04

**The run is over and closed out. Nothing here is an instruction.**

### Outcome

| | |
|---|---|
| started | 2026-08-26 23:30:24 UTC (Job created 23:30:40), helm revision 652 |
| **finished** | **2026-08-29 00:20:53.957156 UTC** (Job completed 00:20:58) |
| **duration** | **48.8 h** actual |
| batches | **5,351** |
| rows updated | **106,931,189** |
| cursor | `done = t` |
| Job status | `succeeded: 1`, **`failed: 3`** |

Read back from the database, not from the tool:

```sql
SELECT batches, rows_updated, done, updated_at FROM chatroach.backfill_cursor;
-- messages-account-backfill | 5351 | 106931189 | t | 2026-08-29 00:20:53.957156+00
```

The captured pod logs reconcile to that row exactly — `5090 + 110 + 5 + 146 =
5,351` and `101,729,634 + 2,198,295 + 99,939 + 2,903,321 = 106,931,189`. Full
record, including the pod chain and the gapless handoffs:
`devops/backfill-logs/README.md`.

### The projection was ~10 h optimistic — and the same method will size 3.2

Projected finish was 2026-08-28 ~14:40–20:00 UTC, from the bounded pass's
**30.1 s/batch** and the full run's first 47 batches at **26.4 s/batch**. The run
sustained **~32.8 s/batch** and landed 2026-08-29 00:20 — roughly **10 hours**
past the late end of the window.

**The early sample was optimistic, not the late one.** An early window catches a
cold cache, low MVCC garbage and an uncontended cluster; the cost per row rises as
the run's own garbage accumulates. **Phase 3.2's sentinel pass will be sized by
exactly this method** (`planning/messages-account-not-null-todo.md`) — size it off
32.8 s/batch sustained, and treat any first-hour measurement as a floor.

### The four close-out steps, as actually done

**1. Capture the logs — DONE**, to `devops/backfill-logs/` (three pod logs,
`job.yaml`, `job-describe.txt`, `pods.yaml`), committed before anything was
disarmed.

> ⚠️ **One pod's log was lost, and not to this process.** `backoffLimit: 3` was
> consumed in full, so **four** pods ran and only **three** survived: routine
> Kubernetes garbage collection had already taken the first, and with it the
> per-batch detail for **batches 1–5090 of 5,351 (95.1%)** — roughly the first
> 44 hours. **That loss predates the capture and is not recoverable.** The
> *totals* are fully reconciled against the cursor, so the outcome is not in
> doubt; only the per-batch timing history of the bulk of the run is gone.

**2. Migration 26's §4 REMOVAL GATE — DELIBERATELY NOT RUN.**
`devops/migrations/26-messages-account.sql:154-165`. This step of the runbook was
skipped on purpose, and the reasoning is recorded so nobody runs it by accident:

- Costed at **399.3 GiB / 16,532 ranges**, no writes.
- `statement_timeout` on this cluster is **`0` — unlimited**. Nothing will stop
  it.
- All three pod failures during the run were `57P01 server is shutting down`,
  i.e. CockroachDB nodes restarting under it. A single unbatched scan that meets
  one returns **nothing** after hours of work.

**Recommendation on record: slice it over the `hsh` keyspace and sum the
slices**, the same way the backfill itself walked the table. Schedule it
deliberately. **Do not run it casually, and do not put it on a dashboard.**

**3. Disarm — DONE AND APPLIED 2026-09-04.**
`messagesBackfill.enabled: false` in `devops/values/production.yaml:1415`, applied
with `helm upgrade` → **revision 660** (2026-09-04 21:07:43). Helm pruned the Job:
`kubectl get job -n vprod gbv-messages-backfill` now returns
`Error from server (NotFound)`. Re-arming would be inert anyway — the cursor
records `done=t`, so the tool exits `ALREADY DONE`.

**4. Unattributable count — RECORDED, and it is 18x the planned figure.**
`SHOW STATISTICS FOR TABLE messages` gives `{account_id} | row_count 108,074,354 |
null_count 54,960 | created 2026-09-03 15:47:18+00` — **~55,000, against the
~3,000 Phase 3.2 was written around**, and consistent with the bounded pass's
independent ~48,800 extrapolation. It is a **statistics estimate, not an exact
count**; the exact number is what step 2's gate would produce. Consequences for
the sentinel pass live in **`planning/messages-account-not-null-todo.md`**, which
now leads with the correction.

### Three things this runbook did not anticipate

Each cost something, and each generalises to the next one-shot Job in this chart.

1. **`backoffLimit: 3` was not headroom — it was *exact*.** It permits four pods;
   four ran. One more `57P01` in that ~68-minute window on 08-28 would have marked
   the Job `Failed` and stranded the run **261 batches from the end**, needing the
   manual delete-and-reapply below. This file called it ample. **Future one-shots
   should set a much larger `backoffLimit`**: resume is free and idempotent (the
   durable cursor plus `AND account_id IS NULL`), so extra retries cost nothing
   and a bounded one nearly cost the run.
2. **Routine pod GC takes logs while the Job still sits `Complete`.** "Capture the
   logs before disarming" was correct and insufficient — nothing deletes the *Job*
   on its own, but Kubernetes had already reclaimed the first pod long before
   anyone reached the close-out, taking 95% of the per-batch history. **Capture
   per-pod as the run goes**, on each restart, not once at the end.
3. **The final pod's `DONE` line reports only its own counters — it under-reports
   the run by 40x.** Pod 3 printed `DONE: reached the end of the table. 2903321
   rows updated across 146 batches.` The run was 106,931,189 rows across 5,351
   batches. The cumulative figures live **only** in `backfill_cursor` and in each
   pod's `RESUMING` line. Anyone reading the last pod's log alone will record the
   wrong number.

---

### Historical: how it was watched while it ran

```bash
kubectl get job -n vprod gbv-messages-backfill
kubectl logs -n vprod job/gbv-messages-backfill --tail=5      # never -f for two days
for p in 0 1 2 3; do kubectl exec -n vprod gbv-cockroachdb-$p -- \
  df -h /cockroach/cockroach-data | tail -1; done
```

It **resumed** rather than restarted when it was widened, which is the durable
cursor working across a Job deletion in production:

```
RESUMING from the stored cursor: hsh=-9154446195056495845 userid=3047173258742232
                                 (399779 rows across 20 batches so far)
batch 1: updated 19996 rows (total 19996) cursor hsh=-9151006287849897919 ...
```

Batch 1 begins immediately past the bounded pass's batch-20 boundary — no gap,
no overlap. It did the same thing three more times, across three node restarts.

Byte-exact disk at the start: **405.28 GiB used / 538.36 GiB available** across
the four nodes. Projected garbage ~335 GiB, ~203 GiB margin, `gc.ttlseconds`
90000 (25 h) so the first ~15 hours of garbage was collected *during* the run.
Disk never became a problem.

---

## ▶ WHEN IT FINISHES — do these, in this order

> **HISTORICAL. All five steps were worked through on 2026-09-04.** What actually
> happened — including step 2 being deliberately deferred, and the log capture
> arriving after Kubernetes had already GC'd the first pod — is in "YOU ARE HERE"
> above. This is kept as the checklist a future one-shot Job should start from.

**1. Capture the logs BEFORE anything else.** There is no `ttlSecondsAfterFinished`,
so nothing deletes the Job on its own — but step 3 does, and it takes the pod and
its logs with it.

> ⚠️ **Necessary but not sufficient, learned the hard way.** Nothing deletes the
> *Job*, but Kubernetes garbage-collects individual *pods* on its own schedule
> while the Job sits `Complete`. On this run that took the first pod and 95% of
> the per-batch history before anyone got here. **Capture per-pod as the run goes
> — on every restart — not once at the end.** And use
> `kubectl logs -l job-name=<job> --tail=-1` per pod: `logs job/<name>` reads one
> pod of however many ran.

```bash
kubectl logs -n vprod job/gbv-messages-backfill > /tmp/backfill-prod-final.log
tail -5 /tmp/backfill-prod-final.log     # expect: DONE: reached the end of the table.
kubectl get job -n vprod gbv-messages-backfill -o json | \
  python3 -c "import json,sys; j=json.load(sys.stdin)['status']; print(j)"
```

Success looks like `DONE: reached the end of the table. N rows updated across M
batches.` and `1 succeeded, 0 failed`. Anything ending `STOPPED at --max-batches`
means it hit the safety stop rather than the table's end — see "If it stops
short" below.

> ⚠️ **`N` and `M` on that `DONE` line are the LAST POD's counters, not the
> run's.** This run ended `2903321 rows updated across 146 batches` and had
> actually done **106,931,189 rows across 5,351** — an under-report by **40x**.
> The cumulative totals live only in `chatroach.backfill_cursor` and in each
> pod's `RESUMING` line. Take the numbers from step 2, never from step 1.
> (`1 succeeded, 0 failed` is also not what success looked like: it was
> `1 succeeded, 3 failed`, all three node restarts.)

**2. Verify against the database, not the tool's output.** This project has been
burned by tools reporting success they did not achieve (`run-migration.sh`, see
`planning/conversation-identity.md` §5.2).

```sql
SELECT batches, rows_updated, done FROM chatroach.backfill_cursor;   -- done must be t
SELECT count(*) AS total, count(account_id) AS with_acct,
       count(*) - count(account_id) AS still_null
  FROM chatroach.messages;
```

`still_null` **will not be zero and should not be** — those are the permanently
unattributable rows. The real gate is migration 26 §4: rows still *attributable
but not yet attributed* must be **0**. It is the only one that proves completion.

> ⚠️ **On this run that gate was deliberately NOT run**, and completion rests on
> the cursor's `done=t` plus the pod-log reconciliation instead. The gate is a
> **399.3 GiB / 16,532-range** scan against an unlimited `statement_timeout`, on a
> cluster that restarted nodes under this Job three times. **Slice it over the
> `hsh` keyspace and sum**; schedule it. See "YOU ARE HERE" step 2.

**3. Disarm it.** `messagesBackfill.enabled: false` in
`devops/values/production.yaml`, then `helm upgrade gbv vlab -f
values/production.yaml -n vprod`. Helm prunes the Job. A one-shot must not be
left armed. (Re-enabling later would exit immediately with `ALREADY DONE`
anyway, because the cursor row records `done`.)

**4. Record the unattributable count — Phase 3.2 depends on it. DONE, and it was
18x the planned figure.** `SHOW STATISTICS FOR TABLE messages`:
`{account_id} | row_count 108,074,354 | null_count 54,960 | created 2026-09-03
15:47:18+00`. So **~55,000**, not the ~3,000
`planning/messages-account-not-null-todo.md` was written around — corroborated by
the bounded pass's independent ~48,800. **It is a statistics estimate, not an
exact count**; the exact number is what step 2's gate would give. That document
now leads with the correction and with what ~55,000 does to the sentinel pass
(batching becomes mandatory; `''` becomes a 55k-row population).

**5. Update the plans. DONE 2026-09-04.** `planning/multi-platform-plan.md` 1.5 →
DONE with the figures, its "Status" line, its "State of the world" table, and
`CLAUDE.md` § "Work Currently In Flight". Phase 1 is complete and **2.1 is
next** (`STRICT_EVENT_ENVELOPE` → true, gated on `CHAT_EVENTS_ENVELOPE_MISSING`
reading zero for 24h) — **but read 2.1's entry first: its recorded risk
assessment assumes WhatsApp is test-only, and WhatsApp is now 90% of live
conversations.**

Optionally drop the cursor row — but keeping it is free and is the only durable
record that this ran:

```sql
-- only if you want a clean slate; not required
DELETE FROM chatroach.backfill_cursor WHERE cursor_key = 'messages-account-backfill';
```

---

## ✖ IF SOMETHING GOES WRONG

**The pod died / restarted.** Nothing to do. `backoffLimit: 3` recreates it and
it resumes from `chatroach.backfill_cursor` automatically — verified in
production, three times over. Confirm with `kubectl get job` (`BACKOFF` count) and
check the new pod's log says `RESUMING from the stored cursor:`.

> ⚠️ **`backoffLimit: 3` was treated here as ample headroom. It was not — it was
> exact.** It permits four pods and exactly four ran (three `57P01 server is
> shutting down`, one success). A fourth failure would have marked the Job
> `Failed` **261 batches from the end**. Since resume is free and idempotent,
> **a future one-shot should set a far larger `backoffLimit`.** Also capture each
> failed pod's log at the moment it fails — see step 1 above.

**It exhausted `backoffLimit` (Job shows failed).** Read the last log lines for
the real error, then delete the Job and re-apply — it resumes. A Job's spec is
immutable, so any settings change needs the delete first:

```bash
kubectl logs -n vprod job/gbv-messages-backfill --tail=40
kubectl delete job gbv-messages-backfill -n vprod
helm upgrade gbv vlab -f values/production.yaml -n vprod
```

**Disk is running low.** The margin is ~203 GiB against ~335 GiB of projected
garbage, so this should not happen — but if `avail` drops below ~60 GiB on any
node, stop it: set `enabled: false` and `helm upgrade` (capture logs first). The
cursor holds the position, so restarting after GC catches up loses nothing.
`gc.ttlseconds` is 90000, so space returns ~25 h after the writes that made it.

**You need to stop it deliberately.** `enabled: false` + `helm upgrade`. It is
safe to kill at any point: each batch is one statement, so there is no
half-applied batch, and `AND account_id IS NULL` makes everything already done a
no-op on resume.

**You need to force a position.** `messagesBackfill.extraArgs:
["--start-hsh=<n>", "--start-userid=<s>"]` — explicit flags override the stored
cursor. Needed only to recover from something unusual; the stored cursor is
otherwise authoritative.

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

## The work — BUILT, SHIPPED AND VERIFIED. Reference only.

Everything in this section is done and merged. It is kept because the *reasoning*
is load-bearing — three of these decisions are non-obvious and each one is a trap
someone would otherwise re-open. Nothing here is an outstanding instruction.

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

## How it was started — historical, already done

Kept because it records what the sequence actually was, not because anything here
is outstanding. **All three steps are complete.** For anything you need to DO
now, use "YOU ARE HERE" and the runbooks at the top of this file instead.

```bash
# 1. the cursor table                              (applied to vprod 2026-08-26)
bash devops/run-migration.sh vprod devops/migrations/31-backfill-cursor.sql
# 2. publish the image                             (CI green, tag pushed)
git tag backfill-v0.1.0 && git push origin backfill-v0.1.0
# 3. arm it in the values file -- NOT --set        (revisions 651 then 652)
#    messagesBackfill.enabled: true
helm upgrade gbv vlab -f values/production.yaml -n vprod
```

It went in two passes: `maxBatches: 20` first, to measure committed writes
(revision 651), then `maxBatches: 20000` for the real run (revision 652). The
widening required deleting the completed bounded Job, because a Job's spec is
immutable.

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
