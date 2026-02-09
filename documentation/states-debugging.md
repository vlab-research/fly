# States System - Cross-Component Documentation

## Overview

The "state" in the VLab platform represents a user's complete conversation context during a survey interaction. Every participant interacting with a chatbot has exactly one state per Facebook page, tracking where they are in the survey flow, what questions they have answered, what errors they have hit, and what they are waiting for.

The state is the central concept that ties together the chatbot engine (replybot), operational automation (Dean), the database (CockroachDB `states` table), and the dashboard. Understanding how state flows through these components is essential for debugging participant issues and building features that expose participant progress.

## State Machine

The state machine governs the lifecycle of a participant's survey interaction. Each participant is always in exactly one of these states:

| State | Meaning |
|-------|---------|
| `START` | Initial state before the participant has begun answering questions |
| `RESPONDING` | Participant is actively answering survey questions |
| `QOUT` | A question has been sent to the participant, waiting for their response |
| `END` | Participant has completed the survey flow (all forms finished) |
| `BLOCKED` | Participant is blocked from proceeding (e.g., spam detection) |
| `ERROR` | An error occurred during processing (API failure, payment error, etc.) |
| `WAIT_EXTERNAL_EVENT` | Participant is paused, waiting for an external event (e.g., a payment confirmation, a timeout, or a follow-up trigger) |
| `USER_BLOCKED` | The user has blocked the Facebook page or is otherwise unreachable |

### Transition Model

The state machine follows a pure functional design with no side effects in transitions:

1. **`exec(state, event) -> output`** -- Categorizes the incoming event and determines what should happen next (which question to ask, whether to advance forms, whether to error out).
2. **`apply(state, output) -> newState`** -- Produces a new state object from the old state and the output. This is a pure function.

Side effects (sending messages to Facebook, publishing to Kafka) happen separately in the `act()` phase, after the new state has been computed. This separation makes the state machine testable and predictable.

## State Object Structure

The state JSON (`state_json` in the database) contains the full conversation context for a single participant. Its fields are:

| Field | Type | Description |
|-------|------|-------------|
| `state` | string | Current state machine value (one of the states listed above) |
| `question` | object | Reference to the current question being asked or awaiting a response |
| `qa` | array | Full transcript of question-answer pairs -- every question asked and every response given |
| `forms` | array | History of forms (shortcodes) the participant has traversed, in order |
| `md` | object | Metadata: randomization seed, start time, user info, payment data, cluster ID |
| `previousOutput` | object | The output from the most recent state transition (useful for debugging what just happened) |
| `error` | object | Error details if the participant is in the ERROR state (error tag, FB error code, etc.) |
| `wait` | object | Wait condition details if in WAIT_EXTERNAL_EVENT (what event is expected, timeout) |
| `tokens` | array | One-time notification tokens (used for re-engagement messaging) |
| `retries` | array | Retry timestamps for exponential backoff on transient failures |
| `pointer` | string | Message pointer timestamp (tracks position in event log replay) |
| `externalEvents` | array | External events received while the participant was waiting |

## Data Flow

State moves through the system in a well-defined pipeline:

```
User sends message on Facebook Messenger
       |
  [Botserver] receives webhook, publishes to Kafka chat-events topic
       |
  [Replybot] consumes event from Kafka
       |
       +---> Replays state from event log (cached in Redis for performance)
       |
       +---> Machine.transition(state, event)
       |         |
       |         +---> exec(state, event) -> output
       |         +---> apply(state, output) -> newState
       |
       +---> New state cached in Redis (runtime source of truth)
       |
       +---> act() sends messages to Facebook Graph API
       |
       +---> Stateman.put() UPSERTs to CockroachDB `states` table
       |         (observability/debugging only -- replybot never reads this)
       |
       +---> State published to Kafka VLAB_STATE_TOPIC
                  |
             [Scribble] consumes and writes to `states` table
```

### Key architectural insight

**Redis is the runtime source of truth for state, not CockroachDB.** Replybot replays state from the Kafka event log with Redis as a cache. The `states` table in CockroachDB is a denormalized dump for observability: it exists so that Dean can automate operational tasks and the dashboard can show participant status. Replybot never reads from the `states` table.

## The `states` Table

### Schema

**Primary key**: `(userid, pageid)` -- exactly one row per user per Facebook page.

| Column | Type | Description |
|--------|------|-------------|
| `userid` | VARCHAR | Facebook user PSID |
| `pageid` | VARCHAR | Facebook page ID |
| `updated` | TIMESTAMPTZ | When this row was last written |
| `current_state` | VARCHAR | The state machine value (START, RESPONDING, etc.) |
| `state_json` | JSON | The full state object (see State Object Structure above) |

### Computed Columns

The table has 15+ computed/stored columns derived from `state_json` for efficient querying without JSON parsing:

| Computed Column | Purpose |
|-----------------|---------|
| `current_form` | Survey form shortcode -- the last entry in the `forms` array |
| `form_start_time` | When the participant started the current form |
| `error_tag` | Error classification string (for filtering by error type) |
| `fb_error_code` | Facebook API error code (for diagnosing delivery failures) |
| `stuck_on_question` | Boolean: detects when a user has answered the same question 3+ times |
| `timeout_date` | When an external wait condition should expire |
| `next_retry` | Exponential backoff retry timestamp |
| `payment_error_code` | Reloadly payment error code |
| `previous_is_followup` | Whether the previous output was a follow-up message |
| `previous_with_token` | Whether the previous output included a one-time notification token |

### Indexes

The table has 10+ indexes plus an INVERTED INDEX on `state_json` for flexible JSON queries. The heavy indexing reflects the variety of queries Dean runs for operational automation.

### Permissions

| DB User | Access |
|---------|--------|
| `chatroach` | INSERT, SELECT, UPDATE (used by scribble for writes, Dean for reads) |
| `chatreader` | SELECT only (used by dashboard-server for read-only queries) |

### Who Reads the `states` Table

1. **Dean** (`dean/queries.go`) -- The primary consumer. Dean is a Go cron service that queries states for operational automation: retrying failed participants, timing out stale waits, detecting stuck users, identifying spammers, and triggering follow-ups.

2. **Dashboard-server** -- Reads states for user-facing debugging and survey health monitoring. Queries are scoped by the authenticated user's surveys.

### Schema Definition

Defined in `devops/migrations/01-init.sql` (lines 109-162), with additional computed columns added in later migration files.

## Survey to States Mapping

### The `current_form` Link

There is no direct foreign key from `states` to `surveys`. The link between a participant's state and a survey is the `current_form` computed column, which contains the survey **shortcode** (e.g., `"s1"`, `"followup_v2"`).

### Survey Names and Multiple Shortcodes

A "survey" in the dashboard sense is identified by `survey_name` in the surveys table. One survey can contain **multiple shortcodes** (called "forms" in the frontend). For example, a survey named "Health Study 2024" might have shortcodes `health_intake`, `health_followup_1`, and `health_followup_2`.

To get all states for a survey, you query all shortcodes belonging to that `survey_name`:

```sql
-- Get all shortcodes for a survey
SELECT DISTINCT shortcode FROM surveys
WHERE survey_name = $1 AND userid = $2;

-- Get states for those shortcodes
SELECT userid, pageid, current_state, current_form, updated, error_tag, timeout_date
FROM states
WHERE current_form IN (
  SELECT shortcode FROM surveys WHERE survey_name = $1 AND userid = $2
);
```

### Formcentral and Time-Based Versioning

Shortcodes are **not globally unique**. The same shortcode can have multiple survey versions, distinguished by their `created` timestamp. When a participant joins a study, their join time determines which version of the survey they receive.

**Formcentral** (`formcentral/`) is a Go microservice that resolves this mapping at runtime:

```
GET /surveys?pageid={fbPageId}&shortcode={shortcode}&timestamp={joinTimeMs}
```

The underlying query finds the most recent survey with that shortcode created at or before the participant's join time:

```sql
SELECT ... FROM surveys s
WHERE s.userid = (SELECT userid FROM credentials WHERE facebook_page_id = $1 LIMIT 1)
  AND s.shortcode = $2
  AND created <= $3
ORDER BY created DESC
LIMIT 1
```

This means if shortcode `"s1"` has been recreated three times, a participant who joined before the second version was created will always see the first version.

### The credentials Bridge

The `credentials` table bridges Facebook page IDs to VLab user IDs:

```
states.pageid -> credentials.facebook_page_id -> credentials.userid -> surveys.userid
```

This is how page-scoped state data connects back to user-owned surveys.

## Components Involved

| Component | Language | Role in States System | Key Files |
|-----------|----------|----------------------|-----------|
| **Replybot** | Node.js | Produces state via the state machine. Caches in Redis, publishes to Kafka. Never reads `states` table. | `replybot/lib/typewheels/machine.js`, `replybot/lib/index.js` |
| **Scribble** | Go | Kafka-to-DB writer. Consumes from state topic, UPSERTs to `states` table. | `scribble/` |
| **Dean** | Go | Reads `states` table for operational automation: retries, timeouts, stuck detection, spam detection, follow-ups. | `dean/queries.go` |
| **Dashboard-server** | Node.js | Reads `states` table for user-facing debugging and survey health views. Queries scoped by authenticated user. | `dashboard-server/` |
| **Formcentral** | Go | Maps (shortcode + join timestamp) to a specific survey version. Used by replybot at runtime, not by the states table directly. | `formcentral/db.go` |
| **Botserver** | Node.js | Event ingress. Receives Facebook webhooks and synthetic events, publishes to Kafka chat-events topic. Upstream of replybot. | `botserver/server/handlers.js` |
| **Redis** | -- | Runtime state cache. Source of truth for replybot's state replay. Not queryable by other services. | -- |
| **CockroachDB** | -- | Stores the `states` table. Queryable by Dean and dashboard-server. Not the runtime source of truth. | `devops/migrations/01-init.sql` |

## Common Debugging Scenarios

### Participant stuck on a question
Query `states` for `stuck_on_question = true`. The `state_json.qa` array will show the repeated question-answer attempts. Common causes: validation failures, unclear question wording, or translation issues.

### Participant in ERROR state
Filter by `current_state = 'ERROR'`. The `error_tag` and `fb_error_code` computed columns classify the error without needing to parse JSON. Common errors: Facebook API rate limits, invalid recipient (user deleted account), payment failures.

### Participant waiting too long
Filter by `current_state = 'WAIT_EXTERNAL_EVENT'` and check `timeout_date`. Dean normally handles timeouts automatically, but if Dean is down or misconfigured, participants can get stuck waiting. The `state_json.wait` field describes what event is expected.

### Survey health overview
Aggregate `current_state` counts grouped by `current_form` for all shortcodes in a survey:

```sql
SELECT current_state, current_form, COUNT(*)
FROM states
WHERE current_form IN (
  SELECT shortcode FROM surveys WHERE survey_name = $1 AND userid = $2
)
GROUP BY current_state, current_form;
```

This shows how many participants are responding, completed, errored, blocked, or waiting across each form in the survey.

## Dashboard UI — States Explorer

The States Explorer feature in the dashboard provides a user-facing interface for debugging participant states. It follows the established container pattern with multiple views for different debugging scenarios.

### StatesSummary Component

**Path**: `dashboard-client/src/containers/StatesExplorer/StatesSummary.js`

**Purpose**: High-level overview of participant states across a survey.

**UI Elements**:
1. **Overview Card** — displays total participant count and per-state aggregates using `<Statistic>` components
2. **State Breakdown Table** — shows `current_form × current_state × count` grouped by both dimensions

**Data Flow**:
- Calls `/surveys/:surveyName/states/summary` endpoint (surveyName is URL-encoded)
- Backend aggregates across all shortcodes belonging to that survey_name
- Response format: `{ summary: [{ current_state, current_form, count }, ...] }`

**State Color Coding**:
States are visualized with color-coded tags for quick recognition:
- `START` — blue (participant just started)
- `RESPONDING` — green (active engagement)
- `QOUT` — cyan (question sent, awaiting answer)
- `END` — default/gray (completed survey)
- `BLOCKED` — red (spam/abuse detection)
- `ERROR` — red (failure state)
- `WAIT_EXTERNAL_EVENT` — orange (waiting for payment, timeout, or trigger)
- `USER_BLOCKED` — magenta (user blocked the Facebook page)

**Use Cases**:
- Quickly assess survey health at a glance
- Identify if a significant number of participants are stuck in ERROR or WAIT states
- Compare completion rates across different forms in a multi-form survey

### StateDetail Component

**Path**: `dashboard-client/src/containers/StatesExplorer/StateDetail.js`

**Purpose**: Deep dive into a single participant's complete state, including full QA transcript and error diagnostics.

**UI Structure**:
1. **Back button** — returns to StatesList
2. **Main info card** — `<Descriptions bordered>` showing all computed columns (userid, pageid, current_state, current_form, updated, form_start_time, error_tag, fb_error_code, stuck_on_question, timeout_date)
3. **Error details card** (conditional, shown if `current_state = 'ERROR'`) — displays `state_json.error` fields including tag, message, fb_error_code, payment_error_code, and additional details
4. **Wait condition card** (conditional, shown if `current_state = 'WAIT_EXTERNAL_EVENT'`) — shows what event is expected, timeout, reason, and metadata
5. **QA transcript table** — all question-answer pairs from `state_json.qa` with columns for question ref/text and response text/value
6. **Raw state_json viewer** — `<Collapse>` component with formatted JSON for advanced debugging

**Data Flow**:
- Calls `/surveys/:surveyName/states/:userid` endpoint (both params URL-encoded)
- Backend returns full state row including `state_json` column
- Component parses JSON and conditionally renders sections based on state

**Interpreting state_json Fields**:

#### QA Transcript (`state_json.qa`)
Array of question-answer pairs representing the full conversation:
```javascript
{
  "question": {
    "ref": "q1",          // Question reference ID from survey definition
    "text": "How old are you?"  // Question text shown to participant
  },
  "response": {
    "text": "25",         // Participant's text response
    "value": 25          // Parsed/validated value (may be different type than text)
  }
}
```

**Debugging patterns**:
- **Repeated questions with same ref** → validation failures or participant confusion
- **response.value differs from response.text** → shows validation/parsing transformations
- **Null or missing response** → question sent but not yet answered (QOUT state)

#### Error Details (`state_json.error`)
Present when `current_state = 'ERROR'`:
```javascript
{
  "tag": "FB_API_ERROR",           // Error classification (indexed in error_tag column)
  "message": "Message failed to send",  // Human-readable error description
  "fb_error_code": 10,             // Facebook API error code (if applicable)
  "payment_error_code": "INSUFFICIENT_FUNDS",  // Reloadly error code (if applicable)
  "details": { /* additional context */ }  // Structured error metadata
}
```

**Common error tags**:
- `FB_API_ERROR` — Facebook Graph API failure (rate limit, invalid recipient, permissions)
- `PAYMENT_ERROR` — Reloadly payment/airtime delivery failure
- `VALIDATION_ERROR` — Participant response failed survey validation rules
- `TIMEOUT_ERROR` — External event wait condition expired without resolution

#### Wait Condition (`state_json.wait`)
Present when `current_state = 'WAIT_EXTERNAL_EVENT'`:
```javascript
{
  "event": "PAYMENT_CONFIRMATION",  // Expected event type
  "timeout": "2024-03-15T10:30:00Z",  // When wait expires (also in timeout_date column)
  "reason": "Waiting for airtime delivery",  // Human-readable explanation
  "metadata": {
    "transaction_id": "abc123",  // Context-specific data for the event
    "amount": 10
  }
}
```

**Debugging actions**:
- Compare `wait.timeout` with current time — if past timeout, Dean should have processed it
- Check `wait.metadata` for transaction/event IDs to correlate with external systems (Reloadly, payment providers)
- If participant stuck waiting past timeout, verify Dean cron is running and check Dean logs for that userid

#### Forms History (`state_json.forms`)
Array of shortcodes the participant has traversed:
```javascript
["intake_survey", "followup_v2"]
```
- Last entry should match `current_form` computed column
- Multiple entries indicate follow-up/multi-stage surveys
- Empty array means participant hasn't started any forms yet (START state)

#### Metadata (`state_json.md`)
Operational metadata about the participant session:
```javascript
{
  "randomization_seed": "abc123",  // Ensures consistent randomization across restarts
  "start_time": "2024-03-10T08:00:00Z",  // When participant first interacted
  "user_info": { /* Facebook profile data */ },
  "cluster_id": "cluster-a",  // A/B test or segmentation group
  "payment_data": { /* airtime delivery info */ }
}
```

**Use Cases**:
- Trace complete conversation history for participants reporting issues
- Diagnose Facebook API delivery failures
- Verify payment/airtime transactions correlated with participant state
- Understand why a participant is stuck (validation loop, external wait, API error)
- Provide support with full context of participant's survey experience

### StatesList Component

**Path**: `dashboard-client/src/containers/StatesExplorer/StatesList.js`

**Purpose**: Filterable, paginated list of all participants with their current states. Provides a bird's-eye view with drill-down capability.

**UI Elements**:
1. **Filter controls card** — three filters arranged in a grid:
   - **State dropdown** — select from state machine values (START, RESPONDING, ERROR, etc.)
   - **Error tag input** — free-text search for specific error tags
   - **User ID search** — LIKE match on userid column
   - **Reset filters button** — clears all filters and resets to page 1
2. **Participant table** — columns: userid (link to detail), current_state (color tag), current_form, updated (formatted timestamp), error_tag (red tag if present), stuck_on_question (yes/no tag), timeout_date (formatted timestamp)
3. **Server-side pagination** — limit/offset query params with configurable page size

**Data Flow**:
- Calls `/surveys/:surveyName/states?state=...&error_tag=...&search=...&limit=50&offset=0`
- Backend returns `{ states: [...], total: N }`
- Table re-fetches on filter change or page change

**Interaction Pattern**:
- Clicking any table row navigates to StateDetail view for that userid
- Filters reset pagination to page 1 to avoid confusion
- Page size options: 10, 20, 50, 100

**Common Workflows**:
- Filter by `state=ERROR` and `error_tag=FB_API_ERROR` to identify all Facebook delivery failures
- Filter by `state=WAIT_EXTERNAL_EVENT` to see all participants waiting for external events (payments, timeouts)
- Search for specific userid when participant reports an issue
- Sort by `updated` to find participants who haven't progressed recently

### Navigation Flow

**Entry Point**: From the main SurveyScreen, users click the **STATES** button (located alongside NEW FORM and EXPORT buttons).

**Route Hierarchy**:
```
/surveys/:surveyName                    → SurveyScreen (main survey table)
  /surveys/:surveyName/states           → StatesSummary (overview/aggregates)
  /surveys/:surveyName/states/list      → StatesList (filterable participant list)
  /surveys/:surveyName/states/:userid   → StateDetail (individual participant deep dive)
```

**Navigation Patterns**:

1. **From SurveyScreen to StatesSummary**:
   - User clicks STATES button → navigates to `/surveys/:surveyName/states`
   - Shows aggregate counts and per-form breakdown
   - User can manually navigate to `/surveys/:surveyName/states/list` or go back to survey

2. **From StatesSummary to StatesList** (not automatic):
   - Currently no direct link from summary to list (future enhancement opportunity)
   - User can manually edit URL or use browser back/forward

3. **From StatesList to StateDetail**:
   - Clicking any table row navigates to `/surveys/:surveyName/states/:userid`
   - StateDetail receives `backPath` prop set to `/surveys/:surveyName/states/list`
   - Back button at top of StateDetail uses this prop to return to the list view

4. **From StateDetail back to StatesList**:
   - Click back button (icon: `<ArrowLeftOutlined />`) at top of page
   - Preserves filters and pagination from previous list view (via browser history)

**URL Parameters**:
- `:surveyName` — the `survey_name` from the surveys table, URL-encoded
- `:userid` — participant's Facebook PSID, URL-encoded

**Authorization**:
All views scoped by authenticated user's surveys. The backend `validateSurveyNameAccess` middleware ensures users can only view states for their own surveys. A 403 response is returned if user attempts to access a survey they don't own.

**Design Rationale**:
Routes are nested under `/surveys/:surveyName/` to maintain context that states are tied to a specific survey. This mirrors the existing pattern for survey forms (`/surveys/:surveyName/form/:surveyid`) and bails (`/surveys/:surveyName/bails`), creating a consistent mental model for users navigating survey-related features.
