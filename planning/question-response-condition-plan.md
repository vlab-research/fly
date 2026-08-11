# question_response Condition — Implementation Plan

**Date**: 2026-02-22
**Based on**: `planning/question-response-condition-findings.md`
**Feature**: New `question_response` simple condition type for the bail system

---

## Overview

Add a `question_response` condition that lets a bail select users based on whether they answered a specific question (optionally with a specific answer) in the `responses` table. The condition uses the same CTE + INNER JOIN pattern as `elapsed_time`.

**Fields:**

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `form` | string | Yes | Shortcode of the form to look up in `responses.shortcode` |
| `question_ref` | string | Yes | The question identifier (`responses.question_ref`) |
| `response` | string | No | If present, exact match on `responses.response`; if absent, any answer matches |

---

## Required Reading

Before implementing, read these files in full:

- `/home/nandan/Documents/vlab-research/fly/exodus/types/types.go` — the full type system; all changes to `SimpleCondition`, `Validate()`, and `containsElapsedTime` live here
- `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go` — the full query builder; the new method and switch case go here
- `/home/nandan/Documents/vlab-research/fly/exodus/types/types_test.go` — see existing test patterns, especially `TestNotOperatorValidation`
- `/home/nandan/Documents/vlab-research/fly/exodus/query/builder_test.go` — see `TestBuildQuery_ElapsedTimeCondition` and `TestBuildQuery_ComplexWithElapsedTime` as the exact reference for CTE test structure
- `/home/nandan/Documents/vlab-research/fly/exodus/examples.json` — existing example structure to follow
- `/home/nandan/Documents/vlab-research/fly/exodus/examples_test.go` — the `testCases` slice that drives `TestExamplesJSONParsing`
- `/home/nandan/Documents/vlab-research/fly/documentation/bail-systems.md` — already partially updated; verify what needs to be added

---

## Chunk 1: Backend — Types

**File**: `/home/nandan/Documents/vlab-research/fly/exodus/types/types.go`

### 1a. Add fields to SimpleCondition (lines 86–94)

Current struct:

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

Replace with:

```go
type SimpleCondition struct {
    Type         string         `json:"type"`
    Value        *string        `json:"value,omitempty"`
    Since        *TimeReference `json:"since,omitempty"`
    Duration     *string        `json:"duration,omitempty"`
    ErrorCode    *string        `json:"error_code,omitempty"`
    QuestionRef  *string        `json:"question_ref,omitempty"`
    CurrentState *string        `json:"current_state,omitempty"`
    Form         *string        `json:"form,omitempty"`
    Response     *string        `json:"response,omitempty"`
}
```

Two fields added:
- `Form *string` — the form shortcode for `question_response`. Note: `Form` is different from `Value` (which for `form`-type conditions means "the current form to match against"). For `question_response`, `Form` means "look in this form's responses".
- `Response *string` — the optional exact answer to match.

`QuestionRef *string` already exists (line 92) and is reused directly.

### 1b. Add validation case to SimpleCondition.Validate() (lines 167–199)

Current switch ends at line 197 with the `default` case. Add a new case before `default`:

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

The `default` case (`return fmt.Errorf("invalid condition type: %s", sc.Type)`) is unchanged.

The full updated switch after changes:

```go
func (sc *SimpleCondition) Validate() error {
    switch sc.Type {
    case "form":
        if sc.Value == nil {
            return fmt.Errorf("value is required for form condition")
        }
    case "state":
        if sc.Value == nil {
            return fmt.Errorf("value is required for state condition")
        }
    case "error_code":
        if sc.Value == nil {
            return fmt.Errorf("value is required for error_code condition")
        }
    case "current_question":
        if sc.Value == nil {
            return fmt.Errorf("value is required for current_question condition")
        }
    case "elapsed_time":
        if sc.Since == nil {
            return fmt.Errorf("since is required for elapsed_time condition")
        }
        if sc.Duration == nil {
            return fmt.Errorf("duration is required for elapsed_time condition")
        }
        if err := sc.Since.Validate(); err != nil {
            return fmt.Errorf("invalid since reference: %w", err)
        }
    case "question_response":
        if sc.Form == nil {
            return fmt.Errorf("form is required for question_response condition")
        }
        if sc.QuestionRef == nil {
            return fmt.Errorf("question_ref is required for question_response condition")
        }
    default:
        return fmt.Errorf("invalid condition type: %s", sc.Type)
    }
    return nil
}
```

### 1c. Extend the NOT restriction (lines 220–242)

Current code (lines 220–242):

```go
// Reject NOT wrapping elapsed_time (directly or transitively)
if lo.Op == "not" {
    if containsElapsedTime(&lo.Vars[0]) {
        return fmt.Errorf("not operator cannot negate elapsed_time conditions (not yet supported)")
    }
}
```

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

Replace both the call site and the helper function. **Rename `containsElapsedTime` to `containsCTECondition`** (it now covers both CTE-based types). Update error message accordingly.

New code for `LogicalOperator.Validate()` (replace the NOT restriction block at lines 220–225):

```go
// Reject NOT wrapping CTE-based conditions (elapsed_time or question_response)
// These use INNER JOINs that cannot express negation correctly
if lo.Op == "not" {
    if containsCTECondition(&lo.Vars[0]) {
        return fmt.Errorf("not operator cannot negate elapsed_time or question_response conditions (not yet supported)")
    }
}
```

New helper function (replaces `containsElapsedTime` at lines 229–242):

```go
// containsCTECondition recursively checks if a condition tree contains a
// CTE-based condition (elapsed_time or question_response).
// These use INNER JOINs and cannot be correctly negated by NOT.
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

**Why this restriction applies**: `question_response` uses INNER JOIN. If a user has never answered the question, they are excluded from the CTE and therefore excluded from the JOIN result. Wrapping in NOT would require LEFT JOIN + `IS NULL` semantics to match "users who did NOT answer". That is not implemented and would require significant query builder changes.

---

## Chunk 2: Backend — Query Builder

**File**: `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go`

### 2a. Add case in buildSimpleCondition() (lines 88–104)

Current switch:

```go
func (qb *QueryBuilder) buildSimpleCondition(cond *types.SimpleCondition) (string, error) {
    switch cond.Type {
    case "form":
        return qb.buildFormCondition(cond)
    case "state":
        return qb.buildStateCondition(cond)
    case "error_code":
        return qb.buildErrorCodeCondition(cond)
    case "current_question":
        return qb.buildCurrentQuestionCondition(cond)
    case "elapsed_time":
        return qb.buildElapsedTimeCondition(cond)
    default:
        return "", fmt.Errorf("unsupported condition type: %s", cond.Type)
    }
}
```

Add `question_response` before `default`:

```go
    case "question_response":
        return qb.buildQuestionResponseCondition(cond)
```

### 2b. Add buildQuestionResponseCondition() method

Add this method after `buildElapsedTimeCondition` (after line 196), before `buildLogicalOperator`:

```go
// buildQuestionResponseCondition creates SQL for question response conditions with CTEs.
// If cond.Response is set, matches users who answered the question with that exact value.
// If cond.Response is nil, matches users who answered the question with any value.
func (qb *QueryBuilder) buildQuestionResponseCondition(cond *types.SimpleCondition) (string, error) {
    if cond.Form == nil {
        return "", fmt.Errorf("form is required for question_response condition")
    }
    if cond.QuestionRef == nil {
        return "", fmt.Errorf("question_ref is required for question_response condition")
    }

    // Allocate a unique CTE index and name for this condition
    cteName := fmt.Sprintf("question_responses_%d", qb.cteIndex)
    qb.cteIndex++

    // Add parameters
    formParam := qb.addParam(*cond.Form)
    questionParam := qb.addParam(*cond.QuestionRef)

    var cte string
    if cond.Response != nil {
        // Match users who answered with a specific response value (exact match)
        responseParam := qb.addParam(*cond.Response)
        cte = fmt.Sprintf(`%s AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d AND response = $%d
)`, cteName, formParam, questionParam, responseParam)
    } else {
        // Match users who answered the question at all (any response value)
        cte = fmt.Sprintf(`%s AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
)`, cteName, formParam, questionParam)
    }

    qb.ctes = append(qb.ctes, cte)

    // Add JOIN clause so BuildQuery includes this CTE in the FROM clause
    aliasIdx := qb.cteIndex - 1
    joinClause := fmt.Sprintf("JOIN %s qr%d ON s.userid = qr%d.userid",
        cteName, aliasIdx, aliasIdx)
    qb.cteJoins = append(qb.cteJoins, joinClause)

    // The INNER JOIN is the filter; return a syntactically valid WHERE fragment
    // that is always true given the join constraint
    return fmt.Sprintf("qr%d.userid IS NOT NULL", aliasIdx), nil
}
```

### 2c. CTE templates (exact SQL)

**When `response` is present** — `cond.Response != nil`:

```sql
question_responses_N AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $M AND question_ref = $K AND response = $J
)
```

JOIN clause: `JOIN question_responses_N qrN ON s.userid = qrN.userid`

WHERE fragment: `qrN.userid IS NOT NULL`

**When `response` is absent** — `cond.Response == nil`:

```sql
question_responses_N AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $M AND question_ref = $K
)
```

JOIN clause: `JOIN question_responses_N qrN ON s.userid = qrN.userid`

WHERE fragment: `qrN.userid IS NOT NULL`

### 2d. Why DISTINCT and not GROUP BY

The `responses` table PRIMARY KEY is `(userid, timestamp, question_ref)`. A user can submit the same question multiple times. `elapsed_time` uses `MIN(timestamp) ... GROUP BY userid` to deduplicate. For `question_response`, only `userid` is selected, so `SELECT DISTINCT userid` achieves deduplication without an aggregate and without GROUP BY. Without DISTINCT, duplicate rows in the CTE would produce duplicate rows in the JOIN result.

### 2e. Why IS NOT NULL as the WHERE fragment

`BuildQuery` (line 64) emits `WHERE <whereClause>` only when the returned string is non-empty. With only a `question_response` condition, the WHERE fragment must be non-empty. `qrN.userid IS NOT NULL` is always true given the INNER JOIN but produces a valid syntactic WHERE clause. The INNER JOIN itself does the actual filtering. This is the simplest approach that avoids changing `BuildQuery`'s assembly logic.

### 2f. Parameter ordering

Parameters are added left-to-right in tree traversal order, matching `elapsed_time`'s behavior. For a standalone `question_response`:

- `$1` = `form` value
- `$2` = `question_ref` value
- `$3` = `response` value (if present)

When combined in AND with other conditions, earlier conditions in `vars` get lower parameter numbers. See the test cases in Chunk 3 for concrete examples.

---

## Chunk 3: Backend — Tests

### File: `/home/nandan/Documents/vlab-research/fly/exodus/types/types_test.go`

Add a new top-level test function after `TestNotOperatorValidation`. Follow the table-driven style used throughout.

```go
func TestSimpleCondition_QuestionResponseValidation(t *testing.T) {
    tests := []struct {
        name    string
        jsonStr string
        wantErr bool
        errMsg  string
    }{
        {
            name:    "valid with response",
            jsonStr: `{"type": "question_response", "form": "myform", "question_ref": "q1", "response": "Yes"}`,
            wantErr: false,
        },
        {
            name:    "valid without response (any answer)",
            jsonStr: `{"type": "question_response", "form": "myform", "question_ref": "q1"}`,
            wantErr: false,
        },
        {
            name:    "missing form",
            jsonStr: `{"type": "question_response", "question_ref": "q1"}`,
            wantErr: true,
            errMsg:  "form is required for question_response condition",
        },
        {
            name:    "missing question_ref",
            jsonStr: `{"type": "question_response", "form": "myform"}`,
            wantErr: true,
            errMsg:  "question_ref is required for question_response condition",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            var cond Condition
            err := json.Unmarshal([]byte(tt.jsonStr), &cond)
            if err != nil {
                t.Fatalf("Unmarshal() error = %v", err)
            }
            err = cond.Validate()
            if (err != nil) != tt.wantErr {
                t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
            }
            if tt.wantErr && err != nil && tt.errMsg != "" {
                if !strings.Contains(err.Error(), tt.errMsg) {
                    t.Errorf("Expected error containing %q, got %q", tt.errMsg, err.Error())
                }
            }
        })
    }
}
```

Add NOT restriction tests. These extend `TestNotOperatorValidation` — either append to its table or add a new function. Appending to the existing table is cleaner:

```go
// Add these cases to TestNotOperatorValidation's tests slice:
{
    name:    "invalid not with question_response",
    jsonStr: `{"op": "not", "vars": [{"type": "question_response", "form": "f1", "question_ref": "q1"}]}`,
    wantErr: true,
    errMsg:  "not operator cannot negate elapsed_time or question_response conditions",
},
{
    name:    "invalid not with nested question_response",
    jsonStr: `{"op": "not", "vars": [{"op": "and", "vars": [{"type": "form", "value": "f"}, {"type": "question_response", "form": "f1", "question_ref": "q1"}]}]}`,
    wantErr: true,
    errMsg:  "not operator cannot negate elapsed_time or question_response conditions",
},
```

Important: the existing `errMsg` checks for `"not operator cannot negate elapsed_time"` will still pass because the new error message `"not operator cannot negate elapsed_time or question_response conditions (not yet supported)"` contains `"not operator cannot negate elapsed_time"` as a substring. No existing test cases need to be modified.

### File: `/home/nandan/Documents/vlab-research/fly/exodus/query/builder_test.go`

Add four new test functions after `TestBuildQuery_NotInsideAnd`.

**Test 1: standalone question_response with response**

```go
func TestBuildQuery_QuestionResponseWithResponse(t *testing.T) {
    def := &types.BailDefinition{
        Conditions: conditionFromJSON(`{
            "type": "question_response",
            "form": "intake-form",
            "question_ref": "q_consent",
            "response": "Yes"
        }`),
        Execution: types.Execution{Timing: "immediate"},
        Action:    types.Action{DestinationForm: "exit-form"},
    }

    sql, params, err := BuildQuery(def)
    if err != nil {
        t.Fatalf("BuildQuery failed: %v", err)
    }

    // CTE structure
    if !strings.Contains(sql, "WITH question_responses_0 AS") {
        t.Errorf("SQL missing CTE, got: %s", sql)
    }
    if !strings.Contains(sql, "SELECT DISTINCT userid") {
        t.Errorf("CTE missing SELECT DISTINCT userid, got: %s", sql)
    }
    if !strings.Contains(sql, "FROM responses") {
        t.Errorf("CTE missing FROM responses, got: %s", sql)
    }
    // $1=intake-form, $2=q_consent, $3=Yes
    if !strings.Contains(sql, "WHERE shortcode = $1 AND question_ref = $2 AND response = $3") {
        t.Errorf("CTE missing correct WHERE clause, got: %s", sql)
    }
    // No GROUP BY (unlike elapsed_time)
    if strings.Contains(sql, "GROUP BY") {
        t.Errorf("SQL should not contain GROUP BY for question_response, got: %s", sql)
    }

    // JOIN and WHERE fragment
    if !strings.Contains(sql, "JOIN question_responses_0 qr0 ON s.userid = qr0.userid") {
        t.Errorf("SQL missing JOIN, got: %s", sql)
    }
    if !strings.Contains(sql, "WHERE qr0.userid IS NOT NULL") {
        t.Errorf("SQL missing WHERE fragment, got: %s", sql)
    }

    // Parameters: $1=intake-form, $2=q_consent, $3=Yes
    if len(params) != 3 {
        t.Fatalf("Expected 3 parameters, got %d: %v", len(params), params)
    }
    if params[0] != "intake-form" {
        t.Errorf("Expected params[0]='intake-form', got %v", params[0])
    }
    if params[1] != "q_consent" {
        t.Errorf("Expected params[1]='q_consent', got %v", params[1])
    }
    if params[2] != "Yes" {
        t.Errorf("Expected params[2]='Yes', got %v", params[2])
    }
}
```

**Test 2: standalone question_response without response**

```go
func TestBuildQuery_QuestionResponseWithoutResponse(t *testing.T) {
    def := &types.BailDefinition{
        Conditions: conditionFromJSON(`{
            "type": "question_response",
            "form": "intake-form",
            "question_ref": "q_consent"
        }`),
        Execution: types.Execution{Timing: "immediate"},
        Action:    types.Action{DestinationForm: "exit-form"},
    }

    sql, params, err := BuildQuery(def)
    if err != nil {
        t.Fatalf("BuildQuery failed: %v", err)
    }

    if !strings.Contains(sql, "WITH question_responses_0 AS") {
        t.Errorf("SQL missing CTE, got: %s", sql)
    }
    // WHERE clause must NOT contain response filter
    if strings.Contains(sql, "AND response =") {
        t.Errorf("SQL should not contain response filter when response is absent, got: %s", sql)
    }
    // $1=intake-form, $2=q_consent only
    if !strings.Contains(sql, "WHERE shortcode = $1 AND question_ref = $2") {
        t.Errorf("CTE missing correct WHERE clause, got: %s", sql)
    }
    if !strings.Contains(sql, "JOIN question_responses_0 qr0 ON s.userid = qr0.userid") {
        t.Errorf("SQL missing JOIN, got: %s", sql)
    }

    // Parameters: $1=intake-form, $2=q_consent (only 2)
    if len(params) != 2 {
        t.Fatalf("Expected 2 parameters, got %d: %v", len(params), params)
    }
    if params[0] != "intake-form" {
        t.Errorf("Expected params[0]='intake-form', got %v", params[0])
    }
    if params[1] != "q_consent" {
        t.Errorf("Expected params[1]='q_consent', got %v", params[1])
    }
}
```

**Test 3: question_response combined with other conditions in AND**

This verifies correct parameter ordering when mixed with simple conditions.

```go
func TestBuildQuery_QuestionResponseCombinedWithOtherConditions(t *testing.T) {
    def := &types.BailDefinition{
        Conditions: conditionFromJSON(`{
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
        }`),
        Execution: types.Execution{Timing: "immediate"},
        Action:    types.Action{DestinationForm: "exit-form"},
    }

    sql, params, err := BuildQuery(def)
    if err != nil {
        t.Fatalf("BuildQuery failed: %v", err)
    }

    if !strings.Contains(sql, "WITH question_responses_0 AS") {
        t.Errorf("SQL missing CTE, got: %s", sql)
    }
    if !strings.Contains(sql, "JOIN question_responses_0 qr0") {
        t.Errorf("SQL missing JOIN, got: %s", sql)
    }
    // $1=RESPONDING (state, processed first), $2=intake-form (CTE), $3=q_consent (CTE), $4=Yes (CTE)
    if !strings.Contains(sql, "s.current_state = $1") {
        t.Errorf("SQL missing state condition, got: %s", sql)
    }
    if !strings.Contains(sql, "shortcode = $2 AND question_ref = $3 AND response = $4") {
        t.Errorf("SQL missing CTE WHERE with correct param numbers, got: %s", sql)
    }
    if !strings.Contains(sql, "qr0.userid IS NOT NULL") {
        t.Errorf("SQL missing WHERE fragment, got: %s", sql)
    }

    // Parameters: $1=RESPONDING, $2=intake-form, $3=q_consent, $4=Yes
    if len(params) != 4 {
        t.Fatalf("Expected 4 parameters, got %d: %v", len(params), params)
    }
    if params[0] != "RESPONDING" {
        t.Errorf("Expected params[0]='RESPONDING', got %v", params[0])
    }
    if params[1] != "intake-form" {
        t.Errorf("Expected params[1]='intake-form', got %v", params[1])
    }
    if params[2] != "q_consent" {
        t.Errorf("Expected params[2]='q_consent', got %v", params[2])
    }
    if params[3] != "Yes" {
        t.Errorf("Expected params[3]='Yes', got %v", params[3])
    }
}
```

**Test 4: multiple question_response conditions — unique CTE names**

```go
func TestBuildQuery_MultipleQuestionResponseConditions(t *testing.T) {
    def := &types.BailDefinition{
        Conditions: conditionFromJSON(`{
            "op": "and",
            "vars": [
                {
                    "type": "question_response",
                    "form": "form1",
                    "question_ref": "q1",
                    "response": "Yes"
                },
                {
                    "type": "question_response",
                    "form": "form2",
                    "question_ref": "q2"
                }
            ]
        }`),
        Execution: types.Execution{Timing: "immediate"},
        Action:    types.Action{DestinationForm: "exit-form"},
    }

    sql, params, err := BuildQuery(def)
    if err != nil {
        t.Fatalf("BuildQuery failed: %v", err)
    }

    // Unique CTE names
    if !strings.Contains(sql, "question_responses_0") {
        t.Errorf("SQL missing first CTE (question_responses_0), got: %s", sql)
    }
    if !strings.Contains(sql, "question_responses_1") {
        t.Errorf("SQL missing second CTE (question_responses_1), got: %s", sql)
    }
    // Unique JOIN aliases
    if !strings.Contains(sql, "JOIN question_responses_0 qr0") {
        t.Errorf("SQL missing first JOIN (qr0), got: %s", sql)
    }
    if !strings.Contains(sql, "JOIN question_responses_1 qr1") {
        t.Errorf("SQL missing second JOIN (qr1), got: %s", sql)
    }
    // WHERE references both aliases
    if !strings.Contains(sql, "qr0.userid IS NOT NULL") {
        t.Errorf("SQL missing first WHERE fragment, got: %s", sql)
    }
    if !strings.Contains(sql, "qr1.userid IS NOT NULL") {
        t.Errorf("SQL missing second WHERE fragment, got: %s", sql)
    }

    // $1=form1, $2=q1, $3=Yes, $4=form2, $5=q2 (5 params: first CTE has response, second does not)
    if len(params) != 5 {
        t.Fatalf("Expected 5 parameters, got %d: %v", len(params), params)
    }
    if params[0] != "form1" {
        t.Errorf("Expected params[0]='form1', got %v", params[0])
    }
    if params[1] != "q1" {
        t.Errorf("Expected params[1]='q1', got %v", params[1])
    }
    if params[2] != "Yes" {
        t.Errorf("Expected params[2]='Yes', got %v", params[2])
    }
    if params[3] != "form2" {
        t.Errorf("Expected params[3]='form2', got %v", params[3])
    }
    if params[4] != "q2" {
        t.Errorf("Expected params[4]='q2', got %v", params[4])
    }
}
```

### File: `/home/nandan/Documents/vlab-research/fly/exodus/examples.json`

Add a new top-level key `"question_response_bail"` at the end of the JSON object (before the final closing `}`). Also add a `"question_response_any_answer_bail"` for the without-response case:

```json
  "question_response_bail": {
    "name": "Consent Response Bail",
    "description": "Bail users who answered the consent question with Yes",
    "survey_id": "123e4567-e89b-12d3-a456-426614174000",
    "enabled": true,
    "destination_form": "main-survey",
    "definition": {
      "conditions": {
        "type": "question_response",
        "form": "intake-form",
        "question_ref": "q_consent",
        "response": "Yes"
      },
      "execution": {
        "timing": "immediate"
      },
      "action": {
        "destination_form": "main-survey",
        "metadata": {
          "trigger": "consent_given"
        }
      }
    }
  },
  "question_response_any_answer_bail": {
    "name": "Any Consent Answer Bail",
    "description": "Bail users who answered the consent question at all",
    "survey_id": "123e4567-e89b-12d3-a456-426614174000",
    "enabled": true,
    "destination_form": "followup-survey",
    "definition": {
      "conditions": {
        "type": "question_response",
        "form": "intake-form",
        "question_ref": "q_consent"
      },
      "execution": {
        "timing": "immediate"
      },
      "action": {
        "destination_form": "followup-survey"
      }
    }
  }
```

### File: `/home/nandan/Documents/vlab-research/fly/exodus/examples_test.go`

In `TestExamplesJSONParsing`, add the two new keys to the `testCases` slice (lines 25–30):

```go
testCases := []string{
    "simple_bail_example",
    "complex_bail_with_and",
    "complex_bail_with_nested_logic",
    "elapsed_time_bail",
    "question_response_bail",
    "question_response_any_answer_bail",
}
```

---

## Chunk 4: Frontend — ConditionBuilder

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/ConditionBuilder/ConditionBuilder.js`

Three changes, all surgical. No imports need to be added — `Select`, `Option`, and `Input` are all already imported at lines 3 and 7.

### 4a. Add to CONDITION_TYPES constant (lines 23–29)

Current:

```javascript
const CONDITION_TYPES = {
  form: { label: 'Form' },
  state: { label: 'State' },
  error_code: { label: 'Error Code' },
  current_question: { label: 'Current Question' },
  elapsed_time: { label: 'Elapsed Time' },
};
```

Add one entry after `elapsed_time`:

```javascript
const CONDITION_TYPES = {
  form: { label: 'Form' },
  state: { label: 'State' },
  error_code: { label: 'Error Code' },
  current_question: { label: 'Current Question' },
  elapsed_time: { label: 'Elapsed Time' },
  question_response: { label: 'Question Response' },
};
```

### 4b. Add branch in handleTypeChange (lines 44–60)

Current function:

```javascript
const handleTypeChange = (newType) => {
  const newCondition = { type: newType };
  if (newType === 'form' || newType === 'state' || newType === 'error_code' || newType === 'current_question') {
    newCondition.value = '';
  } else if (newType === 'elapsed_time') {
    newCondition.since = {
      event: 'response',
      details: {
        form: '',
        question_ref: '',
      },
    };
    newCondition.duration = '1 week';
  }
  onChange(newCondition);
};
```

Add a new `else if` branch after the `elapsed_time` block:

```javascript
const handleTypeChange = (newType) => {
  const newCondition = { type: newType };
  if (newType === 'form' || newType === 'state' || newType === 'error_code' || newType === 'current_question') {
    newCondition.value = '';
  } else if (newType === 'elapsed_time') {
    newCondition.since = {
      event: 'response',
      details: {
        form: '',
        question_ref: '',
      },
    };
    newCondition.duration = '1 week';
  } else if (newType === 'question_response') {
    newCondition.form = '';
    newCondition.question_ref = '';
    // response intentionally omitted — starts in "answered" (any response) mode
  }
  onChange(newCondition);
};
```

The `response` field is intentionally not set in the default state. This means the condition starts in "any answer" mode (the simpler case). The user can switch to "equals specific response" mode via the mode selector.

### 4c. Add JSX rendering block in SimpleCondition (after line 165)

The `elapsed_time` block ends at line 165 (`</>`). Add the `question_response` block immediately after, before the closing `</Space>` at line 166.

Insert this JSX block after the `elapsed_time` block's closing `</>` (after line 165):

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

**Key design decisions:**

1. **Mode discriminator is `condition.response !== undefined`**, not `condition.response` (falsy check). When the user switches to "equals" mode, `response` is set to `''` (empty string). An empty string is falsy, but `'' !== undefined` is true — so the discriminator correctly shows the response input even when the user hasn't typed anything yet.

2. **Switching to "answered" mode uses destructuring** (`const { response, ...rest } = condition; onChange(rest);`) to physically remove the `response` key from the condition object. Setting it to `null` would serialize differently; removing the key entirely ensures the backend receives no `response` field and its `omitempty` tag omits it from SQL generation.

3. **`handleFieldChange` is used for `form`, `question_ref`, and `response`** because they are direct top-level fields (unlike `elapsed_time`'s nested `since.details` structure which required custom onChange handlers).

4. **Edit mode works without special handling**: When loading a saved bail with `question_response`, `condition.form` and `condition.question_ref` populate inputs via `value={condition.form || ''}`. If `condition.response` exists, the mode selector shows "equals" and the response input appears. If absent, "answered" mode renders.

---

## Chunk 5: Documentation

**File**: `/home/nandan/Documents/vlab-research/fly/documentation/bail-systems.md`

The documentation already contains several `question_response` references (added during investigation), but they are scattered and incomplete. Verify and complete these specific locations:

### 5a. Condition types table (already updated, verify line 129)

The table at lines 122–129 already has:
```
| `question_response` | `responses` table — user answered a question | See below |
```
No change needed.

### 5b. question_response description (already present, lines 146–159)

Lines 146–159 already document `question_response` correctly. Verify the content matches. Add the two JSON examples side by side (with and without response) if not already present:

```markdown
**Question response** conditions select users based on their survey answers. `form` and `question_ref` are required; `response` is optional:

```json
{
  "type": "question_response",
  "form": "intake-survey",
  "question_ref": "consent_question",
  "response": "Yes"
}
```

Without `response` — matches any user who answered the question:

```json
{
  "type": "question_response",
  "form": "intake-survey",
  "question_ref": "consent_question"
}
```

If `response` is provided, only users who answered that question with exactly that value are matched. If `response` is omitted, all users who answered the question (with any value) are matched.

Implementation uses a CTE with an INNER JOIN against the `responses` table, similar to `elapsed_time`. Wrapping `question_response` inside a NOT operator is not supported for the same reason as `elapsed_time`: the INNER JOIN cannot express "users who did NOT answer this question".
```

### 5c. NOT operator constraint (already present, verify line 221)

Line 221 already states:
```
- Cannot negate `elapsed_time` or `question_response` conditions, directly or transitively. Both conditions use INNER JOIN CTEs against the responses table; negating them would require LEFT JOIN + IS NULL semantics to correctly include users who never responded, which is not yet supported.
```
No change needed.

### 5d. Wire format reference (already present, verify lines 551–556)

Lines 551–556 already include:
```
{
  "type": "question_response",
  "form": "string (required, form shortcode)",
  "question_ref": "string (required)",
  "response": "string (optional, exact match against responses.response column)"
}
```
No change needed.

### 5e. Update the UI description (line 52)

Line 52 currently says:
```
2. **Conditions** -- a visual condition builder supporting AND/OR/NOT logic trees with condition types: form, state, error_code, current_question, elapsed_time
```

Update to include `question_response`:
```
2. **Conditions** -- a visual condition builder supporting AND/OR/NOT logic trees with condition types: form, state, error_code, current_question, elapsed_time, question_response
```

### 5f. Update the query package description (line 282)

Line 282 currently says:
```
- `query/` -- Translates condition trees into parameterized SQL with CTEs for elapsed_time conditions
```

Update to:
```
- `query/` -- Translates condition trees into parameterized SQL with CTEs for elapsed_time and question_response conditions
```

### 5g. Add generated SQL section for question_response

After the NOT operator SQL table (around line 228), add a new subsection documenting `question_response` SQL generation. Find an appropriate location — likely after the existing elapsed_time SQL description. Add:

```markdown
**SQL generation for question_response:**

When `response` is specified (exact match):
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
Parameters: `[$form, $question_ref, $response]`

When `response` is absent (any answer):
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
Parameters: `[$form, $question_ref]`
```

---

## Generated SQL Examples (Reference)

These are the exact SQL strings the query builder will produce. Tests should assert these patterns.

**Standalone, response present:**

Input:
```json
{"type": "question_response", "form": "intake-form", "question_ref": "q_consent", "response": "Yes"}
```

Output SQL:
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

**Standalone, response absent:**

Input:
```json
{"type": "question_response", "form": "intake-form", "question_ref": "q_consent"}
```

Output SQL:
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

**Combined with state condition:**

Input:
```json
{"op": "and", "vars": [
  {"type": "state", "value": "RESPONDING"},
  {"type": "question_response", "form": "intake-form", "question_ref": "q_consent", "response": "Yes"}
]}
```

Output SQL:
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

## Acceptance Criteria

All of the following must be true for the feature to be complete:

**Backend types:**
1. `go build ./...` in `exodus/` succeeds with no errors
2. `go vet ./...` in `exodus/` produces no warnings
3. `TestSimpleCondition_QuestionResponseValidation` passes: valid conditions (with and without response) succeed; missing `form` returns "form is required"; missing `question_ref` returns "question_ref is required"
4. `TestNotOperatorValidation` passes including the two new NOT+question_response cases: both return "not operator cannot negate elapsed_time or question_response conditions"
5. Existing NOT+elapsed_time tests still pass (error message still contains "not operator cannot negate elapsed_time")
6. `TestBailDefinitionMarshalUnmarshal` and all existing tests in `types_test.go` still pass

**Backend query builder:**
7. `TestBuildQuery_QuestionResponseWithResponse` passes: SQL contains `question_responses_0`, `SELECT DISTINCT userid`, `shortcode = $1 AND question_ref = $2 AND response = $3`, join on `qr0`, 3 params
8. `TestBuildQuery_QuestionResponseWithoutResponse` passes: SQL does not contain `AND response =`, 2 params
9. `TestBuildQuery_QuestionResponseCombinedWithOtherConditions` passes: state is `$1`, CTE params are `$2/$3/$4`, 4 total params
10. `TestBuildQuery_MultipleQuestionResponseConditions` passes: two unique CTEs (`question_responses_0`, `question_responses_1`), two joins (`qr0`, `qr1`), 5 params
11. All existing builder tests still pass (especially `TestBuildQuery_ElapsedTimeCondition` and `TestBuildQuery_ComplexWithElapsedTime`)

**Examples:**
12. `TestExamplesJSONParsing` passes for both `"question_response_bail"` and `"question_response_any_answer_bail"` — they parse, validate, and round-trip correctly
13. `go test ./...` in `exodus/` passes all tests

**Frontend:**
14. `question_response` appears in the type dropdown in the bail condition builder UI
15. Selecting `question_response` shows Form and Question inputs (populated with empty strings initially)
16. The mode selector shows "Is answered (any response)" by default
17. Switching to "Equals specific response" shows the Response input
18. Switching back to "Is answered" hides the Response input and removes the `response` key from the condition object
19. Creating a bail with `question_response` (with response) and submitting to the backend succeeds (200 OK)
20. Creating a bail with `question_response` (without response) and submitting succeeds
21. Loading an existing bail with `question_response` in edit mode shows the correct field values
22. The condition object sent to the backend has fields `type`, `form`, `question_ref`, and optionally `response` — no other unexpected fields

**Documentation:**
23. `documentation/bail-systems.md` line 52 lists `question_response` in the UI description
24. `documentation/bail-systems.md` line 282 mentions `question_response` in the query package description
25. The generated SQL examples for `question_response` are present in `bail-systems.md`

---

## Gotchas and Ordering Notes

1. **Rename `containsElapsedTime` globally**: After renaming to `containsCTECondition`, search the whole `types/` package for any other callers of `containsElapsedTime`. There should be none besides `LogicalOperator.Validate()`, but verify.

2. **Parameter ordering is left-to-right**: In the AND `[state, question_response]` example, `state` is `$1` and the CTE params start at `$2`. This matches `elapsed_time` behavior and is tested in `TestBuildQuery_ComplexWithElapsedTime`. The new combined test verifies the same pattern.

3. **No changes to `BuildQuery` itself**: The CTE assembly logic in `BuildQuery` (lines 44–73) handles any number of CTEs and CTE joins generically. `question_response` plugs in through the same `qb.ctes` and `qb.cteJoins` slices that `elapsed_time` uses.

4. **No frontend test files to update**: `ConditionBuilder.test.js` does not exist. The only test is `App.test.js`. No test file changes needed for the frontend.

5. **JSON serialization is transparent**: `SimpleCondition` uses `omitempty` tags. `Form *string` and `Response *string` with `omitempty` serialize to absent JSON keys when nil. No custom marshal/unmarshal logic is needed.

6. **`QuestionRef` field naming collision check**: `SimpleCondition.QuestionRef` maps to `json:"question_ref"`. `TimeEventDetails.QuestionRef` (used by `elapsed_time`) maps to `json:"question_ref"` inside the `since.details` object. These are on different structs and different JSON paths, so there is no collision.
