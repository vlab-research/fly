# User Lookup Investigation Findings

## Dashboard Server API

### 1. Overall Server Structure

- **Framework**: Express.js (v4), defined in `/home/nandan/Documents/vlab-research/fly/dashboard-server/server.js`
- **Entry point**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/index.js` (also initializes Cube.js)
- **Port**: 3000
- **All API routes** live under `/api/v1` (version from config)
- **Middleware stack** (applied in order): morgan logging, CORS, body-parser (JSON), auth, then router
- **Router**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/index.js`

### 2. Complete API Endpoint Inventory

All endpoints require JWT auth (Auth0 RS256 or HS256 server-to-server) unless noted.

| Method | Route | Controller | Purpose |
|--------|-------|-----------|---------|
| **Responses** | | | |
| GET | `/responses` | response.controller.getAll | List responses |
| GET | `/responses/form-data` | response.controller.getFormDataCSV | Sync CSV export of form data |
| GET | `/responses/csv` | response.controller.getResponsesCSV | Sync CSV export of responses |
| **Exports** | | | |
| POST | `/exports` | exports.controller.generateExport | Trigger async export (Kafka) |
| GET | `/exports/status` | exports.controller.getAll | All export statuses for user |
| GET | `/exports/status/survey` | exports.controller.getBySurvey | Export statuses by survey name |
| **Users** | | | |
| POST | `/users` | users.controller.createUser | Create/upsert dashboard user |
| **Surveys** | | | |
| POST | `/surveys` | survey.controller.postOne | Create survey |
| GET | `/surveys` | survey.controller.getAll | List user's surveys |
| PUT | `/surveys/:surveyid/settings` | survey.controller.putSettings | Update survey settings |
| **Typeform** | | | |
| POST | `/typeform/exchange-token` | typeform.controller.exchangeToken | (unclear, not shown) |
| POST | `/typeform/webhooks` | typeform.controller.addWebhooks | (unclear) |
| POST | `/typeform/get-started` | typeform.controller.addGetStarted | (unclear) |
| **Credentials** | | | |
| POST | `/credentials` | credentials.controller.createCredential | Create credential |
| PUT | `/credentials` | credentials.controller.updateCredential | Update credential |
| GET | `/credentials` | credentials.controller.getCredentials | List credentials |
| **Facebook** | | | |
| POST | `/facebook/exchange-token` | facebook.controller.exchangeToken | Exchange FB token |
| POST | `/facebook/webhooks` | facebook.controller.addWebhooks | Setup webhooks |
| POST | `/facebook/get-started` | facebook.controller.addGetStarted | Setup get-started button |
| **Auth** | | | |
| POST | `/auth/api-token` | auth.routes.createApiToken | Create API token |
| DELETE | `/auth/api-token` | auth.routes.revokeApiToken | Revoke token (stub) |
| **Bails** | | | |
| GET | `/users/:userId/bails` | bails.controller.listBails | List bails |
| POST | `/users/:userId/bails` | bails.controller.createBail | Create bail |
| POST | `/users/:userId/bails/preview` | bails.controller.previewBail | Preview bail |
| GET | `/users/:userId/bails/:bailId` | bails.controller.getBail | Get bail |
| PUT | `/users/:userId/bails/:bailId` | bails.controller.updateBail | Update bail |
| DELETE | `/users/:userId/bails/:bailId` | bails.controller.deleteBail | Delete bail |
| GET | `/users/:userId/bails/:bailId/events` | bails.controller.getBailEvents | Bail events |
| GET | `/users/:userId/bail-events` | bails.controller.getUserEvents | All bail events for user |
| **States** | | | |
| GET | `/surveys/:surveyName/states/summary` | states.controller.getSummary | Aggregated state counts |
| GET | `/surveys/:surveyName/states` | states.controller.listStates | Paginated state list |
| GET | `/surveys/:surveyName/states/:userid` | states.controller.getStateDetail | **Closest to user lookup** |

### 3. Database Connection

- **ORM**: None. Raw SQL queries via `pg` Pool.
- **Database**: CockroachDB (Postgres-compatible)
- **Connection config**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/config/index.js` lines 74-80
  - Test: `root@localhost:5433/chatroach`
  - Production: from env vars `DB_USER`, `DB_HOST`, `DB_PASSWORD`, `DB_DATABASE`, `DB_PORT`
- **Query binding pattern**: Each `queries/<module>/<module>.queries.js` exports `{ name, queries: pool => ({ fn: fn.bind(pool) }) }`. The `queries/index.js` auto-discovers all subdirectories, calls `module.queries(pool)`, and exposes them as `db[module.name]`.
- **Available query modules**: User, Survey, Response, Credential, Exports, States

### 4. Existing User/Participant Lookup Endpoints

**There is NO dedicated endpoint for looking up a participant by page-scoped user ID (PSID).**

The closest existing endpoint is:

**`GET /api/v1/surveys/:surveyName/states/:userid`**
- File: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/states/states.controller.js` line 66
- Query: `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/states/states.queries.js` line 124
- This returns the **state** of a participant (current_state, current_form, error_tag, state_json, etc.)
- It requires knowing the `surveyName` in advance
- It filters by `current_form = ANY(shortcodes)` -- so it only finds the participant if they are currently on one of that survey's forms
- Returns state machine data, NOT user profile/identity data

**Key distinction**: "users" in this codebase has two meanings:
1. **Dashboard users** (`users` table): `{ id: UUID, email: string }` -- these are researchers/admins who log into the dashboard
2. **Participants** (`states` table, `responses` table): identified by `userid` (VARCHAR, the Facebook PSID) and `pageid` (VARCHAR, the Facebook page ID). These are the people taking surveys. There is NO dedicated `participants` table -- participant data lives in `states` and `responses`.

### 5. Authentication/Authorization Patterns

- **Auth middleware**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/middleware/auth.js`
  - Tries Auth0 JWKS (RS256) first, falls back to server JWT (HS256)
  - Sets `req.user` with at minimum `{ email }`
- **Authorization patterns** (three variants):
  1. **Email-based scoping**: Most endpoints filter queries by `req.user.email` (implicit in query joins through `surveys.userid -> users.id`)
  2. **`validateUserAccess`** (bails): Checks `req.user.email` matches `User.user({email})` and that `user.id === req.params.userId`
  3. **`validateSurveyNameAccess`** (states): Loads all surveys for email, filters to matching `survey_name`, collects shortcodes into `req.surveyShortcodes`

### 6. Participant Data Model

The `states` table (schema in `/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql` line 109) is the primary source of participant state:

```sql
CREATE TABLE states(
    userid VARCHAR NOT NULL,           -- Facebook PSID
    pageid VARCHAR NOT NULL,           -- Facebook page ID
    updated TIMESTAMPTZ NOT NULL,
    current_state VARCHAR NOT NULL,    -- e.g., RESPONDING, ERROR, END, WAIT_EXTERNAL_EVENT
    state_json JSON NOT NULL,          -- full state machine JSON
    PRIMARY KEY (userid, pageid),
    -- Many computed columns derived from state_json:
    current_form VARCHAR,              -- shortcode of current form
    error_tag VARCHAR,
    fb_error_code VARCHAR,
    stuck_on_question VARCHAR,
    timeout_date TIMESTAMPTZ,
    next_retry TIMESTAMP,
    payment_error_code VARCHAR,
    form_start_time TIMESTAMPTZ,
    previous_is_followup BOOL,
    previous_with_token BOOL
);
```

The `responses` table also contains per-participant data (their survey answers) keyed by `userid + timestamp + question_ref`.

### 7. Implications for a PSID Lookup Endpoint

To build a "lookup user info by PSID" endpoint, consider:

1. **No survey-name-scoped requirement**: A PSID lookup should work across all surveys the authenticated user owns, not require specifying a survey name upfront.
2. **Data sources**: The `states` table (keyed by `userid, pageid`) is the primary source. The `responses` table could provide historical answer data.
3. **Authorization**: Must verify the PSID belongs to a survey owned by the requesting dashboard user. This means joining through `states.current_form -> surveys.shortcode -> surveys.userid -> users.email`.
4. **Query pattern**: Would follow the existing `queries/<module>` pattern with a new query function bound to the pool.
5. **Route placement**: Could be a new route like `GET /api/v1/participants/:userid` or extend the states API.
6. **The states detail query already does most of the work** -- it just needs the survey-name constraint removed and replaced with a user-email-based authorization check across all owned surveys.

## User Data Storage

### Overview

The system does **not** persistently store Facebook user profile data (first name, last name, full name) in any database table. User profile information is fetched live from the Facebook Graph API at message-processing time, cached briefly in memory, and used ephemerally. The page-scoped user ID (PSID) is the primary identifier for participants across the system.

### Key Terminology

- **userid (VARCHAR)**: In `responses`, `states`, `messages`, `chat_log` tables, this is the Facebook page-scoped user ID (PSID) -- a string like `"123456789"`. This is NOT the `chatroach.users.id` UUID.
- **chatroach.users**: This is the table for *dashboard/admin users* (researchers), not survey participants. It has `id UUID` and `email VARCHAR`.
- **pageid (VARCHAR)**: The Facebook page ID. Present in `states`, `responses`, and `chat_log` tables.

### Database Tables and What They Store

#### `chatroach.users` (admin users only)
- **File**: `/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql` line 34
- Schema: `id UUID, email VARCHAR`
- These are *researchers/dashboard users*, NOT survey participants
- Referenced by `surveys.userid`, `credentials.userid`, `campaigns.userid`

#### `chatroach.states` (participant state)
- **File**: `/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql` line 109
- Primary key: `(userid VARCHAR, pageid VARCHAR)` -- these are PSIDs and page IDs
- `state_json JSON` contains the full state machine state, which includes an `md` (metadata) object
- The `md` object contains fields like `seed`, `form`, `startTime`, `pageid` -- but **no first_name/last_name**

#### `chatroach.responses` (survey answers)
- **File**: `/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql` line 68
- Primary key: `(userid VARCHAR, timestamp, question_ref)`
- `userid` here is the PSID
- `pageid VARCHAR` column also present
- `metadata JSONB` contains metadata from the state machine (seed, form, startTime, pageid, clusterid)
- **No first_name/last_name stored**

#### `chatroach.messages` (raw message content)
- `userid VARCHAR` is the PSID
- Stores raw message content with timestamps

#### `chatroach.chat_log` (conversation replay)
- **File**: `/home/nandan/Documents/vlab-research/fly/devops/migrations/08-chat-log.sql`
- `userid VARCHAR, pageid VARCHAR` -- PSIDs
- Records both bot and user messages
- **No first_name/last_name stored**

#### `chatroach.credentials` (page tokens)
- **File**: `/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql` line 170
- `facebook_page_id VARCHAR` computed column from `details->>'id'`
- `details JSONB` contains credentials including page tokens
- This is how the system looks up Facebook page tokens to make API calls

### How User Profile Data Flows (Ephemeral)

1. **Facebook webhook event arrives** at the botserver with `sender.id` (the PSID) and `recipient.id` (the page ID).

2. **Replybot processes the event** via `Machine.run()` in `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/transition.js`.

3. **`getUserInfo()` is called** in `Machine.actionsResponses()` (line 54 of transition.js):
   ```javascript
   const user = await this.getUser(userId, pageToken)
   ```

4. **`getUserInfo()` calls the Facebook Graph API** at `/home/nandan/Documents/vlab-research/fly/replybot/lib/messenger/index.js` line 44:
   ```javascript
   const url = `${BASE_URL}/${id}?fields=id,name,first_name,last_name`
   ```
   This returns `{ id, name, first_name, last_name }` from Facebook.

5. **The user object is cached briefly in memory** via `Cacheman` with a TTL (default 60 minutes, configured by `REPLYBOT_MACHINE_TTL`). The cache key is `user:<psid>`.

6. **The user object is used for**:
   - **Template interpolation** in survey questions: In `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/form.js` line 42-59, `getFromMetadata()` merges `user` fields with `md` fields. Survey questions can reference `{{hidden:first_name}}` or `{{hidden:last_name}}` via Mustache templates.
   - **Response validation**: The `user` object is passed to `getField()` which checks `user.id` exists (form.js line 142).
   - **Message recipient**: In `respond()` (machine.js line 819), `ctx.user.id` is used as the recipient ID for outgoing messages.

7. **The user object is NOT written to any database**. The `responseVals()` function in `/home/nandan/Documents/vlab-research/fly/replybot/lib/responses/responser.js` line 7 takes `user` as a parameter but only uses `user.id` (the PSID) for the `userid` field in responses.

8. **If Facebook API fails**, the fallback is `{ id, name: '_', first_name: '_', last_name: '_' }` (messenger/index.js line 55). There is a TODO comment: "we should be removing getUserInfo anyways."

### The `facebot` Mock

The `/home/nandan/Documents/vlab-research/fly/facebot/` directory is a **test mock** of the Facebook Graph API, not a production component. Its `users.js` returns a hardcoded user:
```javascript
{ name: 'Leonardo Di Vittorio', first_name: 'Leonardo', last_name: 'Di Vittorio', id: <requested_id> }
```
This is used in integration tests to simulate the Facebook API's user info endpoint.

### How to Map PSIDs to Names

There is **no existing database table or stored mapping** from PSIDs to first/last names. To look up a participant's name given their PSID, you would need to:

1. **Call the Facebook Graph API** directly: `GET /<psid>?fields=id,name,first_name,last_name` with the appropriate page token.
2. **Get the page token** from the `chatroach.credentials` table where `entity = 'facebook_page'` and `facebook_page_id = <the_page_id>`.
3. Note that Facebook may restrict access to user profile information depending on the platform version and permissions granted.

### Historical Note: Removed Tables

The original schema in `/home/nandan/Documents/vlab-research/fly/devops/all.sql` included:
- `chatroach.facebook_pages(pageid, userid, token, instagramid)` -- this mapped page IDs to admin user IDs and stored page tokens
- `chatroach.timeouts(userid, pageid, timeout_date, fulfilled)` -- tracked timeout states

Both were **dropped** (all.sql lines 228-229) and their functionality was replaced:
- Page tokens moved to `chatroach.credentials`
- Timeouts moved to computed columns on `chatroach.states`

### Summary Table

| Data | Stored Where | Persistent? |
|------|-------------|-------------|
| PSID (page-scoped user ID) | `responses.userid`, `states.userid`, `messages.userid`, `chat_log.userid` | Yes |
| Page ID | `responses.pageid`, `states.pageid`, `chat_log.pageid`, `credentials.facebook_page_id` | Yes |
| first_name, last_name, name | In-memory cache only (fetched from Facebook API) | No |
| Dashboard user email | `users.email` | Yes |
| Page tokens | `credentials.details` JSONB | Yes |

### Implications

- **User profile lookup requires a live Facebook API call** -- there is no offline lookup capability.
- **The system is designed around PSIDs** as opaque identifiers. User "identity" is the PSID+pageid pair.
- **If Facebook deprecates or restricts the user profile API** (which the TODO in messenger/index.js hints at), the system would need a new approach. The fallback already returns `'_'` for all name fields.
- **For any feature requiring participant name display**, a new persistent storage mechanism would need to be built, or the Facebook API must be called on demand.

## Dashboard Client Architecture

### Tech Stack Summary

- **Framework**: React 16.13.1 (class-free, all functional components with hooks)
- **Routing**: react-router-dom 5.2.0 with `history` package (BrowserRouter pattern)
- **UI Library**: Ant Design 4.8.6 (dominant -- used in 25+ files)
- **Styling**: CSS files, styled-components 4.4.1 (3 files), inline styles
- **State Management**: Local component state only (`useState`/`useEffect`). No Redux, no Context API for global state (one `Survey` context in `Surveys.js` for sidebar refresh, not a general pattern)
- **HTTP Client**: Native `fetch` API wrapped in custom `fetcher()` function
- **Build**: Create React App (react-scripts 2.1.8, not ejected)
- **Deployment**: Netlify (SPA fallback to index.html)
- **Language**: JavaScript (no TypeScript)
- **Auth**: Auth0 via singleton class

### Project Structure

```
src/
  index.js              -- ReactDOM.render entry point
  root.js               -- Top-level Router with all route definitions
  components/           -- Reusable presentational components
    PrivateRoute/       -- Auth-gated route wrapper
    Navbar/             -- Top navigation (Home, Surveys, Bails, Login/Logout)
    UI/                 -- Styled utility components (Loading, CreateBtn, PrimaryBtn, etc.)
    Spinner/            -- Auth callback loading spinner
    ...                 -- Charts, modals, form builders
  containers/           -- Feature-level pages/screens with business logic
    App/                -- Entry point after auth; POSTs to /users to ensure user exists
    Accounts/           -- Home page; lists connected accounts
    Surveys/            -- Survey list page with sidebar; routes to SurveyScreen
    SurveyScreen/       -- Per-survey tabbed view (Edit | Monitor | Export)
    StatesExplorer/     -- Participant state monitoring (Summary, List, Detail views)
    BailSystems/        -- Bail system CRUD
    CreateExport/       -- Export creation forms
    ...
  services/
    api/                -- API client layer (fetcher.js, startExport.js, etc.)
    auth/               -- Auth0 singleton
    hooks/              -- Custom hooks (useMountFetch)
    history/            -- Browser history singleton
    cube/               -- Cube.js analytics client
    typeform/           -- Typeform OAuth config
  helpers/              -- Utility functions (groupBy, argument validation)
```

### Routing Architecture

All routes defined in `src/root.js` (lines 26-56). Authenticated routes use `<PrivateRoute>` which:
1. Checks `auth.isAuthenticated()` (token expiry check)
2. If not authenticated and not renewing, redirects to `/login`
3. Wraps content in `<Header>` with `<Navbar>` + `<Content>`

**Complete route map**:
```
/                              -- App -> Accounts (home/connected accounts)
/surveys/:survey?              -- Surveys (sidebar list + survey screens)
  /surveys/:survey/edit        -- Survey form list (Edit tab)
  /surveys/:survey/edit/form/:surveyid -- FormScreen (individual form config)
  /surveys/:survey/monitor     -- StatesSummary (Monitor tab, Summary sub-tab)
  /surveys/:survey/monitor/list -- StatesList (Monitor tab, Respondents sub-tab)
  /surveys/:survey/monitor/:userid -- StateDetail (individual participant)
  /surveys/:survey/export      -- ExportPanel
/bails                         -- BailSystems list
/bails/create                  -- BailForm (create)
/bails/:bailId/edit            -- BailForm (edit)
/bails/:bailId/events          -- BailEvents
/exports/create                -- CreateExport (responses)
/exports/create-chat-log       -- CreateChatLogExport
/exports/create-full-messages  -- CreateFullMessagesExport
/connect/facebook-messenger    -- FacebookPages
/connect/reloadly              -- Reloadly
/connect/secrets               -- Secrets
/connect/api-keys              -- ApiKeys
/surveys/auth                  -- TypeformCreateAuth
/login                         -- LoginScreen (public)
/auth                          -- Auth0 callback handler (public)
```

### API Client Layer

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/services/api/fetcher.js`

```javascript
async function fetcher({ path, method = 'GET', headers = {}, body, raw = false, wrapper = wrapApiResponse }) {
  const URL = `${process.env.REACT_APP_SERVER_URL}/api/v1${path}`;
  const TOKEN = auth.getIdToken();
  // Sets Authorization: Bearer <token>, Content-Type for POST/PUT, JSON.stringify(body)
}
```

- **Base URL**: `REACT_APP_SERVER_URL` env var + `/api/v1` prefix
- **Auth**: Auth0 `idToken` sent as Bearer token on every request
- **Error handling**: `wrapApiResponse()` throws on non-OK responses; callers catch and typically call `message.error()` (Ant Design toast)
- **No retry logic, no request cancellation, no caching**
- **Body serialization**: Automatic `JSON.stringify` for POST/PUT bodies

**Custom hook**: `useMountFetch(fetchOpts, initialState)` in `src/services/hooks/useMountFetch.js` -- fires a single GET on mount, returns `[state, setState]`. Used for simple data loading (accounts list, surveys list).

### Existing Search/Lookup UI Patterns

#### StatesList -- Best Reference for User Lookup

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/StatesExplorer/StatesList.js` (274 lines)

This is the **most relevant prior art** for a user lookup feature. It implements:

1. **Filter bar** (lines 186-242): Ant Design `Card` with `Row`/`Col` grid containing:
   - `Select` with `allowClear` for state filter (dropdown with options for each state value)
   - `Input` with `SearchOutlined` prefix and `allowClear` for error tag filter
   - `Input` with `SearchOutlined` prefix and `allowClear` for user ID search (**partial LIKE match**)
   - `Button` with `ReloadOutlined` icon for reset

2. **URL query param reading** (lines 23-31): Reads initial filters from `location.search` via `URLSearchParams` on mount. Used for drill-down from Summary view. Does NOT write filters back to URL on change (one-directional: URL -> state on mount only).

3. **Server-side pagination** (lines 36-39, 79-84): `limit`/`offset` params sent to API. Ant Design `Table` pagination config with `showSizeChanger`, `showTotal`, and `pageSizeOptions`.

4. **Data loading pattern** (lines 41-72):
   ```javascript
   useEffect(() => { loadStates(); }, [surveyName, filters, pagination.current, pagination.pageSize]);

   const loadStates = async () => {
     setLoading(true);
     try {
       const params = new URLSearchParams();
       // build query string from filters
       const res = await api.fetcher({ path: `/surveys/${encodeURIComponent(surveyName)}/states?${params.toString()}` });
       const data = await res.json();
       setStates(data.states || []);
       setTotal(data.total || 0);
     } catch (err) {
       message.error('Failed to load states list');
     } finally {
       setLoading(false);
     }
   };
   ```

5. **Result table** (lines 244-264): Ant Design `Table` with clickable rows navigating to StateDetail. `rowKey="userid"`, `scroll={{ x: 1200 }}`.

6. **Color-coded Tags** (lines 104-114): `stateColors` mapping used for state `Tag` rendering.

#### StateDetail -- Detail View Pattern

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/StatesExplorer/StateDetail.js` (293 lines)

Shows detailed state for one participant:
- Reads `userid` from `useParams()` (line 3, 24)
- API: `GET /api/v1/surveys/{surveyName}/states/{userid}` (line 35)
- Layout: `Descriptions` (bordered, 2 columns) for key-value data, `Table` for QA transcript, `Collapse` for raw JSON, conditional `Card` sections for error/wait details
- Back button navigates to StatesList (line 109-115)
- Loading state with `<Loading>` component (line 47)
- Not-found state with `<Alert>` component (lines 49-62)

#### BailForm -- Form Input Pattern

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/BailSystems/BailForm.js` (366 lines)

Uses Ant Design `Form` component:
- `Form.useForm()` hook for programmatic form control
- `Form.Item` with `rules` for validation
- Card-based form sections
- `onFinish` handler for async submission
- Loading states with `Spin` wrapper
- `message.success()` / `message.error()` for feedback

### Authentication Flow for API Calls

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/services/auth/auth.js` (94 lines)

1. Auth0 WebAuth configured as singleton class, exported as `new Auth()`
2. On page load, if `localStorage.isLoggedIn` is set, calls `renewSession()` (silent auth via iframe)
3. Tokens stored as instance properties: `this.idToken`, `this.accessToken`, `this.expiresAt`
4. `isAuthenticated()` returns `new Date().getTime() < this.expiresAt`
5. `getIdToken()` called by `fetcher()` on every request to set `Authorization: Bearer {token}`
6. `getUserEmail()` returns `this.userEmail` (from `idTokenPayload.email`)
7. Server-side: Express middleware decodes JWT, extracts `req.user.email`, scopes all queries to that email

### Navigation Structure

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/Navbar/Navbar.js` (33 lines)

Current top-level navigation items (Ant Design `Menu` in horizontal mode):
- Home (`/`)
- Surveys (`/surveys`)
- Bails (`/bails`)
- Login/Logout button (right-aligned)

Adding a "User Lookup" feature would require adding a new `Menu.Item` here.

### Gap Analysis: What's Needed for User Lookup

#### What exists today (within a survey):
- **StatesList** already has a "Search by user ID" `Input` that does `LIKE %search%` on userid, within a specific survey's shortcodes
- **StateDetail** shows full participant state including QA transcript, error details, and raw JSON
- Both require the user to first navigate to a specific survey via the sidebar

#### What's missing for a cross-survey user lookup:
1. **Backend endpoint**: No API to search for a userid across ALL surveys the user owns. Current states API requires `surveyName` in the URL path. A new endpoint (e.g., `GET /api/v1/states/lookup?userid=X`) is needed.
2. **Frontend page**: No standalone "User Lookup" page exists. Needs a new container and route.
3. **Navigation**: Navbar needs a new menu item.

#### Implementation approach informed by existing patterns:

**Option A: Survey-scoped lookup (zero backend changes)**
- Enhance existing StatesList with a more prominent search experience
- User must first select a survey, then search within it
- Pro: No backend changes. Con: User must know which survey to look in.

**Option B: Cross-survey lookup (new endpoint + new page)**
- New backend endpoint queries states table across all shortcodes the user owns
- New frontend page at `/lookup` with a search input
- Results table shows: userid, pageid, current_state, current_form, survey_name, updated
- Clicking a result navigates to the existing StateDetail page
- Pro: Find any participant by PSID regardless of survey. Con: Requires backend work.

#### Files to modify/create for Option B:

| Purpose | File | Action |
|---------|------|--------|
| Route definition | `src/root.js` (line 29-53) | Add `<PrivateRoute path="/lookup" ...>` |
| Nav link | `src/components/Navbar/Navbar.js` (lines 14-19) | Add "User Lookup" `Menu.Item` |
| New container | `src/containers/UserLookup/UserLookup.js` | Create (follow StatesList pattern) |
| New container index | `src/containers/UserLookup/index.js` | Create |
| Register export | `src/containers/index.js` | Add `UserLookup` export |
| API fetcher | `src/services/api/fetcher.js` | No changes needed (reuse as-is) |
| Backend route | `dashboard-server/api/states/states.routes.js` | Add cross-survey lookup route |
| Backend query | `dashboard-server/queries/states/states.queries.js` | Add `lookupByUserid()` function |
| Backend controller | `dashboard-server/api/states/states.controller.js` | Add `lookupUser` handler |

#### UI pattern to follow (from StatesList):

```javascript
// Search input
<Input
  allowClear
  placeholder="Enter page-scoped user ID (PSID)"
  value={searchValue}
  onChange={(e) => setSearchValue(e.target.value)}
  onPressEnter={handleSearch}
  prefix={<SearchOutlined />}
/>

// Results table with clickable rows
<Table
  columns={columns}
  dataSource={results}
  rowKey={(record) => `${record.userid}-${record.pageid}`}
  loading={loading}
  pagination={{ ... }}
  onRow={(record) => ({ onClick: () => handleRowClick(record), style: { cursor: 'pointer' } })}
/>

// Color-coded state tags
<Tag color={stateColors[state] || 'default'}>{state}</Tag>
```

- Use `api.fetcher()` for API calls
- Use `encodeURIComponent()` for URL params
- Use `message.error()` for error feedback
- Use `<Loading>` component from `src/components/UI` for loading states
