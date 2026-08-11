# Support Requests + Linear Sync — Implementation Plan

> Status: **planning only — not built yet.** This document captures everything needed to implement the feature end-to-end. Pick up at step 0 when ready.

## 1. Goal

Dashboard users (survey owners) create **support requests** describing a problem. For each request they tag one or more **affected respondent userids**. The backend:

1. Verifies all respondent userids exist in the `states` table.
2. Builds an **immutable snapshot** for each affected userid:
   - full `states` row (the user's state-machine record),
   - the most recent N messages from `chatroach.messages` (default 500, ≤5000),
   - the canonical `surveys.form_json` for the survey version that user was on (resolved via shortcode + `form_start_time`).
3. Persists the request + snapshot to a new `support_requests` table.
4. Pushes the snapshot to **Linear** so the agent can debug without DB access.

Dashboard users see only their own requests; Linear sees all requests in one team.

## 2. Architecture

```
                                     ┌──────────────────────────┐
dashboard-client  ──POST /support──▶ │  dashboard-server        │
                                     │  - validates userids     │
   Support │ NewSupport │ Detail     │  - assembles snapshot    │   snapshot row  ──INSERT──▶  chatroach.support_requests
                                     │                          │
                                     │  status = CREATED        │                                status: CREATED
                                     └──────────────────────────┘                                       │
                                                                                                        │
                                                                    K8s CronJob (every 2 min)            │
                                                                    support-cron.js                      │
                                                                    reads CREATED/LINEAR_FAILED         │
                                                                    calls Linear issueCreate            │
                                                                    updates row ────────────────────────┘
```

## 3. Data Model

### 3.1 Migration — `devops/migrations/18-support-requests.sql`

```sql
CREATE TABLE IF NOT EXISTS chatroach.support_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    userid          UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
    title           VARCHAR NOT NULL,
    description     TEXT NOT NULL,                          -- markdown
    affected_userids VARCHAR[] NOT NULL,                    -- respondent userids
    messages_limit  INT NOT NULL DEFAULT 500,               -- ≤ 5000 (validated app-side)
    snapshot        JSONB NOT NULL,                         -- built at insert time, immutable
    linear_issue_id VARCHAR,
    linear_issue_url VARCHAR,
    status          VARCHAR NOT NULL DEFAULT 'CREATED',     -- CREATED | LINEAR_FAILED | LINEAR_CREATED
    error           TEXT,
    retry_count     INT NOT NULL DEFAULT 0,
    next_retry_at   TIMESTAMPTZ,
    created         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX (userid, created DESC),
    INDEX (status, next_retry_at)
);

GRANT SELECT, INSERT, UPDATE ON TABLE chatroach.support_requests TO chatroach;
```

### 3.2 Schema rationale

- `userid` = the survey owner (same model as `surveys`, `message_templates`).
- `affected_userids` is the array the user supplied — kept verbatim for audit. The persisted `snapshot` is the source of truth for the Linear ticket body.
- `snapshot` frozen at insert time so the Linear ticket always reflects the database as it was when the user reported.
- `status` is the sync state for the cron job.
- `next_retry_at` decouples backoff from scheduler cadence so we can run the cron at 2-min intervals.

## 4. API Endpoints

All routes under `/api/v1/support`. Auth via existing `middleware/auth.js`. Every read/write is scoped to `req.user.email` → `users.id`.

### 4.1 `POST /` — create support request

**Request**
```json
{
  "title": "Form 305 stuck on payment for multiple users",
  "description": "Users report being asked for payment method repeatedly...",
  "affectedUserIds": ["105839823491", "298471029384"],
  "messagesLimit": 500
}
```

**Validation (server-side)**
- `title`, `description`, `affectedUserIds` required.
- `affectedUserIds` non-empty array of strings.
- `messagesLimit` <= 5000, default 500.

**Validation (DB)**
- Every `affectedUserIds[i]` must have a row in `states`. If any are missing → `404` with `missing: [...]`.

**Behavior**
1. Build snapshot (see §5).
2. INSERT row with `status='CREATED'`.
3. Return `{ id, status: 'CREATED' }`.

**Response — `201 Created`**
```json
{
  "id": "7d5e6f2a-...",
  "status": "CREATED"
}
```

### 4.2 `GET /` — list current user's requests

Query: `SELECT * FROM support_requests WHERE userid = $1 ORDER BY created DESC LIMIT 50 OFFSET $2`. Returns `[{ id, title, status, affected_userids, linear_issue_url, created, retry_count }, ...]`.

### 4.3 `GET /:id` — request detail

Returns the full row (including `snapshot`). 404 if not owned by the caller. Never returns rows owned by other users.

### 4.4 Retry endpoint (optional — `POST /:id/retry`)

Resets `next_retry_at = NOW()` so the next cron tick picks it up. Only valid when `status='LINEAR_FAILED'`. Not strictly necessary — `retry_count++` already automatically advances the backoff; but useful after a Linear outage is resolved.

## 5. Snapshot Assembly (Pure Function)

Lives in `dashboard-server/api/support/snapshot.js`. **Pure** — takes inputs, returns the snapshot object. All DB I/O happens in the **imperative shell** (`support.controller.js`).

### 5.1 Inputs

```
{
  affectedUserIds: string[],
  messagesLimit: number
}
```

### 5.2 Shape

```js
{
  users: [
    {
      userid, pageid, current_state, current_form,
      error_tag, fb_error_code, stuck_on_question,
      form_start_time, updated,
      state_excerpt: <trimmed state_json — keys dropped: 'md', 'qa' tail > 20 items>,
      messages: [ { timestamp, content }, ... ],
      form_json: <the surveys.form_json for shortcode + form_start_time>,
      form_resolution: { survey_id, shortcode, form_start_time }   // for audit
    }
  ],
  captured_at: <ISO timestamp>
}
```

### 5.3 Pure functions

- `selectUsers(statesRows)` → `{ userid, pageid, ... }` (drops `state_json`, keeps denormalized columns).
- `selectMessages(messagesRows)` → `[{ timestamp, content }]`.
- `resolveSurvey(surveysRows, state)` → latest survey where `shortcode = state.current_form AND created <= state.form_start_time` (mirrors the rule in `dashboard-server/queries/states/states.queries.js:46` SCOPE_SQL).
- `trimStateJson(json)` → kept keys whitelist + tail-cap on `qa`.
- `buildSnapshot({ reportTitle, reportDescription, capturedAt, users })` → final shape.

### 5.4 Imperative shell

```
async function assemble(email, env) {
  const userRow = await User.user({ email });
  const rows = await Promise.all(env.affectedUserIds.map(getStateRow));
  const unknown = rows.filter(r => r == null).map(...);
  if (unknown.length) throw new RequestError(404, { missing: unknown });
  const users = await Promise.all(rows.map(async (s) => {
    const msgs = await getMessages(s.userid, env.messagesLimit);
    const surveyRow = await resolveSurveyRow(userRow.id, s.current_form, s.form_start_time);
    return {
      ...selectUsers(s),
      messages: selectMessages(msgs),
      form_json: surveyRow ? surveyRow.form_json : null,
      form_resolution: surveyRow ? { survey_id: surveyRow.id, shortcode: s.current_form, form_start_time: s.form_start_time } : null,
      state_excerpt: trimStateJson(s.state_json),
    };
  }));
  return buildSnapshot({ ...env, captured_at: new Date().toISOString(), users });
}
```

### 5.5 Snapshot tests

- Mocha tests for each pure function with hardcoded fixtures.
- Controller test verifies that 404 bubbles up with `missing: [...]`.

## 6. Linear Integration

### 6.1 Utility — `dashboard-server/utils/linear/linear.util.js`

Two pure functions + one IO wrapper.

#### `buildIssueBody({ title, description, snapshot })` → string (pure)

- YAML frontmatter at top — title + description, escaped.
- One `## User <userid>` section per user.
- Each section contains:
  - State snapshot (kv table).
  - Last N messages (table with timestamp + content, capped to e.g. 200 chars per row to avoid huge bodies).
  - `### form_json (resolved)` — collapsible markdown block (Linear will render as a code block).
- Total body **hard-cap**: 60 000 chars (Linear limit ≈ 60k; soft cap at 55k to leave headroom). If overflow, head + tail with `…truncated…` marker.

#### `buildGraphqlVariables({ teamId, title, body })` → object (pure)

```js
{
  teamId,
  title,
  description: body
}
```

#### `createIssueLinear({ apiKey, teamId, title, body })` → Promise<{ id, identifier, url }> (IO)

- `POST https://api.linear.app/graphql`
- Headers: `Authorization: ${apiKey}` (Linear Personal API keys expect the raw key, no `Bearer ` prefix required, but using `Bearer` works too; use the format Linear documents).
- GraphQL:
  ```graphql
  mutation IssueCreate($teamId: String!, $title: String!, $description: String!) {
    issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
      success
      issue { id identifier url }
    }
  }
  ```
- Use `r2` (already a dep) for the HTTP call. Parse JSON.
- On `success: true` → return `{ id, identifier, url }`.
- On `success: false` or HTTP non-200 → throw with the GraphQL `errors[].message` joined.

### 6.2 Config — `dashboard-server/config/index.js`

Add to joi schema:
```js
LINEAR_API_KEY: joi.string().optional().empty(''),
LINEAR_TEAM_ID: joi.string().optional().empty(''),
LINEAR_API_URL: joi.string().optional().empty(''),
```

Add to `config`:
```js
LINEAR: {
  apiKey: envVars.LINEAR_API_KEY,
  teamId: envVars.LINEAR_TEAM_ID,
  url: envVars.LINEAR_API_URL || 'https://api.linear.app/graphql',
},
```

If `LINEAR.apiKey` is empty at request time → return 503 ("Linear not configured") with a clear error message.

### 6.3 Helm values — `devops/values/production.yaml` & `staging.yaml`

Add under `dashboard.env`:
```yaml
- name: LINEAR_API_KEY
  valueFrom:
    secretKeyRef:
      name: gbv-linear
      key: api-key
- name: LINEAR_TEAM_ID
  value: "<uuid>"
- name: LINEAR_API_URL
  value: 'https://api.linear.app/graphql'
```

The `gbv-linear` secret is created via `kubectl create secret generic gbv-linear --from-literal=api-key=...` in the cluster setup. Reference only — outside the scope of this plan.

## 7. Reconciliation Cron Job

### 7.1 New file — `dashboard-server/support-cron.js`

Stand-alone process that:

1. Connects to the DB via the same `pg` pool config.
2. Every tick:
   ```
   SELECT * FROM support_requests
   WHERE status IN ('CREATED', 'LINEAR_FAILED')
     AND (next_retry_at IS NULL OR next_retry_at <= NOW())
   ORDER BY created ASC
   LIMIT 50
   ```
3. For each row, in serial (not parallel — Linear rate limits):
   - Pull `(title, description, snapshot)` and POST to Linear.
   - On success:
     ```
     UPDATE support_requests SET status='LINEAR_CREATED', linear_issue_id=..., linear_issue_url=..., error=NULL, retry_count=retry_count+1, updated=NOW()
     ```
   - On failure: increment `retry_count`, set `next_retry_at = NOW() + INTERVAL '<backoff>'`.
     Backoff: `retry_count=0 → 1m, 1 → 5m, 2 → 30m, 3 → 2h, ≥4 → 6h`.
     Set `status='LINEAR_FAILED'`, capture error message.
4. Sleep until next tick (configurable via `SUPPORT_CRON_INTERVAL_MS`, default 30_000).

NOTE: the cron scheduling is driven by the K8s CronJob (`§7.2`); the in-process loop is a fallback that runs if the pod is the cron target — same code path either way.

### 7.2 K8s CronJob — `dashboard-server/chart/templates/cronjob.yaml`

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: {{ include "dashboard.fullname" . }}-support-sync
  labels:
    {{- include "dashboard.labels" . | nindent 4 }}
spec:
  schedule: "*/2 * * * *"              # every 2 min
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: support-sync
              image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
              imagePullPolicy: {{ .Values.image.pullPolicy }}
              command: ["node", "support-cron.js"]
              envFrom:
                - secretRef: { name: "{{ .Values.envFrom }}" }
              env:
                {{- toYaml .Values.env | nindent 14 }}
                - name: SUPPORT_CRON_INTERVAL_MS
                  value: "0"                            # run once per pod invocation; K8s handles schedule
              resources:
                {{- toYaml .Values.resources | nindent 14 }}
```

Add `supportCron:` boolean and schedule override to `dashboard-server/chart/values.yaml` and the umbrella `devops/values/production.yaml` (`dashboard.supportCron.enabled: true`).

### 7.3 Tests

- `support-cron.test.js` — proxyquire mocks `r2.post(...).json` to a fixture response; verifies that:
  - Successful response → row transitions to `LINEAR_CREATED`.
  - Error response → row transitions to `LINEAR_FAILED`, `next_retry_at` is in the future.
  - Backoff is monotonic with `retry_count`.

## 8. Frontend

New `/support` route with three views. Auth-aware via existing `PrivateRoute`.

### 8.1 Routing (`dashboard-client/src/containers/App/App.js`)

```jsx
<PrivateRoute path="/support" exact component={Support} />
<PrivateRoute path="/support/new" component={NewSupportRequest} />
<PrivateRoute path="/support/:id" component={SupportDetail} />
```

### 8.2 Navbar

Add `Support` link styled like existing top-level entries. Routes to `/support`.

### 8.3 `src/containers/Support/Support.js` (list view)

- Ant `Table` columns: `Title | Status (Tag colored by status) | Affected (count) | Linear Issue (link if exists) | Created | Actions`.
- New request button → `/support/new`.
- Actions: `Open`, plus `Retry` (only when status is `LINEAR_FAILED`).

### 8.4 `src/containers/Support/NewSupportRequest.js` (form)

- Ant `Form`:
  - `title` — Input, required.
  - `description` — `Input.TextArea` with markdown hint, required.
  - `affectedUserIds` — `Select mode="tags"` — paste comma-separated user IDs, or one-at-a-time. Required, min 1.
  - `messagesLimit` — `InputNumber`, default 500, max 5000.
  - `Submit` → POST `/support`; on `201` redirect to `/support/:id`.
- Error handling: `400` (validation) and `404 missing: [...]` shown inline via Ant `Alert`.

### 8.5 `src/containers/Support/SupportDetail.js` (detail)

- Display: title, description (raw markdown), affected userids list, snapshot previews (one panel per user — `Collapse` with state table, messages table, form_json collapsible).
- Status badge, retry button if applicable.
- Linear issue link inline if issue created.
- Auto-polls every 5s while status is `CREATED` or `LINEAR_FAILED` to pick up the cron sync.

### 8.6 API client

Add `src/services/api/support.js`:

```js
import api from '.';
export const createSupport = (body) =>
  api.fetcher({ method: 'POST', path: '/support', body }).then(r => r.json());
export const listSupport = () =>
  api.fetcher({ path: '/support' }).then(r => r.json());
export const getSupport = (id) =>
  api.fetcher({ path: `/support/${id}` }).then(r => r.json());
export const retrySupport = (id) =>
  api.fetcher({ method: 'POST', path: `/support/${id}/retry` }).then(r => r.json());
```

## 9. Implementation Steps (Worktree)

Worktree: `../fly-support-requests` on branch `feature/support-requests`.

```
git worktree add ../fly-support-requests -b feature/support-requests
cd ../fly-support-requests
npm install                              # in dashboard-server and dashboard-client
```

Order:

1. **DB migration** — add `devops/migrations/18-support-requests.sql`. Run locally: `psql -h localhost -p 5433 -U root chatroach -f devops/migrations/18-support-requests.sql` (or whatever the dev cockroach-compose uses).
2. **Queries** — `dashboard-server/queries/support/support.queries.js` (model pattern: `index.js`, `MODULE_NAME`, `queries(pool) => ({ create, list, get, markSynced, markFailed })`). Add to `queries/index.js` loop automatically via the dir-scan (no edit needed there).
3. **Snapshot builder** — `dashboard-server/api/support/snapshot.js`, `snapshot.test.js`.
4. **Linear util** — `dashboard-server/utils/linear/linear.util.js`, `linear.util.test.js` (proxyquire to stub fetch). Update `dashboard-server/utils/index.js`.
5. **Config** — update `dashboard-server/config/index.js` with LINEAR_* env vars.
6. **Controller** — `dashboard-server/api/support/support.controller.js` + `support.routes.js` + `support.test.js`. Wire into `dashboard-server/api/index.js`.
7. **Cron job** — `dashboard-server/support-cron.js` + `support-cron.test.js`.
8. **Chart** — `dashboard-server/chart/templates/cronjob.yaml`; add env vars to `dashboard-server/chart/templates/deployment.yaml`; add `supportCron:` flag to `dashboard-server/chart/values.yaml`. Update `devops/values/production.yaml` and `staging.yaml` with `LINEAR_*` env vars + `dashboard.supportCron.enabled`.
9. **Frontend** — `dashboard-client/src/containers/Support/{index.js, Support.js, NewSupportRequest.js, SupportDetail.js}`, `dashboard-client/src/services/api/support.js`. Update `App.js` routes. Update Navbar.
10. **Documentation** — `documentation/support-requests.md` (see §11). Update `dashboard-server/README.md` and `dashboard-client/README.md`.
11. **Verification** — `npm run lint` + `npm test` in both client and server.

## 10. Edge Cases & Decisions Recorded

| Decision | Rationale |
|----------|-----------|
| Sync via Linear system API key + teamId | User picked "System API key per team". |
| Source = `messages` table (raw FB events) | User picked `messages` over `chat_log`. (Note: `messages.content` is a single VARCHAR; `chat_log` is richer — escalate to revisit if richer event context is required.) |
| Affected userids validated via `states` only | We only need the row to exist; missing users is a meaningful error to surface. |
| Derive `form_json` from state | User said "form json comes from DB". Resolved via the canonical rule from `states.queries.js` SCOPE_SQL. |
| Snapshot is JSONB, immutable post-insert | Re-sync to Linear uses the same snapshot. |
| Default 500 messages, ≤5000 | Per user. |
| Persisted in our DB + separate reconciliation | Linear-any-user / dashboard-scoped. |
| K8s CronJob (recommended over Kafka) | User picked K8s cron, simpler plumbing. |
| Linear API via raw `r2.post` | Avoids adding `@linear/sdk` dep — Linear's GraphQL is small and stable. |
| Status enum: CREATED / LINEAR_FAILED / LINEAR_CREATED | Linear writes to one team — per-row teamId override deferred to a future column. |
| Retry backoff: 1m / 5m / 30m / 2h / 6h cap | Reasonable for an MVP. |

## 11. Documentation — `documentation/support-requests.md` outline

```
# Support Requests

## Overview
- What a support request is.
- What Linear gets.
- Failure modes and retries.

## Request shape
- POST /api/v1/support body
- What each field does.

## Snapshot assembly
- Why we freeze at insert time.
- Per-userid sections.
- form_json resolution rule.

## Linear integration
- Required env vars.
- Mutation used.
- Body size cap.
- What an agent sees on the Linear side.

## Reconciliation cron
- Schedule.
- Backoff table.
- Manual retry endpoint.

## Frontend
- Routes.
- Polling for status updates.

## Failure modes
- 404 missing userids.
- 503 Linear not configured.
- LINEAR_FAILED status after retries — what to do.

## Files touched
- Migration.
- Queries.
- Controller + routes.
- Util.
- Cron.
- Frontend.
- Chart.
```

## 12. Verification Checklist (Pre-merge)

- [ ] Migration applies cleanly to a chatroach instance.
- [ ] `npm test` in `dashboard-server` passes.
- [ ] `npm test` in `dashboard-client` passes.
- [ ] `npm run lint` in both passes.
- [ ] Manual: `POST /support` with 2 known userids → 201, snapshot stored, cron tick (manual) marks `LINEAR_CREATED`.
- [ ] Manual: `POST /support` with 1 unknown userid → 404 `{ missing: [...] }`.
- [ ] Manual: `POST /support` with `messagesLimit: 5001` → 400.
- [ ] Manual: K8s CronJob container exists and the schedule is registered.
- [ ] Manual: FE poll picks up the cron update within 5s.

## 13. Risks & Open Questions

1. **Body size cap** — if a user includes many userids OR very chatty messages tables, the body could exceed Linear limits. Current plan: 60k char cap, head+tail truncate. Will revisit if real traffic shows us under-truncating.
2. **Rate limits** — Linear personal API key (`api.linear.app/graphql`) rate-limits at ~1500 req/h. Cron batches 50 rows per tick × 2 ticks/min = 100 reqs/min. Safe headroom, but worth monitoring.
3. **`messages` content** — single VARCHAR; rich event payloads are in `chat_log`. If we need the raw event later, we'd switch to `chat_log` and pagination.
4. **Per-row `linear_team_id`** — currently all rows go to one team. Add a column later if multi-tenant Linear workspaces are needed.
5. **Retention** — `support_requests` rows stay forever by default. Add a TTL job if Linear fills up.

---

**Implementation order recap**: DB → queries → snapshot (pure) → linear util (pure) → config → controller → cron → chart → frontend → docs → verify.
