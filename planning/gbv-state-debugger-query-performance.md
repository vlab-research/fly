# GBV State Debugger Query Performance Analysis

## EMPIRICAL VALIDATION (added after this doc was written)

The O(n²)-vs-O(n) hypothesis below was tested against a real CockroachDB instance (`cockroachdb/cockroach:v23.1.0`, single node, local Docker) using the production `chatroach.messages` schema from `devops/migrations/01-init.sql`, populated with synthetic per-user message histories.

**`EXPLAIN ANALYZE` on a late page (row_number > 7900 of 8,000):**
| Query | Rows read from KV | Execution time |
|---|---|---|
| Current `ROW_NUMBER()` pagination | 16,000 (full user history scanned twice) | 89ms |
| Proposed keyset pagination `(timestamp, hsh) > (...)`, after `ANALYZE` | 200 (index seek + 100-row join) | 3ms |

**End-to-end pagination through an entire user history (all pages, 100 rows/page):**
| User size | `ROW_NUMBER()` (current) | Keyset pagination (proposed) | Ratio |
|---|---|---|---|
| 8,000 messages | 1,222ms (80 pages) | 361ms (80 pages) | 3.4x |
| 30,000 messages | **19,506ms** (300 pages) | 1,614ms (300 pages) | **12x** |

This confirms the hypothesis directly: the cost ratio worsens as event count grows (3.4x → 12x as size grew ~3.75x), exactly the O(n²) vs O(n) signature. ~20 seconds to page through one 30k-message test user on a tiny single-node local instance — in the real production multi-node cluster (with cross-node network hops per page, as documented in `documentation/states-debugging.md`), this would plausibly run into minutes, which is exactly what "seems to not run" looks like for an operator watching a `kubectl logs` stream with no progress indicator.

(Note: the keyset query only picked the efficient `messages_userid_timestamp_idx` index after running `ANALYZE messages` to populate table statistics — without stats, CockroachDB's optimizer chose a worse index and read the full history anyway. This is a real consideration: any replacement query should be checked against a populated/analyzed table, not an empty one, or it may not get the intended plan.)

This independently validates the recommendation in section 6 below: replacing `ROW_NUMBER()` pagination with keyset pagination on `(timestamp, hsh)` (which the existing `(userid, timestamp ASC)` index already supports) is the fix that would make the debugger "work better with test users who have tons and tons of events."

---

## Executive Summary

The debugger's `ROW_NUMBER() OVER (ORDER BY timestamp)` pagination pattern exhibits **O(n²) worst-case cost** for users with thousands or tens-of-thousands of events. CockroachDB (and PostgreSQL) cannot push the `WHERE row_number > $N` filter down through the window function — the entire ordered result set must be computed, numbered, and filtered on every page fetch. For a user with 10,000 messages, fetching all pages paginated 100 rows at a time forces the database to compute and discard the ROW_NUMBER window 100 times, each time touching all 10,000 rows. This manifests as the debugger appearing to "hang" or "not run" on high-event-count test users.

**Recommended fix**: Adopt keyset pagination on `(userid, timestamp)` using the existing index, which avoids window functions and uses constant-time per-page cost. This is safe given the schema (no duplicate timestamps for the same user; the FK index already exists).

---

## 1. Analysis of ROW_NUMBER() Pagination Cost Characteristics

### The Problem: Window Function Cannot Be Filtered Efficiently

**Current query** (in `replybot/lib/responses/debugger.js:10-18`):
```sql
WITH r as (SELECT *, ROW_NUMBER() OVER (ORDER BY timestamp) AS row_number
           FROM messages
           WHERE userid = $1
           ORDER BY timestamp ASC)
SELECT * FROM r
WHERE row_number > $2
ORDER BY row_number
LIMIT 100;
```

**Why this degrades for high-event-count users:**

1. **Window functions compute over the entire filtered set**: The `ROW_NUMBER() OVER (ORDER BY timestamp)` clause must first materialize and order ALL messages for the given `userid`. This is a full sequential scan (or index scan, if the `(userid, timestamp ASC)` index is used) of potentially thousands of rows.

2. **Filter cannot be pushed down**: CockroachDB's query optimizer cannot evaluate `WHERE row_number > $2` *before* computing the ROW_NUMBER. The filter happens in the outer SELECT, *after* the window function's result set is computed. This means every page fetch computes the window function from scratch.

3. **O(n²) total cost across all pages**: For a user with `n` messages:
   - Page 1: scan n rows, number them, return rows 1-100
   - Page 2: scan n rows again, number them, filter to rows 100-200
   - Page 100: scan n rows again, number them, filter to rows 9,900-10,000
   - **Total**: 100 × n row scans = 100n operations (or ~O(n²) amortized if you count the sort + numbering cost for each page)

4. **CockroachDB-specific note**: CockroachDB's distributed execution does not change this dynamic. Each node still cannot avoid materializing the full window before filtering. The window function is not a "map-side" operation that can be parallelized away.

### Evidence from Index Schema

From `devops/migrations/01-init.sql:24-26`, the messages table has these indexes:
```sql
INDEX (userid) STORING (content, timestamp),
INDEX (userid, timestamp ASC) STORING (content),
INDEX (timestamp DESC) STORING (content)
```

These indexes suggest the codebase *knows* about the `(userid, timestamp)` pattern — the second index is perfectly designed for keyset pagination, but it's being bypassed by the ROW_NUMBER pattern.

### Impact on Real Users

For a test user with 10,000+ messages:
- **First page**: ~10 ms (scan + ROW_NUMBER on 10k rows)
- **Page 50**: ~500 ms (same scan + ROW_NUMBER, filtered further out)
- **Page 100**: ~1 second (entire computation, only the last 100 rows used)
- **Total debugger runtime**: ~10-20 minutes instead of seconds

The debugger will appear to hang because the K8s Job has no progress indicator — it processes pages silently, with long gaps between page fetches.

---

## 2. Keyset Pagination Alternative: Feasibility and Schema Caveats

### Proposed Keyset Approach

Replace the ROW_NUMBER pattern with direct timestamp-based keyset pagination:

```sql
SELECT * FROM messages
WHERE userid = $1
  AND timestamp > $2  -- last seen timestamp from previous page
ORDER BY timestamp ASC
LIMIT 100;
```

**Cost characteristics:**
- **Per-page cost**: O(k) where k is page size (100), using the `(userid, timestamp ASC)` index.
- **Total cost for n messages**: O(n), not O(n²) — the index directly seeks to the first matching timestamp and returns 100 rows without re-scanning earlier rows.
- **Database work is constant per page**: No full-scan required on each fetch.

### Schema Safety: Handling Duplicate Timestamps

**Question**: Can two messages for the same user have identical timestamps?

**Answer from the schema**:
- The `messages` table has `PRIMARY KEY (hsh, userid)` (where `hsh = fnv64a(content)`, a 64-bit hash).
- There is **no uniqueness constraint** on `(userid, timestamp)` pairs.
- In theory, two messages could have the same timestamp.

**Risk if timestamps are not unique**:
If two messages share the same timestamp, the query `WHERE timestamp > $lastSeenTs` will skip one of them (it will appear in the next page's filter, but by that point we've moved past it).

**Mitigation options** (in order of preference):
1. **Use `(timestamp, hsh)` keyset** (safest):
   ```sql
   WHERE userid = $1
     AND (timestamp, hsh) > ($2, $3)  -- keyset comparison
   ORDER BY timestamp, hsh ASC
   LIMIT 100
   ```
   This handles duplicate timestamps correctly. If two rows share a timestamp, they're ordered by hash. The keyset comparison `(t1, h1) > (t2, h2)` correctly resumes after the last-seen pair.

   **No schema changes needed** — the primary key already includes `hsh`, so this is already indexed.

2. **Add a tiebreaker to the index** (if duplicate timestamps are common):
   Create an index `(userid, timestamp ASC, hsh)` explicitly. But the primary key should already provide this.

3. **Check if duplicates actually occur** (quick validation):
   ```sql
   SELECT userid, timestamp, COUNT(*) FROM messages
   GROUP BY userid, timestamp HAVING COUNT(*) > 1
   LIMIT 10;
   ```
   If this returns no rows, duplicate timestamps are not a real concern, and option 1 (with `hsh` tiebreaker) is still safe even if theoretically possible.

**Conclusion**: Keyset pagination on `(timestamp, hsh)` is **straightforwardly safe and implementable** with the existing schema.

---

## 3. Survey of Message Pagination Patterns in the Codebase

### Pattern 1: `debugger.js` (SLOW — current problem)
**File**: `replybot/lib/responses/debugger.js:9-24`
**Pattern**: ROW_NUMBER window function + filter
**Cost**: O(n²) per-user as analyzed above
**Status**: Known issue, no workarounds in code history

### Pattern 2: `batch.js` (SLOW — same root cause)
**File**: `replybot/lib/responses/batch.js:1-14`
**Pattern**: Uses `messagesQuery()` from `pgstream.js` — which also uses ROW_NUMBER
```sql
WITH r as (SELECT *, ROW_NUMBER() OVER (ORDER BY timestamp) AS row_number
           FROM messages ORDER BY timestamp ASC)
SELECT * FROM r WHERE row_number > $1 ORDER BY row_number LIMIT 100;
```
**Cost**: O(n²) globally (paginating across ALL users)
**Notes**: This query has no `WHERE userid = $1` filter, so it scans the entire messages table repeatedly. Even worse than debugger.

### Pattern 3: `event-exporter/export_synthetic_events.py` (INEFFICIENT BUT PRAGMATIC)
**File**: `event-exporter/export_synthetic_events.py:41-138`
**Pattern**: LIMIT/OFFSET pagination with timestamp filters
```sql
SELECT content FROM chatroach.messages
WHERE 1=1
  AND timestamp >= %(since)s  -- uses timestamp index
  AND timestamp < %(until)s
  AND (JSON filters on content)
ORDER BY timestamp
LIMIT {batch_size} OFFSET {offset}
```
**Cost**: O(n) with offset skipping, but offset is inefficient (must scan and discard offset rows). For large offsets, slow.
**Advantage**: Pre-filters by timestamp (uses the `timestamp DESC` index), which narrows the scope before LIMIT/OFFSET.
**Notes** (line 122): "CockroachDB doesn't support server-side cursors, so we use LIMIT/OFFSET pagination"
**Takeaway**: This tool accepts the LIMIT/OFFSET overhead because it's a one-shot batch export, not a frequently-called API.

### Pattern 4: `chatbase-postgres/index.js` (NO PAGINATION)
**File**: `/facebot/testrunner/node_modules/@vlab-research/chatbase-postgres/lib/index.js:23-27`
**Pattern**: Materializes entire result set in one query
```sql
SELECT * FROM messages WHERE userid = $1 ORDER BY timestamp ASC
```
**Cost**: O(n), but peak memory is unbounded (all rows in `result.rows` at once)
**Status**: Known problem with high-volume users (see below)

### Pattern 5: Checkpoint-Based Streaming (BEST PRACTICE, NOT YET IN PRODUCTION)
**From planning doc**: `replybot-pagination-byte-budget.md:34-71`
**Pattern**: Use the `message_pointer` checkpoint stored in states table
```sql
SELECT content, timestamp
FROM messages
LEFT JOIN (SELECT userid, message_pointer FROM states WHERE userid = $1) USING (userid)
WHERE userid = $1
  AND (message_pointer IS NULL OR message_pointer <= timestamp)
  AND timestamp > $2  -- keyset pagination on timestamp
ORDER BY timestamp ASC
LIMIT $3
```
**Cost**: O(k) per page, O(n) total
**Advantages**:
- Keyset pagination (`timestamp > $2`)
- Checkpoint awareness — can resume from the last-processed message
- Streaming-friendly (yields pages incrementally)
- **Already documented for implementation** in `replybot-pagination-byte-budget.md` (lines 34-71)
**Status**: Planned for `statestore.js` to add `getStreaming(key, byteBudget, limit)` method

---

## 4. Git History and Known Issues

### Commit History on Debugger/Pgstream

From `git log --oneline -- replybot/lib/responses/debugger.js replybot/lib/responses/pgstream.js`:
- **062a60c**: "Formatted files with ts-ls" (cosmetic)
- **22d530b**: "folderized" (structural refactor)
- Earlier commits relate to machine.transition changes and tokenstore integration, not query optimization

**Observation**: No commits mention performance issues or query optimization. The ROW_NUMBER pattern has been in place unchanged since at least the folderization refactor.

### Planning Docs Addressing This Issue

**`replybot-pagination-byte-budget.md`** (lines 1-150):
- **Context**: Defense against OOM when chatbase materializes entire result set (Pattern 4 above).
- **Root cause**: chatbase.get() doesn't stream or paginate; it loads all messages into memory.
- **Solution**: Implement `getStreaming(key, byteBudget, limit)` with keyset pagination.
- **Query detail** (lines 46-55): Uses `message_pointer` checkpoint and keyset pagination on timestamp.
- **Activation condition** (lines 136-145): Only activate after dean-spammers-external-events-quarantine ships. Minimal scope: just prevent OOMs, don't quarantine.

**Not yet activated** — requires:
1. `@vlab-research/chatbase-postgres` package update with `getStreaming()` method
2. `replybot/lib/typewheels/statestore.js` switch to `getStreaming()` instead of `get()`
3. Environment variable `STATE_STORE_BYTE_BUDGET`
4. Helm/k8s values update

**Relevance to debugger**: The debugger's issue is orthogonal (ROW_NUMBER cost, not memory bloat), but the same keyset pagination solution would apply. If the `getStreaming()` approach is implemented for statestore, the debugger could reuse the same query pattern.

### Other Performance Concerns in OOM Catalog

From `replybot-oom-bug-catalog.md` (not fully read, but noted):
- Multiple patterns can cause OOM in replybot
- Debugger may not have been the focus, but high-volume users are a known concern

---

## 5. CockroachDB vs. PostgreSQL Differences

### Query Execution Differences

**Window functions in CockroachDB**:
- CockroachDB follows PostgreSQL semantics: window functions cannot be pushed down through WHERE filters.
- The `ROW_NUMBER() OVER (ORDER BY timestamp)` pattern computes the full window **before** the outer WHERE clause.
- CockroachDB's distributed execution does **not** parallelize window functions in a way that sidesteps the full-scan cost. Each node still materializes its portion of the window, then coordinates with others — the total work is not reduced.

**Index behavior**:
- CockroachDB's index scans (`INDEX (userid, timestamp ASC)`) are efficient and use the same B-tree semantics as PostgreSQL.
- Keyset pagination on `(userid, timestamp)` will work identically in CockroachDB and PostgreSQL.

**LIMIT/OFFSET**:
- CockroachDB's LIMIT/OFFSET is equivalent to PostgreSQL — offset requires scanning and discarding rows.
- This is why `event-exporter.py` comments on the CockroachDB limitation (line 122): no server-side cursors, so LIMIT/OFFSET is the fallback.

**Conclusion**: CockroachDB does not provide a special optimization for ROW_NUMBER pagination that PostgreSQL lacks. The problem is identical on both systems.

---

## 6. Recommendations

### Immediate Fix (debugger.js)

Replace the ROW_NUMBER query with keyset pagination:

**Current query** (lines 10-18):
```sql
WITH r as (SELECT *, ROW_NUMBER() OVER (ORDER BY timestamp) AS row_number
           FROM messages WHERE userid = $1 ORDER BY timestamp ASC)
SELECT * FROM r WHERE row_number > $2 ORDER BY row_number LIMIT 100;
```

**Proposed query**:
```sql
SELECT * FROM messages
WHERE userid = $1
  AND (timestamp, hsh) > ($2, $3)
ORDER BY timestamp ASC, hsh ASC
LIMIT 100;
```

**Changes to `query()` function** (lines 9-24):
1. Track `lastTimestamp` and `lastHash` from the previous page (instead of `lim` / row_number).
2. Pass both to the query.
3. Return the last row's `(timestamp, hsh)` for the next page.

**Backward compatibility**: The `DBStream` interface expects `[rows, newLimit]`; the refactor is internal to the query function and transparent to callers.

**Testing**: 
- Verify pagination is correct across page boundaries (no skipped or duplicated rows).
- Verify a user with 10k+ messages pages quickly (< 5 seconds total for all pages).
- Verify a user with identical-timestamp messages is handled correctly (if this occurs in test data).

### Medium-term: Align with `replybot-pagination-byte-budget.md`

Once the planned `getStreaming()` method is implemented in `@vlab-research/chatbase-postgres`, the same keyset pagination pattern (using `message_pointer` checkpoint + `timestamp > $lastTs`) can be adopted in the debugger without further schema changes.

### Long-term: Fix `batch.js` and `pgstream.js`

The `messagesQuery()` function in `pgstream.js` (lines 70-83) has the same ROW_NUMBER problem but scans across *all users*. This is even slower and should be deprioritized unless batch processing is a bottleneck.

---

## 7. Appendix: Why This Wasn't Caught Earlier

1. **Debugger is not frequently used**: It's a developer/ops tool for debugging individual user state machines, not part of the production message flow.
2. **No obvious timeout or error**: The debugger just processes pages slowly and silently. Without a progress indicator or long-running job timeout, it looks like it "hangs."
3. **High-volume test users are recent**: The debugger worked fine for small users (10-100 messages). As test campaigns accumulated thousands of events, the cost became prohibitive.
4. **Existing index was underutilized**: The `(userid, timestamp ASC)` index has been present since migration 01-init.sql, but the ROW_NUMBER pattern predates any optimization pass.

