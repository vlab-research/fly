# Error Message Display in Dashboard Client — Investigation Findings

## Summary

The dashboard client's States Explorer UI displays error information across multiple views, with **good coverage of `error.message` in the StateDetail component but limited error visibility in list/summary views**. The investigation reveals:

1. **StateDetail component (deep dive)** — Already displays `error.message` properly (line 191 in StateDetail.js)
2. **StatesList component (list view)** — Shows only `error_tag`, NOT `error.message`
3. **StatesSummary component (overview)** — Shows only aggregated counts by state, no error details
4. **Backend API** — Fully returns `state_json` with nested `error` object; no data loss at API level
5. **Navigation flow** — The "monitor" feature in SurveyScreen is actually the States Explorer (confusing naming)

## Frontend Components

### StateDetail.js (Deep Dive View)
**Path**: `dashboard-client/src/containers/StatesExplorer/StateDetail.js`

**Current Error Display (Lines 178-214)**:

```javascript
{isError && stateJson.error && (
  <Card
    title="Error Details"
    style={{ marginBottom: 16 }}
    headStyle={{ backgroundColor: '#fff1f0' }}
  >
    <Descriptions bordered column={1}>
      {stateJson.error.tag && (
        <Descriptions.Item label="Error Tag">
          <Tag color="red">{stateJson.error.tag}</Tag>
        </Descriptions.Item>
      )}
      {stateJson.error.message && (
        <Descriptions.Item label="Message">
          {stateJson.error.message}
        </Descriptions.Item>
      )}
      {stateJson.error.fb_error_code && (
        <Descriptions.Item label="Facebook Error Code">
          {stateJson.error.fb_error_code}
        </Descriptions.Item>
      )}
      {stateJson.error.payment_error_code && (
        <Descriptions.Item label="Payment Error Code">
          {stateJson.error.payment_error_code}
        </Descriptions.Item>
      )}
      {stateJson.error.details && (
        <Descriptions.Item label="Details">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(stateJson.error.details, null, 2)}
          </pre>
        </Descriptions.Item>
      )}
    </Descriptions>
  </Card>
)}
```

**Status**: ✅ `error.message` IS displayed (line 190-193) when in ERROR state

**Fields displayed in Error Details Card**:
- `error.tag` — Error classification (e.g., "FB_API_ERROR")
- `error.message` — Human-readable error description
- `error.fb_error_code` — Facebook API error code
- `error.payment_error_code` — Reloadly payment error code
- `error.details` — Additional structured error metadata

**Data flow**:
1. User navigates to `/surveys/:surveyName/monitor/:userid` (StateDetail component)
2. Component fetches `/surveys/:surveyName/states/:userid` API endpoint
3. Backend returns full state object including `state_json`
4. Component parses `state_json` and renders error card if `current_state === 'ERROR'`

---

### StatesList.js (Filterable List View)
**Path**: `dashboard-client/src/containers/StatesExplorer/StatesList.js`

**Current Error Display (Lines 155-163)**:

```javascript
{
  title: 'Error Tag',
  dataIndex: 'error_tag',
  key: 'error_tag',
  width: 150,
  render: (errorTag) => errorTag ? (
    <Tag color="red">{errorTag}</Tag>
  ) : '-',
}
```

**Status**: ⚠️ `error.message` IS NOT displayed — only `error_tag` column visible

**What's displayed in table**:
- `userid` — User PSID (clickable link to StateDetail)
- `current_state` — Color-coded tag (START, RESPONDING, ERROR, etc.)
- `current_form` — Survey form shortcode
- `updated` — Last update timestamp
- **`error_tag` only** — Error classification (RED tag if present, else "-")
- `stuck_on_question` — Yes/No tag
- `timeout_date` — Formatted timestamp

**Data flow**:
1. User navigates to `/surveys/:surveyName/monitor/list` (StatesList component)
2. Component fetches `/surveys/:surveyName/states?state=...&error_tag=...&search=...&limit=50&offset=0`
3. Backend returns `{ states: [...], total: N }` where each state is from the `states` table row
4. Table displays only the flattened/computed columns, not the nested `state_json`

**Problem**: The StatesList API response does NOT include `state_json`, so `error.message` is unavailable at the list level without fetching additional data.

---

### StatesSummary.js (Overview/Aggregated View)
**Path**: `dashboard-client/src/containers/StatesExplorer/StatesSummary.js`

**Current Display**:

```javascript
const columns = [
  {
    title: 'Form',
    dataIndex: 'current_form',
    key: 'current_form',
    sorter: (a, b) => a.current_form.localeCompare(b.current_form),
  },
  {
    title: 'State',
    dataIndex: 'current_state',
    key: 'current_state',
    render: (state) => (
      <Tag color={stateColors[state] || 'default'}>
        {state}
      </Tag>
    ),
  },
  {
    title: 'Count',
    dataIndex: 'count',
    key: 'count',
    ...
  },
];
```

**Status**: ⚠️ No error information displayed — only aggregate counts per state

**What's displayed**:
- Aggregate statistics: total participants, per-state counts
- Form-state breakdown table: `current_form × current_state × count`
- No error details at all (by design—this is an overview)

---

## Backend API Responses

### GET /surveys/:surveyName/states/:userid (Detail Endpoint)
**File**: `dashboard-server/api/states/states.controller.js` (line 66-79)
**Query**: `dashboard-server/queries/states/states.queries.js` (line 124-150)

**Response includes**:
```javascript
{
  userid: string,
  pageid: string,
  updated: timestamp,
  current_state: string,
  current_form: string,
  form_start_time: timestamp,
  error_tag: string,
  fb_error_code: string,
  stuck_on_question: boolean,
  timeout_date: timestamp,
  next_retry: timestamp,
  payment_error_code: string,
  previous_is_followup: boolean,
  previous_with_token: boolean,
  state_json: { // FULL NESTED OBJECT
    state: string,
    question: object,
    qa: array,
    forms: array,
    md: object,
    error: {
      tag: string,
      message: string,        // <-- AVAILABLE HERE
      fb_error_code: string,
      payment_error_code: string,
      details: object
    },
    wait: object,
    ...
  }
}
```

**Status**: ✅ Full `state_json` with nested `error` object returned

---

### GET /surveys/:surveyName/states (List Endpoint)
**File**: `dashboard-server/api/states/states.controller.js` (line 48-63)
**Query**: `dashboard-server/queries/states/states.queries.js` (line 53-115)

**Response includes**:
```javascript
{
  states: [
    {
      userid: string,
      pageid: string,
      current_state: string,
      current_form: string,
      updated: timestamp,
      error_tag: string,        // COMPUTED COLUMN ONLY
      stuck_on_question: boolean,
      timeout_date: timestamp,
      form_start_time: timestamp
      // NO state_json
    },
    ...
  ],
  total: number
}
```

**Status**: ⚠️ Only computed columns returned, NO `state_json` — cannot access nested `error.message`

**Why**: The SQL query (lines 80-96) explicitly selects only flattened columns for efficiency:
```sql
SELECT
  userid,
  pageid,
  current_state,
  current_form,
  updated,
  error_tag,
  stuck_on_question,
  timeout_date,
  form_start_time
FROM states
WHERE ${whereClause}
ORDER BY updated DESC
LIMIT ${limit}
OFFSET ${offset}
```

---

### GET /surveys/:surveyName/states/summary (Summary Endpoint)
**File**: `dashboard-server/api/states/states.controller.js` (line 38-45)
**Query**: `dashboard-server/queries/states/states.queries.js` (line 20-39)

**Response includes**:
```javascript
{
  summary: [
    {
      current_state: string,
      current_form: string,
      count: number
    },
    ...
  ]
}
```

**Status**: ✅ Aggregates only—no error details by design

---

## Navigation Structure (Confusing "Monitor" Naming)

The States Explorer is wrapped in a "Monitor" tab/section in SurveyScreen.js (lines 109-156):

```
/surveys/:surveyName/monitor               → StatesSummary (Overview)
/surveys/:surveyName/monitor/list          → StatesList (Filterable list)
/surveys/:surveyName/monitor/:userid       → StateDetail (Individual detail)
```

**Key insight**: These routes are NOT documented as the "Monitor" feature—they're part of the States Explorer. The naming comes from the SurveyScreen component's `MonitorSection`, which is a confusing name since the feature is actually for debugging participant state, not operational monitoring in the Dean sense.

---

## Where `error.message` is Currently Missing

### 1. StatesList Table ❌
- **Problem**: Table row shows only `error_tag`, not full error message
- **Why**: API response doesn't include `state_json` for performance (list queries fetch many rows)
- **Impact**: Users must click into StateDetail to see the actual error message
- **User experience**: Frustrating when trying to triage multiple errors at once

### 2. StatesSummary Table ❌
- **Problem**: Aggregate view shows no error details at all
- **Why**: By design—it's an overview of state counts, not error diagnostics
- **Impact**: No attempt needed here unless creating an error-specific summary

### 3. Column Visibility Options
- **Problem**: Neither StatesList nor StatesSummary offers toggleable columns
- **Current state**: Fixed column set
- **Impact**: Cannot add `error.message` without modifying column structure

---

## Data Structure Reference

### Error Object in state_json
```javascript
{
  tag: "FB_API_ERROR" | "PAYMENT_ERROR" | "VALIDATION_ERROR" | "TIMEOUT_ERROR",
  message: "Human-readable error description",
  fb_error_code: number,                    // Facebook Graph API error code
  payment_error_code: string,               // Reloadly error code
  details: {                                // Additional context
    // Varies by error type
  }
}
```

### Computed Column (error_tag)
- Stored in database as `error_tag` column, indexed for fast filtering
- Extracted from `state_json.error.tag` by scribble service
- Used for filtering in StatesList UI
- Values: FB_API_ERROR, PAYMENT_ERROR, VALIDATION_ERROR, etc.

**NOT the same as `error.message`**:
- `error_tag` is a classification/enum
- `error.message` is free-form human-readable text

---

## Summary of Current Behavior

| Component | Location | Displays `error.message` | API Includes `state_json` | Notes |
|-----------|----------|--------------------------|---------------------------|-------|
| StateDetail | `/monitor/:userid` | ✅ Yes | ✅ Yes | Deep dive view, full error card |
| StatesList | `/monitor/list` | ❌ No | ❌ No | List view, only `error_tag` |
| StatesSummary | `/monitor` | ❌ No | ❌ No | Aggregate view, counts only |

---

## Recommendations for Enhancement

If the user wants to add `error.message` to the UI:

### Option 1: Add to StatesList Table (Recommended if viewing many errors)
**Approach**: Add error message as a new table column
- **Pros**: Visible at a glance without drilling into detail view; helps triage multiple errors
- **Cons**: Requires either (a) changing StatesList API to return `state_json` (performance impact) or (b) fetching individually for each row (network overhead)
- **Implementation**: Expand StatesList SQL query to include `state_json`, then add new column to render `error.message`
- **Cost**: Moderate—need to handle performance implications

### Option 2: Add Hover Tooltip on Error Tag (Lower Cost)
**Approach**: Show `error.message` in a tooltip when hovering over the `error_tag` in StatesList
- **Pros**: Quick preview without UI clutter; minimal code change
- **Cons**: Requires fetching full state data (on demand or cached)
- **Implementation**: Modify StatesList to fetch `state_json` on hover or add tooltip text via column renderer
- **Cost**: Low—UX improvement without layout changes

### Option 3: Create Error-Specific Dashboard Tab
**Approach**: New tab in SurveyScreen specifically for error analysis
- **Pros**: Dedicated space for error triage with rich error details
- **Cons**: Another navigation layer; duplicates data already in StatesList
- **Cost**: Medium—new component, new API endpoint

### Option 4: Expand StateDetail Error Card (Already Complete)
**Approach**: No change needed—StateDetail already shows all error fields including `error.message`
- **Current state**: ✅ Complete
- **Note**: This is the recommended view for understanding a specific error in depth

---

## Related Code Files

### Frontend (React)
- `dashboard-client/src/containers/StatesExplorer/StateDetail.js` (190 lines)
- `dashboard-client/src/containers/StatesExplorer/StatesList.js` (274 lines)
- `dashboard-client/src/containers/StatesExplorer/StatesSummary.js` (145 lines)
- `dashboard-client/src/containers/StatesExplorer/index.js` (6 lines, exports only)
- `dashboard-client/src/containers/SurveyScreen/SurveyScreen.js` (305 lines, contains MonitorSection)

### Backend (Node.js)
- `dashboard-server/api/states/states.controller.js` (82 lines)
- `dashboard-server/api/states/states.routes.js` (14 lines)
- `dashboard-server/queries/states/states.queries.js` (159 lines)

### Database
- `devops/migrations/01-init.sql` (lines 109-162, states table schema)

### Documentation
- `documentation/states-debugging.md` — Comprehensive guide to states system (already well-documented)

---

## Key Findings

1. **StateDetail already shows `error.message`** — Deep dive view is complete and shows all error fields
2. **StatesList only shows `error_tag`** — Would benefit from seeing message for triage efficiency
3. **Backend doesn't return `state_json` in list queries** — Intentional for performance; list queries scan many rows
4. **No data loss** — All error information is available in the backend; it's just a UI visibility issue
5. **Route naming confusion** — "Monitor" section is actually States Explorer, not operational monitoring
6. **error_tag ≠ error.message** — They are two different fields; tag is a classification, message is human-readable text

---

## Navigation Patterns (Clarification)

Despite the confusing "Monitor" naming in code, users interact with this as the **States Explorer**:

1. User clicks "Monitor" tab in SurveyScreen
2. Lands on StatesSummary (overview of state counts)
3. Can click statistic or table row to drill into StatesList (filterable list)
4. Clicks userid in list to open StateDetail (individual state deep dive)
5. StateDetail shows complete error information including `error.message`

The "Monitor" name in code (`MonitorSection`) is misleading; this is debugging/observability, not operational monitoring (that's Dean's job).

---

## Applied Fix: Error Details Card in StateDetail.js

**Date**: 2026-03-18

**Changes Made**:

1. **Render condition updated** (line 178):
   - Before: `{isError && stateJson.error && (`
   - After: `{stateJson && stateJson.error && (`
   - Reason: Error cards should display whenever `error` object exists in `state_json`, not only when `current_state === 'ERROR'`. Real production data shows errors appearing in states like `BLOCKED`.

2. **Added new error fields to display**:
   - `error.code` — Error code number (e.g., 100 for Facebook error)
   - `error.type` — Error type classification (e.g., "OAuthException")
   - `error.fbtrace_id` — Facebook trace ID for support investigations

3. **Maintained backward compatibility**:
   - All existing fields (`error.tag`, `error.message`, `error.fb_error_code`, `error.payment_error_code`, `error.details`) remain displayed
   - No fields were removed, only new ones added

**Real data example matched**:
```json
{
  "error": {
    "code": 100,
    "fbtrace_id": "ADCXL1xB4B7RqfjR8s_LxkA",
    "message": "(#100) Invalid tag.",
    "stack": "MachineIOError: ...",
    "tag": "FB",
    "type": "OAuthException"
  }
}
```

**File modified**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/StatesExplorer/StateDetail.js` (lines 177-214)
