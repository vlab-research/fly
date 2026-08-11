# Dashboard Client Export UI -- Investigation Findings

**Date**: 2026-02-15
**Investigator**: explore agent
**Purpose**: Understand how the dashboard frontend handles triggering and downloading exports.

---

## 1. UI Framework and Stack

| Technology | Version | Role |
|------------|---------|------|
| React | 16.13.1 | Component framework |
| Ant Design (antd) | 4.8.6 | Primary UI component library |
| styled-components | 4.4.1 | Custom styled components (buttons, layout) |
| react-router-dom | 5.2.0 | Client-side routing |
| Create React App | 2.1.8 | Build tooling (not ejected) |

No state management library (no Redux, MobX, etc.). State is managed with React hooks (`useState`, `useEffect`) and React Context where needed.

---

## 2. Export-Related Files (Complete Inventory)

### Components / Containers

| File | Purpose |
|------|---------|
| `src/containers/Exports/Exports.js` | **Export list page** -- shows table of all exports with status and download links |
| `src/containers/Exports/Exports.css` | Minimal CSS for selector styling on the exports page |
| `src/containers/CreateExport/CreateExport.js` | **Export creation form** -- form with options for configuring an export |
| `src/containers/SurveyScreen/SurveyScreen.js` | Contains the `ExportPanel` component (lines 102-106) that renders the EXPORT button within a survey's tab view |

### API / Services

| File | Purpose |
|------|---------|
| `src/services/api/startExport.js` | Triggers an export via `POST /exports?survey={name}` |
| `src/services/api/getCSV.js` | Downloads a CSV file via blob URL -- **UNUSED** (exported but never imported by any component) |
| `src/services/api/fetcher.js` | Generic fetch wrapper with Auth0 Bearer token injection |
| `src/services/hooks/useMountFetch.js` | Custom hook for one-time data fetching on component mount |

### Routing

| File | Route | Component |
|------|-------|-----------|
| `src/root.js` (line 41) | `/exports/create` | `CreateExport` |
| `src/root.js` (line 42) | `/exports` | `Exports` |
| `src/containers/SurveyScreen/SurveyScreen.js` (line 195) | `/surveys/:survey/export` | `ExportPanel` (inline) |

### Navigation

| File | Line | Element |
|------|------|---------|
| `src/components/Navbar/Navbar.js` (line 21) | Top-level nav | `<Link to="/exports">Exports</Link>` |

---

## 3. Export Trigger Flow (Step by Step)

### Entry Point 1: From a Survey's "Export" Tab

1. User navigates to `/surveys/{surveyName}` and sees three tabs: **Edit**, **Monitor**, **Export** (SurveyScreen.js line 175-179).
2. Clicking the "Export" tab navigates to `/surveys/{surveyName}/export`.
3. The `ExportPanel` component renders a single `CreateBtn` link:
   ```jsx
   <CreateBtn to={`/exports/create?survey_name=${encodeURIComponent(selected)}`}> EXPORT </CreateBtn>
   ```
   This is a styled `<Link>` (not a `<button>`), so it just navigates to the create page.

### Entry Point 2: Direct Navigation

- User can go directly to `/exports/create?survey_name={name}` if they know the URL.
- There is no export button on the `/exports` list page itself -- it only shows existing exports.

### The CreateExport Form (`/exports/create`)

**File**: `src/containers/CreateExport/CreateExport.js`

1. **Survey context** is extracted from the URL query param `survey_name`:
   ```javascript
   const query = new URLSearchParams(location.search);
   const survey = decodeURIComponent(query.get('survey_name'));
   ```

2. The form presents these configuration options (all using Ant Design `Form`):

   | Field | Type | Default | Description |
   |-------|------|---------|-------------|
   | `keep_final_answer` | Switch | `true` | Keep only final answer per question |
   | `drop_duplicated_users` | Switch | `true` | Remove duplicate user entries |
   | `add_duration` | Switch | `true` | Add duration columns to export |
   | `drop_users_without` | Input | empty | Drop users missing a specific variable |
   | `pivot` | Switch | `true` | Pivot data to wide format |
   | `response_value` | Select | `"translated_response"` | Which response value to use in pivot (Response or Translated Response) |
   | `metadata` | Input | empty | Comma-separated metadata column names to include |

3. **On submit** (`onFinish` handler, line 20-35):
   ```javascript
   const onFinish = async (body) => {
     setLoading(true);
     if (body && body.metadata) {
       body.metadata = body.metadata.split(',').map(x => x.trim());
     }
     await startExport(survey, body);
     // artificial wait, hoping for exporter to catch up
     await new Promise(resolve => setTimeout(resolve, 4000));
     setLoading(false);
     history.push('/exports');
   };
   ```

4. **Loading state**: A `<Spin spinning={loading}>` wrapper covers the entire form during submission.

### The `startExport` API Call

**File**: `src/services/api/startExport.js`

```javascript
export default function startExport(selected, body) {
  return ApiClient.fetcher({
    method: 'POST',
    path: `/exports?survey=${encodeURIComponent(selected)}`,
    body
  })
    .then(async (res) => {
      if (res.status !== 201) {
        throw new Error(`Error starting export: ${selected} Error: ${res.statusText}`);
      }
      return res.body.status;
    })
    .catch((err) => {
      console.error(err);
    });
}
```

Key observations:
- **HTTP method**: `POST` to `/api/v1/exports?survey={surveyName}`
- **Request body**: JSON with form field values (the export configuration options)
- **Expected success**: HTTP 201 Created
- **Error handling**: Errors are caught and only logged to console -- **no user-facing error feedback**
- The Auth0 Bearer token is automatically attached by the `fetcher` (see `fetcher.js` line 27)

---

## 4. Download / Status Flow

### Exports List Page (`/exports`)

**File**: `src/containers/Exports/Exports.js`

1. On mount, fetches `GET /api/v1/exports/status` using the `useMountFetch` hook.
2. Renders an Ant Design `<Table>` with columns:
   - Survey (survey_id)
   - User (user_id)
   - Time Exported (updated)
   - Status (status)
   - Download (export_link) -- rendered as a `<Link>` opening the URL in a new tab

3. **Download mechanism**: The `DownloadLink` renderer:
   ```jsx
   const DownloadLink = (text, record) => (
     <Link to={{pathname: text}} target="_blank"> DOWNLOAD </Link>
   );
   ```
   This creates a React Router `<Link>` with `target="_blank"`, so clicking DOWNLOAD opens the `export_link` URL in a new browser tab. This likely points to a cloud storage URL (e.g., GCS signed URL).

4. **No polling**: The exports list is fetched once on mount. There is no refresh or polling mechanism. If a user triggers an export and lands on this page, they see whatever state the exports are in at that moment.

5. **The 4-second artificial wait**: After triggering an export, `CreateExport` waits 4 seconds before redirecting to `/exports`, hoping the export has completed. This is a fragile heuristic -- no actual completion check.

### Unused `getCSV` Function

**File**: `src/services/api/getCSV.js`

This function fetches a CSV as a blob and triggers a browser download via a dynamically created `<a>` element. It is exported from the API service but **never called by any component**. It appears to be dead code from an earlier implementation approach. It would download from a server-generated CSV endpoint rather than a cloud storage link.

---

## 5. Survey Context Passing

The survey name flows through the system as follows:

```
Surveys.js (fetches all surveys from /api/v1/surveys)
  |
  v
Surveys.js reads `survey` from URL params: useParams() -> surveyParam
  |
  v
SurveyScreen receives `selected={selected}` prop (the decoded survey name)
  |
  v
ExportPanel receives `selected={selected}` prop
  |
  v
ExportPanel renders link to /exports/create?survey_name={encoded_name}
  |
  v
CreateExport reads survey_name from URL query params: URLSearchParams
  |
  v
startExport() sends it as query param: POST /exports?survey={encoded_name}
```

The survey name is passed via **URL query parameters**, not through React Context or component state. This means the export creation page can work independently of the survey navigation context.

---

## 6. State Management Summary

| Concern | Approach |
|---------|----------|
| Export creation loading | Local `useState(false)` in CreateExport |
| Export list data | `useMountFetch` hook (fetches once on mount, stores in local state) |
| Export list refresh | **None** -- page must be manually reloaded |
| Error handling on trigger | Errors caught and logged to console only; no UI feedback |
| Error handling on list | Errors from `useMountFetch` logged to console; no UI feedback |
| Survey context | Passed via URL query params |
| Auth tokens | Singleton Auth service, injected by fetcher |

---

## 7. UI Hierarchy and Button Placement

```
Root (root.js)
  +-- Navbar (always visible)
  |     +-- "Exports" link -> /exports
  |
  +-- /surveys/:survey (Surveys container)
  |     +-- Sider (survey list)
  |     +-- Content
  |           +-- SurveyScreen
  |                 +-- Tabs: [Edit] [Monitor] [Export]
  |                 +-- /export tab -> ExportPanel
  |                       +-- CreateBtn "EXPORT" -> /exports/create?survey_name=...
  |
  +-- /exports/create (CreateExport container)
  |     +-- <Spin> wrapper for loading state
  |     +-- <h1> "Export {survey}"
  |     +-- Ant Design <Form> with export config options
  |     +-- PrimaryBtn "START EXPORT" (submits form)
  |
  +-- /exports (Exports container)
        +-- Ant Design <Table> with export rows
              +-- Each row has "DOWNLOAD" link opening export_link in new tab
```

---

## 8. Patterns and Conventions

1. **Styled-components for custom buttons**: `CreateBtn` (a styled `Link`) and `PrimaryBtn` (a styled `button`) are defined in `src/components/UI/index.js`.
2. **Ant Design for forms and tables**: Forms use `antd` `Form`, `Switch`, `Select`, `Input`. Tables use `antd` `Table` with column definitions.
3. **Container pattern**: Each feature is a directory under `src/containers/` with an `index.js` barrel export.
4. **URL-based state**: Survey selection and export context use URL params/query strings rather than React Context.
5. **No loading skeletons**: Loading states use Ant Design `<Spin>` (full spinner overlay) or the custom `<Loading>` component (centered spinner with text).
6. **No toast/notification feedback**: Errors are logged to console. No `antd message` or `notification` calls in the export flow.

---

## 9. Gaps and Concerns

1. **No error feedback to users**: If `startExport` fails, the error is swallowed by `console.error`. The user sees the spinner stop and gets redirected to `/exports` regardless of success/failure.
2. **No polling or refresh on export list**: After triggering an export, the user lands on `/exports` but has no way to see progress update without manually refreshing.
3. **4-second hard-coded wait is fragile**: The artificial delay in CreateExport (line 31) is a workaround for the lack of real-time status updates.
4. **`getCSV` is dead code**: Never used by any component. Could be removed or repurposed.
5. **No export cancellation**: There is no way to cancel an in-progress export from the UI.
6. **DownloadLink uses React Router Link**: The download link renders as `<Link to={{pathname: text}} target="_blank">`. If `export_link` is an external URL (e.g., a GCS signed URL), using React Router's `<Link>` for an external URL is technically incorrect -- it should be a plain `<a href>` tag. React Router `<Link>` is designed for internal routing. This may still work because of `target="_blank"`, but it is a code smell.
7. **Console.log left in Exports.js** (line 26): `console.log(exports)` is a debug statement left in production code.
