# Dashboard-Server Export API Investigation

## Summary

The dashboard-server acts as a thin API gateway for exports. It receives export requests from the dashboard client, publishes them as Kafka messages, and provides a status-polling endpoint that reads from the `export_status` table (which the exporter service writes to). The dashboard-server does NOT serve exported files directly -- download URLs come from the exporter via the database.

## Export API Endpoints

### Route Mounting

All API routes are mounted under `/api/v1` with JWT auth middleware applied globally:

```
server.js:15  ->  app.use(`/api/v${API_VERSION}`, auth, router)
api/index.js:6  ->  .use('/exports', require('./exports'))
```

Full paths:
- `POST /api/v1/exports?survey=<surveyName>` -- trigger an export
- `GET /api/v1/exports/status` -- poll export status for the authenticated user

Route definition: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/exports/exports.routes.js`

### POST /api/v1/exports -- Trigger Export

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/exports/exports.controller.js` (lines 29-56)

Request format:
- Query param: `survey` (survey name/shortcode)
- Body: `options` object (passed directly to Kafka message)
- Auth: JWT Bearer token (provides `req.user.email`)

What it does:
1. Creates a new KafkaJS producer
2. Builds a message: `{ event: "data-export", user: email, survey: survey, options: body }`
3. Publishes to the configured `EXPORTS_TOPIC` with `key: survey`
4. Disconnects the producer
5. Returns `{ status: "success" }` with 201

Response: `201 { status: "success" }` on success, `500` on error.

**Important**: A new Kafka producer is created and disconnected on every request. This is inefficient but functional.

### GET /api/v1/exports/status -- Poll Export Status

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/exports/exports.controller.js` (lines 11-25)

What it does:
1. Reads `req.user.email`
2. Queries `export_status` table for all rows matching `user_id = email`
3. Returns the array of export status rows

Response: `200` with array of `{ updated, user_id, survey_id, status, export_link }` objects.

## Duplicate generateExport in Response Controller (Dead Code)

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/responses/response.controller.js` (lines 81-108)

There is a SECOND `generateExport` function in the response controller that is NOT mounted in any route. Key differences from the exports controller version:
- Takes `type` from query params instead of `options` from body
- Hardcodes topic as `"vlab-exports"` instead of using config
- Hardcodes message key as `"data-exports"` instead of using survey name
- Returns 200 instead of 201

This appears to be an older version that was superseded by the exports controller but never removed.

## Kafka Message Format

The message published to Kafka:

```json
{
  "event": "data-export",
  "user": "user@example.com",
  "survey": "survey-shortcode-or-name",
  "options": {
    "pivot": false,
    "keep_final_answer": false,
    "drop_duplicated_users": false,
    "add_duration": false,
    "metadata": null,
    "drop_users_without": null,
    "response_value": null
  }
}
```

The `options` object is passed through directly from the request body. The exporter validates it against `ExportOptions` (Pydantic model in `/home/nandan/Documents/vlab-research/fly/exporter/exporter/exporter.py`, lines 11-18).

### Kafka Topic

- Config key: `KAFKA.EXPORTS_TOPIC`
- Env var: `KAFKA_EXPORTS_TOPIC`
- Default: `'vlabs-exports'` (note: config default has a typo with 's' -- `vlabs-exports` vs production value `vlab-exports`)
- Production value: `vlab-exports` (from `devops/values/production.yaml` line 19, anchor `&exportertopic`)
- Partitions: 2, replication factor: 2

### Kafka Client

- **File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/utils/kafka/kafka.util.js`
- Library: `kafkajs`
- Client ID: `dashboard-server`
- A single `Kafka` connection object is created at module load time
- Producers are created per-request (not pooled)

## Export Status Table

**Migration**: `/home/nandan/Documents/vlab-research/fly/devops/migrations/02-export-status.sql`

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

Columns:
- `updated` -- auto-maintained timestamp
- `user_id` -- the email address of the user who requested the export
- `survey_id` -- the survey name/shortcode
- `status` -- "Started", "Finished", or "Failed" (set by exporter)
- `export_link` -- URL to download the file, or "Not Found" when not yet available

The UNIQUE constraint on `(survey_id, user_id)` means there is only ONE export status row per user per survey. Re-exporting the same survey overwrites the previous status/link.

## Storage and Download Flow

The dashboard-server does NOT serve exported files. The flow is:

1. Dashboard client POST to `/api/v1/exports` to trigger export
2. Exporter processes the Kafka message, generates CSV, uploads to storage
3. Exporter writes `export_link` (a presigned URL) to `export_status` table
4. Dashboard client polls `GET /api/v1/exports/status`
5. When status is "Finished", the `export_link` contains a presigned URL
6. Client downloads directly from storage using that URL

Storage backends (configured in exporter, not dashboard-server):
- **Google Cloud Storage**: uploads to a GCS bucket
- **S3/MinIO**: uploads to S3-compatible storage, generates presigned URLs (7-hour expiry)
- **Base (dev)**: just logs the data, returns fake link

## Authentication

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/middleware/auth.js`

All routes under `/api/v1/` (including exports) go through the auth middleware which:
1. First tries Auth0 client JWT (RS256, JWKS) -- for dashboard user tokens
2. If that fails with `UnauthorizedError`, falls back to server JWT (HS256) -- for server-to-server calls

The exports endpoints use `req.user.email` for:
- Identifying who requested the export (stored in Kafka message as `user`)
- Scoping export status queries to the authenticated user

**Notable gap**: There is NO survey-level authorization on the export endpoint. Unlike the states and bails endpoints which use `validateSurveyAccess` or `validateSurveyNameAccess` middleware, the export POST endpoint does not verify that the authenticated user owns the requested survey. The exporter may or may not enforce this (it queries responses directly by survey name).

## Existing Export Types

Currently only ONE export type is supported: **CSV response export**. The exporter:
1. Queries all responses for the survey from the database
2. Applies optional preprocessing (pivot, metadata, deduplication, duration, filtering)
3. Saves as CSV to cloud storage

The `options` field allows customization of the preprocessing pipeline, but there is no `type` field in the active exports controller. The dead code in `response.controller.js` had a `type` query param, suggesting export types were once considered but not implemented.

## Response Controller's CSV Endpoints (Synchronous, Separate)

The response controller also has synchronous CSV endpoints that are NOT part of the Kafka export pipeline:

- `GET /api/v1/responses/csv?survey=<survey>` -- streams responses as CSV directly
- `GET /api/v1/responses/form-data?survey=<survey>` -- streams form data as CSV directly

These are synchronous (blocking) and stream directly from the database to the HTTP response. They exist alongside the async Kafka-based export system.

## Key Files Reference

| File | Purpose |
|------|---------|
| `dashboard-server/api/exports/exports.controller.js` | Export trigger + status controller |
| `dashboard-server/api/exports/exports.routes.js` | Route definitions |
| `dashboard-server/queries/exports/exports.queries.js` | Database queries for export_status |
| `dashboard-server/utils/kafka/kafka.util.js` | KafkaJS client setup |
| `dashboard-server/config/index.js` | Config including KAFKA.EXPORTS_TOPIC |
| `dashboard-server/middleware/auth.js` | JWT auth middleware |
| `dashboard-server/server.js` | Express app setup, route mounting |
| `devops/migrations/02-export-status.sql` | export_status table schema |
| `devops/values/production.yaml` | Production Kafka topic config |

## Observations and Concerns

1. **No survey-level auth on exports** -- any authenticated user can trigger an export for any survey name. The status endpoint IS scoped by user email, but the trigger is not.

2. **Producer-per-request** -- creating and disconnecting a Kafka producer on every export request is wasteful. Should use a shared producer.

3. **Dead code in response.controller.js** -- the unused `generateExport` function (line 81) hardcodes the topic name and has different behavior from the active one. Should be removed.

4. **Topic name default mismatch** -- config default is `vlabs-exports` (with 's') but production uses `vlab-exports`. In production the env var overrides this, but in dev/test environments the default could cause messages to go to the wrong topic.

5. **Single export per survey per user** -- the UNIQUE constraint on `(survey_id, user_id)` means re-exporting overwrites the previous export. There is no export history.

6. **No validation of options on dashboard-server side** -- the `options` body is passed through as-is. Validation only happens on the exporter side (Pydantic). Invalid options would result in a Kafka message that fails during processing.

7. **CORS header `Content-Disposition` is exposed** -- configured in `server.js` line 13, needed for the synchronous CSV download endpoints in the response controller.
