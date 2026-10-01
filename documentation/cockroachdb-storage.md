# CockroachDB Storage & Cost Reduction

**👉 START HERE** — this is the entry point for anything touching the production
CockroachDB cluster's size, cost, memory, or topology. Read this first, then follow
the map below to the plan you need.

## The four documents

| Document | What it is | Read it when |
|---|---|---|
| **this doc** (`documentation/cockroachdb-storage.md`) | **Reference / ground truth.** Measured cluster shape, table and index sizes, how `messages` is actually accessed. Durable facts, not a task list. | Always, first |
| [`planning/cockroachdb-memory-and-topology-plan.md`](../planning/cockroachdb-memory-and-topology-plan.md) | 🔴 **Live availability risk** (two CRDB pods on one GKE node) + the **memory** reduction plan. Contains the overall priority order across all this work. | Before *any* cluster change |
| [`planning/cockroachdb-cost-reduction-plan.md`](../planning/cockroachdb-cost-reduction-plan.md) | The **disk / index-drop** work log. Tier 1 (`messages`), Tier 1b (`states`), Tier 2–4. Tracks what's applied. | Doing index work |
| [`planning/cockroachdb-operator-and-v25-v26-migration.md`](../planning/cockroachdb-operator-and-v25-v26-migration.md) | Operator adoption + v25.4/v26 upgrades. **Its Phase 1 is cancelled.** | Planning upgrades |

**If you only read one other thing:** the memory/topology plan. It has the current
priority order, and its Part 0 is an open production risk.

> ⚠️ **Despite the filename, this doc is not only about disk.** The cluster's binding
> cost constraint is **memory** — CockroachDB is 60% of all memory requests in the GKE
> cluster. Disk and memory are coupled through **replica count**, not bytes: every
> index dropped removes ranges, and replica count is what drives the Go heap.

## Current state — measured 2026-10-01

The sections below this one are the July 2026 measurements. They remain the
reasoning of record, but several numbers have moved, mostly because of the
conversation-identity migration (`planning/multi-platform-plan.md`), which
added an account-scoped index to `messages` and backfilled `account_id` into
~107M rows.

| | July 2026 | 2026-10-01 |
|---|---|---|
| CRDB version | v24.1.28 | v24.1.28 |
| `messages` indexes | `primary`, `userid_timestamp`, `userid` (NOT VISIBLE) | `primary`, `userid_account_timestamp`, `userid_timestamp` (**NOT VISIBLE** — migration 29 drops it) |
| Ranges, cluster-wide | 11,801 | **19,768** (`messages` 16,617) |
| Replicas per node | ~8,850 | **14,490–15,191** |
| RSS per pod (`sys.rss`) | 7.22–7.89 GiB | **7.94–8.15 GiB** — all four over the `8000Mi` (7.81 GiB) request |
| Go heap per pod | 0.86–1.85 GiB | 1.24–3.38 GiB |
| Block cache hit rate | 75–82% | 84–91% |
| Physical used per store | 98–105 GiB | 108–112 GiB of 240Gi |
| Pod placement | two pods on one node | four distinct nodes, by chance — anti-affinity is still `soft` live |

What happened to `messages`:

- Migration 19 (drop `messages_userid_idx`) ran on production 2026-08-25.
- Migration 26 built `messages_userid_account_timestamp_idx` and made
  `messages_userid_timestamp_idx` NOT VISIBLE. The replay read now uses the
  account-scoped index. Migration 29 drops the retired one; it has been applied
  on staging, **not production**. Until it runs, `content` is stored 3× on
  production.
- `SELECT *` → `SELECT content` shipped (replybot v0.0.221). The replay query
  now lives in `replybot/lib/chatbase/chatbase.js`, not the external
  `chatbase-postgres` package.
- Migration 30 sets an explicit **table-level** zone on `messages` at
  `range_max_bytes = 64 MiB`. Raising `RANGE default` alone no longer reaches
  `messages`; see the range-size section of the memory plan.

Replica count is the number to watch. It grew ~70% since July, the Go heap grew
with it, and it sits ~50% above CockroachDB's practical ~10,000-per-node
guidance on 4-vCPU nodes.

> `kubectl top pod` reports 9.3–11.6 GiB for these pods. That is the cgroup
> working set, which includes page cache. Use `sys.rss` from
> `crdb_internal.kv_node_status` for the process's own memory.


---

How storage is distributed across the production CockroachDB cluster, why the
`messages` table dominates it, and the roadmap for shrinking the cluster (and the
GKE compute pool sized around it). Originally measured `2026-07-22`; **storage
numbers re-measured `2026-07-26` after Tier 1 Phase 1 was applied.** CRDB `v24.1.28`.

## Cluster shape

- StatefulSet `gbv-cockroachdb`, 4 pods, namespace `vprod`.
- Each pod on a `240Gi pd-ssd` PVC. **Post-Phase-1 physical usage: 98.7 / 98.2 /
  105.0 / 105.4 GiB per store** (~407 GiB total, down from ~596 GB pre-Phase-1).
- Replication factor **3** (`SHOW ZONE CONFIGURATION FROM RANGE default`), GC TTL
  `gc.ttlseconds = 90000` (25h). Logical (per `SHOW RANGES`) is now **432.2 GiB** for
  the `chatroach` database.
- Per-pod flags: `--cache=3500Mi --max-sql-memory=3000Mi`; memory request `8000Mi`.
  Actual RSS is 7.2–7.9 GiB — see the memory plan; `max-sql-memory` runs at 0.1%
  utilization and is not a useful dial.
- **Range size is a pre-v21.1 fossil:** every zone carries
  `range_max_bytes = 67108864` (64 MiB) instead of the modern 512 MiB default, giving
  11,801 ranges / **~8,850 replicas per node**. This is the dominant memory problem
  and is covered in the memory plan, not here.
- All 4 pods run on the `bigpool` node pool (4 nodes × `e2-highmem-4`, 4 vCPU / 32GB,
  all in `europe-west1-b`). CockroachDB is **60% of all memory requests in the
  cluster** — the pool is sized around it.
- ⚠️ **Two CRDB pods (`gbv-cockroachdb-1` and `-3`) currently share one GKE node.**
  Anti-affinity is `soft` and CRDB locality is unset. See the memory/topology plan.

## Storage breakdown (logical, uncompressed)

Re-measured `2026-07-26`, **after** Tier 1 Phase 1:

| Table | Size | Share | Notes |
|---|---|---|---|
| `messages` | 378.6 GiB | ~88% | Append-only event log (`chatroach` db) |
| `responses` | 38.6 GiB | ~9% | Survey responses |
| `states` | 11.1 GiB | ~3% | Computed participant state |
| `chat_log` | 2.9 GiB | — | Curated chat log (separate from `messages`) |
| everything else | <1 GiB | — | users, surveys, credentials, templates… |
| **database total** | **432.2 GiB** | | |

Pre-Phase-1 these were ~624 GB / ~37 GB / ~10.5 GB against a ~672 GB total.

`messages` is the entire cost story. Schema: `devops/migrations/01-init.sql:17-27`.

## Why `messages` is so large: index amplification

`messages` stores the big `content` (raw event JSON) column, and **every secondary
index `STORES content`** — so each index is a near-full copy of the table. Measured
per-index size and read counts (`SHOW RANGES ... WITH DETAILS, INDEXES` +
`crdb_internal.index_usage_statistics`):

| Index | Key order | Size | Reads | Role | Status |
|---|---|---|---|---|---|
| `primary` `(hsh, userid)` | — | 126.2 GiB | 15,889 | Insert dedup (`ON CONFLICT`) — **keep** | live |
| `messages_userid_timestamp_idx` STORING `(content)` | `(userid, ts, hsh)` | 126.2 GiB | 34* | Hot read path — **keep** | live |
| `messages_userid_idx` STORING `(content, ts)` | `(userid, hsh)` | 126.2 GiB | 128,951* | Sibling — **drop** | `NOT VISIBLE` (canary) |
| `messages_timestamp_idx` STORING `(content)` | `(ts ASC, hsh, userid)` | ~131.6 GiB | 25 | Scratch replay only | **dropped 07-22** |
| `messages_timestamp_idx1` STORING `(content)` | `(ts DESC, hsh, userid)` | ~131.6 GiB | 6 | Scratch replay only | **dropped 07-22** |

`content` was stored **5×**; it is now stored 3× (2× after Phase 2). Sizes re-measured
`2026-07-26`; the ~131.6 GiB figures are the original pre-drop measurements.
`messages_timestamp_idx1` is not in `01-init.sql` — added by a later change; the
authoritative list is `SHOW INDEXES FROM messages`.

**Which userid index to keep** — keep `messages_userid_timestamp_idx`, drop
`messages_userid_idx`. But note the reasoning below, which corrects an earlier version
of this doc.

> ⚠️ **Correction (verified 2026-07-26): the hot path does NOT run without a sort.**
> An earlier version of this doc claimed `messages_userid_timestamp_idx` gives a plain
> scan with no sort. That was `EXPLAIN`ed against a *simplified* query. The real
> `Chatbase.get()` (`chatbase-postgres/lib/index.js:21-37`) joins `states` for the
> replay checkpoint:
>
> ```sql
> SELECT * FROM messages
> LEFT JOIN (SELECT userid, message_pointer FROM states WHERE userid = $1) USING (userid)
> WHERE userid = $1
> AND (message_pointer IS NULL OR message_pointer <= timestamp)
> ORDER BY TIMESTAMP ASC
> ```
>
> The merge join on `userid` destroys the timestamp ordering, so `ORDER BY` needs an
> explicit `sort` node. **This does not change the decision**: `messages_userid_idx` is
> keyed `(userid, hsh)` and would sort too, no better. Keep `userid_timestamp` because
> it is the optimizer's choice and the better key order — not because it avoids a sort.
> Any soak checklist that says "verify no sort node" is wrong and will fail.

The 128,951 reads on `userid_idx` are cumulative and the stats were 158 days stale; the
current optimizer prefers `userid_timestamp`, more strongly as a user accumulates rows.

**Neither secondary index is covering for `SELECT *`,** because `id` lives only in
`primary` — so the plan does an `index join` back to `primary` purely to fetch `id`.
And `Chatbase.get()` ends with `result.rows.map(r => r.content)`: **`id` is discarded.**
`EXPLAIN`-verified 2026-07-26 — changing `SELECT *` to `SELECT content` removes the
index join entirely. This is a one-line Tier 2 change and should ship **before**
Phase 2, because while `SELECT *` remains, CockroachDB emits:

```
index recommendations: 1
1. CREATE INDEX ON chatroach.public.messages (userid) STORING (id, content, "timestamp");
```

— which is exactly the `messages_userid_idx` canary being dropped. Fixing the query
first removes the recommendation's basis.

## `states` index amplification (measured 2026-07-26)

`states` is only ~2% of cluster storage, so this is **not a disk-cost play** — it is a
*write-amplification* play. `states` is the hottest write path in the system (every
inbound message updates a row), and every index below is written on every update
regardless of whether anything ever reads it.

The same pathology as `messages` is present: the big `state_json` column is `STORED` in
**five** secondary indexes, so `state_json` lives **6×** on disk (primary + 5), plus a
sixth *expanded* copy in the inverted index.

Per-index size (`SHOW RANGES ... WITH DETAILS, INDEXES`) against reads over the 22-day
uptime window since 2026-07-04 (`crdb_internal.index_usage_statistics`; counters reset on
node restart):

| Index | Size (MB) | Reads (22d) | Stores `state_json` | Verdict |
|---|---:|---:|:--:|---|
| `states_state_json_idx` (INVERTED) | **3,220.0** | **3** | is the JSON | **drop** |
| `primary` | 1,381.6 | 176,800 | ✅ | keep |
| `states_current_form_payment_error_code_idx` | 1,381.2 | 1,223 | ✅ | keep — covering for `current_form` |
| `states_current_state_fb_error_code_idx` | 1,375.6 | 2,309 | ✅ | keep |
| `states_previous_with_token_…_idx` | 1,372.1 | 4 | ✅ | canary — Dean filters on it |
| `states_current_state_timeout_date_idx` | 1,353.0 | 5 | ✅ | canary |
| `states_payment_error_code_idx` | 1,334.8 | 14 | ✅ | **drop** |
| `states_current_state_current_form_updated_idx` | 144.1 | 13,063 | — | keep |
| `states_error_tag_…_idx` | 139.9 | 84 | — | keep |
| `states_stuck_on_question_…_idx` | 139.0 | 7,319 | — | keep |
| `states_current_state_error_tag_updated_next_retry_idx` | 115.9 | 371 | — | keep |
| `states_current_state_updated_idx` | 109.4 | 26,647 | — | keep |
| `states_current_state_fb_error_code_updated_next_retry_idx` | 97.4 | 974 | — | keep |
| `states_auto_index_fk_pageid_ref_facebook_pages` | 89.1 | 21 | — | **drop** — orphan |

Total ≈ 12.0 GiB. Note the shape: every index that stores `state_json` costs ~1.35 GB;
every index that does not costs ~0.1 GB. **Storing `state_json` is ~13× the cost of the
index itself.**

### Why each drop candidate is dead

- **`states_state_json_idx` (inverted, 3,220 MB — 2.3× the primary).** Inverted indexes
  serve `@>` containment. The only JSON access in the codebase is `->>` *extraction*
  (`exodus/query/builder.go:137,147`), which **cannot use** an inverted index. An inverted
  index writes one entry per JSON path/value per row, so this is both the largest
  structure on the table and the most expensive per write. 3 reads in 22 days.
- **`states_payment_error_code_idx` (1,334.8 MB).** `payment_error_code` appears exactly
  once in the codebase — `dashboard-server/queries/states/states.queries.js:167`, as a
  SELECTed output column, never in a `WHERE`. Nothing can lead with this index. (Distinct
  from `states_current_form_payment_error_code_idx`, which leads with `current_form` and
  gets 1,223 reads as a covering index — **keep that one**.)
- **`states_auto_index_fk_pageid_ref_facebook_pages` (89.1 MB).** The FK was dropped
  (`devops/all.sql:142`) but CockroachDB left its auto-index behind. Small, but free.

### Why two are canaries, not drops

- **`states_current_state_timeout_date_idx` (1,353.0 MB, 5 reads).** Dean's timeout sweep
  computes `calculated_timeout_date` in a CTE (`dean/queries.go:172-213`) and filters the
  *derived* expression, which this index cannot serve — hence 5 reads against ~31,680
  exporter runs in the same window. Almost certainly dead, but Dean's timeout path is
  critical enough to soak behind a canary.
- **`states_previous_with_token_…_idx` (1,372.1 MB, 4 reads).** Dean *does* filter on
  these columns (`dean/queries.go:241-242`). Rare ≠ unused — dropping it could turn a rare
  query into a full scan of 1.07M rows. Canary and watch.

**Ceiling:** dropping all five frees ~7.2 GiB of 12.0 GiB (**~60% of `states`**). The
three clear drops alone free ~4.6 GiB. In cluster terms that is ~1% of ~672 GB — the
justification is the write path, not the disk.

### Interaction with the missing `updated` index

There is no index leading with `updated`, which is why every health/traffic query must pin
`current_state = ANY(<10 machine states>)` to get index spans (see
`documentation/study-error-alerting.md`). A plain `(updated)` index would fix that but is a
**CockroachDB anti-pattern**: `updated` is monotonically increasing, so every write lands at
the end of the key space and one range takes all the traffic. If it is ever needed, the
correct form is hash-sharded — `USING HASH WITH BUCKET_COUNT = 8` — and this cleanup is what
buys the write-amplification headroom to afford it.

## How `messages` is actually accessed

This is the fact that governs any archival design:

1. **Runtime — only on a Redis cache-miss.** State is cached in Redis
   (`state:{userid}`, 24h TTL — `replybot/lib/typewheels/statestore.js`). On a miss,
   `getState` replays the user's event history through the state machine. The
   events come from **CockroachDB `messages`**, via the `@vlab-research/chatbase-postgres`
   backend (`Chatbase.get()` — then `chatbase-postgres/lib/index.js:21-37`, now `replybot/lib/chatbase/chatbase.js`), which joins
   `states` and filters on the `message_pointer` checkpoint (see below).
   (Note: state recompute reads `messages`, **not** Kafka — Kafka is only the runtime
   ingest stream.)
2. **Admin exports — on demand only.** The full-messages exporter
   (`exporter/exporter/exporter.py`) queries `WHERE userid IN (...) ORDER BY userid, timestamp`.
   The `chat_log` export uses the separate curated `chat_log` table, not `messages`.
3. **Nothing else.** The dashboard, Dean, and the state machine's normal operation do
   not read `messages` directly.

Access is therefore **always per-user, time-ordered** — never a cross-user scan
(except admin export). Everything funnels through `Chatbase.get(userid)`, which
returns an ordered list of message contents. The state machine is deterministic
replay over that list and does not care where the list comes from — this is the clean
seam for cold storage.

### The `message_pointer` checkpoint (corrects an earlier claim)

An earlier version of this doc — and the cost-reduction plan — stated that recompute
"replays from zero and never uses the already-persisted `states` table as a
checkpoint." **That is not accurate.** A partial checkpoint already exists:

- `states.message_pointer` is a **stored computed column** derived from
  `state_json->>'pointer'` (`devops/migrations/04-pointers.sql`).
- `Chatbase.get()` LEFT JOINs it and filters
  `message_pointer IS NULL OR message_pointer <= timestamp`, so replay is already
  truncated at the pointer.

The real limitation is narrower: **`pointer` only advances on `RESET`,
`RESTORE_STATE`, and `USER_BLOCKED`** (`replybot/lib/typewheels/machine.js:249,314,400`)
— never as a periodic checkpoint. So a long-lived user in one continuous flow still
replays their whole history since the last reset.

This makes the Tier 2 checkpointing work substantially cheaper than described: there
is a working truncation mechanism to *extend with periodic snapshots*, not one to
build from scratch.

## Cost-reduction roadmap

### Tier 1 — Drop redundant indexes (two-phase; no architecture change)
Target end state: keep only `primary` + `messages_userid_timestamp_idx`. Rolled out in
two migrations so the risky drop soaks behind a canary:
- **Phase 1 — `devops/migrations/18-drop-cold-message-indexes.sql` — ✅ APPLIED 2026-07-22.**
  Dropped the two scratch-only global `timestamp` indexes, and set `messages_userid_idx`
  `NOT VISIBLE`. The canary stays on disk but out of the serving path; revert is a
  one-line `ALTER INDEX ... VISIBLE` with no rebuild.
  **Verified 2026-07-26:** schema correct, physical usage ~596 GB → ~407 GiB, GC settled.
- **Phase 2 — `devops/migrations/19-drop-message-userid-idx.sql` — pending.** `DROP` the
  `messages_userid_idx` canary (a further 126.2 GiB logical). The soak window has elapsed.
  **Two preconditions before running it:** (a) fix the replica co-location risk (see the
  memory/topology plan), and (b) ship the `SELECT content` change so CockroachDB stops
  recommending the very index being dropped.

Expected end state ~252 GiB logical for `messages`, ~290 GiB physical (~72 GiB/node).
Disk reclaims only after `gc.ttlseconds` (25h). Tradeoff: a future manual
global-timestamp replay (`batch.js`) falls back to a sort scan.

**Beyond disk:** dropping the canary also removes ~2,916 ranges → ~2,190 fewer replicas
per node. Given the range-size fossil described under *Cluster shape*, replica count is
the more valuable metric to track here than gigabytes.

### Tier 2 — Make the read path covering + `messages` archival (structural)
1. **`SELECT *` → `SELECT content` in `Chatbase.get()`** — one line, removes the index
   join to `primary`, and should ship before Phase 2. See the index-amplification
   section above.
2. **Extend the `message_pointer` checkpoint** so it advances periodically, not only on
   `RESET` / `RESTORE_STATE` / `USER_BLOCKED`. The mechanism already exists (see *The
   `message_pointer` checkpoint* above) — this is an extension, not a new subsystem.
   Once replay is bounded, `messages` is no longer needed for operations, only for
   audit/export. This is the precondition that makes aggressive cold storage safe.

### Tier 3 — Cold storage for dormant users
Survey-takers finish and go dormant; the *warm* working set is a small fraction of
the ~379 GiB in `messages`. Keep **writes** in CockroachDB (append + dedup is what a DB is good at — the
original "buckets only" attempt was slow on the *write/append* path, not on keyed
reads). A periodic archival job moves users inactive > N months into one **per-user
object** in GCS/MinIO (`messages/userid=X.ndjson.gz`) and `DELETE`s them from CRDB. On a
cache-miss for a cold user, `Chatbase.get()` falls back to fetching that single blob —
a keyed single-object read is tens of ms + transfer ("a few seconds to reload" budget).
Buckets are slow for *scans*, fast for *keyed reads* — which is exactly this access pattern.

### Tier 4 — Downsize the cluster (the goal)

⚠️ **Two hard preconditions, both documented in
[`planning/cockroachdb-memory-and-topology-plan.md`](../planning/cockroachdb-memory-and-topology-plan.md):**

1. **Fix the replica co-location risk first.** Two CRDB pods currently share one GKE
   node with only `soft` anti-affinity and no CRDB locality. You cannot safely go
   4 → 3 nodes while the scheduler is free to stack two databases on one machine.
2. **The `3 × ~50Gi` target does not follow from Tier 1.** Post-Phase-2 the cluster is
   ~290 GiB physical; over 3 nodes that is ~96 GiB/node before headroom. `50Gi` only
   becomes reachable after **Tier 3 archival** drops the working set to tens of GB.
   Size PVCs off the right milestone.

**The cost lever is memory, not disk.** CockroachDB is 60% of all memory requests in
the GKE cluster, which is what forces `e2-highmem-4` (32 GB) over `e2-standard-4`
(16 GB) at the same 4 vCPU. The machine-type change reduces to one number: getting the
CRDB pod from `8000Mi` to ~`4000Mi`. The levers for that — range-size fix, index drops,
and Pebble value separation in v25.4 — are all in the memory plan.

## Reference commands

```bash
# Per-index size (slow — live per-range scan)
kubectl -n vprod exec gbv-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach \
  --execute "SELECT index_name, round(sum(range_size_mb)/1024.0,1) AS size_gib, count(*) ranges \
  FROM [SHOW RANGES FROM TABLE messages WITH DETAILS, INDEXES] GROUP BY index_name ORDER BY size_gib DESC;"

# Index read counts (fast — no scan)
# NOTE: as of 2026-07-26 this returns ZERO rows for `messages`. index_usage_statistics
# is in-memory and resets; absence of rows is NOT evidence an index is unused. Prefer
# `NOT VISIBLE` canaries over read counters when deciding whether a drop is safe.
kubectl -n vprod exec gbv-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach \
  --execute "SELECT ti.index_name, s.total_reads, s.last_read \
  FROM crdb_internal.index_usage_statistics s \
  JOIN crdb_internal.table_indexes ti ON s.table_id=ti.descriptor_id AND s.index_id=ti.index_id \
  WHERE ti.descriptor_name='messages' ORDER BY s.total_reads DESC;"

# Physical disk per pod (or read capacity.used from crdb_internal.kv_store_status)
for i in 0 1 2 3; do kubectl -n vprod exec gbv-cockroachdb-$i -- df -h /cockroach/cockroach-data | tail -1; done

# Replica count per node — the memory-relevant metric, see the memory/topology plan
kubectl -n vprod exec gbv-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach \
  --execute "SELECT node_id, round((metrics->>'replicas')::float,0) AS replicas \
  FROM crdb_internal.kv_store_status ORDER BY node_id;"

# Topology check — all four pods MUST be on distinct nodes
kubectl get pods -n vprod -o wide | grep cockroachdb
```

> Tip: for interactive analysis, port-forward `svc/gbv-cockroachdb-public 5432:26257`
> and query with any Postgres client. Avoid `crdb_internal.statement_statistics` —
> it fans out across nodes and can run for minutes on this cluster.
