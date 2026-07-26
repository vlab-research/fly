# Fly Exporter

A service that handles exporting fly data into CSV format for download


## Setup

There are currently various settings that you can configure on this application

## General Configuration:

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

## Storage Specific Configurations

### Google

**GOOGLE_STORAGE_BUCKET:** Google Storage Bucket Name
**GOOGLE_APPLICATION_CREDENTIALS:** The path to the credentials to use to
upload exports

### S3

**S3_BUCKET_NAME:** Storage Bucket Name
**S3_ACCESS_KEY:** Access Key
**S3_ACCESS_KEY:** Access Key
**S3_BUCKET_NAME:** Access Key
**S3_HOST:** Access Key


## Development

**Please Note To use Python 3.9 and above for development**

### Install Dependencies

```bash
pip install -r requirements.txt
```

### Install Development Dependencies

```bash
pip install -r requirements.dev.txt
```

### Running Tests

In order to run tests please use:

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

- `documentation/exports-storage.md` — storage backend, bucket-per-environment
  split, retention policy, and presigned URL lifecycle
- `documentation/secrets.md` — how the `exporter` secret is built and applied
