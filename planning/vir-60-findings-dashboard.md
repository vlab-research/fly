# VIR-60 Scout Findings: Dashboard Platform Support for User List Bails

## Summary

Dashboard-server bail REST endpoints forward the entire bail definition untouched to Exodus without validating user_list entries. Dashboard-client's CsvUpload component accepts only 3 columns (userid, pageid, shortcode), explicitly rejecting a 4th. The MCP schema has `additionalProperties: false` with no `platform` property on user_list items. To support platform correctly end-to-end:

**Key changes needed:**
1. Add optional `platform` field to MCP schema (line 1313-1323 in mcp.core.js) and CsvUpload template/parser
2. Dashboard-server: validate at create/update/preview time that platform (if provided) matches credentials.entity for that pageid, and reject early
3. CsvUpload: parse optional 4th column, show in preview, update template download
4. Error surface consistently: from REST 400 to MCP tool error with specific reasons (platform mismatch, missing credential, etc.)

**Open risks:**
- Credential lookup available (`listMessagingAccounts` in credential.service.js) but unused today
- REST and MCP validation are separate; coordinating changes requires care
- Dashboard-client has no existing UI for displaying platform in bail detail view

---

## Q1. REST Path: Routes, Controller, Validation, SQL

**File tree:**
- **Routes**: `dashboard-server/api/bails/bails.routes.js` (lines 1-18)
  - `POST /users/:userId/bails` (create)
  - `PUT /users/:userId/bails/:bailId` (update)
  - `POST /users/:userId/bails/preview` (preview)
  - `GET /users/:userId/bails` (list)
  - All routes protected by `validateUserAccess` middleware

- **Controller**: `dashboard-server/api/bails/bails.controller.js` (lines 1-143)
  - `createBail` (line 60-78): destructures only `{name, description, definition, destination_form}` from req.body; **drops `enabled` on create** (documented in bail-systems.md §9)
  - `updateBail` (line 81-96): forwards `enabled` when present
  - `previewBail` (line 109-121): passes definition straight through
  - `validateUserAccess` middleware (line 19-39): resolves user from email, checks userId matches authenticated user

- **Service**: `dashboard-server/api/bails/bails.service.js` (lines 1-68)
  - Pure functions, req-free, wrap exodus calls in error handler
  - `resolveVlabUser` (line 31-36): get-or-create from email
  - `exodus` wrapper (line 39-46): catches 4xx as `BailFailure` (expected, safe to echo), rethrows others
  - All operations delegate to `BailsUtil`

- **Util proxy**: `dashboard-server/utils/bails/bails.util.js` (lines 1-85)
  - Makes HTTP requests to Exodus at `Config.EXODUS.url` (e.g., `http://exodus:8080/users/:userId/bails`)
  - Uses `exodusRequest` helper (line 9-34) which formats body as JSON and parses response
  - `createBail`, `updateBail`, `previewBail` pass definition verbatim; Exodus is the only validation

**Validation today:**
- Controller: Only checks `name` and `definition` are non-null (line 64-65, 113-115)
- No schema validation in dashboard-server
- No credentials lookup
- **Definition is forwarded to Exodus untouched** — the REST path is the one documented exception (bail-systems.md:480-481) that can set platform

**Functional core / imperative shell:**
- `bails.service.js` has no IO and takes resolved user as parameter ✓
- `bails.util.js` does the HTTP proxy (imperative shell) ✓
- **No validation logic exists; controller is a thin shell**, not a functional core

**SQL:**
- No dashboard-server queries; Exodus handles CRUD directly to `chatroach.bails` and `chatroach.bail_events`

---

## Q2. MCP Schema, Validation, Tool Descriptions, Tests

**Schema definition**: `dashboard-server/api/mcp/mcp.core.js` (lines 1303-1326)
```javascript
user_list: {
  type: 'object',
  properties: {
    users: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['userid', 'pageid', 'shortcode'],
        additionalProperties: false,  // ← NO PLATFORM PROPERTY
        properties: {
          userid: { type: 'string', minLength: 1 },
          pageid: { type: 'string', minLength: 1 },
          shortcode: { type: 'string', minLength: 1 },
        },
      },
    },
  },
}
```

**Validation function**: `validateBailDefinition` (lines 1576-1623)
- Checks `time_of_day` format (HH:MM for scheduled) — line 1583-1588
- Checks `timezone` is valid IANA name (for scheduled/absolute) — line 1591-1599
- Checks `datetime` format (YYYY-MM-DDTHH:MM:SS for absolute, no Z/offset) — line 1601-1609
- Checks user_list size ≤ MAX_USER_LIST (1000) — line 1614-1620
- **Does NOT validate platform, pageid ownership, or credential existence**

**Schema validation engine**: `validateAgainstSchema` (referenced in tests at line 176+)
- Generic JSON Schema validator (minItems, required, additionalProperties, enum, type checks)
- Not used by `validateBailDefinition` directly; `validateBailDefinition` is hand-rolled
- Used by `validateToolArgs` (core.js ~line 1815) to check request shape before dispatching to handler

**MCP tool descriptions**: `dashboard-server/api/mcp/mcp.core.js`
- `create_bail` (line 1415-1450): No mention of platform validation
- `update_bail` (line 1453-1500): No mention of platform validation
- `preview_bail` (line 1503-1541): No mention of platform validation
- Common BAILS_NOTE (line 71-79): mentions user_list allows per-user destinations, no mention of platform

**MCP request flow**:
1. Tool call arrives at `mcp.routes.js`, parsed by `express.json()`
2. `mcp.tools.js` `runTool` (line ~250) dispatches by tool name
3. For `create_bail`, calls handler in `mcp.tools.js` (line ~1200s)
4. Handler calls `mcp.service.js` functions (line 137: bail operations re-exported from bails.service.js)
5. Service calls `BailsUtil` (same proxy as REST path)
6. `BailsUtil` calls Exodus HTTP

**Tool scope enforcement**: `mcp.tools.js` `TOOL_SCOPES` table
- Bails tools all require `users:write` (except list/preview which need `users:read`)
- No per-field or per-platform scope

**Tests**: `dashboard-server/api/mcp/mcp.core.test.js`
- Lines 932-1036: `validateBailDefinition` tests
  - Tests user_list size cap (line 1018-1031) ✓
  - Tests timing format validation (line 932-1017) ✓
  - **No tests for platform field, pageid validation, or credential lookup** ✗

- Lines 1038-1108: `buildBailRequest` tests (prepares request before sending to Exodus)
  - Tests destination_form handling for conditions-type bails
  - Tests user_list bails don't invent a destination (line 1074-1084) ✓
  - **No platform tests** ✗

**Running tests**:
```bash
cd dashboard-server
npm test                    # runs all tests via jest/mocha
npm test -- mcp.core.test  # specific file
```

---

## Q3. Dashboard-Client: CsvUpload, BailForm, Preview Table, Tests

**CsvUpload component**: `dashboard-client/src/components/CsvUpload/CsvUpload.js`

- **Parser** (line 8-40): `parseCSV(text)`
  - Splits by newline, skips header if first row contains 'userid' or 'user_id' (line 14-17)
  - **Parses exactly 3 columns**, rejects anything else (line 24-26):
    ```javascript
    if (parts.length !== 3) {
      errors.push(`Row ${i + 1}: expected 3 columns (userid, pageid, shortcode), got ${parts.length}`);
      continue;
    }
    ```
  - Returns `{users: [{userid, pageid, shortcode}, ...], errors}`
  - **No platform field** ✗

- **Template download** (line 42-51): Hardcoded string
  ```javascript
  const csv = 'userid,pageid,shortcode\n';
  ```
  - No platform column ✗

- **Preview table** (line 78-94): Three columns only
  ```javascript
  const columns = [
    { title: 'User ID', dataIndex: 'userid' },
    { title: 'Page ID', dataIndex: 'pageid' },
    { title: 'Destination', dataIndex: 'shortcode' },
  ];
  ```
  - No platform column ✗

- **PropTypes** (line 167-174): Validates shape
  ```javascript
  value: PropTypes.arrayOf(PropTypes.shape({
    userid: PropTypes.string.isRequired,
    pageid: PropTypes.string.isRequired,
    shortcode: PropTypes.string.isRequired,  // no platform
  }))
  ```

**BailForm component**: `dashboard-client/src/containers/BailSystems/BailForm.js`

- **Mode detection** (line 39, 128-132): Sets `bailType` state from `definition.type`
  - Initializes `userList` state from `definition.user_list.users` (line 40, 87, 131)

- **CsvUpload integration** (line 11, ~line 200-500 render):
  - Imports `CsvUpload` component
  - Passes `value={userList}` and `onChange={setUserList}` (typical controlled component)
  - CsvUpload emits parsed array directly; BailForm stores in state

- **Definition builder** (line 156-213): `buildDefinition(values)`
  - For `user_list` type (line 185-194):
    ```javascript
    return {
      type: 'user_list',
      user_list: { users: userList },  // ← userList from state
      execution,
      action: { destination_form: userList[0]?.shortcode, metadata },
    };
    ```
  - **No platform per entry** ✗

- **Render** (not fully read, but based on line 11 import and state usage):
  - Renders CsvUpload component conditionally on `bailType === 'user_list'`
  - Passes parsed users from CsvUpload to API create/update

**Tests**: `dashboard-client/src/components/CsvUpload/`
- No `*.test.js` file present in directory listing
- `BailForm.js` likely untested (dashboard-client README line 75-76 says containers are untested, only logic modules)

**Running tests**:
```bash
cd dashboard-client
npm test                    # jest via react-scripts
```

---

## Q4. Error Surfacing

**REST path error format** (`bails.controller.js:12-16`):
```javascript
function handle(err, res) {
  console.error('Bails API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}
```
- Status code from `err.status` (set by `BailFailure`) or default 500
- Response: `{ error: { message: "string" } }`

**Exodus error relay** (`bails.service.js:39-46`):
- Exodus returns 4xx (e.g., 400 invalid_bail_id, 400 invalid_definition) with JSON body
- `exodusRequest` (utils/bails:22-34) parses error and throws with `err.status` set
- `exodus` wrapper (service:39-46) catches 4xx, wraps in `BailFailure` (expected=true), rethrows
- `BailFailure` signals to MCP that this is safe to echo verbatim

**MCP error format** (`mcp.tools.js` ~line 250):
- `runTool` catches all errors from handlers
- If error has `expected: true`, surfaces as tool error with message
- Otherwise, logs internally and returns generic "internal error" to tool
- Tool error shape: `{ isError: true, message: "..." }`

**Validation error example** (from `validateBailDefinition` line 1586):
```javascript
'definition.execution.time_of_day: "09:00:00" is not "HH:MM" (24-hour, e.g. "09:00"). ' +
'Exodus would store it and then never run the bail.'
```
- Clear, actionable, names the field and the problem

**No validation errors today for platform** because:
1. MCP schema has `additionalProperties: false` with no platform, so extra columns are rejected at schema validation, not bail-specific validation
2. REST path accepts whatever is in the definition without dashboard-level checks
3. Exodus validates presence of required fields (userid, pageid, shortcode) but NOT platform
4. Bad platform currently fails at Exodus send time, not at create time

---

## Q5. Tests: Files, Style, Running

**Test files covering bails:**
- `dashboard-server/api/bails/bails.test.js` — REST API integration tests
- `dashboard-server/api/mcp/mcp.core.test.js` — MCP schema and validation unit tests (lines 932-1108)
- `dashboard-server/api/mcp/mcp.tools.test.js` — MCP tool dispatcher and error handling
- `dashboard-server/api/mcp/mcp.transport.test.js` — MCP HTTP transport integration

**Style:**
- **Framework**: Mocha (test runner), Chai (assertions), Supertest (HTTP requests)
- **Setup pattern** (bails.test.js:17-56): before hook creates test user/survey, after hook cleans up
- **Test names**: Descriptive, test one thing (e.g., "returns 400 when name is missing")
- **Assertions**: `should()` or `expect()` (both used)

**Existing bail tests** (bails.test.js:58-100):
- POST create: 401 unauthenticated, 400 missing name, 400 missing definition, 403 user mismatch
- Similar coverage for GET, PUT, DELETE
- **No platform-related tests** ✗
- **No credentials validation tests** ✗

**MCP tests** (mcp.core.test.js:932-1036):
- Pure unit tests (no DB, no HTTP)
- Validate timing format, user_list size, and error message content
- **No platform, credential lookup, or pageid ownership tests** ✗

**Running:**
```bash
cd dashboard-server
npm install              # if needed
docker-compose up -d     # start test DB and MinIO
npm test                 # all tests
npm test -- bails        # filter to bails
npm test -- mcp.core     # filter to MCP core
```

**DB requirement**: Tests need `DATABASE_CONFIG` from `config/index.js`, typically expects CockroachDB at localhost:5433 (or via Docker Compose)

---

## Q6. Other Components Constructing user_list Payloads

**Smoke tests**: No bail-related tests found in `smoke-test/`

**Scripts**: No bails examples found in `devops/` scripts

**Documentation examples**: `documentation/bail-systems.md`
- Example 1 (line 90-91): Two entries with platform explicitly set
  ```json
  { "userid": "user1", "pageid": "page1", "platform": "whatsapp", "shortcode": "survey_a" }
  ```
- Example 2 (line 1016-1017): Full user_list bail POST example showing platform ✓
  
**Description in docs** (line 129-131): Only the REST API can set platform; CSV upload rejects 4th column; MCP has `additionalProperties: false`

---

## Doc Gaps & Observations

**Gaps between docs and code:**
1. `bail-systems.md` line 129-131 says MCP has `additionalProperties: false` without platform — **code confirms this** (mcp.core.js:1317)
2. `bail-systems.md` line 480-481 says only REST API can set platform — **code confirms this** (CsvUpload rejects 4th column, MCP schema forbids it)
3. `bail-systems.md` line 105-123 describes the failure mode well, but dashboard-server makes no attempt to prevent it early
4. **No documentation of validation rules** for platform in dashboard-server (exodus docs exist, but dashboard-server is a proxy and should validate early)

**Undocumented assumptions:**
- Credential lookup exists in `listMessagingAccounts` but dashboard-server doesn't use it for validation
- `credentials.entity` is the source of truth for platform, but no dashboard-server validation checks this
- REST path is the "only" way to set platform, but REST path doesn't validate what's sent

**Surprising code patterns:**
- BailForm stores `userList` state separately and rebuilds the user_list object in `buildDefinition` — flexible but no centralized shape validation
- MCP has generic `validateAgainstSchema` (can be reused) but `validateBailDefinition` is hand-rolled — not a code smell, just worth noting for consistency

---

## Recommendations for Plan Agent

1. **Add platform to MCP schema** (`mcp.core.js:1313-1323`): Add optional `platform` property, update description
2. **Extend validateBailDefinition** to check:
   - If `type === 'user_list'`: each entry's platform (if provided) matches `credentials.entity` for that pageid
   - Reject if pageid has no messaging credential (no facebook_page or whatsapp_business row)
   - Optionally reject if pageid is not owned by the bail owner (LEFT JOIN credentials on userid)
3. **Update CsvUpload** to parse optional 4th column, default to empty string if absent
4. **Update template download** to show 4 columns (userid, pageid, platform, shortcode)
5. **Update preview table** to show platform column
6. **Add tests** for platform validation in both REST and MCP paths
7. **Document the validation in README** — dashboard-server validates early to catch mismatches before Exodus

---

## Files Modified (This Scout Pass Only)

None — read-only investigation only.

## Files for Plan/Build to Read

- `dashboard-server/api/bails/bails.controller.js` (validation entry point)
- `dashboard-server/api/bails/bails.service.js` (error handling)
- `dashboard-server/utils/bails/bails.util.js` (Exodus proxy)
- `dashboard-server/api/mcp/mcp.core.js` (schema and validation)
- `dashboard-server/api/mcp/mcp.tools.js` (dispatcher, error surfacing)
- `dashboard-client/src/components/CsvUpload/CsvUpload.js` (parser, template, preview)
- `dashboard-client/src/containers/BailSystems/BailForm.js` (integration with API)
- `dashboard-server/api/credentials/credential.service.js` (messaging account lookup)
- `dashboard-server/api/mcp/mcp.core.test.js` (validation test patterns)
- `dashboard-server/api/bails/bails.test.js` (REST test patterns)
