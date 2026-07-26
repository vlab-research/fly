# CockroachDB: Topology Fix + Memory Reduction — Plan & Context

**Author of measurements:** session of 2026-07-26, read-only against prod via
port-forwarded SQL (`localhost:5432`) and `kubectl get/describe`.

**Status:** nothing in this document has been applied to production.

**Part 0 is written but NOT applied** (2026-07-26). The values change is staged on
branch `feature/cockroachdb-optimization` (off `main`) — the branch carrying this
whole work stream — together with
[`documentation/cockroachdb-topology.md`](../documentation/cockroachdb-topology.md),
which is now the runbook of record for it. Helm rendering was verified locally;
the diff against the current pod template is *only* the anti-affinity block.
Part 0 remains an open production availability risk until it is applied.

**New here?** The entry point for all CockroachDB size/cost/memory work is
[`documentation/cockroachdb-storage.md`](../documentation/cockroachdb-storage.md) —
it's the measured ground truth and maps out these documents. This plan carries the
**overall priority order** across all of them (below).

**Relationship to the other documents:**

- [`documentation/cockroachdb-storage.md`](../documentation/cockroachdb-storage.md) —
  **reference / ground truth.** Cluster shape, table and index sizes, and the true
  `messages` access pattern. Start there; this plan assumes those facts.
- [`cockroachdb-cost-reduction-plan.md`](./cockroachdb-cost-reduction-plan.md) —
  attacks **disk** via index drops. Still valid; this doc reframes *why* it
  matters (replica count, not gigabytes) and corrects several of its claims.
- [`cockroachdb-operator-and-v25-v26-migration.md`](./cockroachdb-operator-and-v25-v26-migration.md) —
  operator adoption + version upgrades. Its **Phase 1 (raise `cache` to 7Gi,
  `max-sql-memory` to 6Gi) is cancelled** — see Part 3. Its Phase 5 (value
  separation) is the linchpin of the memory target.

> **IaC rule applies.** Per `CLAUDE.md`, nothing here is applied by hand.
> Helm changes go in `devops/values/production.yaml`; database changes go in a
> numbered `devops/migrations/NN-*.sql` and are applied with
> `./devops/run-prod-migration.sh`. Reading live state to diagnose is fine.

---

## Priority order

| # | Action | Gate | Why |
|---|---|---|---|
| **0** | **Fix CRDB replica co-location** | none — do first | Live quorum-loss risk |
| 1 | `SELECT content` PR in `chatbase-postgres` | none | Removes an index join; unblocks 2 |
| 2 | Migration 19 (drop `messages_userid_idx` canary) | 0 | −2,916 ranges |
| 3 | Zone config → 512 MiB ranges, as a migration | 2 | −13× replicas: the big memory win |
| 4 | Tier 1b `states` index cleanup | independent | Write path |
| 5 | Re-measure RSS; set `cache` from evidence | 3, 4 | Don't guess the number |
| 6 | Operator → v25.4 → value separation | 5 | Makes a small cache viable |
| 7 | `8000Mi` → `~4000Mi`, then `e2-highmem-4` → `e2-standard-4` | 6 soaked | The actual bill |

Steps 0–4 need no version upgrade and no new infrastructure.

---

# Part 0 — URGENT: two CockroachDB replicas share one physical node

## Evidence

```
$ kubectl get pods -A -o custom-columns=NODE:.spec.nodeName,...

gke-...-ijmm   vprod   gbv-cockroachdb-1   8000Mi
gke-...-ijmm   vprod   gbv-cockroachdb-3   8000Mi     ← same GKE node
gke-...-hhtr   (no cockroachdb pod at all)
```

Two of the four production database pods are on GKE node `ijmm`. Node `hhtr`
has none. This is why `ijmm` sits at 74% memory requests while `hhtr` is at 23%.

Both guards that should have prevented this are absent:

**1. Anti-affinity is soft.** The chart default is
`statefulset.podAntiAffinity.type: soft`, which renders as
`preferredDuringSchedulingIgnoredDuringExecution`. The scheduler tried to spread
and was not obliged to. `IgnoredDuringExecution` also means it will never
self-correct once placed.

```
$ kubectl -n vprod get sts gbv-cockroachdb -o jsonpath='{...affinity}'
podAntiAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
  - weight: 100
    podAffinityTerm: {topologyKey: kubernetes.io/hostname, ...}
```

**2. CockroachDB has no locality information.**

```sql
SELECT node_id, address, locality FROM crdb_internal.kv_node_status;
-- locality is "" on all four nodes
```

No `--locality` flag is set, so the allocator treats all 4 CRDB nodes as
independent failure domains. It has no way to know that CRDB nodes 3 and 4
(`gbv-cockroachdb-1` and `gbv-cockroachdb-3`) share a machine, and will freely
place 2 of 3 replicas on that pair.

**3. `topologySpreadConstraints` is a no-op here.** The chart defaults to
`topologyKey: topology.kubernetes.io/zone` with
`whenUnsatisfiable: ScheduleAnyway`. All four nodes are in **`europe-west1-b`** —
a single zone — so the constraint is trivially satisfied and does nothing.

## Why this matters

With 4 CRDB nodes at RF3, a range's replica set is 3 of 4. Of the four possible
sets — `{1,2,3} {1,2,4} {1,3,4} {2,3,4}` — **two contain both node 3 and node 4**.

So roughly **half of the cluster's ~11,800 ranges (~5,900) cannot survive the
loss of GKE node `ijmm`.** Losing it means losing 2 of 3 replicas for those
ranges: quorum loss, unavailable ranges, and recovery only via
`cockroach debug unsafe-remove-dead-replicas` with data-loss risk.

The nodes are 22 days old, so this has been the live configuration for at least
that long. It is invisible in normal operation and only manifests during exactly
the event the cluster exists to survive.

## The fix

Set hard anti-affinity in `devops/values/production.yaml`:

```yaml
cockroachdb:
  statefulset:
    podAntiAffinity:
      topologyKey: kubernetes.io/hostname
      type: hard        # was: soft (chart default)
```

Then `helm upgrade gbv vlab -f values/production.yaml -n vprod`.

Staged on `feature/cockroachdb-optimization`; the full runbook, trade-offs and
verified preconditions now live in
[`documentation/cockroachdb-topology.md`](../documentation/cockroachdb-topology.md).

### Do NOT try to fix this with `conf.locality`

The chart templates locality as a single static string:

```
statefulset.yaml:215   {{- with .Values.conf.locality }}
statefulset.yaml:216     --locality={{ . }}
```

One value for all pods. Every node would report *identical* locality, which
tells the allocator nothing about failure domains — it would be cosmetic at
best and actively misleading at worst. Per-pod locality needs a downward-API
injection the chart does not support. **Hard anti-affinity is the correct and
sufficient fix**; revisit locality only during the operator migration, where
per-node config is first-class.

### Applying it — important operational notes

- **CORRECTED 2026-07-26: the helm upgrade is itself a rolling restart of the
  database, and no manual pod delete is needed.** The earlier claim here — that
  the upgrade moves nothing because anti-affinity is `IgnoredDuringExecution` —
  was wrong. Adding affinity changes the *pod template*, and the StatefulSet's
  `updateStrategy` is `RollingUpdate` (verified live), so all four pods are
  recreated one at a time in descending ordinal order (3 → 2 → 1 → 0), each
  waited on for Ready. Each recreation re-schedules under the new hard
  constraint, so pod 3 lands on `hhtr` on its own. Plan for tens of minutes
  (`terminationGracePeriodSeconds: 300` plus rejoin and catch-up per pod) and
  run it outside a traffic peak — this is a bigger operation than a values tweak,
  though it is safe at RF3 since only one pod is ever down.
- **PVCs are fine.** `pd-ssd` is zonal and all four nodes are in
  `europe-west1-b`, so `datadir-gbv-cockroachdb-3` can attach on `hhtr`.
- **Wait for zero under-replicated ranges before touching anything else.**
- **Known trade-off of `hard`:** if a GKE node goes down, its CRDB pod cannot be
  rescheduled (every remaining node already has one) and stays `Pending` until
  the node returns. This is *correct* for RF3 — the cluster tolerates one node
  down — but it does mean no automatic recovery onto a spare. Document it so
  nobody "fixes" it back to `soft` during an incident.
- **This is a hard precondition for the 4→3 node consolidation** in the cost
  plan's Tier 4. You cannot safely shrink to 3 nodes while the scheduler is free
  to stack two databases on one machine.

## Verification

```sql
-- After the reschedule: confirm even distribution and no under-replication
SELECT node_id, round((metrics->>'replicas')::float,0) AS replicas
FROM crdb_internal.kv_store_status ORDER BY node_id;
```

```bash
kubectl get pods -n vprod -o wide | grep cockroachdb   # 4 distinct nodes
```

Also check the DB Console **Replication** dashboard for under-replicated ranges
returning to zero.

---

# Part 1 — The memory picture (measured 2026-07-26)

Per-node, from `crdb_internal.kv_node_status` and `kv_store_status`:

| Node | RSS | Go heap | cgo (Pebble cache) | SQL mem in use | Replicas | Cache hit |
|---|---|---|---|---|---|---|
| 1 | 7.22 GiB | 0.86 | 3.64 | 3.4 MiB | 8,643 | 81.8% |
| 2 | **7.89 GiB** | 1.85 | 3.66 | 3.4 MiB | 8,639 | 81.4% |
| 3 | 7.74 GiB | 1.65 | 3.66 | 3.6 MiB | 9,060 | 75.0% |
| 4 | 7.57 GiB | 1.07 | 3.66 | 3.7 MiB | 9,061 | 78.4% |

Read-amplification is 5 on every store; memtables are 64 MiB.

### Three conclusions

**`max-sql-memory` is irrelevant.** Budgeted `3000Mi`, actually using **3.5 MiB**
— 0.1%. It is a ceiling, not an allocation, so it costs nothing today; but the
operator plan's proposal to raise it to `6Gi` buys literally nothing. Drop it.

**RSS decomposes into one fixed and two steerable parts:**

```
RSS 7.7 GiB  =  3.66 GiB  Pebble block cache (cgo, preallocated by `cache: 3500Mi`)
             +  ~1.5 GiB  Go heap — scales with REPLICA COUNT
             +  ~2.5 GiB  Go runtime, stacks, fragmentation, memtables
```

Only the cache and the replica-count-driven heap are reducible. Note the heap
varies 0.86 → 1.85 GiB across nodes holding identical data — that spread tracks
replica count and churn, not data volume.

**Pod 2 is over its request.** RSS 7.89 GiB against an `8000Mi` (7.81 GiB)
request. No `limits` are set in `production.yaml`, so nothing is OOMKilled, but
the scheduler is packing against a number the process already exceeds.

### The disk → memory link

Disk and memory are not 1:1, but they are coupled through **replica count**, not
bytes. This is the correct framing for the whole cost-reduction effort: every
index dropped removes ranges, every range removed removes 3 replicas spread
across the cluster, and replica count is what inflates the Go heap and the Raft
tick load. **Measure the index work in replicas, not gigabytes.**

---

# Part 2 — The `range_max_bytes` fossil (largest free win)

## Evidence

Every zone in the cluster, `RANGE default` included:

```
range_min_bytes = 16777216    (16 MiB)
range_max_bytes = 67108864    (64 MiB)
```

**That is the pre-v21.1 CockroachDB default.** The project raised it to
512 MiB / 128 MiB in v21.1. Zone configs are persisted data, not defaults, so
this cluster carried its birth settings through every upgrade including the
recent v21.2 → v24.1 recovery. Nothing in `devops/` sets these values — confirmed
by grep — so it is purely an artifact of cluster age.

The ranges are pinned against that ceiling:

```sql
SELECT round(avg(range_size)/1024/1024,1) avg_mib,
       round(max(range_size)/1024/1024,1) max_mib, count(*)
FROM [SHOW RANGES FROM DATABASE chatroach WITH DETAILS];
--  avg 42.4 MiB | max exactly 64.0 MiB | 10,450 ranges
```

Cluster-wide: **11,801 ranges → 35,403 replicas → ~8,850 replicas per node.**

CockroachDB's practical guidance puts the ceiling near 10,000 replicas per node.
**This cluster is at ~88% of that, on 4 vCPU nodes, for 432 GiB of data.**

## Impact

Every replica carries a `Replica` struct, Raft group state, and a periodic tick.

| Stage | Ranges | Replicas/node |
|---|---|---|
| Today | 11,801 | ~8,850 |
| After migration 19 | ~8,885 | ~6,660 |
| After 512 MiB range size | ~900 | **~675** |

A ~13× reduction. That is Go heap, Raft tick CPU, allocator and rebalancer work,
and range descriptor cache pressure all falling together — on nodes with only
4 vCPU, where CPU limits are already oversubscribed to 109–181%.

## How to apply

As a numbered migration (IaC rule — not an ad-hoc `CONFIGURE ZONE`):

```sql
-- devops/migrations/NN-raise-range-size.sql
ALTER RANGE default CONFIGURE ZONE USING
  range_min_bytes = 134217728,   -- 128 MiB
  range_max_bytes = 536870912;   -- 512 MiB
```

Then repeat for any zone that overrides it — `DATABASE system`, `RANGE meta`,
`RANGE liveness`, `RANGE system`, and the `system.public.*` table zones all carry
explicit 64 MiB values. Check with:

```sql
SELECT target, raw_config_sql FROM crdb_internal.zones WHERE raw_config_sql IS NOT NULL;
```

**Leave the system ranges alone on the first pass.** They are small, `num_replicas = 5`,
and carry the cluster's own metadata; the win is entirely in `RANGE default`
(which `chatroach` inherits). Revisit system zones only if measurement justifies it.

## Sequencing and caveats

- **Do this AFTER migration 19.** Merging ranges that belong to an index you are
  about to drop is wasted I/O, and the merge runs over ~290 GiB instead of 432 GiB.
- **Merging is background I/O.** The merge queue will steadily combine ranges
  under `range_min_bytes`. Expect elevated compaction activity for hours to days.
  Start it outside a traffic peak and watch read-amp and p99 latency.
- **This is gradual and safe, not a cutover.** Nothing rewrites at once.
- **It is reversible** by setting the values back, though ranges will not
  re-split without load pressure.

## Verification

```sql
-- Range and replica counts should fall steadily over the following days
SELECT count(*) FROM [SHOW RANGES FROM DATABASE chatroach];
SELECT node_id, round((metrics->>'replicas')::float,0) FROM crdb_internal.kv_store_status;
-- Average range size should climb toward 512 MiB
SELECT round(avg(range_size)/1024/1024,1) FROM [SHOW RANGES FROM DATABASE chatroach WITH DETAILS];
```

Watch Go heap (`sys.go.allocbytes`) fall alongside it — that is the memory payoff.

---

# Part 3 — What actually sizes this cluster

## The GKE inventory

The **entire** GKE cluster is 4 × `e2-highmem-4` (4 vCPU / 32 GB), all in
`europe-west1-b`, all in one pool named `bigpool`. Allocatable per node:
**3920m CPU, ~27.7 GiB memory**.

Memory *requests*:

| Node | Requests | % | Notable pods |
|---|---|---|---|
| hhtr | 6,670Mi | 23% | kafka-1, **no CRDB** |
| hkwa | 10,595Mi | 37% | crdb-2, minio, prometheus |
| ijmm | 21,206Mi | **74%** | crdb-1 + crdb-3 + kafka-2 |
| xof0 | 14,980Mi | 52% | crdb-0, kafka-0, vstag crdb |

**Total ≈ 52.2 GiB requested of ~110.9 GiB allocatable (47%).** Of that 52.2 GiB:

- **Prod CockroachDB: 31.25 GiB — 60% of every memory request in the cluster**
- Kafka: 12 GiB — 23%
- Everything else combined: ~9 GiB — 17%

CPU is not binding: 6,712m requested of 15,680m allocatable (43%).

**Conclusion: CockroachDB memory is what forces `highmem`.** This answers the
question the cost plan left open — shrinking the CRDB pod is directly a
machine-type lever, not just headroom.

## The target

`e2-highmem-4` → `e2-standard-4` is the same 4 vCPU with 16 GB instead of 32 GB.

- 4 × `e2-standard-4` ≈ **51 GiB allocatable** (verify — GKE reserves vary)
- Current requests: 52.2 GiB → **does not fit**
- With CRDB at `4000Mi`/pod: **36.6 GiB → fits with real headroom**

**The entire cost play reduces to one number: getting the CRDB pod from `8000Mi`
to ~`4000Mi`.** That halves the RAM on every node in the cluster.

## Is 4 GiB reachable?

Today: `3.66 cache + ~1.5 heap + ~2.5 runtime = 7.7 GiB`. The path:

| Lever | Effect |
|---|---|
| Part 2 (512 MiB ranges) | heap ~1.5 → ~0.5 GiB |
| Migration 19 + Tier 1b | fewer ranges again; smaller working set |
| Value separation (v25.4) | makes `cache: 1500Mi` viable without losing hit rate |

Landing near **4–4.5 GiB**. Tight, but each step is independently measurable —
which is why step 5 in the priority table is "re-measure, then choose", not
"set 4000Mi and hope".

## Why the operator plan's Phase 1 must be dropped

It proposes `cache: 3500Mi → 7Gi` and `max-sql-memory: 3000Mi → 6Gi`, pushing RSS
to ~12 GiB. That is a latency play in direct opposition to the cost goal, and the
`max-sql-memory` half is pure no-op given 0.1% utilization.

There is a real tension to respect, though: the block cache hit rate is only
**75–82%**. You cannot simply cut the cache without paying in disk reads. The way
out is to make the cache *more effective* rather than larger — which is Part 4.

---

# Part 4 — What newer CockroachDB versions actually buy (memory terms)

## Value separation (v25.4) is a bigger memory story than a disk story

Confirmed absent in v24.1 — there is no `storage.value_separation.*` cluster
setting on the running cluster, so this genuinely requires the upgrade.

Today the large `content` (raw event JSON) column lives inline in sstables. The
block cache caches sstable blocks, so **every cached block drags JSON payload
along with it** — the 3.5 GiB cache is mostly holding blob bytes that a keyed,
ordered scan doesn't need until the final projection. With values ≥256B split
into separate blob files, keys and small values pack into compact sstables and
the same 3.5 GiB caches far more *keys*.

For this workload — whose hot path is a keyed ordered scan over
`(userid, timestamp)` — that is a large effective-cache multiplier. **It is the
thing that makes cutting `cache` possible without surrendering hit rate**, and
therefore the linchpin of the `8000Mi → 4000Mi` target.

Secondary: ~50% less write amplification → less compaction churn and CPU, which
matters on 4 vCPU nodes already carrying read-amp 5.

⚠️ **Verify before planning around it.** The 256B threshold, default-on behavior,
and GA-in-v25.4 claim are inherited from the operator plan and were not
independently confirmed in this session. Read the v25.4 release notes first.

## Everything else is second-order

Admission-control maturity and tighter SQL memory accounting across v24.3 → v25.x
are real improvements, but largely irrelevant here given SQL memory runs at 0.1%
utilization. **Treat value separation as the sole version-driven memory
justification** — it is strong enough on its own, and pretending the others
matter will just make the upgrade case harder to defend.

---

# Corrections to `cockroachdb-cost-reduction-plan.md`

Verified against prod this session; fix these before the next agent acts on them.

**1. "No sort node" is wrong for the real query.** The plan's soak checklist says
to verify the hot path has no `sort`. It does have one. `Chatbase.get()`
(`chatbase-postgres/lib/index.js:21-37`) is not the simplified query the plan
records — it LEFT JOINs `states` for `message_pointer`:

```sql
SELECT * FROM messages
LEFT JOIN (SELECT userid, message_pointer FROM states WHERE userid = $1) USING (userid)
WHERE userid = $1
AND (message_pointer IS NULL OR message_pointer <= timestamp)
ORDER BY TIMESTAMP ASC
```

The merge join on `userid` destroys timestamp ordering, so `ORDER BY` needs an
explicit sort. **This is not a reason to abort Phase 2** — `messages_userid_idx`
is keyed `(userid, hsh)` and would sort too, no better. Just fix the checklist.

**2. The index join fetches a column the app discards.** `SELECT *` pulls `id`,
which lives only in `primary` — that is the entire reason for the index join,
since `content` is already stored in `messages_userid_timestamp_idx`. And `get()`
ends with `result.rows.map(r => r.content)`. Verified by `EXPLAIN`: the
`SELECT content` variant drops the index join completely.

**3. The optimizer is actively recommending you recreate the canary.** `EXPLAIN`
on the current query emits:

```
index recommendations: 1
1. CREATE INDEX ON chatroach.public.messages (userid) STORING (id, content, "timestamp");
```

That is exactly `messages_userid_idx`. **Ship the `SELECT content` PR before
migration 19**, or CockroachDB will keep recommending the index you just dropped
and the next person to read the console will treat it as evidence of a mistake.

**4. Tier 2's checkpointing item is half-wrong — and cheaper than described.**
The plan says recompute "replays a user's entire history from zero and ignores
the already-persisted `states` table." It does not. `states.message_pointer` is a
stored computed column off `state_json->>'pointer'`
(`devops/migrations/04-pointers.sql`) and the query already truncates replay at
it. The real limitation is narrower: `pointer` only advances on `RESET`,
`RESTORE_STATE`, and `USER_BLOCKED`
(`replybot/lib/typewheels/machine.js:249,314,400`). So there is a working
truncation mechanism to *extend with periodic checkpoints*, not one to build.

**5. Tier 4's `3 × ~50Gi` target does not follow from the index work.** Post-
migration-19 the cluster is ~290 GiB physical; over 3 nodes that is ~96 GiB/node
before headroom. The plan is internally consistent — it says "after the working
set drops to tens of GB" — but that precondition is **Tier 3 archival**, not
Phase 2. Worth stating explicitly so nobody sizes PVCs off the wrong milestone.

**6. Phase 1 is verified complete and healthy.** Both timestamp indexes are gone;
`messages_userid_idx` shows `visible: false`. Each remaining index is 126.2 GiB
(`messages` total 378.6 GiB, database 432.2 GiB). Physical usage is
**98.7 / 98.2 / 105.0 / 105.4 GiB** per store — down from ~596 GB on 07-22, so GC
has fully settled. **Migration 19 is clear to run** once Part 0 is done.

---

# Verification cookbook

Connect via port-forward to `localhost:5432`, or
`kubectl -n vprod exec gbv-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach`.

```sql
-- Memory + replica load per node
SELECT node_id,
  round((metrics->>'sys.rss')::float/1024/1024/1024,2)          AS rss_gib,
  round((metrics->>'sys.go.allocbytes')::float/1024/1024/1024,2) AS go_heap_gib,
  round((metrics->>'sys.cgo.allocbytes')::float/1024/1024/1024,2) AS cache_gib,
  round((metrics->>'sql.mem.root.current')::float/1024/1024,1)  AS sql_mem_mib
FROM crdb_internal.kv_node_status ORDER BY node_id;

SELECT node_id,
  round((metrics->>'replicas')::float,0)              AS replicas,
  round((metrics->>'replicas.leaseholders')::float,0) AS leaseholders,
  round((metrics->>'rocksdb.block.cache.hits')::float
        /nullif((metrics->>'rocksdb.block.cache.hits')::float
               +(metrics->>'rocksdb.block.cache.misses')::float,0)*100,2) AS cache_hit_pct,
  round((metrics->>'rocksdb.read-amplification')::float,1) AS read_amp,
  round((metrics->>'capacity.used')::float/1024/1024/1024,1) AS used_gib
FROM crdb_internal.kv_store_status ORDER BY node_id;

-- Topology: locality must be non-empty (or anti-affinity must be hard)
SELECT node_id, address, locality FROM crdb_internal.kv_node_status ORDER BY node_id;

-- Range size distribution (the Part 2 metric)
SELECT round(avg(range_size)/1024/1024,1) AS avg_mib,
       round(max(range_size)/1024/1024,1) AS max_mib, count(*) AS ranges
FROM [SHOW RANGES FROM DATABASE chatroach WITH DETAILS];

-- Per-index size
SELECT index_name, count(*) AS ranges, round(sum(range_size)/1024.0/1024/1024,1) AS gib
FROM [SHOW RANGES FROM TABLE chatroach.public.messages WITH INDEXES, DETAILS]
GROUP BY index_name ORDER BY gib DESC;

-- Zone configs (Part 2 evidence)
SELECT target, raw_config_sql FROM crdb_internal.zones WHERE raw_config_sql IS NOT NULL;
```

```bash
kubectl get pods -n vprod -o wide | grep cockroachdb      # must be 4 distinct nodes
kubectl get nodes -L cloud.google.com/gke-nodepool,node.kubernetes.io/instance-type
kubectl describe node <name> | sed -n '/Allocated resources/,/Events/p'
```

---

# Open questions for the next agent

1. **Verify v25.4 value separation specifics** against release notes — threshold,
   default-on, GA status. The whole memory-shrink case leans on it.
2. **Confirm `e2-standard-4` allocatable memory** on this GKE version before
   committing to the machine-type change. ~12.7 GiB/node is an estimate.
3. **Kafka is 23% of cluster memory requests** (3 × 4Gi) and was not examined.
   After CRDB shrinks it becomes the largest single consumer. Worth a look before
   sizing the new pool.
4. **All four nodes are in a single zone (`europe-west1-b`).** Independent of the
   Part 0 fix, the cluster cannot survive a zone failure. Out of scope here, but
   it should be a conscious decision rather than an accident.
5. **`vstag` CockroachDB shares `bigpool`** (`gbv-cockroachdb-0`, 500Mi, on
   `xof0`). Minor, but it means staging and production compete for the same nodes.
6. **`messages` table stats are 162 days old** (collected 2026-02-14 at 101.1M
   rows). Auto-collection is enabled but `fraction_stale_rows = 0.2` means ~20M
   row changes are needed to retrigger on a table this size — expected behavior,
   not a bug. Consider a manual `CREATE STATISTICS` before running verification
   `EXPLAIN`s so plans reflect reality rather than a forecast.
