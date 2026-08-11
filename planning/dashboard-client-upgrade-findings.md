# Dashboard Client Upgrade Investigation Findings

**Date**: 2026-02-08
**Scope**: Dependency state, build system, React patterns, upgrade challenges

---

## 1. Package Dependencies (package.json)

### Production Dependencies

| Package | Version | Current Latest (approx) | Severity |
|---------|---------|------------------------|----------|
| `react` | `^16.13.1` | 18.x / 19.x | **CRITICAL** -- 3-4 major versions behind |
| `react-dom` | `^16.13.1` | 18.x / 19.x | **CRITICAL** -- same as react |
| `react-scripts` | `2.1.8` | 5.x | **CRITICAL** -- 3 major versions behind, bundles Babel/Webpack/Jest |
| `react-router-dom` | `^5.2.0` | 6.x / 7.x | **HIGH** -- breaking API changes in v6 |
| `antd` | `^4.8.6` | 5.x | **HIGH** -- v5 dropped Less, new design tokens |
| `@ant-design/icons` | `^4.3.0` | 5.x | **HIGH** -- tracks antd major version |
| `styled-components` | `^4.4.1` | 6.x | **MEDIUM** |
| `auth0-js` | `9.10.1` (pinned) | 9.x (latest patch) | **LOW** -- same major |
| `@cubejs-client/core` | `^0.7.10` | 0.36.x+ | **HIGH** -- many breaking changes across 0.x versions |
| `@cubejs-client/react` | `^0.7.10` | 0.36.x+ | **HIGH** -- same as core |
| `core-js` | `^2.6.11` | 3.x | **MEDIUM** -- v2 is deprecated |
| `history` | `4.9.0` (pinned) | 5.x | **HIGH** -- v5 required by react-router v6 |
| `moment` | `2.24.0` (pinned) | 2.30.x | **MEDIUM** -- deprecated, recommend dayjs/date-fns |
| `prop-types` | `15.7.2` (pinned) | 15.x | **LOW** |
| `recharts` | `1.5.0` (pinned) | 2.x | **MEDIUM** |
| `d3-array` | `^2.4.0` | 3.x | **LOW** |
| `babel-plugin-macros` | `^2.8.0` | 3.x | **LOW** |

### Dev Dependencies

| Package | Version | Current Latest (approx) | Notes |
|---------|---------|------------------------|-------|
| `eslint` | `5.15.3` | 9.x | **CRITICAL** -- 4 major versions behind |
| `eslint-config-airbnb` | `17.1.0` | 19.x | **HIGH** |
| `eslint-plugin-import` | `2.16.0` | 2.29.x | **MEDIUM** |
| `eslint-plugin-jsx-a11y` | `6.2.1` | 6.9.x | **LOW** |
| `eslint-plugin-react` | `7.12.4` | 7.37.x | **MEDIUM** |
| `eslint-plugin-react-hooks` | `1.6.0` | 5.x | **HIGH** |
| `husky` | `1.3.1` | 9.x | **MEDIUM** |

---

## 2. Build Configuration

### Build Tool: react-scripts 2.1.8 (Create React App)

The project uses **Create React App (CRA)** via `react-scripts 2.1.8`. NOT ejected -- no custom webpack, babel, or postcss config. Everything encapsulated inside react-scripts.

**What react-scripts 2.1.8 bundles internally** (from package-lock.json):
- `@babel/core` 7.2.2
- `babel-loader` 8.0.5
- `webpack` 4.28.3
- `webpack-dev-server` 3.1.14
- `jest` 23.6.0
- `babel-jest` 23.6.0

**No custom configuration files** for webpack, babel, postcss, or TypeScript.

### ESLint Configuration (.eslintrc.js)

- **Parser**: `babel-eslint` (deprecated, should be `@babel/eslint-parser`)
- **Extends**: `airbnb`, `plugin:react/recommended`
- **React version hardcoded**: `16.8.5` -- should be `detect`
- **Plugins**: `react-hooks`

### Netlify Deployment

- Deploys to Netlify (netlify.toml present)
- SPA fallback configured
- Environment variables set per context

---

## 3. React Usage Patterns

### Component Style: 100% Functional Components
- **Zero class components** -- no migration needed
- **Hooks widely used** -- useState, useEffect, useCallback, useMemo, useRef, useContext across ~20 files

### Deprecated React APIs
- `ReactDOM.render` -- **FOUND in 2 locations** (index.js, App.test.js) -- must migrate to `createRoot` for React 18+
- No other deprecated lifecycle methods found

### PropTypes
- **28 files** use PropTypes from the `prop-types` package
- Enforced by ESLint rule

### React Router v5 Usage (22 files -- LARGEST migration effort)

v5 APIs in use that change in v6:
- `Switch` (-> `Routes`)
- `Route` with `render`/`component` props (-> `element` prop)
- `useHistory()` (-> `useNavigate()`) -- 9+ files
- `useRouteMatch()` (removed in v6) -- 3 files
- `Redirect` (-> `Navigate`)
- `Router` with `history` prop (-> `BrowserRouter`)
- `exact` prop (default in v6)

### Styling: Mixed approach
1. **CSS files** -- 18 plain CSS files
2. **Ant Design** -- 25 files import from `antd` (dominant UI framework)
3. **styled-components** -- 3 files, uses `styled-components/macro`
4. **Inline styles** -- occasional

### Auth: Singleton class pattern
- Auth0 implemented as exported singleton (`new Auth()`)
- Coupled to `history` package for navigation

---

## 4. Lock File and Package Manager

- **npm** (package-lock.json, lockfileVersion 1)
- **node_modules**: Last modified June 2021 (very stale)
- **No .nvmrc or engines field** -- Node version unspecified

---

## 5. Test Setup

- **Jest 23.6.0** via react-scripts (internal)
- **Only 1 test file**: App.test.js (trivial smoke test)
- **No testing-library/react, no enzyme**
- **Effectively zero test coverage**

---

## 6. Upgrade Risk Assessment

### Tier 1: CRITICAL (tightly coupled)
1. **react-scripts 2 -> 5 (or migrate to Vite)** -- CRA is effectively abandoned upstream
2. **React 16 -> 18** -- low friction (only 2 ReactDOM.render calls, no class components)
3. **react-router-dom 5 -> 6** -- LARGEST effort, 22 files need changes

### Tier 2: HIGH
4. **antd 4 -> 5** -- remove global CSS import, 25 files use antd
5. **Cube.js 0.7 -> latest** -- 6 files affected
6. **ESLint 5 -> 9** -- new flat config format

### Tier 3: MEDIUM (incremental)
7. styled-components 4 -> 6 (3 files)
8. core-js 2 -> 3 (automatic with build tool upgrade)
9. moment -> dayjs (6 files, light usage)
10. recharts 1 -> 2

---

## 7. Recommended Upgrade Strategy Options

### Option A: Incremental (Lower Risk)
1. react-scripts 2 -> 5
2. React 16 -> 18
3. react-router 5 -> 6
4. antd 4 -> 5
5. Remaining packages

### Option B: Big Bang with Vite Migration (Better Outcome)
1. Migrate CRA to Vite + React 18 simultaneously
2. react-router 5 -> 6
3. antd 4 -> 5
4. Remaining packages

### Option C: Hybrid (Recommended)
1. react-scripts 2 -> 5 (known upgrade path)
2. Verify everything works
3. Migrate CRA 5 to Vite (well-documented path)
4. Upgrade React, react-router, antd in subsequent passes

---

## 8. Key Files Reference

### Entry Points
- `src/index.js` -- app entry (ReactDOM.render)
- `src/root.js` -- root component with routing

### Key Migration Files
- `src/components/PrivateRoute/PrivateRoute.js` -- auth route guard
- `src/services/auth/auth.js` -- auth singleton
- `src/services/history/index.js` -- history instance (remove for RR v6)
- `src/containers/Surveys/Surveys.js` -- complex routing
- `src/containers/SurveyScreen/SurveyScreen.js` -- nested routing

### Codebase Size
- ~97 JavaScript source files (44 with significant logic)
- 18 CSS files
- 0 TypeScript files
- 1 test file

---

## Addendum: Gap Investigation (2026-02-08)

### SKIP_PREFLIGHT_CHECK
- `.env`: FOUND (line 12: `SKIP_PREFLIGHT_CHECK=true`)
- `.env-dev`: FOUND (line 10: `SKIP_PREFLIGHT_CHECK=true`)

### Netlify Node Version
Current `netlify.toml` configuration: NODE_VERSION is **not set**. The file only contains redirect rules and per-context environment variables (REACT_APP_* values for production and staging). Netlify will use its default Node version, which may differ from what the project expects. An explicit `NODE_VERSION` should be added under `[build.environment]` during the upgrade.

### auth0-js Node Built-in Dependencies
Source code scan for Node built-ins (Buffer, crypto, stream, process) in `dashboard-client/src/`:
- **No Node built-in usage found beyond `process.env`**. All 10 matches are `process.env.REACT_APP_*` references, which are handled by CRA's DefinePlugin at build time (string replacement, not a runtime polyfill). Zero uses of `Buffer`, `require('crypto')`, `require('stream')`, or `require('process')` in application source code.
- Note: `auth0-js` itself (in node_modules) likely uses `crypto` and `Buffer` internally for token handling. This means Webpack 5's removal of automatic Node polyfills is a **real risk** that needs testing during the upgrade. If `npm run build` fails with "Module not found: Can't resolve 'crypto'" or similar, the fix is to add `react-app-rewired` or `craco` with a webpack config override to provide polyfills.
