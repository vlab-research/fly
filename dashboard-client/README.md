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