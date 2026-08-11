# Export Polling Implementation Plan

**Date**: 2026-02-16
**Feature**: 4-second polling + spinning animation for in-progress exports on ExportPanel
**Scope**: `ExportPanel` component in SurveyScreen only (not the global `/exports` page)

---

## 1. Overview

Two changes to the `ExportPanel` component in `SurveyScreen.js`:

1. **Polling**: Replace the one-shot `useEffect` fetch with a `setInterval`-based poll that calls `fetchExportsBySurvey()` every 4 seconds.
2. **Spinner**: Render a CSS-animated spinning icon + "Exporting..." text for rows where `status === 'Started'`.

No backend changes needed. No new dependencies.

---

## 2. Files to Modify

| File | Change |
|------|--------|
| `dashboard-client/src/containers/SurveyScreen/SurveyScreen.js` | Update `ExportPanel` useEffect for polling; update `exportColumns` Status render |
| `dashboard-client/src/containers/SurveyScreen/SurveyScreen.css` | Add `@keyframes` spinner and `.export-status-started` styles |

That is it. Two files.

---

## 3. Polling Mechanism

### Current code (lines 169-174 of SurveyScreen.js)

```javascript
useEffect(() => {
  fetchExportsBySurvey(selected)
    .then(data => setExports(data || []))
    .catch(err => console.error(err))
    .finally(() => setLoading(false));
}, [selected]);
```

### New code

```javascript
useEffect(() => {
  let cancelled = false;

  const fetchExports = () => {
    fetchExportsBySurvey(selected)
      .then(data => {
        if (!cancelled) setExports(data || []);
      })
      .catch(err => console.error(err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
  };

  fetchExports(); // immediate first fetch

  const intervalId = setInterval(fetchExports, 4000);

  return () => {
    cancelled = true;
    clearInterval(intervalId);
  };
}, [selected]);
```

Key details:
- `cancelled` flag prevents state updates after unmount (avoids React warning "Can't perform a React state update on an unmounted component").
- `clearInterval` in the cleanup function stops polling when the user navigates away from the Export tab.
- `setLoading(false)` only fires on the first fetch (subsequent polls will find `loading` already `false`, so `finally` is a harmless no-op setter).
- The interval runs unconditionally every 4 seconds. No conditional "only poll when Started rows exist" -- the user confirmed 4-second continuous polling is acceptable and the endpoint is lightweight (single indexed query).

---

## 4. Spinning Animation for Started Status

### Current status column definition (line 160)

```javascript
{ title: 'Status', dataIndex: 'status' },
```

### New status column definition

```javascript
{
  title: 'Status',
  dataIndex: 'status',
  render: (status) => {
    if (status === 'Started') {
      return (
        <span className="export-status-started">
          <span className="export-spinner" />
          Exporting...
        </span>
      );
    }
    return status;
  },
},
```

This renders:
- `Started` rows: a small spinning circle + "Exporting..." text
- `Finished` / `Failed` rows: plain text as before (no change)

### CSS (append to SurveyScreen.css)

```css
/* Export status spinner for in-progress exports */
.export-status-started {
  display: inline-flex;
  align-items: center;
  color: #1890ff;
  font-weight: 500;
}

.export-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: 8px;
  border: 2px solid #1890ff;
  border-top-color: transparent;
  border-radius: 50%;
  animation: export-spin 0.8s linear infinite;
}

@keyframes export-spin {
  to {
    transform: rotate(360deg);
  }
}
```

Design rationale:
- Uses Ant Design's primary blue (`#1890ff`) to match the existing UI theme.
- 14px spinner is proportional to table text size.
- `border-top-color: transparent` creates the classic rotating arc spinner.
- 0.8s rotation speed is fast enough to look active but not distracting.
- Pure CSS, no JS animation library, no new dependencies.

---

## 5. Complete Diff Summary

### SurveyScreen.js

**Change 1**: Replace the `exportColumns` Status column (line 160).

Replace:
```javascript
{ title: 'Status', dataIndex: 'status' },
```

With:
```javascript
{
  title: 'Status',
  dataIndex: 'status',
  render: (status) => {
    if (status === 'Started') {
      return (
        <span className="export-status-started">
          <span className="export-spinner" />
          Exporting...
        </span>
      );
    }
    return status;
  },
},
```

**Change 2**: Replace the `useEffect` in `ExportPanel` (lines 169-174).

Replace:
```javascript
useEffect(() => {
  fetchExportsBySurvey(selected)
    .then(data => setExports(data || []))
    .catch(err => console.error(err))
    .finally(() => setLoading(false));
}, [selected]);
```

With:
```javascript
useEffect(() => {
  let cancelled = false;

  const fetchExports = () => {
    fetchExportsBySurvey(selected)
      .then(data => {
        if (!cancelled) setExports(data || []);
      })
      .catch(err => console.error(err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
  };

  fetchExports();

  const intervalId = setInterval(fetchExports, 4000);

  return () => {
    cancelled = true;
    clearInterval(intervalId);
  };
}, [selected]);
```

### SurveyScreen.css

**Append** the spinner styles at the end of the file:

```css
/* Export status spinner for in-progress exports */
.export-status-started {
  display: inline-flex;
  align-items: center;
  color: #1890ff;
  font-weight: 500;
}

.export-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: 8px;
  border: 2px solid #1890ff;
  border-top-color: transparent;
  border-radius: 50%;
  animation: export-spin 0.8s linear infinite;
}

@keyframes export-spin {
  to {
    transform: rotate(360deg);
  }
}
```

---

## 6. What This Does NOT Change

- The global `/exports` page (`Exports.js`) -- no polling there (separate scope if desired later).
- The `fetchExportsBySurvey` API service -- no changes needed, it already returns what we need.
- The backend -- no new endpoints or modifications.
- No new npm dependencies.

---

## 7. Acceptance Criteria

1. When the user is on the Export tab of a survey (`/surveys/{name}/export`), the export list refreshes automatically every 4 seconds without any user interaction.
2. Exports with `status === 'Started'` display a small blue spinning circle followed by "Exporting..." instead of the plain "Started" text.
3. Exports with `status === 'Finished'` or `'Failed'` display their status as plain text (no change from current behavior).
4. When the user navigates away from the Export tab (to Edit, Monitor, or another page entirely), the polling interval is cleaned up and no further API calls are made.
5. If the API call fails (network error, 500, etc.), the error is logged to console and the existing table data remains displayed (no crash, no blank screen). The next poll attempt occurs 4 seconds later as normal.
6. The spinner animation is pure CSS with no new dependencies.
7. No visible flicker or table re-render jump when the data refreshes (React's reconciliation handles this since `rowKey="id"` is already set on the Table).

---

## 8. Edge Cases

- **Multiple rapid tab switches**: The `cancelled` flag and `clearInterval` in the cleanup function handle this. Each mount creates a new interval; each unmount clears it.
- **`selected` prop changes**: The `useEffect` dependency on `[selected]` means if the survey name changes, the old interval is cleaned up and a new one starts. This matches the existing behavior.
- **Empty export list**: Polling still runs. This is intentional -- the user may have just triggered an export from a Create form and navigated back.
- **Overlapping fetches**: If a fetch takes longer than 4 seconds, the next `setInterval` tick fires a second concurrent request. This is acceptable because `fetchExportsBySurvey` is a simple GET and the responses are idempotent (each `setExports` call replaces the entire array). No race condition -- the last response to arrive wins, and the data is always a valid snapshot.
