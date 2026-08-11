# Bail System Architecture & SQL Generation Deep Dive

**Purpose:** Technical reference for understanding how bail conditions are stored, validated, and converted to SQL queries.

---

## Table of Contents

1. [Condition Type System](#condition-type-system)
2. [Type Definitions](#type-definitions)
3. [SQL Query Building Process](#sql-query-building-process)
4. [CTE-Based Conditions](#cte-based-conditions)
5. [Parameter Management](#parameter-management)
6. [Data Flow](#data-flow)

---

## Condition Type System

Bail conditions form a **recursive tree structure** supporting:
- **Simple conditions:** Single predicates (form, state, error_code, current_question, elapsed_time, question_response, surveyid)
- **Logical operators:** AND, OR, NOT combining child conditions

### Simple Condition Types

#### 1. Form Condition
- **Matches on:** `states.current_form`
- **SQL:** `s.current_form = $param`
- **Example:** `{"type": "form", "value": "myform"}`
- **CTE-based:** No

#### 2. State Condition
- **Matches on:** `states.current_state`
- **SQL:** `s.current_state = $param`
- **Example:** `{"type": "state", "value": "WAIT_EXTERNAL_EVENT"}`
- **CTE-based:** No

#### 3. Error Code Condition
- **Matches on:** `states.state_json->'error'->>'code'`
- **SQL:** `s.state_json->'error'->>'code' = $param`
- **Example:** `{"type": "error_code", "value": "10"}`
- **CTE-based:** No

#### 4. Current Question Condition
- **Matches on:** `states.state_json->>'question'`
- **SQL:** `s.state_json->>'question' = $param`
- **Example:** `{"type": "current_question", "value": "consent"}`
- **CTE-based:** No

#### 5. Elapsed Time Condition ⚠️ CTE-Based
- **Matches on:** Time since a response to a specific question
- **CTE:** Creates `response_times_N` CTE with MIN(timestamp) per userid
- **JOIN:** INNER JOIN to get only users who have that response
- **SQL WHERE:** `rt_N.response_time + $duration::INTERVAL < NOW()`
- **Example:**
  ```json
  {
    "type": "elapsed_time",
    "duration": "4 weeks",
    "since": {
      "event": "response",
      "details": {
        "question_ref": "q1",
        "form": "myform"
      }
    }
  }
  ```
- **Parameters:** `[form, question_ref, duration]`
- **Limitation:** Cannot be wrapped in NOT operator (INNER JOIN semantics make negation incorrect)

#### 6. Question Response Condition ⚠️ CTE-Based
- **Matches on:** Users who answered a specific question (optionally with a specific response)
- **CTE:** Creates `question_responses_N` CTE selecting userids from responses table
- **JOIN:** INNER JOIN to get only users who have that response
- **SQL WHERE:** `qr_N.userid IS NOT NULL`
- **Two modes:**
  - **With response:** Filters CTE by `shortcode AND question_ref AND response`
  - **Without response:** Filters CTE by `shortcode AND question_ref` only (any answer)
- **Example (with response):**
  ```json
  {
    "type": "question_response",
    "form": "intake",
    "question_ref": "consent_q",
    "response": "Yes"
  }
  ```
- **Parameters:** `[form, question_ref, response]` or `[form, question_ref]`
- **Limitation:** Cannot be wrapped in NOT operator (INNER JOIN semantics make negation incorrect)

#### 7. Survey ID Condition
- **Matches on:** Users on any form belonging to a survey UUID
- **SQL Subquery:** `s.current_form IN (SELECT shortcode FROM surveys WHERE id = $param)`
- **Example:** `{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}`
- **CTE-based:** No (uses inline subquery)
- **Safe to negate:** Yes (subquery operates on single row, doesn't require JOIN)

### Logical Operators

#### AND Operator
- **Behavior:** All child conditions must be true
- **SQL:** Joins conditions with ` AND `
- **CTE handling:** All CTE JOINs execute, filtering progressively
- **Example:**
  ```json
  {
    "op": "and",
    "vars": [
      {"type": "form", "value": "myform"},
      {"type": "state", "value": "BLOCKED"}
    ]
  }
  ```
- **Generated SQL:** `(s.current_form = $1 AND s.current_state = $2)`

#### OR Operator
- **Behavior:** Any child condition can be true
- **SQL:** Joins conditions with ` OR `
- **CTE handling:** ⚠️ **BUG** — All CTE JOINs still execute as INNER JOINs, creating AND semantics
- **Example:**
  ```json
  {
    "op": "or",
    "vars": [
      {"type": "form", "value": "form1"},
      {"type": "form", "value": "form2"}
    ]
  }
  ```
- **Generated SQL:** `(s.current_form = $1 OR s.current_form = $2)` ✓ Works correctly for simple conditions
- **Broken case:** With CTE-based conditions, see bug findings document

#### NOT Operator
- **Behavior:** Negates a single child condition
- **SQL:** Wraps in ` NOT (...)`
- **Limitations:**
  - Must have exactly 1 child
  - Cannot wrap elapsed_time or question_response (INNER JOIN can't express negation)
  - Can wrap surveyid, form, state, error_code, current_question
- **Example:**
  ```json
  {"op": "not", "vars": [{"type": "state", "value": "END"}]}
  ```
- **Generated SQL:** `NOT (s.current_state = $1)`

---

## Type Definitions

### Condition Structure

```go
// Condition is a union type that can be either simple or operator
type Condition struct {
    simple   *SimpleCondition    // Mutually exclusive with operator
    operator *LogicalOperator    // Mutually exclusive with simple
}
```

Uses **custom JSON marshaling** (`UnmarshalJSON`/`MarshalJSON` in types.go:177-216) to distinguish:
- If JSON has `"op"` field → LogicalOperator
- Otherwise → SimpleCondition

### SimpleCondition Structure

```go
type SimpleCondition struct {
    Type         string         // "form", "state", "error_code", "current_question", "elapsed_time", "question_response", "surveyid"
    Value        *string        // Used by: form, state, error_code, current_question, surveyid
    Since        *TimeReference // Used by: elapsed_time
    Duration     *string        // Used by: elapsed_time
    ErrorCode    *string        // Deprecated? (overlaps with Value)
    QuestionRef  *string        // Used by: question_response, elapsed_time
    CurrentState *string        // Deprecated? (overlaps with Value)
    Form         *string        // Used by: question_response
    Response     *string        // Used by: question_response (optional)
}
```

### LogicalOperator Structure

```go
type LogicalOperator struct {
    Op   string      // "and", "or", or "not"
    Vars []Condition // Child conditions (1+ for and/or, exactly 1 for not)
}
```

### BailDefinition Structure

```go
type BailDefinition struct {
    Type       string     // "conditions" (default) or "user_list"
    Conditions *Condition // Root condition (when Type="conditions")
    UserList   *UserList  // User list (when Type="user_list")
    Execution  Execution  // Timing configuration
    Action     Action     // Destination form and metadata
}
```

---

## SQL Query Building Process

### Entry Point: BuildQuery()

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go:35-73`

```
BuildQuery(def *BailDefinition) → (sql string, params []interface{}, error)
```

1. Creates new `QueryBuilder` instance
2. Calls `buildCondition(def.Conditions)` to build WHERE clause
3. Assembles final SQL:
   - WITH clause (if CTEs exist)
   - SELECT DISTINCT s.userid, s.pageid
   - FROM states s
   - JOIN clauses (if CTEs exist)
   - WHERE clause
   - LIMIT 100000

### QueryBuilder State

```go
type QueryBuilder struct {
    params       []interface{}  // Parameters for parameterized query
    paramIndex   int            // Current parameter counter (starts at 1)
    ctes         []string       // CTE definitions (WITH clause content)
    cteJoins     []string       // JOIN clauses (for CTEs)
    cteIndex     int            // Counter for unique CTE names
    queryLimit   int            // Safety limit (100,000)
}
```

**Key insight:** `cteJoins` is a **global list** that accumulates all JOIN statements, regardless of logical operator context.

### Recursive Condition Building

**Process:**

1. `buildCondition()` dispatches on condition type:
   - If simple: call `buildSimpleCondition()`
   - If operator: call `buildLogicalOperator()`

2. `buildSimpleCondition()` matches condition type and delegates:
   - "form" → `buildFormCondition()`
   - "state" → `buildStateCondition()`
   - "error_code" → `buildErrorCodeCondition()`
   - "current_question" → `buildCurrentQuestionCondition()`
   - "elapsed_time" → `buildElapsedTimeCondition()` ⚠️
   - "question_response" → `buildQuestionResponseCondition()` ⚠️
   - "surveyid" → `buildSurveyIDCondition()`

3. Each builder function:
   - Returns a WHERE clause fragment (e.g., `"s.current_form = $1"`)
   - May append CTEs to `qb.ctes` and JOINs to `qb.cteJoins` (side effects)

4. `buildLogicalOperator()` combines child conditions:
   - Recursively builds each child
   - Joins results with appropriate operator (AND/OR/NOT)
   - Returns combined WHERE clause

### Side Effects During Building

**Non-CTE conditions (form, state, etc.):**
- Return a WHERE clause fragment
- No side effects on `ctes` or `cteJoins`

**CTE-based conditions (elapsed_time, question_response):**
- Create a CTE definition and append to `qb.ctes`
- Create a JOIN clause and append to `qb.cteJoins`
- Return a WHERE clause fragment using the CTE alias

**Problem:** These side effects happen **unconditionally** during building, before the builder knows what logical operator will combine the conditions.

### Example: Building OR with Two question_response Conditions

**Input condition:**
```json
{
  "op": "or",
  "vars": [
    {"type": "question_response", "form": "myform", "question_ref": "q1", "response": "yes"},
    {"type": "question_response", "form": "myform", "question_ref": "q2", "response": "no"}
  ]
}
```

**Step-by-step execution:**

1. `buildCondition()` sees it's an operator, calls `buildLogicalOperator(op)`

2. Loop processes first child (q1):
   - Calls `buildCondition()` on first question_response
   - Calls `buildQuestionResponseCondition()` for q1
   - **Side effect:** Appends to `qb.ctes`: `"question_responses_0 AS (SELECT DISTINCT userid FROM responses WHERE shortcode = $1 AND question_ref = $2 AND response = $3)"`
   - **Side effect:** Appends to `qb.cteJoins`: `"JOIN question_responses_0 qr0 ON s.userid = qr0.userid"`
   - Returns: `"qr0.userid IS NOT NULL"`

3. Loop processes second child (q2):
   - Calls `buildCondition()` on second question_response
   - Calls `buildQuestionResponseCondition()` for q2
   - **Side effect:** Appends to `qb.ctes`: `"question_responses_1 AS (SELECT DISTINCT userid FROM responses WHERE shortcode = $4 AND question_ref = $5 AND response = $6)"`
   - **Side effect:** Appends to `qb.cteJoins`: `"JOIN question_responses_1 qr1 ON s.userid = qr1.userid"`
   - Returns: `"qr1.userid IS NOT NULL"`

4. `buildLogicalOperator()` joins results:
   - `conditions = ["qr0.userid IS NOT NULL", "qr1.userid IS NOT NULL"]`
   - `sqlOp = " OR "`
   - Returns: `"(qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)"`

5. Back in `BuildQuery()`:
   - `ctes = ["question_responses_0 AS ...", "question_responses_1 AS ..."]`
   - `cteJoins = ["JOIN question_responses_0 qr0 ...", "JOIN question_responses_1 qr1 ..."]`
   - Both JOINs are unconditionally added to final SQL
   - Result: **Two INNER JOINs** (AND semantics) instead of conditional logic for OR

---

## CTE-Based Conditions

### Why CTEs Are Needed

CTEs (Common Table Expressions) are necessary for conditions that:
1. Query a **different table** than the main query (responses table instead of states)
2. Need to **aggregate or transform** data (e.g., MIN(timestamp) for elapsed_time)
3. Cannot be expressed as simple column predicates

**Example:** "Users who answered question Q1 in the last 4 weeks"
- Requires joining to responses table
- Requires calculating time difference from now
- Requires grouping by userid to get the first response

### How CTEs Are Generated

#### Elapsed Time CTE

```go
cteName := fmt.Sprintf("response_times_%d", qb.cteIndex)
qb.cteIndex++

formParam := qb.addParam(cond.Since.Details.Form)
questionParam := qb.addParam(cond.Since.Details.QuestionRef)
durationParam := qb.addParam(*cond.Duration)

cte := fmt.Sprintf(`%s AS (
    SELECT userid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
    GROUP BY userid
)`, cteName, formParam, questionParam)

qb.ctes = append(qb.ctes, cte)
joinClause := fmt.Sprintf("JOIN %s rt%d ON s.userid = rt%d.userid",
    cteName, qb.cteIndex-1, qb.cteIndex-1)
qb.cteJoins = append(qb.cteJoins, joinClause)

return fmt.Sprintf("rt%d.response_time + $%d::INTERVAL < NOW()",
    qb.cteIndex-1, durationParam), nil
```

**Key points:**
- CTE indexed with `qb.cteIndex` (auto-incrementing)
- CTE name: `response_times_0`, `response_times_1`, etc.
- Join alias: `rt0`, `rt1`, etc.
- Both CTE and JOIN appended unconditionally
- WHERE clause uses alias: `rt0.response_time + $3::INTERVAL < NOW()`

#### Question Response CTE

```go
cteName := fmt.Sprintf("question_responses_%d", qb.cteIndex)
alias := fmt.Sprintf("qr%d", qb.cteIndex)
qb.cteIndex++

formParam := qb.addParam(*cond.Form)
questionParam := qb.addParam(*cond.QuestionRef)

var cte string
if cond.Response != nil {
    responseParam := qb.addParam(*cond.Response)
    cte = fmt.Sprintf(`%s AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d AND response = $%d
)`, cteName, formParam, questionParam, responseParam)
} else {
    cte = fmt.Sprintf(`%s AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
)`, cteName, formParam, questionParam)
}

qb.ctes = append(qb.ctes, cte)
qb.cteJoins.append(fmt.Sprintf("JOIN %s %s ON s.userid = %s.userid", cteName, alias, alias))

return fmt.Sprintf("%s.userid IS NOT NULL", alias), nil
```

**Key points:**
- Similar structure to elapsed_time
- CTE name: `question_responses_0`, `question_responses_1`, etc.
- Join alias: `qr0`, `qr1`, etc.
- Handles two modes: with/without response value
- WHERE condition checks if userid is not NULL (redundant after INNER JOIN)

---

## Parameter Management

### Parameter Indexing

PostgreSQL parameterized queries use `$1`, `$2`, etc. for placeholders.

**Management:**
- `QueryBuilder.paramIndex` starts at 1
- `addParam(value)` appends to `params` and returns the current index
- Index is incremented after each addition

**Example:** Building form condition + state condition
```
First call:  addParam("myform") → params = ["myform"], returns 1 → WHERE ... $1
Second call: addParam("BLOCKED") → params = ["myform", "BLOCKED"], returns 2 → WHERE ... $2
```

### Parameters in CTEs vs WHERE

**CTE parameters** (created during CTE building):
- Added during `buildQuestionResponseCondition()` or `buildElapsedTimeCondition()`
- Used in CTE WHERE clause
- Example: `WHERE shortcode = $1 AND question_ref = $2 AND response = $3` (for question_response)

**Main query parameters** (created during WHERE clause building):
- Added during `buildSimpleCondition()` for simple conditions
- Added during CTE building for CTE-using conditions
- Used in main query WHERE clause

**Parameter numbering is sequential** across the entire query, not scoped to CTEs.

### Example: Parameter Numbering with CTEs

Condition: `(form = "myform") AND (question_response on q1 with "yes")`

```go
// First condition (form):
// buildFormCondition("myform") → addParam("myform") → $1
// Returns: "s.current_form = $1"

// Second condition (question_response):
// buildQuestionResponseCondition() {
//   addParam("myform") → $2 (CTE parameter)
//   addParam("q1") → $3 (CTE parameter)
//   addParam("yes") → $4 (CTE parameter)
//   CTE WHERE: shortcode = $2 AND question_ref = $3 AND response = $4
//   Returns: "qr0.userid IS NOT NULL"
// }

// Combined with AND:
// "($1 AND qr0.userid IS NOT NULL)"

// Final params: ["myform" (WHERE), "myform" (CTE), "q1" (CTE), "yes" (CTE)]
// Final WHERE clause: WHERE (s.current_form = $1 AND qr0.userid IS NOT NULL)
```

---

## Data Flow

### Full Execution Path

1. **User creates bail via dashboard-client**
   - Builds condition tree visually
   - Specifies execution timing and destination form
   - Sends JSON to dashboard-server

2. **Dashboard-server validates and proxies to Exodus API**
   - Authenticates user
   - Proxies to `POST /users/:userId/bails`

3. **Exodus API (api/handlers.go) receives request**
   - Parses JSON to `types.BailDefinition`
   - Calls `definition.Validate()` using types package
   - Stores to database as JSON blob

4. **User clicks "Preview"**
   - Exodus API calls `query.BuildQuery(definition)` to generate SQL
   - Executes query against test database
   - Returns result count + sample userids + generated SQL + parameters

5. **Executor runs (Kubernetes CronJob)**
   - Loads enabled bails from database
   - For each bail, checks timing (immediate/scheduled/absolute)
   - Calls `query.BuildQuery(definition)` again
   - Executes generated SQL
   - Sends bailouts via `sender.Send()` to botserver
   - Records execution event to database

### JSON Storage vs In-Memory Types

**In database:** Stored as `definition` JSON BLOB in `bails` table
```sql
CREATE TABLE bails (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    definition JSONB NOT NULL,  -- Raw BailDefinition JSON
    ...
)
```

**In memory:** Deserialized to `types.BailDefinition` struct with full validation

**Conversion path:**
```
JSON (database)
  ↓ json.Unmarshal()
→ types.BailDefinition (with custom Condition unmarshaling)
  ↓ query.BuildQuery()
→ SQL string + parameters slice
```

---

## Summary: How Question_Response Conditions Work

### Expected Behavior (Single Condition)

```json
{"type": "question_response", "form": "myform", "question_ref": "q1", "response": "yes"}
```

**Generated SQL:**
```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2 AND response = $3
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid
WHERE qr0.userid IS NOT NULL
```

**Result:** Users who answered q1 with "yes" ✓

### Broken Behavior (OR with Multiple Conditions)

```json
{
  "op": "or",
  "vars": [
    {"type": "question_response", "form": "myform", "question_ref": "q1", "response": "yes"},
    {"type": "question_response", "form": "myform", "question_ref": "q2", "response": "no"}
  ]
}
```

**Generated SQL:**
```sql
WITH question_responses_0 AS (...),
     question_responses_1 AS (...)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid
JOIN question_responses_1 qr1 ON s.userid = qr1.userid
WHERE (qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)
```

**Problem:** Both JOINs execute, filtering to users who answered BOTH q1 AND q2 ✗
**Expected:** Users who answered q1 with "yes" OR q2 with "no"

---

## References

- `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go` — SQL generation logic
- `/home/nandu/Documents/vlab-research/fly/exodus/types/types.go` — Type definitions
- `/home/nandan/Documents/vlab-research/fly/exodus/query/builder_test.go` — Unit tests
- `/home/nandan/Documents/vlab-research/fly/documentation/bail-systems.md` — User-facing documentation
