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
| `/users/:userId/bails` | User-scoped bail-out system management (list, create, get, update, delete, preview); access controlled via `validateUserAccess` middleware |
| `/users/:userId/bail-events` | All bail events for a user |
| `/surveys/:surveyName/states` | Participant state monitoring (summary, list, detail) |
| `/surveys/:surveyName/health` | Survey health findings for the Monitor tab (24h aggregates + declarative ruleset); see `documentation/dashboard-study-health.md` |
| `/platform/notices` | Platform-wide notices proxied from AlertManager (whitelisted alertnames, fail-soft) |
| `/media` | Facebook `message_attachments` uploads (reusable image/video attachments) |
| `/message-templates` | Facebook Utility Message templates (CRUD per `(page, name, language)`); see `documentation/utility-messages.md` |
| `/tickets` | Support tickets — thin UI proxy over Linear (no local storage); see `documentation/tickets.md` |

### Media functional core (`api/media/media.core.js`)

The media feature is moving from page-scoped Facebook `attachment_id`s to an
asset/handle model (`planning/media-abstraction.md`; migration
`24-media-assets.sql`). `media.core.js` is its pure decision layer — **no fs, no
network, no database, no `Date.now()`**; anything time-dependent takes `now` as a
parameter, so expiry behaviour is asserted by passing a clock instead of waiting
30 days.

#### Upload Validation and Eligibility (§11.5)

**The dashboard refuses ineligible uploads rather than transcoding or downscaling them.**
Uploads must be both of an allowed MIME type and within the per-type byte limit. Limits
are enforced at the **strictest supported platform's limit**, making eligibility a system-wide
invariant: every asset that exists is guaranteed sendable on every supported platform.
This removes the need for any later per-platform eligibility check.

Limits verified 2026-08-10 against Meta's WhatsApp Cloud API media reference and the
Messenger `saving-assets` page (`planning/media-abstraction.md` §11.5).

| Type | Allowed MIME types | Max size | Rationale |
|---|---|---|---|
| Image | JPEG, PNG (8-bit only) | 5 MB | WhatsApp strictest limit |
| Video | MP4, 3GPP | 16 MB | WhatsApp strictest limit |
| Audio | AAC, MP4, MPEG, AMR, OGG | 16 MB | WhatsApp strictest limit |
| Document | PDF, DOCX, XLSX, PPTX | 100 MB | Meta's list, minus what cannot be identified |

Rejected types (GIF, WebP, WebM, QuickTime, WAV) are not WhatsApp-sendable, so they are
refused with a specific error message naming both the rejected type and the accepted
alternatives for that media class.

**Acceptance is bounded by identification, never by the claimed type or the extension.**
`sniffContentType` returns `application/octet-stream` for anything it cannot positively
name — the same result it returns for an HTML/SVG payload relabelled as an image — and
octet-stream is always refused. That is a deliberate XSS guard (uploaded content is served
back from our own domain), not a gap to "fix" by loosening the check. Widening support
means teaching the sniffer new magic bytes, never accepting unclassified bytes.

Meta lists **eight** document MIME types. Four are accepted, four are not, and each
omission is a decision:

- **PDF** — `%PDF-` magic.
- **DOCX / XLSX / PPTX** — ZIP containers (`PK\x03\x04`). The subtype is read out of the
  package's own `[Content_Types].xml` (inflated from the first ZIP entry) by matching the
  declared `…main+xml` part type, so it is identification rather than a guess. A ZIP that
  does not resolve is reported as `application/zip` — named, so the error can say "ZIP
  archive", but not accepted. Macro-enabled packages (docm/xlsm/pptm) declare a different
  main part, so they fall through to plain ZIP and are refused, which is welcome: they
  carry executable content.
- **DOC / XLS / PPT** — OLE2/CFB compound files (`D0 CF 11 E0 A1 B1 1A E1`). The magic
  names the container, which `.msi` and `.msg` share; telling the three Office types apart
  needs a CFB directory walk down the FAT sector chain, which is out of proportion here.
  Reported as `application/x-ole-storage` and refused with an error naming the format.
- **`text/plain`** — **deliberately not supported.** Text has no magic bytes, so "is this
  text?" cannot be answered; every HTML and SVG payload the octet-stream rejection exists
  to catch is also plain text. Accepting it would mean accepting anything. Pinned by test.

**PNG bit depth is checked; codecs are not.** Meta requires images to be "8-bit, RGB or
RGBA". A 16-bit PNG passes every size and MIME check and is then refused by WhatsApp at
fan-out, leaving an asset that gets no handle and sends by URL forever with nothing
erroring. The depth is one byte at a fixed offset (byte 24 of the IHDR), so it is enforced
and the error names the actual depth. Colour type is **not** enforced — 8-bit greyscale and
palette PNGs are accepted in practice. Video/audio codec constraints (H.264, AAC, OPUS)
need demuxing and are **not** enforced, so the "every asset is sendable everywhere"
invariant holds for size and MIME but not for codecs: the by-URL health signal has a small
non-zero floor rather than being provably zero (§11.5).

#### Core Functions

| Function | Contract |
|---|---|
| `hashContent(buffer)` | sha256 hex. Dedupe **detection** only (`UNIQUE (userid, content_hash)`) — identity is the asset's UUID |
| `storageKeyFor(assetId)` | `a/<uuid>`; throws on anything that is not a UUID, which is what keeps a key inside the prefix |
| `publicUrlFor(base, assetId, filename)` | `<base>/a/<uuid>/<filename>`; the filename segment is cosmetic and percent-encoded |
| `parseAssetId(url)` | uuid or null. **Host-independent** — path shape only |
| `sniffContentType(buffer, claimed)` | Magic-byte detection. A claim can only narrow within the same container, never widen trust; anything unrecognised is `application/octet-stream`. ZIPs are resolved to docx/xlsx/pptx via the package manifest, or reported as plain `application/zip`; OLE2 is named but not resolved |
| `pngBitDepth(buffer)` | The depth byte from a PNG's IHDR, or `null` when there is no readable header. `validateUpload` accepts only 8 |
| `validateUpload(file)` | `{ok:true, filename, mimeType, mediaType, byteSize}` / `{ok:false, error}` — every client-asserted fact is recomputed. Size limits are enforced using the **sniffed** MIME type, never the client's claim |
| `buildAssetRecord(email, hash, meta)` | The write-once `media_asset` row |
| `planReconcile(now, assets, accounts, handles, policy)` | The reconciler's entire decision layer — see below |

Two properties are load-bearing and are pinned by tests:

- **`parseAssetId` is the JS twin of `message-worker/mediaresolve.ParseAssetID`.**
  Both decide the same question on opposite sides of the system, and the test
  tables are deliberately identical. Host-independence is what lets a production
  media URL pasted into a survey run on staging: it parses, misses the local
  lookup, and sends the production URL, which the production proxy serves.
- **Handles are matched on `account_id` alone, never on `(platform, account_id)`.**
  `credentials.entity` says `facebook_page`/`whatsapp_business` while
  `SendMessageCommand` says `messenger`/`whatsapp`, so a two-part key would let
  the writer and reader disagree — and the failure would be invisible, since a
  lookup miss is the designed URL fallback rather than an error. `platform` is
  descriptive only. See the comment in `devops/migrations/24-media-assets.sql`.

#### Reconciliation

`planReconcile` compares desired state (each asset × each of its owner's
messaging accounts) with the handle rows it is given and returns
`{type: 'create'|'refresh'|'prune', assetId, accountId, platform, reason}`
actions. One mechanism covers missing handles, near-expiry handles, accounts
connected after upload, and disconnected accounts. Refresh keys off
`uploaded_at` plus a per-platform TTL — **never off last use** — and applying the plan makes a
re-run return nothing, so it is safe on a tick. Since eligibility is enforced
at upload time, there is no per-platform eligibility check in reconciliation —
every stored asset is sendable everywhere.

**Handle TTLs (`DEFAULT_RECONCILE_POLICY`), verified 2026-08-10 against Meta's docs:**

| Platform | TTL from `uploaded_at` | Source |
|---|---|---|
| Messenger | **90 days** | Meta: "Attachment IDs expire after 90 days" |
| WhatsApp | 30 days | Meta: "Media IDs returned by the API expire after 30 days" |

Handles are refreshed `refreshMarginMs` (3 days) before end of life, so in practice a
Messenger handle is replaced at 87 days and a WhatsApp one at 27.

**Every platform we fan out to must have a finite TTL here.** Messenger was recorded as
never expiring until 2026-08-10. That is a silent-failure bug, not a nit: with no TTL,
`endOfLife` cannot place the handle's death, `planReconcile` never refreshes it by age, and
because a handle is only ever an optimisation, nothing errors when it dies — every send
just falls back to URL, forever, on the platform carrying ~100% of live media traffic
(§11.1). The reconcile tests run against the shipped constants precisely so this cannot
regress unnoticed.

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

#### Health API (`api/health/`)

Functional core / imperative shell: `rules.js` (declarative, data-only
ruleset + platform-notice whitelist), `aggregate.js` (pure fold from query
rows to the aggregate bag), `evaluate.js` (pure rule engine),
`notices.js` (pure AlertManager-alert translation). IO lives at the edges:
the `healthSummary` query (in `queries/states/`, reusing the states scoping
SQL with a 24h window) and the AlertManager fetch in the controller.

The error/blocked classification is a shared taxonomy contract with
sql_exporter — see the "Taxonomy contract" section of
`documentation/study-error-alerting.md`. Full feature design:
`documentation/dashboard-study-health.md`.

Env: `ALERTMANAGER_URL` (optional) — base URL for the notices proxy
(in-cluster: `http://alertmanager-operated.monitoring:9093`). Unset →
`/platform/notices` returns `{ notices: [] }` and the feature is cleanly
off. All AlertManager failures are fail-soft (2s timeout, empty notices).

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
