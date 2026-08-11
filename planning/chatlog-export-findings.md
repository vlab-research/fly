# Exporter Service -- Full Pipeline Investigation

## Overview

The exporter is a Python Kafka consumer that receives export job requests, queries CockroachDB for survey response data, preprocesses it with `vlab_prepro`, generates a CSV, uploads it to cloud storage (GCS or S3), and writes the download link back to the database. The dashboard client and server coordinate the trigger and status display.

## Architecture: End-to-End Pipeline

```
Dashboard Client (CreateExport form)
  |
  | POST /exports?survey=<name>  (body = ExportOptions)
  v
Dashboard Server (exports.controller.js)
  |
  | Produces Kafka message to "vlab-exports" topic
  v
Kafka topic: "vlab-exports" (prod: "vlab-exports", staging: "vlab-staging-exports")
  |
  | Consumed by exporter service (confluent_kafka Consumer)
  v
Exporter Service (Python)
  |
  | 1. Queries CockroachDB for responses + form data
  | 2. Preprocesses with vlab_prepro (pivot, keep_final_answer, etc.)
  | 3. Generates CSV via pandas df.to_csv()
  | 4. Uploads to GCS or S3 (Minio)
  | 5. Writes presigned download URL to export_status table
  v
Dashboard Client (Exports page)
  |
  | GET /exports/status -> reads export_status table
  | Shows download link when status = "Finished"
```

## 1. Exporter Service Architecture

- **Language**: Python 3.11
- **Package manager**: Poetry
- **Entry point**: `exporter/main.py` (top-level) calls `exporter.main.app()`
- **Docker entrypoint**: `python main.py`
- **Docker image**: `vlabresearch/exporter` (production version: v0.3.6)
- **Helm chart**: `exporter/chart/exporter/` (version 0.1.0), deployed as subchart of umbrella `devops/vlab/`

### Key source files

| File | Purpose |
|------|---------|
| `/exporter/main.py` | Top-level entry, calls `exporter.main.app()` |
| `/exporter/exporter/main.py` | Kafka consumer loop, message parsing, orchestration |
| `/exporter/exporter/exporter.py` | Core export logic: DB queries, preprocessing, CSV generation, storage |
| `/exporter/exporter/db.py` | Database access layer (psycopg3, raw SQL) |
| `/exporter/exporter/storage.py` | Storage backends: GCS, S3/Minio, Base (dev) |
| `/exporter/exporter/log.py` | Logging setup |
| `/exporter/exporter/health.py` | Health check stub (currently a no-op `pass`) |
| `/exporter/pyproject.toml` | Dependencies: pandas, vlab-prepro 0.4.1, psycopg3, minio, google-cloud-storage, confluent-kafka, pydantic 1.10 |

## 2. Kafka Integration

### Consumer configuration (`exporter/exporter/main.py` lines 76-93)

- **Library**: `confluent_kafka.Consumer`
- **Topic**: env `KAFKA_TOPIC` (default: `vlab-exports`)
  - Production: `vlab-exports`
  - Staging: `vlab-staging-exports`
- **Group ID**: env `KAFKA_GROUP_ID` (default: `exporter`)
- **Auto offset reset**: `latest` (only processes new messages)
- **Auto commit**: disabled (`enable.auto.commit: false`); commits synchronously after processing each message
- **Max poll interval**: env `KAFKA_MAX_POLL_INTERVAL` (prod: `3600000` = 1 hour, staging: `1200000` = 20 min)
- **Session timeout**: 30s

### Kafka topic configuration (production, `devops/values/production.yaml` lines 81-85)

- 2 partitions, replication factor 2
- Retention: 31 days

### Message format (`KafkaMessage` pydantic model, `main.py` lines 22-26)

```json
{
  "event": "data-export",
  "user": "user@example.com",
  "survey": "my-survey-name",
  "options": {
    "pivot": true,
    "keep_final_answer": true,
    "drop_duplicated_users": true,
    "add_duration": true,
    "response_value": "translated_response",
    "metadata": ["stratum_age"],
    "drop_users_without": "creative"
  }
}
```

### Producer (dashboard-server side, `exports.controller.js` lines 29-56)

- **Library**: `kafkajs`
- **Topic**: env `KAFKA_EXPORTS_TOPIC` (prod: `vlab-exports`)
- **Key**: survey name (ensures same-survey exports go to same partition)
- Message value: JSON stringified `{ event, user, survey, options }`

## 3. Database Queries

The exporter uses **psycopg3** with raw SQL queries. No ORM, no connection pooling (TODO comment in `db.py` line 8 notes this).

### Responses query (`exporter.py` lines 100-122)

```sql
SELECT parent_surveyid, parent_shortcode, surveyid, flowid,
       responses.userid, question_ref, question_idx, question_text,
       response, timestamp::string, responses.metadata::string,
       pageid, translated_response
FROM responses
LEFT JOIN surveys ON responses.surveyid = surveys.id
LEFT JOIN users ON surveys.userid = users.id
WHERE users.email = %s AND surveys.survey_name = %s
ORDER BY (responses.userid, timestamp, question_ref)
```

- Queries the `responses` table **directly**, joined to `surveys` and `users`
- Filters by user email and survey name
- Returns all responses for all forms in the survey
- Note: casts `timestamp` and `metadata` to string (CockroachDB-specific)

### Form data query (`exporter.py` lines 125-147)

```sql
WITH t AS (
  SELECT surveys.*, row_number() OVER (partition BY shortcode ORDER BY created) AS version
  FROM surveys
  LEFT JOIN users ON surveys.userid = users.id
  WHERE users.email = %s AND survey_name = %s
)
SELECT id as surveyid, shortcode, survey_name, version,
       created::string as survey_created, metadata::string
FROM t
ORDER BY shortcode, created
```

- Gets survey/form metadata with computed version numbers
- Used by `vlab_prepro` to merge form data into responses

### Export status table (`devops/migrations/02-export-status.sql`)

```sql
CREATE TABLE IF NOT EXISTS chatroach.export_status(
    updated TIMESTAMPTZ DEFAULT now() ON UPDATE now(),
    user_id VARCHAR NOT NULL,
    survey_id VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    export_link VARCHAR NOT NULL,
    CONSTRAINT unique_status UNIQUE(survey_id, user_id)
);
```

- Upserts on `(survey_id, user_id)` -- only one export per survey per user at a time
- Status values: `Started`, `Finished`, `Failed`
- `export_link` holds the presigned download URL when finished

## 4. CSV Generation

### Preprocessing pipeline (`exporter.py` lines 25-60)

Uses `vlab_prepro.Preprocessor` (version 0.4.1) with `toolz.pipe` for functional composition.

**ExportOptions** (pydantic model):

| Option | Type | Default | Effect |
|--------|------|---------|--------|
| `pivot` | bool | False | Pivot to wide format (one row per user) |
| `keep_final_answer` | bool | False | Keep only last answer per question |
| `drop_duplicated_users` | bool | False | Remove users who took form twice |
| `add_duration` | bool | False | Add timing columns (duration, answer time stats) |
| `metadata` | list[str] or None | None | Extract metadata keys as columns |
| `drop_users_without` | str or None | None | Drop users missing this metadata key |
| `response_value` | str or None | None | Column to use for pivot values (`response` or `translated_response`) |

**Processing order** (always applied in this sequence):
1. `add_form_data` -- always runs, merges form metadata with "form" prefix
2. `keep_final_answer` -- if enabled
3. `add_metadata` -- if metadata keys specified
4. `drop_users_without` -- if specified
5. `drop_duplicated_users` -- if enabled
6. `add_duration` -- if enabled
7. `pivot` -- if enabled (requires `response_value`)

### CSV output

Generated by `pandas.DataFrame.to_csv(index=False)`, uploaded as `text/csv`.

**File path pattern**: `exports/{survey_name}.csv`

Note: this means re-exporting the same survey **overwrites** the previous CSV.

## 5. Storage Backend

Configured via env `STORAGE_BACKEND`. Options: `google`, `s3`, or fallback to `BaseStorageBackend` (dev/debug only).

### Google Cloud Storage (`GoogleStorageBackend`, `storage.py` lines 45-57)

- **Bucket**: env `GOOGLE_STORAGE_BUCKET`
- **Credentials**: env `GOOGLE_APPLICATION_CREDENTIALS` (standard GCP service account)
- Upload: `bucket.blob(file_path).upload_from_string(csv_string, "text/csv")`
- **No `generate_link` override** -- falls through to base class returning `"Base backend fake link"`
- **BUG**: GoogleStorageBackend does NOT implement `generate_link()`. The base class returns a hardcoded string. This means GCS exports will have a non-functional download link.

### S3/Minio (`S3StorageBackend`, `storage.py` lines 60-106)

- **Bucket**: env `S3_BUCKET_NAME`
- **Host**: env `S3_HOST`
- **Credentials**: env `S3_ACCESS_KEY`, `S3_SECRET_KEY`
- **SSL**: env `S3_SSL_ENABLED`
- Auto-creates bucket if it doesn't exist
- `generate_link()` returns a **presigned URL** valid for 7 hours

### Production storage

The production Helm values reference an `exporter` Kubernetes secret (`envSecrets: [exporter]`) which likely contains `DATABASE_URL`, `STORAGE_BACKEND`, and the storage-specific credentials. These secrets are not in the repo (as expected).

## 6. Preprocessing Library: vlab_prepro

Located at: `exporter/.venv/lib/python3.11/site-packages/vlab_prepro/preprocess.py`

**Installed version**: 0.4.1 (per `pyproject.toml`)

The `Preprocessor` class is stateful -- it tracks `self.keys` (the set of columns that identify a unique row) and `self.form_df`. This state accumulates through the pipeline, which is important for `pivot()` to know which columns to use as the index.

Key methods used by the exporter:
- `add_form_data(form_df, prefix)` -- merges survey metadata, flattens JSON metadata column
- `keep_final_answer` -- marks and filters to last answer per (userid, surveyid, question_ref)
- `add_metadata(keys)` -- extracts keys from JSON metadata column into separate columns
- `drop_users_without(key)` -- removes testers/users without a metadata value
- `drop_duplicated_users(form_keys)` -- removes users who answered same form twice
- `add_duration()` -- adds timing stats per user-survey group
- `pivot(answer_column)` -- reshapes from long to wide format

## 7. Configuration Summary

### Environment variables

| Variable | Source | Default | Description |
|----------|--------|---------|-------------|
| `KAFKA_TOPIC` | env / Helm | `vlab-exports` | Kafka topic to consume |
| `KAFKA_BROKERS` | env / Helm | `""` | Kafka broker addresses |
| `KAFKA_GROUP_ID` | env / Helm | `exporter` | Kafka consumer group |
| `KAFKA_MAX_POLL_INTERVAL` | env / Helm | `1200000` | Max poll interval ms |
| `DATABASE_URL` | secret | - | CockroachDB connection string |
| `STORAGE_BACKEND` | secret | - | `google` or `s3` |
| `APP_NAME` | env / Helm | `exporter` | Logger name |
| `GOOGLE_STORAGE_BUCKET` | secret | - | GCS bucket (if google backend) |
| `GOOGLE_APPLICATION_CREDENTIALS` | secret | - | GCP creds path (if google backend) |
| `S3_BUCKET_NAME` | secret | - | S3 bucket (if s3 backend) |
| `S3_HOST` | secret | - | S3/Minio host (if s3 backend) |
| `S3_ACCESS_KEY` | secret | - | S3 access key (if s3 backend) |
| `S3_SECRET_KEY` | secret | - | S3 secret key (if s3 backend) |
| `S3_SSL_ENABLED` | secret | - | S3 SSL flag (if s3 backend) |

### Helm deployment

- Umbrella chart: `devops/vlab/Chart.yaml` includes `exporter` v0.1.0 from OCI registry
- Production values: `devops/values/production.yaml` -- 2 replicas, image `vlabresearch/exporter:v0.3.6`
- Staging values: `devops/values/staging.yaml` -- 1 replica (default), image tag v0.3.2
- Secrets loaded via `envSecrets: [exporter]` k8s secret

## 8. Dashboard Integration

### Trigger: Dashboard Client (`CreateExport` component)

**File**: `/dashboard-client/src/containers/CreateExport/CreateExport.js`

- Form with toggles for all ExportOptions
- Defaults: pivot=true, keep_final_answer=true, drop_duplicated_users=true, add_duration=true, response_value="translated_response"
- Survey name from URL query param `?survey_name=...`
- Calls `startExport(survey, body)` which POSTs to `/exports?survey=<name>`
- Waits 4 seconds (hardcoded artificial delay) then redirects to `/exports`

### API: Dashboard Server

**File**: `/dashboard-server/api/exports/exports.controller.js`

- `POST /exports` -- creates Kafka message, responds 201
- `GET /exports/status` -- queries `export_status` table for user's exports

**Kafka config**: `/dashboard-server/config/index.js` line 83: `EXPORTS_TOPIC: envVars.KAFKA_EXPORTS_TOPIC || 'vlabs-exports'`

Note: the default fallback is `vlabs-exports` (with an 's'), while the actual topic is `vlab-exports` (no 's'). This discrepancy is harmless since the env var is always set in production/staging.

### Status display: Exports page

**File**: `/dashboard-client/src/containers/Exports/Exports.js`

- Table showing survey_id, user_id, updated timestamp, status, and download link
- Download link is the presigned URL from `export_status.export_link`

## 9. Potential Issues and Observations

1. **GoogleStorageBackend missing `generate_link()`**: The GCS backend does not override `generate_link()`, so it returns a fake string. Only S3/Minio generates working presigned URLs. If production uses GCS, downloads would be broken.

2. **No connection pooling**: Each query creates a new psycopg3 connection (TODO in `db.py`). For large exports this is fine since there are only 2-3 queries per export, but it's not optimal.

3. **Health check is a no-op**: `health.py` has `pass` -- the liveness/readiness probes always succeed regardless of Kafka or DB health.

4. **Single CSV per survey per user**: File path `exports/{survey}.csv` means concurrent exports of the same survey could race. The `export_status` table upserts, so only the last result persists.

5. **Error handling**: Exceptions in processing are caught, status set to "Failed", but the Kafka message is still committed (the commit happens in the outer `try` after `process()` succeeds, but if `process()` raises, the message won't be committed due to the flow in `main.py` lines 51-57).

6. **Pydantic v1**: Uses pydantic 1.10.10, not v2. The `BaseSettings` import in storage.py is from pydantic v1.

7. **No retry mechanism**: Failed exports are logged but not retried. Since auto-commit is off and the commit is after successful processing, a failed message will be re-delivered on consumer restart.

8. **4-second artificial delay in UI**: The client waits 4 seconds after triggering an export before redirecting, hoping the export finishes. For large datasets this is likely insufficient.

## 10. event-exporter/ vs exporter/

The `event-exporter/` directory is a **separate service** -- it appears to be a data export tool for extracting events to JSONL files (note the `.jsonl` files in the directory). It is NOT the CSV export service. The CSV export pipeline is entirely within `exporter/`.
