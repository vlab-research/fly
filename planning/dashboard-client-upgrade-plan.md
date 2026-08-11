# Dashboard Client CRA 5 + React 18 Upgrade Plan

## Required Reading
- `planning/dashboard-client-upgrade-findings.md` -- Full investigation of current dependency state, React patterns, and upgrade risk assessment
- `dashboard-client/README.md` -- Component architecture, container patterns, routing patterns, API client, local dev setup, build system, and styling documentation

## Scope

Upgrade react-scripts 2.1.8 → 5.0.1 and React 16.13 → 18.x ONLY.

**Explicitly out of scope**: react-router v6, antd v5, styled-components v6, cubejs upgrade, moment→dayjs, recharts v2, Vite migration, TypeScript migration. These are future phases.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `dashboard-client/.nvmrc` | **CREATE** | Pin Node 18 |
| `dashboard-client/netlify.toml` | **MODIFY** | Add `NODE_VERSION = "18"` to build environment |
| `dashboard-client/package.json` | **MODIFY** | Upgrade react, react-dom, react-scripts; remove core-js; update babel-plugin-macros; remove ESLint devDeps |
| `dashboard-client/.eslintrc.js` | **MODIFY** | Replace airbnb+babel-eslint config with CRA 5's `react-app` extend |
| `dashboard-client/src/index.js` | **MODIFY** | `ReactDOM.render` → `createRoot` |
| `dashboard-client/src/containers/App/App.test.js` | **MODIFY** | `ReactDOM.render`/`unmountComponentAtNode` → `createRoot`/`unmount` |
| `dashboard-client/.env` | **MODIFY** | Remove `SKIP_PREFLIGHT_CHECK=true` (if present) |
| `dashboard-client/.env-dev` | **MODIFY** | Remove `SKIP_PREFLIGHT_CHECK=true` |
| `dashboard-client/package-lock.json` | **REGENERATE** | Delete old (lockfileVersion 1), regenerate via `npm install` |

---

## Implementation Steps

### Step 1: Prerequisites

**1.1 Pin Node version**

Create `dashboard-client/.nvmrc`:
```
18
```

Rationale: react-scripts 5 requires Node >= 14. Node 18 LTS is the most battle-tested with CRA 5.

**1.2 Set Netlify Node version**

Add to `netlify.toml` build environment section:
```toml
[build.environment]
  NODE_VERSION = "18"
```

**1.3 Clean environment**

Before any work in the worktree:
```bash
rm -rf node_modules package-lock.json
```

The existing lock file is lockfileVersion 1 and node_modules is from June 2021. A fresh install is mandatory.

---

### Step 2: package.json Dependency Changes

Apply ALL changes before running `npm install` to avoid intermediate broken states.

**2.1 Upgrade dependencies:**

| Package | From | To | Notes |
|---------|------|----|-------|
| `react` | `^16.13.1` | `^18.2.0` | Major upgrade |
| `react-dom` | `^16.13.1` | `^18.2.0` | Major upgrade |
| `react-scripts` | `2.1.8` | `5.0.1` | Major upgrade (3 versions) |
| `babel-plugin-macros` | `^2.8.0` | `^3.1.0` | CRA 5 bundles this but explicit dep prevents conflicts |
| `core-js` | `^2.6.11` | **REMOVE** | CRA 5 handles polyfills via Babel; no source files import core-js |

**2.2 Remove conflicting devDependencies (CRA 5 bundles its own ESLint):**

Remove ALL of these:
- `eslint` (5.15.3) — CRA 5 bundles ESLint 8
- `eslint-config-airbnb` (17.1.0) — incompatible with ESLint 8
- `eslint-plugin-import` (2.16.0) — CRA 5 bundles its own
- `eslint-plugin-jsx-a11y` (6.2.1) — CRA 5 bundles its own
- `eslint-plugin-react` (7.12.4) — CRA 5 bundles its own
- `eslint-plugin-react-hooks` (1.6.0) — CRA 5 bundles v4+

**Keep**: `husky` (1.3.1) — unrelated to this upgrade.

**2.3 Final package.json dependencies:**

```json
{
  "dependencies": {
    "@ant-design/icons": "^4.3.0",
    "@cubejs-client/core": "^0.7.10",
    "@cubejs-client/react": "^0.7.10",
    "antd": "^4.8.6",
    "auth0-js": "9.10.1",
    "babel-plugin-macros": "^3.1.0",
    "d3-array": "^2.4.0",
    "history": "4.9.0",
    "moment": "2.24.0",
    "prop-types": "15.7.2",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^5.2.0",
    "react-scripts": "5.0.1",
    "recharts": "1.5.0",
    "styled-components": "^4.4.1"
  },
  "devDependencies": {
    "husky": "1.3.1"
  }
}
```

---

### Step 3: Code Changes

**3.1 `src/index.js` — ReactDOM.render → createRoot**

Current:
```javascript
import React from 'react';
import ReactDOM from 'react-dom';
import 'antd/dist/antd.css';
import './index.css';
import Root from './root';

ReactDOM.render(<Root />, document.getElementById('root'));
```

New:
```javascript
import React from 'react';
import { createRoot } from 'react-dom/client';
import 'antd/dist/antd.css';
import './index.css';
import Root from './root';

const container = document.getElementById('root');
const root = createRoot(container);
root.render(<Root />);
```

Key decisions:
- Import `createRoot` from `react-dom/client` (not `react-dom`)
- `antd/dist/antd.css` import remains valid for antd 4.x
- **No `<StrictMode>` wrapper** — adding it would trigger double-render warnings with react-router v5 and antd v4. Add StrictMode in a future phase after those are upgraded.

**3.2 `src/containers/App/App.test.js` — same migration**

Current:
```javascript
import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';

it('renders without crashing', () => {
  const div = document.createElement('div');
  ReactDOM.render(<App />, div);
  ReactDOM.unmountComponentAtNode(div);
});
```

New:
```javascript
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

it('renders without crashing', () => {
  const div = document.createElement('div');
  const root = createRoot(div);
  root.render(<App />);
  root.unmount();
});
```

Note: This test may fail because `App` depends on routing context. If it fails, wrap in `MemoryRouter`:
```javascript
import { MemoryRouter } from 'react-router-dom';
root.render(<MemoryRouter><App /></MemoryRouter>);
```

**3.3 No other React API changes needed**

All components are functional. No class components, no deprecated lifecycle methods, no `findDOMNode`, no string refs. Hooks are fully compatible with React 18.

---

### Step 4: ESLint Configuration

**Replace `.eslintrc.js` entirely:**

```javascript
module.exports = {
  extends: ['react-app'],
  rules: {
    'no-unused-vars': ['error', { varsIgnorePattern: '__', argsIgnorePattern: '__' }],
    'no-shadow': 0,
    'no-alert': 0,
    'no-nested-ternary': 0,
    'no-plusplus': 0,
    'no-undef': 0,
  },
};
```

Rationale:
- `react-app` is CRA 5's built-in ESLint config (via `eslint-config-react-app`). Includes `@babel/eslint-parser`, React rules, hooks rules, and import rules.
- Airbnb config dropped because (a) incompatible with ESLint 8, (b) project was already disabling many airbnb rules.
- Only the custom rule overrides that the project actually uses are preserved.
- React version auto-detected by `react-app` config.

**Alternative (if airbnb is wanted)**: Re-add `eslint-config-airbnb@19.x` + peer deps to devDependencies. More work, more conflict surface area. Not recommended for this phase.

---

### Step 5: Environment Variable Changes

**5.1 Remove SKIP_PREFLIGHT_CHECK**

Remove `SKIP_PREFLIGHT_CHECK=true` from:
- `.env` (if present)
- `.env-dev` (confirmed present)

After removing the ESLint devDependency conflicts, this flag is no longer needed and masks future dependency issues.

**5.2 Start script — no change needed**

The current start script `HTTPS=true env $(cat .env | xargs) react-scripts start` should continue to work with CRA 5.

**5.3 Browserslist — no change needed**

The current browserslist in package.json is compatible with CRA 5.

---

### Step 6: Verification Plan

Execute in order. Each step must pass before proceeding.

**6.1 Clean install**
```bash
cd dashboard-client
rm -rf node_modules package-lock.json
npm install
```
- If strict peer deps fail: use `npm install --legacy-peer-deps`
- Expected warnings: recharts, cubejs, styled-components may warn about React 18 peer deps (non-blocking)

**6.2 Production build**
```bash
npm run build
```
- Watch for ESLint errors (CRA 5 runs ESLint during build)
- Watch for Webpack 5 module resolution errors
- Watch for "Module not found: Can't resolve 'crypto'" (auth0-js polyfill issue — see Risks)

**6.3 Dev server**
```bash
npm start
```
- Verify login page renders
- Verify Auth0 redirect works
- After login: survey list loads, forms table renders
- Check browser console for React 18 warnings (informational, not blockers)

**6.4 Tests**
```bash
npm test
```
- Single test in App.test.js should pass after createRoot migration

**6.5 Lint**
```bash
npm run lint
```
- New `react-app` config may flag issues the old config missed — fix any errors

**6.6 Netlify preview deploy**
- Push to a branch, verify Netlify preview build succeeds with Node 18
- Verify app loads and auth flow works end-to-end

---

### Step 7: Known Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Peer dependency conflicts** | HIGH | Blocks install | Use `npm install --legacy-peer-deps`. CRA 5 on npm 7+ enforces peer deps. |
| **Webpack 5 Node polyfill removal** | MEDIUM | Build failure | CRA 5/Webpack 5 dropped automatic Node.js polyfills (Buffer, crypto, process). `auth0-js` likely uses `crypto` and `Buffer` internally. If build fails with "Module not found: Can't resolve 'crypto'", add `react-app-rewired` or `craco` with webpack config override to provide polyfills. |
| **antd 4 CSS import** | LOW | Styles broken | `import 'antd/dist/antd.css'` should work with Webpack 5. If broken, try `import 'antd/dist/antd.min.css'`. |
| **styled-components/macro** | LOW | Build failure | CRA 5 supports babel-plugin-macros. If it fails, fall back to `import styled from 'styled-components'`. |
| **React 18 automatic batching** | LOW | Subtle UI bugs | React 18 batches ALL state updates (not just event handlers). Functional components with hooks handle this well. |
| **react-router v5 + React 18** | LOW | Console warnings | Works fine without StrictMode. We are NOT enabling StrictMode. |
| **Jest 27 changes** | LOW | Test failure | Only 1 test. Jest 27 changes snapshot serialization and mock resets. |
| **Netlify build** | LOW | Deploy failure | `NODE_VERSION=18` in netlify.toml ensures consistency. Test with preview deploy. |

---

### Step 8: Rollback Strategy

All changes are a single atomic commit. Rollback:
1. `git revert <commit>`
2. `rm -rf node_modules package-lock.json && npm install`
3. Verify old version works

---

## What This Upgrade Does NOT Change

These remain at current versions (future phases):
- `react-router-dom` at v5 — all Switch, Route, useRouteMatch, useHistory patterns unchanged
- `antd` at v4 — `import 'antd/dist/antd.css'` and all component usage unchanged
- `styled-components` at v4 — `styled-components/macro` imports unchanged
- `history` at 4.9.0 — coupled to react-router v5
- `@cubejs-client/*` at 0.7.x
- `recharts` at 1.5.0
- `moment` at 2.24.0
- `auth0-js` at 9.10.1
- `husky` at 1.3.1
- No TypeScript migration
- No Vite migration (subsequent phase after CRA 5 is stable)

---

## Future Phases (Reference)

After this upgrade stabilizes:
1. **Phase 2**: Migrate CRA 5 → Vite (CRA is abandoned upstream)
2. **Phase 3**: react-router v5 → v6 (22 files, largest effort)
3. **Phase 4**: antd v4 → v5 (25 files, CSS-in-JS migration)
4. **Phase 5**: Remaining deps (styled-components, recharts, cubejs, moment→dayjs)
5. **Phase 6**: TypeScript migration (optional, replaces PropTypes)
