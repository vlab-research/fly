# Support Tickets

## Overview

Dashboard users (survey owners) can file **support tickets** from the dashboard and hold a conversation with the support team. The dashboard stores **nothing** about tickets locally — it is a thin UI over [Linear](https://linear.app). Every ticket is a Linear issue in a single configured team; every reply is a Linear comment.

Users see only their own tickets. The support team sees all tickets in Linear and replies there; those replies flow back into the dashboard conversation view.

## Data flow

```
dashboard-client                dashboard-server                 Linear (GraphQL)
  POST /tickets  ──────────────▶ tickets.controller.create ──▶ issueCreate
  GET  /tickets   ─────────────▶ tickets.controller.list   ──▶ team.issues (filter by reporter)
  GET  /tickets/:id ───────────▶ tickets.controller.getOne ──▶ issue(id) + comments
  POST /tickets/:id/replies ───▶ tickets.controller.reply  ──▶ commentCreate
```

No database tables, no migrations, no cron. The `dashboard-server` proxies every call to Linear using a service-account API key.

## Reporter scoping (no local storage)

Because nothing is stored locally, "my tickets" cannot be a DB query. Instead each issue's description ends with a machine sentinel:

```
*vlab-reporter:alice@vlab.com*
```

- **List** fetches the team's recent issues (`team(id).issues(first: 100)`) and filters server-side by the sentinel matching `req.user.email`.
- **Detail / reply** fetch the issue by id and verify the sentinel matches the caller. A mismatch returns `404` (not `403`) so the existence of other users' tickets is not leaked.
- The sentinel is also stamped on every reply comment body, so comments authored via the dashboard are attributed to the reporter in the UI ("You"); Linear-side comments show the Linear user's name.

The sentinel is stripped from the body before display in the dashboard.

## Context fields

The create form encourages structured context:

- **Title** (required)
- **Description** (required, free text)
- **Impacted survey** — a dropdown populated from the caller's `/surveys` (unique `survey_name` values). Optional.
- **Impacted user IDs** — free text, comma/space/newline separated. Optional.

The server assembles these into the Linear issue description as a labeled **Context** block followed by the reporter sentinel:

```
<user description>

---

**Context**
- **Survey:** HPV Nigeria
- **Impacted user IDs:** 105839823491, 298471029384

*vlab-reporter:alice@vlab.com*
```

## Conversation model (single-lane)

Linear comments can be nested (replies to comments). The dashboard **flattens** all comments into a single chronological thread (oldest first) so the user sees a simple single-lane conversation. User replies are always created as top-level comments (no parent), keeping the thread flat.

## Configuration

Required `dashboard-server` env vars:

| Variable | Purpose |
|----------|---------|
| `LINEAR_API_KEY` | Linear personal/service API key. Sent as the raw `Authorization` header value. |
| `LINEAR_TEAM_ID` | The Linear team UUID to file issues into. |
| `LINEAR_API_URL` | Optional. Defaults to `https://api.linear.app/graphql`. |

When `LINEAR_API_KEY` or `LINEAR_TEAM_ID` is unset, all `/tickets` endpoints return `503` with a clear message, so misconfiguration fails loud rather than silently.

New tickets are created in the **Todo** state (not Linear's default Backlog). The state ID is configured via `LINEAR_TODO_STATE_ID` (Virtual Lab team's Todo state: `ebc049cd-ca61-4ef2-a117-250bd08873f9`). If unset, tickets fall back to Linear's default state.

In Kubernetes, `LINEAR_API_KEY` should come from a secret (e.g. `kubectl create secret generic gbv-linear --from-literal=api-key=...`) and `LINEAR_TEAM_ID` from a plain env value. See `devops/values/production.yaml`.

## API

All routes under `/api/v1/tickets`, authenticated via the existing Auth0 JWT middleware. Every read/write is scoped to `req.user.email` via the reporter sentinel.

| Method & route | Behavior |
|----------------|----------|
| `GET /tickets` | List the caller's tickets (newest first). Each item: `{ id, identifier, url, title, state, priority, createdAt, updatedAt }`. |
| `POST /tickets` | Create a ticket. Body: `{ title, description, surveyName?, userIds? }`. Returns the formatted issue. |
| `GET /tickets/:id` | Get a ticket + its flattened comments. 404 if missing or not owned by caller. |
| `POST /tickets/:id/replies` | Add a reply. Body: `{ body }`. Returns a synthesized comment (the created comment id + attributed body). 404 if not owned by caller. |

Errors: `400` validation, `404` not found / not owned, `502` Linear upstream failure, `503` Linear not configured.

## Linear GraphQL operations

| Operation | GraphQL |
|-----------|---------|
| Create issue | `mutation IssueCreate($input: IssueCreateInput!)` with `{ teamId, title, description }` |
| List team issues | `query TeamIssues($teamId: String!, $first: Int)` → `team(id).issues.nodes` |
| Get issue + comments | `query Issue($id: String!)` → `issue(id)` with `comments(first: 100).nodes` |
| Create comment | `mutation CommentCreate($input: CommentCreateInput!)` with `{ issueId, body }` |

The HTTP client uses `r2` (existing dep) and posts JSON `{ query, variables }` with `Authorization: <apiKey>` and `Content-Type: application/json`. GraphQL `errors[]` are joined and thrown; non-2xx becomes a `502` at the controller.

## Frontend

Routes (in `src/root.js`, all `PrivateRoute`):

- `/tickets` — list view (`Tickets.js`)
- `/tickets/new` — create form (`NewTicket.js`)
- `/tickets/:id` — detail + conversation + reply (`TicketDetail.js`)

Nav item "Support" added to `Navbar.js`. Containers live in `src/containers/Tickets/` and use the standard `api.fetcher` pattern (no separate service file, matching `MessageTemplates`).

## Files

Backend (`dashboard-server`):
- `config/index.js` — `LINEAR_API_KEY` / `LINEAR_TEAM_ID` / `LINEAR_API_URL` env vars
- `utils/linear/linear.core.js` — pure transforms (description assembly, reporter sentinel, formatting)
- `utils/linear/linear.util.js` — GraphQL HTTP client + `makeClient` factory
- `api/tickets/tickets.core.js` — input validation (pure)
- `api/tickets/tickets.controller.js` — `makeHandlers` (DI) — list, create, getOne, reply
- `api/tickets/tickets.routes.js` — wires handlers with the real Linear client
- `api/index.js` — registers `/tickets`
- Tests: `linear.core.test.js`, `tickets.core.test.js`, `tickets.controller.test.js`

Frontend (`dashboard-client`):
- `src/containers/Tickets/{Tickets,NewTicket,TicketDetail}.js`
- `src/containers/Tickets/index.js` (barrel)
- `src/containers/index.js`, `src/root.js`, `src/components/Navbar/Navbar.js` (wiring)

## Failure modes

- **503 Linear not configured** — set `LINEAR_API_KEY` and `LINEAR_TEAM_ID`.
- **502 Linear upstream failure** — Linear API error or network issue; message forwarded to the UI.
- **404 on detail/reply** — issue missing OR not owned by caller (deliberately indistinguishable).
- **List misses older tickets** — `list` fetches the most recent 100 team issues. If a reporter has filed more than 100 tickets across the team, older ones won't appear. Revisit with server-side filtering if volume grows.

## Open questions / future work

- **Smarter context fields** — the impacted-survey dropdown is the first structured field; add impacted-form (shortcode) selection and user-id validation against `states` in a later iteration.
- **Ticket categories** — v1 is a single generic "support ticket". Add Bug / Support / Question categories mapped to Linear labels when needed.
- **Status polling** — the list/detail views do not auto-refresh; a user must reload to see new replies. Add polling if real-time feel is wanted.
- **Custom-field filtering** — if Linear exposes a reliable custom-field filter on `issues`, switch `list` from fetch-and-JS-filter to a server-side filter to scale beyond 100 tickets.
