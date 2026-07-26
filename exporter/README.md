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
- **`chat_log`**: Conversation history with optional raw payload and metadata fields. See `export_chat_log()` in `exporter.py`.
- **`full_messages`**: Complete message history with event-type filtering and optional raw JSON. Covers all message sources (Messenger, WhatsApp, synthetic) and event types (conversation, referrals, payments, system, etc.). See `export_full_messages()` in `exporter.py` and `documentation/full-messages-export.md` for details.

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

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `DATABASE_URL` | Required | CockroachDB connection string (PostgreSQL format) |
| `WORKER_THREADS` | 4 | Number of daemon threads polling for jobs |
| `POLL_INTERVAL_SECONDS` | 5 | Seconds to sleep between claim attempts when no jobs are available |
| `MAX_EXPORT_RETRIES` | 3 | Maximum attempts per job before marking Failed |
| `STUCK_TIMEOUT_MINUTES` | 120 | Minutes a Processing job can be locked before resetting to Requested |
| `STORAGE_BACKEND` | (no-op) | Storage backend: `google` (GCS), `s3` (MinIO), or unset for dev |

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

## Known Issues

**Empty surveys fail instead of producing an empty CSV.** A `responses` export
for a survey with zero responses fails all retries and lands in `Failed` with:

```
"['metadata'] not found in axis"
```

The formatting step drops a `metadata` column that does not exist on an empty
dataframe. The job metadata correctly records `{"responses": 0, "users": 0}`, so
the cause is identifiable, but the surfaced error is misleading — it reads like a
schema problem rather than "there is no data". Note that `survey_id` in
`export_status` holds `surveys.survey_name`, **not** the survey title, so an
export requested against a title silently matches zero rows and hits this path.

## See Also

- `documentation/full-messages-export.md` — event classification and
  full-messages-specific options
- `documentation/exports-storage.md` — storage backend, bucket-per-environment
  split, retention policy, and presigned URL lifecycle
- `documentation/secrets.md` — how the `exporter` secret is built and applied
