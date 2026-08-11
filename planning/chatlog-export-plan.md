# Chat Log CSV Export -- Implementation Plan (REVISED)

**Date**: 2026-02-15
**Revision**: 2 -- Replaces previous plan. Fundamental redesign of export_status as an append-only log.
**Prerequisite**: The `chat_log` table must be deployed first (migration `08-chat-log.sql` from the `feat/chat-log` branch).

## Design Philosophy Change

The previous plan treated `export_status` as a mutable record with a UNIQUE constraint per (survey, user, export_type). The new design treats exports as an **append-only log**: every export attempt is a new row, nothing gets overwritten. This is cleaner because:

1. Users can see their full export history, not just the latest attempt.
2. No upsert complexity -- INSERT for start, UPDATE by ID for finish.
3. The `source` column (`'responses'` or `'chat_log'`) is just metadata on the row, not a discriminator in a unique constraint.
4. Per-survey filtering becomes natural -- just WHERE on `survey_id`.

## User Decisions

1. **No preprocessing** -- chat log export is a raw CSV dump. No `vlab_prepro` pipeline.
2. **Per-survey export tab** -- the Export tab on each survey shows that survey's exports. No global /exports page needed (or keep as secondary).
3. **Exports are a log** -- every export is a new row. No overwrites. No unique constraint on (survey, user).
4. **Source as a field** -- whether the export pulls from `responses` or `chat_log` is a `source` column value, not a structural discriminator.
5. **UUID tracking** -- dashboard-server generates a UUID for each export, INSERTs the initial "Started" row directly, then passes the UUID through Kafka so the exporter can UPDATE that specific row on completion.
6. **Form page with toggles** -- the chat log export button links to a form page with `include_raw_payload` (default OFF) and `include_metadata` (default OFF) toggles.

## Required Reading

An implementer must read these files before starting:

| File | Why |
|------|-----|
| `/home/nandan/Documents/vlab-research/fly-chat-log/exporter/exporter/main.py` | Kafka consumer loop, message parsing, `KafkaMessage` model |
| `/home/nandan/Documents/vlab-research/fly-chat-log/exporter/exporter/exporter.py` | Core export logic: `export_data()`, `export_chat_log()`, `set_export_status()`, `ExportOptions` model |
| `/home/nandan/Documents/vlab-research/fly-chat-log/exporter/exporter/db.py` | Database access: `query()` and `execute()` functions |
| `/home/nandan/Documents/vlab-research/fly-chat-log/exporter/exporter/storage.py` | Storage backends, `get_storage_backend()` |
| `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-server/api/exports/exports.controller.js` | Export trigger + status controller |
| `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-server/api/exports/exports.routes.js` | Route definitions for `/exports` |
| `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-server/queries/exports/exports.queries.js` | DB queries for export_status |
| `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/containers/SurveyScreen/SurveyScreen.js` | `ExportPanel` component (lines 102-107) |
| `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/containers/CreateExport/CreateExport.js` | Export creation form -- use as template for `CreateChatLogExport` |
| `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/root.js` | Route definitions -- add new route here |
| `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/containers/index.js` | Container barrel exports -- add new container here |
| `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/containers/Exports/Exports.js` | Export list table |
| `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/services/api/startExport.js` | API call to trigger export |
| `/home/nandan/Documents/vlab-research/fly-chat-log/devops/migrations/02-export-status.sql` | Current export_status schema |
| `/home/nandan/Documents/vlab-research/fly-chat-log/devops/migrations/08-chat-log.sql` | chat_log table schema |

---

## Step-by-Step Changes

### Step 1: Database Migration -- Redesign `export_status` as an Append-Only Log

**File**: REPLACE `/home/nandan/Documents/vlab-research/fly-chat-log/devops/migrations/09-export-type.sql` with new content (rename to `09-export-log-redesign.sql` for clarity)

This migration transforms `export_status` from a "one row per user per survey" upsert table into an append-only log. Changes:

1. **Add `id` column** (UUID, auto-generated primary key) for tracking individual export attempts.
2. **Add `source` column** (`'responses'` or `'chat_log'`) to indicate what data the export pulls from.
3. **Drop the UNIQUE constraint** on `(survey_id, user_id)` so multiple exports can exist per user per survey.

#### Exact SQL

```sql
/*
 * Redesign export_status as an append-only export log.
 *
 * Previously: one row per (survey_id, user_id), upserted on each export.
 * Now: every export attempt is a new row with a unique UUID id.
 *
 * Changes:
 *   1. Add 'id' column (UUID primary key) for tracking individual exports.
 *   2. Add 'source' column to distinguish 'responses' vs 'chat_log' exports.
 *   3. Drop the UNIQUE constraint on (survey_id, user_id) to allow multiple exports.
 *
 * Note: CockroachDB supports gen_random_uuid() natively.
 * Note: We keep export_type (added by previous migration if it exists) for safety,
 *       but the new 'source' column is the canonical field going forward.
 */

-- Add the UUID primary key column with auto-generated default
ALTER TABLE chatroach.export_status
    ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

-- Add the source column (what data this export pulls from)
ALTER TABLE chatroach.export_status
    ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'responses';

-- Drop the unique constraint so multiple exports can exist per user per survey.
-- Handle both possible constraint names: the original from 02-export-status.sql
-- and the one from 09-export-type.sql if it was applied.
ALTER TABLE chatroach.export_status
    DROP CONSTRAINT IF EXISTS unique_status;

-- Add primary key on id (only if no PK exists yet -- the original table had no PK)
-- CockroachDB requires a primary key; if one does not exist, it uses rowid implicitly.
-- We make id the explicit primary key for clarity and for use in UPDATE WHERE id = $1.
-- Note: If the table already has an implicit rowid PK, we need to handle this.
-- CockroachDB approach: add a unique index on id instead, since altering PK is complex.
CREATE UNIQUE INDEX IF NOT EXISTS idx_export_status_id ON chatroach.export_status (id);

-- Index for per-survey filtering (the primary query pattern going forward)
CREATE INDEX IF NOT EXISTS idx_export_status_survey ON chatroach.export_status (survey_id);

-- Index for per-user filtering (the global list query)
CREATE INDEX IF NOT EXISTS idx_export_status_user ON chatroach.export_status (user_id);

GRANT SELECT ON TABLE chatroach.export_status TO chatreader;
GRANT INSERT, SELECT, UPDATE ON TABLE chatroach.export_status TO chatroach;
```

**Current schema** (from `02-export-status.sql`):
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

**After migration, effective schema**:
```
export_status:
    id           UUID DEFAULT gen_random_uuid()   -- unique per export attempt
    updated      TIMESTAMPTZ DEFAULT now() ON UPDATE now()
    user_id      VARCHAR NOT NULL
    survey_id    VARCHAR NOT NULL
    status       VARCHAR NOT NULL                  -- 'Started', 'Finished', 'Failed'
    export_link  VARCHAR NOT NULL
    source       VARCHAR NOT NULL DEFAULT 'responses'  -- 'responses' or 'chat_log'
```

**What about the `export_type` column from the old `09-export-type.sql`?** If that migration was already applied to production, the column exists. This new migration does not drop it -- it is harmless. The new `source` column is the canonical field going forward. If `09-export-type.sql` was never applied, the `export_type` column simply does not exist, and this migration works fine. Either way the exporter and dashboard code should use `source`, not `export_type`.

**Important**: The old `09-export-type.sql` file must be replaced, not left alongside the new migration. We are replacing it because the old migration's UNIQUE constraint change is the opposite of what we want now.

---

### Step 2: Dashboard Server -- Generate UUID, INSERT "Started" Row, Pass ID Through Kafka

The key architectural change: the dashboard server now does two things when an export is requested:

1. **Generate a UUID** for the export.
2. **INSERT the initial "Started" row** into `export_status` directly -- the user sees "Started" immediately when the page refreshes.
3. **Publish the Kafka message** with the `export_id` so the exporter knows which row to UPDATE.

This means the dashboard server needs a database connection to `export_status` for writes. Currently the dashboard server only reads from `export_status` (via `getAll`). We need to add an INSERT query.

#### 2a. Add `insert` query to exports queries

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-server/queries/exports/exports.queries.js`

Add a new function to insert the initial "Started" row:

```javascript
'use strict';

class RequestError extends Error {}

async function checkUserExists(email, pool) {
  const query = `
  SELECT EXISTS(SELECT 1 FROM users WHERE users.email = $1);
`;
  const { rows } = await pool.query(query, [email]);
  return rows;
}

async function _all(email, pool) {
  const query = `SELECT * FROM export_status WHERE user_id = $1 ORDER BY updated DESC`;
  const { rows } = await pool.query(query, [email]);
  return rows;
}

async function _bySurvey(email, surveyName, pool) {
  const query = `SELECT * FROM export_status WHERE user_id = $1 AND survey_id = $2 ORDER BY updated DESC`;
  const { rows } = await pool.query(query, [email, surveyName]);
  return rows;
}

async function _insert(id, email, surveyName, source, pool) {
  const query = `
    INSERT INTO export_status (id, user_id, survey_id, status, export_link, source)
    VALUES ($1, $2, $3, 'Started', 'Not Found', $4)
  `;
  await pool.query(query, [id, email, surveyName, source]);
}

async function all(email) {
  const userCheck = await checkUserExists(email, this);
  const [user] = userCheck;

  if (!user.exists) {
    throw new RequestError(
      `No exports were found for user: ${email}`,
    );
  }

  let responses = await _all(email, this);
  return { responses };
}

async function bySurvey(email, surveyName) {
  const userCheck = await checkUserExists(email, this);
  const [user] = userCheck;

  if (!user.exists) {
    throw new RequestError(
      `No exports were found for user: ${email}`,
    );
  }

  let responses = await _bySurvey(email, surveyName, this);
  return { responses };
}

async function insert(id, email, surveyName, source) {
  await _insert(id, email, surveyName, source, this);
}

module.exports = {
  name: 'Exports',
  _all,
  _bySurvey,
  _insert,
  queries: pool => ({
    all: all.bind(pool),
    bySurvey: bySurvey.bind(pool),
    insert: insert.bind(pool),
  }),
};
```

**What changed**:
- Added `_bySurvey()` -- queries export_status filtered by `user_id` AND `survey_id`, ordered by `updated DESC`.
- Added `_insert()` -- inserts a new "Started" row with a given UUID, user, survey, and source.
- Added `bySurvey()` and `insert()` as bound public methods.
- Added `ORDER BY updated DESC` to `_all` so newest exports appear first.

#### 2b. Modify the controller to generate UUID and INSERT before publishing

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-server/api/exports/exports.controller.js`

```javascript
'use strict';
const crypto = require('crypto');
const { Exports } = require('../../queries');
const { KafkaUtil } = require('../../utils');
const { EXPORTS_TOPIC } = require('../../config').KAFKA;

function handle(err, res) {
  console.error(err);
  res.status(500).end();
}

exports.getAll = async (req, res) => {
  try {
    const { email } = req.user;

    if (!email) {
      return res.status(400).send('No user, no responses!');
    }

    const responses = await Exports.all(email);
    res.status(200).send(responses.responses);
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
};

exports.getBySurvey = async (req, res) => {
  try {
    const { email } = req.user;
    const { survey } = req.query;

    if (!email) {
      return res.status(400).send('No user, no responses!');
    }

    if (!survey) {
      return res.status(400).send('survey query parameter is required');
    }

    const responses = await Exports.bySurvey(email, survey);
    res.status(200).send(responses.responses);
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
};

// Creates a message on Kafka that will start an export.
// The dashboard-server generates a UUID, inserts the initial "Started" row,
// then publishes the Kafka message with the export_id so the exporter
// can UPDATE that row on completion.
exports.generateExport = async (req, res) => {
  const { survey } = req.query;
  const { export_type, ...options } = req.body;

  const { email } = req.user;
  const source = export_type === 'chat_log' ? 'chat_log' : 'responses';
  const exportId = crypto.randomUUID();

  try {
    // 1. Insert "Started" row so the user sees it immediately
    await Exports.insert(exportId, email, survey, source);

    // 2. Publish Kafka message with the export_id
    const producer = KafkaUtil.Conn.producer({
      createPartitioner: KafkaUtil.Partitioners.DefaultPartitioner
    });
    await producer.connect();
    const message = {
      event: 'data-export',
      user: email,
      survey: survey,
      export_id: exportId,
      source: source,
      ...(source === 'chat_log'
        ? { chat_log_options: options }
        : { options: options })
    };

    await producer.send({
      topic: EXPORTS_TOPIC,
      messages: [{ key: survey, value: JSON.stringify(message) }],
    });
    await producer.disconnect();
    return res.status(201).send({ status: 'success', export_id: exportId });
  } catch (err) {
    handle(err, res);
  }
};
```

**What changed**:
- `generateExport` now generates a UUID via `crypto.randomUUID()`.
- It INSERTs the initial "Started" row into `export_status` before publishing to Kafka.
- The Kafka message includes `export_id` (UUID) and `source` (instead of `export_type`).
- Added `getBySurvey` controller for per-survey filtering.
- The response now includes `export_id` so the client could use it if needed.

#### 2c. Add the per-survey route

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-server/api/exports/exports.routes.js`

```javascript
const router = require('express').Router();
const controller = require('./exports.controller');

router
  .post('/', controller.generateExport)
  .get('/status', controller.getAll)
  .get('/status/survey', controller.getBySurvey);

module.exports = router;
```

**What changed**: Added `GET /exports/status/survey?survey=<name>` route for per-survey filtering.

#### Kafka Message Formats

**Response Export**:
```json
{
  "event": "data-export",
  "user": "user@example.com",
  "survey": "my-survey-name",
  "export_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "source": "responses",
  "options": {
    "pivot": true,
    "keep_final_answer": true,
    "drop_duplicated_users": true,
    "add_duration": true,
    "response_value": "translated_response",
    "metadata": ["stratum_age"]
  }
}
```

**Chat Log Export**:
```json
{
  "event": "data-export",
  "user": "user@example.com",
  "survey": "my-survey-name",
  "export_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "source": "chat_log",
  "chat_log_options": {
    "include_raw_payload": false,
    "include_metadata": true
  }
}
```

**Key change from previous plan**: The message now includes `export_id` (UUID) and uses `source` instead of `export_type`. The exporter no longer needs to INSERT a "Started" row -- it just UPDATEs the existing one.

---

### Step 3: Exporter -- Update to Use `export_id` for Status Updates

The exporter no longer INSERTs "Started" rows. The dashboard-server already did that. The exporter now:

1. Receives the `export_id` from the Kafka message.
2. On completion, UPDATEs the row `WHERE id = export_id` to set status and link.
3. On failure, UPDATEs the row `WHERE id = export_id` to set status to "Failed".

#### 3a. Modify `KafkaMessage` model

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/exporter/exporter/main.py`

```python
import json
import os

from confluent_kafka import Consumer
from dotenv import load_dotenv
from pydantic import BaseModel

from .exporter import ExportOptions, export_data, export_chat_log
from .log import log

# load the env file into the environment
load_dotenv()

# Settings
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC", "vlab-exports")
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "")
KAFKA_GROUP_ID = os.getenv("KAFKA_GROUP_ID", "exporter")
KAFKA_MAX_POLL_INTERVAL = os.getenv("KAFKA_MAX_POLL_INTERVAL", "1200000")
DATABASE_URL = os.getenv("DATABASE_URL")


class ChatLogExportOptions(BaseModel):
    include_raw_payload: bool = False
    include_metadata: bool = False


class KafkaMessage(BaseModel):
    event: str
    survey: str
    user: str
    export_id: str                                                 # UUID generated by dashboard-server
    source: str = "responses"                                      # 'responses' or 'chat_log'
    options: ExportOptions = ExportOptions()
    chat_log_options: ChatLogExportOptions = ChatLogExportOptions()
```

**What changed**:
- `export_type` renamed to `source` to match the new schema column name.
- Added `export_id` (required field) -- the UUID generated by dashboard-server.

**Backwards compatibility note**: Messages already in the Kafka queue from the old code will NOT have `export_id` and will fail to parse (Pydantic will raise a validation error for the missing required field). This is acceptable because:
- The exporter and dashboard-server should be deployed together.
- Any in-flight messages at deploy time will error and be logged (the existing `except BaseException` in `app()` catches this).
- If backwards compat is critical, make `export_id` optional (`export_id: str | None = None`) and fall back to the old INSERT behavior when it is None. This is discussed in the "Backwards Compatibility" section below.

**Update `process()`**:

```python
def process(cnf, data: KafkaMessage):
    """
    The main message processor
    """
    log.info(f"processing {data.source} export for study {data.survey} (id={data.export_id})")
    if data.source == "chat_log":
        export_chat_log(cnf, data.export_id, data.user, data.survey, data.chat_log_options)
    else:
        export_data(cnf, data.export_id, data.user, data.survey, data.options)
```

**What changed**: Passes `data.export_id` to export functions. Uses `data.source` instead of `data.export_type`.

#### 3b. Modify `set_export_status()` to UPDATE by `export_id`

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/exporter/exporter/exporter.py`

The function no longer does an UPSERT. It just UPDATEs the row that the dashboard-server already INSERTed.

```python
def set_export_status(cnf, export_id, url="Not Found", status="Failed"):
    """
    Update the export_status row identified by export_id.
    The row was already INSERTed by the dashboard-server with status='Started'.
    """
    q = """
        UPDATE export_status
        SET status = %s, export_link = %s
        WHERE id = %s
    """
    execute(cnf, q, vals=(status, url, export_id))
```

**What changed**:
- Signature simplified: takes `export_id`, `url`, `status` only. No more `user`, `survey`, `export_type`/`source` params -- those are already on the row.
- SQL is a simple UPDATE WHERE id = %s. No INSERT, no ON CONFLICT.
- The `updated` column updates automatically via `ON UPDATE now()`.

#### 3c. Update `export_data()` to use new signature

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/exporter/exporter/exporter.py`

```python
def export_data(cnf, export_id, user, survey, options: ExportOptions):
    log.info(f"starting csv export for survey: {survey}")
    set_export_status(cnf, export_id, status="Started")
    storage_backend = storage.get_storage_backend(file_path=f"exports/{survey}.csv")

    try:
        # Get responses and form data from database
        responses = get_responses(cnf, user, survey)
        form_data = get_form_data(cnf, user, survey)

        # process data using the vlab prepro library
        dd = format_data(responses, form_data, options)

        # store as csv on configured backend
        storage_backend.save_to_csv(dd)
        url = storage_backend.generate_link()
        set_export_status(cnf, export_id, url, status="Finished")
        log.info(f"finished csv export for survey: {survey}")
    except Exception as e:
        set_export_status(cnf, export_id, status="Failed")
        raise e
```

**What changed**:
- Added `export_id` parameter.
- All `set_export_status` calls now pass `export_id` instead of `user, survey, export_type`.
- Note: The initial `set_export_status(cnf, export_id, status="Started")` is technically redundant (the row is already "Started"), but it is harmless and serves as a confirmation/log that the exporter has picked up the job. It could be removed if desired.

#### 3d. Update `export_chat_log()` to use new signature

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/exporter/exporter/exporter.py`

```python
def export_chat_log(cnf, export_id, user, survey, chat_log_options):
    """
    Export raw chat log data as CSV for a survey.
    No preprocessing -- just a direct dump of the chat_log table.
    Optional columns (raw_payload, metadata) are controlled by chat_log_options.
    """
    log.info(f"starting chat log export for survey: {survey}")
    set_export_status(cnf, export_id, status="Started")
    storage_backend = storage.get_storage_backend(
        file_path=f"exports/{survey}_chat_log.csv"
    )

    try:
        chat_data = get_chat_log(cnf, user, survey, chat_log_options)

        if chat_data.empty:
            log.warning(f"no chat log data found for survey: {survey}")

        storage_backend.save_to_csv(chat_data)
        url = storage_backend.generate_link()
        set_export_status(cnf, export_id, url, status="Finished")
        log.info(f"finished chat log export for survey: {survey}")
    except Exception as e:
        set_export_status(cnf, export_id, status="Failed")
        raise e
```

**What changed**: Same pattern as `export_data()` -- uses `export_id` for status updates.

#### 3e. `get_chat_log()` -- No changes from current implementation

The `get_chat_log()` function at lines 179-215 of `exporter.py` is already correct. It accepts `chat_log_options` and conditionally includes `raw_payload` and `metadata` columns. No changes needed.

---

### Step 4: Dashboard Client -- Per-Survey Export List and Forms

#### 4a. Modify `startExport` API call -- No changes needed

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/services/api/startExport.js`

The current implementation already supports the `exportType` parameter. No changes needed -- the function sends `export_type` in the request body, which the server destructures and uses to set `source`.

#### 4b. Add `fetchExportsBySurvey` API function

**File**: NEW `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/services/api/fetchExportsBySurvey.js`

```javascript
import ApiClient from '.';

export default function fetchExportsBySurvey(surveyName) {
  return ApiClient.fetcher({
    method: 'GET',
    path: `/exports/status/survey?survey=${encodeURIComponent(surveyName)}`,
  }).then(res => res.json());
}
```

Update the barrel export:

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/services/api/index.js`

```javascript
import fetcher, { wrapApiResponse } from './fetcher';
import getCSV from './getCSV';

export default { fetcher, getCSV, wrapApiResponse };
```

No change needed to the barrel -- `fetchExportsBySurvey` is imported directly by consumers, same pattern as `startExport`.

#### 4c. Redesign `ExportPanel` to show per-survey exports inline

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/containers/SurveyScreen/SurveyScreen.js`

The Export tab on each survey should show:
1. The two export buttons (Export Responses, Export Chat Log) -- already there.
2. A table of exports filtered by that survey -- NEW.

```jsx
import React, { useState, useEffect } from 'react';
// ... existing imports ...
import { Table, Spin, Tabs } from 'antd';
import { Link } from 'react-router-dom';
import fetchExportsBySurvey from '../../services/api/fetchExportsBySurvey';

// ... existing code ...

const DownloadLink = (text) => (
  text && text !== 'Not Found'
    ? <Link to={{ pathname: text }} target="_blank">DOWNLOAD</Link>
    : null
);

const exportColumns = [
  { title: 'Source', dataIndex: 'source', render: (text) => text === 'chat_log' ? 'Chat Log' : 'Responses' },
  { title: 'Status', dataIndex: 'status' },
  { title: 'Time', dataIndex: 'updated' },
  { title: 'Download', dataIndex: 'export_link', render: DownloadLink },
];

const ExportPanel = ({ selected }) => {
  const [exports, setExports] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchExportsBySurvey(selected)
      .then(data => setExports(data || []))
      .catch(err => console.error(err))
      .finally(() => setLoading(false));
  }, [selected]);

  return (
    <div style={{ padding: '24px 0' }}>
      <div style={{ marginBottom: 24 }}>
        <CreateBtn to={`/exports/create?survey_name=${encodeURIComponent(selected)}`}>
          EXPORT RESPONSES
        </CreateBtn>
        <CreateBtn to={`/exports/create-chat-log?survey_name=${encodeURIComponent(selected)}`} style={{ marginLeft: 16 }}>
          EXPORT CHAT LOG
        </CreateBtn>
      </div>

      <Spin spinning={loading}>
        <Table
          columns={exportColumns}
          dataSource={exports}
          rowKey="id"
          pagination={{ pageSize: 10 }}
        />
      </Spin>
    </div>
  );
};
```

**What changed**: `ExportPanel` is no longer a simple stateless component. It now fetches and displays that survey's export history inline. The `rowKey="id"` uses the new UUID column.

**Note on `PropTypes`**: Keep the existing `ExportPanel.propTypes = { selected: PropTypes.string.isRequired }`.

#### 4d. Update `CreateChatLogExport` form redirect

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/containers/CreateChatLogExport/CreateChatLogExport.js`

If this component already exists (from the previous plan's implementation), the only change is the redirect after submission. Instead of `history.push('/exports')`, redirect back to the survey's export tab:

```javascript
const onFinish = async (body) => {
  setLoading(true);
  await startExport(survey, body, 'chat_log');

  // Short wait for the exporter to pick up the job
  // (the "Started" row is already visible since dashboard-server INSERTs it)
  await new Promise(resolve => setTimeout(resolve, 1000));

  setLoading(false);
  // Navigate back -- the browser's back button or a manual redirect.
  // Since we don't have the survey URL path here, redirect to /exports
  // or use history.goBack().
  history.goBack();
};
```

**Note**: The artificial wait can be reduced from 4 seconds to 1 second (or removed entirely) because the "Started" row is now INSERTed by the dashboard-server synchronously before the Kafka message. The user will see "Started" immediately upon returning to the export tab. The wait is only needed if we want the user to potentially see "Finished" by the time they return.

Similarly update the existing `CreateExport` component's redirect if desired.

#### 4e. Update `Exports.js` table columns for `source`

**File**: `/home/nandan/Documents/vlab-research/fly-chat-log/dashboard-client/src/containers/Exports/Exports.js`

If the global exports page is kept, update the column to use `source` instead of `export_type`:

```javascript
let columns = [
  { title: 'Survey', dataIndex: 'survey_id' },
  { title: 'Source', dataIndex: 'source', render: (text) => text === 'chat_log' ? 'Chat Log' : 'Responses' },
  { title: 'User', dataIndex: 'user_id' },
  { title: 'Time Exported', dataIndex: 'updated' },
  { title: 'Status', dataIndex: 'status' },
  { title: 'Download', dataIndex: 'export_link', render: DownloadLink },
];
```

**What changed**: `export_type` dataIndex changed to `source` to match the new column name.

If the global exports page is removed entirely, this file can be left as-is or deleted.

---

## Backwards Compatibility Strategy

The migration from the old `ON CONFLICT` upsert model to the new `export_id` model requires coordinated deployment. There are two strategies:

### Option 1: Hard Cutover (Recommended for Simplicity)

Deploy migration, exporter, and dashboard-server together. Accept that any in-flight Kafka messages at deploy time will fail (they lack `export_id`). These will be logged and can be retried manually.

- Make `export_id` a required field on `KafkaMessage`.
- Deploy during low-traffic window.

### Option 2: Graceful Transition

Make `export_id` optional on `KafkaMessage`. If missing, fall back to the old INSERT behavior:

```python
class KafkaMessage(BaseModel):
    event: str
    survey: str
    user: str
    export_id: str | None = None         # None for old-style messages
    source: str = "responses"
    export_type: str = "responses"       # Legacy field, maps to source
    options: ExportOptions = ExportOptions()
    chat_log_options: ChatLogExportOptions = ChatLogExportOptions()
```

And in `set_export_status`:
```python
def set_export_status(cnf, export_id=None, url="Not Found", status="Failed",
                      user=None, survey=None, source="responses"):
    if export_id:
        q = "UPDATE export_status SET status = %s, export_link = %s WHERE id = %s"
        execute(cnf, q, vals=(status, url, export_id))
    else:
        # Legacy fallback: INSERT with generated id
        q = """
            INSERT INTO export_status (user_id, survey_id, status, export_link, source)
            VALUES (%s, %s, %s, %s, %s)
        """
        execute(cnf, q, vals=(user, survey, status, url, source))
```

**Recommendation**: Go with Option 1. The system is low-traffic enough that a coordinated deploy is straightforward, and the legacy code path adds complexity that will never be removed.

---

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `devops/migrations/09-export-type.sql` | **REPLACE** | Rename to `09-export-log-redesign.sql`. Drop unique constraint, add `id` UUID column, add `source` column, add indexes |
| `exporter/exporter/main.py` | MODIFY | `KafkaMessage` gets `export_id` (required) and `source` (replaces `export_type`). `process()` passes `export_id` |
| `exporter/exporter/exporter.py` | MODIFY | `set_export_status()` simplified to UPDATE by id. `export_data()` and `export_chat_log()` pass `export_id` |
| `dashboard-server/api/exports/exports.controller.js` | MODIFY | Generate UUID, INSERT "Started" row, pass `export_id` in Kafka message. Add `getBySurvey` controller |
| `dashboard-server/api/exports/exports.routes.js` | MODIFY | Add `GET /exports/status/survey` route |
| `dashboard-server/queries/exports/exports.queries.js` | MODIFY | Add `_bySurvey()`, `_insert()` queries. Add `ORDER BY updated DESC` |
| `dashboard-client/src/services/api/fetchExportsBySurvey.js` | **NEW** | Fetch exports filtered by survey name |
| `dashboard-client/src/containers/SurveyScreen/SurveyScreen.js` | MODIFY | `ExportPanel` fetches and displays per-survey export history inline |
| `dashboard-client/src/containers/Exports/Exports.js` | MODIFY | Column `export_type` -> `source` |
| `dashboard-client/src/containers/CreateChatLogExport/CreateChatLogExport.js` | MODIFY (or NEW) | Reduce artificial wait, redirect with `goBack()` |
| `dashboard-client/src/containers/CreateChatLogExport/index.js` | NEW (if not exists) | Barrel export |
| `dashboard-client/src/containers/index.js` | MODIFY (if not done) | Add `CreateChatLogExport` import |
| `dashboard-client/src/root.js` | MODIFY (if not done) | Add `/exports/create-chat-log` route |

---

## Implementation Order

1. **Migration** (Step 1) -- must run before any code changes hit production. This is safe to run on an existing database because it only adds columns and drops a constraint.
2. **Dashboard Server** (Step 2) -- must be deployed alongside or before the exporter, because it now INSERTs the "Started" row that the exporter expects to UPDATE.
3. **Exporter** (Step 3) -- must be deployed at the same time as dashboard-server (or immediately after), since it expects messages with `export_id`.
4. **Dashboard Client** (Step 4) -- can be deployed independently after the server.

**Critical deployment constraint**: Steps 2 and 3 must be deployed together (or server first, exporter second). If the exporter deploys first with the new code, it will fail on old-format Kafka messages. If the server deploys first, old-format exporter will ignore the `export_id` field (Pydantic will reject it unless we use Option 2).

**Safest order**: Migration -> Server + Exporter together -> Client.

---

## Test Strategy

### Unit Tests

#### Exporter

1. **Test `set_export_status()` UPDATE**: Verify the SQL is `UPDATE ... WHERE id = %s` with correct parameter ordering.

2. **Test `export_chat_log()` end-to-end**: Mock the database and storage backend. Verify:
   - `set_export_status` called with `export_id` and `status="Started"` before processing
   - File path is `exports/{survey}_chat_log.csv`
   - `set_export_status` called with `export_id`, url, and `status="Finished"` on success
   - `set_export_status` called with `export_id` and `status="Failed"` on exception
   - CSV contains only base columns when both toggles are OFF
   - CSV includes `metadata` column when `include_metadata=True`
   - CSV includes `raw_payload` column when `include_raw_payload=True`

3. **Test `KafkaMessage` parsing**:
   - Message with `export_id` and `source` parses correctly
   - Message without `source` defaults to `"responses"`
   - Message with `chat_log_options` parses correctly
   - Message without `chat_log_options` defaults to both toggles OFF
   - Message without `export_id` raises validation error (or defaults to None if using Option 2)

4. **Test `process()` routing**: Verify that `source="chat_log"` calls `export_chat_log()` with `export_id` and `chat_log_options`, and `source="responses"` calls `export_data()` with `export_id` and `options`.

#### Dashboard Server

5. **Test `generateExport` controller**:
   - Generates a UUID
   - Calls `Exports.insert(id, email, survey, source)` before publishing to Kafka
   - Kafka message includes `export_id`, `source`, and correct options key
   - Body with `export_type: "chat_log"` produces `source: "chat_log"` and `chat_log_options`
   - Body without `export_type` produces `source: "responses"` and `options`

6. **Test `getBySurvey` controller**:
   - Returns exports filtered by survey name
   - Returns 400 if no survey query param

7. **Test `_insert` query**: Verify INSERT SQL with correct columns and values.

8. **Test `_bySurvey` query**: Verify SELECT with WHERE user_id AND survey_id, ORDER BY updated DESC.

#### Dashboard Client

9. **Test ExportPanel**: Verify:
   - Both buttons render
   - Fetches exports for the selected survey on mount
   - Displays export table with Source, Status, Time, Download columns
   - Uses `id` as row key

10. **Test CreateChatLogExport form**: Verify:
    - Both toggles render and default to OFF
    - Submitting calls `startExport(survey, { include_raw_payload: false, include_metadata: false }, 'chat_log')`
    - After submit, navigates back

11. **Test Exports table** (if global page kept): Verify `source` column renders "Chat Log" / "Responses".

### Integration / Manual Testing

12. **Migration test**: Run migration against a database that already has `export_status` rows. Verify:
    - Existing rows get `source = 'responses'` and a generated `id`
    - The unique constraint is gone -- can INSERT multiple rows for same (survey_id, user_id)
    - Can filter by survey_id with the new index

13. **End-to-end flow**:
    - Navigate to a survey's Export tab
    - Verify previous exports for that survey are displayed
    - Click "Export Chat Log" -- verify form opens
    - Submit with default toggles
    - Verify "Started" row appears immediately in the export table (no need to wait for Kafka)
    - Wait for exporter to finish -- verify row transitions to "Finished" with download link
    - Click "Export Responses" for the same survey -- verify a second row appears
    - Verify both exports coexist with correct Source labels
    - Trigger multiple exports for the same survey -- verify all appear as separate rows

---

## Acceptance Criteria

1. Every export attempt creates a new row in `export_status` -- nothing is overwritten.
2. The Export tab on each survey shows that survey's exports (filtered by survey name).
3. The export list shows: Source (Responses/Chat Log), Status, Time, Download link.
4. A user can trigger a chat log export from the form page with `include_raw_payload` and `include_metadata` toggles.
5. The "Started" status appears immediately when the user returns to the export tab (no waiting for Kafka roundtrip).
6. Multiple exports for the same survey appear as separate rows, ordered newest first.
7. The chat log CSV contains base columns by default, plus optional columns when toggled on.
8. Existing response exports continue to work identically -- no regressions.
9. The exported CSV file paths are: `exports/{survey_name}.csv` for responses, `exports/{survey_name}_chat_log.csv` for chat logs.

---

## Risks and Considerations

1. **Coordinated deployment**: The exporter and dashboard-server must be deployed together because the message format changes (adds required `export_id`, renames `export_type` to `source`). Mitigate by deploying during low-traffic window.

2. **UUID in CockroachDB**: `gen_random_uuid()` is native to CockroachDB and works out of the box. No extension needed (unlike PostgreSQL which needs `pgcrypto`). In Node.js, `crypto.randomUUID()` is available since Node 19+; verify the dashboard-server's Node version supports this. If not, use `require('uuid').v4()` (the `uuid` package).

3. **Large exports / many rows**: Since exports are no longer deduplicated per survey+user, the `export_status` table will grow unboundedly. For now this is acceptable (exports are infrequent). Future consideration: add a TTL or cleanup job for old "Failed" rows.

4. **Row visibility race condition**: The dashboard-server INSERTs the "Started" row and then publishes to Kafka. If the INSERT fails, no Kafka message is sent (the try/catch handles this). If the Kafka publish fails after INSERT, there will be a "Started" row that never transitions to "Finished". This is visible to the user but acceptable -- they can see it stuck at "Started" and retry. Future improvement: add a "Stale" cleanup for Started rows older than N minutes.

5. **Empty exports**: If the chat_log table has no data for a survey, the export will produce a CSV with only headers. The status will still be "Finished" with a valid download link.

6. **Join correctness**: Same consideration as before -- `get_chat_log()` joins on `shortcode`, which is correct given the `survey_name` filter prevents cross-survey pollution.

---

## SQL Reference

### Migration (09-export-log-redesign.sql)

```sql
ALTER TABLE chatroach.export_status
    ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

ALTER TABLE chatroach.export_status
    ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'responses';

ALTER TABLE chatroach.export_status
    DROP CONSTRAINT IF EXISTS unique_status;

CREATE UNIQUE INDEX IF NOT EXISTS idx_export_status_id ON chatroach.export_status (id);
CREATE INDEX IF NOT EXISTS idx_export_status_survey ON chatroach.export_status (survey_id);
CREATE INDEX IF NOT EXISTS idx_export_status_user ON chatroach.export_status (user_id);

GRANT SELECT ON TABLE chatroach.export_status TO chatreader;
GRANT INSERT, SELECT, UPDATE ON TABLE chatroach.export_status TO chatroach;
```

### Dashboard Server INSERT

```sql
INSERT INTO export_status (id, user_id, survey_id, status, export_link, source)
VALUES ($1, $2, $3, 'Started', 'Not Found', $4)
```

### Dashboard Server SELECT (per-survey)

```sql
SELECT * FROM export_status WHERE user_id = $1 AND survey_id = $2 ORDER BY updated DESC
```

### Exporter UPDATE

```sql
UPDATE export_status SET status = %s, export_link = %s WHERE id = %s
```

### Chat Log Query (unchanged from current code)

```sql
SELECT cl.userid, cl.pageid, cl.timestamp::string, cl.direction,
       cl.content, cl.question_ref, cl.shortcode, cl.surveyid::string,
       cl.message_type
       [, cl.metadata::string]
       [, cl.raw_payload::string]
FROM chat_log cl
INNER JOIN surveys s ON cl.shortcode = s.shortcode
INNER JOIN users u ON s.userid = u.id
WHERE u.email = %s AND s.survey_name = %s
ORDER BY (cl.userid, cl.timestamp)
```
