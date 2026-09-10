# MCP full coverage — implementation plan

**Date:** 2026-09-07
**Status (2026-09-09):** Phases 0, A, B and C are **released** as dashboard
**v0.0.75** (PR #170, merged to `main` as `b53da3e6`; deploy commit
`0a63fba7`; vstag revision 100, vprod revision 666), 19 tools.

**Phase D is built** on `feature/mcp-phase-d` (worktree
`../fly-mcp-phase-d`, cut from `main` at `6e0b68dc`): the seven bail tools and
the two account lists, 9 more, **28 in total**. §8 was decided — see the table
there.

**The four ticket tools are NOT built** (decided 2026-09-09, after the first
build): `/tickets` is a thin proxy over Linear whose audience is a person
asking the Fly team for help, so an agent that hits something it cannot fix
should say so to whoever is reading it rather than filing. §6 keeps them
written out in case that changes; `TICKET_TOOLS` stays an empty array in
`mcp.core.js` and `api/tickets/` is untouched — no service extraction, since
rule 1 only applies once a tool shares the controller's work. Phase E is still
deferred.

### Where the build deviated from this plan, and why

Read these before Phase D; they are the ground truth now.

- **`healthFindings` and `platformNotices` live in `api/health/health.service.js`**,
  not `states.service.js` (§2.1 said states). Rule 2 — the operation lives with
  its module — wins over the letter of §2.1.
- **The exporter's terminal status is `Finished`, not `Completed`.** The
  statuses are `Requested → Processing → Finished | Failed`
  (`exporter/exporter/main.py`, `exporter.py#set_export_status`). §4 and
  `exports-storage.md` said `Completed`; the doc is corrected, and
  `list_exports` reports `export_link` null until `Finished`.
- **`chat_log` options are `include_metadata` and `include_raw_payload`**
  (`ChatLogExportOptions`), not the `responses` keys `exports-storage.md`
  listed. The doc is corrected; `start_export` validates against the real
  models. `metadata` on a `responses` export is a list of keys, not an object.
- **`list_states.state` accepts ten values, not eight**: `RESET` and `OFF` are
  in `STATE_MACHINE_STATES` and can appear in a summary, so the list must be
  able to filter on them.
- **`upload_media`'s URL fetch has an SSRF guard** the plan did not ask for:
  http(s) only, no loopback / `*.svc` / `*.cluster.local` / `*.internal` /
  `*.local` / private IP literals, hostname resolved and its address checked,
  redirects followed by hand (max 3) with the same check per hop. This server
  runs in-cluster, so without it a caller could fetch AlertManager or the
  Kubernetes API. DNS rebinding is not defended against.
- **`MAX_UPLOAD_BYTES` moved into `media.core.js`** (was derived in
  `media.routes.js`) so the fetch cap and the multer cap are one constant.
- **`GET /responses` on a survey with no responses now answers `200 []`**, not
  `500`: `response.service.js#getResponses` maps the query's `RequestError` to
  an empty page for REST and MCP alike (agent-api.md §10).
- **`GET /exports/status` for an account with no `users` row answers `200 []`**
  rather than throwing (`exports.service.js#listExports`).
- **A docs base commit** carries the audit, this plan, and the audit's doc
  pass (README Cube.js section, agent-api §10, the exports contract,
  `full-messages-export.md`) onto the branch — they were uncommitted in the
  main checkout and the phases edit those files.
- **Not run locally:** the database-backed suites (`states.test.js`,
  `health.test.js`, `bails.test.js`, media integration). Docker's daemon was
  broken on the build machine. Every hermetic suite is green on Node 22; CI
  (`dashboard-test.yml`) is the gate for the rest. CI ran them green on PR #170.

**Audit this plan implements:** `planning/mcp-coverage-audit.md` (read it
first; §2 is the capability matrix, §5 the design rules, §6 the security
findings, and the DECIDE items are still open).

This document is written for an agent that has not seen the audit
conversation. It says what to build, in what order, in what shape, and how to
know it is done. Where a choice was made, the reason is next to it.

---

## 0. Read before touching anything

In this order. Treat them as ground truth over the code.

1. `CLAUDE.md` — worktree rule, functional-core/imperative-shell rule, docs rule.
2. `dashboard-server/README.md` — "Authentication" (scopes), "`/mcp` and
   delegated authorization", "MCP server (`api/mcp/`)", "Creating a survey
   version is one shared function", the route table, and the new "Cube.js
   analytics" subsection.
3. `documentation/agent-api.md` — §1 (identifiers), §9 (the current MCP
   contract, whose shape every new subsection copies), §10 (`GET /responses`).
4. `planning/mcp-coverage-audit.md` — the matrix and design rules.
5. The existing MCP module, all of it: `dashboard-server/api/mcp/*.js`. It is
   ~2,900 lines including tests and it is the pattern. In particular:
   - `mcp.core.js`: `TOOLS` array of `{name, description, inputSchema}`,
     `SERVER_INSTRUCTIONS`, the small JSON-Schema validator
     (`validateAgainstSchema`, `validateToolArgs`), `toolResult`, `toolError`,
     `invalidArgsError`, and every decision function. **No IO, no clock.**
   - `mcp.tools.js`: `TOOL_SCOPES`, `toolAllowed`, `TOOL_HANDLERS` (three
     steps each: decide in core, do in service, shape in core), `runTool`
     (turns every failure into a tool error; a thrown error with
     `err.expected` becomes its own message, anything else becomes a generic
     one and is logged).
   - `mcp.service.js`: the IO shell. Note the comment explaining why
     `registerSurveyVersion` lives in `api/surveys/survey.service.js` and not
     here. That is the rule for every new tool: **the operation lives with its
     module, MCP calls it**.
   - `mcp.server.js`: one `Server` per request, low-level SDK API on purpose.
   - Tests: `mcp.core.test.js` (asserts on the tool table, including "exactly
     the five tools"), `mcp.tools.test.js` (handlers with a `makeService`
     recorder stub), `mcp.transport.test.js` (real express + real SDK client
     over HTTP, service stubbed), `mcp.routes.test.js` (real app + real auth
     middleware), `mcp.service.test.js`.
6. Per area, the feature doc named in the phase section below.

---

## 1. Ground rules for every tool

These are not suggestions. A PR that breaks one is not mergeable.

1. **Scope = what the REST route derives.** `TOOL_SCOPES[name]` is the
   `resource:action` the middleware would compute for the endpoint the tool
   wraps (first path segment, `GET` → `read`, else `write`). A tool with no
   entry is denied. Never invent a new resource.
2. **Same service function as the controller.** If the controller's logic is
   inline or inside a `makeHandlers` factory, **extract** it into
   `api/<module>/<module>.service.js` as a `req`-free function that takes
   `{email, ...}` and returns a plain result or throws a failure marked
   `expected`. Then make the controller call it too. This is what PR #164 did
   for `registerSurveyVersion` and it is the only acceptable way to share.
   Never call a controller with a fake `req`/`res`.
3. **Ownership goes through the existing gate.** Every query already takes
   `email`. Survey-scoped tools reproduce `validateSurveyNameAccess`
   (`api/states/states.controller.js`) via a shared `resolveSurvey` helper
   (§2.1). Bail tools reproduce `validateUserAccess` via `resolveVlabUser`.
4. **Decisions in `mcp.core.js`, IO in a service.** Clamping a `limit`,
   shaping a result, redacting a field, choosing an error sentence: core.
   Anything that touches `queries/`, the network, or `config`: service.
5. **Every failure is a tool error.** External `502`s (Meta, Linear, Typeform,
   AlertManager, Exodus) become `isError: true` with the upstream message.
   Nothing throws through `runTool`.
6. **Every list is bounded and says how to page.** Clamp in core, return
   `total` or a cursor, and say so in the description.
7. **Descriptions are the product.** First sentence says what the tool does;
   destructive tools open with the warning; every schema property has a
   `description` (an existing test asserts this for all tools).
8. **Hermetic tests.** Handler tests stub the service with the `makeService`
   recorder pattern. Transport tests get at least one `tools/call` per new
   tool through the real SDK client. Never open a pg pool in a unit test.
9. **Docs in the same PR.** `documentation/agent-api.md` §9 gains a
   subsection per area in the exact shape of the current one (Connecting /
   Scopes table / The tools / Failure). The README route table row for `/mcp`
   gets the new count. Feature docs named per phase get a line saying the MCP
   tool exists.

---

## 2. Phase 0 — shared groundwork (one PR, before any tools)

### 2.1 Helpers, in the modules that own them

- `api/states/states.service.js` — new. Exports:
  - `resolveSurvey({email, survey_name})` → `{ok, email, surveyName,
    shortcodes}` or `{ok: false, notFound: true, known: [survey_names]}`.
    Same query and same filtering as `validateSurveyNameAccess`; the
    controller middleware is refactored to call it so there is one
    implementation.
  - `statesSummary`, `listStates`, `stateDetail`, `healthFindings`: thin
    wrappers over `queries/states` and `api/health/{aggregate,evaluate,rules}`
    taking the resolved survey. `getHealth` in `health.controller.js` is
    refactored to call `healthFindings`.
  - `platformNotices()`: the fetch in `getPlatformNotices`, moved here,
    fail-soft unchanged (`{notices: []}` on any failure).
- `api/bails/bails.service.js` — new. `resolveVlabUser({email})` does what
  `validateUserAccess` plus the UI's `POST /users` do together: `User.user`,
  and if absent `User.create`, returning `{id, email}`. The seven bail
  operations become `{email, ...}`-shaped wrappers around `utils/bails`
  (which talks to the Exodus service over HTTP; failures become `expected`).
- `api/exports/exports.service.js` — new. `startExport({email, survey_name,
  export_type, options})` containing the `SOURCE_MAP` + `randomUUID` +
  `Exports.insert` logic from `generateExport`; `listExports({email,
  survey_name?})` over `Exports.all` / `Exports.bySurvey`. Controller
  refactored to call them. Exports are **picked up by the exporter polling
  `export_status`** (`exporter/exporter/main.py`, migration 16); there is no
  Kafka publish, whatever older docs say.
- `api/responses/response.service.js` — `getResponses({email, survey_name,
  after, pageSize})` over `Response.all`, returning rows plus the next cursor
  as the query already shapes it.
- `api/media/media.service.js`, `api/message-templates/message-templates.service.js`
  — extracted from the respective `makeHandlers` factories (Phase C did this).
  `api/tickets/tickets.service.js` was listed here too and is NOT built, since
  the ticket tools are not. The factories keep their dependency injection; the service
  takes the same injected deps as a first argument and the route file builds
  them exactly as it does today.
- `api/credentials/credential.service.js` — `listMessagingAccounts({email})`
  over `Credential.getMessagingAccounts` (already exists in
  `queries/credentials`) projected to `{entity, key, name, created}` **and
  nothing from `details` except a display name / phone number**.

### 2.2 `mcp.core.js` restructuring

- Split `TOOLS` into per-area arrays (`SURVEY_TOOLS`, `MONITORING_TOOLS`,
  `DATA_TOOLS`, `TEMPLATE_TOOLS`, `MEDIA_TOOLS`, `BAIL_TOOLS`,
  `TICKET_TOOLS`, `ACCOUNT_TOOLS`) and export `TOOLS = [].concat(...)`.
  Export the per-area arrays too so tests and docs can assert per area.
- Replace the "exactly the five tools" test with a table-driven one: a
  `TOOL_NAMES` constant in the test listing every expected name, asserted
  equal to `TOOLS.map(t => t.name)`. Adding a tool means adding a name there,
  which is the point.
- Add `clampLimit(value, {default, max})` and `redactCredential(row)` pure
  helpers with their own tests. `redactCredential`'s test walks the result
  recursively and asserts no key named `access_token`, `token`, `secret`,
  `value`, `password`, `id_token` or `refresh_token` exists at any depth.
- `SERVER_INSTRUCTIONS`: keep the current text and append one paragraph per
  area, added in the phase that ships the area (wording in each phase below).
- `mcp.server.js`: keep `SERVER_INFO.name = 'vlab-fly-surveys'` (clients have
  it in config; renaming breaks nothing today but buys nothing either).
  Change `title` to `'Fly'` and bump `version` to `'0.2.0'`.

### 2.3 Common shapes

- Survey-scoped tools take `survey_name` (exact, as in `list_surveys`). On
  miss, the error lists the caller's survey names, as `list_surveys` does.
- Paged list results: `{ total, limit, offset, items }` for offset paging
  (states), `{ page_size, next_cursor, items }` for cursor paging (responses).
- Timestamps as ISO-8601 strings, as the queries already return them.

---

## 3. Phase A — monitoring (5 tools)

Feature docs: `documentation/states-debugging.md`,
`documentation/dashboard-study-health.md`, `documentation/study-error-alerting.md`.

| Tool | Scope | Args | Calls | Returns |
|---|---|---|---|---|
| `get_states_summary` | `surveys:read` | `survey_name` (req) | `resolveSurvey` → `States.summary(email, name, shortcodes)` | The summary rows as the REST endpoint returns them (counts by `state` and form). |
| `list_states` | `surveys:read` | `survey_name` (req); `state?` enum of the eight states; `error_tag?` string; `form?` shortcode; `search?` userid substring; `limit?` int default 50 **max 200**; `offset?` int ≥ 0 | `States.list(email, name, shortcodes, {state, errorTag, form, search, limit, offset})` | `{total, limit, offset, items}`; `items` are the list rows (userid, state, error_tag, stuck_on_question, timeout_date, updated). Check the exact row shape in `queries/states/states.queries.js#list` and copy it. |
| `get_participant_state` | `surveys:read` | `survey_name` (req), `userid` (req) | `States.detail(email, name, shortcodes, userid)` | `{state_json, error_tag, stuck_on_question, timeout_date, state, form_start_time}`; not found → tool error "no participant `userid` in survey". |
| `get_survey_health` | `surveys:read` | `survey_name` (req) | `States.healthSummary` → `buildAggregates(rows, HEALTH_WINDOW_HOURS)` → `evaluate(aggregates, rules)` | `{window_hours, findings, aggregates}`, identical to `GET /health`. |
| `get_platform_notices` | `platform:read` | none | `platformNotices()` | `{notices}`; always succeeds (fail-soft is the endpoint's contract). |

Instructions paragraph to append:

> MONITORING. Participants are always in exactly one state (START, RESPONDING,
> QOUT, END, BLOCKED, ERROR, WAIT_EXTERNAL_EVENT, USER_BLOCKED). Call
> get_states_summary first for counts, then list_states with a `state` or
> `error_tag` filter to find who, then get_participant_state for one person's
> full context. get_survey_health is the same 24-hour findings the dashboard's
> Monitor tab shows. Lists are capped at 200 rows; page with offset.

Tests: core (schemas, clamp, the error-tag enum if one is exposed), tools
(each handler against a recorder stub, including not-found and the clamp),
transport (`tools/call` for `get_states_summary` and `list_states`).

Docs: `agent-api.md` §9 "Monitoring tools" subsection; one line in
`states-debugging.md` and `dashboard-study-health.md` pointing at the tools.

---

## 4. Phase B — data (3 tools)

Feature docs: `documentation/exports-storage.md` ("Request and status
contract" section), `documentation/full-messages-export.md`,
`documentation/agent-api.md` §10.

| Tool | Scope | Args | Calls | Returns |
|---|---|---|---|---|
| `start_export` | `exports:write` | `survey_name` (req); `export_type` enum `responses` \| `chat_log` \| `full_messages` (req); `options` object whose allowed keys depend on `export_type` (validate in core: the `responses`/`chat_log` keys and the `full_messages` keys are listed in `exports-storage.md`) | `resolveSurvey` (to refuse a survey you do not own before inserting) → `startExport` | `{export_id, status: 'Requested', note}` where `note` says to poll `list_exports` and that the link expires 7 hours after completion. |
| `list_exports` | `exports:read` | `survey_name?` | `listExports` | `{items: [{id, survey_name, source, status, export_link, updated, retry_count, options}]}`; `status` is one of `Requested`, `Processing`, `Completed`, `Failed`. |
| `get_responses` | `responses:read` | `survey_name` (req); `after?` opaque cursor; `page_size?` default 25 **max 500** | `getResponses` | `{page_size, next_cursor, items}` with the row shape §10 of `agent-api.md` documents. |

Instructions paragraph:

> DATA. Exports are asynchronous: start_export returns an id, the exporter
> picks it up within seconds, and list_exports shows the status and, once
> Completed, a download URL valid for 7 hours. Fetch that URL yourself; no tool
> returns file contents. get_responses is for looking at answers in pages, not
> for bulk — use an export for that. Reading answers needs the responses:read
> scope, which is separate from surveys:read on purpose.

Tests as Phase A, plus a core test that `start_export` rejects an option key
that belongs to a different `export_type`.

Docs: `agent-api.md` §9 "Data tools"; `exports-storage.md` gains a line under
the contract section.

---

## 5. Phase C — templates and media (6 tools)

Feature docs: `documentation/utility-messages.md`,
`documentation/media-abstraction.md`, `dashboard-server/README.md` §11
(media) and the message-templates section.

Prerequisite refactor: extract `message-templates.service.js` and
`media.service.js` from the `makeHandlers` factories, keeping the injected
deps (`credentialQuery`, `templateQuery`, `facebookClient`, `whatsappClient`;
`mediaQuery`, `storage`, `platformUpload`, `newId`). The route files build the
deps as today; `mcp.service.js` imports the same builders. Do this as its own
commit with the existing controller tests still green before adding tools.

| Tool | Scope | Args | Notes |
|---|---|---|---|
| `list_message_templates` | `templates:read` | none | Rows include `status` and `rejection_reason`. |
| `get_message_template` | `templates:read` | `id` | |
| `create_message_template` | `templates:write` | `account_id`, `name`, `language`, `body`, `buttons?`, `examples?` — copy the schema from `validateCreateInput` in `message-templates.core.js` | Submits to Meta for approval; result carries `status: PENDING` and a note that approval takes time and `list_message_templates` shows it. Meta error → tool error with Meta's message. |
| `delete_message_template` | `templates:write` | `id` | Description opens: "Deletes the template at Meta as well as in Fly; this cannot be undone." |
| `list_media` | `media:read` | none | Rows: `{id, filename, mediaType, mimeType, byteSize, created, url}`. |
| `upload_media` | `media:write` | exactly one of `source_url` or `content_base64`; `filename` (req); `mime_type?` | Service fetches `source_url` with a byte cap equal to `MAX_UPLOAD_BYTES` from `media.routes.js` (derived from `MEDIA_TYPE_LIMITS`), then runs the same `validateUpload` → `hashContent` → `buildAssetRecord` → store → fan-out path as the controller. Dedupe hit returns the existing asset with `deduplicated: true`. Description steers to `source_url`. |

Instructions paragraph:

> MESSAGING ASSETS. Media uploaded with upload_media gets a permanent public URL
> to reference from questions (see the `description` YAML of
> create_typeform_form). Utility message templates are submitted to Meta and
> must be approved before they can be sent; check status with
> list_message_templates.

Tests: the extraction commit keeps every existing controller test green;
new service tests; handler and transport tests as before; a test that
`upload_media` refuses when both or neither source is given and when the
fetched body exceeds the cap.

---

## 6. Phase D — bails and accounts (9 tools built), tickets (4, not built)

Feature docs: `documentation/bail-systems.md` (the `definition` grammar is
§4–5 there), `documentation/tickets.md`, `dashboard-server/README.md`
"Credentials and the messaging account registry".

Bails (scope `users:*`, all through `resolveVlabUser` so the agent never sees
a user id):

| Tool | Scope | Args |
|---|---|---|
| `list_bails` | `users:read` | none |
| `get_bail` | `users:read` | `bail_id` |
| `create_bail` | `users:write` | `name`, `definition`, `description?`, `destination_form?`, `enabled?` — the `definition` schema is written out in JSON Schema from `bail-systems.md` §4–5, with the grammar summarised in the property description |
| `update_bail` | `users:write` | `bail_id` plus any of the create fields; `enabled` alone is the toggle |
| `delete_bail` | `users:write` | `bail_id`; description opens with the warning |
| `preview_bail` | `users:write` | `definition`; returns the match count. `write` because REST derives it from `POST`; keep parity |
| `list_bail_events` | `users:read` | `bail_id?`, `limit?` default 100 max 500; without `bail_id` it is the user-wide `bail-events` feed |

Tickets (scope `tickets:*`) — **not built**, see the status note at the top.
Kept here as written in case that is revisited; it would go via a
`tickets.service.js` extracted from `makeHandlers` with the Linear client
injected as today:

| Tool | Scope | Args |
|---|---|---|
| `list_tickets` | `tickets:read` | none |
| `get_ticket` | `tickets:read` | `id`; includes `comments` |
| `create_ticket` | `tickets:write` | `title`, `description`, `survey_name?`, `user_ids?` (array; the `triage-linear-tickets` skill reads these) |
| `reply_to_ticket` | `tickets:write` | `id`, `body` |

Accounts:

| Tool | Scope | Args | Notes |
|---|---|---|---|
| `list_messaging_accounts` | `credentials:read` | none | Through `redactCredential`; the recursive no-secret test is mandatory. |
| `list_typeform_forms` | `surveys:read` | none | `TypeformUtil.TypeformFormList(token)`; no stored token → tool error "connect Typeform in the dashboard first". Returns `{id, title, last_updated_at}` per form. |

Instructions paragraph:

> BAIL SYSTEMS route participants who match a condition to another form; the
> condition grammar is in create_bail's schema. preview_bail tells you how many
> would match before you enable one.

(The shipped `BAILS_NOTE` says more than this — that a bail moves live people,
that it belongs to the researcher rather than to a survey, and that an enabled
"immediate" bail keeps firing. `ACCOUNTS_NOTE` covers the two lists and says
that nothing here writes a credential or a key. There is no tickets
paragraph.)

---

## 7. Phase E — analytics (deferred, 3 tools) and the Cube.js fix

Not part of this release. Recorded so the next planner does not re-derive it.

- Do **not** wrap `/cubejs-api` (unscoped; audit §6).
- Build scoped queries in `queries/responses` that compute what the five
  reports compute in the browser: participation timeline (start and end time
  per user → histogram and duration percentiles), answer distribution per
  question, last-question drop-off. Expose as `get_participation_timeline`,
  `get_answer_distribution`, `get_dropoff`, scope `responses:read`.
- Fix Cube.js in the same piece of work: a `queryRewrite` in the
  `CubejsServerCore` options that injects a `Responses.formid IN (...)` filter
  from the caller's surveys, or retire Cube once the REST queries exist.

---

## 8. Open decisions (need a human before Phase D)

**Decided 2026-09-09.** The MCP surface writes no credential and no API key at
all; both are dashboard-only, where a human does them. There is therefore no
`auth:*` scope anywhere in `TOOL_SCOPES`.

| Item | Recommendation | Decision |
|---|---|---|
| `set_secret`, `set_reloadly_credential` | Exclude | **Excluded.** An agent cannot read a credential back to check it, so a bad write is invisible until a survey breaks |
| `mint_api_key` | Exclude | **Excluded.** Not an escalation (REST caps a new key at the caller's own scopes), but it lets an agent create a credential that outlives the session |
| `revoke_api_key` | Include in D | **Excluded** — against the recommendation. Key lifecycle stays entirely human; an agent that finds a leaked key reports it |
| `preview_bail` as `write` | Keep parity with REST | **Kept.** Every scope in the table is the one its REST route derives, with no exceptions to remember |

---

### Where Phase D deviated from this plan, and why

- **The `definition` schema is not fully written out in JSON Schema.** §6 asked
  for it; the condition tree is recursive, `validateAgainstSchema` has no
  `$ref`, and a `$ref`/`$defs` schema advertised through `tools/list` is not
  safely portable across MCP clients. Bounded-depth expansion was the
  alternative and would have added several KB to every `tools/list` while still
  rejecting a legal deeper tree. So `BAIL_CONDITION_SCHEMA` validates one level
  and carries the whole grammar in its description; Exodus validates the depth
  below and its rejections are relayed verbatim.
- **`validateBailDefinition` checks time formats**, which the plan did not ask
  for. It is not a duplicate of Exodus's validation: Exodus checks that
  `time_of_day` / `timezone` / `datetime` are *present* and not that they are
  well formed, and a malformed one is stored and then silently skipped forever
  with no error event. That is the one bail failure invisible from the outside.
- **`buildBailRequest` reconciles the two `destination_form`s** — the row column
  and `definition.action.destination_form`. The dashboard writes both; an agent
  setting one would get a validation failure or a blank display.
- **`list_bail_events` cuts the per-bail page client-side.** That Exodus
  endpoint takes no limit and returns the whole history; only the user-wide feed
  has one.
- **The bails controller was rewired onto its service** in this PR:
  `bails.service.js` existed from Phase 0 but nothing called it, and rule 1 (§1)
  says the tool and the controller call the same function.
- **`api/typeform/typeform.service.js` is new**: `GET /typeform/form` did the
  token lookup inline, and `list_typeform_forms` needed the same one.

---

## 9. Release

One dashboard release after the last built phase merges, following exactly
what shipped v0.0.74 (git log `deploy: dashboard v0.0.74`):

1. Each phase is its own PR to `main`, green on `dashboard-test.yml`, merged
   in order 0 → A → B → C → (D).
2. Tag `dashboard-v0.0.75` on `main`; wait for `release.yml` to push
   `ghcr.io/vlab-research/dashboard:v0.0.75`.
3. `devops/values/staging.yaml` `versionDashboard` → `v0.0.75`; drift check
   (`helm get values gbv -n vstag` vs the file); `helm upgrade gbv vlab -f
   values/staging.yaml -n vstag`; rollout status.
4. Verify on staging from inside the pod (staging signs with its own secret,
   so a production key is refused there): mint a token with
   `utils/auth/auth.util#makeAPIToken` in a `kubectl exec node -e` and call
   `tools/list` (count must equal `TOOLS.length`) and one read tool per area.
5. Same for `production.yaml` / `vprod`; verify with `$FLY_API_KEY` from a
   laptop: `tools/list`, `get_states_summary` on a real survey,
   `list_exports`, `list_media`.
6. Deploy commit with both values files, message in the v0.0.74 style.

---

## 10. Definition of done, per phase

- [ ] Service functions extracted; controller calls them; controller tests unchanged and green.
- [ ] Tools in `TOOL_SCOPES`, per-area array in `mcp.core.js`, handlers in `mcp.tools.js`.
- [ ] `TOOL_NAMES` in `mcp.core.test.js` updated; every property has a description.
- [ ] Handler tests with the recorder stub: happy path, not-found / not-yours, clamp or validation edge.
- [ ] Transport test: at least one `tools/call` per new tool through the SDK client.
- [ ] `redactCredential` recursive test (Phase D) and `upload_media` source tests (Phase C).
- [ ] `SERVER_INSTRUCTIONS` paragraph appended.
- [ ] `documentation/agent-api.md` §9 subsection; README `/mcp` row count; feature doc line.
- [ ] `npm run lint` and `npm test` clean on Node 22.
