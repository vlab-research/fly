# Bail Systems

## Overview

Bail systems are automated rules that redirect survey respondents from one form to another based on configurable conditions. They replace the previous approach of hand-written Kubernetes CronJob manifests (`bailer-job/kube/`) with a database-driven, UI-manageable system.

Common use cases:

- **Timeout recovery**: Move users stuck in `WAIT_EXTERNAL_EVENT` for more than N weeks to an intermediate form
- **Error recovery**: Redirect users in `BLOCKED` state with specific error codes back to retry
- **End of study**: Move all users on a form to an exit survey at a specific date/time
- **Stuck question recovery**: Bail users stuck at a particular question

A bail is owned by a user (not a survey) and can query across any shortcodes that user owns. This allows cross-survey bail rules -- for example, bailing users from any of several survey forms into a single exit survey.

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
2. **Conditions** -- a visual condition builder supporting AND/OR logic trees with condition types: form, state, error_code, current_question, elapsed_time
3. **Execution Timing** -- choose immediate, scheduled (daily at a time + timezone), or absolute (one-time at a datetime)
4. **Action** -- destination form shortcode and optional JSON metadata

A **Preview** button performs a dry-run query showing how many users currently match the conditions and a sample of their IDs.

### Event History

Each bail has an event history view (`/bails/:bailId/events`) showing a table of past executions with timestamp, event type (execution or error), users matched, users bailed, and error details if any.

## Data Flow

End-to-end path when a bail fires:

```
User creates bail in dashboard UI (React)
    |
    v
dashboard-client POST /users/:userId/bails
    |  (includes name, definition, source_shortcodes)
    v
dashboard-server proxy layer (Node.js)
    |  - Validates authentication (JWT)
    |  - Validates userId matches authenticated user
    |  - Validates source_shortcodes belong to user's surveys
    v
exodus API POST /users/:userId/bails
    |  - Validates bail definition schema
    |  - Extracts destination_form for denormalized column
    |  - Stores in bails table (CockroachDB)
    v
[bail is now stored and enabled]
    |
    v
Kubernetes CronJob runs exodus executor (every minute)
    |  - Loads all enabled bails
    |  - For each bail, checks timing (shouldExecute)
    |  - If timing matches:
    |      1. Builds SQL from conditions + source_shortcodes
    |      2. Queries states/responses tables for matching users
    |      3. Sends bailout events to botserver via HTTP POST
    |      4. Records execution event in bail_events table
    v
botserver /synthetic endpoint receives bailout event
    |  - Processes form change for the user
    v
User is now on the destination form
```

## Bail Definition Model

A bail definition is a JSON object with three sections:

### Conditions

Conditions define **who** gets bailed. They form a recursive tree supporting AND/OR logic.

**Simple condition types:**

| Type | Matches on | Example |
|------|-----------|---------|
| `form` | `states.current_form` | `{"type": "form", "value": "mysurvey"}` |
| `state` | `states.current_state` | `{"type": "state", "value": "WAIT_EXTERNAL_EVENT"}` |
| `error_code` | `states.state_json.error.code` | `{"type": "error_code", "value": "10"}` |
| `current_question` | `states.state_json.question` | `{"type": "current_question", "value": "hello_again"}` |
| `elapsed_time` | Time since a response event | See below |

**Elapsed time** is the most complex condition. It references a specific response event and checks if enough time has passed:

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

Duration uses PostgreSQL interval syntax: `"4 weeks"`, `"2 days"`, `"1 hour"`, `"30 minutes"`.

**Logical operators** combine conditions:

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

### Action

Defines **what** happens to matched users:

```json
{
  "destination_form": "exit_survey_v2",
  "metadata": { "reason": "timeout", "version": 1 }
}
```

`destination_form` is required. `metadata` is optional and passed through to botserver.

## Source Shortcodes

Each bail has a `source_shortcodes` field -- an array of form shortcodes that scope which users the bail can query. The query builder adds a JOIN to the `responses` table filtering by these shortcodes, ensuring the bail only matches users who have interacted with the specified forms.

This enables cross-survey bails: a single bail rule can reference shortcodes from multiple surveys owned by the same user. For example, a researcher running three survey waves can create one bail that catches dropouts across all three.

Shortcode ownership is validated at the dashboard-server proxy layer. When creating or updating a bail, the server verifies that every shortcode in `source_shortcodes` belongs to a survey owned by the authenticated user.

## Access Control

- Bails are scoped to users, not surveys. A bail's `user_id` references the user who created it.
- The bail name must be unique per user (`UNIQUE (user_id, name)`).
- The dashboard-server proxy enforces that `req.params.userId` matches the authenticated user.
- On create/update, the dashboard-server validates that all `source_shortcodes` belong to surveys owned by the user.
- Exodus itself has no auth layer -- it trusts the caller. All access control happens at the dashboard-server boundary.

## Component Responsibilities

### exodus (Go)

The core service, deployed in two modes from the same binary:

- **API mode** (`--mode=api`): REST API for bail CRUD, preview, and event history. Routes under `/users/:userId/bails`. Uses Echo framework. Validates bail definition schema, builds preview queries, manages database records.
- **Executor mode** (`--mode=executor`): Runs as a Kubernetes CronJob. Loads enabled bails, checks timing, builds and executes queries, sends bailouts, records events.

Key packages:
- `types/` -- Bail, BailEvent, BailDefinition, Condition types with validation and custom JSON marshaling
- `query/` -- Translates condition trees into parameterized SQL with CTEs for elapsed_time conditions
- `executor/` -- Execution loop with timing logic, error isolation per bail, panic recovery
- `sender/` -- HTTP POST to botserver's `/synthetic` endpoint with rate limiting
- `api/` -- REST handlers, request/response types, db-to-types conversion
- `db/` -- Database operations (CRUD for bails, events)

### dashboard-server (Node.js)

Auth proxy layer between the dashboard client and exodus:

- Authenticates requests via JWT
- Validates user identity (`userId` matches authenticated user)
- Validates shortcode ownership on create/update
- Proxies all requests to exodus API via `BailsUtil`

### dashboard-client (React)

UI components for bail management:

- `BailSystems.js` -- List view with table, inline enable/disable, delete
- `BailForm.js` -- Create/edit form with condition builder, timing config, preview
- `BailEvents.js` -- Event history table for a specific bail
- `ConditionBuilder` -- Reusable component for building condition trees visually

Uses Ant Design components. Routes are top-level under `/bails`.

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
   d. If timing matches: build SQL query, execute it, send bailouts, record event
3. Exit

### Error Handling

Three levels of error isolation:

| Level | Examples | Behavior |
|-------|----------|----------|
| **System** | Database unreachable, invalid config | Exit with non-zero code; Kubernetes retries |
| **Bail-level** | Invalid definition JSON, SQL error | Log error, record error event in `bail_events`, continue to next bail |
| **User-level** | Botserver returns 4xx for one user | Log warning, continue with remaining users; record partial success |

Each bail is wrapped in panic recovery (`defer/recover`) so one bad bail cannot crash the entire executor run.

### Rate Limiting

The sender applies a configurable delay between HTTP POSTs to botserver (default: 1 request/second via `EXODUS_RATE_LIMIT`). This prevents overwhelming botserver when a bail matches thousands of users.

### Query Safety

- All queries use parameterized values (no SQL injection)
- Queries have a safety `LIMIT 100000` to prevent unbounded result sets
- Duration strings are validated against a strict regex before being used as PostgreSQL intervals

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
| `users_matched` | Number of users matching the query |
| `users_bailed` | Number of users successfully bailed (may differ from matched if sends fail) |
| `definition_snapshot` | Full JSON copy of the bail definition at execution time |
| `error` | JSON error details (null for successful executions) |

The `definition_snapshot` is critical: it captures exactly what definition was active when the bail ran, providing a full audit trail even if the bail is later edited or deleted.

Events are immutable -- they are only ever inserted, never updated or deleted.
