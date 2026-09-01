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

### Two things that will bite you first — both hit for real on 2026-08-24

**1. `--sql-dir` resolves against your cwd, not the binary.** The default is
"`../sql` relative to this binary's source", but in practice it is looked up as the
relative path `devops/sql/...`, so it only works from the repo root. Running from
`devops/backfill` — the obvious place — fails with:

```
ERROR: reading devops/sql/messages-account-id-expr.sql: no such file or directory
```

Pass it explicitly and the problem disappears: `--sql-dir "$PWD/../sql"`.

**2. Port 5455 in the example above is the LOCAL DEV CockroachDB.** It is very
likely already listening (docker-compose), so a `kubectl port-forward ... 5455`
fails with `address already in use` — and if you *don't* notice, following the
example verbatim points this tool at the wrong database. Forward a cluster to a
different port, and **prove which database you reached before pointing a write tool
at it**:

```bash
kubectl port-forward -n <ns> pod/gbv-cockroachdb-0 5457:26257 &
psql "postgres://root@localhost:5457/chatroach?sslmode=disable" \
  -c "SELECT count(*), count(account_id) FROM chatroach.messages;"
# must match what `kubectl exec -n <ns> gbv-cockroachdb-0 -- ./cockroach sql` reports
```

### Timing and disk

Counting (`--dry-run`) ran ~100 s per 20,000-row batch on vstag; real `UPDATE`s are
several times slower. Budget hours on production's 101M+ rows.

`messages` has no column families, so setting `account_id` rewrites the **whole
row** — `content` included — into every index. That MVCC garbage is held for
`gc.ttlseconds`: 14400 (4h) on vstag but **90000 (25h) on production**, so on a
multi-hour production run the garbage accumulates for the entire run rather than
being reclaimed behind you. Watch it:

```bash
kubectl exec -n <ns> gbv-cockroachdb-0 -- df -h /cockroach/cockroach-data
```

### Measured on vstag, 2026-08-24 — do not transfer these to production

| | |
|---|---|
| rows total / needing backfill | 162,691 / 162,567 |
| `--dry-run` | **153,776 attributable, 9 batches, reached END** |
| `--rehearse --max-batches 3` | 56,701, batch counts identical to the dry-run |
| permanently unattributable | **8,791** — synthetic events with no account in `content` |

Staging's data is synthetic-heavy, so that 8,791 is not a preview of production's
(~3,000 by an older estimate). Re-derive it. See
`planning/messages-account-not-null-todo.md`.

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
| `--cursor-key` | `$BACKFILL_CURSOR_KEY` | persist the cursor in `chatroach.backfill_cursor` under this key and resume from it automatically. Empty keeps the cursor on stdout only. |

## The durable resume cursor

By default the cursor exists only in stdout. That was enough while this was a
25-minute run driven by hand; it is thin for the ~41-hour production run, where
recovery would mean scraping a log line out of a pod that may already have been
garbage collected — and failing that, restarting at the beginning of a 107M-row
keyspace.

Pass `--cursor-key <name>` and the position is written to
`chatroach.backfill_cursor` after every committed batch
(`devops/migrations/31-backfill-cursor.sql` — apply it first). Then:

- a restart with **no** `--start-*` flags resumes by itself, and says so;
- `--start-hsh`/`--start-userid` still win when given, because an operator
  overriding the stored position is doing it deliberately;
- a run that already reached the end exits immediately instead of re-walking the
  table to update nothing;
- `batches` and `rows_updated` accumulate **across restarts**, so the totals an
  operator is watching do not reset to zero when a pod is replaced.

```sql
SELECT * FROM chatroach.backfill_cursor;
```

Three properties are worth stating because they are what make it safe:

**The cursor is written after the batch, never before.** A cursor ahead of its
work would make a restart skip that batch's rows, and a skipped row is never
revisited. Lagging by one batch is harmless — `AND account_id IS NULL` makes
redoing it a no-op — so lagging is the correct direction to fail in.

**It is not written in the batch's transaction, deliberately.** Each batch is one
statement, which CockroachDB runs as an implicit transaction and can retry at the
gateway. An explicit `BEGIN`/`COMMIT` around the `UPDATE` and the cursor upsert
would push retryable serialization errors (40001) out to a client that has no
retry loop — trading a harmless one-batch race for a new way to abort a two-day
job.

**`--dry-run` and `--rehearse` never move it.** A rehearsal rolls its work back;
if it advanced the stored cursor, the next real run would skip every range it
rehearsed.

A missing table or a missing grant is fatal **at startup** — the tool reads the
cursor and writes a probe row before doing any work, so a broken sink cannot be
discovered 40 hours in. A write failure *during* the run is a loud warning and
the run continues: the batch is already durable and the cursor is still on
stdout.

## Running it in the cluster

Against production this is a ~41-hour run, so it ships as an image and runs as a
Kubernetes `Job` rather than through a port-forward. See
`planning/backfill-in-cluster-job.md` for the whole procedure and
`devops/vlab/templates/messages-backfill-job.yaml` for the Job itself.

```bash
git tag backfill-v0.1.0 && git push origin backfill-v0.1.0   # CI publishes to ghcr
# then set messagesBackfill.enabled: true in devops/values/production.yaml and
helm upgrade gbv vlab -f values/production.yaml -n vprod
```

Three things about the image, all of which are startup failures if missed:

- **The build context is `devops/`, not `devops/backfill/`** — the `*-expr.sql`
  files live outside this directory and Docker cannot reach above its context.
  `.github/workflows/release.yml` carries the matching `file:` input; this is the
  only service whose Dockerfile is not at `<context>/Dockerfile`.
- **`--sql-dir=/app/sql` must be passed**, because the default is a relative path
  resolved against the working directory.
- **`--yes` must be passed**, or the process blocks forever on a prompt no Job
  can answer.

### The database user must be `root`

Every service in the chart connects as `chatroach`. On `chatroach.messages` that
user holds only `INSERT` and `SELECT` — verified on vprod 2026-08-26:

```
chatroach | INSERT
chatroach | SELECT
```

So a backfill running as the service user connects cleanly, prints a healthy
banner, and then fails on its **first** `UPDATE`. The Job connects as `root`
(the cluster is insecure, so no password). Do not widen the service user's
grants to suit a one-off migration.

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

The cursor tests need `devops/migrations/31-backfill-cursor.sql` applied to the
test database; they skip with a pointer to it if the table is absent. They cover
the round trip, an unset cursor staying distinguishable from `hsh = 0`, totals
accumulating across restarts, a resume from the *stored* position deriving a
correct table, and neither `--dry-run` nor `--rehearse` moving it.

The suite is mutation-checked. Dropping the `account_id IS NULL` guard fails three
tests; turning the batch upper bound from `<=` into `<` fails four, including rows
silently skipped — the failure mode that matters, because a skipped row is never
revisited. Removing the dry-run/rehearse guard on the cursor save fails two;
moving the save ahead of its batch fails with rows left NULL — the same
silent-skip signature.

## Not done here

`account_id` is still **nullable**. Roughly 3,000 production rows are synthetic
events carrying no account in any field, so the rule returns NULL for them and
that is the honest answer. Getting to `NOT NULL` needs a sentinel decision for
those rows (`''`, as `chat_log.pageid` already uses) — see migration 26 §4.
