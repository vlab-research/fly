# CockroachDB Cost Reduction — Plan & Progress

**Goal:** Shrink the production CockroachDB cluster (and the GKE compute pool sized
around it) by attacking the `messages` table, which is ~93% of all data.

**Status as of 2026-07-26:** Phase 1 soak **complete and verified against prod**
(schema correct, physical ~596 GB → ~407 GiB, GC settled). Phase 2 is ready to run
once its two new preconditions are met — see below.

> 🔴 **Do not run Phase 2, and do not act on Tier 4, before reading
> [`cockroachdb-memory-and-topology-plan.md`](./cockroachdb-memory-and-topology-plan.md).**
> It documents a **live production availability risk** (two CockroachDB pods sharing
> one GKE node, ~half of all ranges unable to survive that node's loss) that must be
> fixed first. It also establishes that **memory, not disk, is the actual cost lever** —
> CockroachDB is 60% of all memory requests in the GKE cluster.
>
> Several claims in *this* document were checked against prod on 2026-07-26 and found
> wrong. They are corrected inline below and marked ⚠️.

**New here? Start at
[`documentation/cockroachdb-storage.md`](../documentation/cockroachdb-storage.md)** —
it's the measured ground truth (cluster shape, table and index sizes, access patterns)
and maps out all four CockroachDB documents. This plan is the **disk / index-drop work
log**; the overall priority order lives in
[`cockroachdb-memory-and-topology-plan.md`](./cockroachdb-memory-and-topology-plan.md).
Version upgrades are in
[`cockroachdb-operator-and-v25-v26-migration.md`](./cockroachdb-operator-and-v25-v26-migration.md).

---

## The situation (measured 2026-07-22 — **pre-Phase-1 baseline**, kept for reference)

> Current numbers are in the *Work log — DONE* entry for 2026-07-26 and in
> [`documentation/cockroachdb-storage.md`](../documentation/cockroachdb-storage.md).
> Post-Phase-1: **432.2 GiB logical / ~407 GiB physical**, `messages` 378.6 GiB.

- Cluster: StatefulSet `gbv-cockroachdb`, 4 pods in `vprod`, each on a `240Gi pd-ssd`
  PVC → **960Gi provisioned, ~596GB physical used** (~63%). All 4 pods on the
  `bigpool` node pool (4 × `e2-highmem-4`, 4 vCPU / 32GB, all `europe-west1-b`).
  ⚠️ Two of those pods currently share one GKE node — see the memory/topology plan.
- **`messages` was ~93% of the data** (~624 GB logical). `responses` ~37GB, `states`
  ~10.5GB, everything else <1GB.
- **Root cause of `messages` bloat:** the big `content` (raw event JSON) column is
  `STORED` in every secondary index, so each index is a near-full copy of the table
  (~131.6 GiB each). `content` was stored **5×**.
- **Access pattern:** `messages` is read at runtime *only* on a Redis cache-miss,
  via `Chatbase.get()`: `SELECT * FROM messages WHERE userid=$1 ORDER BY timestamp ASC`
  (state recompute). Otherwise only on-demand admin exports. Always per-user,
  full-history, time-ordered. No cross-user scans. (State recompute reads
  CockroachDB, **not** Kafka — Kafka is only the ingest stream.)

---

## Index inventory & decision

Sizes re-measured 2026-07-26; the 131.6 GiB figures were the pre-drop measurements.

| Index | Key order | Size | Verdict | Status |
|---|---|---|---|---|
| `primary` `(hsh, userid)` | — | 126.2 GiB | **keep** — insert dedup | live |
| `messages_userid_timestamp_idx` STORING `(content)` | `(userid, ts, hsh)` | 126.2 GiB | **keep** — hot path | live |
| `messages_userid_idx` STORING `(content, ts)` | `(userid, hsh)` | 126.2 GiB | **drop** — redundant sibling | `NOT VISIBLE` canary |
| `messages_timestamp_idx` STORING `(content)` | `(ts ASC, …)` | ~131.6 GiB | **drop** — scratch-replay only | ✅ dropped 07-22 |
| `messages_timestamp_idx1` STORING `(content)` | `(ts DESC, …)` | ~131.6 GiB | **drop** — scratch-replay only | ✅ dropped 07-22 |

**Why keep `userid_timestamp` over `userid_idx`:** it is the optimizer's choice and the
better key order for a timestamp-ordered per-user read. The decision is correct.

> ⚠️ **Correction (prod-verified 2026-07-26): the "no sort" reasoning was wrong.**
> The `EXPLAIN` behind it was run against a simplified query. The real `Chatbase.get()`
> (`chatbase-postgres/lib/index.js:21-37`) LEFT JOINs `states` for the `message_pointer`
> checkpoint, and **the merge join on `userid` destroys the timestamp ordering — so the
> plan contains a `sort` node.**
>
> This does **not** change the verdict: `userid_idx` is keyed `(userid, hsh)` and would
> sort too, no better. But any checklist step that says "verify no sort node" is wrong
> and **will fail**; those are corrected below.

**Why the two `timestamp` indexes are safe to drop:** used only by the manual replay
tool `replybot/lib/responses/batch.js` (via `replybot/kube-scratch/batchscratch.yaml`),
which is **not** in the prod Helm release (`scratchbot: false`). Lifetime reads: 25 / 6.

---

---

## Tier 1b — `states` index cleanup (measured 2026-07-26)

**Read this framing first: this is not a disk-cost win.** `states` is ~12 GiB of a ~672 GB
cluster. Dropping everything proposed here frees ~7.2 GiB — about **1% of the cluster**.
It will not move the PVC sizing in Tier 4 and should not be counted toward it.

**The actual justification is write amplification.** `states` is the hottest write path in
the system: every inbound message updates a row, and **every index is written on every
update whether or not anything ever reads it**. Four of these indexes have been read
3–21 times in 22 days while being written continuously.

Same pathology as `messages`: the big `state_json` column is `STORED` in five secondary
indexes, so it lives **6×** on disk, plus a sixth *expanded* copy in the inverted index.
The shape is stark — indexes that store `state_json` cost ~1.35 GB each; indexes that
don't cost ~0.1 GB. **Storing `state_json` is ~13× the cost of the index itself.**

Full measurements and per-index reasoning:
[`documentation/cockroachdb-storage.md`](../documentation/cockroachdb-storage.md#states-index-amplification-measured-2026-07-26).

### Decision table

| Index | Size (MB) | Reads (22d) | Verdict |
|---|---:|---:|---|
| `states_state_json_idx` (INVERTED) | **3,220.0** | 3 | **drop — Phase 1** |
| `states_payment_error_code_idx` | 1,334.8 | 14 | **drop — Phase 1** |
| `states_auto_index_fk_pageid_ref_facebook_pages` | 89.1 | 21 | **drop — Phase 1** |
| `states_current_state_timeout_date_idx` | 1,353.0 | 5 | **canary — Phase 1**, drop Phase 2 |
| `states_previous_with_token_…_idx` | 1,372.1 | 4 | **canary — Phase 1**, drop Phase 2 |
| all 9 others | — | 84 – 176,800 | keep |

**Phase 1 frees ~4.6 GiB** (three clear drops). **Phase 2 frees a further ~2.7 GiB** →
~7.2 GiB total, ~60% of `states`.

### Why each is safe

- **`states_state_json_idx`** — the headline. 3,220 MB, **2.3× the primary**, 3 reads in
  22 days. Inverted indexes serve `@>` containment; the only JSON access in the codebase
  is `->>` *extraction* (`exodus/query/builder.go:137,147`), which cannot use one. It
  writes one entry per JSON path/value per row — largest structure on the table and the
  most expensive per write. Nothing can be using it for anything meaningful.
- **`states_payment_error_code_idx`** — `payment_error_code` appears exactly once in the
  codebase (`dashboard-server/queries/states/states.queries.js:167`) as a SELECTed output
  column, **never in a `WHERE`**. Nothing can lead with it.
  ⚠️ Do **not** confuse with `states_current_form_payment_error_code_idx` (1,223 reads) —
  that one leads with `current_form` and is serving as a covering index. **Keep it.**
- **`states_auto_index_fk_pageid_ref_facebook_pages`** — orphan. The FK was dropped
  (`devops/all.sql:142`); CockroachDB left the auto-index behind.
- **`states_current_state_timeout_date_idx` (canary)** — Dean's timeout sweep computes
  `calculated_timeout_date` in a CTE (`dean/queries.go:172-213`) and filters the *derived*
  expression, which this index cannot serve. 5 reads against ~31,680 exporter runs in the
  same window. Almost certainly dead — but Dean's timeout path is critical, so soak it.
- **`states_previous_with_token_…_idx` (canary)** — the one to be careful with. Dean
  genuinely filters on these columns (`dean/queries.go:241-242`). Rare ≠ unused; dropping
  it outright could turn a rare query into a full scan of 1.07M rows.

### Migration shape (mirrors the proven 18/19 pattern)

Not yet authored as files — the SQL below is the proposal.

```sql
-- Phase 1 (proposed devops/migrations/20-drop-cold-states-indexes.sql)
-- Three clear drops (~4.6 GiB):
DROP INDEX chatroach.states@states_state_json_idx;
DROP INDEX chatroach.states@states_payment_error_code_idx;
DROP INDEX chatroach.states@states_auto_index_fk_pageid_ref_facebook_pages;

-- Two canaries: out of the serving path, still on disk, instantly revertible.
ALTER INDEX chatroach.states@states_current_state_timeout_date_idx NOT VISIBLE;
ALTER INDEX chatroach.states@states_previous_with_token_previous_is_followup_form_start_time_current_state_updated_idx NOT VISIBLE;

-- Phase 2 (proposed devops/migrations/21-drop-states-canaries.sql), after clean soak:
-- DROP both canaries (~2.7 GiB).
```

**Abort switch (instant, no rebuild):**
`ALTER INDEX chatroach.states@<name> VISIBLE;`

### Soak checklist (Phase 1 → Phase 2)

- [ ] Dean timeout processing: expired waits still cleared; watch `survey_expired_waits`
      on the Study Health board and the `deanexpiredwaits` alert.
- [ ] `EXPLAIN` Dean's timeout sweep and follow-up queries (`dean/queries.go:172-213`,
      `:241-242`) — confirm no `FULL SCAN` appears.
- [ ] replybot state-write latency flat (the whole point is a *faster* write path).
- [ ] No new slow queries in the CRDB console.
- [ ] After > `gc.ttlseconds` (25h): confirm disk sheds ~4.6 GiB worth.

### Expected upside beyond disk

Writes drop from 14 index maintenances per state update to 11 (Phase 1) or 9 (Phase 2),
and the removed ones include the inverted index — by far the most expensive per write,
since it expands every JSON path. This is the measurable win; watch state-write latency,
not `df`.

### Related: the missing `updated` index

There is no index leading with `updated`, which forces every health/traffic query to pin
`current_state = ANY(<10 machine states>)` for index spans. A plain `(updated)` index would
remove that fragility (a new state machine state currently goes *silently invisible* to the
metrics) but is a **CRDB anti-pattern** — monotonically increasing key ⇒ every write lands
on one range ⇒ write hotspot on the hottest table. If it is ever added, use
`USING HASH WITH BUCKET_COUNT = 8`. This cleanup is what buys the headroom to afford it.
Cheaper mitigation for the fragility: a test asserting botserver-core's state list matches
the exporter's and dashboard-server's `STATE_MACHINE_STATES`.

---

## Work log — DONE

- [x] Measured cluster shape, disk usage, per-table and per-index sizes, index read
      stats, replication factor, GC TTL, node/pool sizing.
- [x] Traced the true `messages` access pattern and corrected the misconception that
      state recompute reads Kafka (it reads CockroachDB `messages`).
- [x] `EXPLAIN`-verified which userid index the optimizer prefers (→ `userid_timestamp`).
- [x] Wrote reference doc: `documentation/cockroachdb-storage.md`.
- [x] Authored two-phase migration:
  - `devops/migrations/18-drop-cold-message-indexes.sql`
  - `devops/migrations/19-drop-message-userid-idx.sql`
- [x] **Applied Phase 1 (migration 18)** — dropped the two `timestamp` indexes and set
      `messages_userid_idx` `NOT VISIBLE` (canary).
- [x] Verified post-Phase-1 plan: hot query runs on `messages_userid_timestamp_idx`,
      ~88 rows, ~271ms (dominated by the `id`→primary index join).
      ⚠️ *The original entry claimed "no sort node" — incorrect, see the correction above.*
- [x] **2026-07-26 — verified Phase 1 against prod (read-only).** Schema correct
      (`messages_userid_idx` `visible=f`, both timestamp indexes gone). Physical usage
      98.7 / 98.2 / 105.0 / 105.4 GiB per store, down from ~596 GB. GC fully settled.
- [x] **2026-07-26 — measured memory and GKE topology.** Findings, including a live
      availability risk, are in
      [`cockroachdb-memory-and-topology-plan.md`](./cockroachdb-memory-and-topology-plan.md).

---

## Work log — TODO

### Immediate — soak Phase 1 — ✅ DONE (verified 2026-07-26)
- [x] Disk shed confirmed: ~596 GB → ~407 GiB total, GC settled well past the 25h TTL.
- [x] Schema confirmed correct via `SHOW INDEXES`.
- [ ] *Still worth a glance:* replybot state-recompute latency / error rate in Grafana.
- **Abort switch (instant, no rebuild):**
      `ALTER INDEX chatroach.public.messages@messages_userid_idx VISIBLE;`

### Phase 2 — drop the canary

**Preconditions (both new, both required):**
1. 🔴 **Fix the replica co-location risk first** — two CRDB pods share one GKE node.
   See [`cockroachdb-memory-and-topology-plan.md`](./cockroachdb-memory-and-topology-plan.md) Part 0.
2. **Ship the `SELECT content` PR first** (Tier 2 below). While `SELECT *` remains,
   `EXPLAIN` emits `CREATE INDEX ON messages (userid) STORING (id, content, "timestamp")`
   — i.e. CockroachDB actively recommends recreating the exact index being dropped.

Then:
- [ ] Run `./devops/run-prod-migration.sh devops/migrations/19-drop-message-userid-idx.sql`.
- [ ] Verify only `primary` + `messages_userid_timestamp_idx` remain.
      ⚠️ The migration's own precondition checklist says to verify "no sort node" —
      that check is wrong (see the correction above); ignore it.
- [ ] After GC, confirm disk sheds a further 126.2 GiB worth.
- **Expected end state:** `messages` ~252 GiB logical, cluster physical ~407 → ~290 GiB
      (~72 GiB/node). *Also* removes ~2,916 ranges → ~2,190 fewer replicas per node,
      which is the more valuable number — see the memory plan.

### Tier 1b — `states` index cleanup (see section above)
- [ ] Author `devops/migrations/20-drop-cold-states-indexes.sql` (3 drops + 2 canaries).
- [ ] Apply Phase 1 via `./devops/run-prod-migration.sh`.
- [ ] Soak: Dean timeout path, `EXPLAIN` for full scans, state-write latency, disk after 25h.
- [ ] Author + apply `devops/migrations/21-drop-states-canaries.sql` after clean soak.
- **Expected:** ~7.2 GiB freed (~60% of `states`, ~1% of cluster — *not* a Tier 4 input).
      Real win: 14 → 9 index writes per state update, including the inverted index.

### Tier 2 — make the read path covering + `messages` archival-only
- [ ] **Small standalone PR — do this BEFORE Phase 2.** Change `Chatbase.get()` in
      `@vlab-research/chatbase-postgres` from `SELECT *` to `SELECT content`.
      `EXPLAIN`-verified 2026-07-26: this removes the index join to `primary` entirely.
      The join exists *only* to fetch `id`, which `get()` then discards
      (`result.rows.map(r => r.content)`). The `sort` remains — it comes from the
      `states` join, not the projection.
- [ ] **State snapshot checkpointing.**
      ⚠️ **Correction:** the premise below was wrong. A checkpoint mechanism already
      exists — `states.message_pointer` is a stored computed column off
      `state_json->>'pointer'` (`devops/migrations/04-pointers.sql`), and `Chatbase.get()`
      already filters `message_pointer <= timestamp`, so replay is already truncated.
      The **real** limitation is narrower: `pointer` only advances on `RESET`,
      `RESTORE_STATE`, and `USER_BLOCKED`
      (`replybot/lib/typewheels/machine.js:249,314,400`) — never periodically.
      **So this is extending a working mechanism with periodic snapshots, not building
      one.** Substantially cheaper than this plan originally implied. Still the
      precondition for aggressive cold storage.

### Tier 3 — cold storage for dormant users
- [ ] Periodic archival job: for users inactive > N months, write full history to one
      per-user object in GCS/MinIO (`messages/userid=X.ndjson.gz`), then `DELETE` from CRDB.
- [ ] `Chatbase.get()` falls back to the archive blob on a cache-miss for a cold user
      (keyed single-object read = tens of ms + transfer; meets "few seconds to reload").
      Writes stay in CRDB (append/dedup is the DB's job — the reason buckets-only was slow
      originally was the *write* path, not keyed reads).

### Tier 4 — downsize the cluster (the goal)

⚠️ **This tier is superseded by
[`cockroachdb-memory-and-topology-plan.md`](./cockroachdb-memory-and-topology-plan.md).**
Read that first; the corrections below are why.

- [ ] 🔴 **Precondition: fix the replica co-location risk.** You cannot safely go 4 → 3
      nodes while `podAntiAffinity` is `soft` and CRDB locality is unset.
- [ ] ⚠️ **`3 × ~50Gi` does not follow from the index work.** Post-Phase-2 the cluster is
      ~290 GiB physical; over 3 nodes that is ~96 GiB/node before headroom. `50Gi` needs
      **Tier 3 archival** first. Size PVCs off the right milestone.
- [ ] ⚠️ **The cost lever is memory, not disk.** Measured: CockroachDB is **60% of all
      memory requests in the GKE cluster** (31.25 GiB of 52.2 GiB), which is what forces
      `e2-highmem-4` (32 GB) over `e2-standard-4` (16 GB) at the same 4 vCPU. The whole
      machine-type change reduces to getting the CRDB pod from `8000Mi` to ~`4000Mi`.
      CPU is not binding (43% of requests).
- [ ] ⚠️ **Do not lower `--max-sql-memory` expecting a win** — it runs at 0.1%
      utilization (3.5 MiB of 3000Mi) and is a ceiling, not an allocation. The two real
      dials are `--cache` and **replica count**.
- [ ] **Biggest untapped memory win, needs no upgrade:** every zone carries
      `range_max_bytes = 67108864` (64 MiB), the pre-v21.1 default, giving ~8,850
      replicas/node. Raising it to 512 MiB is a ~13× replica reduction. See the memory plan.
- [ ] **Note:** GKE `pd-ssd` cannot be shrunk in place. This is a provision-new +
      let-CRDB-rebalance + decommission-old sequence — plan it explicitly before touching
      PVCs. It is also the *same physical operation* as the operator's rolling adoption,
      so sequence them together rather than rebuilding the cluster twice.

---

## Side finding (not part of this work, worth a separate look)
The `messages` table contains junk/attack `userid`s — e.g. a **log4shell JNDI probe
string** was the first row sampled. Harmless to the index work, but worth checking
whether such payloads are being replayed through the state machine.

---

## How to apply / verify (quick reference)

```bash
# Phase 1 (done)
./devops/run-prod-migration.sh devops/migrations/18-drop-cold-message-indexes.sql
# Phase 2 (after soak)
./devops/run-prod-migration.sh devops/migrations/19-drop-message-userid-idx.sql

# Verify indexes
kubectl -n vprod exec gbv-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach \
  --execute "SHOW INDEXES FROM messages;"

# Verify hot-path plan. Use the REAL query (with the states join), not the simplified one —
# expect scan on messages_userid_timestamp_idx. A `sort` node IS expected and is fine.
kubectl -n vprod exec gbv-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach \
  --execute "EXPLAIN SELECT * FROM messages \
    LEFT JOIN (SELECT userid, message_pointer FROM states WHERE userid='<real-userid>') USING (userid) \
    WHERE userid='<real-userid>' \
    AND (message_pointer IS NULL OR message_pointer <= timestamp) ORDER BY timestamp ASC;"

# Replica count per node — the memory-relevant metric (see the memory/topology plan)
kubectl -n vprod exec gbv-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach \
  --execute "SELECT node_id, round((metrics->>'replicas')::float,0) AS replicas \
    FROM crdb_internal.kv_store_status ORDER BY node_id;"

# Topology check — all four pods MUST be on distinct nodes
kubectl get pods -n vprod -o wide | grep cockroachdb

# Verify disk (wait > gc.ttlseconds = 25h after each drop)
for i in 0 1 2 3; do kubectl -n vprod exec gbv-cockroachdb-$i -- df -h /cockroach/cockroach-data | tail -1; done
```
