# User Lookup by PSID -- Implementation Plan

## Overview

Add a "User Lookup" feature to the dashboard that allows researchers to enter a Facebook page-scoped user ID (PSID), auto-resolve the page it belongs to, fetch the user's first/last name from the Facebook Graph API, and display the result.

---

## 1. Required Reading

Before implementing, the developer must read and understand:

| File | Why |
|------|-----|
| `/home/nandan/Documents/vlab-research/fly/planning/user-lookup-findings.md` | Full investigation of data model, auth, existing patterns |
| `/home/nandan/Documents/vlab-research/fly/replybot/lib/messenger/index.js` lines 44-57 | The existing `getUserInfo()` function that calls Facebook Graph API |
| `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/states/states.controller.js` | Controller pattern, `validateSurveyNameAccess` middleware, error handling |
| `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/states/states.queries.js` | Query binding pattern (`this.query()`, `bind(pool)`, module export shape) |
| `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/credentials/credentials.queries.js` | How credentials are queried, the `getOne` pattern |
| `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/StatesExplorer/StatesList.js` | Reference UI pattern for search + results display |

---

## 2. Backend Changes

### New Endpoint

```
GET /api/v1/user-lookup/:userid
```

**Flow:**
1. Extract `req.user.email` from auth middleware (already applied to all `/api/v1` routes)
2. Query `states` table to find rows where `userid = :userid`
3. Authorization check: join through states -> current_form -> surveys.shortcode -> surveys.userid -> users.email to verify the requesting user owns a survey that this PSID is associated with
4. Extract `pageid` from the matched states row
5. Query `credentials` table for `entity = 'facebook_page'` where `facebook_page_id = pageid` and the credential belongs to the authenticated user (join via `userid`)
6. Call Facebook Graph API: `GET /<psid>?fields=id,name,first_name,last_name` with `Authorization: Bearer <access_token>` from `credentials.details.access_token`
7. Return `{ userid, pageid, first_name, last_name, name }`

**Error cases:**
- `404` -- PSID not found in `states` table, or not associated with any survey owned by the requesting user
- `403` -- PSID exists but belongs to a page/survey the user does not own
- `502` -- Facebook Graph API call failed (network error, invalid token, API restriction)
- `400` -- Missing or empty userid parameter

### New Query: `lookupByUserid`

Add to `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/states/states.queries.js`:

```javascript
/**
 * Look up a participant's pageid by their userid (PSID), scoped to surveys
 * owned by the authenticated user.
 *
 * @param {string} email - Authenticated user's email
 * @param {string} userid - Facebook PSID to look up
 * @returns {Promise<Object|null>} { userid, pageid } or null
 */
async function lookupByUserid(email, userid) {
  const query = `
    SELECT DISTINCT s.userid, s.pageid
    FROM states s
    JOIN surveys sv ON s.current_form = sv.shortcode
    JOIN users u ON sv.userid = u.id
    WHERE u.email = $1
      AND s.userid = $2
    LIMIT 1
  `;
  const { rows } = await this.query(query, [email, userid]);
  return rows.length > 0 ? rows[0] : null;
}
```

### New Query: `getPageToken`

Add to `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/credentials/credentials.queries.js`:

```javascript
/**
 * Get the Facebook page access token for a given page ID, scoped to the
 * authenticated user.
 *
 * @param {string} email - Authenticated user's email
 * @param {string} pageid - Facebook page ID
 * @returns {Promise<Object|null>} { access_token } or null
 */
async function getPageToken(email, pageid) {
  const query = `
    SELECT details->>'access_token' as access_token
    FROM credentials
    JOIN users ON credentials.userid = users.id
    WHERE users.email = $1
      AND facebook_page_id = $2
    LIMIT 1
  `;
  const { rows } = await this.query(query, [email, pageid]);
  return rows.length > 0 ? rows[0] : null;
}
```

### New Controller: `user-lookup.controller.js`

Create at `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/user-lookup/user-lookup.controller.js`:

```javascript
'use strict';

const r2 = require('r2');
const { States, Credential } = require('../../queries');

const FB_GRAPH_URL = process.env.FACEBOOK_GRAPH_URL || 'https://graph.facebook.com/v18.0';

function handle(err, res) {
  console.error('User Lookup API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}

exports.lookupUser = async (req, res) => {
  try {
    const { userid } = req.params;
    const { email } = req.user;

    if (!userid || !userid.trim()) {
      return res.status(400).json({ error: { message: 'userid parameter is required' } });
    }

    // 1. Find pageid for this PSID, scoped to user's surveys
    const stateRow = await States.lookupByUserid(email, userid.trim());
    if (!stateRow) {
      return res.status(404).json({ error: { message: 'User not found in any of your surveys' } });
    }

    // 2. Get page token from credentials
    const tokenRow = await Credential.getPageToken(email, stateRow.pageid);
    if (!tokenRow || !tokenRow.access_token) {
      return res.status(404).json({ error: { message: 'No Facebook page token found for this page. Reconnect the page in Settings.' } });
    }

    // 3. Call Facebook Graph API
    const url = `${FB_GRAPH_URL}/${userid.trim()}?fields=id,name,first_name,last_name`;
    const headers = { Authorization: `Bearer ${tokenRow.access_token}` };

    let fbUser;
    try {
      fbUser = await r2.get(url, { headers }).json;
    } catch (networkErr) {
      return res.status(502).json({ error: { message: 'Failed to reach Facebook API' } });
    }

    if (fbUser.error) {
      return res.status(502).json({
        error: {
          message: `Facebook API error: ${fbUser.error.message}`,
          fb_error: fbUser.error,
        },
      });
    }

    // 4. Return result
    res.status(200).json({
      userid: stateRow.userid,
      pageid: stateRow.pageid,
      first_name: fbUser.first_name,
      last_name: fbUser.last_name,
      name: fbUser.name,
    });
  } catch (err) {
    handle(err, res);
  }
};
```

### New Route File

Create at `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/user-lookup/index.js`:

```javascript
const router = require('express').Router();
const controller = require('./user-lookup.controller');

router.get('/:userid', controller.lookupUser);

module.exports = router;
```

### Register Route

In `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/index.js`, add the new route:

```javascript
.use('/user-lookup', require('./user-lookup'))
```

---

## 3. Frontend Changes

### New Page Component: `UserLookup`

Create at `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/UserLookup/UserLookup.js`.

**UI layout** (following existing patterns -- Ant Design, functional component with hooks):

```
+--------------------------------------------------+
|  Card: "User Lookup"                             |
|                                                  |
|  Enter a page-scoped user ID (PSID):            |
|  [ PSID input field       ] [ Search button ]    |
|                                                  |
+--------------------------------------------------+
|                                                  |
|  (Result area -- shown after search)             |
|                                                  |
|  Card: "User Information"                        |
|  +----------------------------------------------+
|  | User ID:    | 123456789                       |
|  | Page ID:    | 987654321                       |
|  | First Name: | Leonardo                        |
|  | Last Name:  | Di Vittorio                     |
|  | Full Name:  | Leonardo Di Vittorio            |
|  +----------------------------------------------+
|                                                  |
|  (or Alert: "User not found" on 404)             |
|  (or Alert: "Facebook API error: ..." on 502)    |
+--------------------------------------------------+
```

**Component structure:**

```javascript
import React, { useState } from 'react';
import { Card, Input, Button, Descriptions, Alert, message } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import api from '../../services/api';
import { Loading } from '../../components/UI';

const UserLookup = () => {
  const [psid, setPsid] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleSearch = async () => {
    const trimmed = psid.trim();
    if (!trimmed) {
      message.warning('Please enter a PSID');
      return;
    }

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await api.fetcher({
        path: `/user-lookup/${encodeURIComponent(trimmed)}`,
      });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      // Parse error message from server response
      try {
        const errData = JSON.parse(err.message);
        setError(errData.error?.message || 'Lookup failed');
      } catch {
        setError(err.message || 'Lookup failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <Card title="User Lookup">
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <Input
            allowClear
            placeholder="Enter page-scoped user ID (PSID)"
            value={psid}
            onChange={(e) => setPsid(e.target.value)}
            onPressEnter={handleSearch}
            prefix={<SearchOutlined />}
            style={{ flex: 1 }}
          />
          <Button type="primary" onClick={handleSearch} loading={loading}>
            Search
          </Button>
        </div>
      </Card>

      {loading && <Loading />}

      {error && (
        <Alert
          type="error"
          message="Lookup Failed"
          description={error}
          showIcon
          style={{ marginTop: 16 }}
        />
      )}

      {result && (
        <Card title="User Information" style={{ marginTop: 16 }}>
          <Descriptions bordered column={1}>
            <Descriptions.Item label="User ID">{result.userid}</Descriptions.Item>
            <Descriptions.Item label="Page ID">{result.pageid}</Descriptions.Item>
            <Descriptions.Item label="First Name">{result.first_name}</Descriptions.Item>
            <Descriptions.Item label="Last Name">{result.last_name}</Descriptions.Item>
            <Descriptions.Item label="Full Name">{result.name}</Descriptions.Item>
          </Descriptions>
        </Card>
      )}
    </div>
  );
};

export default UserLookup;
```

### New Index File

Create at `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/UserLookup/index.js`:

```javascript
export { default } from './UserLookup';
```

### Route Registration

In `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/root.js`, add after the bails routes (around line 40):

```javascript
import UserLookup from './containers/UserLookup';
```

And in the Router:

```jsx
<PrivateRoute exact path="/user-lookup" component={UserLookup} auth={Auth} />
```

### Navbar Update

In `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/Navbar/Navbar.js`, add a new `Menu.Item` after the "Bails" item (line 19):

```jsx
<Menu.Item>
  <Link to="/user-lookup">User Lookup</Link>
</Menu.Item>
```

### Container Index Update

In `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/index.js`, add:

```javascript
import UserLookup from './UserLookup';
```

And add to the export block:

```javascript
UserLookup,
```

(Note: this export is optional since `root.js` imports directly. Include it for consistency with the existing pattern.)

---

## 4. File-by-File Change List

### Files to CREATE

| File | Purpose |
|------|---------|
| `dashboard-server/api/user-lookup/user-lookup.controller.js` | Controller: validate input, query states for pageid, query credentials for token, call Facebook API, return result |
| `dashboard-server/api/user-lookup/index.js` | Route file: `GET /:userid` -> `controller.lookupUser` |
| `dashboard-client/src/containers/UserLookup/UserLookup.js` | React component: search input, API call, result display |
| `dashboard-client/src/containers/UserLookup/index.js` | Re-export barrel file |

### Files to MODIFY

| File | Change |
|------|--------|
| `dashboard-server/queries/states/states.queries.js` | Add `lookupByUserid(email, userid)` function. Export it in the `queries` object at line 154. |
| `dashboard-server/queries/credentials/credentials.queries.js` | Add `getPageToken(email, pageid)` function. Export it in the `queries` object at line 68. |
| `dashboard-server/api/index.js` (line 14) | Add `.use('/user-lookup', require('./user-lookup'))` |
| `dashboard-client/src/root.js` (line 13, line 40) | Import `UserLookup`, add `<PrivateRoute exact path="/user-lookup" ...>` |
| `dashboard-client/src/components/Navbar/Navbar.js` (line 19) | Add `<Menu.Item><Link to="/user-lookup">User Lookup</Link></Menu.Item>` |
| `dashboard-client/src/containers/index.js` (lines 1, 21) | Import and re-export `UserLookup` |

---

## 5. Test Strategy

### Backend Unit Tests

**Query tests** (if a test harness exists for the queries module):
- `lookupByUserid` returns `{ userid, pageid }` when the PSID exists in a survey owned by the requesting user
- `lookupByUserid` returns `null` when the PSID exists but belongs to another user's survey
- `lookupByUserid` returns `null` when the PSID does not exist at all
- `getPageToken` returns `{ access_token }` for a valid page ID owned by the user
- `getPageToken` returns `null` for a page ID not owned by the user

**Controller tests** (mock queries and `r2`):
- Returns 400 for empty/missing userid
- Returns 404 when `lookupByUserid` returns null
- Returns 404 when `getPageToken` returns null
- Returns 502 when Facebook API returns an error object
- Returns 502 when Facebook API network request fails
- Returns 200 with `{ userid, pageid, first_name, last_name, name }` on success

### Frontend Manual Testing

- Navigate to `/user-lookup` via navbar link
- Enter a valid PSID -- should show user info card
- Enter an invalid PSID -- should show "User not found" error alert
- Enter an empty string and click Search -- should show warning message
- Press Enter in input field -- should trigger search
- Clear input with allowClear button -- should clear field
- Verify loading state shows while waiting for API response

### Integration Test

If the existing integration test infrastructure (using the `facebot` mock) is available:
- End-to-end: create a user, survey, credentials, and states row; call `GET /api/v1/user-lookup/<psid>`; verify response contains facebot's hardcoded name (`Leonardo Di Vittorio`)

---

## 6. Acceptance Criteria

1. A "User Lookup" link appears in the top navigation bar between "Bails" and "Login/Logout"
2. Clicking it navigates to `/user-lookup`
3. The page shows a search input with a placeholder "Enter page-scoped user ID (PSID)" and a "Search" button
4. Entering a valid PSID and pressing Enter or clicking Search displays the user's first name, last name, and full name in a bordered Descriptions card
5. The page ID is also displayed in the result
6. If the PSID is not found (404), an error alert says "User not found in any of your surveys"
7. If the Facebook API fails (502), an error alert shows the Facebook error message
8. If the page token is missing, an error alert says "No Facebook page token found for this page"
9. The endpoint is auth-protected (returns 401 for unauthenticated requests)
10. The endpoint only returns results for PSIDs in surveys owned by the authenticated user (authorization scoping)
11. The Facebook API call uses Graph API v18.0 (or configured URL) with Bearer token auth

---

## Design Decisions and Rationale

**Why a separate `/user-lookup` route group instead of extending `/states`?**
The existing states routes are all scoped under `/surveys/:surveyName/states` and require `validateSurveyNameAccess` middleware. User lookup is intentionally cross-survey (you do not need to know which survey the PSID belongs to), so it needs a different authorization pattern. A separate route group avoids complicating the existing states middleware.

**Why `r2` for the Facebook API call in the controller?**
The dashboard-server already uses `r2` in its Facebook controller (`dashboard-server/api/facebook/facebook.controller.js`). Using the same HTTP library maintains consistency. We do NOT import replybot's `getUserInfo` because: (a) replybot is a separate service with its own dependencies, and (b) the dashboard-server should not take a dependency on replybot code.

**Why no retry logic for the Facebook API call?**
This is a user-initiated, interactive request. If it fails, the user can simply click Search again. Adding retry logic would increase response latency for a synchronous request. The replybot has retries because it processes webhooks asynchronously.

**Why Graph API v18.0?**
The replybot uses v8.0 (set years ago). The dashboard-server Facebook controller uses v9.0. For new code, we should use a recent stable version. The `FACEBOOK_GRAPH_URL` env var can override this in all environments.

**Why not cache results?**
The user requirement explicitly states "live Facebook API call is acceptable." Caching adds complexity (invalidation, staleness) and the use case is low-frequency (researchers looking up specific participants).
