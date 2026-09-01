# TODO — get `messages.account_id` to NOT NULL

**Status: not started. Deliberately deferred 2026-08-20.** The backfill
(`devops/backfill`) is written and tested; this is the step *after* it. **The
production backfill is RUNNING as of 2026-08-26 23:30 UTC** — see
`planning/backfill-in-cluster-job.md`. Do not start this until it completes.

> ## ⚠️ THE ~3,000 FIGURE BELOW IS PROBABLY LOW BY AN ORDER OF MAGNITUDE
>
> **Corrected 2026-08-26 from real backfill output**, not from a sample. The
> first 20 committed batches covered 400,000 rows and updated 399,779 — leaving
> **221 untouched**. About 39 of those are rows already stamped forward by the
> 1.3 deploy (excluded by `AND account_id IS NULL`, not unattributable), so
> roughly **182 per 400,000 = 0.046%**, extrapolating to **~48,800 across the
> table** against the ~3,000 this document is written around.
>
> **Why the old sample under-counted:** it counted two specific *causes* —
> `bad_json` and synthetic-with-no-page — at 9 per 300,000. The backfill's own
> figure counts every row the rule returns NULL for, whatever the reason, which
> is the number the sentinel pass actually has to cover.
>
> **Do not plan the sentinel pass around 3,000.** Neither number is authoritative
> yet: the measured slice is the low end of the `hsh` keyspace and may not be
> representative. **Re-derive with the migration 26 §4 gate once the backfill
> finishes** (see "Steps, in order" below) and correct this document then. The
> sentinel `UPDATE` is unbatched as written below, which is defensible at 3,000
> and is not at 50,000 — reuse `devops/backfill`'s batching, as step 3 already
> says.

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
that is the rows this pass exists for (~3,000 by the old sample, **~48,800 by the
backfill's own output**; re-derive before acting).

## Steps, in order

1. Run `devops/backfill` to completion against production. **In flight since
   2026-08-26 23:30 UTC** as an in-cluster Job; `planning/backfill-in-cluster-job.md`
   has the completion runbook.
2. Verify the §4 gate above returns **0**.
3. Sentinel pass (the UPDATE above), batched the same way — reuse
   `devops/backfill` with a sentinel flag rather than writing new bash.
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
