# Database Migrations

How schema changes reach the CockroachDB clusters (`vstag`, `vprod`). The
`chatroach` database has no migration framework or applied-migrations table.
Each migration is a SQL file, applied once per environment by hand, with its
status recorded in the plan that called for it.

## Where migrations live

| Path | For |
|---|---|
| `devops/migrations/NN-*.sql` | Pure schema changes that work on any CockroachDB cluster. Dev and test runners (`Makefile` `test-db`, `scripts/bootstrap-fly.sh`) glob this directory. |
| `devops/migrations/prod/NN-*.sql` | Anything that needs production-only resources (a GCS bucket, Workload Identity, a license) or production-only tuning. Subdirectories are skipped by the dev runners. |

Numbers are assigned in order of authoring, not of application. Suffixes
(`28a`, `28b`) mark one change split into steps that must be applied in order
with something in between.

## Running one

```bash
devops/run-migration.sh <namespace> <migration-file.sql>
```

`vprod` asks for the namespace to be typed back; other namespaces ask yes/no.
The answer is read from stdin, so `echo vprod | devops/run-migration.sh vprod
<file>` runs unattended.

### What the runner does

1. Reads the CockroachDB image from the live `gbv-cockroachdb` StatefulSet, so
   the client always matches the server's version.
2. Creates a Job, `migration-<file>-<UTC timestamp>`, with `backoffLimit: 0`; a
   migration is never retried automatically. The SQL file goes into a ConfigMap
   owned by that Job.
3. The Job runs `cockroach sql --file --echo-sql` against
   `gbv-cockroachdb-public`, database `chatroach`.
4. The script streams the Job's log, then reports from the **Job's status**, not
   from the stream.

The SQL runs inside the cluster, so a dropped laptop connection, a closed lid or
Ctrl-C only stops the watching; the migration carries on. The script prints how
to follow it:

```bash
kubectl -n <ns> logs -f job/<job>
kubectl -n <ns> get job <job>
kubectl -n <ns> get jobs -l app.kubernetes.io/name=migration-runner   # history
```

Finished Jobs, with their logs and the exact SQL that ran (in the ConfigMap),
are kept for 7 days (`ttlSecondsAfterFinished`).

## Semantics a migration author must know

**The file is one session.** A `SET` at the top applies to every statement after
it. Session settings a migration depends on belong **in the file**, not in an
apply-time incantation. The canonical case: a large `CREATE INDEX` on `messages`
or `responses` needs `SET use_declarative_schema_changer = 'off'` and a smaller
`bulkio.index_backfill.batch_size`, or the backfill can wedge silently (see the
header of `devops/migrations/26-messages-account.sql`). Cluster settings
(`SET CLUSTER SETTING`) outlive the session, so `RESET` them at the end of the
file.

**Execution stops at the first error, and there is no implicit transaction.**
Statements before the failing one have committed. Write migrations to be safely
re-runnable (`IF EXISTS`, `IF NOT EXISTS`). Put precondition guards at the top
using `crdb_internal.force_error`, which aborts the run before anything changes:

```sql
SELECT crdb_internal.force_error('XXUUU', 'precondition failed: <why>')
FROM (SELECT count(*) AS n FROM ... WHERE <precondition holds>)
WHERE n = 0;
```

**Schema changes can finish after the statement returns.** `DROP INDEX` returns
quickly while the space returns only after `gc.ttlseconds` (25h on production).
A schema-change job can outlive a failed or cancelled session. After any DDL,
verify against the schema (`SHOW INDEXES`, `SHOW CREATE TABLE`) and
`crdb_internal.jobs`, and treat the runner's verdict as necessary but not
sufficient.

## Production checklist

- Run it on `vstag` first, unless it is a `prod/` migration.
- Read the file's header: most carry preconditions, a verification query and a
  rollback.
- Prefer off-peak for anything that rewrites or drops a large index.
- Record the outcome (date, Job name, verification) in the plan or document
  that called for the migration.
