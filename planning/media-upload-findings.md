# Media Upload Feature - Architecture Findings

## Dashboard Client Architecture

### Overview

The dashboard-client is a React 16 SPA using Ant Design 4 as the UI framework, deployed on Netlify. It uses react-router-dom v5, Auth0 for authentication, and a custom `fetcher` function (native `fetch` wrapper) for API communication.

### 1. Routing Setup

**Route definitions**: All top-level routes are defined in `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/root.js`.

**Route pattern**: Every authenticated route uses `<PrivateRoute>`:
```jsx
<PrivateRoute exact path="/bails" component={BailSystems} auth={Auth} />
```

`PrivateRoute` (`src/components/PrivateRoute/PrivateRoute.js`) wraps the component in:
- An Ant Design `<Header>` containing the `<Navbar>`
- An Ant Design `<Content>` wrapper (flex column layout)
- Redirects to `/login` if not authenticated
- Shows a spinner during token renewal

**Navbar**: Defined in `src/components/Navbar/Navbar.js`. It is a simple Ant Design `<Menu mode="horizontal">` with hardcoded `<Menu.Item>` links:
- Home (`/`)
- Surveys (`/surveys`)
- Bails (`/bails`)
- Login/Logout button (float right)

**To add a new top-level page** (e.g., `/media`), you need to:
1. Create a container component in `src/containers/Media/`
2. Add it to `src/containers/index.js` exports
3. Add a `<PrivateRoute>` in `src/root.js`
4. Add a `<Menu.Item>` link in `src/components/Navbar/Navbar.js`

**Nested routes**: Some pages (e.g., Surveys) define sub-routes internally using `<Switch>` and `useRouteMatch()` within the container component. See `src/containers/Surveys/Surveys.js` and `src/containers/SurveyScreen/SurveyScreen.js`.

### 2. Existing Page Pattern (BailSystems as Reference)

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/BailSystems/BailSystems.js`

This is the best reference for a new CRUD-style top-level page:

**Structure**:
```
src/containers/BailSystems/
  index.js          # Re-exports BailSystems, BailForm, BailEvents
  BailSystems.js    # List page
  BailForm.js       # Create/edit form
  BailEvents.js     # Detail/history view
  BailSystems.css   # Styles
```

**State management**: Pure React hooks (`useState`, `useEffect`). No Redux, no MobX, no context (except Survey context in one place).

**Data fetching pattern** (used consistently across all containers):
```javascript
const [data, setData] = useState(null);
const [loading, setLoading] = useState(true);

useEffect(() => { loadData(); }, []);

const loadData = async () => {
  try {
    const res = await api.fetcher({ path: '/endpoint' });
    const result = await res.json();
    setData(result);
  } catch (err) {
    message.error('Failed to load data');
    console.error(err);
  } finally {
    setLoading(false);
  }
};
```

**Loading state**: Returns `<Loading>Loading...</Loading>` (from `src/components/UI`) while loading.

**Layout pattern**: Wraps content in `<Layout><Content style={{ padding: '30px' }}>`.

**User ID resolution**: Bail endpoints require a user ID. The pattern is to first call `POST /users` with empty body (which creates-or-returns the user), then use the returned `user.id` for subsequent API calls. This pattern is repeated in `App.js` and `BailSystems.js`.

### 3. API Communication

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/services/api/fetcher.js`

- Uses **native `fetch`** (not axios)
- Base URL: `${process.env.REACT_APP_SERVER_URL}/api/v1${path}`
- Auth: Attaches `Authorization: Bearer ${idToken}` header automatically
- For POST/PUT: Hardcodes `Content-Type: application/json` and `JSON.stringify(body)`
- Returns the raw `Response` object (caller does `.json()`)
- Error handling: `wrapApiResponse()` throws on non-OK responses
- `raw: true` option skips the error wrapper

**IMPORTANT for file uploads**: The current fetcher **cannot handle file uploads** because it:
1. Hardcodes `Content-Type: application/json` for POST/PUT
2. Always `JSON.stringify(body)`
3. Has no support for `FormData`

For the Media upload feature, either the fetcher needs to be extended or a separate upload function needs to be created that sends `FormData` without the JSON content type.

**Custom hook**: `useMountFetch` (`src/services/hooks/useMountFetch.js`) provides a simpler pattern for GET-on-mount:
```javascript
const [data, setData] = Hook.useMountFetch({ path: '/endpoint' }, initialValue);
```

**API service files** (in `src/services/api/`):
- `fetcher.js` -- Core fetch wrapper
- `index.js` -- Re-exports
- `startExport.js` -- Export-specific POST helper
- `fetchExportsBySurvey.js` -- Export list fetch helper
- `getCSV.js` -- Blob download helper (currently unused)

### 4. Authentication

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/services/auth/auth.js`

- Auth0 WebAuth SDK (`auth0-js` package)
- Singleton pattern: `export default new Auth()` -- NOT a React context/provider
- Stores `accessToken`, `idToken`, `expiresAt` as instance properties
- `isAuthenticated()` checks expiry time
- `getIdToken()` returns the token (used by fetcher)
- Session renewal: On page load, if `isLoggedIn` in localStorage, calls `checkSession()` to silently renew
- Auth flow: Login redirects to Auth0, callback at `/auth` parses hash, sets session, redirects to `/`

**Auth guard**: `PrivateRoute` checks `auth.isAuthenticated()`. If false and not renewing, redirects to `/login`.

**Environment variables** for auth:
- `REACT_APP_AUTH0_DOMAIN`
- `REACT_APP_AUTH0_CLIENT_ID`
- `REACT_APP_AUTH0_CALLBACK_URL`

### 5. UI Framework

**Primary**: **Ant Design 4** (`antd ^4.8.6`) with `@ant-design/icons ^4.3.0`

Commonly used Ant Design components:
- `Layout`, `Header`, `Content`, `Sider` -- page structure
- `Menu` -- navigation (both top navbar and sidebar)
- `Table` -- data tables with pagination, sorting
- `Button`, `Switch`, `Tag`, `Space` -- controls
- `message` -- toast notifications for success/error feedback
- `Popconfirm` -- confirmation dialogs
- `Form`, `Input`, `Select`, `DatePicker` -- form controls (in BailForm)
- `Spin` -- loading spinners

**Secondary**: `styled-components ^4.4.1` (with `/macro` imports for build-time optimization) -- used sparingly in `src/components/UI/index.js` and a few other places.

**CSS**: Plain `.css` files imported per-component. No CSS modules, no SCSS.

**For the Media page**: Use Ant Design's `Upload` component (`antd` includes `<Upload>` and `<Upload.Dragger>`) for file uploads. This is already available in the installed `antd@4.8.6` package -- no new dependency needed.

### 6. File Organization Convention

```
src/
  components/           # Reusable, presentational components
    Navbar/
      Navbar.js
    PrivateRoute/
      PrivateRoute.js
    UI/
      index.js          # Shared styled-components (Loading, CreateBtn, etc.)
    ConditionBuilder/
      ConditionBuilder.js
    ...
  containers/           # Feature pages with business logic
    BailSystems/
      index.js          # Re-exports
      BailSystems.js    # Main list view
      BailForm.js       # Create/edit
      BailEvents.js     # Sub-page
      BailSystems.css
    Surveys/
      Surveys.js        # Sidebar + sub-routing
      Surveys.css
    App/
      App.js
      App.css
    ...
    index.js            # Barrel file re-exporting all containers
  services/
    api/
      fetcher.js        # Core API client
      index.js
      ...
    auth/
      auth.js           # Auth0 singleton
      auth0-variables.js
    hooks/
      useMountFetch.js  # Generic data-fetching hook
    ...
    index.js            # Barrel file
  helpers/
    argValidation.js
    index.js
  root.js               # All top-level route definitions
  index.js              # App entry point
  index.css             # Global styles
```

**Naming conventions**:
- Container directories: PascalCase matching the component name
- Each container has an `index.js` that re-exports the default
- CSS files named after the component
- Service directories: lowercase
- No TypeScript anywhere -- pure JavaScript with PropTypes (sparingly used)

### 7. Summary: Steps to Add a "Media" Top-Level Page

1. **Create container**: `src/containers/Media/Media.js` and `src/containers/Media/index.js`
2. **Export from containers barrel**: Add to `src/containers/index.js`
3. **Add route**: Add `<PrivateRoute exact path="/media" component={Media} auth={Auth} />` in `src/root.js`, import Media at top
4. **Add navbar link**: Add `<Menu.Item><Link to="/media">Media</Link></Menu.Item>` in `src/components/Navbar/Navbar.js`
5. **Extend API client for file uploads**: Either modify `fetcher.js` to conditionally skip JSON serialization when body is `FormData`, or create a dedicated `src/services/api/uploadMedia.js` helper
6. **Use Ant Design Upload**: `antd@4.8.6` includes the `Upload` and `Upload.Dragger` components -- no new dependency needed

### 8. Risks and Considerations

- **fetcher.js modification**: The hardcoded JSON content type means file uploads require changes to the core API client or a bypass. Safest approach: add a conditional in `fetcher.js` that skips `Content-Type` and `JSON.stringify` when `body instanceof FormData`.
- **React version**: React 16.13.1 does not support hooks like `useId()` or automatic batching. Standard hooks (`useState`, `useEffect`, `useCallback`) all work fine.
- **No TypeScript**: Follow the existing JS + PropTypes pattern.
- **No state management library**: Keep using local component state with hooks.
- **Upload component**: Ant Design 4's `Upload` component supports custom upload via `customRequest` prop, which would let you use the modified fetcher rather than Ant's default XMLHttpRequest.

---

## Existing Media/Facebook API Patterns

### 1. Facebook Graph API Usage

The codebase has a well-established pattern for calling the Facebook Graph API, concentrated in two services:

#### Replybot Messenger Module (`/home/nandan/Documents/vlab-research/fly/replybot/lib/messenger/index.js`)
- **Base URL**: `process.env.FACEBOOK_GRAPH_URL || "https://graph.facebook.com/v8.0"`
- **Auth pattern**: `Authorization: Bearer ${pageToken}` header
- **Retry logic**: Exponential backoff (400ms base), up to 5 retries for ETIMEDOUT and FB error codes 1200/551
- **Error handling**: Wraps all errors in `MachineIOError` with tags (`NETWORK`, `FB`)
- **Endpoints used**:
  - `POST ${BASE_URL}/me/messages` -- send messages to users
  - `GET ${BASE_URL}/${id}?fields=id,name,first_name,last_name` -- get user info
  - `POST ${BASE_URL}/me/pass_thread_control` -- handoff protocol
- **NOT used**: `message_attachments` API (for uploading reusable media)

#### Dashboard Server Facebook Utils
- `/home/nandan/Documents/vlab-research/fly/dashboard-server/utils/facebook/facebook.util.js` -- subscribes pages, sets "Get Started" button
- `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/facebook/facebook.controller.js` -- exchanges tokens, adds webhooks
- Both use `r2` for HTTP requests (same as replybot)
- Dashboard-server uses Graph API v9.0; replybot uses v8.0

### 2. Attachment Translation in translate-typeform (Sending Media TO Users)

The `@vlab-research/translate-typeform` package (`replybot/node_modules/@vlab-research/translate-typeform/translate-fields.js`, lines 278-300) already has a `translateAttachment` function that constructs Facebook Send API attachment payloads:

```javascript
const translateAttachment = (data) => {
  const { attachment } = data.md
  const { type, url, attachment_id } = attachment

  const payload = {}

  if (url) {
    payload['url'] = url
    payload['is_reusable'] = true    // <-- uses is_reusable flag
  }

  if (attachment_id) {
    payload['attachment_id'] = attachment_id  // <-- supports pre-uploaded attachments
  }

  return {
    "attachment": {
      "type": type,       // e.g., "image", "video", "audio", "file"
      "payload": payload
    }
  }
}
```

**Key insight**: The system already supports two modes for sending attachments:
1. **By URL** -- provides `url` + `is_reusable: true` (Facebook downloads and caches the image)
2. **By attachment_id** -- uses a pre-uploaded attachment ID (from the `message_attachments` API)

The `attachment_id` code path exists but **nothing in the codebase actually calls the Facebook `message_attachments` API to upload media and obtain an `attachment_id`**. This is the gap that needs to be filled.

The field type `attachment` is registered in the translator lookup table (line 326) alongside other field types like `short_text`, `multiple_choice`, etc.

### 3. Upload Field Type (Receiving Media FROM Users)

The system also supports an `upload` field type for **receiving** media from users (the opposite direction):
- `translate-fields.js` line 217: `translateUpload = translateShortText` -- sends a plain text prompt asking the user to upload
- `validator.js` lines 264-277: `validateUpload` validates that the user's response is an attachment with the correct type and has a `payload.url`
- `machine.js` lines 513-522 (`/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js`): When a user sends media (`MEDIA` event type at line 188), the machine extracts `attachments[0]` and stores `attachment.payload.url` as the `responseValue`

### 4. Other Attachment Patterns in translate-typeform

Several other field types use Facebook's attachment API structure:
- **`translatePictureChoice`** (line 139): Creates a generic template with `image_url` from Typeform-hosted URLs (`choice.attachment.href`)
- **`translateWebview`** (line 252): Creates a button template with web_url buttons
- **`translateShare`** (line 198): Creates a button template with element_share button
- **`translateNotify`** (line 219): Creates a one_time_notif_req template

All of these use inline URLs (Typeform-hosted or user-provided). None use pre-uploaded `attachment_id`s.

### 5. Page Token Storage and Retrieval

Page tokens are stored in the `credentials` table:

**Schema** (`/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql`, line 170):
```sql
CREATE TABLE chatroach.credentials(
  userid UUID NOT NULL REFERENCES users(id),
  entity VARCHAR NOT NULL,
  key VARCHAR NOT NULL,
  created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  details JSONB NOT NULL,
  facebook_page_id VARCHAR AS (
    CASE WHEN entity = 'facebook_page'
    THEN details->>'id' ELSE NULL END
  ) STORED,
  UNIQUE(entity, key),
  INDEX (userid, entity, key, created desc) STORING (details),
  INDEX (facebook_page_id) STORING (details, key, userid),
  CONSTRAINT unique_facebook_page UNIQUE(facebook_page_id)
);
```

**Retrieval** (`/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/tokenstore.js`):
```sql
SELECT details->>'access_token' AS token
FROM credentials
WHERE facebook_page_id = $1
ORDER BY created DESC LIMIT 1
```

**Entity types in use**: `facebook_page` (page access tokens), `typeform_token`, `facebook_ad_user`

### 6. Google Cloud Storage Patterns

The exporter service (`/home/nandan/Documents/vlab-research/fly/exporter/exporter/storage.py`) has a pluggable storage backend:
- `STORAGE_BACKEND` env var selects backend: `google` or `s3`
- **GoogleStorageBackend**: Uses `google.cloud.storage` client, reads `GOOGLE_STORAGE_BUCKET` env var
- **S3StorageBackend**: Uses Minio client, supports presigned URL generation with 7-hour expiry (`generate_link()`)
- Currently used only for CSV export files, not media/images
- Only the S3 backend has `generate_link()` -- Google backend does not generate download URLs

### 7. The `adopt` Package

There is **no `adopt` Python package in this repository**. However:
- An `adopt_reports` table exists in the database schema (`01-init.sql`, line 221)
- A database user `adopt` exists with SELECT permissions on responses, credentials, surveys, campaigns, and campaign_confs
- The `adopt` package likely lives in a **separate repository** and connects to the same database
- References to `adopt.*` imports in notebooks would be from that external package

### 8. Capability Gap Summary

| Capability | Status | Location |
|---|---|---|
| Send attachment by URL | Exists | translate-typeform `translateAttachment` |
| Send attachment by `attachment_id` | Code path exists, never used | translate-typeform `translateAttachment` |
| Upload media to Facebook (`message_attachments` API) | **Does not exist** | Nowhere in codebase |
| Receive media from users | Exists | replybot machine.js `MEDIA` handler |
| Upload to GCS | Exists (CSV only) | exporter/storage.py |
| Upload to S3/Minio | Exists (CSV only) | exporter/storage.py |
| Media management UI | **Does not exist** | -- |

### 9. Patterns to Follow for New Facebook API Calls

When implementing Facebook media upload (`POST /me/message_attachments`):
- **HTTP client**: Use `r2` (used consistently across replybot and dashboard-server)
- **Auth**: Use `Authorization: Bearer ${pageToken}` header (replybot pattern) or `?access_token=${token}` query param (dashboard-server pattern). Header-based auth is the more modern approach.
- **Token retrieval**: Query `credentials` table where `entity = 'facebook_page'`, extract `details->>'access_token'`
- **Error handling**: Wrap in retry logic with exponential backoff (replybot messenger pattern)
- **Graph API version**: Current code uses v8.0 (replybot) and v9.0 (dashboard-server). New code should use a newer version.
- **Storage**: If storing uploaded media metadata (attachment_id mapping), follow the JSONB pattern used in the credentials table

---

## Dashboard Server Architecture

### Overview

The dashboard-server is an Express.js application running on Node 14, listening on port 3000. It serves as the backend API for the dashboard-client SPA. It connects to CockroachDB (the `chatroach` database on port 26257) and uses Cube.js for analytics aggregation.

**Entry point**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/index.js` -- creates the Express app and initializes Cube.js, then starts an HTTP server on port 3000.

**Server setup**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/server.js` -- configures Express middleware stack:
1. `morgan('tiny')` -- request logging
2. `cors({ exposedHeaders: ['Content-Disposition'] })` -- CORS with exposed headers for file downloads
3. `express.json()` -- body parsing (JSON only, no multipart)
4. Auth middleware on all `/api/v1/*` routes
5. Health check at `/health`
6. 404 handler
7. UnauthorizedError handler

### 1. Facebook Page Credentials -- How Tokens Are Stored and Accessed

#### Storage Schema (CockroachDB `chatroach.credentials` table)

**File**: `/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql`, lines 170-182

```sql
CREATE TABLE chatroach.credentials(
  userid UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity VARCHAR NOT NULL,           -- e.g., 'facebook_page', 'typeform_token', 'facebook_ad_user'
  key VARCHAR NOT NULL,              -- for facebook_page: the page ID
  created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  details JSONB NOT NULL,            -- for facebook_page: {"name": "...", "id": "...", "access_token": "..."}
  facebook_page_id VARCHAR AS (
    CASE WHEN entity = 'facebook_page' THEN details->>'id' ELSE NULL END
  ) STORED,                          -- computed column: extracts page ID from JSONB for indexing
  UNIQUE(entity, key),
  INDEX (facebook_page_id) STORING (details, key, userid),
  CONSTRAINT unique_facebook_page UNIQUE(facebook_page_id)
);
```

**Key entity types** used in the credentials table:
- `facebook_page` -- page access tokens (details: `{name, id, access_token}`)
- `facebook_ad_user` -- ad account tokens
- `typeform_token` -- Typeform OAuth tokens
- `api_token` -- internal API tokens created via `/auth/api-token`

#### How the Client Stores Page Tokens

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/FacebookPages/FacebookPages.js`, line 123

When a user connects a Facebook page, the client formats the credential as:
```javascript
{ entity: 'facebook_page', key: id, details: { name, id, access_token } }
```
This is then POSTed to `POST /api/v1/credentials` which calls `Credential.create()`.

#### How Tokens Are Retrieved

**Replybot's TokenStore** (`/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/tokenstore.js`):
```sql
SELECT details->>'access_token' AS token
FROM credentials
WHERE facebook_page_id = $1
ORDER BY created DESC LIMIT 1
```
This is the canonical pattern for getting a page token by page ID. The `facebook_page_id` computed column and index make this efficient.

**Dashboard-server's credential queries** (`/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/credentials/credentials.queries.js`):
- `get({email})` -- returns all credentials for a user (JOINs credentials with users on userid=id, filters by email)
- `getOne({email, entity, key})` -- returns a single credential by entity+key for a user
- `create({entity, key, details, email})` -- inserts a new credential
- `update({entity, key, details, email})` -- updates details for an existing credential

**IMPORTANT**: The dashboard-server credential queries always scope by `email` (the authenticated user), ensuring users can only access their own page tokens. To get a page token for a specific page ID, the media upload endpoint would need either:
1. A new query: `getOne({email, entity: 'facebook_page', key: pageId})` -- using the existing `getOne` function since `key` = page ID for `facebook_page` entities
2. OR: A new query that uses the `facebook_page_id` computed column directly (like TokenStore does)

Option 1 is simpler since it uses the existing `getOne` query and enforces email-based authorization.

### 2. Existing API Patterns -- Endpoint Structure

#### Framework and Middleware Stack

- **Framework**: Express.js 4.16.4
- **Body parsing**: `express.json()` only -- no multipart/form-data support currently
- **Auth**: JWT-based via `express-jwt` 5.3.1 (see middleware section below)
- **HTTP client for outbound calls**: `r2` (lightweight fetch wrapper)
- **Logging**: `morgan('tiny')`
- **CORS**: Enabled globally with `Content-Disposition` exposed

#### Route Registration Pattern

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/index.js`

All routes are mounted on the Express router with a resource-based prefix:
```javascript
router
  .use('/responses', require('./responses'))
  .use('/exports', require('./exports'))
  .use('/users', require('./users'))
  .use('/surveys', require('./surveys'))
  .use('/typeform', require('./typeform'))
  .use('/credentials', require('./credentials'))
  .use('/facebook', require('./facebook'))
  .use('/auth', require('./auth/auth.routes'))
  .use('/users/:userId/bails', require('./bails'))
  .use('/surveys/:surveyName/states', require('./states'))
```

All routes live under `/api/v1/` (set via `API_VERSION` config).

#### Adding a New Route (Step-by-Step)

To add a new `/api/v1/media` route, follow the established pattern:

1. **Create route files**:
   - `api/media/index.js` -- re-exports the routes file
   - `api/media/media.routes.js` -- defines routes on an Express Router
   - `api/media/media.controller.js` -- handler functions

2. **Register in `api/index.js`**:
   ```javascript
   .use('/media', require('./media'))
   ```

3. **If new queries are needed**, add `queries/media/` following the pool-binding pattern

#### Controller Pattern

Every controller function follows the same shape:
```javascript
exports.handlerName = async (req, res) => {
  const { email } = req.user;  // always available from JWT auth
  try {
    // ... business logic ...
    return res.status(200).json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).send(e);
  }
};
```

The user's email is always available on `req.user.email` after the auth middleware runs.

### 3. File Upload Handling -- Current State

**There is NO existing file upload capability in dashboard-server.** Specifically:

- **No `multer`** -- not in `package.json`, not used anywhere
- **No multipart body parser** -- only `express.json()` is configured
- **No GCS/S3 client** -- the server has no cloud storage integration (the exporter, a separate Python service, has GCS/S3)
- **No `FormData` processing** -- the `r2` library is used only for outbound HTTP calls, not for parsing incoming multipart

**To add file upload support**, the server needs:
1. A multipart body parser: `multer` (most common for Express) or `busboy`
2. For the media upload use case specifically: the file comes from the client, gets forwarded to Facebook's `message_attachments` API. Options:
   - **Stream-through**: Use multer to receive the file, then forward it to Facebook (avoids storing on disk/cloud)
   - **Store-then-forward**: Save to disk/GCS first, then upload to Facebook
   - Stream-through is simpler and avoids needing a cloud storage client

### 4. Facebook API Integration -- Existing Code

#### Dashboard-Server Facebook Controller

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/facebook/facebook.controller.js`

Three existing endpoints:
1. `POST /facebook/exchange-token` -- exchanges a short-lived token for a long-lived one
   - Uses `r2.get()` to call Facebook's `/oauth/access_token`
   - Takes `{token}` in request body
   - Uses configured `FACEBOOK_GRAPH_URL`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`

2. `POST /facebook/webhooks` -- subscribes a page to messaging webhooks
   - Uses `r2.post()` to call `graph.facebook.com/v9.0/{pageid}/subscribed_apps`
   - Takes `{pageid, token}` in request body (token passed from client)

3. `POST /facebook/get-started` -- sets the "Get Started" button on Messenger
   - Uses `r2.post()` to call `graph.facebook.com/v9.0/me/messenger_profile`
   - Takes `{token}` in request body

**Pattern observations**:
- Page tokens are passed from the client in the request body (not looked up server-side)
- Uses `r2` for HTTP calls (lightweight fetch wrapper, supports `.json` response parsing)
- Error handling: checks `r.error`, returns 400 with Facebook's error object
- Graph API version: hardcoded `v9.0` in webhooks/get-started, configurable via `FACEBOOK_GRAPH_URL` in exchange-token

#### Facebook Utils (Server-Side)

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/utils/facebook/facebook.util.js`

Utility functions for programmatic use (not exposed as endpoints):
- `setGetStarted(token)` -- sets Get Started button
- `subscribe(page)` -- subscribes a page using app-level auth (`fb.id|fb.secret` pseudo-token)

#### Key Observation: Token Handling Pattern

The existing Facebook endpoints take the page token directly from the client request body. For the media upload feature, there are two options:

1. **Client-sends-token pattern** (current): The client already has the page token (it stores it when connecting the page). The client could send the token alongside the file upload.
2. **Server-looks-up-token pattern** (more secure): The client sends only the page ID, and the server looks up the token from the credentials table. This is better because it avoids sending long-lived tokens over the wire from client to server.

**Recommendation**: Use the server-looks-up-token pattern. The client sends `pageId` + file; the server queries `Credential.getOne({email, entity: 'facebook_page', key: pageId})` to get the token, then calls Facebook's API.

### 5. Pages/Studies Relationship

#### How the Server Knows Which Pages Belong to a User

The relationship is indirect, through the `credentials` table:
- `credentials.userid` references `users.id`
- When `entity = 'facebook_page'`, the credential contains the page token
- The dashboard-server always filters by `req.user.email` (via JOIN with users table)

There is **no direct page-to-study relationship** in the schema. Instead:
- A user owns pages (via credentials) and studies/surveys (via surveys.userid)
- Surveys have a `shortcode` that links to states and responses
- States have a `pageid` column linking responses to specific Facebook pages

To get "which pages does this user have?":
```javascript
const creds = await Credential.get({ email });  // returns all credentials
const pages = creds.filter(c => c.entity === 'facebook_page');
```

This is exactly what the dashboard-client does in the `Accounts` page (`/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/Accounts/Accounts.js`, line 12) to display connected pages.

### 6. Database Access Patterns

#### Connection Setup

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/index.js`

- Uses `pg.Pool` (PostgreSQL client) connected to CockroachDB
- Pool configuration comes from `config.DATABASE_CONFIG`
- Auto-discovers query modules by reading subdirectories of `queries/`
- Each module exports `{ name, queries: pool => ({...}) }` and gets registered as `db[name]`
- The pool is also exposed as `db.pool` for direct use

#### Query Module Pattern

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/credentials/credentials.queries.js` (representative example)

```javascript
// Functions use `this` (bound to pool) for queries
async function get({email}) {
  const q = `SELECT ... FROM credentials JOIN users ON userid=id WHERE email = $1`;
  const {rows} = await this.query(q, [email]);
  return rows;
}

// Module exports name and factory
module.exports = {
  name: 'Credential',
  queries: pool => ({
    get: get.bind(pool),
    getOne: getOne.bind(pool),
    create: create.bind(pool),
    update: update.bind(pool),
  }),
};
```

Key aspects:
- Query functions are defined as standalone async functions that use `this.query()` (bound to the pool)
- All queries use parameterized inputs (`$1`, `$2`) for SQL injection protection
- Functions are exported via a factory that binds them to the pool
- The `name` property determines how the module is accessed: `const { Credential } = require('../../queries')`

#### Config and Environment

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/config/index.js`

Config is validated with Joi on startup. Relevant entries for the media upload feature:
- `FACEBOOK.id` -- Facebook App ID
- `FACEBOOK.secret` -- Facebook App Secret
- `FACEBOOK.url` -- Facebook Graph API base URL (e.g., `https://graph.facebook.com/v9.0`)
- `DATABASE_CONFIG` -- CockroachDB connection settings

### 7. Implementation Guidance for Media Upload Endpoint

Based on all findings, the media upload endpoint would:

**New files needed**:
- `api/media/index.js`
- `api/media/media.routes.js`
- `api/media/media.controller.js`

**Dependencies to add** (to `package.json`):
- `multer` -- for parsing multipart/form-data file uploads

**Endpoint design**:
```
POST /api/v1/media/upload
Content-Type: multipart/form-data

Fields:
  - pageId: string (Facebook page ID)
  - file: binary (the media file)

Response:
  { attachment_id: "12345", type: "image" }
```

**Server-side flow**:
1. Auth middleware validates JWT (automatic on all `/api/v1/*` routes)
2. `multer` parses the multipart upload
3. Controller extracts `pageId` from `req.body`, file from `req.file`
4. Look up page token: `Credential.getOne({email: req.user.email, entity: 'facebook_page', key: pageId})`
5. Verify credential exists and belongs to user (getOne already filters by email)
6. Call Facebook: `POST https://graph.facebook.com/v22.0/me/message_attachments` with the page token and file
7. Return the `attachment_id` from Facebook's response

**Facebook message_attachments API call shape**:
```
POST /me/message_attachments?access_token={PAGE_TOKEN}
Content-Type: multipart/form-data

message={"attachment":{"type":"image","payload":{"is_reusable":true}}}
filedata=@/path/to/file
```

**Graph API version**: Production Helm values show `v22.0` for the linksniffer service (`/home/nandan/Documents/vlab-research/fly/devops/values/production.yaml`, line 529). Dashboard-server config still points to `v9.0`. The new endpoint should use the version from `FACEBOOK_GRAPH_URL` config for consistency, and that config value should be updated to a current version.

### 8. Production vs. Development Database Differences

**NOTE**: The MCP Postgres connection available in this environment connects to a **different database** than the one dashboard-server uses. The MCP database has a simpler `credentials` schema (columns: `user_id`, `entity`, `key`, `created`, `details`, `rowid`, `org_id`) with entity types like `facebook`, `facebook_ad_user`, `fly`, `alchemer`, `qualtrics`. This is likely the "fly" platform database.

The dashboard-server connects to the **CockroachDB `chatroach` database** (port 26257) which has the full schema from `devops/migrations/01-init.sql`, including the `facebook_page_id` computed column and the `facebook_page` entity type.

For local development, the `docker-compose.yml` in dashboard-server sets up CockroachDB and initializes it from `devops/all.sql`.

---

## Existing Storage Infrastructure

### 1. Exporter Storage Backends

**File**: `/home/nandan/Documents/vlab-research/fly/exporter/exporter/storage.py`

The exporter service has a pluggable storage system with three backends, selected by the `STORAGE_BACKEND` environment variable:

| Backend | Env Value | Class | Purpose |
|---------|-----------|-------|---------|
| Base (dev) | *(unset)* | `BaseStorageBackend` | Prints to logs, returns fake link. Development only. |
| Google Cloud Storage | `google` | `GoogleStorageBackend` | Uses `google.cloud.storage` SDK. Reads bucket from `GOOGLE_STORAGE_BUCKET` env var. |
| S3/MinIO | `s3` | `S3StorageBackend` | Uses `minio` Python client. Reads `S3_BUCKET_NAME`, `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_SSL_ENABLED` env vars. |

**Factory function** (line 14):
```python
def get_storage_backend(file_path, **kwargs):
    backend_map = {"google": GoogleStorageBackend, "s3": S3StorageBackend}
    backend = backend_map.get(os.getenv("STORAGE_BACKEND"), BaseStorageBackend)
    return backend(file_path=file_path, **kwargs)
```

**Operations supported by each backend**:

| Operation | Base | GCS | S3/MinIO |
|-----------|------|-----|----------|
| `save_to_csv(df)` | Prints to log | Uploads string to blob | `put_object()` with BytesIO |
| `save_file(path)` | Prints to log | `upload_from_filename()` | `fput_object()` from file path |
| `generate_link()` | Returns fake string | **NOT IMPLEMENTED** (returns base class fake) | Presigned GET URL, 7-hour expiry |

**Critical observation**: The `GoogleStorageBackend` does NOT override `generate_link()`. It inherits the base class version which returns `"Base backend fake link"`. This means **production is using the S3/MinIO backend**, not GCS, for the export download feature to work. (Or GCS exports simply have no download link, which seems unlikely.)

### 2. How the Export Download Flow Works End-to-End

The complete flow from user click to file download:

```
Browser                  Dashboard-Server         Kafka          Exporter           MinIO/S3
  |                           |                    |                |                  |
  |-- POST /exports --------->|                    |                |                  |
  |                           |-- INSERT row ----->| (export_status table, status=Started)
  |                           |-- Kafka msg ------>|                |                  |
  |<-- 201 {export_id} -------|                    |                |                  |
  |                           |                    |-- consume ---->|                  |
  |                           |                    |                |-- save_to_csv -->|
  |                           |                    |                |-- generate_link->|
  |                           |                    |                |<-- presigned URL-|
  |                           |                    |                |-- UPDATE export_status
  |                           |                    |                |   (status=Finished,
  |                           |                    |                |    export_link=presigned URL)
  |-- GET /exports/status/survey (polls every 4s)  |                |                  |
  |<-- [{status, export_link}]|                    |                |                  |
  |                           |                    |                |                  |
  |-- (user clicks DOWNLOAD) -|-- (direct link) ---------------------------------->|
  |<------- file download ----|------------------------------------------------------|
```

**Key steps in detail**:

1. **Dashboard-server** (`/home/nandan/Documents/vlab-research/fly/dashboard-server/api/exports/exports.controller.js`, line 53): Generates a UUID, inserts a row in `export_status` with status `Started` and `export_link = 'Not Found'`, publishes a Kafka message to `vlab-exports` topic.

2. **Exporter** (`/home/nandan/Documents/vlab-research/fly/exporter/exporter/main.py`, line 85): Kafka consumer picks up the message, calls `export_data()`, `export_chat_log()`, or `export_full_messages()` depending on `source`.

3. **Storage upload** (`/home/nandan/Documents/vlab-research/fly/exporter/exporter/exporter.py`, lines 226-243): Creates storage backend with path like `exports/{survey}.csv`, calls `save_to_csv(df)` or `save_file(tmp_path)`, then `generate_link()` to get a presigned URL.

4. **Status update** (`/home/nandan/Documents/vlab-research/fly/exporter/exporter/exporter.py`, line 246): UPDATEs `export_status` row with status=`Finished` and the presigned URL as `export_link`.

5. **Client polling** (`/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/SurveyScreen/SurveyScreen.js`, line 184): The ExportPanel polls `GET /exports/status/survey` every 4 seconds. While status is `Started`, it shows a spinner. When `Finished`, it renders a download link.

6. **Download** (`/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/SurveyScreen/SurveyScreen.js`, lines 103-107): The `DownloadLink` component renders an `<a href={export_link} target="_blank">DOWNLOAD</a>`. The link goes directly to MinIO/S3 -- the dashboard-server is NOT a proxy for the download. The browser fetches the file directly from the presigned URL.

### 3. MinIO Configuration

**Production** (`/home/nandan/Documents/vlab-research/fly/devops/values/minio.yaml`):
- Console UI: `storage.vlab.digital` (HTTPS, with nginx ingress and cert-manager)
- S3 API: `storage-api.vlab.digital` (HTTPS, proxy body size limit 1000MB)
- Auth: via Kubernetes secret `minio-auth`
- Storage class: `standard-rwo`
- Prometheus monitoring enabled

**Local development** (`/home/nandan/Documents/vlab-research/fly/devops/values/integrations/minio.yaml`):
- Default bucket: `fly`
- Root user: `admin`, password: `4f01f399-179f-43e4-aec4-b6d59d07d026`
- Console hostname: `minio.fly.local`

**Production exporter config** (`/home/nandan/Documents/vlab-research/fly/devops/values/production.yaml`, lines 595-613):
- Exporter runs with 2 replicas
- Image: `vlabresearch/exporter:v0.5.1`
- Env secrets loaded from Kubernetes secret named `exporter` (line 613: `envSecrets: - exporter`)
- The S3/MinIO credentials (`S3_BUCKET_NAME`, `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_SSL_ENABLED`, `STORAGE_BACKEND`) are NOT in the Helm values -- they are in the `exporter` Kubernetes secret

### 4. Can This Storage Be Reused for Media Uploads?

**Short answer: Yes, but it is the wrong approach for this feature.**

**Why MinIO/S3 storage CAN work**:
- MinIO is already deployed and accessible at `storage-api.vlab.digital`
- Presigned URLs can provide public (time-limited) access to files
- The Python `minio` client supports uploading arbitrary files with any content type
- The infrastructure (ingress, TLS, auth) is already configured

**Why MinIO/S3 storage is NOT the right approach for media uploads**:

1. **Facebook's `message_attachments` API accepts direct file uploads** -- the media file needs to go from the browser to Facebook, not to our storage. Storing in MinIO would be an unnecessary intermediate step.

2. **The URL pattern does not match**: Facebook's Send API accepts either a public URL or an `attachment_id`. MinIO presigned URLs expire after 7 hours (configurable). If a media file is uploaded to MinIO and its presigned URL is used in message templates, the URL will expire and all future sends of that template will fail. This is a fundamental mismatch.

3. **The `attachment_id` approach is superior**: Upload the file to Facebook's `message_attachments` API once, get back a permanent `attachment_id`. This ID never expires and can be used indefinitely in message templates. The existing `translateAttachment` code in translate-typeform already supports the `attachment_id` field (line 267 of `replybot/node_modules/@vlab-research/translate-typeform/translate-fields.js`).

4. **The dashboard-server has NO storage client**: Adding MinIO/S3/GCS client to the Node.js dashboard-server would be a significant new dependency. The exporter is Python and already has the clients installed, but it is a Kafka consumer -- not an HTTP API server.

**However, MinIO could be useful as a secondary concern**:
- If a user wants to upload media that is NOT going to Facebook (e.g., a research dataset, a CSV of bail configurations), MinIO is the right backend
- If we wanted to keep a local copy of uploaded media for auditing/backup, MinIO could store a copy alongside the Facebook upload

### 5. Recommended Approach for Media Uploads

The media upload feature should **NOT** reuse the exporter's storage pattern. Instead:

```
Browser                  Dashboard-Server           Facebook Graph API
  |                           |                          |
  |-- POST /media/upload ---->|                          |
  |   (multipart: file,       |                          |
  |    pageId)                |-- lookup page token ----->| (credentials table)
  |                           |                          |
  |                           |-- POST /me/message_attachments -->|
  |                           |   (multipart: file + JSON)       |
  |                           |<-- { attachment_id } ------------|
  |                           |                          |
  |<-- { attachment_id } -----|                          |
```

The file goes: **browser -> dashboard-server -> Facebook**. No intermediate storage needed. The dashboard-server acts as a pass-through proxy that:
1. Authenticates the user (JWT)
2. Looks up the page token (credentials table)
3. Forwards the file to Facebook
4. Returns the `attachment_id`

The `attachment_id` is then stored as part of the form/question metadata and used by translate-typeform's existing `translateAttachment` function when sending messages.

### 6. Summary of Existing Storage Patterns

| Aspect | Export (existing) | Media Upload (proposed) |
|--------|------------------|------------------------|
| Storage target | MinIO/S3 | Facebook `message_attachments` API |
| Upload trigger | Kafka message | HTTP POST from browser |
| Upload performed by | Exporter (Python) | Dashboard-server (Node.js) |
| Download/access | Presigned URL (7hr expiry) | `attachment_id` (permanent) |
| File flow | DB -> exporter -> MinIO -> browser | Browser -> dashboard-server -> Facebook |
| Dashboard-server role | Produces Kafka message | Proxies file to Facebook |
| Existing code reuse | None applicable | `translateAttachment` already handles `attachment_id` |
