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
- Only 1 test file exists: `src/containers/App/App.test.js` (smoke test)
- No @testing-library/react or enzyme installed
- Test coverage is effectively zero

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
- **StatesExplorer** — participant state debugging (where participants are in survey flow, error tracking)
  - **StatesSummary** — aggregated state counts per form and state
  - **StatesList** — filterable list of all participants with their current states
  - **StateDetail** — detailed view of a single participant's state including QA transcript and error details

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
