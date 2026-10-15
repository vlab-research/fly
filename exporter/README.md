# Fly Exporter

A database-polling service that processes export jobs for survey responses, chat logs, and message history, writing CSVs to object storage.

## Architecture

The exporter runs as a set of daemon worker threads that continuously poll the `export_status` table in CockroachDB for jobs to process. Each worker:
1. Calls `claim_job()` every `POLL_INTERVAL_SECONDS` to atomically claim a `Requested` job and transition it to `Processing`
2. Calls `process_job()` to execute the export (querying data, formatting to CSV, uploading to storage)
3. Updates the job to `Finished` on success or resets it to `Requested` for retry on failure

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
- **`full_messages`**: Complete message history with event-type filtering and optional raw JSON. Covers all message sources (Messenger, WhatsApp, synthetic) and event types (conversation, referrals, payments, system, etc.). See `export_full_messages()` in `exporter.py` and `documentation/full-messages-export.md` for details.

### Responses and chat_log: batches of users

Both exports fetch the survey's userids once, sorted, then query and write
`EXPORT_USER_BATCH_SIZE` users at a time, appending to a temp CSV that is
uploaded with `save_file()` at the end. `full_messages` does the same with its
own batch size of 500. Memory therefore depends on the batch size, not the
survey; the temp file on the pod's disk holds the whole CSV.

A responses batch runs the full vlab-prepro pipeline (`format_data()`) on its
own. That is correct because every step it uses needs only one user's rows
(`keep_final_answer`, `drop_users_without`, `drop_duplicated_users`,
`add_duration` and `pivot` all group by user; form data and metadata are
row-wise). Batches must still write identical columns, formatted identically,
so a few things are decided once for the whole survey before the first batch:

- **Form data** is fetched once and passed whole to every batch, so flattened
  form-metadata columns get the same dtype in each (a key missing on one
  version is a float column, `1.0`, everywhere).
- **Metadata columns** (`ad_id`, always, plus the requested keys) take their
  dtype from the kinds of JSON value each key has across the survey
  (`get_metadata_kinds()`, one SQL query), as pandas would infer it over the
  whole survey: an int key missing on some rows is `1.0` in every batch, not
  `1` in batches where it is never missing. A key is named `<key>_metadata`
  when any question in the survey has that ref.
- **Pivot columns** are the key columns sorted, then every question_ref in the
  survey sorted (`get_question_refs()`), so a question no user in a batch, or
  in the export, answered is an empty column.

The long format's header is the first non-empty batch's columns; a batch with
other columns fails the export. A batch left with no rows (e.g. every user
dropped by `drop_users_without`) is skipped. An export with no rows at all is
an empty file (`chat_log`: header only).

Compared with exporting the whole survey at once, rows can come out in a
different order (batches are in userid order), and pivot columns are in the
fixed order above. Cell values are the same; `tests/test_batched_export.py` and
`tests/test_export_db_integration.py` check this against the whole-survey
export kept in `tests/reference_export.py`.

Progress is written to `export_status.metadata` as it goes: `users` and
`batches` up front, then a running `responses` (responses only), `rows` and
`batches_done` after each batch.

### Memory

Peak RSS of one export of a synthetic survey shaped like the largest production
one (13k users, 50 responses each, 650k rows, 334 MB long-format CSV), local
CockroachDB, 2026-10-15:

| `EXPORT_USER_BATCH_SIZE` | long format | pivot (`keep_final_answer`) |
|---|---|---|
| whole survey at once (exporter before batching) | 1977 MB | 1488 MB |
| 100 | 126 MB | 127 MB |
| 250 | 141 MB | 144 MB |
| 500 (default) | 166 MB | 173 MB |
| 1000 | 219 MB | 231 MB |
| 2000 | 324 MB | 347 MB |
| 4000 | 501 MB | 577 MB |

About 100 MB per 50k rows in a batch, over a ~110 MB baseline. Run time was
flat from 500 up and rose below it (100: twice as long), from per-batch
overhead. Memory per batch scales with responses per user, so a survey with
far more than 50 responses per user needs a smaller batch for the same peak.

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

On failure, if `retry_count < MAX_EXPORT_RETRIES`, the job is reset to `Requested` for the next worker to retry. Exceeding `MAX_EXPORT_RETRIES` marks it `Failed`.

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

**Requires Python 3.9+**

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
pytest exporter/ -s
```

Tests marked `integration` run against a real CockroachDB and are skipped
unless `DATABASE_URL` is set:

```bash
make -C ../devops test-db
DATABASE_URL=postgresql://root@localhost:5433/chatroach pytest exporter/
```

## Known Issues

`survey_id` in `export_status` holds `surveys.survey_name`, **not** the survey
title, so an export requested against a title matches zero users and finishes
with an empty file.

## See Also

- `documentation/full-messages-export.md` — event classification and
  full-messages-specific options
- `documentation/exports-storage.md` — storage backend, bucket-per-environment
  split, retention policy, and presigned URL lifecycle
- `documentation/secrets.md` — how the `exporter` secret is built and applied
