# TODO — get `messages.account_id` to NOT NULL

**Status: not started. Deliberately deferred 2026-08-20.** The backfill
(`devops/backfill`) is written and tested; this is the step *after* it.

Owner decision recorded: *"No SET NOT NULL yet, we'll do that after."*

## Why it is not just "run the backfill then SET NOT NULL"

The backfill fills every row whose account is derivable from its archived
`content`. Some rows have no account **in any field** — synthetic events written
without a `page`. The extraction rule returns NULL for them by design
(`devops/sql/messages-account-id-expr.sql`, final `ELSE NULL`), and NULL is the
honest answer, not a bug to fix.

Measured on production 2026-08-20, from a 300,000-row sample:

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
that is the ~3,000 rows this pass exists for.

## Steps, in order

1. Run `devops/backfill` to completion against production.
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
