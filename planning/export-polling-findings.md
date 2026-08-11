# Export Feature Investigation -- Polling Findings

**Date**: 2026-02-16
**Purpose**: Full investigation of the dashboard-client export UI to understand components, state management, routing, API calls, status representation, and whether any polling mechanism exists.

---

## 1. Component Inventory

### Top-Level Routes (defined in `src/root.js`)

| Route | Component | Purpose |
|-------|-----------|---------|
| `/exports` | `Exports` | Global list of all user exports |
| `/exports/create?survey_name={name}` | `CreateExport` | Form to create a "responses" export |
| `/exports/create-chat-log?survey_name={name}` | `CreateChatLogExport` | Form to create a "chat_log" export |
| `/exports/create-full-messages?survey_name={name}` | `CreateFullMessagesExport` | Form to create a "full_messages" export |

All routes use `PrivateRoute` (requires Auth0 authentication).

### Survey-Scoped Export Panel

The `SurveyScreen` component (`src/containers/SurveyScreen/SurveyScreen.js`) renders a tabbed UI with three tabs: **Edit**, **Monitor**, **Export**. The Export tab renders `ExportPanel` -- an inline component defined in the same file (lines 165-200).

Route to reach the survey-specific export panel:
```
/surveys/{survey_name}/export
```

This is nested under the `Surveys` container, which handles the `path="/surveys/:survey?"` route.

---

## 2. Component Details

### `Exports` (global list page)

**File**: `src/containers/Exports/Exports.js`

- Functional component, no props
- Fetches `GET /api/v1/exports/status` once on mount via `Hook.useMountFetch`
- Returns `[exports, setExports]` -- the setter is exposed via React Context (`Export` context, line 9)
- Renders an Ant Design `Table` with columns: Survey, Source, User, Time Exported, Status, Download
- Source column maps: `chat_log` -> "Chat Log", `full_messages` -> "Full Messages", anything else -> "Responses"
- Download column renders a `<Link>` pointing to `export_link` that opens in a new tab
- Pagination: 20 per page
- CSS: `Exports.css` -- only styles a `.selector-container` element (vestigial, not used by current Exports component)
- **No polling, no refresh, no re-fetch mechanism whatsoever**

### `ExportPanel` (survey-scoped, inline in SurveyScreen)

**File**: `src/containers/SurveyScreen/SurveyScreen.js`, lines 165-200

- Takes `selected` prop (survey name string)
- Uses `useState` + `useEffect` for data fetching (NOT the shared `useMountFetch` hook)
- Calls `fetchExportsBySurvey(selected)` which hits `GET /api/v1/exports/status/survey?survey={name}`
- Renders three `CreateBtn` links (EXPORT RESPONSES, EXPORT CHAT LOG, EXPORT FULL MESSAGES)
- Shows an Ant Design `Table` with columns: Source, Status, Time, Download
- Pagination: 10 per page
- Wrapped in `<Spin>` for loading state
- **No polling, no refresh, no re-fetch mechanism**

### `CreateExport` (responses export form)

**File**: `src/containers/CreateExport/CreateExport.js`

- Reads `survey_name` from URL query string
- Ant Design `Form` with options: keep_final_answer, drop_duplicated_users, add_duration, drop_users_without, pivot, response_value, metadata
- On submit: calls `startExport(survey, body)`, waits 4 seconds (artificial), then `history.push('/exports')` to navigate to global list
- **Does NOT navigate back to survey-scoped ExportPanel** -- always goes to `/exports`

### `CreateChatLogExport`

**File**: `src/containers/CreateChatLogExport/CreateChatLogExport.js`

- Options: include_metadata, include_raw_payload
- On submit: calls `startExport(survey, body, 'chat_log')`, waits 1 second, then `history.goBack()`
- **Goes back to previous page** (typically the ExportPanel in SurveyScreen)

### `CreateFullMessagesExport`

**File**: `src/containers/CreateFullMessagesExport/CreateFullMessagesExport.js`

- Options: event_groups (checkbox group of 8 event categories), include_raw_json
- On submit: calls `startExport(survey, body, 'full_messages')`, waits 1 second, then `history.goBack()`
- **Goes back to previous page** (typically the ExportPanel in SurveyScreen)

---

## 3. API Services

### `startExport(selected, body, exportType)`

**File**: `src/services/api/startExport.js`

- `POST /api/v1/exports?survey={name}` with JSON body
- If `exportType` is provided, adds `export_type` to the body
- Expects 201 response; logs errors to console only (no user-facing error feedback)

### `fetchExportsBySurvey(surveyName)`

**File**: `src/services/api/fetchExportsBySurvey.js`

- `GET /api/v1/exports/status/survey?survey={name}`
- Returns parsed JSON (array of export status rows)

### `useMountFetch(fetchOpts, initialState)` (shared hook)

**File**: `src/services/hooks/useMountFetch.js`

- Generic hook that calls `ApiClient.fetcher(fetchOpts)` once on mount
- Returns `[state, setState]` -- exposes setter for external updates
- Errors only logged to console
- **No refetch capability, no dependency-based re-fetching** (empty deps array `[]`)

### `getCSV(path, selected)` -- DEAD CODE

**File**: `src/services/api/getCSV.js`

- Downloads a CSV as a blob and triggers a browser download
- Not imported or used by any component

---

## 4. Server-Side API

### Routes (`dashboard-server/api/exports/exports.routes.js`)

| Method | Path | Controller | Description |
|--------|------|------------|-------------|
| POST | `/` | `generateExport` | Create new export |
| GET | `/status` | `getAll` | All exports for authenticated user |
| GET | `/status/survey` | `getBySurvey` | Exports filtered by survey name |

### Export Creation Flow (`generateExport`)

1. Generate `crypto.randomUUID()` for the export
2. Insert row into `export_status` with `status='Started'`, `export_link='Not Found'`
3. Publish Kafka message with export_id to the exports topic
4. Return `{ status: 'success', export_id: exportId }` with 201

### Database Schema (`export_status` table)

Defined in `devops/migrations/02-export-status.sql` + `09-export-log-redesign.sql`:

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Unique per export, auto-generated, added in migration 09 |
| `updated` | TIMESTAMPTZ | Auto-updated on write (`DEFAULT now() ON UPDATE now()`) |
| `user_id` | VARCHAR | User email |
| `survey_id` | VARCHAR | Survey name |
| `status` | VARCHAR | "Started", "Finished", or "Failed" |
| `export_link` | VARCHAR | Cloud storage URL or "Not Found" |
| `source` | VARCHAR | "responses", "chat_log", or "full_messages" |

The table is append-only (multiple exports per user/survey allowed after migration 09 dropped the unique constraint).

### Exporter Status Updates

The Python exporter (`exporter/exporter/exporter.py`) updates the `export_status` row via `set_export_status()`:

- Sets `status='Started'` at the beginning (redundant with server insert, but ensures consistency)
- Sets `status='Finished'` with the presigned download URL on success
- Sets `status='Failed'` on error

---

## 5. State Management

**No Redux, no Context API for state management, no global store.**

State management is entirely local:

- **Exports page**: `useMountFetch` returns `[exports, setExports]`. The `setExports` is exposed via a React Context (`Export.Provider`), but this context is **never consumed** by any child component. It is vestigial.
- **ExportPanel**: Plain `useState` + `useEffect` local state.
- **Create forms**: Local `useState` for loading spinner only.

---

## 6. Polling / Refresh Mechanisms

**There is NO polling anywhere in the export feature.** Specifically:

- No `setInterval` or `setTimeout`-based polling
- No WebSocket or Server-Sent Events
- No "refresh" button
- No dependency-based re-fetching (both fetch hooks use empty `[]` deps)
- The `useMountFetch` hook fetches exactly once on mount and never again
- The `ExportPanel` useEffect depends on `[selected]` (survey name) but this value does not change while the panel is visible

**After triggering an export, the user sees:**

1. A spinner during the POST + artificial wait
2. Redirect to the exports list (or back to ExportPanel)
3. The new row appears with `status='Started'` (because the server inserts it before returning)
4. The status column shows the literal text "Started"
5. **The user must manually reload the page** to see the status change to "Finished" or "Failed"
6. Once "Finished", the export_link column shows a DOWNLOAD link

---

## 7. "In Process" UI Representation

Export statuses are rendered as **raw text** in a table column:

```javascript
{ title: 'Status', dataIndex: 'status' }
```

There is:
- No color coding
- No icons
- No progress indicator
- No animated spinner for in-progress exports
- No visual distinction between Started, Finished, and Failed
- Just the plain string value from the database ("Started", "Finished", "Failed")

The Download column renders:
- A `<Link>` component pointing to the `export_link` value (Exports page) -- this will render "DOWNLOAD" even when `export_link` is "Not Found" (broken link for Started/Failed exports)
- An `<a>` tag with null-checking (ExportPanel) -- correctly returns `null` when text is falsy or equals "Not Found"

**Bug in Exports page**: The global Exports page (`Exports.js` line 13) renders a DOWNLOAD link regardless of the status. It does not check if `export_link === 'Not Found'`. The ExportPanel in SurveyScreen handles this correctly.

---

## 8. Navigation Inconsistencies

- `CreateExport` (responses) always redirects to `/exports` (global list page)
- `CreateChatLogExport` and `CreateFullMessagesExport` use `history.goBack()` (returns to ExportPanel in SurveyScreen)
- The ExportPanel buttons link to `/exports/create*` routes -- these are top-level routes, not nested under the survey
- After creating a responses export, the user is taken to the global exports page and has no way back to the survey-specific panel without re-navigating

---

## 9. Key Findings Summary

### What Exists
- Three export types: responses, chat_log, full_messages
- Two list views: global (`/exports`) and survey-scoped (ExportPanel in SurveyScreen)
- Server immediately inserts a "Started" row so the export appears in the list right away
- The exporter updates the row to "Finished" (with download URL) or "Failed"

### What Is Missing
1. **Polling** -- No mechanism to update the UI when an export completes. The user must manually reload.
2. **Status styling** -- No visual differentiation between Started/Finished/Failed states.
3. **Download link guard** -- The global Exports page renders a broken DOWNLOAD link for non-finished exports.
4. **Error feedback** -- All errors are logged to console only; no toast/alert shown to the user.
5. **Refresh button** -- No way to re-fetch the export list without a full page reload.

### Recommendations for Polling Implementation
- The `ExportPanel` in SurveyScreen is the better target for polling since it uses standard `useState`/`useEffect` (easy to add a `setInterval`)
- The global `Exports` page uses `useMountFetch` which would need to be replaced or extended with a polling variant
- The server-side `GET /exports/status/survey` endpoint already exists and is lightweight (single indexed query)
- Poll only when there are rows with `status === 'Started'` to avoid unnecessary requests
- Consider adding color-coded status badges (green for Finished, orange/yellow for Started, red for Failed)

---

## 10. File Reference

| File | Purpose |
|------|---------|
| `dashboard-client/src/root.js` | Top-level routing |
| `dashboard-client/src/containers/Exports/Exports.js` | Global exports list |
| `dashboard-client/src/containers/Exports/Exports.css` | CSS (vestigial selector styles) |
| `dashboard-client/src/containers/SurveyScreen/SurveyScreen.js` | Contains `ExportPanel` (lines 165-200) |
| `dashboard-client/src/containers/CreateExport/CreateExport.js` | Responses export form |
| `dashboard-client/src/containers/CreateChatLogExport/CreateChatLogExport.js` | Chat log export form |
| `dashboard-client/src/containers/CreateFullMessagesExport/CreateFullMessagesExport.js` | Full messages export form |
| `dashboard-client/src/services/api/startExport.js` | POST to create export |
| `dashboard-client/src/services/api/fetchExportsBySurvey.js` | GET exports by survey |
| `dashboard-client/src/services/hooks/useMountFetch.js` | Fetch-on-mount hook |
| `dashboard-client/src/services/api/getCSV.js` | Dead code (unused CSV download) |
| `dashboard-client/src/components/UI/index.js` | Shared styled components (CreateBtn, PrimaryBtn, Loading) |
| `dashboard-server/api/exports/exports.controller.js` | Server-side export controller |
| `dashboard-server/api/exports/exports.routes.js` | Server-side export routes |
| `dashboard-server/queries/exports/exports.queries.js` | Database queries for export_status |
| `devops/migrations/02-export-status.sql` | Original table creation |
| `devops/migrations/09-export-log-redesign.sql` | Table redesign (append-only, UUID, source column) |
| `exporter/exporter/exporter.py` | Python exporter that processes exports and updates status |
