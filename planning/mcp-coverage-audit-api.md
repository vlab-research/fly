# MCP Coverage Audit: Dashboard-Server HTTP Endpoints

**Date**: 2026-09-07  
**Scope**: Complete inventory of `/api/v1` endpoints exposed by dashboard-server, with MCP readiness assessment.  
**Ground Truth**: `dashboard-server/README.md` (Authentication, Scopes, Route Structure), `documentation/agent-api.md`, code in `dashboard-server/api/*/` and `dashboard-server/server.js`.

---

## Authentication & Authorization Context

### Scope Derivation Rules (from `api/auth/auth.core.js` and README)

All endpoints under `/api/v1` pass through `middleware/auth.js`:
1. **Auth0 RS256** (`config.JWT`) — unscoped, full access
2. **HS256** against `AUTH0_DASHBOARD_SECRET` — scoped via `TOOL_SCOPES` for `/mcp`, or path-based `ROUTE_RESOURCES` for REST

**Scope resource** is derived from the first path segment under `/api/v1`:

| Path segment | Resource | Action derivation |
|---|---|---|
| `/surveys` | `surveys` | GET=read, else=write |
| `/responses` | `responses` | GET=read, else=write |
| `/exports` | `exports` | GET=read, else=write |
| `/media` | `media` | GET=read, else=write |
| `/credentials`, `/facebook`, `/whatsapp` | `credentials` | GET=read, else=write |
| `/message-templates` | `templates` | GET=read, else=write |
| `/tickets` | `tickets` | GET=read, else=write |
| `/users` | `users` | GET=read, else=write |
| `/platform` | `platform` | GET=read, else=write |
| `/auth` | `auth` | GET=read, else=write |
| `/typeform` | `surveys` | (special: reads own Typeform token, not a credential) |
| `/mcp` | **delegated** | Per-tool in `TOOL_SCOPES` |
| `/states` (under `/surveys/:surveyName/`) | `surveys` | (shared `surveys:read`/`write`) |
| `/health` (under `/surveys/:surveyName/`) | `surveys` | (shared `surveys:read`/`write`) |
| `/users/:userId/bails` | `users` | (shared `users:read`/`write`) |
| `/users/:userId/bail-events` | `users` | (shared `users:read`/`write`) |

**Ownership scoping**: Most queries filter on `req.user.email`. Survey writes use SQL-level `INSERT … SELECT` with ownership gate.

---

## Endpoint Inventory

### `/auth`

**Scope Resource**: `auth`

#### POST `/api/v1/auth/api-token`

| Aspect | Details |
|--------|---------|
| **Scope** | `auth:write` |
| **Inputs** | Body: `{ name: string, scopes?: string[] }` |
| **Output** | `201`: `{ name, token, scopes, expiresAt }` or `400`/`403` |
| **Controller** | `api/auth/auth.routes.js#createApiToken` |
| **Service functions** | `AuthUtil.makeAPIToken`, `AuthUtil.insertIntoCredentials`, `validateScopes`, `canGrantScopes` |
| **Side effects** | INSERT into `credentials` table; token never stored, row is the credential |
| **Ownership check** | Scoped to `req.user.email` in SQL |
| **MCP-readiness** | Pure function `validateScopes`, `canGrantScopes` exist in `auth.core.js`; token minting logic is in `auth.routes.js` (controller). **NOT callable without `req`/`res`.** |

#### DELETE `/api/v1/auth/api-token?name=<name>`

| Aspect | Details |
|--------|---------|
| **Scope** | `auth:write` |
| **Inputs** | Query param: `name`; or Body: `{ name }` |
| **Output** | `200`: `{ name, revoked: true }`; `404` if not found |
| **Controller** | `api/auth/auth.routes.js#revokeApiToken` |
| **Service functions** | `Credential.deleteApiToken` |
| **Side effects** | DELETE from `credentials` table; evicts from 30s cache |
| **Ownership check** | Scoped to `req.user.email` in SQL DELETE |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

---

### `/credentials`

**Scope Resource**: `credentials` (shared with `/facebook`, `/whatsapp`)

#### POST `/api/v1/credentials`

| Aspect | Details |
|--------|---------|
| **Scope** | `credentials:write` |
| **Inputs** | Body: `{ entity: string, key: string, details: object }` |
| **Output** | `201`: credential row; `400` on duplicate `(entity, key)` pair; `500` on other errors |
| **Controller** | `api/credentials/credentials.controller.js#createCredential` |
| **Service functions** | `Credential.create` |
| **Side effects** | INSERT into `credentials` table; may write dual credential for messaging entities (see README §11.2) |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### PUT `/api/v1/credentials`

| Aspect | Details |
|--------|---------|
| **Scope** | `credentials:write` |
| **Inputs** | Body: `{ entity, key, details }` — partial or full |
| **Output** | `200`: updated credential row; `404` if `(entity, key)` not found; `500` on error |
| **Controller** | `api/credentials/credentials.controller.js#updateCredential` |
| **Service functions** | `Credential.update` |
| **Side effects** | UPDATE `credentials` table |
| **Ownership check** | Scoped to `req.user.email` in `Credential.update` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### GET `/api/v1/credentials`

| Aspect | Details |
|--------|---------|
| **Scope** | `credentials:read` |
| **Inputs** | None |
| **Output** | `200`: `[{ entity, key, details, created }, …]`; deduped to newest per `(entity, key)` |
| **Controller** | `api/credentials/credentials.controller.js#getCredentials` |
| **Service functions** | `Credential.get` |
| **Side effects** | None |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

---

### `/facebook`

**Scope Resource**: `credentials` (same as `/credentials`)

#### POST `/api/v1/facebook/exchange-token`

| Aspect | Details |
|--------|---------|
| **Scope** | `credentials:write` |
| **Inputs** | Body: `{ token: string }` — temporary OAuth token from Facebook |
| **Output** | `200`: `{ access_token: string }`; `400` on Facebook error |
| **Controller** | `api/facebook/facebook.controller.js#exchangeToken` |
| **Service functions** | HTTP POST to `https://graph.facebook.com/oauth/access_token` |
| **Side effects** | None (token only; does not write credentials) |
| **Ownership check** | None (this is a stateless OAuth helper) |
| **MCP-readiness** | No pure core; raw HTTP call. **NOT callable without `req`.** |

#### POST `/api/v1/facebook/webhooks`

| Aspect | Details |
|--------|---------|
| **Scope** | `credentials:write` |
| **Inputs** | Body: `{ pageid: string, token: string }` |
| **Output** | `201`: Facebook webhook subscription response; `400` on error |
| **Controller** | `api/facebook/facebook.controller.js#addWebhooks` |
| **Service functions** | HTTP POST to `https://graph.facebook.com/{pageid}/subscribed_apps` with fields list |
| **Side effects** | None (webhook registered with Facebook, not stored locally) |
| **Ownership check** | None (stateless) |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### POST `/api/v1/facebook/get-started`

| Aspect | Details |
|--------|---------|
| **Scope** | `credentials:write` |
| **Inputs** | Body: `{ token: string }` |
| **Output** | `201`: Facebook response; `400` on error |
| **Controller** | `api/facebook/facebook.controller.js#addGetStarted` |
| **Service functions** | HTTP POST to `https://graph.facebook.com/me/messenger_profile` with `get_started` payload |
| **Side effects** | Messenger profile updated on Facebook; nothing stored locally |
| **Ownership check** | None (stateless) |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

---

### `/whatsapp`

**Scope Resource**: `credentials` (same as `/credentials`)

#### POST `/api/v1/whatsapp/exchange-code`

| Aspect | Details |
|--------|---------|
| **Scope** | `credentials:write` |
| **Inputs** | Body: `{ code: string, phone_number_id: string, waba_id: string }` |
| **Output** | `200`: `{ access_token, phone_number_id }`; `400` on validation/parse error; `502` on WABA subscribe failure |
| **Controller** | `api/whatsapp/whatsapp.controller.js#exchangeCode` (via `makeHandlers`) |
| **Service functions** | `facebookExchangeCode(code)`, `facebookSubscribeWaba(wabaId, token)` (from `whatsapp.facebook.js`); pure validators in `whatsapp.core.js` |
| **Side effects** | Facebook OAuth code exchanged for token; WABA subscribed to webhooks via Meta Graph API |
| **Ownership check** | None (stateless OAuth exchange) |
| **MCP-readiness** | Validators (`validateExchangeInput`, `parseExchangeResponse`) are pure; parsers in `whatsapp.core.js`. **Validators are callable without `req`, but orchestration is not.** |

---

### `/surveys`

**Scope Resource**: `surveys`

#### POST `/api/v1/surveys`

| Aspect | Details |
|--------|---------|
| **Scope** | `surveys:write` |
| **Inputs** | Body: `{ survey_name, shortcode, formid, title, metadata?, translation_conf? }` |
| **Output** | `201`: full `surveys` row with `form_json`, `messages_json`, etc.; `400` on validation / Typeform error; `404` if user/Typeform credential missing; `500` on internal error |
| **Controller** | `api/surveys/survey.controller.js#postOne` |
| **Service functions** | `registerSurveyVersion` from `survey.service.js` (pure logic, delegates to queries) |
| **Side effects** | Fetches form + messages from Typeform; INSERTs into `surveys` table (append-only, `ON CONFLICT DO NOTHING`); may write `survey_settings` row if both are passed |
| **Ownership check** | Scoped to `req.user.email`; user row must exist |
| **MCP-readiness** | **YES**: `registerSurveyVersion` in `api/surveys/survey.service.js` is callable without `req`/`res`. Pure core exists in `mcp.core.js` for validation and Typeform fetching. Currently called by both REST controller and MCP tools. |

#### GET `/api/v1/surveys`

| Aspect | Details |
|--------|---------|
| **Scope** | `surveys:read` |
| **Inputs** | None |
| **Output** | `200`: `[{ id, created, shortcode, survey_name, title, metadata, translation_conf, formid, off_time, timeouts }, …]` ordered DESC by created; `400` if no email |
| **Controller** | `api/surveys/survey.controller.js#getAll` |
| **Service functions** | `Survey.retrieve` |
| **Side effects** | None |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### PUT `/api/v1/surveys/:surveyid/settings`

| Aspect | Details |
|--------|---------|
| **Scope** | `surveys:write` |
| **Inputs** | URL param: `surveyid` (UUID); Body: `{ timeouts?: array, off_time?: string }` |
| **Output** | `200`: `{ surveyid, timeouts, off_time }`; `404` if `surveyid` invalid or not owned; `500` on error |
| **Controller** | `api/surveys/survey.controller.js#putSettings` |
| **Service functions** | `Survey.update` (via query layer) |
| **Side effects** | INSERT … ON CONFLICT on `survey_settings` row; both fields overwrite (never partial merge in REST). Settings do NOT carry to new versions. |
| **Ownership check** | SQL-level: `INSERT … SELECT` gated on `surveys JOIN users WHERE email = $4`; returns `404` if no row |
| **MCP-readiness** | **YES (partial)**: MCP tool `update_survey_settings` wraps this and performs read-before-write merge (avoiding the wipe-on-omit gotcha). Service layer exists in `mcp.service.js#updateSettings`. |

---

### `/responses`

**Scope Resource**: `responses`

#### GET `/api/v1/responses`

| Aspect | Details |
|--------|---------|
| **Scope** | `responses:read` |
| **Inputs** | Query: `survey` (required, decoded), `after?` (cursor), `pageSize?` (default unknown, inferred paginated) |
| **Output** | `200`: responses; `400` if `survey` or `email` missing; `500` on error |
| **Controller** | `api/responses/response.controller.js#getAll` |
| **Service functions** | `Response.all` |
| **Side effects** | None |
| **Ownership check** | Scoped to `req.user.email` in query |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### GET `/api/v1/responses/csv`

| Aspect | Details |
|--------|---------|
| **Scope** | `responses:read` |
| **Inputs** | Query: `survey` (required, URL-decoded) |
| **Output** | Streamed CSV; `200` with `Content-Type: text/csv` and `Content-Disposition: attachment`; `500` on error |
| **Controller** | `api/responses/response.controller.js#getResponsesCSV` |
| **Service functions** | `Response.formResponses` (returns stream) |
| **Side effects** | None (read-only) |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core; streams. **NOT callable without `req`.** |

#### GET `/api/v1/responses/form-data`

| Aspect | Details |
|--------|---------|
| **Scope** | `responses:read` |
| **Inputs** | Query: `survey` (required, URL-decoded) |
| **Output** | Streamed CSV; `200` with attachment header; `500` on error |
| **Controller** | `api/responses/response.controller.js#getFormDataCSV` |
| **Service functions** | `Response.formData` (returns async generator/array) |
| **Side effects** | None |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core; streams. **NOT callable without `req`.** |

---

### `/exports`

**Scope Resource**: `exports`

#### POST `/api/v1/exports`

| Aspect | Details |
|--------|---------|
| **Scope** | `exports:write` |
| **Inputs** | Query: `survey` (required); Body: `{ export_type?, ...options }` where `export_type` ∈ {`chat_log`, `full_messages`} or defaults to `responses` |
| **Output** | `201`: `{ status: "success", export_id: string }`; `500` on error |
| **Controller** | `api/exports/exports.controller.js#generateExport` |
| **Service functions** | `Exports.insert` (writes export record to DB); Kafka message sent (async, not awaited in response) |
| **Side effects** | INSERT into `exports` table; publishes event to Kafka topic `vlab-exports` (exporter consumes async and produces presigned URL) |
| **Ownership check** | Scoped to `req.user.email` in `Exports.insert` |
| **MCP-readiness** | No pure core; writes to Kafka. **NOT callable without `req`.** |

#### GET `/api/v1/exports/status`

| Aspect | Details |
|--------|---------|
| **Scope** | `exports:read` |
| **Inputs** | None |
| **Output** | `200`: `{ responses: [{ export_id, status, url?, email, survey, ...metadata }, …] }`; `400` if no email |
| **Controller** | `api/exports/exports.controller.js#getAll` |
| **Service functions** | `Exports.all` |
| **Side effects** | None |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### GET `/api/v1/exports/status/survey`

| Aspect | Details |
|--------|---------|
| **Scope** | `exports:read` |
| **Inputs** | Query: `survey` (required) |
| **Output** | `200`: `{ responses: […] }`; `400` if `survey` or `email` missing |
| **Controller** | `api/exports/exports.controller.js#getBySurvey` |
| **Service functions** | `Exports.bySurvey` |
| **Side effects** | None |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

---

### `/media`

**Scope Resource**: `media`

#### POST `/api/v1/media/upload`

| Aspect | Details |
|--------|---------|
| **Scope** | `media:write` |
| **Inputs** | Multipart: `file` (required); Multer size cap: derived max of `MEDIA_TYPE_LIMITS` (100 MB for documents) |
| **Output** | `201` (new asset) or `200` (dedupe hit): `{ id, filename, mediaType, mimeType, byteSize, created, url }`; `400` on validation error; `500` on storage error |
| **Controller** | `api/media/media.controller.js#uploadMedia` (via `makeHandlers`) |
| **Service functions** | `validateUpload`, `hashContent`, `buildAssetRecord` (pure core); `Media.create`, `Media.findByHash`, `Credential.getMessagingAccounts` (queries); `storage.put`, `uploadToPlatform` (IO) |
| **Side effects** | Writes object to S3/MinIO; INSERTs into `media_asset` table (dedupe by `userid, content_hash`); UPSERTs `media_handle` rows per account (fan-out is fire-and-forget, does not block response) |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | **Partial**: `validateUpload`, `hashContent`, `buildAssetRecord` are pure in `media.core.js` and callable without IO. Orchestration and fan-out are not. **NOT ready for MCP without service wrapper.** |

#### GET `/api/v1/media`

| Aspect | Details |
|--------|---------|
| **Scope** | `media:read` |
| **Inputs** | None |
| **Output** | `200`: `[{ id, filename, mediaType, mimeType, byteSize, created, url }, …]` newest first; `500` on error |
| **Controller** | `api/media/media.controller.js#listMedia` |
| **Service functions** | `Media.list` |
| **Side effects** | None |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

**Note**: `DELETE /media/:id` is deliberately **NOT** offered in v1 (see README §11.6).

---

### `/message-templates`

**Scope Resource**: `templates`

#### POST `/api/v1/message-templates`

| Aspect | Details |
|--------|---------|
| **Scope** | `templates:write` |
| **Inputs** | Body: `{ accountId (or legacy pageId), name, language, body, buttons?, examples? }` |
| **Output** | `201`: `{ id, name, language, platform, fb_template_id, status }`; `400` on validation; `404` if account not found; `502` if Facebook/WhatsApp API fails; `500` other |
| **Controller** | `api/message-templates/message-templates.controller.js#create` |
| **Service functions** | `Credential.getOne` (resolves page or WABA); pure validators in `message-templates.core.js`; Facebook/WhatsApp template creation (HTTP POST) |
| **Side effects** | Template created on Meta via Graph API; INSERTs into local `message_template` table |
| **Ownership check** | Scoped to `req.user.email` in credential lookup |
| **MCP-readiness** | Validators (`validateCreateInput`) are pure; orchestration is not. **NOT ready for MCP.** |

#### GET `/api/v1/message-templates`

| Aspect | Details |
|--------|---------|
| **Scope** | `templates:read` |
| **Inputs** | None (returns all caller's templates) |
| **Output** | `200`: `[{ id, name, language, platform, fb_template_id, status }, …]`; `500` on error |
| **Controller** | `api/message-templates/message-templates.controller.js#list` |
| **Service functions** | `MessageTemplate.list` |
| **Side effects** | None |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### GET `/api/v1/message-templates/:id`

| Aspect | Details |
|--------|---------|
| **Scope** | `templates:read` |
| **Inputs** | URL param: `id` |
| **Output** | `200`: one template object; `404` if not found; `500` on error |
| **Controller** | `api/message-templates/message-templates.controller.js#getOne` |
| **Service functions** | `MessageTemplate.getOne` |
| **Side effects** | None |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### DELETE `/api/v1/message-templates/:id`

| Aspect | Details |
|--------|---------|
| **Scope** | `templates:write` |
| **Inputs** | URL param: `id` |
| **Output** | `204` (no content); `404` if not found; `502` if Meta API fails; `500` other |
| **Controller** | `api/message-templates/message-templates.controller.js#remove` |
| **Service functions** | Credential lookup, template deletion via Meta Graph API, local DELETE |
| **Side effects** | Template deleted from Meta; deleted from local `message_template` table |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core. **NOT ready for MCP.** |

---

### `/typeform`

**Scope Resource**: `surveys` (reads Typeform token, not credentials)

#### GET `/api/v1/typeform/auth/:code`

| Aspect | Details |
|--------|---------|
| **Scope** | `surveys:write` (mints Typeform credential as side effect) |
| **Inputs** | URL param: `code` (from Typeform OAuth callback) |
| **Output** | `201`: credential row; `500` on error |
| **Controller** | `api/typeform/typeform.controller.js#authorize` |
| **Service functions** | `TypeformUtil.TypeformToken(code)` (HTTP POST to Typeform); `Credential.create` |
| **Side effects** | Exchanges OAuth code for Typeform access token; INSERTs into `credentials` table with `entity: 'typeform_token'` |
| **Ownership check** | Scoped to `req.user.email` |
| **MCP-readiness** | No pure core; OAuth exchange. **NOT callable without `req`.** |

#### GET `/api/v1/typeform/form`

| Aspect | Details |
|--------|---------|
| **Scope** | `surveys:read` |
| **Inputs** | None (reads Typeform token for caller's email) |
| **Output** | `200`: array of forms from Typeform; `401` if no token; `500` on error |
| **Controller** | `api/typeform/typeform.controller.js#getForm` |
| **Service functions** | `Credential.getOne`, `TypeformUtil.TypeformFormList(token)` (HTTP GET) |
| **Side effects** | None |
| **Ownership check** | Scoped to `req.user.email` in credential lookup |
| **MCP-readiness** | No pure core; HTTP call. **NOT callable without `req`.** |

---

### `/tickets`

**Scope Resource**: `tickets`

#### GET `/api/v1/tickets`

| Aspect | Details |
|--------|---------|
| **Scope** | `tickets:read` |
| **Inputs** | None |
| **Output** | `200`: `[{ id, identifier, url, title, state, priority, createdAt, updatedAt }, …]` (caller's only, newest first); `503` if Linear not configured; `502` if Linear API fails |
| **Controller** | `api/tickets/tickets.controller.js#list` |
| **Service functions** | `linearClient.listTeamIssues()`, pure filter `filterByReporter(issues, email)`, sort `sortByCreatedDesc` |
| **Side effects** | None (read-only from Linear) |
| **Ownership check** | Reporter sentinel in issue description must match `req.user.email` |
| **MCP-readiness** | Filter and sort are pure; Linear client is not. **NOT ready for MCP.** |

#### POST `/api/v1/tickets`

| Aspect | Details |
|--------|---------|
| **Scope** | `tickets:write` |
| **Inputs** | Body: `{ title (required), description (required), surveyName?, userIds? }` |
| **Output** | `201`: `{ id, identifier, url, title, state, priority, createdAt, updatedAt }`; `400` on validation; `503` if not configured; `502` if Linear fails |
| **Controller** | `api/tickets/tickets.controller.js#create` |
| **Service functions** | Pure `buildIssueDescription` (formats context block + sentinel); `linearClient.createIssue()` |
| **Side effects** | Issue created in Linear with formatted description (context + sentinel); nothing stored locally |
| **Ownership check** | Sentinel `*vlab-reporter:email*` embedded in description |
| **MCP-readiness** | `buildIssueDescription` is pure; orchestration is not. **NOT ready for MCP.** |

#### GET `/api/v1/tickets/:id`

| Aspect | Details |
|--------|---------|
| **Scope** | `tickets:read` |
| **Inputs** | URL param: `id` |
| **Output** | `200`: issue + flattened comments; `404` if missing or not owned; `503` if not configured; `502` if Linear fails |
| **Controller** | `api/tickets/tickets.controller.js#getOne` |
| **Service functions** | `linearClient.getIssue()`, pure `isReporterIssue()` ownership check |
| **Side effects** | None |
| **Ownership check** | Sentinel in description must match `req.user.email`; `404` if mismatch (not `403`) |
| **MCP-readiness** | Ownership check is pure; fetch is not. **NOT ready for MCP.** |

#### POST `/api/v1/tickets/:id/replies`

| Aspect | Details |
|--------|---------|
| **Scope** | `tickets:write` |
| **Inputs** | URL param: `id`; Body: `{ body (required) }` |
| **Output** | `201`: synthesized comment `{ id, body, createdAt, author, reporterEmail }`; `404` if not owned; `503` if not configured; `502` if Linear fails |
| **Controller** | `api/tickets/tickets.controller.js#reply` |
| **Service functions** | `linearClient.getIssue()`, pure `buildReplyBody()`, `linearClient.createComment()` |
| **Side effects** | Comment created in Linear with reporter sentinel appended; synthesized response returned (Linear comment id + formatted body) |
| **Ownership check** | Ownership checked before reply creation |
| **MCP-readiness** | `buildReplyBody` is pure; orchestration is not. **NOT ready for MCP.** |

---

### `/users`

**Scope Resource**: `users`

#### POST `/api/v1/users`

| Aspect | Details |
|--------|---------|
| **Scope** | `users:write` |
| **Inputs** | Body: passed as `req.user` (already parsed) |
| **Output** | `200`: user row; `500` on error |
| **Controller** | `api/users/users.controller.js#createUser` |
| **Service functions** | `User.create` |
| **Side effects** | INSERTs into `users` table; called as part of dashboard onboarding (not typical API flow) |
| **Ownership check** | N/A (creates for authenticated user) |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

---

### `/users/:userId/bails`

**Scope Resource**: `users` (shared). Accessed via `validateUserAccess` middleware.

#### GET `/api/v1/users/:userId/bails`

| Aspect | Details |
|--------|---------|
| **Scope** | `users:read` |
| **Inputs** | URL param: `userId` |
| **Output** | `200`: array of bails; `403` if user mismatch; `500` on error |
| **Controller** | `api/bails/bails.controller.js#listBails` |
| **Service functions** | `BailsUtil.listBails` |
| **Side effects** | None |
| **Ownership check** | `validateUserAccess` middleware checks `req.user.email` matches `User.id` for `userId` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### POST `/api/v1/users/:userId/bails`

| Aspect | Details |
|--------|---------|
| **Scope** | `users:write` |
| **Inputs** | URL param: `userId`; Body: `{ name (required), definition (required), description?, destination_form? }` |
| **Output** | `201`: bail object; `400` if required fields missing; `403` if user mismatch; `500` on error |
| **Controller** | `api/bails/bails.controller.js#createBail` |
| **Service functions** | `BailsUtil.createBail` |
| **Side effects** | INSERTs into bails table |
| **Ownership check** | `validateUserAccess` middleware |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### POST `/api/v1/users/:userId/bails/preview`

| Aspect | Details |
|--------|---------|
| **Scope** | `users:write` (dry-run, but not a write) |
| **Inputs** | URL param: `userId`; Body: `{ definition (required) }` |
| **Output** | `200`: preview result; `400` if definition missing; `403` if user mismatch; `500` on error |
| **Controller** | `api/bails/bails.controller.js#previewBail` |
| **Service functions** | `BailsUtil.previewBail` |
| **Side effects** | None (query preview only) |
| **Ownership check** | `validateUserAccess` middleware |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### GET `/api/v1/users/:userId/bails/:bailId`

| Aspect | Details |
|--------|---------|
| **Scope** | `users:read` |
| **Inputs** | URL params: `userId`, `bailId` |
| **Output** | `200`: bail object; `403` if user mismatch; `404` if bail not found; `500` on error |
| **Controller** | `api/bails/bails.controller.js#getBail` |
| **Service functions** | `BailsUtil.getBail` |
| **Side effects** | None |
| **Ownership check** | `validateUserAccess` middleware |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### PUT `/api/v1/users/:userId/bails/:bailId`

| Aspect | Details |
|--------|---------|
| **Scope** | `users:write` |
| **Inputs** | URL params: `userId`, `bailId`; Body: `{ name?, description?, definition?, enabled?, destination_form? }` (partial) |
| **Output** | `200`: updated bail; `403` if user mismatch; `404` if bail not found; `500` on error |
| **Controller** | `api/bails/bails.controller.js#updateBail` |
| **Service functions** | `BailsUtil.updateBail` |
| **Side effects** | UPDATEs bails table |
| **Ownership check** | `validateUserAccess` middleware |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### DELETE `/api/v1/users/:userId/bails/:bailId`

| Aspect | Details |
|--------|---------|
| **Scope** | `users:write` |
| **Inputs** | URL params: `userId`, `bailId` |
| **Output** | `204` (no content); `403` if user mismatch; `500` on error |
| **Controller** | `api/bails/bails.controller.js#deleteBail` |
| **Service functions** | `BailsUtil.deleteBail` |
| **Side effects** | DELETEs from bails table |
| **Ownership check** | `validateUserAccess` middleware |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### GET `/api/v1/users/:userId/bails/:bailId/events`

| Aspect | Details |
|--------|---------|
| **Scope** | `users:read` |
| **Inputs** | URL params: `userId`, `bailId` |
| **Output** | `200`: array of events; `403` if user mismatch; `500` on error |
| **Controller** | `api/bails/bails.controller.js#getBailEvents` |
| **Service functions** | `BailsUtil.getBailEvents` |
| **Side effects** | None |
| **Ownership check** | `validateUserAccess` middleware |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

---

### `/users/:userId/bail-events`

**Scope Resource**: `users`

#### GET `/api/v1/users/:userId/bail-events`

| Aspect | Details |
|--------|---------|
| **Scope** | `users:read` |
| **Inputs** | URL param: `userId`; Query: `limit?` (default 100) |
| **Output** | `200`: array of events; `403` if user mismatch; `500` on error |
| **Controller** | `api/bails/bails.controller.js#getUserEvents` |
| **Service functions** | `BailsUtil.getUserEvents` |
| **Side effects** | None |
| **Ownership check** | `validateUserAccess` middleware (reused from `/bails` route) |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

---

### `/surveys/:surveyName/states`

**Scope Resource**: `surveys`. Accessed via `validateSurveyNameAccess` middleware (shared with `/health`).

#### GET `/api/v1/surveys/:surveyName/states/summary`

| Aspect | Details |
|--------|---------|
| **Scope** | `surveys:read` |
| **Inputs** | URL param: `surveyName` |
| **Output** | `200`: `{ state_counts: {...}, form_counts: {...}, error_tag_counts: {...} }`; `403` if survey not owned; `500` on error |
| **Controller** | `api/states/states.controller.js#getSummary` |
| **Service functions** | `States.summary` (via `statesQueries`) |
| **Side effects** | None |
| **Ownership check** | `validateSurveyNameAccess` middleware resolves shortcodes and checks `req.user.email` |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### GET `/api/v1/surveys/:surveyName/states`

| Aspect | Details |
|--------|---------|
| **Scope** | `surveys:read` |
| **Inputs** | URL param: `surveyName`; Query: `state?`, `error_tag?`, `form?`, `search?` (userid substring), `limit?` (default 50), `offset?` (default 0) |
| **Output** | `200`: `{ items: [...], total }`; `403` if not owned; `500` on error |
| **Controller** | `api/states/states.controller.js#listStates` |
| **Service functions** | `States.list` |
| **Side effects** | None |
| **Ownership check** | `validateSurveyNameAccess` middleware |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

#### GET `/api/v1/surveys/:surveyName/states/:userid`

| Aspect | Details |
|--------|---------|
| **Scope** | `surveys:read` |
| **Inputs** | URL params: `surveyName`, `userid` |
| **Output** | `200`: state detail object (includes `state_json`); `404` if not found; `403` if survey not owned; `500` on error |
| **Controller** | `api/states/states.controller.js#getStateDetail` |
| **Service functions** | `States.detail` |
| **Side effects** | None |
| **Ownership check** | `validateSurveyNameAccess` middleware |
| **MCP-readiness** | No pure core. **NOT callable without `req`.** |

---

### `/surveys/:surveyName/health`

**Scope Resource**: `surveys`. Accessed via `validateSurveyNameAccess` middleware (shared with `/states`).

#### GET `/api/v1/surveys/:surveyName/health`

| Aspect | Details |
|--------|---------|
| **Scope** | `surveys:read` |
| **Inputs** | URL param: `surveyName` |
| **Output** | `200`: `{ window_hours, findings: [{ category, severity, count, ...}], aggregates: {...} }`; `403` if not owned; `500` on error |
| **Controller** | `api/health/health.controller.js#getHealth` |
| **Service functions** | `States.healthSummary` (24h window), pure `buildAggregates`, pure `evaluate(aggregates, rules)` |
| **Side effects** | None (read-only) |
| **Ownership check** | `validateSurveyNameAccess` middleware |
| **MCP-readiness** | `buildAggregates` and `evaluate` are pure in `health/aggregate.js` and `health/evaluate.js`. Query is not. **Partial.** |

---

### `/platform/notices`

**Scope Resource**: `platform`

#### GET `/api/v1/platform/notices`

| Aspect | Details |
|--------|---------|
| **Scope** | `platform:read` |
| **Inputs** | None |
| **Output** | `200`: `{ notices: [{ alertname, severity, message, ...}, …] }`; always `200` even on AlertManager failure (fail-soft) |
| **Controller** | `api/health/health.controller.js#getPlatformNotices` (via `platform.routes.js`) |
| **Service functions** | HTTP GET to AlertManager `/api/v2/alerts` (2s timeout); pure `translateAlerts` |
| **Side effects** | None (read-only; AlertManager URL is optional per env) |
| **Ownership check** | None (platform-wide, all authenticated users see same notices) |
| **MCP-readiness** | `translateAlerts` is pure; fetch is not. Feature is fail-soft (returns empty on misconfiguration). **NOT ready for MCP.** |

---

### `/mcp`

**Scope Resource**: `mcp` (delegated per-tool via `TOOL_SCOPES`)

#### POST `/api/v1/mcp`

| Aspect | Details |
|--------|---------|
| **Method** | POST only (stateless) |
| **Inputs** | JSON-RPC 2.0 message: `{ jsonrpc: "2.0", method: "<tool-name>", params: {...}, id }`; valid tools: `list_surveys`, `create_typeform_form`, `create_survey`, `create_survey_version`, `update_survey_settings` |
| **Output** | `200`: JSON-RPC response `{ jsonrpc, result: {…}, id }` on success or `{ jsonrpc, error: {code, message}, id }` on tool error; `400` on JSON parse error; `405` on GET/DELETE; `500` on transport error |
| **Transport** | `StreamableHTTPServerTransport` (stateless, no session id) |
| **Auth** | Same as rest of API: Auth0 RS256 or HS256 API key via `middleware/auth.js` |
| **Scope enforcement** | Per-tool in `TOOL_SCOPES` (in `mcp.tools.js`): `list_surveys` → `surveys:read`; write tools → `surveys:write` |
| **Controller** | `api/mcp/mcp.routes.js#handlePost` → `buildServer` (one server per request) → `runTool` (dispatch) |
| **Orchestration** | `mcp.tools.js#runTool`: validates args against JSON Schema, checks scopes, dispatches to handler |
| **Handlers** | Five tool handlers in `mcp.tools.js#TOOL_HANDLERS`: `list_surveys`, `create_typeform_form`, `create_survey`, `create_survey_version`, `update_survey_settings` |
| **Service layer** | `mcp.service.js`: `listSurveys`, `registerSurveyVersion`, `createTypeformForm`, `updateSettings` |
| **Core layer** | `mcp.core.js`: pure validators, decision functions (e.g. `surveyNameExists`, `resolvePreviousVersion`) and tool descriptions (JSON Schema, instructions) |
| **Side effects** | Varies per tool (see below) |
| **Ownership check** | Scoped to `req.user.email` in all handlers |
| **MCP-readiness** | **YES, partially**: Five tools exist and are functional. `registerSurveyVersion` is reused from REST path. Validators and decision logic are pure. |

**MCP Tool Scope Mapping** (`TOOL_SCOPES`):

| Tool | Scope | Side effects | Calls |
|------|-------|-----------|-------|
| `list_surveys` | `surveys:read` | None (read-only) | `service.listSurveys` → `Survey.retrieve` |
| `create_typeform_form` | `surveys:write` | Creates form in Typeform (HTTP POST); does NOT create Fly survey | `service.createTypeformForm` → `Typeform.createForm` (via `mcp.typeform.js`) |
| `create_survey` | `surveys:write` | Fetches Typeform form; INSERTs survey + settings | `service.registerSurveyVersion` (same as REST POST) |
| `create_survey_version` | `surveys:write` | Same as `create_survey` but enforces shortcode exists | `service.registerSurveyVersion` |
| `update_survey_settings` | `surveys:write` | UPSERTs `survey_settings` row; **reads before writes** (merges, doesn't wipe) | `service.updateSettings` which reads then writes |

#### GET `/api/v1/mcp`
| Aspect | Details |
|--------|---------|
| **Response** | `405 Method Not Allowed` with `Allow: POST` header |

#### DELETE `/api/v1/mcp`
| Aspect | Details |
|--------|---------|
| **Response** | `405 Method Not Allowed` with `Allow: POST` header |

---

## Cube.js Analytics Schema

**Endpoint**: `/cubejs-api` (added by `CubejsServerCore.initApp` in `index.js`)

**Auth**: Same middleware applied; inherits `req.user.email` for scoping.

**Cubes defined** (in `schema/`):

### Responses Cube

**SQL**: `SELECT * FROM responses`

**Measures**:
- `count` — row count
- `uniqueUserCount` — distinct `userid`
- `startTime` — min `timestamp`
- `endTime` — max `timestamp`

**Dimensions**:
- `formid` — `surveyid` (mapped name)
- `userid` — `userid`
- `flowid` — `flowid`
- `timestamp` — `timestamp` (time dimension)
- `response` — `response` (string)
- `questionId` — `question_idx` (mapped name)

### LastQuestions Cube

**SQL**: Lateral subquery picking the latest response per `(userid, parent_surveyid)` by `timestamp DESC`

**Measures**:
- `count` — row count

**Dimensions**:
- `formid` — `surveyid`
- `timestamp` — `timestamp` (time)
- `response` — `response`
- `questionRef` — `question_ref`
- `questionText` — `question_text`

**Note**: No ownership/scoping baked into Cube.js schema; `checkAuthMiddleware` is responsible. The middleware verifies the token and passes `req.user.email`, but Cube.js does not enforce filtering by email at the schema level — that must be handled elsewhere or assumed to be done by the client.

---

## Current MCP Tool Coverage

The dashboard-server exposes exactly **five MCP tools**, all survey-related:

1. **`list_surveys`** — calls `service.listSurveys` (maps to `Survey.retrieve`)
2. **`create_typeform_form`** — calls `service.createTypeformForm` (creates form in Typeform, does not create Fly survey)
3. **`create_survey`** — calls `service.registerSurveyVersion` (same as `POST /surveys`)
4. **`create_survey_version`** — calls `service.registerSurveyVersion` with version-override logic
5. **`update_survey_settings`** — calls `service.updateSettings` (reads then merges, unlike REST PUT)

**Reused shared function**: `registerSurveyVersion` in `api/surveys/survey.service.js` is the single implementation used by both REST and MCP.

---

## Endpoints NOT Reachable by Scoped API Keys

| Endpoint | Reason |
|----------|--------|
| All top-level routes not in `ROUTE_RESOURCES` | `ROUTE_RESOURCES` in `auth.core.js` defines the complete whitelist; absent paths return `403` to scoped keys. **Any new top-level route must be added to `ROUTE_RESOURCES`.** |
| `/health` (no auth required, ever) | Actually **passes auth middleware** but `/health` is a server-level, non-API route responding with string "hola". Never accessible through `/api/v1`. |

---

## Endpoints with No Ownership Check or Surprising Scope Mapping

| Endpoint | Issue | Details |
|----------|-------|---------|
| **`POST /facebook/exchange-token`** | No ownership check | Stateless OAuth exchange; no row written; caller identity not enforced. Scope is `credentials:write` but it's really a helper. |
| **`POST /facebook/webhooks`** | No ownership check | Registers webhook on Facebook; caller identity not enforced. Scope is `credentials:write`. |
| **`POST /facebook/get-started`** | No ownership check | Updates Messenger profile on Facebook; no local storage. Scope is `credentials:write`. |
| **`POST /whatsapp/exchange-code`** | No ownership check | OAuth code exchange + WABA subscription; caller identity not enforced (but WABA must be owned by the account). Scope is `credentials:write`. |
| **`GET /platform/notices`** | No scoping | Returns platform-wide notices to all authenticated users; no per-user or per-survey filtering. Scope is `platform:read`. |
| **`/typeform/form` counts as `surveys:read`** | Surprising mapping | `/typeform` maps to `surveys` resource (not `credentials`) so a `surveys:read` key can read Typeform forms. Reason: Typeform is where survey content is authored; the token is the researcher's own and stays unreadable through `/credentials`. **Documented in README.** |
| **`/surveys/:surveyName/states` and `/health`** | Shared scope | Both map to `surveys:read`/`write`, so a `surveys:read` key sees participant state data (summary + detail). This is intentional — states are part of survey monitoring. **Documented in README.** |

---

## Large/Async Endpoints

**Synchronous but potentially large** (buffered bodies):

| Endpoint | Issue | Details |
|----------|-------|---------|
| `GET /responses/csv` | CSV stream | Streams response; no size cap enforced at API level (query limit is application-dependent) |
| `GET /responses/form-data` | CSV stream | Same as above |
| `GET /surveys` | Unbounded list | Returns all caller's surveys (all `survey_name`s, all shortcodes, all versions) with no pagination. Typically small (10–100 rows) but technically unbounded. |
| `POST /surveys` | Large response | Response is full `surveys` row including `form_json` and `messages_json`, often 100s of KB (entire Typeform document). **Read `id` and discard the rest.** (Documented in `agent-api.md`.) |

**Asynchronous** (return id, poll status):

| Endpoint | Async mechanism | Status endpoint |
|----------|---|---|
| `POST /exports` | Publishes to Kafka topic `vlab-exports`; exporter consumes and produces presigned URL | `GET /exports/status` (list all) or `GET /exports/status/survey` (by survey) |

---

## Docs vs. Code: Gaps and Discrepancies

### Routes listed in README but code check needed

| Route (from README) | Actual status | Notes |
|---|---|---|
| `/responses` | ✓ Exists (GET list, GET csv, GET form-data) | Docs call it "Survey response data"; implemented. |
| `/surveys` | ✓ Exists (POST create, GET list, PUT settings) | Docs correct. |
| `/users` | ✓ Exists (POST create, GET bails scoped, GET bail-events) | Docs call it "Account operations"; implemented but minimal (only `createUser` at POST root). |
| `/exports` | ✓ Exists (POST generate, GET status variants) | Docs say "Async data export (via Kafka)"; correct. |
| `/typeform` | ✓ Exists (GET auth/:code OAuth, GET form list) | Docs brief but correct. |
| `/credentials` | ✓ Exists (POST create, PUT update, GET list) | Docs mention dual-write for messaging. |
| `/facebook` | ✓ Exists (POST exchange-token, webhooks, get-started) | Docs minimal. |
| `/auth` | ✓ Exists (POST api-token, DELETE api-token) | Docs mention key management. |
| `/mcp` | ✓ Exists (POST only) | Docs say "five survey tools"; correct. |
| `/media` | ✓ Exists (POST upload, GET list) | Docs extensive (§11, media-abstraction.md). `DELETE` deliberately NOT in v1. |
| `/message-templates` | ✓ Exists (POST create, GET list/single, DELETE) | Docs call it "Utility Message templates"; correct. |
| `/tickets` | ✓ Exists (GET list, POST create, GET one, POST reply) | Docs call it "Support tickets"; correct. |
| `/users/:userId/bails` | ✓ Exists (GET list, POST create/preview, GET one, PUT update, DELETE, GET events) | Docs mention it in route list. |
| `/surveys/:surveyName/states` | ✓ Exists (GET summary, GET list, GET detail) | Docs extensive (states-debugging.md); correct. |
| `/surveys/:surveyName/health` | ✓ Exists (GET health) | Docs extensive (dashboard-study-health.md); correct. |
| `/platform/notices` | ✓ Exists (GET notices from AlertManager proxy) | Docs mention platform notices banner; correct. |

### Routes in code but not documented or under-documented

| Route | Documentation | Status |
|---|---|---|
| All routes | `agent-api.md` (MCP only) | Agent-focused docs; REST API surface not formally specified in one place. **README covers conceptually but not a formal endpoint inventory.** |
| `/users/:userId/bail-events` | README mentions but minimal | Endpoint exists; docs brief. |
| `/whatsapp/exchange-code` | README mentions "WhatsApp integration" but no detail | Endpoint exists; implementation is `whatsapp.controller.js`. |

### Behavior differences between docs and code

| Area | Documented | Actual code | Issue |
|---|---|---|---|
| `metadata` and `translation_conf` defaults on `POST /surveys` | Docs say "omit for default `{}`" | Code crashes if both omitted (dereferencing before validation) | **VIR-37 fixed this for MCP but REST endpoint still has the bug.** |
| `PUT /surveys/:surveyid/settings` | Docs say "replace, never patch" | Code confirms: both fields overwritten, omitted fields become NULL | ✓ Correct, but gotcha-prone. MCP tool works around it by reading then merging. |
| Survey version resolution | Docs say "by timestamp, not pointer" | Code in `formcentral/db.go` matches: `created <= $3, ORDER BY created DESC LIMIT 1` | ✓ Correct. |
| Typeform token scope mapping | Docs say "`/typeform` is `surveys`, not `credentials`" | Code in `auth.core.js` confirms: `ROUTE_RESOURCES['/typeform'] = 'surveys'` | ✓ Correct. |
| Response size on `POST /surveys` | Docs say "large, often hundreds of KB" | Code returns full row via `RETURNING *` | ✓ Correct; client should read `id` and discard. |

---

## Ownership and Scoping Patterns Observed

### Pattern 1: Middleware checks (path-param routes)

**Routes**: `/users/:userId/bails`, `/surveys/:surveyName/states`, `/surveys/:surveyName/health`

**Implementation**: Middleware (`validateUserAccess`, `validateSurveyNameAccess`) runs before handler:
- Loads caller's data (user or surveys list)
- Filters to matching rows
- `403` if none match; `401` if no email
- Sets `req.vlabUser`, `req.surveyEmail`, `req.surveyName`, `req.surveyShortcodes` for handler

### Pattern 2: SQL-level scoping (write routes)

**Routes**: `/surveys/:surveyid/settings` (PUT)

**Implementation**: Query is an `INSERT … SELECT` gated on `surveys JOIN users WHERE users.email = $4`:
- SELECT yields no row if survey not owned → no write → `404` (not `403`)
- `404` never confirms survey id to owner

### Pattern 3: Table-level filtering (read routes)

**Routes**: `/responses`, `/exports`, `/credentials`, `/media`, everything else

**Implementation**: Query `WHERE email = $1` filters to caller's rows in application code

### Pattern 4: Sentinel-based scoping (no local storage)

**Route**: `/tickets` (Linear proxy)

**Implementation**: Linear issue description ends with `*vlab-reporter:email*` sentinel:
- **List**: fetches team's issues, filters server-side by sentinel
- **Get**: fetches issue, checks sentinel, `404` if mismatch
- **Create**: embeds sentinel in description
- **Reply**: appends sentinel to comment body

---

## API Key Scope Semantics

### Granted scopes vs. effective scopes

| Scenario | Token claim | Credential row | Effective | Notes |
|----------|---|---|---|---|
| Newly minted key | `scopes: ["surveys:read"]` | `details.scopes: ["surveys:read"]` | `["surveys:read"]` | Both agree; new keys get 90d `exp`. |
| Legacy key (pre-VIR-37) | `scopes: undefined` | `details.scopes: undefined` | `undefined` → unrestricted | Unrestricted keys are backward-compat. |
| Narrowed key (edited row) | `scopes: ["surveys:read"]` | `details.scopes: null` or narrower | Credential row wins | `effectiveScopes` prefers row over token. |
| Internal service JWT | `iat, exp` (no `scopes`, no `jti`) | N/A (no lookup) | Unrestricted | replybot/hermes tokens have no row. |

### Error messages on scope refusal

**Transport**: `403` with body:
```json
{ "error": { "message": "required scope name; you hold scopes X, Y" } }
```

**MCP tool error** (not transport 403):
```json
{ "jsonrpc": "2.0", "error": { "code": -32001, "message": "This API key is not permitted to use \"tool_name\". It needs the scope:read scope; it has no scopes." } }
```

---

## Summary Table: All Endpoints

| HTTP Verb + Path | Scope | Service function | Inputs | Output | Ownership | MCP-ready |
|---|---|---|---|---|---|---|
| POST `/auth/api-token` | auth:write | `AuthUtil.makeAPIToken`, `insertIntoCredentials` | name, scopes? | 201: {token, scopes, expiresAt} | req.user.email | NO |
| DELETE `/auth/api-token?name=` | auth:write | `Credential.deleteApiToken` | name | 200 or 404 | req.user.email | NO |
| POST `/credentials` | credentials:write | `Credential.create` | entity, key, details | 201 or 400/500 | req.user.email | NO |
| PUT `/credentials` | credentials:write | `Credential.update` | entity, key, details | 200 or 404 | req.user.email | NO |
| GET `/credentials` | credentials:read | `Credential.get` | - | 200: array | req.user.email | NO |
| POST `/facebook/exchange-token` | credentials:write | Facebook OAuth | token | 200: {access_token} | none | NO |
| POST `/facebook/webhooks` | credentials:write | Facebook Graph | pageid, token | 201 or 400 | none | NO |
| POST `/facebook/get-started` | credentials:write | Facebook Graph | token | 201 or 400 | none | NO |
| POST `/whatsapp/exchange-code` | credentials:write | Facebook OAuth + WABA subscribe | code, phone_number_id, waba_id | 200 or 400/502 | none (OAuth) | PARTIAL |
| POST `/surveys` | surveys:write | `registerSurveyVersion` | formid, shortcode, survey_name, title, metadata?, translation_conf? | 201 or 400/404/500 | req.user.email + SQL | YES |
| GET `/surveys` | surveys:read | `Survey.retrieve` | - | 200: array | req.user.email | NO |
| PUT `/surveys/:surveyid/settings` | surveys:write | `Survey.update` | surveyid, timeouts?, off_time? | 200 or 404 | SQL gate | YES (via MCP wrapper) |
| GET `/responses` | responses:read | `Response.all` | survey, after?, pageSize? | 200 or 400 | req.user.email | NO |
| GET `/responses/csv` | responses:read | `Response.formResponses` | survey | 200: CSV stream | req.user.email | NO |
| GET `/responses/form-data` | responses:read | `Response.formData` | survey | 200: CSV stream | req.user.email | NO |
| POST `/exports` | exports:write | `Exports.insert`, Kafka publish | survey, export_type?, options | 201: {export_id} | req.user.email | NO |
| GET `/exports/status` | exports:read | `Exports.all` | - | 200: array | req.user.email | NO |
| GET `/exports/status/survey` | exports:read | `Exports.bySurvey` | survey | 200: array | req.user.email | NO |
| POST `/media/upload` | media:write | `validateUpload`, `hashContent`, `Media.create`, S3 put, fan-out | file (multipart) | 201/200: {url, ...} | req.user.email | PARTIAL |
| GET `/media` | media:read | `Media.list` | - | 200: array | req.user.email | NO |
| POST `/message-templates` | templates:write | Meta Graph + `MessageTemplate.insert` | accountId, name, language, body, buttons?, examples? | 201 or 400/404/502 | req.user.email + cred lookup | NO |
| GET `/message-templates` | templates:read | `MessageTemplate.list` | - | 200: array | req.user.email | NO |
| GET `/message-templates/:id` | templates:read | `MessageTemplate.getOne` | id | 200 or 404 | req.user.email | NO |
| DELETE `/message-templates/:id` | templates:write | Meta Graph + DB DELETE | id | 204 or 404/502 | req.user.email | NO |
| GET `/typeform/auth/:code` | surveys:write | `TypeformUtil.TypeformToken`, `Credential.create` | code | 201 or 500 | req.user.email | NO |
| GET `/typeform/form` | surveys:read | `Credential.getOne`, `TypeformUtil.TypeformFormList` | - | 200: form array or 401 | req.user.email | NO |
| GET `/tickets` | tickets:read | `linearClient.listTeamIssues`, filter by sentinel | - | 200: array | sentinel match | NO |
| POST `/tickets` | tickets:write | `linearClient.createIssue` | title, description, surveyName?, userIds? | 201 or 400/503/502 | req.user.email (embedded) | NO |
| GET `/tickets/:id` | tickets:read | `linearClient.getIssue`, verify sentinel | id | 200 or 404/502 | sentinel match | NO |
| POST `/tickets/:id/replies` | tickets:write | `linearClient.createComment` | id, body | 201 or 404/502 | sentinel match | NO |
| POST `/users` | users:write | `User.create` | (from req.user) | 200 or 500 | req.user.email | NO |
| GET `/users/:userId/bails` | users:read | `BailsUtil.listBails` | userId | 200 or 403 | middleware check | NO |
| POST `/users/:userId/bails` | users:write | `BailsUtil.createBail` | userId, name, definition, description?, destination_form? | 201 or 400/403 | middleware check | NO |
| POST `/users/:userId/bails/preview` | users:write | `BailsUtil.previewBail` | userId, definition | 200 or 400/403 | middleware check | NO |
| GET `/users/:userId/bails/:bailId` | users:read | `BailsUtil.getBail` | userId, bailId | 200 or 403/404 | middleware check | NO |
| PUT `/users/:userId/bails/:bailId` | users:write | `BailsUtil.updateBail` | userId, bailId, name?, description?, definition?, enabled?, destination_form? | 200 or 403/404 | middleware check | NO |
| DELETE `/users/:userId/bails/:bailId` | users:write | `BailsUtil.deleteBail` | userId, bailId | 204 or 403 | middleware check | NO |
| GET `/users/:userId/bails/:bailId/events` | users:read | `BailsUtil.getBailEvents` | userId, bailId | 200 or 403 | middleware check | NO |
| GET `/users/:userId/bail-events` | users:read | `BailsUtil.getUserEvents` | userId, limit? | 200 or 403 | middleware check | NO |
| GET `/surveys/:surveyName/states/summary` | surveys:read | `States.summary` | surveyName | 200 or 403 | middleware check | NO |
| GET `/surveys/:surveyName/states` | surveys:read | `States.list` | surveyName, state?, error_tag?, form?, search?, limit?, offset? | 200 or 403 | middleware check | NO |
| GET `/surveys/:surveyName/states/:userid` | surveys:read | `States.detail` | surveyName, userid | 200 or 403/404 | middleware check | NO |
| GET `/surveys/:surveyName/health` | surveys:read | `States.healthSummary`, `buildAggregates`, `evaluate` | surveyName | 200 or 403 | middleware check | PARTIAL |
| GET `/platform/notices` | platform:read | fetch AlertManager (fail-soft), pure `translateAlerts` | - | 200: {notices} | none (platform-wide) | PARTIAL |
| POST `/mcp` | per-tool (delegated) | `runTool` dispatch | JSON-RPC method + params | 200: JSON-RPC result or error | req.user.email | YES (five tools) |

---

## Recommendations for MCP Tool Expansion

### High-value targets (pure core exists or nearly):

1. **Media upload** — `validateUpload`, `hashContent`, `buildAssetRecord` are pure. Service wrapper needed for storage IO and fan-out orchestration.
2. **Message template CRUD** — validators (`validateCreateInput`) are pure. Service wrapper needed for Meta Graph IO.
3. **States health queries** — `buildAggregates` and `evaluate` are pure. Wrapper needed for database layer.
4. **Exports** — Async by design; could expose as "request export and poll status" pair.

### Low-value targets (no pure core, or simple reads):

- **Tickets** — Linear proxy; Linear client is the core, which is not pure.
- **Bails** — Application logic is intertwined with IO; no separation.
- **Responses** — Query layer only; no business logic to share.

---

## Key Files Reference

| File | Purpose |
|---|---|
| `api/index.js` | Route mounting |
| `api/auth/auth.core.js` | Scope validation, token claims, cache logic |
| `api/auth/auth.routes.js` | POST/DELETE `/api/token` handlers |
| `middleware/auth.js` | JWT verification, credential lookup, scope enforcement |
| `api/surveys/survey.service.js` | `registerSurveyVersion` (shared REST/MCP) |
| `api/mcp/mcp.tools.js` | TOOL_SCOPES, five tool handlers, runTool dispatcher |
| `api/mcp/mcp.core.js` | Pure validators, decision functions, tool descriptions |
| `api/mcp/mcp.server.js` | MCP server builder per request |
| `dashboard-server/README.md` | Ground truth for auth, scopes, route structure, media, etc. |
| `documentation/agent-api.md` | Agent-facing API contract (MCP + REST) |

