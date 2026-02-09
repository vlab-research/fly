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

The `queries/states/` module provides three functions for querying participant state data:

1. **`summary(shortcodes)`** - Aggregated counts grouped by `current_state` and `current_form`
   - Input: Array of shortcodes to filter by
   - Output: Array of `{ current_state, current_form, count }` objects

2. **`list(shortcodes, { state, errorTag, search, limit, offset })`** - Paginated participant list with filtering
   - Input: Shortcodes array + optional filters
   - Output: `{ states: Array, total: number }`
   - Supports filtering by state, error_tag, and userid search (LIKE)

3. **`detail(shortcodes, userid)`** - Full state detail including `state_json`
   - Input: Shortcodes array + participant userid
   - Output: Single state object with all computed columns and full JSON, or null if not found

### External Integrations

- **Cube.js**: Used for analytics aggregation on the dashboard
- **Kafka**: Used for async export jobs; export requests are published to Kafka and results are delivered asynchronously

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
