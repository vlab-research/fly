# messages account/platform backfill

Fills `chatroach.messages.account_id` and `.platform` from the per-shape account
fields inside each row's archived `content`.

Replaces `devops/backfill-messages-account.sh`. The rewrite bought one thing:
tests. The extraction *rule* was already covered by
`scribble.TestBackfillSQLMatchesGo`, but the orchestration around it — batching,
the cursor, resume, error detection, idempotency — was 240 lines of bash that
nothing executed, and two other files pointed at a test suite for it that did not
exist.

## Running it

```bash
go run ./devops/backfill --dsn "postgres://root@localhost:5455/chatroach" --dry-run
go run ./devops/backfill --dsn "$BACKFILL_DSN"
```

Against production, port-forward the cluster's CockroachDB and pass that DSN. The
prompt makes you type `vprod` when the DSN looks like production.

| Flag | Default | |
|---|---|---|
| `--dsn` | `$BACKFILL_DSN` | connection string |
| `--batch-size` | 20000 | rows per `UPDATE` |
| `--max-batches` | 20000 | safety stop |
| `--start-hsh` / `--start-userid` | — | resume cursor, printed every batch and on failure |
| `--dry-run` | false | count what each batch would update, write nothing |
| `--rehearse` | false | run the real `UPDATE` in a transaction and **roll it back** |
| `--statement-timeout` | 10m | per statement |
| `--yes` | false | skip the confirmation |

## How it works

The expressions run **server-side**. `messages` is 384 GiB; `content` never
crosses the wire. This process issues `UPDATE`s and moves a cursor, nothing more.

It walks the primary key `(hsh, userid)` in order rather than filtering on
`account_id IS NULL`. That predicate is not an index prefix, so a `WHERE
account_id IS NULL LIMIT n` form is instant while most rows still match and
catastrophic at the end — the final batches scan all 384 GiB to find nothing.

**The cursor is an optimization; the predicate is the guarantee.** Every batch
carries `AND account_id IS NULL`, so re-running over completed rows is a no-op and
correctness never depends on resuming in the right place. Restarting from scratch
after a partial run is always safe.

## Running it safely against production

This walks a 384 GiB table. The order below is the point — each step is cheap and
answers one question before the next one costs anything.

1. **Size the work.** `--dry-run` counts using the same predicate as the real
   statement, takes no locks, and writes nothing.

   ```bash
   go run ./devops/backfill --dsn "$DSN" --dry-run
   ```

2. **Rehearse.** `--rehearse` runs the **real** `UPDATE` inside a transaction and
   rolls it back. Strictly stronger than a count: it proves the expressions
   evaluate against every real shape in the range, that the writes pass every
   constraint and index on the table, and that a batch fits in one transaction —
   then leaves nothing behind.

   ```bash
   go run ./devops/backfill --dsn "$DSN" --rehearse --max-batches 3
   ```

   A rehearsal is **not free**: the rollback discards the work but the work still
   happened, and it holds real locks for the batch. Rehearse a few batches, not
   the table.

3. **Run it on staging first**, to completion. Same command, same data shapes.

4. **Run it on production.** Start with a small `--max-batches` and widen once the
   per-batch timings look sane. It is interruptible: `^C` between batches loses
   nothing, and the cursor is printed every batch and again on failure.

   ```bash
   go run ./devops/backfill --dsn "$DSN" --max-batches 5
   go run ./devops/backfill --dsn "$DSN" --start-hsh <n> --start-userid '<u>'
   ```

5. **Verify.** The gate is in `devops/migrations/26-messages-account.sql` §4:
   rows still *attributable but not yet attributed* must reach 0. A plain
   `count(*) WHERE account_id IS NULL` never reaches 0 and should not — see
   `planning/messages-account-not-null-todo.md`.

### Why an interrupted run is safe

Each batch is **one statement**, so it lands whole or not at all; there is no
half-applied batch. The cursor only advances past a batch that committed. And
`AND account_id IS NULL` means re-running over completed rows is a no-op, so
even resuming at the wrong place — or from scratch — is correct, just slower.

Nothing here is destructive: the only write is filling a column that is NULL,
and rows already carrying an account are excluded by the predicate.

## The rule lives in one place

`devops/sql/messages-account-id-expr.sql` and `messages-platform-expr.sql` are
read at startup and substituted into the batch statement. The same two files are
evaluated by `scribble.TestBackfillSQLMatchesGo` against the shared fixture
`testdata/event-envelope/messenger-account-derivation.json`, which also pins
hermes' Rust and replybot's JS. There is deliberately no second copy of the rule
in this package.

## Tests

```bash
make -C devops test-db PORT=5455
TEST_DATABASE_URL=postgres://root@localhost:5455/chatroach go test ./devops/backfill/...
```

Unit tests cover the statements we build. Integration tests run the real loop
against a real CockroachDB seeded with one row per branch of the rule — including
a malformed-JSON row, because 106M rows of payload going back to 2020 contain
some, and an unguarded `::JSONB` cast on one kills the whole batch permanently.

They cover: every real shape, poison resilience, idempotency, resumability,
restart-from-scratch, coverage at five batch sizes, an empty table, awkward
userids surviving the cursor, a forward-written row arriving mid-run,
`--dry-run` writing nothing, and `--rehearse` executing the real statement while
persisting nothing and reporting the same count the real run writes.

The suite is mutation-checked. Dropping the `account_id IS NULL` guard fails three
tests; turning the batch upper bound from `<=` into `<` fails four, including rows
silently skipped — the failure mode that matters, because a skipped row is never
revisited.

## Not done here

`account_id` is still **nullable**. Roughly 3,000 production rows are synthetic
events carrying no account in any field, so the rule returns NULL for them and
that is the honest answer. Getting to `NOT NULL` needs a sentinel decision for
those rows (`''`, as `chat_log.pageid` already uses) — see migration 26 §4.
