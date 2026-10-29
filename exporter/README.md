# Fly Exporter

A database-polling service that processes export jobs for survey responses, chat logs, and message history, writing CSVs to object storage.

## Architecture

The exporter runs as a set of daemon worker threads that continuously poll the `export_status` table in CockroachDB for jobs to process. Each worker:
1. Calls `claim_job()` every `POLL_INTERVAL_SECONDS` to atomically claim a `Requested` job and transition it to `Processing`
2. Calls `process_job()` to execute the export (querying data, formatting to CSV, uploading to storage)
3. Updates the job to `Finished` on success; on failure `run_job()` resets it to `Requested` for a retry, or marks it `Failed` when that was its last attempt or the error would recur

Stale jobs (jobs stuck in `Processing` longer than `STUCK_TIMEOUT_MINUTES`) are automatically reset back to `Requested` for reprocessing.

## Export Types & Sources

**KAFKA_TOPIC:** The topic on which to listen for message
**KAFKA_SERVERS:** Comma seperated list fo kafka brokers to listen on
**KAFKA_GROUP_ID:** Kafka Group ID
**APP_NAME:** identifier of the application
**DATABASE_URL:** the full url to access the database.

> **The scheme must be `postgres://` or `postgresql://`.** The exporter connects
> with psycopg (libpq) directly, *not* SQLAlchemy, and libpq recognises only
> those two as connection URIs. A `cockroachdb://` URL — valid as a SQLAlchemy
> dialect, and what CockroachDB's own docs often show — is not rejected as an
> unknown scheme. It falls through to keyword/value DSN parsing, which splits on
> the `=` in `?sslmode=disable` and fails at connect time with:
>
> ```
> invalid connection option "cockroachdb://root@host:26257/chatroach?sslmode"
> ```
>
> This took down every staging export worker for 7 days. See
> `documentation/secrets.md`.
**STORAGE_BACKEND:** Storage backend to use, current options supported are `google` and `s3`

The exporter supports three export sources, each with its own handler:

- **`responses`**: Survey response data in pivot or flat format. See `export_data()` in `exporter.py` and the vlab-prepro library for formatting options.
- **`chat_log`**: Conversation history with optional raw payload and metadata fields, written row by row with no preprocessing. See `export_chat_log()` in `exporter.py`.
- **`full_messages`**: Complete message history with event-type filtering and optional raw JSON. Parses Messenger, WhatsApp and synthetic rows, one parser per source, into event types grouped as conversation, referrals, payments, system, etc. See `export_full_messages()` in `exporter.py` and `documentation/full-messages-export.md` for details.

### Responses and chat_log: batches of users

Both exports fetch the survey's userids once, sorted, then query and write
`EXPORT_USER_BATCH_SIZE` users at a time, appending to a temp CSV that is
uploaded with `save_file()` at the end. `full_messages` does the same with its
own batch size of 500. Memory therefore depends on the batch size, not the
survey; the temp file on the pod's disk holds the whole CSV.

A responses batch is Polars from end to end: the query's rows go straight
into a `pl.DataFrame` (`RESPONSE_SCHEMA`), run through the vlab-prepro
pipeline (`format_data()`; vlab-prepro returns Polars when given Polars), and
are appended with `write_csv`. pandas is not used. Running the pipeline per
batch is correct because every step it uses needs only one user's rows
(`keep_final_answer`, `drop_users_without`, `drop_duplicated_users`,
`add_duration` and `pivot` all group by user; form data and metadata are
row-wise). Batches must still write identical columns, formatted identically:

- **Form data** is fetched once and passed whole to every batch, so flattened
  form-metadata columns get the same type in each. A key of ints missing on
  some version is written as floats (`1.0`) everywhere.
- **Metadata columns** (`ad_id`, always, plus the requested keys) are each
  row's own JSON value as text (`metadata_value()`), never a type inferred
  over the rows at hand: strings as they are, numbers as Polars prints them
  (ints as written, so `1`, never `1.0`), booleans `True`/`False`, objects and
  arrays as compact JSON, null or absent empty. A key is named
  `<key>_metadata` when any question in the survey has that ref
  (`get_question_refs()`). A key containing a backslash can't be expressed as
  a JSONPath, so it fails the export as invalid options.
- **Pivot columns** are the key columns sorted, then every question_ref in the
  survey sorted, so a question no user in a batch, or in the export, answered
  is an empty column.

`csv_frame()` writes values the way pandas' `to_csv` does, so files read the
same as pandas-made exports of the same study: booleans `True`/`False`, floats
as Python's `repr` (`12.0`, `1e-05`), timestamps as `str(pd.Timestamp)` (a
fraction only when non-zero: `2020-01-01 12:00:00+00:00`,
`2020-01-01 12:00:00.123456+00:00`), empty strings and nulls as empty fields,
minimal quoting, `\n` line ends.

The long format's header is the first non-empty batch's columns; a batch with
other columns fails the export. A batch left with no rows (e.g. every user
dropped by `drop_users_without`) is skipped. An export with no rows at all is
an empty file (`chat_log`: header only).

Compared with the whole-survey pandas export (vlab-prepro 0.5.3, kept in
`tests/reference_export.py`), rows can come out in a different order (batches
are in userid order), pivot columns are in the fixed order above, and
metadata cells differ where pandas inferred a type for the whole column: an
int in a column pandas made float is `1` rather than `1.0`, an object is
`{"a":1}` rather than `{'a': 1}`, and a float below 1e-4 is `0.000025` rather
than `2.5e-05`. Everything else is the same cell for cell and byte for byte;
`tests/test_batched_export.py` and `tests/test_export_db_integration.py` check
this, the latter against CockroachDB.

Progress is written to `export_status.metadata` as it goes: `users` and
`batches` up front, then a running `responses` (responses only), `rows` and
`batches_done` after each batch.

### One snapshot per export

Every read of an export (`responses`, `chat_log` and `full_messages`) is
`AS OF SYSTEM TIME` one timestamp, `follower_read_timestamp()` taken when the
export starts (`db.snapshot_timestamp()`; about 5 s in the past). So:

- All batches read the same data: a user answering mid-export doesn't show up
  in one batch's query and not another's. Responses written in the few seconds
  before the export started are not in it.
- Reads of a live survey are not restarted by concurrent writes. A read at the
  present can fail with `ReadWithinUncertaintyIntervalError` (40001) when
  `responses` is being written, and CockroachDB does not retry it itself: the
  statement follows psycopg's `BEGIN` in a separate round trip, and even in
  autocommit it can't once a batch has sent the client more than
  `sql.defaults.results_buffer.size` (512 KiB). A historical read has no
  uncertainty interval, and at a closed timestamp it never waits on, or
  pushes, in-flight writes.
- The snapshot must stay within the tables' `gc.ttlseconds` (production
  90000 s) for the length of an attempt; `STUCK_TIMEOUT_MINUTES` bounds that.

psycopg runs every query in a transaction it opened, where a query's own
`AS OF SYSTEM TIME` clause fails with "inconsistent AS OF SYSTEM TIME
timestamp", so reads set it with `SET TRANSACTION AS OF SYSTEM TIME` first.

### Memory

Peak RSS of one export of a synthetic survey shaped like the largest production
one (13k users, 50 responses each, 650k rows, 334 MB long-format CSV), local
CockroachDB, 8 cores, with the Dockerfile's
`_RJEM_MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0`, 2026-10-15:

| `EXPORT_USER_BATCH_SIZE` | long format | pivot (`keep_final_answer`) |
|---|---|---|
| 250 | 281 MB | 265 MB |
| 500 (default) | 292-339 MB | 277-319 MB |
| 1000 | 322 MB | 292 MB |
| 2000 | 392 MB | 334 MB |

About 200 MB of that is imports alone: vlab-prepro imports pandas, which
imports pyarrow. Runs vary by about 30 MB. Without the jemalloc setting peaks
are 15-70 MB higher (Polars' default keeps freed pages for a second). A long
export with `keep_final_answer` and `add_duration` peaks at about 360 MB at
500. Run time is about 12 s whatever the batch size (14 s with
`add_duration`). Responses are fetched in chunks of `RESPONSE_CHUNK_ROWS` rows
because a batch's rows as Python tuples take several times their size in a
frame. Memory per batch scales with responses per user, so a survey with far
more than 50 responses per user needs a smaller batch for the same peak.

## Job Lifecycle

A job progresses through the following states:

```
Requested
  ↓ [claimed by worker, locked_at set, retry_count incremented]
Processing
  ↓ [worker calls process_job]
Querying → Formatting/Writing → Uploading
  ↓
Finished (successful export)
  OR
Failed (max retries exhausted or unrecoverable error)
  OR
[Reset to Requested if stuck > STUCK_TIMEOUT_MINUTES]
```

On failure, if `retry_count < MAX_EXPORT_RETRIES`, the job is reset to `Requested` for the next worker to retry, and only the worker (`run_job()`) marks a job `Failed`, so an export being retried never shows `Failed`. The error is written to `metadata.error` when the job is marked `Failed`, and claiming a job removes any `metadata.error`. Exceeding `MAX_EXPORT_RETRIES` marks it `Failed`.

Errors that would recur on every attempt are not retried: a vlab-prepro
`PreprocessingError` (e.g. "Could not pivot", or `drop_users_without` naming a
column that was not added) and `InvalidOptionsError` (pivot without a
`response_value`) leave the job `Failed` after the first attempt, with the
message in `metadata.error` (`NON_RETRYABLE_ERRORS` in `exporter.py`).

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `DATABASE_URL` | Required | CockroachDB connection string (PostgreSQL format) |
| `WORKER_THREADS` | 4 | Number of daemon threads polling for jobs |
| `POLL_INTERVAL_SECONDS` | 5 | Seconds to sleep between claim attempts when no jobs are available |
| `MAX_EXPORT_RETRIES` | 3 | Maximum attempts per job before marking Failed |
| `STUCK_TIMEOUT_MINUTES` | 120 | Minutes a Processing job can be locked before resetting to Requested |
| `STORAGE_BACKEND` | (no-op) | Storage backend: `google` (GCS), `s3` (MinIO), or unset for dev |
| `EXPORT_USER_BATCH_SIZE` | 500 | Users per batch in `responses` and `chat_log` exports; peak memory grows with it (see Memory) |

### Storage-Specific Configuration

**Google Cloud Storage**:
- `GOOGLE_STORAGE_BUCKET`: Bucket name
- `GOOGLE_APPLICATION_CREDENTIALS`: Path to service account JSON

**S3 / MinIO**:
- `S3_BUCKET_NAME`: Bucket name
- `S3_ACCESS_KEY`: Access key
- `S3_SECRET_KEY`: Secret key (if required)
- `S3_HOST`: Endpoint URL (for MinIO or S3-compatible services)

## Development

**Requires Python 3.11+**

### Install Dependencies

```bash
pip install -r requirements.txt
```

### Install Development Dependencies

```bash
pip install -r requirements.dev.txt
```

### Running Tests

```bash
poetry run pytest -v
```

Tests marked `integration` run against a real CockroachDB and are skipped
unless `DATABASE_URL` is set. Exports read at `follower_read_timestamp()`, so
fixtures call `wait_for_follower_reads()` after seeding (about 5 s):

```bash
make -C ../devops test-db
DATABASE_URL=postgresql://root@localhost:5433/chatroach poetry run pytest
```

**CI:** The GitHub Actions workflow `.github/workflows/exporter-test.yml` runs
both unit and integration tests on every change to `exporter/`,
`devops/migrations/` (schema), `devops/Makefile` (test-db target), or the
workflow itself. The workflow fails if integration tests would skip (guard
against broken DB setup), not just if they fail.

## Object Keys

Every artifact is written to `exports/<sha256(email)[:16]>/<survey_name><artifact>.csv`
(`exporter/keys.py`, pure). The owner prefix exists because `survey_name` is
unique per researcher, not globally. Without it, researchers who share a survey
name overwrite each other's exports and disclose respondent data through
still-valid presigned links (VIR-23). Keys must stay under `exports/` or the
3-day lifecycle rule stops expiring them. The dashboard-server recomputes the
same prefix to refuse links that are not the caller's, so changing the digest
means changing `dashboard-server/api/exports/exports.keys.js` in step. Full
rationale: `documentation/exports-storage.md` § "Object keys are scoped by
owner".

## Known Issues

`survey_id` in `export_status` holds `surveys.survey_name`, **not** the survey
title, so an export requested against a title matches zero users and finishes
with an empty file.

**The Google backend returns no real link.** `GoogleStorageBackend` does not
override `generate_link`, so a `STORAGE_BACKEND=google` export finishes with
`"Base backend fake link"`. Every live environment uses `s3` (MinIO).

**Stale configuration notes above.** The `KAFKA_*` variables listed under
"Export Types & Sources" are not read: the exporter polls `export_status` and
does not use Kafka. Dependencies are managed with Poetry (`pyproject.toml`),
not `requirements*.txt`; `poetry install` followed by `pytest` works.

## See Also

- `documentation/full-messages-export.md` — event classification and
  full-messages-specific options
- `documentation/exports-storage.md` — storage backend, bucket-per-environment
  split, retention policy, and presigned URL lifecycle
- `documentation/secrets.md` — how the `exporter` secret is built and applied
