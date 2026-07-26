# CockroachDB Cost Reduction — Plan & Progress

**Goal:** Shrink the production CockroachDB cluster (and the GKE compute pool sized
around it) by attacking the `messages` table, which is ~93% of all data.

**Status as of 2026-07-22:** Phase 1 index cleanup applied and soaking. Canary
verified healthy. Awaiting soak → Phase 2.

Full technical reference (measurements, access patterns, index analysis): see
[`documentation/cockroachdb-storage.md`](../documentation/cockroachdb-storage.md).

---

## The situation (measured 2026-07-22, prod, CRDB v24.1.28, RF3)

- Cluster: StatefulSet `gbv-cockroachdb`, 4 pods in `vprod`, each on a `240Gi pd-ssd`
  PVC → **960Gi provisioned, ~596GB physical used** (~63%). All 4 pods on the
  `bigpool` node pool (4 × 4 vCPU / 32GB).
- **`messages` is ~93% of the data** (~624 GB logical). `responses` ~37GB, `states`
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

| Index | Key order | Size | Verdict |
|---|---|---|---|
| `primary` `(hsh, userid)` | — | 131.7 GiB | **keep** — insert dedup |
| `messages_userid_timestamp_idx` STORING `(content)` | `(userid, ts, hsh)` | 131.6 GiB | **keep** — hot path, no sort |
| `messages_userid_idx` STORING `(content, ts)` | `(userid, hsh)` | 131.6 GiB | **drop** — sibling that forces a sort |
| `messages_timestamp_idx` STORING `(content)` | `(ts ASC, …)` | 131.6 GiB | **drop** — scratch-replay only |
| `messages_timestamp_idx1` STORING `(content)` | `(ts DESC, …)` | 131.6 GiB | **drop** — scratch-replay only |

**Why keep `userid_timestamp` over `userid_idx`** (verified with `EXPLAIN`, not the
stale read counter): the hot query orders by timestamp. `userid_timestamp` is keyed
`(userid, timestamp)` → optimizer's natural plan is a plain scan with **no sort**.
`userid_idx` is keyed `(userid, hsh)` → the same query needs a `sort` node. So keeping
`userid_timestamp` makes the hot path *faster*, not just smaller.

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
      **no sort node**, ~88 rows, ~271ms (dominated by the `id`→primary index join).

---

## Work log — TODO

### Immediate — soak Phase 1 (next few days)
- [ ] Watch replybot state-recompute latency / error rate (Grafana/Prometheus) — expect flat.
- [ ] Confirm no unexpected full scans / slow queries in the CRDB console.
- [ ] After >25h (`gc.ttlseconds = 90000`): confirm per-pod disk sheds ~263 GiB worth:
      `kubectl -n vprod exec gbv-cockroachdb-0 -- df -h /cockroach/cockroach-data`
- **Abort switch (instant, no rebuild):**
      `ALTER INDEX chatroach.public.messages@messages_userid_idx VISIBLE;`

### Phase 2 — drop the canary (after clean soak)
- [ ] Run `./devops/run-prod-migration.sh devops/migrations/19-drop-message-userid-idx.sql`.
- [ ] Verify only `primary` + `messages_userid_timestamp_idx` remain.
- [ ] After GC, confirm disk sheds the final ~131.6 GiB worth.
- **Expected total win:** ~395 GiB logical freed (~60% of `messages`), cluster physical
      ~596GB → ~250GB (~62GB/pod).

### Tier 1b — `states` index cleanup (see section above)
- [ ] Author `devops/migrations/20-drop-cold-states-indexes.sql` (3 drops + 2 canaries).
- [ ] Apply Phase 1 via `./devops/run-prod-migration.sh`.
- [ ] Soak: Dean timeout path, `EXPLAIN` for full scans, state-write latency, disk after 25h.
- [ ] Author + apply `devops/migrations/21-drop-states-canaries.sql` after clean soak.
- **Expected:** ~7.2 GiB freed (~60% of `states`, ~1% of cluster — *not* a Tier 4 input).
      Real win: 14 → 9 index writes per state update, including the inverted index.

### Tier 2 — make the read path covering + `messages` archival-only
- [ ] **Small standalone PR:** change `Chatbase.get()` in `@vlab-research/chatbase-postgres`
      from `SELECT *` to `SELECT content`. Then `messages_userid_timestamp_idx` is fully
      covering → no primary index join, no sort → collapses the ~271ms read and adds no
      storage. (Pairs naturally with the index work.)
- [ ] **State snapshot checkpointing:** on a Redis miss, recompute currently replays a
      user's *entire* history from zero and ignores the already-persisted `states` table.
      Snapshot state durably and replay only from the last snapshot → `messages` becomes
      operationally unnecessary (audit/export only). Precondition for aggressive cold storage.

### Tier 3 — cold storage for dormant users
- [ ] Periodic archival job: for users inactive > N months, write full history to one
      per-user object in GCS/MinIO (`messages/userid=X.ndjson.gz`), then `DELETE` from CRDB.
- [ ] `Chatbase.get()` falls back to the archive blob on a cache-miss for a cold user
      (keyed single-object read = tens of ms + transfer; meets "few seconds to reload").
      Writes stay in CRDB (append/dedup is the DB's job — the reason buckets-only was slow
      originally was the *write* path, not keyed reads).

### Tier 4 — downsize the cluster (the goal)
- [ ] After the working set drops to tens of GB: move `4×240Gi → 3×~50Gi pd-ssd`
      (RF3 min = 3 nodes), lower the `8000Mi` memory requests and `--cache` /
      `--max-sql-memory`, reclaim a `bigpool` node (4→3) or a smaller machine type.
- [ ] **Note:** GKE `pd-ssd` cannot be shrunk in place. This is a provision-new +
      let-CRDB-rebalance + decommission-old sequence — plan it explicitly before touching
      PVCs.

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

# Verify hot-path plan (expect messages_userid_timestamp_idx, no sort)
kubectl -n vprod exec gbv-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach \
  --execute "EXPLAIN SELECT * FROM messages WHERE userid='<real-userid>' ORDER BY timestamp ASC;"

# Verify disk (wait > gc.ttlseconds = 25h after each drop)
for i in 0 1 2 3; do kubectl -n vprod exec gbv-cockroachdb-$i -- df -h /cockroach/cockroach-data | tail -1; done
```
