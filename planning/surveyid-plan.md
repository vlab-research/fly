# Implementation Plan: `surveyid` Condition Type for the Bail System

**Date**: 2026-02-22
**Scope**: Add a new `surveyid` simple condition type to exodus bails.
**Findings reference**: `planning/surveyid-starttime-findings.md`

---

## 1. Required Reading

Before starting, read these files in full:

| File | Why |
|------|-----|
| `/home/nandan/Documents/vlab-research/fly/exodus/types/types.go` | Contains `SimpleCondition`, `Validate()`, and `containsCTECondition()`. You are adding a case to the switch at line 170. |
| `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go` | Contains `buildSimpleCondition()` switch (line 90) and all builder functions. You are adding one case and one new function. |
| `/home/nandan/Documents/vlab-research/fly/exodus/types/types_test.go` | Contains `TestSimpleConditionValidation` (line 462) and `TestNotOperatorValidation` (line 513). You are adding table-driven cases to both. |
| `/home/nandan/Documents/vlab-research/fly/exodus/query/builder_test.go` | Contains all query builder tests. The last test is `TestBuildQuery_QuestionResponseWithoutResponse` (line 675). You are appending new test functions after it. |
| `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/ConditionBuilder/ConditionBuilder.js` | Contains `CONDITION_TYPES` (line 23), `handleTypeChange` (line 45), and JSX render blocks (lines 94–210). You are adding to all three. |
| `/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql` (lines 44–59) | Confirms the `surveys` table schema: `id UUID`, `shortcode VARCHAR`. No migration is needed. |

---

## 2. Exact Changes Per File

### 2.1 `exodus/types/types.go`

#### Change A: Add `"surveyid"` case to `SimpleCondition.Validate()`

Location: line 205, immediately before the `default:` case.

Current code at lines 197–207:
```go
	case "question_response":
		if sc.Form == nil || *sc.Form == "" {
			return fmt.Errorf("question_response condition requires 'form' field")
		}
		if sc.QuestionRef == nil || *sc.QuestionRef == "" {
			return fmt.Errorf("question_response condition requires 'question_ref' field")
		}
		// response is optional — no check needed
	default:
		return fmt.Errorf("invalid condition type: %s (must be form, state, error_code, current_question, elapsed_time, or question_response)", sc.Type)
	}
```

Replace with:
```go
	case "question_response":
		if sc.Form == nil || *sc.Form == "" {
			return fmt.Errorf("question_response condition requires 'form' field")
		}
		if sc.QuestionRef == nil || *sc.QuestionRef == "" {
			return fmt.Errorf("question_response condition requires 'question_ref' field")
		}
		// response is optional — no check needed
	case "surveyid":
		if sc.Value == nil || *sc.Value == "" {
			return fmt.Errorf("value is required for surveyid condition")
		}
	default:
		return fmt.Errorf("invalid condition type: %s (must be form, state, error_code, current_question, elapsed_time, question_response, or surveyid)", sc.Type)
	}
```

**Notes on validation depth:**

The `value` field for `surveyid` holds a UUID string (e.g., `"550e8400-e29b-41d4-a716-446655440000"`). The plan deliberately does NOT add UUID format validation. Reasons:
1. None of the other simple condition types validate format — `form` and `state` accept any non-nil string. Consistency matters.
2. CockroachDB will return a clear error at query time if the string is not a valid UUID (`invalid UUID`). The error propagates back to the API caller.
3. Adding a UUID regex or `uuid.Parse()` call would be the only place in the types package that validates semantic content rather than structural presence. This can be added later if desired.

If UUID validation is wanted in the future, import `github.com/google/uuid` (already imported in `types.go` at line 8) and add:
```go
case "surveyid":
    if sc.Value == nil || *sc.Value == "" {
        return fmt.Errorf("value is required for surveyid condition")
    }
    if _, err := uuid.Parse(*sc.Value); err != nil {
        return fmt.Errorf("value must be a valid UUID for surveyid condition: %w", err)
    }
```

#### Change B: `containsCTECondition()` — No change needed

The current implementation at lines 241–254:
```go
func containsCTECondition(c *Condition) bool {
	if c.IsSimple() {
		t := c.GetSimple().Type
		return t == "elapsed_time" || t == "question_response"
	}
	...
}
```

`surveyid` does NOT use a CTE (it is a subquery in the WHERE clause, not a JOIN against a CTE). Do NOT add `"surveyid"` to this function. The `not` operator will be allowed to wrap `surveyid`, which is the correct behavior.

---

### 2.2 `exodus/query/builder.go`

#### Change A: Add a case to `buildSimpleCondition()`

Location: lines 89–106. Add the new case immediately before the `default:` case.

Current code at lines 99–105:
```go
	case "elapsed_time":
		return qb.buildElapsedTimeCondition(cond)
	case "question_response":
		return qb.buildQuestionResponseCondition(cond)
	default:
		return "", fmt.Errorf("unsupported condition type: %s", cond.Type)
	}
```

Replace with:
```go
	case "elapsed_time":
		return qb.buildElapsedTimeCondition(cond)
	case "question_response":
		return qb.buildQuestionResponseCondition(cond)
	case "surveyid":
		return qb.buildSurveyIDCondition(cond)
	default:
		return "", fmt.Errorf("unsupported condition type: %s", cond.Type)
	}
```

#### Change B: Add `buildSurveyIDCondition()` function

Location: add after `buildQuestionResponseCondition()`, which ends at line 240. Add the new function starting at line 242.

```go
// buildSurveyIDCondition matches users whose current form belongs to a specific survey UUID.
// It uses a subquery against the surveys table to map the survey UUID to one or more shortcodes,
// then checks whether states.current_form is one of those shortcodes.
// A survey UUID can map to multiple shortcodes (one per published version), so IN is correct.
func (qb *QueryBuilder) buildSurveyIDCondition(cond *types.SimpleCondition) (string, error) {
	if cond.Value == nil || *cond.Value == "" {
		return "", fmt.Errorf("value is required for surveyid condition")
	}

	paramNum := qb.addParam(*cond.Value)
	return fmt.Sprintf("s.current_form IN (SELECT shortcode FROM surveys WHERE id = $%d)", paramNum), nil
}
```

**SQL semantics confirmed:**

- `surveys.id` is of type `UUID` (confirmed in `devops/migrations/01-init.sql` line 45).
- `surveys.shortcode` is of type `VARCHAR` (line 50).
- `states.current_form` is computed as `state_json->'forms'->>-1` — a VARCHAR.
- The parameter `$N` is passed as a Go `string`. CockroachDB performs an implicit cast from `string` to `UUID` for the comparison `id = $N`. This is the standard behaviour and works correctly.
- The subquery `SELECT shortcode FROM surveys WHERE id = $N` may return 0, 1, or multiple rows (if a survey UUID was published multiple times under different shortcodes, which is unusual but schema-permitted). The `IN` operator handles all cases correctly.
- Using a subquery in the `WHERE` clause rather than a JOIN keeps the query structure consistent with how the other simple conditions work (all simple conditions are WHERE predicates; only CTE-based conditions introduce JOINs).
- `qb.cteIndex` is NOT incremented — this condition does not use CTEs.

**Table qualification:**

Use unqualified `surveys` (not `chatroach.surveys`). This matches the convention already used in `builder.go` for `states` and `responses`. The database connection uses the `chatroach` schema by default, so unqualified table names resolve correctly.

---

### 2.3 `exodus/types/types_test.go`

Add two new table-driven test cases to `TestSimpleConditionValidation` (starting at line 462).

The existing test slice ends at line 490. Append these entries inside the `tests` slice before the closing `}`:

```go
		{
			name:    "valid surveyid with UUID value",
			jsonStr: `{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}`,
			wantErr: false,
		},
		{
			name:    "invalid surveyid missing value",
			jsonStr: `{"type": "surveyid"}`,
			wantErr: true,
			errMsg:  "value is required for surveyid condition",
		},
		{
			name:    "invalid surveyid empty value",
			jsonStr: `{"type": "surveyid", "value": ""}`,
			wantErr: true,
			errMsg:  "value is required for surveyid condition",
		},
```

Add one new table-driven test case to `TestNotOperatorValidation` (starting at line 513).

The existing test slice ends before line 558. Append this entry inside the `tests` slice before the closing `}`. This test confirms that `surveyid` is NOT blocked by `containsCTECondition` and therefore IS allowed inside `not`:

```go
		{
			name:    "valid not wrapping surveyid",
			jsonStr: `{"op": "not", "vars": [{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}]}`,
			wantErr: false,
		},
```

---

### 2.4 `exodus/query/builder_test.go`

Add three new top-level test functions after `TestBuildQuery_QuestionResponseWithoutResponse` (which ends at line 714).

#### Test 1: Basic `surveyid` query

```go
func TestBuildQuery_SurveyIDCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}`),
		Execution:  types.Execution{Timing: "immediate"},
		Action:     types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	// Must be a simple WHERE subquery — no CTEs, no JOINs beyond the base FROM
	if strings.Contains(sql, "WITH ") {
		t.Errorf("SQL should not have CTEs for surveyid condition, got: %s", sql)
	}
	if strings.Contains(sql, "JOIN ") {
		t.Errorf("SQL should not have JOINs for surveyid condition, got: %s", sql)
	}
	if !strings.Contains(sql, "s.current_form IN (SELECT shortcode FROM surveys WHERE id = $1)") {
		t.Errorf("SQL missing surveyid subquery, got: %s", sql)
	}
	if !strings.Contains(sql, "FROM states s") {
		t.Error("SQL missing FROM states s")
	}

	// Exactly one parameter: the survey UUID
	if len(params) != 1 {
		t.Fatalf("Expected 1 parameter, got %d", len(params))
	}
	if params[0] != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("Expected params[0]='550e8400-e29b-41d4-a716-446655440000', got %v", params[0])
	}
}
```

#### Test 2: `surveyid` wrapped in NOT

```go
func TestBuildQuery_SurveyIDWithNOT(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "not",
			"vars": [{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}]
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed (NOT wrapping surveyid should be allowed): %v", err)
	}

	if !strings.Contains(sql, "NOT (s.current_form IN (SELECT shortcode FROM surveys WHERE id = $1))") {
		t.Errorf("SQL missing NOT-wrapped surveyid subquery, got: %s", sql)
	}
	if len(params) != 1 || params[0] != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("Incorrect parameters: %v", params)
	}
}
```

#### Test 3: `surveyid` combined with AND

```go
func TestBuildQuery_SurveyIDInsideAND(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "and",
			"vars": [
				{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"},
				{"type": "state", "value": "WAIT_EXTERNAL_EVENT"}
			]
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	// $1 = survey UUID (surveyid processed first), $2 = state value
	if !strings.Contains(sql, "s.current_form IN (SELECT shortcode FROM surveys WHERE id = $1)") {
		t.Errorf("SQL missing surveyid condition, got: %s", sql)
	}
	if !strings.Contains(sql, "s.current_state = $2") {
		t.Errorf("SQL missing state condition, got: %s", sql)
	}
	if !strings.Contains(sql, " AND ") {
		t.Error("SQL missing AND operator")
	}

	if len(params) != 2 {
		t.Fatalf("Expected 2 parameters, got %d", len(params))
	}
	if params[0] != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("Expected params[0]='550e8400-...', got %v", params[0])
	}
	if params[1] != "WAIT_EXTERNAL_EVENT" {
		t.Errorf("Expected params[1]='WAIT_EXTERNAL_EVENT', got %v", params[1])
	}
}
```

---

### 2.5 `dashboard-client/src/components/ConditionBuilder/ConditionBuilder.js`

Three locations require changes.

#### Change A: `CONDITION_TYPES` object (lines 23–30)

Current code:
```js
const CONDITION_TYPES = {
  form: { label: 'Form' },
  state: { label: 'State' },
  error_code: { label: 'Error Code' },
  current_question: { label: 'Current Question' },
  elapsed_time: { label: 'Elapsed Time' },
  question_response: { label: 'Question Response' },
};
```

Replace with:
```js
const CONDITION_TYPES = {
  form: { label: 'Form' },
  state: { label: 'State' },
  error_code: { label: 'Error Code' },
  current_question: { label: 'Current Question' },
  elapsed_time: { label: 'Elapsed Time' },
  question_response: { label: 'Question Response' },
  surveyid: { label: 'Survey ID' },
};
```

The label `'Survey ID'` will appear in the dropdown. It matches the visual style of existing entries (title-case, human-readable).

#### Change B: `handleTypeChange` (lines 45–65)

The function initialises default state for the new type when the user switches to it. Currently ends at line 64 before `onChange(newCondition)`.

Current code at lines 58–64:
```js
    } else if (newType === 'question_response') {
      newCondition.form = '';
      newCondition.question_ref = '';
      // response intentionally not set — absence means "is answered" mode
    }
    onChange(newCondition);
```

Replace with:
```js
    } else if (newType === 'question_response') {
      newCondition.form = '';
      newCondition.question_ref = '';
      // response intentionally not set — absence means "is answered" mode
    } else if (newType === 'surveyid') {
      newCondition.value = '';
    }
    onChange(newCondition);
```

The `value` field is set to an empty string so the input renders with a controlled empty state rather than `undefined`.

#### Change C: JSX render block (after line 210, inside the `<Space direction="vertical">`)

The existing `question_response` render block ends at line 210. Add the new block immediately after it, before the closing `</Space>`:

```jsx
        {(type === 'surveyid') && (
          <Input
            placeholder="Survey UUID (e.g., 550e8400-e29b-41d4-a716-446655440000)"
            value={condition.value || ''}
            onChange={(e) => handleFieldChange('value', e.target.value)}
            addonBefore="Survey ID"
          />
        )}
```

**Design decision — text input rather than a survey dropdown:**

A dropdown of surveys would require fetching the user's surveys via an API call from inside `ConditionBuilder.js`. The component currently has no such data-fetching. All other `value`-based types (`form`, `error_code`, `current_question`) use plain text inputs. Keeping the same pattern (plain text input) means:

- No new API dependencies or props needed for the component.
- The user pastes a UUID from the survey management page.
- The UUID is validated structurally at save time by the Go backend.

If a dropdown is desired in the future, the implementer will need to pass a `surveys` prop into `ConditionBuilder` or add a `useEffect` fetch inside the component. That is out of scope for this change.

---

## 3. Test Strategy

### Existing tests to run after making changes

Run from the `exodus/` directory:

```bash
go test ./types/...
go test ./query/...
go test ./...
```

The following existing tests must continue to pass without modification:

**`types_test.go`:**
- `TestSimpleConditionMarshalUnmarshal` — covers `form`, `state`, `error_code`
- `TestSimpleConditionValidation` — existing cases for `question_response`
- `TestNotOperatorValidation` — existing cases confirming `elapsed_time` and `question_response` are blocked under NOT

**`builder_test.go`:**
- All `TestBuildQuery_*` tests — none of them should change behaviour
- `TestValidateDuration` — unchanged
- `TestSQLInjectionPrevention` — must still pass; the new builder follows the same parameterized pattern

### New tests added (summary)

| Test file | Test name | What it verifies |
|-----------|-----------|-----------------|
| `types_test.go` | `"valid surveyid with UUID value"` (table case) | Non-nil value string is accepted |
| `types_test.go` | `"invalid surveyid missing value"` (table case) | Nil value field errors correctly |
| `types_test.go` | `"invalid surveyid empty value"` (table case) | Empty string value errors correctly |
| `types_test.go` | `"valid not wrapping surveyid"` (table case) | NOT + surveyid passes `containsCTECondition` check |
| `builder_test.go` | `TestBuildQuery_SurveyIDCondition` | SQL fragment and single param are correct |
| `builder_test.go` | `TestBuildQuery_SurveyIDWithNOT` | NOT wrapping produces `NOT (s.current_form IN (...))` |
| `builder_test.go` | `TestBuildQuery_SurveyIDInsideAND` | surveyid in AND with state; param ordering correct |

---

## 4. Acceptance Criteria

The implementation is complete when all of the following hold:

1. **Validation accepts valid input.** A condition `{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}` passes `SimpleCondition.Validate()` without error.

2. **Validation rejects missing value.** A condition `{"type": "surveyid"}` returns an error containing `"value is required for surveyid condition"`.

3. **Validation rejects empty value.** A condition `{"type": "surveyid", "value": ""}` returns an error containing `"value is required for surveyid condition"`.

4. **Error message lists `surveyid`.** When an unknown condition type is submitted, the error message includes `surveyid` in the list of valid types.

5. **SQL is a parameterized subquery.** `BuildQuery` for a `surveyid` condition produces SQL containing `s.current_form IN (SELECT shortcode FROM surveys WHERE id = $1)` and `params[0]` equals the UUID string.

6. **No CTEs or extra JOINs.** The generated SQL does NOT contain a `WITH` clause or a `JOIN` clause for the `surveyid` condition.

7. **NOT is allowed.** A `{"op": "not", "vars": [{"type": "surveyid", "value": "..."}]}` condition passes `Validate()` and produces `NOT (s.current_form IN (...))` in the SQL.

8. **AND combination is correct.** When `surveyid` is ANDed with other simple conditions, parameters are numbered sequentially and the SQL contains both predicates joined with `AND`.

9. **All existing tests pass.** No regressions in `go test ./...` output.

10. **Frontend dropdown shows "Survey ID".** After the change, the condition type selector in the bail editor includes a "Survey ID" option that renders a text input labelled "Survey ID" when selected.

11. **Frontend state initialises cleanly.** Switching to `surveyid` type resets the condition to `{type: "surveyid", value: ""}` — no leftover fields from a previous type.

---

## 5. No Migration Required

The `surveys` table already exists with the required `id` (UUID) and `shortcode` (VARCHAR) columns, defined in `devops/migrations/01-init.sql` lines 44–59. No new database migration is needed for this feature.

---

## 6. Files Changed Summary

| File | Lines affected | Nature of change |
|------|---------------|-----------------|
| `exodus/types/types.go` | ~205–206 | Add 1 case + update error string |
| `exodus/query/builder.go` | ~101–102, ~241–252 | Add 1 case to switch + 1 new function |
| `exodus/types/types_test.go` | ~490 (table append), ~558 (table append) | Add 4 table-driven test cases |
| `exodus/query/builder_test.go` | ~715+ (append) | Add 3 new test functions |
| `dashboard-client/src/components/ConditionBuilder/ConditionBuilder.js` | ~23–30, ~58–64, ~210+ | Add entry to dict, add branch to handleTypeChange, add JSX block |
