# MCP full-coverage audit

**Date:** 2026-09-07
**Status:** audit complete, nothing built. Decisions marked **DECIDE** need a human.
**Goal:** every action a researcher can take in the dashboard UI should be
reachable through `POST /api/v1/mcp`, so an agent holding a Fly API key can do
the researcher's job end to end.

Two inventories feed this document and remain as appendices:

- `planning/mcp-coverage-audit-ui.md` — every screen, button and API call in
  `dashboard-client` (54 actions, 32 REST paths, 5 Cube.js queries).
- `planning/mcp-coverage-audit-api.md` — every route in `dashboard-server` (49
  routes, 16 modules) with scope, service function, ownership check and whether
  a `req`-free service function already exists.

Where the two disagreed or left something "inferred", the code was re-read and
the answer is what is written here.

---

## 1. Where we are

The MCP server exposes **five tools**, all survey authoring:
`list_surveys`, `create_typeform_form`, `create_survey`,
`create_survey_version`, `update_survey_settings`. That is the whole of the
"Surveys" area and nothing else. Monitoring, exports, responses, analytics,
messaging accounts, templates, media, bail systems, tickets and API keys are
REST-only.

Full coverage is **27 new tools** (32 total), plus **2 deferred analytics
tools** that need new server-side queries first. Nine UI actions should stay
out of the MCP on purpose (§4).

---

## 2. Coverage matrix

Columns: what the UI lets a researcher do → the endpoint behind it → whether the
MCP covers it today → the proposed tool → the scope its `TOOL_SCOPES` entry
gets → notes that change the design.

Scope rule reminder (`dashboard-server/README.md` "Authentication"): resource is
the first path segment, `GET` is `read`, everything else is `write`, `write`
implies `read`. Tools inherit the scope their REST route would have had, so a
key that can do X over REST can do X over MCP and nothing more.

### 2.1 Surveys and forms

| UI capability | Endpoint | MCP today | Proposed tool | Scope | Notes |
|---|---|---|---|---|---|
| List surveys, versions, shortcodes | `GET /surveys` | ✅ `list_surveys` | — | `surveys:read` | Unbounded list; fine at current sizes. |
| Create survey from a Typeform form | `POST /surveys` | ✅ `create_survey` | — | `surveys:write` | Shared `registerSurveyVersion`. |
| New version of an existing form | `POST /surveys` | ✅ `create_survey_version` | — | `surveys:write` | |
| Edit timeouts and kill time | `PUT /surveys/:id/settings` | ✅ `update_survey_settings` | — | `surveys:write` | MCP read-merge-writes; REST replaces. |
| Author a Typeform form | none in UI (UI only imports) | ✅ `create_typeform_form` | — | `surveys:write` | MCP-only capability, keep. |
| Pick an existing Typeform form | `GET /typeform/form` | ❌ | `list_typeform_forms` | `surveys:read` | Returns `401` from Typeform when no token stored; tool should turn that into a tool error saying "connect Typeform in the dashboard first". |
| Typeform OAuth callback | `GET /typeform/auth/:code` | ❌ | **excluded** | — | Browser redirect flow, §4. |

### 2.2 Monitoring (the "what state is everyone in" ask)

| UI capability | Endpoint | MCP today | Proposed tool | Scope | Notes |
|---|---|---|---|---|---|
| State counts by state and form | `GET /surveys/:name/states/summary` | ❌ | `get_states_summary` | `surveys:read` | Cheap, call first. |
| Paginated participant list with filters | `GET /surveys/:name/states?state&error_tag&form&search&limit&offset` | ❌ | `list_states` | `surveys:read` | REST default limit 50, **no maximum**. Tool must clamp `limit` to 200 and return `total` so the agent knows to page. |
| One participant's full state, error, stuck question | `GET /surveys/:name/states/:userid` | ❌ | `get_participant_state` | `surveys:read` | Returns `state_json`; can be large but bounded. |
| Health findings, 24h, categorised | `GET /surveys/:name/health` | ❌ | `get_survey_health` | `surveys:read` | Pure `buildAggregates`/`evaluate` already exist. UI polls every 60s; an agent calls once. |
| Platform notices banner | `GET /platform/notices` | ❌ | `get_platform_notices` | `platform:read` | Platform-wide, not per survey; fail-soft on AlertManager down. |

States and health live under `/surveys`, so `surveys:read` already reaches
participant data over REST. Keeping the same scope for the tools is consistent;
splitting participant data into its own scope would be a REST change too and is
out of scope here.

### 2.3 Data: responses and exports

| UI capability | Endpoint | MCP today | Proposed tool | Scope | Notes |
|---|---|---|---|---|---|
| Response export (pivot, dedupe, duration…) | `POST /exports?survey=` body `{pivot, keep_final_answer, drop_duplicated_users, add_duration, drop_users_without, response_value, metadata}` | ❌ | `start_export` with `export_type: "responses"` | `exports:write` | Async: the exporter polls `export_status` (migration 16); returns `export_id`. |
| Chat log export | same, `export_type: "chat_log"` | ❌ | `start_export` | `exports:write` | |
| Full messages export | same, `export_type: "full_messages"`, `{event_groups, include_raw_json, start_time?, end_time?}` | ❌ | `start_export` | `exports:write` | `documentation/full-messages-export.md`. |
| See export progress and download link | `GET /exports/status/survey?survey=` (UI polls 4s until none in progress) | ❌ | `list_exports` | `exports:read` | Returns status rows with the presigned URL (7h TTL). Server `instructions` must say: exports are async, poll `list_exports`, download the URL yourself. |
| All my exports | `GET /exports/status` | ❌ | `list_exports` with no `survey_name` | `exports:read` | Same tool, optional filter. |
| Read responses as data | `GET /responses?survey&after&pageSize` | ❌ (UI does not use it either) | `get_responses` | `responses:read` | Cursor paging (`after` is an opaque token), default page 25. Clamp `pageSize` to 500. This is the tool an agent uses to *look at* answers; exports are for bulk. |
| Download responses CSV | `GET /responses/csv`, `/responses/form-data` | ❌ | **excluded** | — | Dead in the UI (`services/api/getCSV.js` has no call sites). Unbounded CSV body is wrong for a tool result; `start_export` covers it. |

`responses` is a separate scope from `surveys` on purpose: a key can see study
structure and participant *state* without seeing *answers*. `get_responses`
keeps that line.

### 2.4 Analytics (Cube.js reports)

| UI capability | Endpoint | MCP today | Proposed tool | Scope | Notes |
|---|---|---|---|---|---|
| Start-time histogram | `POST /cubejs-api` `Responses.startTime` by `userid` | ❌ | deferred `get_participation_timeline` | `responses:read` | See below. |
| Duration percentiles | Cube `Responses.startTime/endTime` by `userid` | ❌ | deferred, same tool | | |
| Join-time histogram | Cube, same shape | ❌ | deferred, same tool | | |
| Answers per question | Cube `Responses.count` by `userid` + client-side | ❌ | deferred `get_answer_distribution` | `responses:read` | |
| Drop-off: last question per user | Cube `LastQuestions.count` by `questionRef/questionText` | ❌ | deferred `get_dropoff` (or fold into health) | `responses:read` | |

**Do not wrap Cube.js.** Verified in `index.js`, `middleware/auth.js`,
`schema/Responses.js`, `schema/LastQuestions.js`: the cube endpoint is
authenticated but **never scoped to the caller**. The cube SQL is
`SELECT * FROM responses` with no email join and no `queryRewrite`; the only
survey filter is the `Responses.formid` filter the browser supplies. Any Auth0
user or unscoped API key can query any survey's responses by supplying another
survey's id. Scoped keys are refused only because `/cubejs-api` is not in
`ROUTE_RESOURCES`. See §6.

The analytics tools should therefore be built as **new server-side queries**
over `responses` with the email join, computing the same aggregates the five
reports compute in the browser today. That is new work, not wrapping, so they
are deferred to a later phase. In the meantime an agent can pull `get_responses`
pages and aggregate itself.

### 2.5 Messaging accounts and credentials

| UI capability | Endpoint | MCP today | Proposed tool | Scope | Notes |
|---|---|---|---|---|---|
| See connected pages / WhatsApp numbers / Reloadly / secrets | `GET /credentials` | ❌ | `list_messaging_accounts` | `credentials:read` | **`details` contains access tokens and secrets.** Tool returns `entity`, `key`, display name / phone, `created` only. Never `details`. |
| Connect a Facebook page | `POST /facebook/exchange-token`, `/facebook/webhooks`, `/facebook/get-started`, then `POST /credentials` | ❌ | **excluded** | — | Browser OAuth flow; the three `/facebook` helpers have no ownership check (they act on whatever token is posted). §4. |
| Connect WhatsApp (embedded signup) | `POST /whatsapp/exchange-code`, `POST /credentials` | ❌ | **excluded** | — | Same. |
| Refresh a page token | `PUT /credentials` | ❌ | **excluded** | — | Needs a fresh token from the OAuth flow. |
| Set Reloadly credentials | `POST`/`PUT /credentials` entity `reloadly` | ❌ | **DECIDE** `set_reloadly_credential` | `credentials:write` | Writable without a browser, but it is an agent pasting a payment-provider secret. Recommend excluded. |
| Set a named secret | `POST`/`PUT /credentials` entity `secrets` | ❌ | **DECIDE** `set_secret` | `credentials:write` | Same argument. Recommend excluded. |

### 2.6 Message templates (WhatsApp / Messenger utility messages)

| UI capability | Endpoint | MCP today | Proposed tool | Scope | Notes |
|---|---|---|---|---|---|
| List templates and their approval status | `GET /message-templates` (UI polls 4s while any `PENDING`) | ❌ | `list_message_templates` | `templates:read` | |
| View one | `GET /message-templates/:id` | ❌ | `get_message_template` | `templates:read` | Includes `rejection_reason`. |
| Create (submits to Meta for approval) | `POST /message-templates` `{accountId, name, language, body, buttons?, examples?}` | ❌ | `create_message_template` | `templates:write` | Pure `validateCreateInput` exists. External call to Meta Graph; failure comes back as `502` today, must become a tool error. |
| Duplicate | `GET /:id` then `POST` | — | covered by get + create | | |
| Delete (also deletes at Meta) | `DELETE /message-templates/:id` | ❌ | `delete_message_template` | `templates:write` | Destructive and external; tool description must say it deletes at Meta too. |

### 2.7 Media library

| UI capability | Endpoint | MCP today | Proposed tool | Scope | Notes |
|---|---|---|---|---|---|
| List assets with public URLs | `GET /media` | ❌ | `list_media` | `media:read` | |
| Upload a file | `POST /media/upload` multipart `file` | ❌ | `upload_media` | `media:write` | MCP has no multipart. Accept **either** `source_url` (server fetches, with a size cap) **or** `content_base64`. Reuse pure `validateUpload`, `hashContent`, `buildAssetRecord`; dedupe by content hash already returns the existing asset. Per-type size and MIME limits are in `media.core.js`. |
| Copy URL | client-side | — | covered by `list_media` | | |
| Delete | not in v1 anywhere | — | — | | README says deliberately absent. |

### 2.8 Bail systems

| UI capability | Endpoint | MCP today | Proposed tool | Scope | Notes |
|---|---|---|---|---|---|
| List bails | `GET /users/:userId/bails` | ❌ | `list_bails` | `users:read` | |
| View one | `GET /users/:userId/bails/:bailId` | ❌ | `get_bail` | `users:read` | |
| Create | `POST /users/:userId/bails` `{name, definition, description?, destination_form?}` | ❌ | `create_bail` | `users:write` | `definition` is the condition tree the `ConditionBuilder` produces, or a `user_list`. The tool schema must spell out that grammar; it is not documented anywhere today (§7). |
| Edit | `PUT /users/:userId/bails/:bailId` | ❌ | `update_bail` | `users:write` | |
| Enable / disable | same `PUT` with `{enabled}` | — | covered by `update_bail` | | |
| Delete | `DELETE /users/:userId/bails/:bailId` | ❌ | `delete_bail` | `users:write` | |
| Preview match count | `POST /users/:userId/bails/preview` `{definition}` | ❌ | `preview_bail` | `users:write` | Scope is `write` only because REST derives it from `POST`; it reads. Keep parity with REST rather than special-casing. |
| Event timeline for a bail | `GET /users/:userId/bails/:bailId/events` | ❌ | `list_bail_events` | `users:read` | |
| All my bail events | `GET /users/:userId/bail-events?limit` | ❌ | `list_bail_events` with no `bail_id` | `users:read` | Same tool. |
| Upload user list CSV | client-side parse, then `definition.user_list` | — | covered by `create_bail` | | Agent passes the list directly. |

`:userId` disappears from every tool: the UI gets it by calling `POST /users`
(get-or-create) on mount. The tool handlers do the same lookup from
`req.user.email` internally, so the agent never sees or supplies a user id.

### 2.9 Support tickets (Linear)

| UI capability | Endpoint | MCP today | Proposed tool | Scope | Notes |
|---|---|---|---|---|---|
| List my tickets | `GET /tickets` | ❌ | `list_tickets` | `tickets:read` | Ownership is by a sentinel embedded in the Linear issue. |
| View with comments | `GET /tickets/:id` | ❌ | `get_ticket` | `tickets:read` | |
| Create | `POST /tickets` `{title, description, surveyName?, userIds?}` | ❌ | `create_ticket` | `tickets:write` | The `userIds` field is what `triage-linear-tickets` reads; expose it. |
| Reply | `POST /tickets/:id/replies` `{body}` | ❌ | `reply_to_ticket` | `tickets:write` | |

### 2.10 API keys and account

| UI capability | Endpoint | MCP today | Proposed tool | Scope | Notes |
|---|---|---|---|---|---|
| Mint an API key | `POST /auth/api-token` | ❌ | **excluded** | `auth:write` | A key can only mint keys with scopes it already holds, so this is not an escalation path, but an agent minting long-lived credentials is a policy question. **DECIDE**; recommend excluded. |
| Revoke by name | `DELETE /auth/api-token?name=` (not in UI) | ❌ | **DECIDE** `revoke_api_key` | `auth:write` | Useful for an agent to clean up after itself. Low risk: revocation only. |
| Get-or-create user | `POST /users` | ❌ | **excluded** | — | Implicit; handlers do it. |

---

## 3. Proposed tool set

Grouped in build order. Each phase is independently shippable and each tool is
one row in `TOOL_SCOPES`, one definition in `mcp.core.js`, one thin handler in
`mcp.tools.js`, and a service function in `mcp.service.js` or the owning
module's service file.

| Phase | Tools | Count | Why this order |
|---|---|---|---|
| **A. Monitoring** | `get_states_summary`, `list_states`, `get_participant_state`, `get_survey_health`, `get_platform_notices` | 5 | Read-only, the explicit ask, service functions exist. |
| **B. Data** | `start_export`, `list_exports`, `get_responses` | 3 | The second explicit ask. One write, async. |
| **C. Templates + media** | `list_message_templates`, `get_message_template`, `create_message_template`, `delete_message_template`, `list_media`, `upload_media` | 6 | Pure cores exist; `upload_media` needs the URL/base64 design. |
| **D. Bails + tickets + accounts** | `list_bails`, `get_bail`, `create_bail`, `update_bail`, `delete_bail`, `preview_bail`, `list_bail_events`, `list_tickets`, `get_ticket`, `create_ticket`, `reply_to_ticket`, `list_messaging_accounts`, `list_typeform_forms` | 13 | Wrapping only, but bails needs the condition grammar written down first. |
| **E. Analytics (deferred)** | `get_participation_timeline`, `get_answer_distribution`, `get_dropoff` | 3 | New scoped queries; do not wrap Cube.js. |
| **DECIDE** | `set_secret`, `set_reloadly_credential`, `revoke_api_key`, `mint_api_key` | 0–4 | Policy, see §2.5 and §2.10. |

Total after A–D: **32 tools** (5 existing + 27). After E: 35.

---

## 4. Deliberately excluded

| Capability | Why |
|---|---|
| Facebook page connect (`/facebook/*`), WhatsApp embedded signup (`/whatsapp/exchange-code`), Typeform OAuth (`/typeform/auth/:code`) | Browser redirect flows that need a human in a Meta or Typeform login. The `/facebook` helpers also have no ownership check, so exposing them to a bearer-token caller widens the surface for nothing. |
| `PUT /credentials` for page tokens | Only meaningful with a fresh token from the flow above. |
| `GET /responses/csv`, `/responses/form-data` | Unbounded CSV in a tool result. Dead in the UI. `start_export` is the path. |
| `POST /users` | Implicit get-or-create; handlers call it. |
| Cube.js `/cubejs-api` | Unscoped, §6. |
| API key minting | Policy, §2.10. |

---

## 5. Cross-cutting design decisions

1. **Same scope as REST, always.** Every tool's `TOOL_SCOPES` entry is what the
   underlying route derives. No tool is reachable by a key that could not reach
   the route. This is the invariant that makes `/mcp`'s delegated authorization
   safe (`dashboard-server/README.md` "`/mcp` and delegated authorization").
2. **Ownership through the same service functions.** No new SQL. Every tool
   calls the service or query function the controller calls, passing
   `req.user.email`, so the existing ownership gates apply unchanged.
3. **Bounded results.** `list_states` clamps `limit` to 200, `get_responses`
   clamps `pageSize` to 500, both return a cursor or `total`. `list_surveys`
   stays unbounded as today. Every list tool's description says how to page.
4. **Async stays async.** `start_export` returns `export_id` and the
   instructions text tells the agent to poll `list_exports` and fetch the URL
   itself. No tool waits on the exporter.
5. **External failures are tool errors.** Meta Graph, Linear, Typeform and
   AlertManager errors that the REST layer maps to `502`/`503` become
   `isError: true` results with the upstream message, per the existing
   `runTool` contract. Never a transport error.
6. **Redaction in the pure core.** `list_messaging_accounts` shapes its output
   in `mcp.core.js` from a `details`-free projection. Add a unit test that the
   shaped result has no `access_token`, `secret`, `token` or `value` key at any
   depth, so a future column cannot leak by accident.
7. **Destructive tools say so.** `delete_message_template`, `delete_bail` and
   `revoke_api_key` (if built) carry a first-sentence warning in their
   description. `delete_message_template` also deletes at Meta.
8. **Uploads without multipart.** `upload_media` takes `source_url` or
   `content_base64`; the service fetches with a hard byte cap equal to the
   largest per-type limit in `media.core.js` and then runs the existing pure
   validation. Base64 inflates tool-call size by a third; the description
   should steer agents to `source_url`.
9. **Tool descriptions are the product surface** and live in the pure core so
   they can be diffed and asserted on, as today. The server `instructions`
   grow a paragraph per area: monitoring (call summary first), exports (async),
   bails (the condition grammar).
10. **`agent-api.md` §9 grows one subsection per phase**, in the same shape as
    the current five-tool section, and the README route table row for `/mcp`
    stops saying "five survey tools".

---

## 6. Security findings surfaced by the audit

These are pre-existing and independent of the MCP work, recorded here because
the audit is where they were found.

| Finding | Where | Severity | Suggested fix |
|---|---|---|---|
| **Cube.js analytics are not scoped to the caller.** The cube SQL has no email join and no `queryRewrite`; the browser supplies the `formid` filter. Any Auth0 user or unscoped API key can read any survey's `responses` rows through `/cubejs-api` by supplying another survey's id. | `dashboard-server/index.js`, `schema/Responses.js`, `schema/LastQuestions.js` | High (cross-tenant read of respondent answers) | Add a `queryRewrite` in the Cube config that injects a `Responses.formid IN (caller's survey ids)` filter from `req.user.email`, or replace the five reports with scoped REST queries (which Phase E needs anyway) and remove Cube. |
| `POST /surveys` over REST crashes when `metadata` and `translation_conf` are both omitted; MCP path was fixed in VIR-37. | `api/surveys` controller | Low | Default both to `{}` in the controller as the MCP tool does. |
| `/facebook/exchange-token`, `/facebook/webhooks`, `/facebook/get-started` act on whatever token is posted with no ownership check. | `api/facebook` | Low (needs a valid page token to do anything) | Not exposing them via MCP is enough for now. |
| `GET /credentials` returns raw `details` including access tokens to the browser. | `queries/credentials` | Informational | Fine for the SPA, must be projected for MCP (§5.6). |

---

## 7. Documentation gaps this audit found

To be done as the separate doc step, not mixed into implementation.

| Gap | Where it belongs |
|---|---|
| Cube.js: which cubes exist, that auth is not scoped, and the client-supplied filter | `dashboard-server/README.md` (new "Cube.js analytics" subsection) |
| The bail `definition` grammar is documented in `documentation/bail-systems.md` §4–5 but the README bails route row did not point at it | `dashboard-server/README.md` bails row (done in the doc pass) |
| UI polling intervals: health 60s, templates 4s while `PENDING`, exports 4s until none in progress | `dashboard-client/README.md` |
| `services/api/getCSV.js` is dead code; `Settings/` and `FormConfig/` containers are unrouted | `dashboard-client/README.md` |
| `GET /responses` cursor paging (`after` token, `pageSize`) is undocumented for API consumers | `documentation/agent-api.md` (new §, alongside a future `get_responses`) |
| `list_states` has no maximum `limit` | `dashboard-server/README.md` states section |
| Export request bodies per `export_type` are documented only in `full-messages-export.md`; the `responses` and `chat_log` shapes are not | `documentation/exports-storage.md` or a new `documentation/exports.md` |

---

## 8. Effort

Phases A and B are wrapping existing service functions and can be one PR each
following the exact pattern of PR #164: schema in `mcp.core.js`, scope in
`TOOL_SCOPES`, handler, hermetic tests through `mcp.transport.test.js`'s
harness, an `agent-api.md` §9 subsection. Phase C adds the upload design.
Phase D is the largest by count but the bail grammar documentation is the only
real thinking in it. Phase E is new query work and should be planned together
with the Cube.js scoping fix in §6, since both want a scoped
`responses`-by-survey query.
