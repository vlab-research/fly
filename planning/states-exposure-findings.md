# States Table Exposure — Investigation Findings

## 1. The `states` Table

### Schema
- **Primary key**: `(userid, pageid)` — one row per user per Facebook page
- **Core columns**: `userid`, `pageid`, `updated` (timestamptz), `current_state` (varchar), `state_json` (json)
- **15+ computed/stored columns** derived from `state_json` for query optimization:
  - `current_form` — survey form shortcode (last in forms array)
  - `form_start_time` — when user started current form
  - `error_tag`, `fb_error_code` — error classification
  - `stuck_on_question` — detects user answering same question 3x
  - `timeout_date` — when external wait should expire
  - `next_retry` — exponential backoff retry time
  - `payment_error_code` — Reloadly payment errors
  - `previous_is_followup`, `previous_with_token` — previous output flags
- **Heavy indexing**: 10 indexes + INVERTED INDEX on state_json
- **Defined in**: `devops/migrations/01-init.sql` (lines 109–162)
- **Permissions**: `chatroach` has INSERT/SELECT/UPDATE, `chatreader` has SELECT only

### Write Path
1. User interacts with chatbot → event enters Kafka
2. Replybot consumes event, replays state from event log (cached in Redis)
3. Machine.transition(state, event) produces new state
4. New state cached in Redis (source of truth for runtime)
5. Stateman.put() UPSERTs to `states` table (for analytics/debugging only)
6. State also published to Kafka `VLAB_STATE_TOPIC`

**Key insight**: The `states` table is NOT the source of truth for runtime. It's a denormalized dump for observability. Replybot never reads from it.

### Who reads `states` today
- **Dean service** (`dean/queries.go`): Queries for operational automation — retries, timeouts, error recovery, stuck detection, spam detection
- **No dashboard exposure currently exists** — no API endpoint, no UI, no Cube.js cube

## 2. Internal State Object

The state JSON represents a user's complete conversation context:
- `state` — current state machine value (START, RESPONDING, QOUT, END, BLOCKED, ERROR, WAIT_EXTERNAL_EVENT, USER_BLOCKED)
- `question` — current question reference
- `qa` — array of question-answer pairs (full transcript)
- `forms` — history of forms traversed
- `md` — metadata (seed, startTime, user info, payment data)
- `previousOutput` — last transition output
- `error` — error details if in error state
- `wait` — wait condition details if waiting
- `tokens` — one-time notification tokens
- `retries` — retry timestamps for backoff
- `pointer` — message pointer timestamp
- `externalEvents` — external events received while waiting

### State Machine
Pure functional design: `exec(state, event) → output`, then `apply(state, output) → newState`. No side effects in transitions.

## 3. Dashboard & API Architecture

### Dashboard-Server
- **Express app** on port 3000, API version v1
- **Auth**: JWT via Auth0 (client) or HS256 (server-to-server). Middleware in `middleware/auth.js`
- **User scoping**: All queries filter by `req.user.email` — users only see their own surveys/data

### Existing Routes
- `/responses` — survey response data
- `/surveys` — survey CRUD and settings
- `/users` — account operations
- `/exports` — async data export (via Kafka)
- `/typeform`, `/credentials`, `/facebook`, `/auth` — integrations
- `/surveys/:surveyId/bails` — bail-out monitoring (newest pattern)
- `/surveys/:surveyId/bail-events` — survey-wide bail events

### Authorization Pattern (bails endpoint = newest/cleanest)
```javascript
const validateSurveyAccess = async (req, res, next) => {
  const { email } = req.user;
  const surveys = await Survey.retrieve({ email });
  const survey = surveys.find(s => s.shortcode === surveyId || s.id === surveyId);
  if (!survey) return res.status(403);
  req.survey = survey;
  next();
};
```

### Query Pattern
- Direct CockroachDB queries via pg pool
- Parameterized queries with email-based filtering
- JOIN through surveys → users for data scoping

### Dashboard-Client
- React SPA (Netlify-deployed)
- API client in `src/services/api/` — adds Auth0 Bearer token to all requests
- Targets `REACT_APP_SERVER_URL/api/v1/{path}`
- Cube.js for analytics aggregation

## 4. Key Considerations for States Exposure

### Data Sensitivity
- `state_json` contains the full conversation transcript (`qa` array) — PII risk
- `userid` is a Facebook user ID — may need to be handled carefully
- Payment error codes could contain sensitive financial context

### Scoping Challenge
- The `states` table has `(userid, pageid)` as key, NOT `surveyid`
- To scope by survey, need to JOIN through `pageid` → pages → surveys → users
- OR filter by `current_form` (which maps to survey shortcode)
- The bails endpoint pattern shows how to validate survey ownership first

### What Users Would Want for Debugging
- See which state each participant is in (RESPONDING, ERROR, BLOCKED, etc.)
- See error details for stuck participants
- See timeout information for waiting participants
- See the QA transcript to understand where someone got stuck
- Filter by state, form, error type
- Aggregate counts by state for survey health overview

### Recommended Endpoint Pattern
Following the bails pattern:
```
GET /surveys/:surveyId/states — list participant states for a survey
GET /surveys/:surveyId/states/summary — aggregate state counts
```

### Missing Link: pageid → surveyid
Need to investigate how surveys map to pages to understand the JOIN path for scoping states to a specific survey. The `current_form` computed column (survey shortcode) is likely the simplest filter.

## 5. Formcentral: Form → Survey Mapping

### What is Formcentral?
A standalone Go microservice (`formcentral/`) that maps form shortcodes + join timestamps to survey IDs.

### The Core SQL Logic (`formcentral/db.go`, getSurveyByParams)
```sql
SELECT id, s.userid, form_json, form, s.shortcode, translation_conf, messages, created, off_time
FROM surveys s
LEFT JOIN survey_settings ON s.id = survey_settings.surveyid
WHERE s.userid=(SELECT userid FROM credentials WHERE facebook_page_id=$1 LIMIT 1)
  AND s.shortcode=$2
  AND created<=$3
ORDER BY created DESC
LIMIT 1
```

**Parameters**: `(pageid, shortcode, joinTimestamp)`

**How join time works**: The `created <= timestamp` filter finds the most recent survey version with that shortcode created at or before the user's join time. This handles multi-version surveys — if shortcode "s1" has been recreated over time, each participant gets the version that was current when they joined.

### Endpoint
`GET /surveys?pageid={fbPageId}&shortcode={shortcode}&timestamp={joinTimeMs}`

Timestamp is milliseconds, converted to seconds and rounded up.

## 6. Survey ↔ Shortcode Data Model

### Survey Table (`devops/migrations/01-init.sql`)
- `id` UUID primary key
- `shortcode` VARCHAR NOT NULL — **not unique** (multiple surveys can share a shortcode, versioned by `created`)
- `userid` UUID — survey owner (FK to users)
- `created` TIMESTAMPTZ
- `formid` VARCHAR — Typeform form ID
- `form` / `form_json` — denormalized form content
- Index: `(shortcode, userid, created DESC)` — optimized for the formcentral query pattern

### Key Relationships
- **No `survey_forms` join table** — one survey = one shortcode = one form
- **Shortcode is not unique globally** — scoped by (userid, created) for versioning
- **No direct FK from states → surveys** — the link is `states.current_form` (shortcode string) matched against `surveys.shortcode`
- **credentials table** bridges pageid → userid: `SELECT userid FROM credentials WHERE facebook_page_id = $1`

### Data Flow for States → Survey Scoping
```
states.current_form (shortcode)
  → surveys.shortcode (WHERE shortcode = ? AND userid = owner_userid)
  → Multiple versions possible, disambiguated by created timestamp
```

For the dashboard, since we know the user's email and their survey shortcodes, the simplest approach:
1. Get user's surveys via `Survey.retrieve({ email })` — returns all surveys with shortcodes
2. Query states WHERE `current_form` IN (survey's shortcodes)
3. No need to go through formcentral — we already know which shortcodes belong to the user

### All Database Tables (for reference)
Key tables in the public schema: `users`, `surveys`, `survey_settings`, `credentials`, `states`, `responses`, `exports`, `bails`

## 7. Clarification: Survey = Multiple Shortcodes

**Key insight from user**: A "survey" in the dashboard sense is identified by `survey_name` in the database, and one survey can contain **multiple shortcodes** (called "forms" in the frontend).

### Implications for States Exposure
- The summary view should be scoped to a **survey_name**, aggregating states across ALL shortcodes belonging to that survey
- The summary should also show per-shortcode breakdowns within the survey
- Query pattern: get all shortcodes for a survey_name, then query states WHERE current_form IN (those shortcodes)
- The per-participant view should show which shortcode (form) each participant is on

### Updated Query Approach
```sql
-- Get shortcodes for a survey
SELECT DISTINCT shortcode FROM surveys WHERE survey_name = $1 AND userid = $2

-- Summary: states grouped by current_state across those shortcodes
SELECT current_state, current_form, COUNT(*)
FROM states
WHERE current_form IN (SELECT shortcode FROM surveys WHERE survey_name = $1 AND userid = $2)
GROUP BY current_state, current_form

-- Per-participant: individual state rows
SELECT userid, pageid, current_state, current_form, updated, error_tag, stuck_on_question, timeout_date
FROM states
WHERE current_form IN (SELECT shortcode FROM surveys WHERE survey_name = $1 AND userid = $2)
ORDER BY updated DESC
```