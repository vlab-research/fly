# States Exposure — Implementation Plan

## Architecture Overview

The feature follows the established bails endpoint pattern. Routes use `surveyName` as the URL parameter (URL-encoded) since a "survey" identified by `survey_name` groups multiple shortcodes/forms.

## Required Reading

Before implementing any chunk, read these documents:

- **`documentation/states-debugging.md`** — how the states system works end-to-end (state machine, data flow, table schema, survey mapping)
- **`dashboard-server/README.md`** — API architecture, auth patterns, route structure, query patterns
- **`dashboard-client/README.md`** — React app structure, container pattern, API client, component library (Ant Design)
- **`planning/states-exposure-findings.md`** — raw investigation notes with detailed schema, SQL examples, and formcentral mapping logic

### Design Decisions
1. **URL structure**: `/surveys/:surveyName/states` — follows nesting convention, param name clearly indicates survey_name
2. **Direct DB queries** (not Exodus proxy) — states data lives in CockroachDB, following `response.queries.js` pattern
3. **`validateSurveyNameAccess` middleware** — like `validateSurveyAccess` but validates by survey_name, collects all shortcodes for that survey_name onto `req.surveyShortcodes`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/surveys/:surveyName/states/summary` | Aggregated state counts grouped by current_state and current_form |
| GET | `/surveys/:surveyName/states` | Paginated list of participant states with filtering |
| GET | `/surveys/:surveyName/states/:userid` | Full state detail for a single participant (includes state_json) |

### Query Parameters (list endpoint)
- `state` — filter by current_state (e.g., ERROR, RESPONDING)
- `error_tag` — filter by error_tag
- `search` — search by userid (LIKE match)
- `limit` — page size (default 50)
- `offset` — pagination offset

## Implementation Chunks

### Chunk 1: Backend — States Queries Module

**Create:**
- `dashboard-server/queries/states/states.queries.js`
- `dashboard-server/queries/states/index.js`

Three query functions bound to pool via `this.query()`:
- `summary(shortcodes)` — `SELECT current_state, current_form, COUNT(*)::int FROM states WHERE current_form = ANY($1) GROUP BY current_state, current_form`
- `list(shortcodes, { state, errorTag, search, limit, offset })` — dynamic WHERE clause, returns `{ states, total }`
- `detail(shortcodes, userid)` — includes `state_json`, returns single row

**Pattern**: follows `response.queries.js` exactly — queries are functions bound to pool.

### Chunk 2: Backend — Controller and Routes

**Create:**
- `dashboard-server/api/states/states.controller.js`
- `dashboard-server/api/states/states.routes.js`
- `dashboard-server/api/states/index.js`

Controller includes:
- `validateSurveyNameAccess` middleware — extracts email from JWT, gets user's surveys, finds matching survey_name, collects shortcodes onto `req.surveyShortcodes`
- `getSummary`, `listStates`, `getStateDetail` handlers

**Pattern**: follows `bails.controller.js` exactly.

### Chunk 3: Backend — Register Routes

**Modify:** `dashboard-server/api/index.js`

Add: `.use('/surveys/:surveyName/states', require('./states'))` after the bails route.

### Chunk 4: Backend — Tests

**Create:** `dashboard-server/api/states/states.test.js`

Following `bails.test.js` pattern:
- Setup: create test user, two surveys with different shortcodes under same survey_name, insert test state rows
- Tests: 401 without auth, 403 for unauthorized survey, summary returns grouped counts, list with filters, detail with state_json, 404 for nonexistent userid
- Cleanup: delete test data

### Chunk 5: Frontend — StatesSummary Component

**Create:** `dashboard-client/src/containers/StatesExplorer/StatesSummary.js`

- Overview card with total participants and per-state counts (color-coded tags)
- Per-form breakdown table (current_form × current_state × count)
- Uses `api.fetcher` + Ant Design components

### Chunk 6: Frontend — StatesList Component (Per-Participant)

**Create:** `dashboard-client/src/containers/StatesExplorer/StatesList.js`

- Filterable table: state dropdown, error_tag input, userid search
- Columns: userid (link to detail), state (tag), form, updated, error_tag, stuck_on_question, timeout_date
- Server-side pagination (limit/offset)

### Chunk 7: Frontend — StateDetail Component

**Create:** `dashboard-client/src/containers/StatesExplorer/StateDetail.js`

- Descriptions panel with all computed columns
- QA transcript table (question/answer pairs from state_json.qa)
- Error details card (if in error state)
- Wait condition card (if waiting)
- Collapsible raw state_json viewer

### Chunk 8: Frontend — Container and Routing Integration

**Create:** `dashboard-client/src/containers/StatesExplorer/index.js`, `StatesExplorer.css`

**Modify:**
- `dashboard-client/src/containers/index.js` — add StatesExplorer exports
- `dashboard-client/src/containers/SurveyScreen/SurveyScreen.js` — add "STATES" button alongside "NEW FORM" and "EXPORT", add routes for states views

## Files Summary

### Create (11 files)
| File | Purpose |
|------|---------|
| `dashboard-server/queries/states/states.queries.js` | DB queries |
| `dashboard-server/queries/states/index.js` | Module export |
| `dashboard-server/api/states/states.controller.js` | Handlers + auth middleware |
| `dashboard-server/api/states/states.routes.js` | Express router |
| `dashboard-server/api/states/index.js` | Module export |
| `dashboard-server/api/states/states.test.js` | Integration tests |
| `dashboard-client/src/containers/StatesExplorer/StatesSummary.js` | Summary view |
| `dashboard-client/src/containers/StatesExplorer/StatesList.js` | Participant list |
| `dashboard-client/src/containers/StatesExplorer/StateDetail.js` | Participant detail |
| `dashboard-client/src/containers/StatesExplorer/StatesExplorer.css` | Styles |
| `dashboard-client/src/containers/StatesExplorer/index.js` | Component exports |

### Modify (3 files)
| File | Change |
|------|--------|
| `dashboard-server/api/index.js` | Register states route |
| `dashboard-client/src/containers/index.js` | Add StatesExplorer exports |
| `dashboard-client/src/containers/SurveyScreen/SurveyScreen.js` | Add STATES button + routes |

## Parallelization

- **Stream A**: Chunks 1+2+3 (backend queries, controller, route registration) — sequential, one developer
- **Stream B**: Chunks 5+6+7+8 (all frontend) — can start immediately with agreed API contract
- **Stream C**: Chunk 4 (backend tests) — alongside Stream A

## Reference Files (patterns to follow)
- `dashboard-server/api/bails/bails.controller.js` — validateSurveyAccess middleware pattern
- `dashboard-server/queries/responses/response.queries.js` — SQL query binding pattern
- `dashboard-client/src/containers/BailSystems/BailSystems.js` — frontend component pattern

## Acceptance Criteria
1. Users can view summary of participant states for any survey they own
2. Summary shows total counts per state and per-shortcode breakdown
3. Users can filter participant list by state, error_tag, and userid
4. Users can view full state details including QA transcript
5. All data scoped to authenticated user's surveys only (403 for unauthorized)
6. Follows existing codebase patterns
7. Backend API tests pass
8. UI accessible from SurveyScreen with clear navigation
