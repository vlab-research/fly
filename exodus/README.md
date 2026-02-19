# Exodus

Bail systems service for automated user bailouts in surveys. When users get stuck, time out, or hit error states during chatbot-driven surveys, exodus identifies them via configurable conditions and redirects them to a destination form.

## Architecture

Exodus is a single Go binary that runs in two modes:

- **Executor** (`--mode=executor`): Runs once, processes all enabled bails, then exits. Deployed as a Kubernetes CronJob (every minute). Queries the `states` table for users matching bail conditions, then sends bailout events to botserver.
- **API** (`--mode=api`): Long-running HTTP server for CRUD management of bail configurations. Deployed as a Kubernetes Deployment. Used by the dashboard.

Both modes share the same database connection and config. The executor is the workhorse; the API is the management plane.

## Directory Structure

```
exodus/
  main.go              # Entry point, mode switching (api/executor)
  config/config.go     # Environment variable parsing (caarlos0/env)
  types/types.go       # Domain types: Bail (with user_id), BailDefinition, Condition, Execution, Action
  db/
    db.go              # Connection pool, generic Query method
    bails.go           # CRUD for chatroach.bails table (GetBailsByUser, CreateBail, UpdateBail, DeleteBail)
    events.go          # Insert/query for chatroach.bail_events table (user-scoped)
  query/builder.go     # Translates bail conditions into parameterized SQL against states table
  executor/
    executor.go        # Orchestrates bail processing: load -> query -> send -> record
    timing.go          # Determines if a bail should fire based on timing config
  sender/sender.go     # HTTP client that POSTs bailout events to botserver
  api/
    server.go          # Echo HTTP server setup and route registration (user-scoped routes)
    handlers.go        # Handler implementations for all endpoints (user-scoped)
    types.go           # Request/response structs
  chart/               # Helm chart (CronJob + Deployment)
  Dockerfile           # Multi-stage build (golang:1.23-alpine -> alpine)
```

## Configuration

All config is via environment variables (parsed by `caarlos0/env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `CHATBASE_DATABASE` | `chatroach` | CockroachDB database name |
| `CHATBASE_HOST` | `localhost` | Database host |
| `CHATBASE_PORT` | `5433` | Database port |
| `CHATBASE_USER` | `root` | Database user |
| `CHATBASE_PASSWORD` | (empty) | Database password |
| `BOTSERVER_URL` | `http://localhost:8080/synthetic` | Botserver synthetic event endpoint |
| `EXODUS_RATE_LIMIT` | `1s` | Delay between bailout sends |
| `EXODUS_MAX_BAIL_USERS` | `100000` | Max users to bail per bail definition per run |
| `PORT` | `8080` | API server port (api mode only) |
| `DRY_RUN` | `false` | Log bailouts without sending to botserver |

Validation is mode-specific: executor requires `BOTSERVER_URL`, api requires `PORT`.

## Database

Uses CockroachDB (accessed via pgx). Two tables in the `chatroach` schema:

### `chatroach.bails`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key (auto-generated) |
| `user_id` | UUID | Owning user (FK to users table) |
| `name` | TEXT | Human-readable name |
| `description` | TEXT | Optional description |
| `enabled` | BOOL | Whether executor processes this bail |
| `definition` | JSONB | Full bail definition (conditions, execution timing, action) |
| `destination_form` | TEXT | Shortcode of the form to bail users into (denormalized from definition.action) |
| `created_at` | TIMESTAMPTZ | Auto-set on insert |
| `updated_at` | TIMESTAMPTZ | Auto-set on insert and update |

### `chatroach.bail_events`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key (auto-generated) |
| `bail_id` | UUID | FK to bails (nullable for orphaned events) |
| `user_id` | UUID | Owning user context |
| `bail_name` | TEXT | Bail name at time of event |
| `event_type` | TEXT | `"execution"` or `"error"` |
| `timestamp` | TIMESTAMPTZ | Auto-set on insert |
| `users_matched` | INT | Users that matched conditions |
| `users_bailed` | INT | Users successfully bailed |
| `definition_snapshot` | JSONB | Bail definition at time of execution |
| `error` | JSONB | Error details (null for successful executions) |

## API Endpoints

All bail endpoints are scoped under `/users/:userId`. A bail belongs to a user and can reference any form shortcode in its conditions.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/users/:userId/bails` | List all bails for a user (includes last event) |
| `POST` | `/users/:userId/bails` | Create a new bail |
| `POST` | `/users/:userId/bails/preview` | Dry-run a bail definition, returns matching users |
| `GET` | `/users/:userId/bails/:id` | Get a single bail (includes last event) |
| `PUT` | `/users/:userId/bails/:id` | Update a bail (partial updates supported) |
| `DELETE` | `/users/:userId/bails/:id` | Delete a bail |
| `GET` | `/users/:userId/bails/:id/events` | Get event history for a bail |
| `GET` | `/users/:userId/bail-events?limit=N` | Get recent events for a user (default 100, max 1000) |

## Query DSL

Bail conditions are JSON objects that translate to parameterized SQL against the `states` table. Conditions can be composed with logical operators.

### Condition Types

| Type | Fields | SQL Generated |
|------|--------|---------------|
| `form` | `value` | `s.current_form = $N` |
| `state` | `value` | `s.current_state = $N` |
| `error_code` | `value` | `s.state_json->'error'->>'code' = $N` |
| `current_question` | `value` | `s.state_json->>'question' = $N` |
| `elapsed_time` | `since`, `duration` | CTE join on `responses` table, checks `response_time + interval < NOW()` |

### Logical Operators

Conditions can be combined with `and`, `or`, and `not`:

| Operator | Children | SQL Generated |
|----------|----------|---------------|
| `and` | 1 or more | `(child1 AND child2 AND ...)` |
| `or` | 1 or more | `(child1 OR child2 OR ...)` |
| `not` | exactly 1 | `NOT (child)` |

Example with `and`:

```json
{
  "op": "and",
  "vars": [
    {"type": "form", "value": "survey_a"},
    {"type": "state", "value": "QOUT"},
    {"type": "elapsed_time", "duration": "4 weeks", "since": {
      "event": "response",
      "details": {"question_ref": "q1", "form": "survey_a"}
    }}
  ]
}
```

Example with `not` (negate a single condition):

```json
{"op": "not", "vars": [{"type": "state", "value": "END"}]}
```

Generates: `NOT (s.current_state = $1)`

Example with `not` wrapping a group:

```json
{
  "op": "not",
  "vars": [{
    "op": "and",
    "vars": [
      {"type": "form", "value": "survey_v1"},
      {"type": "state", "value": "END"}
    ]
  }]
}
```

Generates: `NOT ((s.current_form = $1 AND s.current_state = $2))`

**Constraint**: The `not` operator cannot wrap `elapsed_time` conditions (directly or transitively). This is rejected at validation time because negating elapsed_time would require LEFT JOIN + IS NULL handling to correctly include users who never responded.

The `elapsed_time` condition generates a CTE that joins the `responses` table to find when a user last answered a specific question, then checks if that time plus the duration is before now.

Operators nest arbitrarily. The builder wraps each group in parentheses for correct SQL precedence.

### Generated SQL Shape

The query builder produces SQL of this form:

```sql
SELECT DISTINCT s.userid, s.pageid
FROM states s
[optional CTE JOINs for elapsed_time conditions]
WHERE [condition clauses]
LIMIT 100000
```

The default query limit of 100,000 is a safety cap.

### Duration Format

PostgreSQL interval format: `"<number> <unit>"` where unit is one of: `seconds`, `minutes`, `hours`, `days`, `weeks`, `months`, `years`.

## Executor Flow

1. Load all enabled bails from `chatroach.bails`
2. For each bail (with panic recovery and error isolation):
   a. Parse and validate the JSON definition
   b. Check timing (`shouldExecute`): immediate always fires; scheduled checks time-of-day in timezone with 24h dedup; absolute fires once after target datetime
   c. Build SQL from conditions via `query.BuildQuery`
   d. Execute query against CockroachDB, get `(userid, pageid)` pairs
   e. Apply `MaxBailUsers` limit
   f. Send bailout events to botserver via HTTP POST with rate limiting
   g. Record a `bail_events` row with `user_id` (execution or error)
3. Individual bail failures are logged and recorded but do not stop processing of other bails

## Sender

Sends HTTP POST requests to botserver's `/synthetic` endpoint. Each bailout is a JSON payload:

```json
{
  "user": "<userid>",
  "page": "<pageid>",
  "event": {
    "type": "bailout",
    "value": {
      "form": "<destination_form>",
      "metadata": {}
    }
  }
}
```

Sends are rate-limited (configurable via `EXODUS_RATE_LIMIT`). Failures for individual users are logged but do not stop remaining sends. Supports dry-run mode.

## Deployment

### Docker

Multi-stage build: `golang:1.23-alpine` for compilation, `alpine` for runtime. Default entrypoint runs executor mode.

```
docker build -t vlabresearch/exodus .
docker run vlabresearch/exodus --mode=executor
docker run vlabresearch/exodus --mode=api
```

### Helm Chart

Located in `chart/`. Deploys two resources from the same image:

- **CronJob** (`executor.enabled: true`): Runs every minute, `concurrencyPolicy: Forbid`, 1h deadline. Default.
- **Deployment** (`api.enabled: false`): ClusterIP service on port 80 -> container port 8080. Disabled by default until dashboard integration is ready.

See `chart/values.yaml` for resource limits and environment variable configuration.

## Dependencies

### Go Modules

- `github.com/jackc/pgx/v4` -- PostgreSQL driver (CockroachDB compatible)
- `github.com/labstack/echo/v4` -- HTTP framework (API mode)
- `github.com/caarlos0/env/v6` -- Environment variable config parsing
- `github.com/google/uuid` -- UUID generation and parsing

### External Services

- **CockroachDB**: Primary data store. Uses `chatroach` schema with `states`, `responses`, `bails`, and `bail_events` tables.
- **Botserver**: Receives bailout events at `/synthetic` endpoint. Botserver then redirects the user to the destination form in their next interaction.
