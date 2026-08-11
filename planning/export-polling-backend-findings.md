# Export Polling Backend Findings

Investigation date: 2026-02-16

## 1. Export API Endpoints (dashboard-server)

**Route file**: `/dashboard-server/api/exports/exports.routes.js`
**Controller**: `/dashboard-server/api/exports/exports.controller.js`
**Queries**: `/dashboard-server/queries/exports/exports.queries.js`

### Endpoints

| Method | Route | Controller | Purpose |
|--------|-------|------------|---------|
| `POST` | `/api/v1/exports?survey=<name>` | `generateExport` | Create a new export job |
| `GET` | `/api/v1/exports/status` | `getAll` | Get all exports for authenticated user |
| `GET` | `/api/v1/exports/status/survey?survey=<name>` | `getBySurvey` | Get exports for a specific survey |

### Response Shape

The `getAll` and `getBySurvey` endpoints return `SELECT * FROM export_status`, so the response is an array of rows with these columns:

```json
[
  {
    "id": "uuid-string",
    "updated": "2026-02-16T12:00:00Z",
    "user_id": "user@example.com",
    "survey_id": "my-survey-name",
    "status": "Started" | "Finished" | "Failed",
    "export_link": "https://presigned-url..." | "Not Found",
    "source": "responses" | "chat_log" | "full_messages"
  }
]
```

Both endpoints return rows ordered by `updated DESC` (newest first).

### Create Export Response

`POST /exports` returns:
```json
{ "status": "success", "export_id": "uuid-string" }
```
with HTTP 201.

## 2. Export Statuses

There are exactly **three** status values. They are plain strings, not an enum -- just conventions used consistently across dashboard-server and exporter.

| Status | Set By | When |
|--------|--------|------|
| `"Started"` | dashboard-server (`exports.queries.js` line 28) | Immediately on INSERT when the export is created |
| `"Started"` | exporter (`exporter.py` lines 211, 306, 363) | Redundantly set at the start of each export function (no-op since already "Started") |
| `"Finished"` | exporter (`exporter.py` lines 225, 349, 377) | After CSV upload and presigned URL generation succeed |
| `"Failed"` | exporter (`exporter.py` lines 228, 352, 380) | In the `except` block if any step fails |

**Important**: There is no "in_progress" or "processing" status. The lifecycle is simply:
- `Started` -> `Finished` (success)
- `Started` -> `Failed` (error)

The exporter calls `set_export_status(cnf, export_id, status="Started")` at the top of each export function, but the row was already inserted with status "Started" by the dashboard-server. This is a redundant UPDATE that effectively no-ops.

## 3. Export Lifecycle (End-to-End)

### Step-by-step flow:

1. **Client POST** to `/api/v1/exports?survey=<name>` with body `{ export_type, ...options }`
2. **dashboard-server** (`exports.controller.js` lines 53-93):
   - Generates a UUID via `crypto.randomUUID()`
   - Maps `export_type` to `source`: `"chat_log"` -> `"chat_log"`, `"full_messages"` -> `"full_messages"`, everything else -> `"responses"`
   - **INSERTs** a row into `export_status` with `status='Started'`, `export_link='Not Found'`, the UUID as `id`, and the `source`
   - **Publishes** a Kafka message to `EXPORTS_TOPIC` containing `{ event, user, survey, export_id, source, ...options }`
   - Returns `201 { status: "success", export_id }` to the client
3. **Exporter service** (`exporter/exporter/main.py`) consumes the Kafka message:
   - Routes by `source`: `"chat_log"` -> `export_chat_log()`, `"full_messages"` -> `export_full_messages()`, default -> `export_data()`
4. **Exporter processing** (`exporter/exporter/exporter.py`):
   - Calls `set_export_status(cnf, export_id, status="Started")` (redundant)
   - Queries CockroachDB for data (responses, chat_log, or messages table)
   - Processes/formats data (pandas, vlab_prepro for responses; streaming CSV for full_messages)
   - Uploads CSV to cloud storage (GCS or S3/Minio)
   - Generates a presigned URL (7-hour expiry for S3)
   - **UPDATEs** the row: `set_export_status(cnf, export_id, url, status="Finished")`
   - On exception: **UPDATEs** the row: `set_export_status(cnf, export_id, status="Failed")`
5. **Client polls** `GET /exports/status` or `GET /exports/status/survey?survey=<name>` until status changes from "Started"

### Key observation about polling

The dashboard client currently does **NOT** poll. The Exports page (`/dashboard-client/src/containers/Exports/Exports.js`) uses `Hook.useMountFetch` which fetches once on mount. There is no interval-based polling or refetch mechanism. The user must manually refresh the page to see updated export status.

## 4. Database Schema

### Table: `export_status`

**Original schema** (`devops/migrations/02-export-status.sql`):
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

**Redesigned schema** (`devops/migrations/09-export-log-redesign.sql`):
- Added `id UUID DEFAULT gen_random_uuid()` -- unique per export attempt
- Added `source VARCHAR NOT NULL DEFAULT 'responses'` -- distinguishes export type
- **Dropped** the `UNIQUE(survey_id, user_id)` constraint -- multiple exports allowed per user per survey
- Added indexes: `idx_export_status_id` (unique), `idx_export_status_survey`, `idx_export_status_user`

**Current effective schema**:
```sql
export_status (
    id         UUID         DEFAULT gen_random_uuid(),   -- PK, unique index
    updated    TIMESTAMPTZ  DEFAULT now() ON UPDATE now(),
    user_id    VARCHAR      NOT NULL,
    survey_id  VARCHAR      NOT NULL,
    status     VARCHAR      NOT NULL,    -- 'Started', 'Finished', 'Failed'
    export_link VARCHAR     NOT NULL,    -- presigned URL or 'Not Found'
    source     VARCHAR      NOT NULL DEFAULT 'responses'  -- 'responses', 'chat_log', 'full_messages'
)
```

### How status updates work

The exporter uses a simple UPDATE keyed by `id`:
```python
# exporter/exporter/exporter.py line 237
UPDATE export_status SET status = %s, export_link = %s WHERE id = %s
```

The dashboard-server inserts:
```sql
-- dashboard-server/queries/exports/exports.queries.js line 27
INSERT INTO export_status (id, user_id, survey_id, status, export_link, source)
VALUES ($1, $2, $3, 'Started', 'Not Found', $4)
```

## 5. The `getBySurvey` Endpoint

**Route**: `GET /api/v1/exports/status/survey?survey=<name>`
**Controller**: `exports.controller.js` lines 28-47
**Query**: `SELECT * FROM export_status WHERE user_id = $1 AND survey_id = $2 ORDER BY updated DESC`

This endpoint:
- Requires `req.user.email` (from JWT auth)
- Requires `survey` query parameter
- Returns all export rows for that user+survey combination, newest first
- Does **NOT** validate survey ownership via middleware (no `validateSurveyAccess`)

This is the ideal endpoint for per-survey polling since it filters to just the relevant exports.

## 6. Export Types (Sources)

Three export types exist, determined by `export_type` in the POST body:

| `export_type` (client) | `source` (DB/Kafka) | Exporter Function | Data Source |
|------------------------|---------------------|-------------------|-------------|
| _(default/anything)_ | `responses` | `export_data()` | `responses` table + `surveys` table |
| `chat_log` | `chat_log` | `export_chat_log()` | `chat_log` table |
| `full_messages` | `full_messages` | `export_full_messages()` | `messages` table |

## 7. Notable Details for Polling Implementation

1. **The `getBySurvey` endpoint already exists** and is ready for per-survey polling. No new API endpoint is needed.
2. **The `id` field** (UUID) is the primary identifier for tracking individual exports. It is returned by the POST endpoint and is the `rowKey` in the Exports table.
3. **The `updated` column** auto-updates on any change (`ON UPDATE now()`), so it reflects when the status last changed.
4. **No WebSocket or push mechanism exists** -- polling is the only way to get status updates.
5. **The `export_link` field** contains `"Not Found"` while the export is in progress. Once finished, it contains the presigned URL. Presigned URLs expire after 7 hours (S3 backend).
6. **Error handling in the exporter** catches all exceptions and sets status to "Failed", then re-raises. The Kafka consumer loop (`main.py` line 73) catches the re-raised exception and logs it, then continues polling for the next message.
7. **No retry mechanism** exists. Once an export fails, it stays failed. The user must trigger a new export.

## 8. File Reference

| File | Purpose |
|------|---------|
| `dashboard-server/api/exports/exports.routes.js` | Route definitions |
| `dashboard-server/api/exports/exports.controller.js` | Endpoint handlers |
| `dashboard-server/queries/exports/exports.queries.js` | SQL queries for export_status table |
| `dashboard-server/queries/index.js` | Query module loader (binds queries to pool) |
| `exporter/exporter/main.py` | Kafka consumer, message parsing, routing |
| `exporter/exporter/exporter.py` | Export logic, status updates, DB queries |
| `exporter/exporter/storage.py` | Storage backends (GCS, S3/Minio) |
| `exporter/exporter/db.py` | Database connection helper (psycopg3) |
| `devops/migrations/02-export-status.sql` | Original schema |
| `devops/migrations/09-export-log-redesign.sql` | Schema redesign (UUID id, source column) |
| `dashboard-client/src/containers/Exports/Exports.js` | Global exports list page (no polling) |
