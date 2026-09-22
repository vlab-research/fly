# TODO — get `messages.account_id` to NOT NULL

**Status: not started. Deliberately deferred 2026-08-20. NO LONGER BLOCKED —
the production backfill COMPLETED 2026-08-29 00:20:53 UTC** (5,351 batches,
106,931,189 rows, `chatroach.backfill_cursor done=t`) and was closed out
2026-09-04. See `planning/backfill-in-cluster-job.md` and
`devops/backfill-logs/`. This is the step after it, and it can now start.

> ## ⚠️ THE ~3,000 FIGURE IN THIS DOCUMENT IS WRONG. THE NUMBER IS ~55,000 — 18x LARGER.
>
> **Measured on vprod 2026-09-04:**
>
> ```sql
> SELECT column_names, row_count, null_count, created
>   FROM [SHOW STATISTICS FOR TABLE chatroach.messages]
>  WHERE column_names = ARRAY['account_id'] ORDER BY created DESC LIMIT 1;
> ```
> ```
> column_names   row_count    null_count   created
> {account_id}   108074354    54960        2026-09-03 15:47:18.173725+00
> ```
>
> **This document is written around ~3,000. Plan around ~55,000.**
>
> ### It is a statistics estimate, not an exact count
>
> `SHOW STATISTICS` reports what the last automatic stats collection sampled. It
> is the right order of magnitude and it is **not** an exact figure, so do not
> quote it as one. `null_count` has read 54,960 across three consecutive
> collections (2026-08-31, 09-01, 09-03) while `row_count` moved by a million,
> which is reassuring about the magnitude and is also exactly what a stale
> per-column estimate looks like.
>
> **The exact number comes from migration 26's REMOVAL GATE,
> `devops/migrations/26-messages-account.sql:154-165`, and NOTHING ELSE.**
> ⚠️ **Do not run it casually.** It is costed at **399.3 GiB / 16,532 ranges**
> with no writes; `statement_timeout` is `0` (unlimited) on this cluster, and all
> three backfill pod failures were `57P01 server is shutting down` — a node
> restart mid-scan returns nothing after hours. Recommendation on record: slice it
> over the `hsh` keyspace and sum the slices. Schedule it; do not put it on a
> dashboard.
>
> ### Two independent methods agree on the magnitude
>
> The bounded 20-batch pass of 2026-08-26 extrapolated **~48,800** by a completely
> different route (see below). 49k and 55k from unrelated methods is the reason to
> believe ~55,000 rather than either number precisely.
>
> **Corrected 2026-08-26 from real backfill output**, not from a sample. The
> first 20 committed batches covered 400,000 rows and updated 399,779 — leaving
> **221 untouched**. About 39 of those are rows already stamped forward by the
> 1.3 deploy (excluded by `AND account_id IS NULL`, not unattributable), so
> roughly **182 per 400,000 = 0.046%**, extrapolating to **~48,800 across the
> table**. Caveat, still true: the measured slice is the low end of the `hsh`
> keyspace and may not be representative.
>
> **Why the old ~3,000 sample under-counted:** it counted two specific *causes* —
> `bad_json` and synthetic-with-no-page — at 9 per 300,000. The backfill's own
> figure counts every row the rule returns NULL for, whatever the reason, which
> is the number the sentinel pass actually has to cover.
>
> ### Three consequences, not just a bigger number
>
> 1. **The unbatched sentinel `UPDATE` below is no longer acceptable. Batching is
>    mandatory.** It was defensible at 3,000. At ~55,000 rows in a 399 GiB table
>    it is a single long-running transaction holding locks, on a cluster whose
>    nodes demonstrably restart mid-statement. Reuse `devops/backfill`'s batching
>    and its durable cursor — step 3 already says so; it is now a requirement, not
>    a preference.
> 2. **`''` becomes a ~55,000-row population that every consumer must tolerate**,
>    not a rounding error. Anything that reads `messages.account_id` and treats a
>    non-NULL value as a real Meta graph id will see 55k falsy ones. `''` is still
>    the right sentinel (reasons below), but "a handful of odd rows" is no longer
>    an honest description of what NOT NULL will leave behind.
> 3. **Those rows survive into 3.1 and 3.4.** 3.1 (drop `OR account_id IS NULL`
>    from `chatbase.get()`) is gated on the removal gate reading 0 — which counts
>    *attributable but unattributed* rows, not these — so 3.1 is still reachable,
>    but it ships a read path against a table where 55k rows carry `''`. And 3.4's
>    `pageid` → `account_id` rename inherits them.

Owner decision recorded: *"No SET NOT NULL yet, we'll do that after."*

## Why it is not just "run the backfill then SET NOT NULL"

The backfill fills every row whose account is derivable from its archived
`content`. Some rows have no account **in any field** — synthetic events written
without a `page`. The extraction rule returns NULL for them by design
(`devops/sql/messages-account-id-expr.sql`, final `ELSE NULL`), and NULL is the
honest answer, not a bug to fix.

Measured on production 2026-08-20, from a 300,000-row sample — **superseded, see
the correction at the top of this file**:

```
sampled  bad_json  synthetic-with-no-page
300000          0                       9
```

≈0.003%, so **order 3,000 rows** across 106,275,818. The sample is effectively
uniform: the primary key is `(hsh, userid)` with `hsh = fnv64a(content)`, so scan
order is hash order.

`SET NOT NULL` cannot proceed while those rows exist. So NOT NULL needs a value
for them — the "sentinel pass".

## The sentinel pass

A second, targeted UPDATE that writes a placeholder to rows the rule could not
attribute, run **after** the main backfill has drained:

```sql
UPDATE chatroach.messages
   SET account_id = ''
 WHERE account_id IS NULL;
```

> ⚠️ **Do not run it in that shape.** The statement above states the *intent*; it
> is not the command. It was written when this population was believed to be
> ~3,000. It is **~55,000** (see the correction at the top of this file), in a
> 399 GiB table, on a cluster where three separate backfill pods died to
> `57P01 server is shutting down` mid-statement. An unbatched single-transaction
> `UPDATE` here holds locks for as long as it runs and loses everything on a node
> restart. **Batch it — reuse `devops/backfill` and its durable cursor**, which
> already solved exactly this problem for the main pass. Step 3 below.

`''` rather than a made-up id, and rather than leaving NULL:

- It is **already the convention in this schema.** Migration 27 uses `''` for
  `chat_log.pageid` for exactly this case — see
  `documentation/chat-message-logging.md`, where 14,834 rows are stored under the
  `''` sentinel rather than dropped. Two archival tables should not disagree.
- CockroachDB refuses a nullable column in a primary key (SQLSTATE 42P15), which
  is why `chat_log` needed the sentinel; `messages` does not have `account_id` in
  its key, so this is about column shape rather than key shape — but the reason to
  pick the *same* placeholder is consistency for anyone querying both.
- `''` is falsy in every consumer and cannot be mistaken for a real Meta graph id
  (which are `^[0-9]+$`). A sentinel like `'unknown'` would be a string that looks
  like a name.

**Before running it**, confirm the main backfill is genuinely done — the gate is
in `devops/migrations/26-messages-account.sql` §4. Count rows that are still
*attributable but not yet attributed*; it must be 0:

```sql
SELECT count(*) FROM chatroach.messages
 WHERE account_id IS NULL
   AND json_valid(content)
   AND (<devops/sql/messages-account-id-expr.sql>) IS NOT NULL;
```

A plain `count(*) WHERE account_id IS NULL` never reaches zero and should not —
that is the rows this pass exists for (~3,000 by the old sample, ~48,800 by the
backfill's own output, **54,960 by `SHOW STATISTICS` on 2026-09-03**; the
statistics figure is an estimate, so the gate above is still the only exact
answer).

## Steps, in order

1. ~~Run `devops/backfill` to completion against production.~~ **DONE — completed
   2026-08-29 00:20:53 UTC**: 5,351 batches, 106,931,189 rows,
   `chatroach.backfill_cursor done=t`, 48.8 h wall clock across four pods (three
   `57P01` restarts, each resumed from the cursor). Record:
   `planning/backfill-in-cluster-job.md`, logs `devops/backfill-logs/`.
2. Verify the §4 gate above returns **0**. **NOT RUN, deliberately** — as of
   2026-09-04 this is the outstanding prerequisite. It is a **scheduled 399.3 GiB
   / 16,532-range scan**, and it does double duty: it is both the completion gate
   *and* the only way to get the **exact** unattributable count that replaces the
   54,960 estimate. Slice it over the `hsh` keyspace and sum, rather than running
   it unbatched against an unlimited `statement_timeout` on a cluster that
   restarts nodes.
3. Sentinel pass (the UPDATE above), **batched — mandatory at ~55,000 rows, not
   optional**: reuse `devops/backfill` with a sentinel flag rather than writing
   new bash. Size it off the main run's **sustained 32.8 s/batch**, not off an
   early sample — the main run's own projection, built on its first 47 batches,
   was ~10 h optimistic over 48.8 h.
4. `ALTER TABLE chatroach.messages ALTER COLUMN account_id SET NOT NULL;` as a new
   numbered migration. This is a **validation scan of 384 GiB**, not a rewrite —
   but it is not free and should be scheduled, not slipped in.
5. Only then remove the `OR account_id IS NULL` branch in
   `replybot/lib/chatbase/chatbase.js` (the removal gate is documented there).

## Open sub-questions

- **Does `platform` get the same treatment?** It is nullable too and has a wider
  NULL population (nothing writes it for `responses`/`chat_log` yet — migration 26
  §1). NOT NULL on `platform` is a separate decision and is **not** covered here.
- **A row with no derivable account but a derivable platform is skipped entirely**
  by the backfill (`AND (<account>) IS NOT NULL`). Measured empty on production —
  zero of the 9 no-page rows carry a `platform` — and pinned by
  `TestARowWithNoDerivableAccountIsSkippedEvenIfItsPlatformWasDerivable`. If that
  test ever fails, this decision needs revisiting before the sentinel pass.
