# Dashboard Client
React app to render info report.

## Local Development Setup

### Prerequisites
- Node.js (currently no version pinned — `.nvmrc` planned for Node 18)
- npm (project uses npm, not yarn)

### Environment Variables

The app uses `REACT_APP_*` environment variables. Required variables (configured in `.env`, `.env-dev`, and `netlify.toml`):

| Variable | Purpose |
|----------|---------|
| `REACT_APP_AUTH0_DOMAIN` | Auth0 tenant domain |
| `REACT_APP_AUTH0_CLIENT_ID` | Auth0 application client ID |
| `REACT_APP_AUTH0_CALLBACK_URL` | Auth0 callback URL after login |
| `REACT_APP_SERVER_URL` | Backend API base URL |
| `REACT_APP_URL` | Frontend app URL |
| `REACT_APP_TYPEFORM_CLIENT_ID` | Typeform OAuth client ID |
| `REACT_APP_TYPEFORM_AUTH_URL` | Typeform OAuth URL |
| `REACT_APP_TYPEFORM_REDIRECT_URL` | Typeform OAuth redirect URL |
| `REACT_APP_FACEBOOK_APP_ID` | Facebook app ID for page management |
| `REACT_APP_FACEBOOK_GRAPH_VERSION` | Facebook Graph API version |

### Running Locally

```bash
cd dashboard-client
npm install
npm start   # Starts dev server with HTTPS on localhost:3000
```

The start script sources `.env` and enables HTTPS: `HTTPS=true env $(cat .env | xargs) react-scripts start`.

### Build

```bash
npm run build   # Production build via react-scripts (output in build/)
npm run lint     # ESLint
npm test         # Jest (via react-scripts test)
```

### Deployment

Deployed via **Netlify** (see `netlify.toml`):
- SPA fallback: all routes redirect to `/index.html`
- Environment variables configured per Netlify context (production, staging)
- Domain: `fly.vlab.digital` (redirected from `app.vlab.digital`)

## Build System

- **Build tool**: Create React App (react-scripts) — NOT ejected
- **Bundler**: Webpack (bundled inside react-scripts)
- **Transpiler**: Babel (bundled inside react-scripts)
- **Test runner**: Jest (bundled inside react-scripts)
- **Linter**: ESLint with custom `.eslintrc.js`

Current versions (as of 2026-02-08):
- react-scripts 2.1.8 (internally bundles webpack 4.28.3, @babel/core 7.2.2, jest 23.6.0)
- React 16.13.1
- antd 4.8.6
- react-router-dom 5.2.0
- styled-components 4.4.1

## Testing

- Framework: Jest (via react-scripts)
- No @testing-library/react or enzyme installed, so **nothing renders in tests**
- The established shape is therefore: extract the logic into a pure module next
  to the container, and test that module. `StatesExplorer/healthNav.test.js` and
  `Media/format.test.js` both follow it
- Test files: `containers/App/App.test.js` (smoke),
  `containers/StatesExplorer/healthNav.test.js`, `containers/Media/format.test.js`
- Coverage is otherwise low; containers themselves are untested

## Authentication

Auth0 is implemented as a **singleton class** in `src/services/auth/auth.js`:
- Exported as `new Auth()` — imported directly by components
- NOT a React context/provider pattern
- Stores tokens as instance properties
- Uses the `history` package for navigation after auth events
- `PrivateRoute` component gates authenticated routes by checking `auth.isAuthenticated()`

## Styling

Three styling approaches coexist:
1. **CSS files** — 18 plain CSS files imported directly into components
2. **Ant Design** — dominant UI framework, used in 25+ files
3. **styled-components** — used in 3 files (`UI/index.js`, `ConditionBuilder.js`, `LinkModal/style.js`), uses `styled-components/macro` for build-time optimization
4. **Inline styles** — occasional use

## Architecture Overview

Dashboard Client is a **React single-page application** deployed on **Netlify**. It provides a web interface for researchers to manage surveys, view response data, and monitor survey health.

### Project Structure

```
src/
  components/       # Reusable UI components (buttons, tables, layout, etc.)
  containers/       # Feature-level components (pages/screens with business logic)
  services/
    api/            # API client — standard fetcher with Auth0 Bearer token
    auth/           # Auth0 integration and session management
    cube/           # Cube.js client for analytics queries
```

**Container pattern**: Feature components live in `src/containers/` and compose reusable pieces from `src/components/`. Containers typically handle data fetching, state management, and business logic, while components handle presentation.

### Key Containers

- **Data** — main data exploration view
- **SurveyScreen** — individual survey management (includes routing to form details and states explorer)
- **AnswersReport** — response/answer analytics
- **TopQuestionsReport** — question-level analytics
- **DurationReport** — survey duration/timing analytics
- **BailSystems** — bail-out monitoring (participants who abandon surveys)
- **Media** — the media library: upload a file, get a permanent URL to paste into a survey. See "Media library" below
- **MessageTemplates** — creates/manages utility message templates per `(account_id, name, language)` for out-of-window sends, on **both** Messenger pages and WhatsApp numbers (`accounts.js` merges the two). Listed name-first, since a survey field names a template but not a platform, so one name is normally registered once per account with independent statuses. **Duplicate** (`/message-templates/new?duplicate=<id>`) pre-fills body and buttons from an existing registration so placeholder and button shape stays in agreement across accounts. See `documentation/utility-messages.md` (Messenger) and `documentation/whatsapp-templates.md` (WhatsApp, and the cross-platform model)
- **Tickets** — support inbox UI (split list/detail layout with open/closed tabs, Markdown-rendered conversations via the shared `src/components/Markdown` component) backed entirely by Linear (no local storage); see `documentation/tickets.md`
- **StatesExplorer** — participant state debugging (where participants are in survey flow, error tracking)
  - **StatesSummary** — aggregated state counts per form and state, topped by the **HealthCard**
  - **StatesList** — filterable list of all participants with their current states
  - **StateDetail** — detailed view of a single participant's state including QA transcript and error details

### Media Library

`containers/Media/` — a researcher uploads a file and gets back a permanent
public URL to paste into their survey. See `planning/media-abstraction.md` §3
for the model and `documentation/media.md` once written.

API consumed (`dashboard-server/api/media`):

| Call | Result |
|---|---|
| `POST /media/upload` (multipart, field `file`) | `201` with the new asset; **`200` with the existing asset** on a dedupe hit (`UNIQUE (userid, content_hash)`) |
| `GET /media` | the caller's assets, newest first |
| `DELETE /media/:id` | `204`; `404` if not the caller's |

Asset shape: `{id, filename, mediaType, mimeType, byteSize, created, url}`. The
field is **`url`** — §3's prose says `public_url`, but the implementation emits
`url` and the implementation wins. `url` is derived server-side from
`MEDIA_PUBLIC_BASE` and is never stored.

**Three deliberate absences.** Each one is a thing a reasonable person would add
back, so each is written down:

1. **No account/page selector.** Asset creation is platform-independent (§3), so
   there is no account for the author to choose and no connected-page
   requirement — upload works with zero connected accounts. This page previously
   called `GET /media/pages`, which was deleted server-side along with the
   concept; the page 404'd on load until this rewrite. (`MessageTemplates/accounts.js`
   was the endpoint's only other caller and now reads `/credentials`.)
2. **No handle state.** No "uploaded to N accounts", no expiry, no platform
   anything. §3: *"Handle state is not shown — it is our problem."* Showing it
   would put platform detail back on the authoring surface, which is what the
   media abstraction exists to remove.
3. **No client-side size or type validation**, and no `accept` filter on the
   dragger. The server owns eligibility (§11.5); a second copy of those rules
   here could only drift out of agreement with it.

**Upload errors are the feature, not the sad path.** §11.5 decided the dashboard
refuses ineligible files rather than transcoding them — no downscaling, no
re-encoding. That is only fair because the server's refusal names both the
problem and the fix ("image is 6.2 MB, maximum is 5.0 MB"; "GIF is not
supported; use JPEG or PNG"). So the client surfaces the server's string
**verbatim**, in a persistent `Alert` inside the upload card rather than a toast
that disappears while the researcher is fixing the file. `parseApiError`
(`Media/format.js`) does the extraction — `services/api/fetcher.js` throws
`new Error(await res.text())`, so the raw response body arrives as `err.message`.
Collapsing that into "upload failed" would break the decision, and there is a
test pinning that it doesn't.

**The capability-URL warning** (§4.6) is a persistent `warning` Alert at the top
of the library card, directly above the URLs it describes — asset URLs are
unguessable but permanently readable by anyone who obtains one, in researcher
terms: *"anyone with the link can view the file, forever; don't upload anything
confidential."* Not a footnote and not dismissible.

**Delete warns about the missing reference count** (§11.6). Nothing checks
whether a live survey references an asset, so deletion silently breaks that
survey's media. The confirmation says so in plain language rather than asking
"are you sure?".

`Media/format.js` holds the pure logic — `formatBytes` (base 1024, one decimal
at MB, matching dashboard-server's error strings so a "6.2 MB" refusal and the
"6.2 MB" row agree), `parseApiError`, `mergeAsset` (replace-by-id, so the 200
dedupe response doesn't duplicate a row) and `isPreviewable`. Tested in
`format.test.js` at the level `StatesExplorer/healthNav.test.js` set: pure
logic and regressions, no rendering.

### Monitor Tab Health Surface

The Monitor tab surfaces survey health findings from
`GET /surveys/:surveyName/health` and platform notices from
`GET /platform/notices` (see `documentation/dashboard-study-health.md` for
the full design). The client is intentionally dumb: findings arrive fully
resolved (message strings, levels, action dests); no thresholds or taxonomy
live client-side.

Three presentation layers, silent by default:

1. **Ambient badge** — amber dot on the Monitor tab label
   (`SurveyScreen.js`) when any finding has `level === 'action'`. Notes and
   platform notices do not light it.
2. **Banners** (`HealthBanners` in `SurveyScreen.js`) — inside the Monitor
   tab, above the sub-tabs, only when firing: blue `info` alerts for
   platform notices; a single amber `warning` alert for study action
   findings (collapsed to "N issues need attention" when more than one).
3. **HealthCard** (`StatesExplorer/HealthCard.js`) — top of
   Monitor → Summary; "✓ No issues in the last 24h" when healthy, otherwise
   `action` findings (prominent) and `note` findings (muted) with links.

Supporting modules: `SurveyScreen/useSurveyHealth.js` (fetch + 60s poll,
mounted at SurveyScreen level so the badge works without entering the tab;
`findings` stays `null` until first load, and failed polls keep the last
known state) and `StatesExplorer/healthNav.js` (pure helpers: badge logic +
`action.dest` → URL mapping; unknown dests render without a link).

### API Client

The API client in `src/services/api/` handles all communication with the dashboard-server backend:

- Automatically attaches the **Auth0 Bearer token** to every request
- Targets `REACT_APP_SERVER_URL/api/v1/{path}` (environment-configured base URL)
- All requests are scoped to the authenticated user on the server side
- **URL encoding**: When survey names are used in URL paths, they must be encoded with `encodeURIComponent()` to handle special characters

### Component Patterns

#### Container Data Fetching Pattern

Containers follow a consistent pattern for fetching data from the backend:

```javascript
const [data, setData] = useState(null);
const [loading, setLoading] = useState(true);

useEffect(() => {
  loadData();
}, [dependency]);

const loadData = async () => {
  try {
    const res = await api.fetcher({ path: `/endpoint` });
    const data = await res.json();
    setData(data.field);
  } catch (err) {
    message.error('Failed to load data');
    console.error(err);
  } finally {
    setLoading(false);
  }
};
```

#### Ant Design Component Usage

Common patterns for Ant Design components:

- **Card** — wrapper for distinct UI sections with optional title
- **Table** — data tables with built-in sorting, filtering, and pagination
- **Tag** — color-coded labels for categorical data (states, statuses, etc.)
- **Statistic** — large numerical displays for key metrics
- **message** — toast notifications for user feedback
- **Descriptions** — key-value display with labels (use `bordered` and `column` props)
- **Collapse/Panel** — expandable sections for optional/verbose content
- **Alert** — warnings and error messages with icons

### ConditionBuilder (Bail Conditions UI)

The `ConditionBuilder` component (`src/components/ConditionBuilder/ConditionBuilder.js`) provides a recursive tree editor for bail conditions. It supports three logical operators: **AND**, **OR**, and **NOT**.

**NOT operator behavior**:
- NOT takes exactly **one** child condition (simple or compound group).
- When switching from AND/OR to NOT, only the first child is kept; extra children are discarded.
- When switching from NOT to AND/OR, the single child is preserved and the user can add more.
- The "Add Condition" and "Add Group" buttons are hidden when NOT is selected, enforcing the single-child constraint.
- Deleting the only child of a NOT group resets it to a default empty form condition (`{type: 'form', value: ''}`) rather than collapsing the NOT wrapper.
- The JSON structure produced is `{op: "not", vars: [child]}`.
- The backend rejects NOT conditions that wrap `elapsed_time` (directly or transitively). The frontend does not currently block this selection -- the backend validation error is surfaced to the user.

**State color mapping convention** for state machine values:
```javascript
const stateColors = {
  START: 'blue',
  RESPONDING: 'green',
  QOUT: 'cyan',
  END: 'default',
  BLOCKED: 'red',
  ERROR: 'red',
  WAIT_EXTERNAL_EVENT: 'orange',
  USER_BLOCKED: 'volcano',
};
```
