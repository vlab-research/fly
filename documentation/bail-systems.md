# Bail Systems

## Table of Contents

1. [Overview](#overview)
2. [User-Facing Behavior](#user-facing-behavior)
3. [Bail Types](#bail-types)
4. [Bail Definition Model](#bail-definition-model)
5. [Access Control](#access-control)
6. [Component Responsibilities](#component-responsibilities)
7. [Execution Model](#execution-model)
8. [Event Audit Trail](#event-audit-trail)
9. [API Endpoints Reference](#api-endpoints-reference)
10. [Data Transformation](#data-transformation)
11. [Frontend-Backend Mapping](#frontend-backend-mapping)
12. [Configuration](#configuration)

---

## Overview

Bail systems are automated rules that redirect survey respondents from one form to another based on configurable conditions. They replace the previous approach of hand-written Kubernetes CronJob manifests (`bailer-job/kube/`) with a database-driven, UI-manageable system.

Common use cases:

- **Timeout recovery**: Move users stuck in `WAIT_EXTERNAL_EVENT` for more than N weeks to an intermediate form
- **Error recovery**: Redirect users in `BLOCKED` state with specific error codes back to retry
- **End of study**: Move all users on a form to an exit survey at a specific date/time
- **Stuck question recovery**: Bail users stuck at a particular question
- **Direct targeting**: Send a specific list of users to specific destination forms (user list bails)

A bail is owned by a user (not a survey) and can query across any forms that user owns. Conditions such as `question_response` and `elapsed_time` scope their queries to specific form shortcodes, enabling cross-survey bail rules — for example, bailing users from any of several survey forms into a single exit survey.

## User-Facing Behavior

### Bail List

The dashboard shows a table of all bail systems for the authenticated user at `/bails`. Each row displays:

- Name (links to edit form)
- Enabled toggle (can enable/disable inline)
- Timing mode (color-coded tag: green=immediate, blue=scheduled, orange=absolute)
- Destination form shortcode
- Last execution timestamp and user counts
- Action buttons: edit, view event history, delete (with confirmation)

### Creating a Bail

The create form (`/bails/create`) has four sections:

1. **Basic Information** -- name, description, enabled toggle
2. **Definition** -- either a visual condition builder (for conditions-type bails) or a user list (for user_list-type bails). Conditions support AND/OR/NOT logic trees with condition types: form, state, error_code, current_question, elapsed_time, question_response (with a mode toggle for "is answered" vs "equals specific response"), surveyid
3. **Execution Timing** -- choose immediate, scheduled (daily at a time + timezone), or absolute (one-time at a datetime)
4. **Action** -- destination form shortcode and optional JSON metadata (conditions-type bails only)

A **Preview** button performs a dry-run query showing how many users currently match the conditions and a sample of their IDs. For conditions-based bails, the generated SQL and parameters are also returned.

### Event History

Each bail has an event history view (`/bails/:bailId/events`) showing a table of past executions with timestamp, event type (execution or error), users matched, users bailed, and error details if any.

---

## Bail Types

A `BailDefinition` has a `type` field that determines how target users are identified:

| Type | Description |
|------|-------------|
| `"conditions"` | (default) Builds a SQL query from a condition tree. All bails created before `type` was introduced are implicitly `"conditions"`. |
| `"user_list"` | Targets a fixed, explicitly enumerated list of users. No SQL query is built. |

### Conditions Type

The default type. Uses a recursive condition tree to build a SQL query against the `states` and `responses` tables. The `action.destination_form` field is required and specifies where all matched users are sent.

### User List Type

Targets a fixed list of up to 1000 users. Each entry specifies the user, their page, and their **individual destination form** (`shortcode`). This allows sending different users to different forms in a single bail.

`action.destination_form` is not used for `user_list` bails — the destination is per-user in the list.

```json
{
  "type": "user_list",
  "user_list": {
    "users": [
      { "userid": "user1", "pageid": "page1", "shortcode": "survey_a" },
      { "userid": "user2", "pageid": "page2", "shortcode": "survey_b" }
    ]
  },
  "execution": { "timing": "immediate" },
  "action": {}
}
```

**Validation rules:**
- `users` array must have 1–1000 entries
- Each entry must have non-empty `userid`, `pageid`, and `shortcode`
- `action` is present in the JSON but `destination_form` is not validated (ignored)

**Preview behavior:** Returns the user list directly without executing a query. `sql` and `params` are empty in the preview response.

---

## Bail Definition Model

A bail definition is a JSON object with the following top-level structure:

```json
{
  "type": "conditions",
  "conditions": { ... },
  "execution": { ... },
  "action": { ... }
}
```

Or for user list bails:

```json
{
  "type": "user_list",
  "user_list": { "users": [...] },
  "execution": { ... },
  "action": {}
}
```

The `type` field defaults to `"conditions"` when omitted.

### Conditions

Conditions define **who** gets bailed. They form a recursive tree supporting AND/OR/NOT logic.

**Simple condition types:**

| Type | Matches on | Example |
|------|-----------|---------|
| `form` | `states.current_form` | `{"type": "form", "value": "mysurvey"}` |
| `state` | `states.current_state` | `{"type": "state", "value": "WAIT_EXTERNAL_EVENT"}` |
| `error_code` | `states.state_json->'error'->>'code'` | `{"type": "error_code", "value": "10"}` |
| `current_question` | `states.state_json->>'question'` | `{"type": "current_question", "value": "hello_again"}` |
| `elapsed_time` | Time since a response event (scoped to a shortcode) | See below |
| `question_response` | `responses` table (shortcode + question_ref + optional response) | See below |
| `surveyid` | `states.current_form` (via subquery into `surveys.id`) | `{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}` |

**Elapsed time** is the most complex condition. It references a specific response event (identified by form shortcode and question ref) and checks if enough time has passed since that response:

```json
{
  "type": "elapsed_time",
  "since": {
    "event": "response",
    "details": { "question_ref": "thankyou", "form": "myform" }
  },
  "duration": "4 weeks"
}
```

The `form` in `since.details` is a form shortcode. Only the `"response"` event type is supported.

Duration uses the format `<number> <unit>` where unit is one of: `microseconds`, `milliseconds`, `seconds`, `minutes`, `hours`, `days`, `weeks`, `months`, `years` (singular or plural). This is passed directly to PostgreSQL as an interval: `$N::INTERVAL`. Examples: `"4 weeks"`, `"2 days"`, `"1 hour"`, `"30 minutes"`. Formats like `"4w"` or `"4 weeks ago"` are rejected.

**Question response** conditions select users based on their survey answers. `form` (shortcode) and `question_ref` are required; `response` is optional.

Mode 1 — Equals specific response (user answered question X with exactly response Y):

```json
{
  "type": "question_response",
  "form": "intake-survey",
  "question_ref": "consent_question",
  "response": "Yes"
}
```

Mode 2 — Is answered (user answered question X at all, any response):

```json
{
  "type": "question_response",
  "form": "intake-survey",
  "question_ref": "consent_question"
}
```

If `response` is provided, only users who answered that question with exactly that value are matched. If `response` is omitted (not just empty string — the key must be absent), all users who answered the question with any value are matched.

Implementation uses a CTE with an INNER JOIN against the `responses` table, similar to `elapsed_time`. Wrapping `question_response` inside a NOT operator is not supported for the same reason as `elapsed_time`: the INNER JOIN cannot express "users who did NOT answer this question".

**Survey ID** conditions select users whose current form belongs to the survey with the given UUID. This is useful when you want to target all users currently on any form within a specific survey, without having to enumerate the individual form shortcodes.

```json
{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}
```

The `value` field must be the UUID of the survey (as stored in `surveys.id`). The condition matches users where `states.current_form` is any form belonging to that survey (resolved via a subquery: `s.current_form IN (SELECT shortcode FROM surveys WHERE id = $N)`).

Unlike `elapsed_time` and `question_response`, `surveyid` is safe to wrap in a NOT operator. It does not use an INNER JOIN CTE against a separate table; the subquery operates on the states row itself, so negation works correctly.

**Logical operators** combine conditions:

- **`and`** -- all child conditions must match. Takes 1 or more children.
- **`or`** -- any child condition must match. Takes 1 or more children.
- **`not`** -- negates a single child condition. Takes exactly 1 child.

```json
{
  "op": "and",
  "vars": [
    { "type": "form", "value": "myform" },
    { "type": "state", "value": "BLOCKED" },
    {
      "op": "or",
      "vars": [
        { "type": "error_code", "value": "10" },
        { "type": "error_code", "value": "11" }
      ]
    }
  ]
}
```

**NOT operator examples:**

Negate a single condition (match users whose state is NOT "END"):

```json
{"op": "not", "vars": [{"type": "state", "value": "END"}]}
```

NOT inside an AND group (match users on a form whose state is NOT "END"):

```json
{
  "op": "and",
  "vars": [
    {"type": "form", "value": "myform"},
    {"op": "not", "vars": [{"type": "state", "value": "END"}]}
  ]
}
```

**NOT operator constraints:**
- Must have exactly 1 child (validation rejects 0 or 2+ children).
- Cannot negate `elapsed_time` or `question_response` conditions, directly or transitively. Both conditions use INNER JOIN CTEs against the responses table; negating them would require LEFT JOIN + IS NULL semantics to correctly include users who never responded, which is not yet supported.
- `surveyid` IS safe to wrap in NOT.

**SQL generation for NOT:**

| Condition | Generated SQL |
|-----------|--------------|
| `{"op": "not", "vars": [{"type": "state", "value": "END"}]}` | `NOT (s.current_state = $1)` |
| `{"op": "not", "vars": [{"op": "and", "vars": [...]}]}` | `NOT ((child1 AND child2))` |

### SQL Generation Examples

**Simple conditions-based query** (form + state):

```sql
SELECT DISTINCT s.userid, s.pageid
FROM states s
WHERE (s.current_form = $1 AND s.current_state = $2)
LIMIT 100000
```

**Elapsed time** — uses a named CTE joined to `states`:

```sql
WITH response_times_0 AS (
    SELECT userid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2
    GROUP BY userid
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN response_times_0 rt0 ON s.userid = rt0.userid
WHERE rt0.response_time + $3::INTERVAL < NOW()
LIMIT 100000
```

Parameters: `[$form, $question_ref, $duration]`

**Question response (exact match):**

```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2 AND response = $3
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid
WHERE qr0.userid IS NOT NULL
LIMIT 100000
```

Parameters: `[$form, $question_ref, $response]`

**Question response (any answer):**

```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid
WHERE qr0.userid IS NOT NULL
LIMIT 100000
```

Parameters: `[$form, $question_ref]`

### Execution Timing

Defines **when** the bail fires.

| Timing | Behavior | Required fields |
|--------|----------|-----------------|
| `immediate` | Executes on every CronJob tick (every minute) | None |
| `scheduled` | Executes daily at a specific time in a specific timezone | `time_of_day` (HH:MM), `timezone` (IANA) |
| `absolute` | Executes once at a specific datetime, then never again | `datetime` (ISO 8601) |

Deduplication:
- **Immediate**: No deduplication; runs every tick. Idempotent because botserver handles duplicate bailouts.
- **Scheduled**: Will not re-execute if the last successful execution was within 24 hours.
- **Absolute**: Will not re-execute if any prior successful execution exists.

**Important**: At creation time, Exodus validates that required timing fields are present but does not validate their format. Format validation happens at execution time:
- `time_of_day` must be `HH:MM` format. Invalid format causes the bail to silently skip execution.
- `timezone` must be a valid IANA timezone name (e.g., `"America/New_York"`). An invalid timezone name causes the bail to silently skip execution with no error event recorded.
- `datetime` must be ISO 8601 / RFC 3339 format (e.g., `"2024-06-01T09:00:00Z"`). A bare datetime without timezone (`"2024-06-01T09:00:05"`) is also accepted.

### Action

Defines **what** happens to matched users (conditions-type bails only):

```json
{
  "destination_form": "exit_survey_v2",
  "metadata": { "reason": "timeout", "version": 1 }
}
```

`destination_form` is required for conditions-type bails. `metadata` is optional and passed through to botserver. For `user_list` bails, the destination is per-user in the `user_list.users[].shortcode` field; `action` is present but `destination_form` is ignored.

---

## Access Control

- Bails are scoped to users, not surveys. A bail's `user_id` references the user who created it.
- The bail name must be unique per user (`UNIQUE (user_id, name)`).
- The dashboard-server proxy enforces that `req.params.userId` matches the authenticated user.
- Exodus itself has no auth layer -- it trusts the caller. All access control happens at the dashboard-server boundary.

---

## Component Responsibilities

### exodus (Go)

The core service, deployed in two modes from the same binary:

- **API mode** (`--mode=api`): REST API for bail CRUD, preview, and event history. Routes under `/users/:userId/bails`. Uses Echo framework. Validates bail definition schema, builds preview queries, manages database records.
- **Executor mode** (`--mode=executor`): Runs as a Kubernetes CronJob. Loads enabled bails, checks timing, builds and executes queries, sends bailouts, records events.

Key packages:
- `types/` -- Bail, BailEvent, BailDefinition, UserList, Condition types with validation and custom JSON marshaling
- `query/` -- Translates condition trees into parameterized SQL with CTEs for elapsed_time and question_response conditions
- `executor/` -- Execution loop with timing logic, error isolation per bail, panic recovery
- `sender/` -- HTTP POST to botserver's `/synthetic` endpoint with rate limiting and dry-run support
- `api/` -- REST handlers, request/response types, db-to-types conversion
- `db/` -- Database operations (CRUD for bails, events)
- `config/` -- Environment variable configuration loading

### dashboard-server (Node.js)

Auth proxy layer between the dashboard client and exodus:

- Authenticates requests via JWT
- Validates user identity (`userId` matches authenticated user)
- Proxies all requests to exodus API via `BailsUtil`

### dashboard-client (React)

UI components for bail management:

- `BailSystems.js` -- List view with table, inline enable/disable, delete
- `BailForm.js` -- Create/edit form with condition builder, timing config, preview
- `BailEvents.js` -- Event history table for a specific bail
- `ConditionBuilder` -- Reusable component for building condition trees visually

Uses Ant Design components. Routes are top-level under `/bails`.

---

## Execution Model

### Deployment

Exodus executor runs as a Kubernetes CronJob with:

- **Schedule**: `* * * * *` (every minute)
- **Concurrency policy**: `Forbid` (prevents parallel runs; if a run takes longer than 1 minute, the next scheduled run is skipped)
- **Active deadline**: 3600 seconds (1 hour max per run)
- **Restart policy**: `OnFailure` (Kubernetes retries on system-level crashes)

### Execution Loop

Each run:

1. Load all enabled bails from the database
2. For each bail:
   a. Parse and validate the definition JSON
   b. Fetch the last successful execution timestamp from `bail_events`
   c. Call `shouldExecute()` with the timing config, current time, and last execution
   d. If timing matches:
      - For `conditions` bails: build SQL query, execute it against the database
      - For `user_list` bails: convert user list directly to targets
      - Apply `EXODUS_MAX_BAIL_USERS` limit if matched count exceeds it
      - Send bailouts via botserver, record event
3. Exit

### Error Handling

Three levels of error isolation:

| Level | Examples | Behavior |
|-------|----------|----------|
| **System** | Database unreachable, invalid config | Exit with non-zero code; Kubernetes retries |
| **Bail-level** | Invalid definition JSON, SQL error, invalid timezone (silent) | Log error, record error event in `bail_events`, continue to next bail |
| **User-level** | Botserver returns non-200 for one user | Log warning, continue with remaining users; record partial success |

Each bail is wrapped in panic recovery (`defer/recover`) so one bad bail cannot crash the entire executor run. Panics are caught, logged, and recorded as error events.

**Partial success**: If some user sends fail, `users_bailed` will be less than `users_matched` in the recorded event. This still counts as an execution event (not an error event).

### Rate Limiting

The sender applies a configurable delay between HTTP POSTs to botserver (configurable via `EXODUS_RATE_LIMIT`, default: 1 second). This prevents overwhelming botserver when a bail matches thousands of users.

### Query Safety

- All queries use parameterized values (no SQL injection)
- Queries have a safety `LIMIT 100000` at the SQL level
- An additional `EXODUS_MAX_BAIL_USERS` limit is applied in the executor before sending (default: 100000)
- Duration strings are validated against a strict regex before being used as PostgreSQL intervals

### Dry Run Mode

When `DRY_RUN=true`, the sender logs what it would do instead of actually POSTing to botserver. All other execution logic (query building, timing checks, event recording) runs normally.

---

## Event Audit Trail

Every bail execution (successful or failed) is recorded in the `bail_events` table:

| Column | Description |
|--------|-------------|
| `id` | UUID primary key |
| `bail_id` | Reference to the bail (SET NULL on bail deletion) |
| `user_id` | User who owns the bail |
| `bail_name` | Snapshot of bail name at event time |
| `event_type` | `"execution"` for success, `"error"` for failures |
| `timestamp` | When the event occurred |
| `users_matched` | Number of users matching the query (or user list size) |
| `users_bailed` | Number of users successfully bailed (may differ from matched if sends fail) |
| `definition_snapshot` | Full JSON copy of the bail definition at execution time |
| `error` | JSON error details (null for successful executions) |
| `execution_results` | JSON object `{"user_ids": [...]}` listing user IDs successfully bailed in this execution (null for error events) |

The `definition_snapshot` is critical: it captures exactly what definition was active when the bail ran, providing a full audit trail even if the bail is later edited or deleted.

Events are immutable -- they are only ever inserted, never updated or deleted.

---

## API Endpoints Reference

All bail endpoints are scoped under `/users/:userId/bails`. The `/api/v1` prefix is added by the dashboard-server Express app layer, so the full path from the client is `/api/v1/users/:userId/bails`. Authentication is via Bearer token in the Authorization header. The dashboard-server proxies these to exodus.

### Endpoints Summary

| Operation | Method | Path | Frontend | Backend Handler |
|-----------|--------|------|----------|-----------------|
| List | GET | `/users/:userId/bails` | BailSystems.js | handlers.go:ListBails |
| Get | GET | `/users/:userId/bails/:id` | BailForm.js | handlers.go:GetBail |
| Create | POST | `/users/:userId/bails` | BailForm.js | handlers.go:CreateBail |
| Update | PUT | `/users/:userId/bails/:id` | BailForm.js | handlers.go:UpdateBail |
| Delete | DELETE | `/users/:userId/bails/:id` | BailSystems.js | handlers.go:DeleteBail |
| Bail Events | GET | `/users/:userId/bails/:id/events` | BailEvents.js | handlers.go:GetBailEvents |
| User Events | GET | `/users/:userId/bail-events` | - | handlers.go:GetUserEvents |
| Preview | POST | `/users/:userId/bails/preview` | BailForm.js | handlers.go:PreviewBail |

### List Bails

```
GET /users/:userId/bails
Authorization: Bearer {token}
```

**Response** (200 OK):
```json
{
  "bails": [
    {
      "bail": {
        "id": "uuid",
        "user_id": "uuid",
        "name": "string",
        "description": "string",
        "enabled": true,
        "definition": { "conditions": {}, "execution": {}, "action": {} },
        "destination_form": "string",
        "created_at": "ISO-8601",
        "updated_at": "ISO-8601"
      },
      "last_event": {
        "id": "uuid",
        "bail_id": "uuid",
        "user_id": "uuid",
        "bail_name": "string",
        "event_type": "execution|error",
        "timestamp": "ISO-8601",
        "users_matched": 0,
        "users_bailed": 0,
        "definition_snapshot": {},
        "error": null,
        "execution_results": {"user_ids": ["uid1", "uid2"]}
      }
    }
  ]
}
```

### Get Single Bail

```
GET /users/:userId/bails/:id
Authorization: Bearer {token}
```

**Response** (200 OK):
```json
{
  "bail": { "..." },
  "last_event": { "..." }
}
```

**Errors**: 400 (invalid UUID), 404 (not found), 500 (database error)

### Create Bail

```
POST /users/:userId/bails
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "string (required)",
  "description": "string (optional)",
  "enabled": true,
  "definition": {
    "type": "conditions",
    "conditions": {},
    "execution": { "timing": "immediate|scheduled|absolute", "..." },
    "action": { "destination_form": "string", "..." }
  }
}
```

**Response** (201 Created):
```json
{
  "bail": { "..." },
  "last_event": null
}
```

Note: The `enabled` field defaults to `false` if omitted from the request body (standard JSON boolean zero value). To create a bail that runs immediately, pass `"enabled": true` explicitly.

### Update Bail

```
PUT /users/:userId/bails/:id
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "string (optional)",
  "description": "string (optional)",
  "definition": { "..." },
  "enabled": true
}
```

Partial update -- only provided fields are changed.

**Response** (200 OK): Updated bail object with last_event.

### Delete Bail

```
DELETE /users/:userId/bails/:id
Authorization: Bearer {token}
```

**Response** (204 No Content): Empty body.

### Get Bail Events

```
GET /users/:userId/bails/:id/events
Authorization: Bearer {token}
```

Returns full event history for a specific bail, most recent first.

**Response** (200 OK):
```json
{
  "events": [
    {
      "id": "uuid",
      "bail_id": "uuid",
      "user_id": "uuid",
      "bail_name": "string",
      "event_type": "execution|error",
      "timestamp": "ISO-8601",
      "users_matched": 0,
      "users_bailed": 0,
      "definition_snapshot": {},
      "error": null,
      "execution_results": {"user_ids": ["uid1", "uid2"]}
    }
  ]
}
```

### Get User Events

```
GET /users/:userId/bail-events?limit=100
Authorization: Bearer {token}
```

Returns recent events across **all** bails owned by the user (not scoped to a specific bail). Useful for an activity feed or cross-bail audit view.

Query parameters:
- `limit`: integer 1–1000, default 100

**Response** (200 OK): Same `EventsListResponse` shape as Get Bail Events.

### Preview Bail (Dry Run)

```
POST /users/:userId/bails/preview
Authorization: Bearer {token}
Content-Type: application/json

{
  "definition": {
    "type": "conditions",
    "conditions": {},
    "execution": { "timing": "immediate" },
    "action": { "destination_form": "string" }
  }
}
```

**Response** (200 OK) for conditions-based bails:
```json
{
  "count": 127,
  "users": [
    { "userid": "user1", "pageid": "page1" }
  ],
  "sql": "SELECT DISTINCT s.userid, s.pageid FROM states s WHERE ...",
  "params": ["value1", "value2"]
}
```

**Response** (200 OK) for user_list bails:
```json
{
  "count": 3,
  "users": [
    { "userid": "user1", "pageid": "page1" },
    { "userid": "user2", "pageid": "page2" }
  ],
  "sql": "",
  "params": null
}
```

Shows which users match the conditions without creating or executing the bail. For conditions-based bails, the generated SQL and parameters are included in the response, which is useful for debugging complex condition trees. For user_list bails, the user list is returned directly and no SQL is generated.

The dashboard-server proxy is a pure pass-through for preview.

### Data Structures

**Condition** -- Union type discriminated by presence of `op` field:

- If `op` is present: compound condition (`LogicalOperator`)
- If `op` is absent: simple condition (`SimpleCondition`)

Simple conditions:

```json
{ "type": "form", "value": "string" }
{ "type": "state", "value": "START|RESPONDING|QOUT|WAIT_EXTERNAL_EVENT|END|BLOCKED|ERROR" }
{ "type": "error_code", "value": "string" }
{ "type": "current_question", "value": "string" }
{
  "type": "elapsed_time",
  "since": { "event": "response", "details": { "form": "string", "question_ref": "string" } },
  "duration": "string (e.g. '4 weeks', '2 days')"
}
{
  "type": "question_response",
  "form": "string (required, form shortcode)",
  "question_ref": "string (required)",
  "response": "string (optional, exact match against responses.response column)"
}
{ "type": "surveyid", "value": "string (required, UUID of the survey)" }
```

Compound conditions:

```json
{ "op": "and|or", "vars": [ /* 1+ Condition objects */ ] }
{ "op": "not", "vars": [ /* exactly 1 Condition object */ ] }
```

**Execution**:

```json
{
  "timing": "immediate|scheduled|absolute",
  "time_of_day": "HH:MM (required if scheduled)",
  "timezone": "IANA timezone (required if scheduled)",
  "datetime": "ISO-8601 (required if absolute)"
}
```

**Action**:

```json
{
  "destination_form": "string (required for conditions-type, ignored for user_list)",
  "metadata": { "optional": "JSON object" }
}
```

**UserList**:

```json
{
  "users": [
    { "userid": "string", "pageid": "string", "shortcode": "string (destination form)" }
  ]
}
```

### Error Handling

Error response format:

```json
{
  "error": "error_code",
  "message": "human readable message"
}
```

Common errors:

| Status | Error Code | Scenario |
|--------|-----------|----------|
| 400 | `invalid_user_id` | User ID is not a valid UUID |
| 400 | `invalid_bail_id` | Bail ID is not a valid UUID |
| 400 | `invalid_request` | Request body is not valid JSON |
| 400 | `missing_field` | Required field is missing (e.g., name) |
| 400 | `invalid_definition` | Definition fails validation (with details) |
| 404 | `bail_not_found` | Bail does not exist or does not belong to user |
| 500 | `database_error` | Database operation failed |

### Example: Create a Scheduled Bail

**Request**:
```json
POST /users/550e8400-e29b-41d4-a716-446655440001/bails

{
  "name": "4-Week Dropout Recovery",
  "description": "Recover users who haven't responded in 4 weeks",
  "enabled": true,
  "definition": {
    "conditions": {
      "op": "and",
      "vars": [
        {
          "type": "elapsed_time",
          "since": {
            "event": "response",
            "details": { "form": "intake_survey", "question_ref": "age_q" }
          },
          "duration": "4 weeks"
        },
        { "type": "state", "value": "RESPONDING" }
      ]
    },
    "execution": {
      "timing": "scheduled",
      "time_of_day": "09:00",
      "timezone": "America/New_York"
    },
    "action": {
      "destination_form": "recovery_survey",
      "metadata": { "reason": "dropout_recovery" }
    }
  }
}
```

**Response** (201):
```json
{
  "bail": {
    "id": "550e8400-e29b-41d4-a716-446655440002",
    "user_id": "550e8400-e29b-41d4-a716-446655440001",
    "name": "4-Week Dropout Recovery",
    "enabled": true,
    "definition": { "..." },
    "destination_form": "recovery_survey",
    "created_at": "2024-02-15T18:48:00Z",
    "updated_at": "2024-02-15T18:48:00Z"
  },
  "last_event": null
}
```

### Example: Create a User List Bail

**Request**:
```json
POST /users/550e8400-e29b-41d4-a716-446655440001/bails

{
  "name": "Direct Outreach Batch",
  "description": "Send specific users to specific surveys",
  "enabled": true,
  "definition": {
    "type": "user_list",
    "user_list": {
      "users": [
        { "userid": "abc123", "pageid": "page_abc", "shortcode": "survey_a" },
        { "userid": "def456", "pageid": "page_def", "shortcode": "survey_b" }
      ]
    },
    "execution": { "timing": "immediate" },
    "action": {}
  }
}
```

---

## Data Transformation

### Key Transformation Points

Data flows through several layers, with transformations at each boundary:

| Field | Frontend Type | Transformation | Backend Type | Storage |
|-------|---|---|---|---|
| `name` | string | unchanged | string | TEXT |
| `type` | string | unchanged | string | JSONB |
| `conditions` | JS object | JSON serialization | Condition (union) | JSONB |
| `user_list` | JS object | JSON serialization | UserList | JSONB |
| `timing` | string | unchanged | string | JSONB |
| `time_of_day` | moment object | `format('HH:mm')` | string | JSONB |
| `datetime` | moment object | `toISOString()` | string | JSONB |
| `timezone` | string | unchanged | string | JSONB |
| `destination_form` | string | unchanged | string | TEXT |
| `metadata` | JSON string (textarea) | `JSON.parse()` | map[string]interface{} | JSONB |
| `enabled` | boolean | unchanged | boolean | BOOLEAN |

### Validation Flow

All comprehensive validation happens on the backend in `types.go`:

```
BailDefinition.Validate()
+-- (if type="conditions") Conditions.Validate()
|   +-- (if operator) LogicalOperator.Validate()
|   |   +-- Check op is "and", "or", or "not"
|   |   +-- "not" must have exactly 1 child
|   |   +-- "not" cannot contain elapsed_time or question_response (directly or transitively)
|   |   +-- Validate each child condition recursively
|   +-- (if simple) SimpleCondition.Validate()
|       +-- Check type is valid (form, state, error_code, current_question, elapsed_time, question_response, surveyid)
|       +-- Check required fields for each type
|       +-- If elapsed_time: validate TimeReference structure (event="response", details with form and question_ref)
|       +-- If question_response: require form and question_ref (response is optional)
|       +-- If surveyid: require value (must be a non-empty string)
|
+-- (if type="user_list") UserList.Validate()
|   +-- Array must have 1–1000 entries
|   +-- Each entry must have userid, pageid, shortcode
|
+-- Execution.Validate()
|   +-- Check timing is valid (immediate, scheduled, absolute)
|   +-- If scheduled: require time_of_day and timezone (presence only, not format)
|   +-- If absolute: require datetime (presence only, not format)
|
+-- (if type="conditions") Action.Validate()
    +-- Check destination_form is non-empty
```

Frontend validation is minimal (required field checks via AntD Form rules). The backend is the source of truth for all validation.

### Common Issues

**Time format mismatches**: `time_of_day` must be `HH:MM` format (e.g., `"09:00"`, not `"09:00:00"`). `datetime` must be ISO 8601 / RFC 3339 (e.g., `"2024-06-01T09:00:00Z"`). Format errors are not caught at creation — the bail stores successfully but silently skips execution.

**Invalid timezone**: An unrecognized IANA timezone name (e.g., `"US/Eastern"` instead of `"America/New_York"`) causes the bail to silently never execute. No error event is recorded. Always use canonical IANA zone names.

**Metadata validation**: The frontend silently falls back to an empty object on invalid JSON input. Users receive no feedback that their JSON was malformed.

**Missing timing fields**: The frontend does not strictly enforce conditional required fields (e.g., `time_of_day` when timing is "scheduled"). The backend will reject with a clear error message.

**Condition type errors**: Using an unsupported condition type name will be rejected by the backend with: `invalid condition type: <type>`. Valid types are: `form`, `state`, `error_code`, `current_question`, `elapsed_time`, `question_response`, `surveyid`.

**State values**: The backend accepts any string for `state` conditions. The meaningful values are: `START`, `RESPONDING`, `QOUT`, `WAIT_EXTERNAL_EVENT`, `END`, `BLOCKED`, `ERROR`, `USER_BLOCKED`. `QOUT` means a question has been delivered and the bot is waiting for the user's reply — it is the normal in-flight state for active participants.

**Duration format**: Must be `<number> <unit>` exactly. Accepted units: `microseconds`, `milliseconds`, `seconds`, `minutes`, `hours`, `days`, `weeks`, `months`, `years` (singular or plural). Formats like `"4w"`, `"4 weeks ago"`, or `"1.5 hours"` are rejected.

**Enabled on create**: `enabled` defaults to `false` if omitted. New bails will be created as disabled unless you explicitly pass `"enabled": true`.

**User list size**: User list bails are limited to 1–1000 users per bail. For larger batches, split across multiple bails.

---

## Frontend-Backend Mapping

### Condition Union Pattern

Frontend and backend represent the same condition tree using different patterns:

- **Frontend**: Plain JavaScript objects. Presence of `op` field distinguishes compound from simple conditions.
- **Backend**: Go discriminated union (`Condition` struct) with custom JSON marshal/unmarshal. Presence of `op` triggers `LogicalOperator` path; absence triggers `SimpleCondition` path.

Both patterns produce identical JSON over the wire.

### Key Compatibility Notes

| Aspect | Frontend | Backend | Notes |
|--------|----------|---------|-------|
| Bail type | string field `type` | `BailDefinition.Type` | Omitting defaults to `"conditions"` |
| Condition union | Plain JS object with `op` or `type` | Custom unmarshal, discriminated union struct | Identical JSON wire format |
| Time fields | moment.js objects in form state | ISO 8601 or HH:mm strings in JSON | Transformation in `buildDefinition()` |
| Metadata | JSON string in textarea | `map[string]interface{}` | Frontend parses on send, stringifies on load |
| Enabled on create | Part of form values | Used as-is; defaults to false if omitted | Pass `true` explicitly to enable |
| Validation depth | Minimal (required fields) | Comprehensive (type enums, format, structure) | Backend is source of truth |
| Partial update | Full form always submitted | `UpdateBailRequest` supports optional fields | Only provided fields updated on PUT |

### Special Behaviors

**`destination_form` duplication**: The `Bail` object has `destination_form` both at the top level and inside `definition.action.destination_form`. The backend populates the top-level field from the definition on create/update. For `user_list` bails, the top-level `destination_form` is stored as an empty string.

**Metadata round-trip**: On load, metadata object is stringified to JSON for display in a textarea. On save, the textarea string is parsed back to an object. Invalid JSON silently becomes `{}`.

**User list bails and action**: The `action` field must be present in the JSON but `destination_form` inside it is not validated or used. Send `"action": {}` for user list bails.

---

## Configuration

All configuration is via environment variables.

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `CHATBASE_DATABASE` | `chatroach` | Database name |
| `CHATBASE_HOST` | `localhost` | Database host |
| `CHATBASE_PORT` | `5433` | Database port |
| `CHATBASE_USER` | `root` | Database user |
| `CHATBASE_PASSWORD` | *(empty)* | Database password |

Tables are stored in the `chatroach` schema (e.g., `chatroach.bails`, `chatroach.bail_events`).

### Botserver

| Variable | Default | Description |
|----------|---------|-------------|
| `BOTSERVER_URL` | `http://localhost:8080/synthetic` | Full URL of botserver's synthetic endpoint |

### Executor

| Variable | Default | Description |
|----------|---------|-------------|
| `EXODUS_RATE_LIMIT` | `1s` | Delay between HTTP POSTs to botserver (Go duration string, e.g. `"500ms"`, `"2s"`) |
| `EXODUS_MAX_BAIL_USERS` | `100000` | Maximum users to bail per bail per execution run. Applied after the SQL LIMIT. |
| `DRY_RUN` | `false` | When `true`, log bailout events instead of POSTing to botserver |

### API Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Port for the exodus API HTTP server |

### Botserver Event Format

Exodus posts the following JSON to `BOTSERVER_URL` for each user:

```json
{
  "user": "userid",
  "page": "pageid",
  "event": {
    "type": "bailout",
    "value": {
      "form": "destination_form_shortcode",
      "metadata": { "optional": "object" }
    }
  }
}
```

---

## Debugging Guide

This section covers common bail problems and how to diagnose them using the database.

### Useful queries

Look up a bail by name:

```sql
SELECT id, name, enabled, definition, created_at, updated_at
FROM chatroach.bails
WHERE name ILIKE '%<bail name>%';
```

Check recent execution history for a bail (includes the definition snapshot that was active at execution time):

```sql
SELECT id, event_type, timestamp, users_matched, users_bailed,
       definition_snapshot->'execution' AS execution_def, error
FROM chatroach.bail_events
WHERE bail_id = '<bail_id>'
ORDER BY timestamp DESC
LIMIT 10;
```

Check a specific user's responses for a given form/question:

```sql
SELECT userid, shortcode, question_ref, response, timestamp
FROM chatroach.responses
WHERE userid = '<userid>'
  AND shortcode = '<form_shortcode>'
  AND question_ref = '<question_ref>'
ORDER BY timestamp;
```

