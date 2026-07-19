---
description: "Triage or respond to support tickets filed via the dashboard. Fetches Linear issues in the Virtual Lab team, parses the vlab-reporter marker to identify who filed each ticket, looks up that user and their impacted user IDs in CockroachDB, investigates their survey/state data, and posts a reply comment back on the Linear issue. Use when the user says 'triage tickets', 'check support tickets', 'respond to Linear tickets', or asks to review new support requests."
allowed-tools: ["Bash", "Read", "Grep", "Glob", "WebFetch"]
---

# Triage Linear Tickets

Support tickets filed from the dashboard (`fly.vlab.digital/tickets`) are Linear issues in the **Virtual Lab** team (team ID `004fb90f-35c7-47dd-afd1-0bc5c71bed67`, key `VIR`). Each issue's description ends with a machine sentinel `*vlab-reporter:<email>*` identifying the dashboard user who filed it. Replies posted from the dashboard appear as Linear comments with the same sentinel.

This skill covers the full triage loop: fetch tickets → identify reporter → investigate their data → reply.

## Linear access

A Linear MCP server is configured in this project's MCP config. Use the MCP tools to query and mutate Linear if available. The key operations:

| Action | How |
|--------|-----|
| List team issues | Query `team(id: "004fb90f-35c7-47dd-afd1-0bc5c71bed67") { issues(first: 50) { nodes { id identifier url title description state { name } createdAt comments { nodes { id body createdAt user { name } } } } } }` |
| Get a single issue + comments | Query `issue(id: "<id>") { id identifier title description state { name } comments(first: 100) { nodes { id body createdAt user { name } } } }` |
| Post a reply comment | Mutation `commentCreate(input: { issueId: "<id>", body: "<your reply>" })` |
| Change issue state | Mutation `issueUpdate(input: { id: "<id>", stateId: "<stateId>" })` |

If the MCP is unavailable, use curl with the API key from `devops/dev/.env-prod` (`LINEAR_API_KEY`):

```bash
KEY=$(grep -E '^LINEAR_API_KEY=' devops/dev/.env-prod | cut -d= -f2)
curl -s https://api.linear.app/graphql \
  -H "Authorization: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"query { team(id: \"004fb90f-35c7-47dd-afd1-0bc5c71bed67\") { issues(first: 50) { nodes { id identifier title description state { name } createdAt } } } }"}'
```

## Identifying the reporter

Parse the `vlab-reporter:<email>` marker from the issue description or comment body. The marker is always on the last line, wrapped in asterisks (italic markdown):

```
*vlab-reporter:alice@vlab.com*
```

Extract with: look for `vlab-reporter:` in the description, then read until the next whitespace, backtick, asterisk, or newline. That email is the dashboard user who filed the ticket — and the user you need to investigate in the database.

The issue description also contains an optional **Context** block with:
- `**Survey:** <survey_name>` — the impacted survey
- `**Impacted user IDs:** <comma-separated list>` — respondent userids the reporter flagged

## Database access

The dashboard-server connects to CockroachDB. Connection details are in `dashboard-server/config/index.js` → `DATABASE_CONFIG`, populated from env vars (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_DATABASE`, `DB_PASSWORD`). In production these come from the `production.yaml` values:

- Host: the CockroachDB cluster (check `devops/values/production.yaml` for `DB_HOST`)
- Port: `26257`
- Database: `chatroach`
- User: `chatroach`

Connect with `psql` or a Node script using the `pg` package. The fastest path for ad-hoc queries:

```bash
psql "postgresql://chatroach@<db-host>:26257/chatroach" -c "<query>"
```

If psql isn't available or you need the password, read it from the `gbv-bot-envs` Kubernetes secret:

```bash
kubectl -n <namespace> get secret gbv-bot-envs -o go-template='{{.data.DB_PASSWORD | base64decode}}'
```

## What to look up

### 1. The reporter (dashboard user)

```sql
-- Find the user account by email
SELECT id, email FROM users WHERE email = '<reporter-email>';
```

### 2. The reporter's surveys

```sql
-- All surveys owned by this user
SELECT s.id, s.shortcode, s.survey_name, s.title, s.created, ss.off_time, ss.timeouts
FROM surveys s
LEFT JOIN users u ON s.userid = u.id
LEFT JOIN survey_settings ss ON s.id = ss.surveyid
WHERE u.email = '<reporter-email>'
ORDER BY s.created DESC;
```

If the ticket names an impacted survey, filter on `s.survey_name = '<survey_name>'` to narrow to that survey's shortcodes.

### 3. Impacted user IDs (respondents)

If the ticket includes impacted user IDs, look up their current state:

```sql
-- Current state of each impacted respondent
SELECT userid, pageid, current_state, current_form, error_tag,
       stuck_on_question, form_start_time, updated
FROM states
WHERE userid = ANY(ARRAY['<id1>', '<id2>', ...]::varchar[]);
```

If the ticket names an impacted survey, also check which form version each respondent was on:

```sql
-- Resolve which survey version each impacted user was on
SELECT st.userid, st.current_form, st.current_state, st.error_tag,
       s.survey_name, s.title, s.created AS form_created
FROM states st
LEFT JOIN surveys s ON s.shortcode = st.current_form
  AND s.userid = (SELECT id FROM users WHERE email = '<reporter-email>')
  AND s.created <= st.form_start_time
WHERE st.userid = ANY(ARRAY['<id1>', '<id2>', ...]::varchar[])
ORDER BY st.userid;
```

### 4. Recent messages for a respondent (if deeper investigation needed)

```sql
-- Last 50 messages for a specific respondent
SELECT timestamp, content
FROM messages
WHERE userid = '<respondent-userid>'
ORDER BY timestamp DESC
LIMIT 50;
```

## Triage workflow

1. **Fetch all team issues** from Linear (via MCP or curl). Filter to issues that contain `vlab-reporter:` in the description — those are dashboard-filed tickets.
2. **For each ticket** that needs triage (state is "Todo" or has no reply yet):
   - Parse the reporter email from the `vlab-reporter:` marker.
   - Parse the impacted survey name and user IDs from the Context block.
   - Look up the reporter in the `users` table to confirm they exist.
   - Look up their surveys (especially the named one, if any).
   - If impacted user IDs are present, query their `states` rows — check for `error_tag`, `stuck_on_question`, `BLOCKED`, `ERROR`, or `WAIT_EXTERNAL_EVENT` states.
   - If a respondent is stuck, optionally pull their recent messages to understand what happened.
3. **Reply on Linear** via `commentCreate` (MCP or curl). Your reply should:
   - Acknowledge the issue and confirm you've looked into it.
   - Share relevant findings: how many impacted users are in error states, what errors they're hitting, which form version they were on.
   - Ask follow-up questions if the context is insufficient.
   - If the issue is resolved or answered, update the state to "Done" via `issueUpdate`.
4. **Do not** include the `vlab-reporter:` marker in your own comments — that sentinel is for dashboard-user-authored replies only. Your comments show the Linear user's name automatically.

## Reply tone

- Be specific and data-driven. Cite actual state values, error tags, and form versions you found.
- If you found a bug or systemic issue, say so and link related evidence (states, messages).
- If the impacted users look healthy (no error states), say that too — it narrows the problem.
- If you cannot find the reporter or their surveys, flag it — the ticket may be from a user whose account is misconfigured.

## State transitions

The Virtual Lab team's workflow states:

| State | Type | When to set |
|-------|------|-------------|
| Todo | unstarted | Default for new tickets — awaiting triage |
| In Progress | started | You are actively investigating |
| In Review | started | You've replied and are waiting for the user to respond |
| Done | completed | Resolved or answered |
| Canceled | canceled | Invalid or duplicate |
| Duplicate | duplicate | Duplicate of another issue |

New tickets arrive in "Todo". After you reply, move to "In Review" (waiting for user response). When resolved, "Done".

## Key files for reference

- `documentation/tickets.md` — how the ticket system works end-to-end
- `dashboard-server/utils/linear/linear.core.js` — pure transforms (sentinel parsing, description assembly)
- `dashboard-server/queries/users/user.queries.js` — user lookup SQL
- `dashboard-server/queries/surveys/survey.queries.js` — survey lookup SQL
- `dashboard-server/queries/states/states.queries.js` — state lookup SQL (version resolution logic)
- `devops/values/production.yaml` — database connection details and Linear team/state IDs
