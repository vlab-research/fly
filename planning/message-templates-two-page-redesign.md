# MessageTemplates two-page redesign

## Problem

The MessageTemplates page resets `selectedPage` to `undefined` on every browser refresh,
so the template list never fetches and appears empty. A localStorage fix was rejected.
The right fix is a UX redesign: split into a list page (no page selection needed) and a
create page, backed by a backend change that makes `pageId` optional on GET.

---

## Current state of files to change

### `dashboard-server/queries/message-templates/message-templates.queries.js`

`list` currently takes `{ email, facebookPageId }` and filters by both:
```sql
WHERE u.email = $1
  AND m.facebook_page_id = $2
ORDER BY m.name ASC, m.language ASC
```
No `listAll` function exists yet. Exported via `queries: pool => ({ create, list, get, updateStatus, remove })`.

### `dashboard-server/api/message-templates/message-templates.controller.js`

`list` handler (lines 79–125) hard-requires `pageId`:
```javascript
if (!pageId) {
  return res.status(400).json({ error: 'pageId query parameter is required' });
}
```
Then fetches, groups PENDING by name, refreshes from Facebook per-name, returns all formatted.

### `dashboard-client/src/root.js` (line 45)
```jsx
<PrivateRoute exact path="/message-templates" component={MessageTemplates} auth={Auth} />
```
Only one route. `MessageTemplates` is imported from `./containers/MessageTemplates` (default export).

### `dashboard-client/src/containers/MessageTemplates/MessageTemplates.js`

Currently has **half-done localStorage edits** (mid-flight when plan mode activated):
- `useState(() => localStorage.getItem(SELECTED_PAGE_KEY) || undefined)` — bad init
- `handlePageChange` function that writes to localStorage
- Load effect that validates/restores from localStorage and auto-selects if one page
- `onChange={handlePageChange}` on the Select

All of this is to be **replaced** by the rewrite below.

---

## Backend changes

### 1. `message-templates.queries.js` — add `listAll`

Add after the existing `list` function (line 41):

```javascript
async function listAll({ email }) {
  const q = `
    SELECT m.id, m.facebook_page_id, m.fb_template_id, m.name, m.language,
           m.body, m.status, m.rejection_reason, m.buttons, m.created, m.updated
    FROM message_templates m
    JOIN users u ON m.userid = u.id
    WHERE u.email = $1
    ORDER BY m.name ASC, m.language ASC
  `;
  const { rows } = await this.query(q, [email]);
  return rows;
}
```

Export it: add `listAll` to the `queries` map at the bottom.

### 2. `message-templates.controller.js` — make `pageId` optional on `list`

Replace lines 79–125 (`list` handler). New logic:

```
if pageId provided:
  → existing behavior unchanged (templateQuery.list + Facebook PENDING refresh per-page)
if no pageId:
  → call templateQuery.listAll({ email })
  → group PENDING rows by facebook_page_id
  → for each group: getPageToken → getTemplatesByName for each unique name → updateStatus
  → return all formatted records
```

The PENDING refresh loop logic is the same as today — just wrapped to run per-page instead of assuming a single pageId is already known.

---

## Frontend changes

### 3. `src/root.js` — add second route

After line 45, add:
```jsx
<PrivateRoute exact path="/message-templates/new" component={NewMessageTemplate} auth={Auth} />
```
Add `NewMessageTemplate` to the import from `./containers/MessageTemplates`.

### 4. `MessageTemplates.js` — rewrite as list page

Remove: page selector state, `handlePageChange`, form state, `placeholderIndices`, `onSubmit`, the `Form` block, the `selectedPageRef`, the localStorage init.

Keep: `loadTemplates`, polling logic, `onDelete`, `statusCell`, `columns`, table card.

Add:
- On mount: `GET /message-templates` (no `pageId`) → `setTemplates(data)`
- Fetch pages separately to build a `{ [pageId]: pageName }` lookup for the Page column
- Poll `GET /message-templates` (no `pageId`) every 4 s while any PENDING; stop when none
- Add **Page** column to `columns` using the lookup map
- "New Template" button on the card title → `history.push('/message-templates/new')`
- Empty state: "No templates yet." with a link to `/message-templates/new`

### 5. `NewMessageTemplate.js` — new file (extracted create form)

Extract from current `MessageTemplates.js`:
- All form state: `placeholderIndices`, `submitting`
- `pages`, `selectedPage`, `loadPages`, page selector
- Auto-select if exactly one page (no localStorage)
- Full `Form` block unchanged
- On submit success: `history.push('/message-templates')` instead of updating local state
- Cancel button: `history.push('/message-templates')`
- Import `useHistory` from `react-router-dom`

---

## Files to change (summary)

| File | Change |
|------|--------|
| `dashboard-server/queries/message-templates/message-templates.queries.js` | Add `listAll({ email })` |
| `dashboard-server/api/message-templates/message-templates.controller.js` | Make `pageId` optional; grouped PENDING refresh when absent |
| `dashboard-client/src/root.js` | Add `/message-templates/new` route + import |
| `dashboard-client/src/containers/MessageTemplates/MessageTemplates.js` | Rewrite as list page; undo localStorage edits |
| `dashboard-client/src/containers/MessageTemplates/NewMessageTemplate.js` | New file — create form |

---

## Verification

1. `/message-templates` → table populates immediately, no page selector shown
2. Refresh → templates still appear (no interaction required)
3. Any PENDING template → polls every 4 s → updates to APPROVED/REJECTED
4. "New Template" button → navigates to `/message-templates/new`
5. Create form: if one page → auto-selected; submit → redirects to list with new PENDING row
6. Cancel on create page → returns to list unchanged
7. Delete from list → row removed
8. `GET /message-templates` with `pageId` (old behavior) still works unchanged
