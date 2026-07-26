# CockroachDB Storage & Cost Reduction

How storage is distributed across the production CockroachDB cluster, why the
`messages` table dominates it, and the roadmap for shrinking the cluster (and the
GKE compute pool sized around it). Measured on prod `2026-07-22`, CRDB `v24.1.28`.

## Cluster shape

- StatefulSet `gbv-cockroachdb`, 4 pods, namespace `vprod`.
- Each pod on a `240Gi pd-ssd` PVC → **960Gi provisioned, ~596GB physical used** (~63%).
- Replication factor **3** (`SHOW ZONE CONFIGURATION FROM RANGE default`), GC TTL
  `gc.ttlseconds = 90000` (25h). Physical unique compressed ≈ 596/3 ≈ ~199GB;
  logical uncompressed ≈ 672GB (~3.4× compression on disk).
- Per-pod flags: `--cache=3500Mi --max-sql-memory=3000Mi`; memory request `8000Mi`.
- All 4 pods run on the `bigpool` node pool (4 nodes × 4 vCPU / 32GB). The pool is
  sized largely around CockroachDB.

## Storage breakdown (logical, uncompressed)

| Table | Size | Share | Notes |
|---|---|---|---|
| `messages` | ~624 GB | ~93% | Append-only event log (`chatroach` db) |
| `responses` | ~37 GB | ~5% | Survey responses |
| `states` | ~10.5 GB | ~2% | Computed participant state |
| everything else | <1 GB | — | users, surveys, credentials, templates, `chat_log`… |

`messages` is the entire cost story. Schema: `devops/migrations/01-init.sql:17-27`.

## Why `messages` is so large: index amplification

`messages` stores the big `content` (raw event JSON) column, and **every secondary
index `STORES content`** — so each index is a near-full copy of the table. Measured
per-index size and read counts (`SHOW RANGES ... WITH DETAILS, INDEXES` +
`crdb_internal.index_usage_statistics`):

| Index | Key order | Size | Reads | Role |
|---|---|---|---|---|
| `primary` `(hsh, userid)` | — | 131.7 GiB | 15,889 | Insert dedup (`ON CONFLICT`) — **keep** |
| `messages_userid_timestamp_idx` STORING `(content)` | `(userid, ts, hsh)` | 131.6 GiB | 34* | Hot read path (no sort) — **keep** |
| `messages_userid_idx` STORING `(content, ts)` | `(userid, hsh)` | 131.6 GiB | 128,951* | Sibling that forces a sort — **drop** |
| `messages_timestamp_idx` STORING `(content)` | `(ts ASC, hsh, userid)` | 131.6 GiB | 25 | Scratch replay only — **drop** |
| `messages_timestamp_idx1` STORING `(content)` | `(ts DESC, hsh, userid)` | 131.6 GiB | 6 | Scratch replay only — **drop** |

`content` is stored **5×**. `messages_timestamp_idx1` is not in `01-init.sql` — added
by a later change; the authoritative list is `SHOW INDEXES FROM messages`.

**Which userid index to keep** (verified with `EXPLAIN`, not the read counter): the hot
query is `WHERE userid=$1 ORDER BY timestamp ASC`. `messages_userid_timestamp_idx` is
keyed `(userid, timestamp)`, so rows come back already sorted — the optimizer's *natural*
plan is a plain scan with **no sort**. `messages_userid_idx` is keyed `(userid, hsh)`, so
the same query needs a `sort` node (CockroachDB's own index recommendation flags it for
replacement). So keep `userid_timestamp` and drop `userid_idx` — the hot path *improves*.
The 128,951 reads on `userid_idx` are cumulative and the stats are 158 days stale; the
current optimizer prefers `userid_timestamp`, more strongly as a user accumulates rows.

Bonus: neither secondary index is *covering* for `SELECT *`, because `id` lives only in
`primary` — both plans `index join` back to `primary` anyway, so the `STORING(content)`
on the secondaries doesn't help this query. Changing `Chatbase.get()` from `SELECT *` to
`SELECT content` would make `userid_timestamp` fully covering (no join, no sort) — a
Tier 2 app-side optimization.

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
   `getState` replays the user's full event history through the state machine. The
   events come from **CockroachDB `messages`**, via the `@vlab-research/chatbase-postgres`
   backend (`Chatbase.get()`): `SELECT * FROM messages WHERE userid=$1 ORDER BY timestamp ASC`.
   (Note: state recompute reads `messages`, **not** Kafka — Kafka is only the runtime
   ingest stream. `STATE_STORE_LIMIT` is passed but `get()` ignores it, so every miss
   replays the *entire* per-user history.)
2. **Admin exports — on demand only.** The full-messages exporter
   (`exporter/exporter/exporter.py`) queries `WHERE userid IN (...) ORDER BY userid, timestamp`.
   The `chat_log` export uses the separate curated `chat_log` table, not `messages`.
3. **Nothing else.** The dashboard, Dean, and the state machine's normal operation do
   not read `messages` directly.

Access is therefore **always per-user, full-history, time-ordered** — never a
cross-user scan (except admin export). Everything funnels through `Chatbase.get(userid)`,
which returns an ordered list of message contents. The state machine is deterministic
replay over that list and does not care where the list comes from — this is the clean
seam for cold storage.

## Cost-reduction roadmap

### Tier 1 — Drop redundant indexes (two-phase; no architecture change)
Target end state: keep only `primary` + `messages_userid_timestamp_idx`. Rolled out in
two migrations so the risky drop soaks behind a canary:
- **Phase 1 — `devops/migrations/18-drop-cold-message-indexes.sql`**: drop the two
  scratch-only global `timestamp` indexes (~263 GiB), and set `messages_userid_idx`
  `NOT VISIBLE`. The canary stays on disk but out of the serving path, so the hot query
  runs on `messages_userid_timestamp_idx` (no sort) during the soak; revert is a one-line
  `ALTER INDEX ... VISIBLE` with no rebuild.
- **Phase 2 — `devops/migrations/19-drop-message-userid-idx.sql`**: after a few clean
  soak days, `DROP` the `messages_userid_idx` canary (final ~131.6 GiB).

Total frees ~395 GiB logical (~60% of `messages`, ~55% of the DB); the runtime hot path
*improves* (loses its sort). Disk reclaims only after `gc.ttlseconds` (25h) — verify with
`df -h` on the pods before shrinking PVCs/nodes.
See `devops/migrations/18-drop-redundant-message-indexes.sql`. Disk reclaims only after
`gc.ttlseconds` (25h) — verify with `df -h` on the pods before shrinking PVCs/nodes.
Tradeoff: a future manual global-timestamp replay (`batch.js`) falls back to a sort scan.

### Tier 2 — Make `messages` purely archival (structural)
On a Redis miss, recompute replays from zero and never uses the already-persisted
`states` table as a checkpoint. Snapshot state durably and replay only from the last
snapshot → `messages` is no longer needed for operations, only for audit/export. This
is the precondition that makes aggressive cold storage safe.

### Tier 3 — Cold storage for dormant users
Survey-takers finish and go dormant; the *warm* working set is a small fraction of
624 GB. Keep **writes** in CockroachDB (append + dedup is what a DB is good at — the
original "buckets only" attempt was slow on the *write/append* path, not on keyed
reads). A periodic archival job moves users inactive > N months into one **per-user
object** in GCS/MinIO (`messages/userid=X.ndjson.gz`) and `DELETE`s them from CRDB. On a
cache-miss for a cold user, `Chatbase.get()` falls back to fetching that single blob —
a keyed single-object read is tens of ms + transfer ("a few seconds to reload" budget).
Buckets are slow for *scans*, fast for *keyed reads* — which is exactly this access pattern.

### Tier 4 — Downsize the cluster (the goal)
After Tier 1 (+ Tier 3), the working set drops from ~199GB to tens of GB. Then:
`4×240Gi → 3×~50Gi pd-ssd` (RF3 minimum is 3 nodes), lower the `8000Mi` memory requests
and `--cache`/`--max-sql-memory`, and reclaim a `bigpool` node (4→3) or move to a smaller
machine type.

## Reference commands

```bash
# Per-index size (slow — live per-range scan)
kubectl -n vprod exec gbv-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach \
  --execute "SELECT index_name, round(sum(range_size_mb)/1024.0,1) AS size_gib, count(*) ranges \
  FROM [SHOW RANGES FROM TABLE messages WITH DETAILS, INDEXES] GROUP BY index_name ORDER BY size_gib DESC;"

# Index read counts (fast — no scan)
kubectl -n vprod exec gbv-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach \
  --execute "SELECT ti.index_name, s.total_reads, s.last_read \
  FROM crdb_internal.index_usage_statistics s \
  JOIN crdb_internal.table_indexes ti ON s.table_id=ti.descriptor_id AND s.index_id=ti.index_id \
  WHERE ti.descriptor_name='messages' ORDER BY s.total_reads DESC;"

# Physical disk per pod
for i in 0 1 2 3; do kubectl -n vprod exec gbv-cockroachdb-$i -- df -h /cockroach/cockroach-data | tail -1; done
```
