# question_response Condition — Investigation Findings

**Date**: 2026-02-22
**Working directory**: `/home/nandan/Documents/vlab-research/fly/exodus`

---

## Summary

This document captures everything needed to implement the `question_response` condition type in exodus. The changes required are surgical and well-contained: two files must be changed (`types/types.go` and `query/builder.go`), and tests and examples should be added alongside.

---

## 1. Responses Table Schema

From `devops/migrations/01-init.sql` (lines 68–102):

```sql
CREATE TABLE IF NOT EXISTS chatroach.responses (
    parent_surveyid UUID REFERENCES chatroach.surveys(id),
    parent_shortcode VARCHAR NOT NULL,
    surveyid UUID NOT NULL REFERENCES chatroach.surveys(id),
    shortcode VARCHAR NOT NULL,          -- form shortcode (matches surveys.shortcode)
    flowid INT NOT NULL,
    userid VARCHAR NOT NULL,             -- user identifier (matches states.userid)
    question_ref VARCHAR NOT NULL,       -- question identifier
    question_idx INT NOT NULL,
    question_text VARCHAR NOT NULL,
    response VARCHAR NOT NULL,           -- the user's response value
    seed INT NOT NULL,
    pageid VARCHAR,
    clusterid VARCHAR AS (metadata->>'clusterid') STORED,
    timestamp TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (userid, timestamp, question_ref),
    metadata JSONB,
    translated_response VARCHAR,
    INVERTED INDEX (metadata),
    INDEX (shortcode, question_ref, response, clusterid, timestamp),
    ...
);
```

**Key columns for `question_response`:**

| Column | Type | Purpose |
|--------|------|---------|
| `userid` | VARCHAR | Joins to `states.userid` |
| `shortcode` | VARCHAR | Identifies the form (matches `surveys.shortcode`) |
| `question_ref` | VARCHAR | Identifies the question |
| `response` | VARCHAR | The user's actual response text |
| `timestamp` | TIMESTAMPTZ | When the response was recorded |

The column for matching a user's answer is `response` (not `response_value`).

**Important**: There is an index on `(shortcode, question_ref, response, ...)` which means a query filtering on all three columns will be index-efficient.

---

## 2. How elapsed_time Generates SQL (reference implementation)

From `query/builder.go` lines 147–196:

```go
func (qb *QueryBuilder) buildElapsedTimeCondition(cond *types.SimpleCondition) (string, error) {
    // ... validation ...

    // Create a unique CTE name for this elapsed_time condition
    cteName := fmt.Sprintf("response_times_%d", qb.cteIndex)
    qb.cteIndex++

    // Add parameters for the CTE
    formParam := qb.addParam(cond.Since.Details.Form)
    questionParam := qb.addParam(cond.Since.Details.QuestionRef)
    durationParam := qb.addParam(*cond.Duration)

    // Build the CTE for response times
    cte := fmt.Sprintf(`%s AS (
    SELECT userid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
    GROUP BY userid
)`, cteName, formParam, questionParam)

    qb.ctes = append(qb.ctes, cte)

    // Add JOIN clause for this CTE
    joinClause := fmt.Sprintf("JOIN %s rt%d ON s.userid = rt%d.userid",
        cteName, qb.cteIndex-1, qb.cteIndex-1)
    qb.cteJoins = append(qb.cteJoins, joinClause)

    // Return the WHERE condition using this CTE
    return fmt.Sprintf("rt%d.response_time + $%d::INTERVAL < NOW()",
        qb.cteIndex-1, durationParam), nil
}
```

The pattern:
1. Allocate a unique CTE index (`qb.cteIndex`), then immediately increment it
2. Add params to `qb.params` via `qb.addParam()` — each call returns the `$N` index
3. Build a CTE string and append to `qb.ctes`
4. Build a JOIN string and append to `qb.cteJoins`
5. Return the WHERE fragment that references the CTE alias

The final SQL structure (from `BuildQuery`, lines 44–73):
```sql
WITH <cte1>, <cte2>...
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN <cte1_alias> ON s.userid = ...
WHERE <where_clause>
LIMIT 100000
```

---

## 3. Current SimpleCondition Struct

From `types/types.go` lines 86–94:

```go
type SimpleCondition struct {
    Type         string         `json:"type"`
    Value        *string        `json:"value,omitempty"`
    Since        *TimeReference `json:"since,omitempty"`
    Duration     *string        `json:"duration,omitempty"`
    ErrorCode    *string        `json:"error_code,omitempty"`
    QuestionRef  *string        `json:"question_ref,omitempty"`
    CurrentState *string        `json:"current_state,omitempty"`
}
```

`QuestionRef` already exists on `SimpleCondition` (used by `TimeEventDetails` for elapsed_time's `since.details.question_ref`, not directly on `SimpleCondition`). The field `QuestionRef *string` on `SimpleCondition` itself is currently unused by any condition type — it was likely pre-added in anticipation of this feature.

The new `question_response` condition needs:
- `form` (string, required) — already served by... nothing directly on `SimpleCondition`. `Value` is used for the value-type conditions; `form` needs its own field, or `Value` could be repurposed. **However**, there is no `Form` field on `SimpleCondition`. This needs to be added.
- `question_ref` (string, required) — `QuestionRef *string` already exists
- `response` (string, optional) — no field exists yet; needs to be added

**Fields to add to `SimpleCondition`:**

```go
Form     *string `json:"form,omitempty"`
Response *string `json:"response,omitempty"`
```

`QuestionRef *string` is already present and can be used directly.

---

## 4. Changes Required in types/types.go

### 4a. Add new fields to SimpleCondition

```go
type SimpleCondition struct {
    Type         string         `json:"type"`
    Value        *string        `json:"value,omitempty"`
    Since        *TimeReference `json:"since,omitempty"`
    Duration     *string        `json:"duration,omitempty"`
    ErrorCode    *string        `json:"error_code,omitempty"`
    QuestionRef  *string        `json:"question_ref,omitempty"`
    CurrentState *string        `json:"current_state,omitempty"`
    Form         *string        `json:"form,omitempty"`         // NEW: for question_response
    Response     *string        `json:"response,omitempty"`     // NEW: for question_response
}
```

### 4b. Add validation case in SimpleCondition.Validate()

Location: `types/types.go` lines 167–199. The `switch sc.Type` must gain a new case:

```go
case "question_response":
    if sc.Form == nil {
        return fmt.Errorf("form is required for question_response condition")
    }
    if sc.QuestionRef == nil {
        return fmt.Errorf("question_ref is required for question_response condition")
    }
    // response is optional — no validation needed
```

### 4c. Update error message in default case

The existing default case says:
```go
return fmt.Errorf("invalid condition type: %s", sc.Type)
```

The documentation (bail-systems.md line 697) says the error message lists the valid types. That string is not in the Go code (the error message is just the type name), so no change needed there — just adding the case is sufficient.

### 4d. Consider NOT operator restriction

The current `containsElapsedTime` function (lines 229–242) is what prevents NOT from wrapping `elapsed_time`. The `question_response` condition uses a CTE with a JOIN (not a LEFT JOIN), which means NOT wrapping it would also be incorrect — a INNER JOIN would silently exclude all users who have no response for that question.

**Recommendation**: Add a similar restriction for `question_response` inside NOT. Create a parallel `containsJoinCondition` function (or extend `containsElapsedTime` to cover both types), and apply it in `LogicalOperator.Validate()`.

Alternatively, name it `containsCTECondition` since both `elapsed_time` and `question_response` use JOINs that would misbehave under NOT.

---

## 5. Changes Required in query/builder.go

### 5a. Add case in buildSimpleCondition()

In the `switch cond.Type` at lines 90–104:

```go
case "question_response":
    return qb.buildQuestionResponseCondition(cond)
```

### 5b. Add buildQuestionResponseCondition() method

Two SQL patterns depending on whether `response` is provided:

**When `response` is present** (match exact response value):
```sql
WITH question_responses_N AS (
    SELECT userid
    FROM responses
    WHERE shortcode = $M AND question_ref = $K AND response = $J
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_N qrN ON s.userid = qrN.userid
WHERE ...
```
WHERE fragment: `qrN.userid IS NOT NULL` — or more correctly, the JOIN itself acts as the filter, so the WHERE fragment can be just `TRUE` and rely on the JOIN, or can be omitted by returning a tautology.

Actually, looking at how `elapsed_time` works: the CTE JOIN is INNER JOIN, which filters to only users who appear in the CTE. The WHERE clause still needs to return something. For `elapsed_time`, the WHERE fragment is `rt0.response_time + $N::INTERVAL < NOW()`. For `question_response`, if the CTE already filters to matching users (by response value), the JOIN is the filter — the WHERE fragment just needs to be non-empty but could be `TRUE` or reuse a column.

**Better pattern**: Include the WHERE condition in the WHERE clause too, keeping the CTE simple (just a list of userid):

```sql
WITH question_responses_N AS (
    SELECT userid
    FROM responses
    WHERE shortcode = $M AND question_ref = $K AND response = $J
)
JOIN question_responses_N qrN ON s.userid = qrN.userid
-- WHERE fragment: just use the join result, emit a tautology
```

Looking at `elapsed_time` again more carefully: the CTE selects `userid` and `response_time`. The JOIN matches, and the WHERE uses `response_time` to further filter. For `question_response`, if we only need "did they answer", the CTE just needs `userid`. The WHERE fragment can be any column reference on the CTE to avoid emitting nothing — or just return an always-true condition since the JOIN does the work.

**Proposed implementation:**

```go
func (qb *QueryBuilder) buildQuestionResponseCondition(cond *types.SimpleCondition) (string, error) {
    if cond.Form == nil {
        return "", fmt.Errorf("form is required for question_response condition")
    }
    if cond.QuestionRef == nil {
        return "", fmt.Errorf("question_ref is required for question_response condition")
    }

    cteName := fmt.Sprintf("question_responses_%d", qb.cteIndex)
    qb.cteIndex++

    formParam := qb.addParam(*cond.Form)
    questionParam := qb.addParam(*cond.QuestionRef)

    var cte string
    if cond.Response != nil {
        // Match users who answered with a specific response value
        responseParam := qb.addParam(*cond.Response)
        cte = fmt.Sprintf(`%s AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d AND response = $%d
)`, cteName, formParam, questionParam, responseParam)
    } else {
        // Match users who answered the question at all (any response)
        cte = fmt.Sprintf(`%s AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
)`, cteName, formParam, questionParam)
    }

    qb.ctes = append(qb.ctes, cte)

    aliasIdx := qb.cteIndex - 1
    joinClause := fmt.Sprintf("JOIN %s qr%d ON s.userid = qr%d.userid",
        cteName, aliasIdx, aliasIdx)
    qb.cteJoins = append(qb.cteJoins, joinClause)

    // The JOIN is the filter; return a tautology as the WHERE fragment
    // (consistent with the structure: the CTE join does the filtering work)
    return fmt.Sprintf("qr%d.userid IS NOT NULL", aliasIdx), nil
}
```

**Note on WHERE fragment**: Returning `qr0.userid IS NOT NULL` is always true given the INNER JOIN, but it provides a valid syntactically-correct WHERE fragment. The alternative is to return `TRUE` or restructure to allow empty WHERE fragments (which would require changes to `BuildQuery`). The `IS NOT NULL` approach is cleanest with the existing structure.

---

## 6. NOT Operator Constraint for question_response

The existing restriction for `elapsed_time` inside NOT is at `types/types.go` lines 220–225:

```go
if lo.Op == "not" {
    if containsElapsedTime(&lo.Vars[0]) {
        return fmt.Errorf("not operator cannot negate elapsed_time conditions (not yet supported)")
    }
}
```

And the recursive helper at lines 229–242:

```go
func containsElapsedTime(c *Condition) bool {
    if c.IsSimple() {
        return c.GetSimple().Type == "elapsed_time"
    }
    if c.IsOperator() {
        for i := range c.GetOperator().Vars {
            if containsElapsedTime(&c.GetOperator().Vars[i]) {
                return true
            }
        }
    }
    return false
}
```

**Recommended approach**: Rename `containsElapsedTime` to `containsCTECondition` (or add `question_response` to its check) and update the error message:

```go
func containsCTECondition(c *Condition) bool {
    if c.IsSimple() {
        t := c.GetSimple().Type
        return t == "elapsed_time" || t == "question_response"
    }
    if c.IsOperator() {
        for i := range c.GetOperator().Vars {
            if containsCTECondition(&c.GetOperator().Vars[i]) {
                return true
            }
        }
    }
    return false
}
```

And in `LogicalOperator.Validate()`:

```go
if lo.Op == "not" {
    if containsCTECondition(&lo.Vars[0]) {
        return fmt.Errorf("not operator cannot negate elapsed_time or question_response conditions (not yet supported)")
    }
}
```

**Why the restriction applies**: The `question_response` CTE uses INNER JOIN. If wrapped in NOT, you would want users who did NOT answer the question — but the INNER JOIN excludes exactly those users before NOT can apply. Correct implementation would require LEFT JOIN + WHERE NULL semantics, which is not supported.

---

## 7. JSON Wire Format

The new condition in JSON:

```json
// With specific response (exact match):
{
  "type": "question_response",
  "form": "my-survey-shortcode",
  "question_ref": "consent_question",
  "response": "Yes"
}

// Without response (answered at all):
{
  "type": "question_response",
  "form": "my-survey-shortcode",
  "question_ref": "consent_question"
}
```

No custom marshaling/unmarshaling needed. The existing `SimpleCondition` struct with `omitempty` tags handles both cases transparently.

---

## 8. Generated SQL Examples

**question_response with specific response:**

Input:
```json
{
  "type": "question_response",
  "form": "intake-form",
  "question_ref": "q_consent",
  "response": "Yes"
}
```

Generated SQL:
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
LIMIT 100000
```

Parameters: `["intake-form", "q_consent", "Yes"]`

**question_response without response (any answer):**

Input:
```json
{
  "type": "question_response",
  "form": "intake-form",
  "question_ref": "q_consent"
}
```

Generated SQL:
```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid
WHERE qr0.userid IS NOT NULL
LIMIT 100000
```

Parameters: `["intake-form", "q_consent"]`

**Combined with other conditions:**

Input (AND of form + question_response with response):
```json
{
  "op": "and",
  "vars": [
    {"type": "state", "value": "RESPONDING"},
    {
      "type": "question_response",
      "form": "intake-form",
      "question_ref": "q_consent",
      "response": "Yes"
    }
  ]
}
```

Generated SQL:
```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $2 AND question_ref = $3 AND response = $4
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid
WHERE (s.current_state = $1 AND qr0.userid IS NOT NULL)
LIMIT 100000
```

Parameters: `["RESPONDING", "intake-form", "q_consent", "Yes"]`

---

## 9. Parameter Ordering Gotcha

The parameter ordering follows the same left-to-right traversal as `elapsed_time`. When `question_response` appears inside a compound condition:

- Simple conditions (form, state, etc.) that appear **before** `question_response` in the tree get lower parameter numbers
- The `question_response` CTE parameters (form, question_ref, and optionally response) are added when the condition is processed during tree traversal
- This is the same ordering used by `elapsed_time`

The test `TestBuildQuery_ComplexWithElapsedTime` is the reference for understanding this ordering: parameters are interleaved across WHERE and CTE sections based on left-to-right processing order.

---

## 10. Files to Change

| File | Change |
|------|--------|
| `exodus/types/types.go` | Add `Form *string` and `Response *string` to `SimpleCondition`; add `"question_response"` case to `Validate()`; extend NOT restriction to cover `question_response` |
| `exodus/query/builder.go` | Add `"question_response"` case to `buildSimpleCondition()`; add `buildQuestionResponseCondition()` method |
| `exodus/types/types_test.go` | Add tests for question_response validation (valid with response, valid without response, missing form, missing question_ref) |
| `exodus/query/builder_test.go` | Add tests for SQL generation (with response, without response, combined with other conditions, multiple question_response conditions) |
| `exodus/examples.json` | Add `question_response_bail` example |
| `exodus/examples_test.go` | Add `"question_response_bail"` to `testCases` slice |

---

## 11. Gotchas and Constraints

1. **`QuestionRef` already exists on `SimpleCondition`** but is not used by any active condition type. It was pre-added on the struct. Use it directly.

2. **`Form` does NOT already exist** on `SimpleCondition`. It must be added. The existing `Value` field is used for `form` condition but means "the form shortcode to match current_form against". For `question_response`, the `form` field means "the form shortcode to look up in the responses table". Different semantics, so a separate `Form` field is correct.

3. **`Response` does NOT already exist** on `SimpleCondition`. It must be added.

4. **NOT operator must be restricted** for `question_response` for the same reason as `elapsed_time`: INNER JOIN semantics cannot express NOT (answered this question). This is a new semantic constraint that must be added to both `containsElapsedTime` (or its successor) and the validation error message.

5. **Index usage**: The responses table has `INDEX (shortcode, question_ref, response, clusterid, timestamp)`. A query with `shortcode = ? AND question_ref = ? AND response = ?` will use this index efficiently. Without response (just `shortcode + question_ref`), it uses the same index as a prefix scan — still efficient.

6. **DISTINCT in CTE**: Use `SELECT DISTINCT userid` in the `question_response` CTE (unlike `elapsed_time` which uses `MIN(timestamp)`). A user can answer the same question multiple times (the PRIMARY KEY is `(userid, timestamp, question_ref)` so multiple rows per user+question are possible). Without DISTINCT, the JOIN would produce duplicate rows in the result.

7. **`elapsed_time` uses `MIN(timestamp)`** which implicitly deduplicates by taking the earliest response. `question_response` doesn't need the timestamp so DISTINCT is simpler.

8. **The `response` column is `VARCHAR NOT NULL`** in the schema — all rows have a response value, so no null handling is needed.

9. **CTE naming prefix**: Use `question_responses_N` (instead of `response_times_N`) to avoid naming conflicts when both `elapsed_time` and `question_response` conditions appear in the same bail. The `cteIndex` counter is shared across all CTE-generating condition types, so uniqueness is guaranteed.

---

## 12. Validation Chain (Complete)

After changes, the full validation path for `question_response`:

```
BailDefinition.Validate()
+-- Conditions.Validate()
    +-- SimpleCondition.Validate()
        +-- case "question_response":
            +-- form != nil (required)
            +-- question_ref != nil (required)
            +-- response: no validation (optional)
    +-- LogicalOperator.Validate()
        +-- if op == "not":
            +-- containsCTECondition() includes "question_response"
            +-- Error: "not operator cannot negate elapsed_time or question_response conditions"
```

---

## 13. Test Cases to Write

### types_test.go additions

```
- TestSimpleCondition_QuestionResponse_Valid_WithResponse
- TestSimpleCondition_QuestionResponse_Valid_WithoutResponse
- TestSimpleCondition_QuestionResponse_Missing_Form
- TestSimpleCondition_QuestionResponse_Missing_QuestionRef
- TestNotOperator_QuestionResponse_Rejected
- TestNotOperator_NestedQuestionResponse_Rejected
```

### builder_test.go additions

```
- TestBuildQuery_QuestionResponseWithResponse
  * Verify CTE: WITH question_responses_0 AS (... WHERE shortcode = $1 AND question_ref = $2 AND response = $3 ...)
  * Verify JOIN: JOIN question_responses_0 qr0 ON s.userid = qr0.userid
  * Verify WHERE: qr0.userid IS NOT NULL
  * Verify 3 params: [form, question_ref, response]

- TestBuildQuery_QuestionResponseWithoutResponse
  * Verify CTE: WHERE shortcode = $1 AND question_ref = $2 (no AND response = ...)
  * Verify 2 params: [form, question_ref]

- TestBuildQuery_QuestionResponseCombinedWithOtherConditions
  * AND of state + question_response_with_response
  * Verify correct parameter ordering ($1=state, $2=form, $3=qref, $4=response)

- TestBuildQuery_MultipleQuestionResponseConditions
  * Two question_response conditions in AND
  * Verify unique CTE names: question_responses_0, question_responses_1
  * Verify unique aliases: qr0, qr1
```

---

## 14. Cross-Reference: elapsed_time vs question_response

| Aspect | elapsed_time | question_response |
|--------|-------------|-------------------|
| CTE name | `response_times_N` | `question_responses_N` |
| CTE alias | `rt0`, `rt1`... | `qr0`, `qr1`... |
| CTE SELECT | `userid, MIN(timestamp) as response_time` | `DISTINCT userid` |
| CTE WHERE | `shortcode = $N AND question_ref = $M` | `shortcode = $N AND question_ref = $M [AND response = $K]` |
| CTE GROUP BY | `GROUP BY userid` | None (DISTINCT handles dedup) |
| JOIN | `JOIN ... ON s.userid = rtN.userid` | `JOIN ... ON s.userid = qrN.userid` |
| WHERE fragment | `rtN.response_time + $K::INTERVAL < NOW()` | `qrN.userid IS NOT NULL` |
| Params count | 3 (form, question_ref, duration) | 2 or 3 (form, question_ref, [response]) |
| NOT allowed | No | No |
| Fields on SimpleCondition | `Since *TimeReference`, `Duration *string` | `Form *string`, `QuestionRef *string`, `Response *string` |

---

## 15. Frontend: ConditionBuilder UI Analysis

**Date added**: 2026-02-22
**Files examined**: `dashboard-client/src/components/ConditionBuilder/ConditionBuilder.js`, `dashboard-client/src/containers/BailSystems/BailForm.js`

### 15a. Architecture Overview

The condition builder UI is entirely self-contained in one file:

```
dashboard-client/src/components/ConditionBuilder/
  ConditionBuilder.js    (all logic + rendering)
  index.js               (re-exports default)
```

It is consumed by `BailForm.js` as an AntD Form field:

```jsx
// BailForm.js line 227
<Form.Item name="conditions" rules={[{ required: true }]}>
  <ConditionBuilder />
</Form.Item>
```

The `ConditionBuilder` component is AntD Form-compatible: it receives `value` (the condition object) and calls `onChange(newCondition)` whenever state changes. AntD's `Form.Item` wires these props automatically.

### 15b. Component Hierarchy

Three internal components, only `ConditionBuilder` is exported:

```
ConditionBuilder          (main, AntD Form-compatible)
  └── ConditionNode       (dispatcher: compound vs simple)
        ├── CompoundCondition  (handles op: and/or/not + recursive children)
        └── SimpleCondition   (handles leaf condition types)
```

`ConditionNode` is declared with `let ConditionNode;` before `CompoundCondition` (line 178) so that `CompoundCondition` can reference it recursively. It is defined after `CompoundCondition` (line 301).

### 15c. How Condition Types Are Enumerated

All condition type options come from a single constant at the top of the file:

```javascript
// ConditionBuilder.js lines 23–29
const CONDITION_TYPES = {
  form: { label: 'Form' },
  state: { label: 'State' },
  error_code: { label: 'Error Code' },
  current_question: { label: 'Current Question' },
  elapsed_time: { label: 'Elapsed Time' },
};
```

These are rendered into an AntD `<Select>` in `SimpleCondition`:

```jsx
// lines 70–78
<Select value={type} onChange={handleTypeChange} style={{ width: 150 }}>
  {Object.entries(CONDITION_TYPES).map(([key, { label }]) => (
    <Option key={key} value={key}>{label}</Option>
  ))}
</Select>
```

**To add `question_response`**: Add one entry to `CONDITION_TYPES`:

```javascript
question_response: { label: 'Question Response' },
```

### 15d. How Type-Switching Resets Form State

When the user changes the type dropdown, `handleTypeChange` (lines 44–60) creates a fresh condition object with sensible defaults for the new type:

```javascript
const handleTypeChange = (newType) => {
  const newCondition = { type: newType };
  if (newType === 'form' || newType === 'state' || newType === 'error_code' || newType === 'current_question') {
    newCondition.value = '';
  } else if (newType === 'elapsed_time') {
    newCondition.since = {
      event: 'response',
      details: { form: '', question_ref: '' },
    };
    newCondition.duration = '1 week';
  }
  onChange(newCondition);
};
```

**For `question_response`**, add a new `else if` branch:

```javascript
} else if (newType === 'question_response') {
  newCondition.form = '';
  newCondition.question_ref = '';
  // response is intentionally omitted (optional field)
}
```

### 15e. How elapsed_time Renders Its Fields (Reference Implementation)

`elapsed_time` uses three inputs rendered inside a React Fragment (lines 126–165):

```jsx
{(type === 'elapsed_time') && (
  <>
    <Input
      placeholder="Form shortcode"
      value={(condition.since && condition.since.details && condition.since.details.form) || ''}
      onChange={(e) => {
        const newSince = {
          event: 'response',
          details: {
            ...(condition.since && condition.since.details),
            form: e.target.value,
          },
        };
        onChange({ ...condition, since: newSince });
      }}
      addonBefore="Form"
    />
    <Input
      placeholder="Question reference"
      value={(condition.since && condition.since.details && condition.since.details.question_ref) || ''}
      onChange={(e) => {
        const newSince = {
          event: 'response',
          details: {
            ...(condition.since && condition.since.details),
            question_ref: e.target.value,
          },
        };
        onChange({ ...condition, since: newSince });
      }}
      addonBefore="Question"
    />
    <Input
      placeholder="e.g., 4 weeks, 30 days"
      value={condition.duration || ''}
      onChange={(e) => handleFieldChange('duration', e.target.value)}
      addonBefore="Duration"
    />
  </>
)}
```

Key observations:
- `elapsed_time` stores `form` and `question_ref` nested inside `condition.since.details` (a complex object), not directly on the condition
- `question_response` stores them directly on the condition object: `condition.form` and `condition.question_ref`
- This means `question_response`'s field rendering is simpler — uses `handleFieldChange` directly (no nested object manipulation)

### 15f. What the question_response UI Block Should Look Like

The JSX block for `question_response` in `SimpleCondition`, to be placed after the `elapsed_time` block (after line 165):

```jsx
{(type === 'question_response') && (
  <>
    <Input
      placeholder="Form shortcode (e.g., onboarding_v1)"
      value={condition.form || ''}
      onChange={(e) => handleFieldChange('form', e.target.value)}
      addonBefore="Form"
    />
    <Input
      placeholder="Question reference (e.g., consent)"
      value={condition.question_ref || ''}
      onChange={(e) => handleFieldChange('question_ref', e.target.value)}
      addonBefore="Question"
    />
    <Select
      value={condition.response !== undefined ? 'equals' : 'answered'}
      onChange={(mode) => {
        if (mode === 'answered') {
          // Remove response field from condition
          const { response, ...rest } = condition;
          onChange(rest);
        } else {
          // Add response field with empty string
          handleFieldChange('response', '');
        }
      }}
      style={{ width: '100%' }}
    >
      <Option value="answered">Is answered (any response)</Option>
      <Option value="equals">Equals specific response</Option>
    </Select>
    {condition.response !== undefined && (
      <Input
        placeholder="Response value (e.g., Yes)"
        value={condition.response || ''}
        onChange={(e) => handleFieldChange('response', e.target.value)}
        addonBefore="Response"
      />
    )}
  </>
)}
```

**Notes on this design**:
- The mode selector (answered vs equals) controls whether `response` is present in the condition object
- "Is answered" mode: `response` key is absent from the object entirely (omitempty on backend)
- "Equals" mode: `response` key is present (even if empty string while user is typing)
- The mode is derived from the current state: `condition.response !== undefined` means equals mode
- `handleFieldChange` (lines 62–64) is available in scope: `onChange({ ...condition, [field]: value })`
- The destructuring `const { response, ...rest } = condition;` removes the field cleanly when switching to "answered" mode

### 15g. How Condition Data Flows to the Backend

The condition tree is stored directly in the AntD form field named `"conditions"`. When the form submits:

1. AntD calls `onFinish(values)` where `values.conditions` is the raw condition object from the builder
2. `buildDefinition(values)` (lines 83–116) passes `conditions` through unchanged:
   ```javascript
   return {
     conditions: values.conditions,  // passed as-is, no transformation
     execution,
     action: { ... },
   };
   ```
3. The definition is POSTed/PUT to the backend as JSON

**No transformation happens on the frontend.** The condition object built by `ConditionBuilder` is sent verbatim. This means:
- Field names in the condition object must exactly match what the backend expects
- For `question_response`: the object must be `{ type: "question_response", form: "...", question_ref: "...", response: "..." }` (or without `response`)

### 15h. How Edit Mode Loads an Existing Condition

In `BailForm.js` `loadBail()` (lines 50–81):

```javascript
const def = bail.definition;
form.setFieldsValue({
  // ...
  conditions: def.conditions,   // line 67
  // ...
});
```

The condition object from the API response is placed directly into the AntD form field. `ConditionBuilder` receives it as `value` prop and renders accordingly.

For `question_response`, edit mode works if:
- `condition.type === 'question_response'` triggers the correct JSX block
- `condition.form`, `condition.question_ref` populate their inputs via `value={condition.form || ''}`
- `condition.response !== undefined` shows the "equals" mode with the response input

No special deserialization is needed because the backend stores and returns the condition exactly as structured.

### 15i. Default Condition in BailForm

When creating a new bail, the form is initialized with:

```javascript
// BailForm.js lines 192–197
initialValues={{
  enabled: false,
  timing: 'immediate',
  timezone: 'UTC',
  conditions: { type: 'form', value: '' },  // default condition type is 'form'
}}
```

And `ConditionBuilder` itself also has a fallback:

```javascript
// ConditionBuilder.js line 333
const condition = value || { type: 'form', value: '' };
```

The default condition type is `form` in both places. No changes needed here — the user will switch to `question_response` via the type dropdown.

Also note the `onDelete` handler at the root level:

```javascript
// ConditionBuilder.js line 356
onDelete={() => handleChange({ type: 'form', value: '' })}
```

Deleting the root condition resets to `{ type: 'form', value: '' }`. This is consistent — no change needed.

### 15j. CompoundCondition Default New Child

When adding a new simple condition within a compound group, the default child is:

```javascript
// ConditionBuilder.js lines 218–220
const newChild = isCompound
  ? { op: 'and', vars: [{ type: 'form', value: '' }] }
  : { type: 'form', value: '' };
```

And when deleting a child leaves one remaining in NOT:

```javascript
// ConditionBuilder.js line 208
onChange({ op: 'not', vars: [{ type: 'form', value: '' }] });
```

These use `form` as the default type. No changes needed since `question_response` is just another selectable type, not a default.

---

## 16. Complete Frontend Change Summary

Only **one file** needs to be changed:

### File: `dashboard-client/src/components/ConditionBuilder/ConditionBuilder.js`

**Change 1 — Add to CONDITION_TYPES constant (line 29, after `elapsed_time` entry):**

```javascript
const CONDITION_TYPES = {
  form: { label: 'Form' },
  state: { label: 'State' },
  error_code: { label: 'Error Code' },
  current_question: { label: 'Current Question' },
  elapsed_time: { label: 'Elapsed Time' },
  question_response: { label: 'Question Response' },  // ADD THIS
};
```

**Change 2 — Add branch in handleTypeChange (after the `elapsed_time` else-if, around line 58):**

```javascript
} else if (newType === 'question_response') {
  newCondition.form = '';
  newCondition.question_ref = '';
  // response intentionally omitted (optional)
}
```

**Change 3 — Add JSX rendering block in SimpleCondition (after the `elapsed_time` block, after line 165):**

```jsx
{(type === 'question_response') && (
  <>
    <Input
      placeholder="Form shortcode (e.g., onboarding_v1)"
      value={condition.form || ''}
      onChange={(e) => handleFieldChange('form', e.target.value)}
      addonBefore="Form"
    />
    <Input
      placeholder="Question reference (e.g., consent)"
      value={condition.question_ref || ''}
      onChange={(e) => handleFieldChange('question_ref', e.target.value)}
      addonBefore="Question"
    />
    <Select
      value={condition.response !== undefined ? 'equals' : 'answered'}
      onChange={(mode) => {
        if (mode === 'answered') {
          const { response, ...rest } = condition;
          onChange(rest);
        } else {
          handleFieldChange('response', '');
        }
      }}
      style={{ width: '100%' }}
    >
      <Option value="answered">Is answered (any response)</Option>
      <Option value="equals">Equals specific response</Option>
    </Select>
    {condition.response !== undefined && (
      <Input
        placeholder="Response value (e.g., Yes)"
        value={condition.response || ''}
        onChange={(e) => handleFieldChange('response', e.target.value)}
        addonBefore="Response"
      />
    )}
  </>
)}
```

No other frontend files require changes. `BailForm.js`, `BailSystems.js`, `BailEvents.js`, and the routing are all unaffected.

---

## 17. Frontend Gotchas

1. **`handleFieldChange` uses spread — safe for direct fields**: `onChange({ ...condition, [field]: value })` works correctly for `form`, `question_ref`, and `response` because they are direct top-level fields on the condition object (unlike `elapsed_time`'s nested `since.details` structure).

2. **Mode toggle removes field via destructuring**: The switch from "equals" to "answered" mode must physically remove the `response` key from the condition object (not set it to `null` or `undefined`). The backend's `omitempty` tag means a `null` value might still serialize differently than an absent field depending on the JSON encoder. Use `const { response, ...rest } = condition; onChange(rest);` to safely drop the key.

3. **No imports needed**: `Select` and `Option` are already imported at the top of `ConditionBuilder.js` (lines 3, 7). The JSX block uses only components already in scope.

4. **`condition.response !== undefined` is the mode discriminator**: When the condition is first created (from `handleTypeChange`), `response` is not set. After switching to "equals" mode, `response` is set to `''`. The discriminator `condition.response !== undefined` correctly distinguishes these states. Do not use `condition.response` (falsy check) because `''` is falsy but means "equals mode with empty input".

5. **Edit mode for existing bails**: If a saved bail has `{ type: "question_response", form: "...", question_ref: "..." }` (no response), `condition.response` will be `undefined` after `JSON.parse`, so "answered" mode renders correctly. If it has `response: "Yes"`, the "equals" input shows correctly. No special handling needed.

6. **No PropTypes update needed**: `SimpleCondition.propTypes` uses `condition: PropTypes.object.isRequired` — the generic object type covers all condition shapes.

7. **No tests exist for ConditionBuilder**: The only test file found is `App.test.js`. There is no `ConditionBuilder.test.js`. The build engineer does not need to update tests (though adding them would be good practice).
