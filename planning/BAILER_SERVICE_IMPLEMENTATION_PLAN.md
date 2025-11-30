# Bailer Service Implementation Plan

## Overview

This document describes the design and implementation plan for a formalized **Bailer Service** - a database-driven, UI-manageable system for moving users between forms based on configurable triggers and conditions.

### Goals

1. Replace ad-hoc bailer-job Kubernetes manifests with a unified service
2. Enable non-technical users to create and manage bails via UI
3. Support flexible trigger conditions (absolute time, relative time, time-of-day)
4. Maintain the dean-like pattern (Go service, CronJob, database-driven)
5. No raw SQL exposure to users (security)

### Non-Goals

1. Real-time bail triggering (batch processing is sufficient)
2. User-local timezone support (explicit timezones only)

---

## Current State Analysis

### Existing Patterns from bailer-job

Audited 21 Kubernetes manifests in `bailer-job/kube/`. Key patterns identified:

| Pattern | Example | Frequency |
|---------|---------|-----------|
| Form + State + Relative Time | Users on form X in WAIT_EXTERNAL_EVENT for > 4 weeks | ~40% |
| Form + State + Error Code | Users on form X in BLOCKED with error code 10 | ~25% |
| Form Only | All users on form X | ~20% |
| Form + Response History | Users who responded to question Y before date Z | ~10% |
| Form + State + Question | Users on form X in QOUT at question Y | ~5% |

### Execution Patterns

| Schedule Type | Example | Use Case |
|---------------|---------|----------|
| Daily at fixed time | `0 15 * * *` | Regular timeout recovery |
| Every N days | `0 18 */2 * *` | Error retry |
| Specific date/time | `0 10 22 11 *` | End of study |
| One-time Job | Kubernetes Job (not CronJob) | Manual intervention |

### Timezone Usage

- Most use UTC implicitly
- One example uses explicit timezone: `timeZone: "Asia/Jakarta"`

---

## Data Model

### Design Rationale

The data model uses two tables:

1. **`bails`** - Mutable bail definitions, one row per bail (survey + name unique)
2. **`bail_events`** - Immutable event log with definition snapshots (currently just executions, but flexible for future event types)

This approach provides:
- Simple queries for active bails
- Full audit trail via execution history
- Definition snapshot at execution time (know exactly what ran)
- Ability to restrict edits after a bail has fired (optional)

### Database Schema

```sql
-- Bail definitions (mutable)
CREATE TABLE bails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity: unique bail = survey + name
  survey_id UUID NOT NULL REFERENCES surveys(id),
  name STRING NOT NULL,

  -- Content
  description STRING,
  enabled BOOL NOT NULL DEFAULT true,
  definition JSONB NOT NULL,

  -- Denormalized for querying (extracted from definition.action.destination_form)
  destination_form STRING NOT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Constraints
  UNIQUE (survey_id, name),

  -- Indexes
  INDEX idx_bails_survey (survey_id),
  INDEX idx_bails_enabled (enabled)
);

-- Bail events (immutable log)
CREATE TABLE bail_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Reference to bail (may be null if bail was deleted)
  bail_id UUID REFERENCES bails(id) ON DELETE SET NULL,

  -- Snapshot of bail identity at event time
  survey_id UUID NOT NULL,
  bail_name STRING NOT NULL,

  -- Event type: 'execution' or 'error'
  event_type STRING NOT NULL DEFAULT 'execution',

  -- Event details
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  users_matched INT NOT NULL DEFAULT 0,
  users_bailed INT NOT NULL DEFAULT 0,

  -- Snapshot of definition at event time (for audit)
  definition_snapshot JSONB NOT NULL,

  -- Error details (null for successful executions)
  error JSONB,

  -- Indexes
  INDEX idx_bail_events_bail (bail_id, timestamp DESC),
  INDEX idx_bail_events_survey (survey_id, timestamp DESC)
);
```

### Key Behaviors

**Creating a bail:**
```sql
INSERT INTO bails (survey_id, name, description, enabled, definition, destination_form)
VALUES ($1, $2, $3, $4, $5, $6);
```

**Updating a bail:**
```sql
UPDATE bails
SET definition = $1, destination_form = $2, enabled = $3, updated_at = now()
WHERE id = $4;
```

**Optional: Prevent updates after execution:**
```sql
-- Check if bail has ever executed before allowing update
SELECT COUNT(*) FROM bail_events WHERE bail_id = $1 AND event_type = 'execution';
-- If count > 0, reject update (or warn user)
```

**Get active bails for execution:**
```sql
SELECT * FROM bails WHERE enabled = true;
```

**Record execution event:**
```sql
INSERT INTO bail_events (bail_id, survey_id, bail_name, event_type, users_matched, users_bailed, definition_snapshot)
VALUES ($1, $2, $3, 'execution', $4, $5, $6);
```

**Get event history for a bail:**
```sql
SELECT * FROM bail_events
WHERE bail_id = $1
ORDER BY timestamp DESC;
```

**Get event history for a survey:**
```sql
SELECT * FROM bail_events
WHERE survey_id = $1
ORDER BY timestamp DESC;
```

### Bail Definition Schema (JSON)

```typescript
interface BailDefinition {
  // Conditions: unified predicates for WHO and WHEN (combined with AND/OR)
  conditions: Condition;

  // Execution: When to actually send the bail?
  execution: {
    timing: "immediate" | "scheduled" | "absolute";

    // For scheduled:
    time_of_day?: string;               // "09:00", "15:30"
    timezone?: string;                  // "UTC", "Africa/Lagos", "Asia/Jakarta"

    // For absolute:
    datetime?: string;                  // ISO 8601: "2025-12-15T10:00:00Z"
  };

  // Action: What to do?
  action: {
    destination_form: string;           // Required: where to send them
    metadata?: Record<string, any>;     // Optional: extra metadata to pass
  };
}

// Recursive condition type with AND/OR support
type Condition =
  | SimpleCondition
  | { op: "and", vars: Condition[] }
  | { op: "or", vars: Condition[] };

// Simple condition types
type SimpleCondition =
  // User/state predicates
  | { type: "form", value: string }
  | { type: "state", value: string }
  | { type: "error_code", value: string }
  | { type: "current_question", value: string }

  // Time-based predicate
  | { type: "elapsed_time", since: TimeReference, duration: string };

// TimeReference: points to an event with a timestamp
// Currently only "response" is implemented, but the structure supports future event types
type TimeReference =
  | { event: "response", details: { question_ref: string, form: string } }
  // Future: { event: "form_start" }
  // Future: { event: "wait_start" }
  // Future: { event: "payment", details: { provider: string, status: string } }
```

### Example Definitions

**1. Timeout Recovery (most common pattern)**

```json
{
  "conditions": {
    "op": "and",
    "vars": [
      { "type": "form", "value": "bebbobg2basebul" },
      { "type": "state", "value": "WAIT_EXTERNAL_EVENT" },
      {
        "type": "elapsed_time",
        "since": { "event": "response", "details": { "question_ref": "thankyou_you_qualify", "form": "bebbobg2basebul" } },
        "duration": "4 weeks"
      }
    ]
  },
  "execution": {
    "timing": "scheduled",
    "time_of_day": "15:00",
    "timezone": "UTC"
  },
  "action": {
    "destination_form": "bebbobgintermediatebail"
  }
}
```

**2. Error Code Recovery**

```json
{
  "conditions": {
    "op": "and",
    "vars": [
      { "type": "form", "value": "bebbobgfueng" },
      { "type": "state", "value": "BLOCKED" },
      { "type": "error_code", "value": "10" }
    ]
  },
  "execution": {
    "timing": "scheduled",
    "time_of_day": "18:00",
    "timezone": "UTC"
  },
  "action": {
    "destination_form": "bebbobgfueng"
  }
}
```

**3. End of Study (absolute date)**

```json
{
  "conditions": { "type": "form", "value": "sigapbridgeind" },
  "execution": {
    "timing": "absolute",
    "datetime": "2025-11-22T10:00:00+07:00"
  },
  "action": {
    "destination_form": "sigapendline"
  }
}
```

**4. Question-specific bail**

```json
{
  "conditions": {
    "op": "and",
    "vars": [
      { "type": "form", "value": "urdupaywave1" },
      { "type": "state", "value": "QOUT" },
      { "type": "current_question", "value": "hello_again" }
    ]
  },
  "execution": {
    "timing": "immediate"
  },
  "action": {
    "destination_form": "urdupaywave1bail"
  }
}
```

**5. Complex OR condition (4 weeks after qualification OR 6 weeks after consent)**

```json
{
  "conditions": {
    "op": "and",
    "vars": [
      { "type": "form", "value": "myform" },
      { "type": "state", "value": "WAIT_EXTERNAL_EVENT" },
      {
        "op": "or",
        "vars": [
          {
            "type": "elapsed_time",
            "since": { "event": "response", "details": { "question_ref": "qualification", "form": "myform" } },
            "duration": "4 weeks"
          },
          {
            "type": "elapsed_time",
            "since": { "event": "response", "details": { "question_ref": "consent", "form": "myform" } },
            "duration": "6 weeks"
          }
        ]
      }
    ]
  },
  "execution": {
    "timing": "scheduled",
    "time_of_day": "09:00",
    "timezone": "UTC"
  },
  "action": {
    "destination_form": "myform_bail"
  }
}
```

---

## Architecture

### Service Design

```
┌─────────────────────────────────────────────────────────────┐
│                     Bailer Service (Go)                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                    Main Loop                         │   │
│  │                                                      │   │
│  │  1. Load enabled bails from DB                       │   │
│  │  2. For each bail:                                   │   │
│  │     a. Check if execution should fire now            │   │
│  │     b. If yes: build SQL, query users, post bails    │   │
│  │     c. Record event in bail_events table             │   │
│  │  3. Sleep until next tick                            │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Execution    │  │ Query        │  │ Bail             │  │
│  │ Checker      │  │ Builder      │  │ Sender           │  │
│  │              │  │              │  │                  │  │
│  │ - immediate  │  │ - DSL → SQL  │  │ - Rate limiting  │  │
│  │ - scheduled  │  │ - Params     │  │ - HTTP POST      │  │
│  │ - absolute   │  │ - Safe joins │  │ - Error handling │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
    ┌─────────────┐     ┌──────────┐         ┌──────────┐
    │   bails     │     │  states  │         │ botserver│
    │   table     │     │responses │         │/synthetic│
    ├─────────────┤     │ surveys  │         └──────────┘
    │   bail_     │     └──────────┘
    │   events    │
    └─────────────┘
```

### Deployment Model

```yaml
# Kubernetes CronJob - runs every minute
apiVersion: batch/v1
kind: CronJob
metadata:
  name: vlab-bailer
spec:
  schedule: "* * * * *"  # Every minute
  concurrencyPolicy: Forbid  # IMPORTANT: Prevents parallel runs, allowing large user sets to complete
  jobTemplate:
    spec:
      activeDeadlineSeconds: 3600  # 1 hour max per run
      template:
        spec:
          containers:
          - name: bailer
            image: vlabresearch/bailer:2.0.0
            env:
            - name: DB_URL
              value: "postgres://..."
            - name: BOTSERVER_URL
              value: "http://gbv-botserver"
            - name: DRY_RUN
              value: "false"
```

**Note on Large User Runs**: With `concurrencyPolicy: Forbid`, if a bail matches 10,000+ users, the job will run to completion (up to `activeDeadlineSeconds`) before the next scheduled run starts. Combined with rate limiting on the bail sender, this ensures all users get processed without overwhelming botserver.

### Execution Timing Logic

```go
// shouldExecute determines if a bail should run now
// Uses lastExecution to prevent double-execution for scheduled/absolute bails
func shouldExecute(bail *Bail, now time.Time, lastExecution *time.Time) bool {
    exec := bail.Definition.Execution

    switch exec.Timing {
    case "immediate":
        // Always execute on every tick
        return true

    case "absolute":
        // Execute if we're past the datetime AND haven't already executed
        target, _ := time.Parse(time.RFC3339, exec.Datetime)
        if now.Before(target) {
            return false // Not yet time
        }
        if lastExecution != nil {
            return false // Already ran
        }
        return true

    case "scheduled":
        // Execute if current time matches time_of_day in timezone
        loc, _ := time.LoadLocation(exec.Timezone)
        localNow := now.In(loc)
        targetTime, _ := time.Parse("15:04", exec.TimeOfDay)

        // Check if we're within the execution window (1 minute)
        localMinute := localNow.Hour()*60 + localNow.Minute()
        targetMinute := targetTime.Hour()*60 + targetTime.Minute()
        if localMinute != targetMinute {
            return false
        }

        // Check if we already ran in this scheduled window
        // A "window" is defined as: target time has passed AND less than 24h since last execution
        if lastExecution != nil {
            hoursSinceLastExec := now.Sub(*lastExecution).Hours()
            if hoursSinceLastExec < 24 {
                return false // Already ran in the last 24 hours
            }
        }
        return true
    }

    return false
}
```

The executor fetches the last successful execution time for each bail before checking timing:

```go
func (e *Executor) Run() {
    bails := e.db.GetEnabledBails()
    now := time.Now()

    for _, bail := range bails {
        // Get last successful execution for this bail
        lastExec := e.db.GetLastSuccessfulExecution(bail.ID)

        if shouldExecute(bail, now, lastExec) {
            e.executeBail(bail)
        }
    }
}
```

### Query Builder (DSL to SQL)

The query builder recursively walks the condition tree and generates SQL. Each condition type maps to a SQL fragment, and AND/OR operators combine them.

```go
// QueryBuilder holds state during query construction
type QueryBuilder struct {
    params       []interface{}
    paramIdx     int
    ctes         []string    // Common Table Expressions
    responseCTEs []string    // Track response CTE names for joins
}

func (qb *QueryBuilder) nextParam(val interface{}) string {
    qb.params = append(qb.params, val)
    idx := qb.paramIdx
    qb.paramIdx++
    return fmt.Sprintf("$%d", idx)
}

// BuildQuery generates SQL from a bail definition
func BuildQuery(def *BailDefinition) (string, []interface{}) {
    qb := &QueryBuilder{paramIdx: 1}

    whereClause := qb.buildCondition(def.Conditions)

    // Build final query with any CTEs
    var query string
    if len(qb.ctes) > 0 {
        query = "WITH " + strings.Join(qb.ctes, ", ") + " "
    }
    query += `SELECT DISTINCT s.userid, s.pageid FROM states s`

    // Add joins for each response-based CTE
    for i, cteName := range qb.responseCTEs {
        alias := fmt.Sprintf("rt%d", i)
        query += fmt.Sprintf(` JOIN %s %s ON s.userid = %s.userid`, cteName, alias, alias)
    }

    query += " WHERE " + whereClause

    return query, qb.params
}

// buildCondition recursively processes the condition tree
func (qb *QueryBuilder) buildCondition(cond Condition) string {
    switch c := cond.(type) {
    case *AndCondition:
        parts := make([]string, len(c.Vars))
        for i, v := range c.Vars {
            parts[i] = qb.buildCondition(v)
        }
        return "(" + strings.Join(parts, " AND ") + ")"

    case *OrCondition:
        parts := make([]string, len(c.Vars))
        for i, v := range c.Vars {
            parts[i] = qb.buildCondition(v)
        }
        return "(" + strings.Join(parts, " OR ") + ")"

    case *SimpleCondition:
        return qb.buildSimpleCondition(c)
    }
    return "TRUE"
}

// buildSimpleCondition handles individual condition types
func (qb *QueryBuilder) buildSimpleCondition(c *SimpleCondition) string {
    switch c.Type {
    case "form":
        return fmt.Sprintf("s.current_form = %s", qb.nextParam(c.Value))

    case "state":
        return fmt.Sprintf("s.current_state = %s", qb.nextParam(c.Value))

    case "error_code":
        return fmt.Sprintf("s.state_json->'error'->>'code' = %s", qb.nextParam(c.Value))

    case "current_question":
        return fmt.Sprintf("s.state_json->>'question' = %s", qb.nextParam(c.Value))

    case "elapsed_time":
        return qb.buildElapsedTime(c.Since, c.Duration)
    }
    return "TRUE"
}

// buildElapsedTime handles time-based conditions with different event sources
// Each call generates a uniquely-named CTE to avoid collisions when multiple
// elapsed_time conditions exist in the same query
func (qb *QueryBuilder) buildElapsedTime(since TimeReference, duration string) string {
    switch since.Event {
    case "response":
        details := since.Details

        // Generate unique CTE name for this response condition
        cteIndex := len(qb.responseCTEs)
        cteName := fmt.Sprintf("response_times_%d", cteIndex)
        alias := fmt.Sprintf("rt%d", cteIndex)

        // Add CTE with shortcode filter for safety
        qb.ctes = append(qb.ctes, fmt.Sprintf(`%s AS (
            SELECT userid, MIN(timestamp) as response_time
            FROM responses
            WHERE shortcode = %s AND question_ref = %s
            GROUP BY userid
        )`, cteName, qb.nextParam(details.Form), qb.nextParam(details.QuestionRef)))

        // Track join needed
        qb.responseCTEs = append(qb.responseCTEs, cteName)

        return fmt.Sprintf("%s.response_time + %s::INTERVAL < NOW()", alias, qb.nextParam(duration))

    // Future event types would be added here:
    // case "form_start":
    //     return fmt.Sprintf("s.form_start_time + %s::INTERVAL < NOW()", qb.nextParam(duration))
    // case "wait_start":
    //     return fmt.Sprintf(`timezone('UTC', ...) + %s::INTERVAL < NOW()`, qb.nextParam(duration))
    }
    return "TRUE"
}
```

**Example: Condition to SQL**

Input:
```json
{
  "op": "and",
  "vars": [
    { "type": "form", "value": "myform" },
    { "type": "state", "value": "WAIT_EXTERNAL_EVENT" },
    {
      "type": "elapsed_time",
      "since": { "event": "response", "details": { "question_ref": "qualification", "form": "myform" } },
      "duration": "4 weeks"
    }
  ]
}
```

Output:
```sql
WITH response_times_0 AS (
    SELECT userid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2
    GROUP BY userid
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN response_times_0 rt0 ON s.userid = rt0.userid
WHERE (
    s.current_form = $3
    AND s.current_state = $4
    AND rt0.response_time + $5::INTERVAL < NOW()
)
```

---

## API Design

### REST Endpoints (for Dashboard UI)

Bails are scoped to surveys. All endpoints require survey context.

```
# List bails for a survey
GET /api/surveys/:surveyId/bails
  Response: { bails: Bail[] }

# Get single bail
GET /api/surveys/:surveyId/bails/:id
  Response: Bail

# Create bail
POST /api/surveys/:surveyId/bails
  Body: { name, description?, definition }
  Response: Bail

# Update bail
PUT /api/surveys/:surveyId/bails/:id
  Body: { name?, description?, definition?, enabled? }
  Response: Bail
  Note: May warn/reject if bail has already executed (optional behavior)

# Delete bail
DELETE /api/surveys/:surveyId/bails/:id
  Response: { success: true }

# Preview bail (dry run - show who would be bailed)
POST /api/surveys/:surveyId/bails/:id/preview
  Response: { users: [{userid, pageid}], count: number }

# Preview from definition (without saving)
POST /api/surveys/:surveyId/bails/preview
  Body: { definition }
  Response: { users: [{userid, pageid}], count: number }

# Manually trigger a bail (one-time execution)
POST /api/surveys/:surveyId/bails/:id/trigger
  Response: { execution_id: uuid, users_matched: number, users_bailed: number }

# Get event history for a bail
GET /api/surveys/:surveyId/bails/:id/events
  Response: { events: BailEvent[] }

# Get event history for entire survey
GET /api/surveys/:surveyId/bail-events
  Response: { events: BailEvent[] }
```

### Example API Responses

```json
// GET /api/surveys/:surveyId/bails
{
  "bails": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "survey_id": "123e4567-e89b-12d3-a456-426614174000",
      "name": "4-week timeout",
      "description": "Move users to intermediate form after 4 weeks",
      "enabled": true,
      "destination_form": "bebbobgintermediatebail",
      "definition": { ... },
      "created_at": "2025-01-15T10:00:00Z",
      "updated_at": "2025-01-15T10:00:00Z",
      "last_event": {
        "event_type": "execution",
        "timestamp": "2025-01-20T15:00:00Z",
        "users_bailed": 12
      }
    }
  ]
}

// GET /api/surveys/:surveyId/bails/:id/events
{
  "events": [
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "bail_id": "550e8400-e29b-41d4-a716-446655440000",
      "event_type": "execution",
      "timestamp": "2025-01-20T15:00:00Z",
      "users_matched": 15,
      "users_bailed": 15,
      "definition_snapshot": { ... }
    },
    {
      "id": "660e8400-e29b-41d4-a716-446655440002",
      "bail_id": "550e8400-e29b-41d4-a716-446655440000",
      "event_type": "execution",
      "timestamp": "2025-01-19T15:00:00Z",
      "users_matched": 8,
      "users_bailed": 8,
      "definition_snapshot": { ... }
    }
  ]
}

// POST /api/surveys/:surveyId/bails/preview
{
  "users": [
    {"userid": "10017573934948776", "pageid": "1855355231229529"},
    {"userid": "10017573934948777", "pageid": "1855355231229529"}
  ],
  "count": 2
}

// POST /api/surveys/:surveyId/bails/:id/trigger
{
  "execution_id": "770e8400-e29b-41d4-a716-446655440003",
  "users_matched": 5,
  "users_bailed": 5
}
```

---

## Implementation Phases

### Phase 1: Core Service (Week 1-2)

1. **Database schema** - Create `bails` and `bail_events` tables with migrations
2. **Query builder** - Implement DSL-to-SQL translation for all condition types
3. **Execution checker** - Implement timing logic (immediate, scheduled, absolute)
4. **Bail sender** - HTTP POST to botserver with rate limiting
5. **Event logging** - Record each execution as a bail event with definition snapshot
6. **Main loop** - Load bails, check execution, run queries, send bails, log event
7. **Kubernetes manifests** - CronJob deployment for executor mode

**Deliverable**: Working bailer service that reads from `bails` table and logs events

### Phase 2: API (Week 2-3)

1. **REST API** - CRUD endpoints for bail management (survey-scoped)
2. **Event history API** - Endpoints to view bail event history
3. **Preview endpoint** - Dry-run capability
4. **Validation** - Schema validation for bail definitions
5. **Logging & metrics** - Prometheus metrics, structured logging
6. **Kubernetes manifests** - Deployment for API server mode

**Deliverable**: API-manageable bails, event history visible

### Phase 3: Dashboard UI (Week 3-4)

1. **Bail list view** - Table of all bails with status and last event info
2. **Bail editor** - Form-based creation/editing of bail definitions
3. **Event history view** - Show past events with user counts
4. **Preview UI** - Show affected users before enabling
5. **Manual trigger** - Button to trigger bail immediately
6. **Form selector** - Dropdown populated from available forms

**Deliverable**: Full UI for managing bails and viewing event history

### Phase 4: Documentation & Testing (Week 4)

1. **Documentation** - User guide, API docs
2. **Runbook** - Operational procedures
3. **Testing** - Integration tests, load testing

**Deliverable**: Production-ready system

---

## File Structure

```
bailer/
├── main.go                 # Entry point (--mode=api or --mode=executor)
├── config/
│   └── config.go           # Environment configuration
├── db/
│   ├── db.go               # Database connection
│   ├── bails.go            # Bail CRUD operations
│   ├── events.go           # Bail event log operations
│   └── migrations/
│       ├── 001_create_bails.sql
│       └── 002_create_bail_events.sql
├── executor/
│   ├── executor.go         # Main execution loop
│   ├── timing.go           # Execution timing logic
│   └── timing_test.go
├── query/
│   ├── builder.go          # DSL to SQL translation
│   ├── builder_test.go
│   └── templates.go        # SQL query templates
├── sender/
│   ├── sender.go           # HTTP POST to botserver
│   └── sender_test.go
├── api/
│   ├── server.go           # HTTP server setup
│   ├── handlers.go         # REST handlers for bails
│   ├── events.go           # REST handlers for bail events
│   └── validation.go       # Definition validation
├── chart/
│   ├── Chart.yaml
│   ├── values.yaml
│   └── templates/
│       ├── cronjob.yaml    # Executor mode
│       ├── deployment.yaml # API server mode
│       └── service.yaml
├── Dockerfile
├── go.mod
└── go.sum
```

---

## Security Considerations

1. **No raw SQL** - All queries built from DSL, preventing injection
2. **Parameterized queries** - All user-provided values are parameters
3. **Form validation** - Validate form shortcodes exist before saving
4. **API authentication** - Integrate with existing dashboard auth
5. **Rate limiting** - Bail sender limits requests to botserver (1/sec)
6. **Audit logging** - Log who created/modified bails

---

## Monitoring & Observability

### Metrics (Prometheus)

```
# Counter: bails executed
bailer_executions_total{bail_name, status}

# Counter: users bailed
bailer_users_bailed_total{bail_name, destination_form}

# Histogram: query execution time
bailer_query_duration_seconds{bail_name}

# Gauge: enabled bails count
bailer_enabled_bails

# Counter: errors
bailer_errors_total{bail_name, error_type}
```

### Logging

```json
{
  "level": "info",
  "ts": "2025-01-15T10:00:00Z",
  "msg": "bail executed",
  "bail_id": "550e8400-e29b-41d4-a716-446655440000",
  "bail_name": "BEBBO BG 4-week",
  "users_found": 15,
  "users_bailed": 15,
  "duration_ms": 234
}
```

---

## Design Decisions

1. **Validation**: No validation of bail definitions for v1. Form existence, question_ref existence, and duration parsing are not checked at save time. Invalid bails will fail at execution time and be logged.

2. **Rate limiting**: Configurable via `BAILER_RATE_LIMIT` environment variable (requests per second to botserver). This is a system-wide setting since it depends on botserver capacity.

3. **Dashboard integration**: Bailer is a standalone Go service with full REST API. Dashboard-server proxies to it (same pattern as formcentral). No direct dashboard-server changes needed beyond proxy routes.

4. **Migration**: No auto-migration of existing bailer-job manifests. New bails will be created via UI as needed. Old bailer-job CronJobs continue running independently - no transition period required.

## Error Handling Strategy

**Three levels of errors:**

### 1. System Errors (crash and retry)
Errors that affect all bails - the whole job should fail and Kubernetes will retry:
- Database connection failure
- Botserver unreachable (HTTP connection refused)
- Invalid configuration

**Behavior**: Panic/exit with non-zero code. CronJob `restartPolicy: OnFailure` handles retry.

### 2. Bail-Level Errors (log and continue)
Errors specific to one bail - skip this bail, continue with others:
- Invalid condition in definition (bad JSON structure)
- SQL query error (e.g., referencing non-existent column)
- No users matched (not really an error, but worth logging)

**Behavior**: Log error with bail ID/name, record in `bail_events` with `event_type: "error"` and error details, continue to next bail.

### 3. User-Level Errors (log and continue)
Errors when bailing a specific user - rare, but possible:
- Botserver returns 4xx/5xx for specific user
- User no longer exists

**Behavior**: Log warning, increment error counter in bail_events record, continue with remaining users. Record `users_matched` vs `users_bailed` discrepancy.

**bail_events for errors:**
```sql
INSERT INTO bail_events (bail_id, survey_id, bail_name, event_type, users_matched, users_bailed, definition_snapshot, error)
VALUES ($1, $2, $3, 'error', 0, 0, $4, $5);
```

## Open Questions

1. **Restrict edits after execution?**: Should we prevent/warn when editing a bail that has already executed?
   - Option A: Hard block - cannot edit after first execution
   - Option B: Soft warning - show warning but allow edit
   - Option C: No restriction - edits always allowed, history preserved in event snapshots
   - Recommendation: Option B - warn but allow, since the snapshot preserves what actually ran

2. **Execution deduplication**: ✓ Resolved - The `shouldExecute()` function queries `lastExecution` from `bail_events` before running:
   - **Scheduled bails**: Won't re-execute if last execution was within 24 hours
   - **Absolute bails**: Won't re-execute if any previous successful execution exists
   - **Immediate bails**: Execute every tick (idempotent - machine handles duplicate bailouts)

3. **Notification on Bail**: Should we notify (Slack/email) when bails execute?
   - Recommendation: Add optional webhook notification in v2

4. **Bulk Preview Limit**: For preview, should we limit results?
   - Recommendation: Yes, `LIMIT 100` with total count

5. **Survey deletion**: What happens to bails when a survey is deleted?
   - Option A: Cascade delete bails
   - Option B: Soft delete / disable bails
   - Recommendation: Option A with foreign key CASCADE, execution history preserved (bail_id becomes NULL)

---

## Success Criteria

1. New bails can be created entirely through UI without developer intervention
2. Preview shows accurate user counts before enabling
3. Execution times are respected (scheduled bails fire at correct time/timezone)
4. Zero SQL injection vulnerabilities
5. < 5 minute latency from condition becoming true to bail execution (for immediate)
6. Metrics and logging sufficient for debugging production issues
