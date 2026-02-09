# States Exposure Feature — Documentation Index

**Feature Status**: ✅ Complete (as of 2026-02-09)
**Branch**: `feature/states-exposure` (rebased on main)

## Quick Navigation

### Implementation Complete ✅
Start here to understand what was built:
- **`states-exposure-completion.md`** — What was implemented, status, deployment, testing checklist

### Understanding the Feature
Deep dives for different aspects:
- **`states-exposure-plan.md`** — Original implementation plan with design decisions
- **`states-exposure-findings.md`** — Raw investigation notes, schema details, SQL examples
- **`documentation/states-debugging.md`** — End-user guide to states system (in main docs)

### Continuation & Future Work
If you're extending this feature:
- Read `states-exposure-completion.md` first (status & architecture)
- For new backend work: see patterns in `states-exposure-plan.md` (chunks 1-4)
- For new frontend work: see patterns in `dashboard-client/README.md` (routing, components)
- For testing: follow pattern in `states-exposure-plan.md` (chunk 4)

## Feature Overview

The States Exposure feature provides a web UI for viewing and debugging participant state data in surveys.

**What it does:**
- Shows aggregated state counts (how many participants in each state)
- Provides filterable list of all participants with their current state
- Shows detailed state view including QA transcript and error information
- Integrates into SurveyScreen as a "Monitor" tab

**Who uses it:**
- Survey researchers debugging participant flow
- QA monitoring survey responses
- Issue investigation

**API Endpoints** (all scoped to authenticated user):
- `GET /surveys/:surveyName/states/summary` — aggregates
- `GET /surveys/:surveyName/states` — list with filters
- `GET /surveys/:surveyName/states/:userid` — detail

**UI Routes** (all under `/surveys/:surveyName/monitor/`):
- `/surveys/:surveyName/monitor` → StatesSummary
- `/surveys/:surveyName/monitor/list` → StatesList
- `/surveys/:surveyName/monitor/:userid` → StateDetail

## File Locations

```
Feature Code:
├── dashboard-server/
│   ├── api/states/                    # API endpoints
│   │   ├── states.controller.js
│   │   ├── states.routes.js
│   │   ├── states.test.js
│   │   └── index.js
│   ├── queries/states/                # Database queries
│   │   ├── states.queries.js
│   │   └── index.js
│   └── api/index.js                   # Route registration
│
└── dashboard-client/
    ├── src/containers/
    │   ├── StatesExplorer/            # UI Components
    │   │   ├── StatesSummary.js
    │   │   ├── StatesList.js
    │   │   ├── StateDetail.js
    │   │   ├── StatesExplorer.css
    │   │   └── index.js
    │   ├── SurveyScreen/              # Tabbed container
    │   │   ├── SurveyScreen.js        # UPDATED
    │   │   └── SurveyScreen.css
    │   └── index.js                   # UPDATED

Documentation:
├── planning/
│   ├── STATES_EXPOSURE_README.md      # This file
│   ├── states-exposure-completion.md  # Completion status
│   ├── states-exposure-plan.md        # Implementation plan
│   └── states-exposure-findings.md    # Investigation notes
│
└── documentation/
    └── states-debugging.md             # End-user guide
```

## Key Decisions

1. **Tabbed Layout** — SurveyScreen now uses Ant Design Tabs with Edit, Monitor, Export tabs
2. **URL-based Tab Selection** — Active tab derived from pathname (works with deep links)
3. **Direct DB Queries** — States data queried from CockroachDB, not proxied through external service
4. **Survey Scoping** — All data scoped to user's surveys via `validateSurveyNameAccess` middleware

## Testing Status

- **Backend**: Integration tests written and syntax-verified ✅
- **Frontend**: No automated tests (app-wide test coverage is minimal)
- **Manual Testing**: See checklist in `states-exposure-completion.md`

## Deployment

Ready to deploy to both backend and frontend:
- Backend: New API endpoints, no schema changes
- Frontend: New UI components and tab layout

See `states-exposure-completion.md` for deployment steps.

## Common Tasks

### I want to add a new filter to StatesList
1. Read `dashboard-client/README.md` — "List View with Server-Side Filtering Pattern"
2. Add filter field to useState in StatesList.js
3. Add query param to URLSearchParams
4. Add backend filter to `states.queries.js` `list()` function

### I want to add a new column to the detail view
1. Read `documentation/states-debugging.md` — understand field meanings
2. Add to `StateDetail.js` Descriptions component
3. Make sure field is returned from API (`states.queries.js` `detail()`)

### I want to change the tab layout
1. Modify `SurveyScreen.js` tabs and routes
2. Update `documentation/states-debugging.md` Navigation section
3. Test that links and back buttons still work

### I want to improve performance
1. Check `StatesList.js` pagination (currently 50 default)
2. Check `states.queries.js` indexes on `current_form` and `current_state`
3. Consider caching for `summary()` endpoint

## Related Features

- **Bails** — separate system for participant bail-out monitoring (top-level navbar, not integrated into SurveyScreen)
- **BailSystems** — managed separately, follows similar API pattern but different DB
- **Exports** — managed through separate export UI

## Questions?

Refer to:
- `states-exposure-completion.md` — "How to Continue" section
- `states-exposure-plan.md` — design decisions and patterns
- `documentation/states-debugging.md` — states system details
