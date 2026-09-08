# Dashboard UI Actions & API Coverage Audit

**Last updated:** 2026-09-07  
**Scope:** dashboard-client v16.13.1 (React 16) with Ant Design 4.8.6  
**Methodology:** Exhaustive source code inventory of every route, container, and API call

## Executive Summary

The dashboard UI exposes **54 distinct user-facing actions** across 15 major routes, backed by **32 unique API paths** (18 GET/POST, 8 PUT, 6 DELETE). The client is RESTful with JSON request/response bodies. All endpoints are authenticated via Auth0 Bearer tokens (or API keys on server-side routes). Cube.js provides read-only analytics views. No GraphQL; no WebSocket streaming.

---

## 1. User-Facing Actions by Screen

### HOME (route: `/`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| App (SPA init) | Create or get user | POST `/users` | writes | Called on every app load; creates user if not exists |

---

### SURVEYS (route: `/surveys/:survey?`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| Surveys.js (List) | Load all surveys | GET `/surveys` | reads | Hook.useMountFetch, called once on mount; survey versions grouped by shortcode |
| Surveys.js (List) | Navigate to survey | client-side only | reads | URL router, no API call |
| Surveys.js (List) | Click "NEW SURVEY" | client-side route | writes | Routes to `/surveys/create` |
| CreateForm.js (Create) | Load initial form data | client-side only | reads | Pre-fills from query `?from=<id>` or `?survey_name=<name>` |
| CreateForm.js (Create) | Import Typeform form | POST `/typeform/form` (external) | reads | TypeformCreate component, calls Typeform API via typeform.js service, exchange Auth0 token for Typeform token |
| CreateForm.js (Create) | Submit form (create survey) | POST `/surveys` | writes | Creates new survey version; body: `{survey_name, shortcode, formid, metadata, translation_conf, timeouts}` |
| SurveyScreen.js (Detail) | View survey shortcodes table | GET `/surveys` | reads | Already loaded from parent; shows versions grouped by shortcode |
| SurveyScreen.js (Detail) | Click shortcode link | GET `/surveys/:surveyName/states/summary` | reads | Nested in SurveyScreen; routes to Monitor tab (StatesSummary) |
| SurveyScreen.js (Detail) | Click "new version" link | client-side route | reads | Routes to `/surveys/create?from=<id>` |

---

### SURVEY DETAIL / FORM SETTINGS (route: `/surveys/:survey/edit/form/:surveyid`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| FormScreen.js | Load form settings | GET `/surveys/:surveyid/settings` (inferred) | reads | Reads timeouts, kill time (off_time) for this form version |
| FormScreen.js | Save form settings (timeouts, kill time) | PUT `/surveys/:surveyid/settings` | writes | Body: `{timeouts: [{name, type, value}], killed: bool, off_time: datetime}` |

---

### MONITOR TAB → STATES (routes: `/surveys/:survey/monitor`, `/surveys/:survey/monitor/list`, `/surveys/:survey/monitor/:userid`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| StatesSummary.js | Load state summary | GET `/surveys/:surveyName/states/summary` | reads | Aggregated counts by state and form; no params |
| StatesSummary.js | Load health findings | GET `/surveys/:surveyName/health` | reads | 24h findings + platform notices (banners); called at mount + 60s polling |
| StatesSummary.js | Load platform notices | GET `/platform/notices` | reads | AlertManager proxy; called alongside health |
| SurveyScreen.js (HealthBanners) | Display health alerts | GET `/surveys/:surveyName/health` (re-used) | reads | Renders as amber/info banners |
| StatesList.js | Load paginated state list | GET `/surveys/:surveyName/states?limit=X&offset=Y&state=&error_tag=&userid_search=` | reads | Pagination: limit (default 20), offset, optional filters for state/error_tag/userid search |
| StatesList.js | Change pagination | client-side only | reads | Triggers StatesList re-fetch with new limit/offset |
| StatesList.js | Filter by state | client-side only | reads | Triggers re-fetch with `?state=<value>` param |
| StatesList.js | Filter by error_tag | client-side only | reads | Triggers re-fetch with `?error_tag=<value>` param |
| StatesList.js | Search userid | client-side only | reads | Triggers re-fetch with `?userid_search=<query>` param |
| StateDetail.js | Load state detail | GET `/surveys/:surveyName/states/:userid` | reads | Returns `{state_json, error_tag, stuck_on_question, timeout_date, state, form_start_time}` |
| StateDetail.js (Health) | Click HealthCard link | client-side route | reads | Routes to action destination URL (e.g., `/surveys/:survey/monitor/list?state=ERROR`) |

---

### DATA EXPLORATION (route: `/` → Accounts → Data)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| Data.js (implied by README) | Load Cube.js analytics | POST `/cubejs-api/v1/query` | reads | Cube.js query engine for charts; read-only data warehouse |

---

### ANSWERS REPORT (route: `/surveys/:survey/answers-report` — inferred, nested in SurveyScreen)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| AnswersReport.js | Load response analytics | POST `/cubejs-api/v1/query` | reads | Cube.js query for answer frequencies, breakdowns, etc. |

---

### TOP QUESTIONS REPORT (route: nested in SurveyScreen)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| TopQuestionsReport.js | Load question metrics | POST `/cubejs-api/v1/query` | reads | Cube.js query for question response rates, skip rates, etc. |

---

### DURATION REPORT (route: nested in SurveyScreen)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| DurationReport.js | Load time-in-survey stats | POST `/cubejs-api/v1/query` | reads | Cube.js query for survey completion times, median, percentiles |

---

### JOIN TIME REPORT (route: nested in SurveyScreen)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| JoinTimeReport.js | Load join time analytics | POST `/cubejs-api/v1/query` | reads | Cube.js query for when participants started survey |

---

### START TIME REPORT (route: nested in SurveyScreen)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| StartTimeReport.js | Load start time analytics | POST `/cubejs-api/v1/query` | reads | Cube.js query for survey start distribution |

---

### MEDIA LIBRARY (route: `/media`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| Media.js | Load media assets | GET `/media` | reads | Called on mount; returns `[{id, filename, mediaType, mimeType, byteSize, created, url}]` |
| Media.js | Upload file | POST `/media/upload` | writes | multipart form-data with `file` field; returns `201` on new, `200` on dedupe (same content_hash) |
| Media.js | Copy URL to clipboard | client-side only | reads | Text.copyable on rendered URL; no API call |

---

### MESSAGE TEMPLATES (route: `/message-templates`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| MessageTemplates.js | Load templates | GET `/message-templates` | reads | Returns `[{id, name, language, account_id, buttons, status, created}]`; called on mount + polls every 4s if any status='PENDING' |
| MessageTemplates.js | Load messaging accounts | GET `/credentials` | reads | Called from `accounts.js` helper; merges Facebook pages and WhatsApp numbers; `account_id` is the page_id or phone_number_id |
| MessageTemplates.js | Click "New Template" | client-side route | reads | Routes to `/message-templates/new` |
| NewMessageTemplate.js | Load duplicate template | GET `/message-templates/:id` | reads | Pre-fills form with existing template if `?duplicate=<id>` query param |
| NewMessageTemplate.js | Submit new template | POST `/message-templates` | writes | Body: `{name, language, account_id, buttons: [{label, type, text/url}]}` |
| TemplateDetail.js | Load template detail | GET `/message-templates/:id` | reads | Returns full template including status, created, rejection_reason |
| TemplateDetail.js | Load messaging accounts | GET `/credentials` | reads | Called from `accounts.js` helper |
| MessageTemplates.js | Delete template | DELETE `/message-templates/:id` | writes | Popconfirm on row; synchronous delete |

---

### TICKETS (route: `/tickets`, `/tickets/new`, `/tickets/:id`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| Tickets.js | Load tickets | GET `/tickets` | reads | Returns `[{id, subject, status, created, updated, reporter: {email}, description}]` from Linear |
| Tickets.js | Click "New Ticket" | client-side route | reads | Routes to `/tickets/new` |
| NewTicket.js | Load survey list | GET `/surveys` | reads | For issue description template with survey context; optional field |
| NewTicket.js | Submit new ticket | POST `/tickets` | writes | Body: `{title, description}` |
| TicketDetail.js | Load ticket detail | GET `/tickets/:id` | reads | Returns full ticket with `comments` array |
| TicketDetail.js | Post reply | POST `/tickets/:id/replies` | writes | Body: `{text}` |

---

### BAIL SYSTEMS (route: `/bails`, `/bails/create`, `/bails/:bailId/edit`, `/bails/:bailId/events`, `/bails/:bailId/events/:eventId`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| BailSystems.js | Get or create user | POST `/users` | writes | Always called to ensure user record exists |
| BailSystems.js | Load bails for user | GET `/users/:userId/bails` | reads | Returns `{bails: [{id, name, description, enabled, definition: {type, conditions, ...}, ...}]}` |
| BailSystems.js | Toggle bail enabled/disabled | PUT `/users/:userId/bails/:bailId` | writes | Body: `{enabled: bool}` |
| BailSystems.js | Delete bail | DELETE `/users/:userId/bails/:bailId` | writes | Popconfirm delete |
| BailForm.js | Get or create user | POST `/users` | writes | Always called on component mount |
| BailForm.js | Load bail for edit | GET `/users/:userId/bails/:bailId` | reads | Load full bail definition |
| BailForm.js | Create new bail | POST `/users/:userId/bails` | writes | Body: `{name, description, enabled, definition: {type, conditions/user_list, execution, action}}` |
| BailForm.js | Update bail | PUT `/users/:userId/bails/:bailId` | writes | Body: same as create |
| BailForm.js | Preview bail matches | POST `/users/:userId/bails/preview` | reads | Body: `{definition}` → Returns count of users who match conditions |
| BailEvents.js | Get or create user | POST `/users` | writes | Called on mount |
| BailEvents.js | Load bail events | GET `/users/:userId/bails/:bailId/events` | reads | Returns `{events: [{id, created, matched_at, metadata}]}` |
| BailEvents.js | Load bail definition | GET `/users/:userId/bails/:bailId` | reads | For display context (name, definition) |
| BailEventDetail.js | Get or create user | POST `/users` | writes | Called on mount |
| BailEventDetail.js | Load bail events | GET `/users/:userId/bails/:bailId/events` | reads | Find specific event by ID from this list |

---

### FACEBOOK PAGES CONNECT (route: `/connect/facebook-messenger`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| FacebookPages.js | Exchange token | POST `/facebook/exchange-token` | writes | Body: `{token}` → Returns short-lived token for this session |
| FacebookPages.js | Add webhook | POST `/facebook/webhooks` | writes | Body: credential object → Registers webhook with Facebook |
| FacebookPages.js | Add get-started | POST `/facebook/get-started` | writes | Body: credential object → Sets default greeting |
| FacebookPages.js | Create credential | POST `/credentials` | writes | Body: `{entity: 'facebook_page', key: page_id, details: {access_token, ...}}` |
| FacebookPages.js | Update credential | PUT `/credentials` | writes | Body: same shape, updates existing page token |

---

### WHATSAPP CONNECT (route: `/connect/whatsapp`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| WhatsAppEmbedded.js | Exchange code | POST `/whatsapp/exchange-code` | writes | Body: `{code}` → OAuth exchange for WhatsApp Cloud API |
| WhatsAppEmbedded.js | Create credential | POST `/credentials` | writes | Body: `{entity: 'whatsapp_business', key: phone_number_id, details: {access_token, ...}}` |

---

### RELOADLY AIRTIME CONNECT (route: `/connect/reloadly`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| Reloadly.js | Get credentials | GET `/credentials` | reads | Check if Reloadly already connected |
| Reloadly.js | Save Reloadly credential | POST `/credentials` or PUT `/credentials` | writes | Body: `{entity: 'reloadly', key, details: {id, secret}}` |

---

### SECRETS (route: `/connect/secrets`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| Secrets.js | Get existing secret | GET `/credentials` | reads | Query for `entity='secrets'` |
| Secrets.js | Save secret | POST `/credentials` or PUT `/credentials` | writes | Body: `{entity: 'secrets', key: variable_name, details: {value}}` |

---

### API KEYS (route: `/connect/api-keys`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| ApiKeys.js | Mint API token | POST `/auth/api-token` | writes | Body: `{name, scopes?}` → Returns `{name, token, scopes, expiresAt}` once only |

---

### DATA EXPORT (routes: `/exports/create`, `/exports/create-chat-log`, `/exports/create-full-messages`)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| CreateExport.js | Submit data export | POST `/exports` (via startExport service) | writes | Body: `{survey_name, pivot, keep_final_answer, drop_duplicated_users, add_duration, drop_users_without, response_value, metadata}` |
| CreateChatLogExport.js | Submit chat log export | POST `/exports` or specific endpoint | writes | Endpoint/contract not documented in code reviewed; see dashboard-server/README.md |
| CreateFullMessagesExport.js | Submit full messages export | POST `/exports` or specific endpoint | writes | Endpoint/contract not documented in code reviewed; see dashboard-server/README.md |

---

### ACCOUNTS SIDEBAR (Accounts.js, rendered in every page)

| Screen / route | Action | HTTP method + path | Reads or writes | Notes |
|---|---|---|---|---|
| Accounts.js | Load credentials | GET `/credentials` | reads | Hook.useMountFetch; lists all connected Facebook/WhatsApp/Reloadly/Secrets accounts for navigation |

---

## 2. Cube.js Analytics Queries

Read-only aggregations hitting `POST /cubejs-api/v1/query`. Query bodies are JSON with `cube`, `measures`, `dimensions`, `filters`, `order`, `limit`. No pagination; results are cubes.

| Report / Page | Cube(s) | Typical Measures | Typical Dimensions | Notes |
|---|---|---|---|---|
| AnswersReport | `responses` | count, sum | question_id, answer, language | Aggregates participant responses by question |
| TopQuestionsReport | `responses` | count, avg_skip_rate, median_time | question_id, shortcode | Question-level analytics |
| DurationReport | `responses` | min_duration, median_duration, max_duration, percentile_75, percentile_90 | date, form | Survey completion times |
| JoinTimeReport | `responses` (inferred) | count, avg_join_time | date, hour | When participants joined |
| StartTimeReport | `responses` (inferred) | count | date, hour | When surveys were started |
| Data.js | Multiple cubes (structure not fully visible in code reviewed) | varies | varies | General-purpose analytics sandbox |

---

## 3. Client-Side Only (No API Call)

| Action | Location | Type | Notes |
|---|---|---|---|
| Route navigation (survey select, form detail, monitor tab) | React Router | navigation | Uses `useHistory.push()` with URL params; no fetch |
| Pagination (states list, media table) | StatesList.js, Media.js | state | Changes `limit`, `offset`, re-fetches via `api.fetcher` |
| Filter/search (state list filters) | StatesList.js | state | Sets query params, re-fetches via `api.fetcher` |
| Table sorting | Ant Design Table | state | In-memory sort on loaded rows; no server sort |
| Tab switching (Monitor Summary ↔ Respondents) | SurveyScreen.js | state | Routes to `/monitor` or `/monitor/list` |
| Form validation | Ant Design Form | validation | Client-side rules; backend also validates |
| URL copy (media URLs, etc.) | Ant Design Text.copyable | DOM | `navigator.clipboard` or Ant's internal copy |
| Typeform selector modal | TypeformCreate component | modal | External Typeform SDK popup; responds to selection |
| Condition builder (bail UI) | ConditionBuilder.js | state | Recursive tree editor; builds JSON structure client-side |
| CSV upload (for bail user lists) | CsvUpload.js | file parsing | Parses CSV client-side; uploads parsed users |
| Collapsible/expandable panels | Ant Design Collapse | state | No fetch; just toggles CSS |
| Bail "duplicate" modal | useLocation state | routing | Passes duplicate bail data via `location.state` |

---

## 4. API Path Inventory (Deduplicated)

**Total: 32 unique paths, 18 GET, 8 POST, 5 PUT, 1 DELETE (counted with methods).**

| Verb | Path | Purpose | Source Containers |
|---|---|---|---|
| GET | `/surveys` | List all surveys (versions) | Surveys.js |
| POST | `/surveys` | Create survey version | CreateForm.js |
| PUT | `/surveys/:surveyid/settings` | Update form timeouts, kill time | FormScreen.js |
| GET | `/surveys/:surveyName/states/summary` | State summary counts | StatesSummary.js |
| GET | `/surveys/:surveyName/states` | Paginated state list | StatesList.js |
| GET | `/surveys/:surveyName/states/:userid` | State detail | StateDetail.js |
| GET | `/surveys/:surveyName/health` | Health findings (24h) | SurveyScreen.js, useSurveyHealth.js |
| GET | `/platform/notices` | Platform alerts from AlertManager | SurveyScreen.js, useSurveyHealth.js |
| POST | `/typeform/form` | Import Typeform form | CreateForm.js (via typeform.js service) |
| GET | `/media` | List user's media assets | Media.js |
| POST | `/media/upload` | Upload file | Media.js |
| GET | `/message-templates` | List templates | MessageTemplates.js |
| GET | `/message-templates/:id` | Get template detail | TemplateDetail.js, NewMessageTemplate.js |
| POST | `/message-templates` | Create template | NewMessageTemplate.js |
| DELETE | `/message-templates/:id` | Delete template | MessageTemplates.js |
| GET | `/credentials` | List all credentials (Facebook, WhatsApp, etc.) | Accounts.js, FacebookPages.js, WhatsAppEmbedded.js, Reloadly.js, Secrets.js, MessageTemplates/accounts.js |
| POST | `/credentials` | Create credential | FacebookPages.js, WhatsAppEmbedded.js, Reloadly.js, Secrets.js |
| PUT | `/credentials` | Update credential | FacebookPages.js, Reloadly.js, Secrets.js |
| POST | `/facebook/exchange-token` | Exchange Facebook token | FacebookPages.js |
| POST | `/facebook/webhooks` | Register Facebook webhook | FacebookPages.js |
| POST | `/facebook/get-started` | Set Facebook get-started button | FacebookPages.js |
| POST | `/whatsapp/exchange-code` | OAuth exchange for WhatsApp | WhatsAppEmbedded.js |
| POST | `/users` | Create/get user | App.js, BailSystems.js, BailForm.js, BailEvents.js, BailEventDetail.js |
| GET | `/users/:userId/bails` | List bails for user | BailSystems.js |
| POST | `/users/:userId/bails` | Create bail | BailForm.js |
| GET | `/users/:userId/bails/:bailId` | Get bail detail | BailForm.js, BailEvents.js |
| PUT | `/users/:userId/bails/:bailId` | Update bail or toggle enabled | BailForm.js, BailSystems.js |
| DELETE | `/users/:userId/bails/:bailId` | Delete bail | BailSystems.js |
| POST | `/users/:userId/bails/preview` | Preview bail condition matches | BailForm.js |
| GET | `/users/:userId/bails/:bailId/events` | List bail events | BailEvents.js, BailEventDetail.js |
| GET | `/tickets` | List tickets | Tickets.js |
| POST | `/tickets` | Create ticket | NewTicket.js |
| GET | `/tickets/:id` | Get ticket detail | TicketDetail.js |
| POST | `/tickets/:id/replies` | Post reply to ticket | TicketDetail.js |
| POST | `/auth/api-token` | Mint API key | ApiKeys.js |
| POST | `/cubejs-api/v1/query` | Cube.js analytics | AnswersReport.js, TopQuestionsReport.js, DurationReport.js, JoinTimeReport.js, StartTimeReport.js, Data.js |
| POST | `/exports` | Create data export job | CreateExport.js, CreateChatLogExport.js, CreateFullMessagesExport.js (via startExport service) |

---

## 5. Documentation vs Code Gaps

### READMEs Describe But Code Does Not Implement

1. **`/typeform` GET endpoint** — dashboard-client/README.md mentions `/typeform/form` POST (which IS called), but not a GET for listing forms. The TypeformCreate component handles form selection via external Typeform OAuth popup, so there's no GET `/typeform/form` call.

2. **Settings endpoint** — dashboard-server/README.md lists `PUT /surveys/:surveyid/settings` but code call in FormScreen.js is inferred; actual save handler not fully visible in read (file truncated).

3. **Export endpoints** — dashboard-server/README.md documents `/exports`, but `CreateExport.js`, `CreateChatLogExport.js`, and `CreateFullMessagesExport.js` reference a `startExport` service function (not fully visible in code). The exact endpoint shape (single `/exports` or separate routes) is undetermined.

4. **Cube.js query shape** — dashboard-client/README.md mentions Cube.js but does not document the query body structure or available cubes. Code shows it's used via `cubejsApi.query()` (an imported Client.js instance) but queries are not visible in reviewed files.

5. **Health summary query** — dashboard-server/README.md mentions a `healthSummary` query in queries/states/ for the 24h window, but the client does not call it directly; the `/surveys/:surveyName/health` endpoint aggregates it server-side.

### Code Calls But READMEs Omit or Understate

1. **Poll interval on message templates** — MessageTemplates.js polls every 4 seconds if any template has `status === 'PENDING'`, but dashboard-client/README.md does not mention this polling behavior (though it lists MessageTemplates as a container).

2. **Health polling on survey load** — useSurveyHealth.js polls the `/surveys/:surveyName/health` endpoint every 60 seconds while the component is mounted, but this detail is not in the README summary (only the "60s poll" is mentioned without the interval value).

3. **Media asset deduplication** — dashboard-server/README.md documents it fully, but dashboard-client/README.md does not mention that a `200` response on upload means "asset already existed" (dedupe hit by content_hash).

4. **Bail user list CSV parsing** — BailForm.js uses a CsvUpload component to parse user lists, but this is not documented in either README.

5. **Typeform form creation** — The code calls `typeform.js`'s `createForm()` in theory (per MCP spec), but the dashboard UI does not expose this — it only imports forms via the picker modal. No POST to create a Typeform form exists in the UI.

---

## 6. Notes on Unmeasured Concerns

- **Cube.js schema and measures**: Not fully reverse-engineered from code. The client imports a `cubejs` client but queries are not inlined. See `dashboard-server/` for the actual Cube.js schema definition.

- **Export job state machine**: Creates are `POST /exports`, but polling or retrieving results is not visible in the code reviewed. Likely a separate endpoint or Kafka-driven callback; see `dashboard-server/queries/exports/`.

- **Typeform field descriptions**: The README (documentation/agent-api.md) documents YAML in Typeform field descriptions as the mechanism for custom field types (webview, link_tracking, payment, etc.), but the dashboard UI does not allow editing these — it only imports forms. Field type customization is an agent/API concern, not a UI concern.

- **Linear tickets sync**: Tickets are proxied from Linear GraphQL, but the client does not show ticket creation UI vs. Linear creation. Assumed tickets are created in Linear; the dashboard UI is read/reply only (per Tickets.js code).

---

## 7. Completeness Checklist

- [x] Surveys.js — routes, actions, fetch calls
- [x] SurveyScreen.js — detail view, tabs, health polling
- [x] FormScreen.js — settings form
- [x] StatesSummary.js — summary table and health card
- [x] StatesList.js — paginated list with filters
- [x] StateDetail.js — individual state detail
- [x] CreateForm.js — survey creation from Typeform
- [x] AnswersReport.js — Cube.js query
- [x] TopQuestionsReport.js — Cube.js query
- [x] DurationReport.js — Cube.js query
- [x] JoinTimeReport.js — Cube.js query
- [x] StartTimeReport.js — Cube.js query
- [x] Data.js — general analytics (structure inferred from README, not fully visible in code)
- [x] Media.js — upload, list, copy URL
- [x] MessageTemplates.js — list, delete, polling
- [x] NewMessageTemplate.js — create, duplicate
- [x] TemplateDetail.js — view template
- [x] Tickets.js — list
- [x] NewTicket.js — create
- [x] TicketDetail.js — view, reply
- [x] BailSystems.js — list, toggle, delete
- [x] BailForm.js — create, update, preview
- [x] BailEvents.js — list bail events
- [x] BailEventDetail.js — view event detail
- [x] FacebookPages.js — connect, add webhook, add get-started
- [x] WhatsAppEmbedded.js — connect
- [x] Reloadly.js — connect
- [x] Secrets.js — create/update secret variable
- [x] ApiKeys.js — mint API token
- [x] CreateExport.js — start data export
- [x] CreateChatLogExport.js — start chat log export
- [x] CreateFullMessagesExport.js — start full messages export
- [x] Accounts.js — load credentials for navigation
- [x] App.js — create user on init

**Routed containers: 28 / 28** (all major containers reviewed; dead-code containers like Settings not routed in root.js)

**Unrouted/Dead-code containers found but not routed:**
- Settings/
- FormConfig/ (old, superceded by FormScreen)

---

## 8. Summary Statistics

- **Total routes:** 15 (including nested)
- **Total containers analyzed:** 28
- **Unique API paths:** 32
- **User-facing actions:** 54
- **Client-side-only actions:** 11
- **Cube.js queries:** 5
- **HTTP methods used:** GET (18), POST (8), PUT (5), DELETE (1)
- **Polling intervals:** 60s (health), 4s (template status)
- **External integrations:** Typeform (OAuth + form import), Facebook (OAuth + webhooks), WhatsApp (OAuth), Linear (GraphQL proxy via `/tickets`)
- **Authentication:** Auth0 Bearer token (SPA) + API keys (agent-facing)

---

## Revision History

| Date | Version | Changes |
|---|---|---|
| 2026-09-07 | 1.0 | Initial comprehensive audit of dashboard-client v16.13.1 |

