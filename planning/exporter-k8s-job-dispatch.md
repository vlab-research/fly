# Exporter: one Kubernetes Job per export, with a dispatcher and backpressure

**Status 2026-10-06: PROPOSED — nothing built.** Linear: VIR-92 (the client
ticket that surfaced it). Interim mitigation applied separately: exporter memory
request/limit and `WORKER_THREADS=2` in `devops/values/production.yaml`.

## Why

On 2026-10-05 three Kenya Girl Effect exports (two long-format `responses`, one
`full_messages` with raw JSON; ~526k responses, 10,227 users) were claimed by the
same exporter pod at once. The pod had no memory limit, its Python process grew
to ~3.8 GB and the node (`gke-toixo-bigpool-470b8568-2lka`) ran out of memory:

- 20:46 UTC the exporter was OOM-killed; all three jobs were left in their last
  status ("Formatting") with a lock that is only reclaimed after
  `STUCK_TIMEOUT_MINUTES` (120).
- 20:51 UTC `gbv-cockroachdb-1` and `-2`, on the same node, restarted.
- ~2 h later the jobs were reclaimed. One pod on a roomier node finished all
  three (long format alone fits in ~2–4.5 GB). The other pod on `2lka` was
  **evicted at 4.5 GB** and both cockroach replicas restarted a second time.

Three things failed, and none of them is pandas:

1. **Recovery** — a dead process's jobs wait 120 minutes. The only liveness
   signal is a lock timestamp that must outlast the longest export.
2. **Containment** — four worker threads share one process and one memory
   space; one oversized job kills its neighbours, and with no limit, the node.
3. **Backpressure** — nothing bounds how many large exports run at once, per
   pod or cluster-wide. Export pods also outrank nothing: under memory pressure
   cockroach lost to an export.

The goal is a process that **expects to die** and heals by construction, not a
fix tuned to this one incident.

## Options considered

| option | recovery | verdict |
|---|---|---|
| lease with long fixed timeout (today) | = longest job (2 h) | too slow |
| lease + heartbeat thread per job, `retry_count` as fencing token | ~2–3 min | good, ~40 lines; a hung worker keeps its lease forever |
| connection-scoped lock (`SKIP LOCKED` / advisory lock held for the job) | instant | ruled out on CockroachDB: no real advisory locks, long txns contend, the job's own status writes would block on its lock |
| startup sweep of jobs held by own pod name | seconds, in-place restarts only | doesn't cover eviction or node loss |
| **one Kubernetes Job per export + dispatcher** | seconds | **chosen** — Kubernetes owns supervision, retries and placement |
| Kafka / RQ / Celery | session timeout | still lease + heartbeat underneath, plus a dependency; `max.poll.interval.ms` must exceed the longest export |
| split exports into small leased chunks | per chunk | most robust, but a rewrite (pivot needs all rows) |

## Design

```
dashboard-server ──INSERT──▶ export_status (ledger)
                                   ▲   │
                    status updates │   │ poll every few seconds
                                   │   ▼
              export pod ◀──creates── dispatcher (Deployment)
         (run_one <id>, exits)         └─ lists Jobs by label export-id
```

The database and Kubernetes never talk directly. The **dispatcher** is a
level-triggered reconcile loop (the standard controller pattern): each pass it
reads ledger rows and existing Jobs and corrects the difference. It keeps no
state and is safe to kill at any point.

### Reconcile table

| ledger | Kubernetes | action |
|---|---|---|
| `Requested`, budget available | no Job | create Job `export-<id>-<attempt>`; row → `Dispatched` |
| `Requested`, budget exhausted | no Job | nothing (stays queued) |
| in progress | Job active | nothing |
| in progress | Job failed (backoffLimit exhausted) | row → `Failed`, `metadata.error` from pod status (e.g. `OOMKilled`) |
| in progress | Job succeeded, row not `Finished` | row → `Failed` ("exited without reporting") |
| in progress | no Job (deleted / TTL'd) | row → `Requested` |
| `Finished` / `Failed` | Job exists | nothing; `ttlSecondsAfterFinished` removes it |

The decision is a pure function, `reconcile(rows, jobs, budget) -> [actions]`;
the shell reads both sides and applies actions. The whole table is unit-testable
without a cluster.

**Idempotent dispatch:** Job names are deterministic and Kubernetes rejects a
duplicate name. A dispatcher that crashes between creating the Job and updating
the row gets `AlreadyExists` on the next pass and moves on. No lock or leader
election is needed.

### The export pod

`python -m exporter.run_one <export_id>`: one export, progress written to the
ledger as today, exit 0 on success and non-zero on failure. The claim loop,
threads, stuck-job sweep and `retry_count` bookkeeping go away.

### Retries belong to Kubernetes

- `backoffLimit` caps attempts; the Job controller retries within seconds with
  exponential backoff.
- `podFailurePolicy`:
  - `DisruptionTarget` (eviction, node drain) → `Ignore`: retried without
    consuming the budget.
  - exit 137 (OOM) → `Count` (retry).
  - exit 1 (our exception) → `FailJob`: don't retry a bug.
- The dispatcher surfaces the termination reason to the user instead of a frozen
  status.

### Backpressure

1. **The ledger is the queue.** The dispatcher creates Jobs only while active
   exports are under budget; everything else stays `Requested`. Queued work
   lives in the database, not as Pending pods.
   - Start with a **count budget** (e.g. 2 concurrent exports).
   - Later, a **size budget**: a cheap pre-dispatch count (responses for
     `responses`, messages for `full_messages`) sets the Job's memory request,
     and Jobs are admitted while the sum stays under a total (e.g. 10Gi). Needs
     measured memory-per-row first.
2. **Hard ceiling in Kubernetes**, independent of the dispatcher:
   - a low `PriorityClass` for export pods, so under pressure the scheduler
     evicts exports, never cockroach;
   - a `ResourceQuota` scoped to that priority class capping total export
     `requests.memory` (e.g. 12Gi);
   - per-pod memory request and limit, so the scheduler places each export
     only where it fits and a runaway is confined to its own pod.
3. **Visible queueing:** the dashboard shows `Queued (n ahead)`, so a waiting
   export doesn't look stuck and invite re-requests.

Backpressure also bounds load on CockroachDB: each large export is a heavy scan.

### Infrastructure (all in the exporter chart)

- ServiceAccount, Role (`batch/jobs`: create/get/list/delete; `pods`: get/list
  for termination reasons), RoleBinding.
- Job spec template (image, resources, `ttlSecondsAfterFinished`,
  `podFailurePolicy`, priority class) defined in chart values and handed to the
  dispatcher. The Jobs are created at runtime, but their shape lives in the repo.
- `PriorityClass` and `ResourceQuota`.
- The existing exporter Deployment becomes the dispatcher (a few MB of memory).
- `pullPolicy: IfNotPresent` with pinned tags. Under `Always`, every export
  start would depend on ghcr.io being reachable. Cached images make startup
  ~1 s plus Python imports; the first pull per node per release is ~10 s
  (545 MB).

## Out of scope

- **De-duplicating identical requests**: judged not worth the complexity.
- **Per-owner concurrency caps**: revisit if one researcher's backlog starves
  others.
- **Kueue / Argo / a custom `ExportRequest` resource**: the native answer at
  scale, overkill for one job type.
- **Streaming or Polars in `vlab_prepro`** (`vlab_prepro/planning/polars-migration-plan.md`):
  reduces memory per export, and is complementary. The plan describes a
  migration that is not in the code; only the dependency and the integration
  tests survive.

## Open questions

- Local development: run the dispatcher against kind, or give it an in-process
  executor for dev and tests?
- `Dispatched` as a new ledger status: does the dashboard's status rendering
  need changes?
- Budget defaults: measure peak memory per export type and size before choosing
  the count and quota numbers.
