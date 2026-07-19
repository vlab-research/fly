# Dashboard Server
Backend service to serve data to dashboard client.

## API Architecture

### Server Overview
- **Framework**: Express.js
- **Port**: 3000
- **API version prefix**: `/api/v1`

### Authentication

JWT-based authentication with two modes, implemented in `middleware/auth.js`:

- **Client (dashboard) auth**: JWT tokens issued by Auth0. The React SPA obtains a Bearer token from Auth0 and sends it with every request.
- **Server-to-server auth**: HS256-signed JWTs for internal service communication (e.g., export callbacks).

### User Scoping and Authorization

All queries filter by `req.user.email` so that users only see their own surveys and data. This is the primary access-control mechanism.

For survey-specific endpoints, there are two authorization middleware patterns:

**1. `validateSurveyAccess`** - Validates access to a single survey by shortcode or ID:

```javascript
const validateSurveyAccess = async (req, res, next) => {
  const { email } = req.user;
  const surveys = await Survey.retrieve({ email });
  const survey = surveys.find(s => s.shortcode === surveyId || s.id === surveyId);
  if (!survey) return res.status(403);
  req.survey = survey;
  next();
};
```

**2. `validateSurveyNameAccess`** - Validates access to all forms under a survey_name:

```javascript
const validateSurveyNameAccess = async (req, res, next) => {
  const { email } = req.user;
  const { surveyName } = req.params;
  const surveys = await Survey.retrieve({ email });
  const matchingSurveys = surveys.filter(s => s.survey_name === surveyName);
  if (matchingSurveys.length === 0) return res.status(403);
  req.surveyShortcodes = matchingSurveys.map(s => s.shortcode); // All shortcodes for this survey_name
  next();
};
```

This pattern is used when a "survey" (identified by `survey_name`) can contain multiple forms (shortcodes), and the endpoint needs access to data across all forms.

### Route Structure

| Route | Purpose |
|-------|---------|
| `/responses` | Survey response data |
| `/surveys` | Survey CRUD and settings |
| `/users` | Account operations |
| `/exports` | Async data export (via Kafka) |
| `/typeform` | Typeform integration |
| `/credentials` | Credential management |
| `/facebook` | Facebook integration |
| `/auth` | Authentication endpoints |
| `/surveys/:surveyId/bails` | Bail-out monitoring |
| `/surveys/:surveyId/bail-events` | Survey-wide bail events |
| `/surveys/:surveyName/states` | Participant state monitoring (summary, list, detail) |
| `/media` | Facebook `message_attachments` uploads (reusable image/video attachments) |
| `/message-templates` | Facebook Utility Message templates (CRUD per `(page, name, language)`); see `documentation/utility-messages.md` |
| `/tickets` | Support tickets — thin UI proxy over Linear (no local storage); see `documentation/tickets.md` |

### Database and Query Pattern

- Direct CockroachDB queries via a `pg` connection pool
- All queries are parameterized with email-based filtering
- JOINs through `surveys -> users` for data scoping
- The `states` table links to surveys via the `current_form` column (shortcode string), not a direct foreign key

#### Query Module Pattern

Query modules in `queries/` follow a consistent pattern for binding to the connection pool:

```javascript
// queries/<module>/<module>.queries.js
async function queryFunction(params) {
  const query = `SELECT ... WHERE ... = $1`;
  const { rows } = await this.query(query, [params]);
  return rows;
}

module.exports = {
  name: 'ModuleName',
  queries: pool => ({
    queryFunction: queryFunction.bind(pool),
  }),
};
```

Key aspects:
- Queries are functions bound to the pool via `this.query()`
- All queries use parameterized inputs (`$1`, `$2`, etc.) for SQL injection protection
- Type casting with `::int` for counts ensures proper integer types in results
- Functions return raw query results or structured objects (e.g., `{ items, total }` for pagination)

#### States Query Module

The `queries/states/` module provides three functions for querying participant state data: `summary`, `list`, and `detail`. All three are scoped to `(email, surveyName, shortcodes)` and apply the same scoping logic — see the docstring at the top of `queries/states/states.queries.js` for the full explanation.

**Why each query takes both `surveyName` and `shortcodes`**: the `states` table only carries `current_form` (the shortcode), but a single shortcode can belong to multiple `survey_name`s under the same owner with different historical versions. Each query does two things:

1. **Pre-filter on `current_form = ANY(shortcodes)`** — uses the `states (current_state, current_form, ...)` indexes to prune the scan down to candidate rows. Without this the resolution runs against every row in `states`.
2. **Scalar subquery against `surveys`** — for each candidate row, resolves which historical version of the shortcode the user was on (`s.created <= states.form_start_time`, ordered DESC, LIMIT 1) and filters on the resolved `survey_name`. This is the bit that disambiguates between sibling surveys that share a shortcode.

The resolution is written as a scalar subquery rather than `JOIN LATERAL` because CockroachDB's planner rewrites the LATERAL form into a surveys×states cross product. On HPV Nigeria Study (28 versions, 14 shortcodes, ~150k candidate state rows) the LATERAL form took ~46s and the scalar form takes ~5s for the same result.

State rows with NULL `form_start_time` (haven't started a form) are excluded. Killed versions (`off_time` set) are intentionally kept so historical attribution stays correct.

If the resolution rule in formcentral ever changes (shortcode + timestamp → surveyid), update this subquery to match — formcentral is the canonical source.

### External Integrations

- **Cube.js**: Used for analytics aggregation on the dashboard
- **Kafka**: Used for async export jobs; export requests are published to Kafka and results are delivered asynchronously
- **Linear**: Support tickets (`/tickets`) are proxied to Linear's GraphQL API using a service-account API key (`LINEAR_API_KEY`) filing into a single team (`LINEAR_TEAM_ID`). Nothing is stored locally — "my tickets" is scoped by a `vlab-reporter:<email>` sentinel embedded in each issue description. See `documentation/tickets.md`.

## Testing

### Test Setup

Integration tests require a running CockroachDB instance. Tests use the configuration from `DATABASE_CONFIG` in the test environment.

To run tests:
```bash
# Start test database (if using docker-compose)
docker-compose up -d

# Run all tests
npm test

# Run specific test file
npm test -- states.test.js
```

### Test Pattern

API integration tests follow a consistent pattern (see `api/bails/bails.test.js` and `api/states/states.test.js`):

**Setup (before hook):**
1. Create test user with `User.create({ email })`
2. Create test survey(s) with `Survey.create({ ...surveyConfig })`
3. Insert test data into relevant tables via direct SQL
4. Generate auth token with `makeAPIToken({ email })`

**Tests:**
- Test 401 (unauthorized) for endpoints without authentication
- Test 403 (forbidden) for endpoints with wrong user access
- Test happy path scenarios with valid auth and data
- Test filtering, pagination, and edge cases
- Verify response structure and data integrity

**Cleanup (after hook):**
1. Delete test data in reverse order (child tables first)
2. Delete test surveys
3. Delete test user
4. Close database pool with `vlabPool.end()`

### States API Tests

The states API tests (`api/states/states.test.js`) verify:

**Summary endpoint (`GET /surveys/:surveyName/states/summary`):**
- Returns aggregated counts grouped by state and form
- Respects user authorization

**List endpoint (`GET /surveys/:surveyName/states`):**
- Returns paginated results with correct structure
- Filters by state, error_tag, and userid search
- Pagination works correctly with limit/offset

**Detail endpoint (`GET /surveys/:surveyName/states/:userid`):**
- Returns full state detail including `state_json`
- Returns 404 for nonexistent userid
- Returns 403 for userid in unauthorized survey

**Test Data Setup:**
- Two surveys with same `survey_name` but different shortcodes
- Multiple state rows with different states (RESPONDING, ERROR, WAIT_EXTERNAL_EVENT, END)
- Includes rows with error_tag, stuck_on_question, and timeout_date for comprehensive testing

## Build

The Dockerfile is pinned to `node:14-bullseye` and installs deps with `npm i`. Two things to know before touching it:

- **Don't use `node:14-stretch`.** Debian stretch is EOL and Docker stopped updating it, so that tag is stuck at Node ≤14.17. The `require('util/types')` subpath needs Node ≥14.18 (it's pulled in by current `pg` transitives), and on stretch the container crashes at startup with `Cannot find module 'util/types'`. The `bullseye` tag tracks the latest 14.x (currently 14.21.x) and has the subpath.
- **Don't switch to `npm ci` without also bumping Node.** Node 14 ships npm 6, and the committed `package-lock.json` is lockfile v2, which npm 6 can't parse (`Cannot read property '@cubejs-backend/postgres-driver' of undefined`). `npm i` is the workaround until someone upgrades Node — replybot's Node 12 → 22 LTS bump (`replybot-v0.0.192`) is the template for that work. The downside of `npm i` is that builds re-resolve dependencies, so a transitive bump can cause runtime surprises like the `util/types` one.
