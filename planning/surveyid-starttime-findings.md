# Bail Condition Types: surveyid and start_time Implementation Findings

**Date**: 2026-02-22
**Scope**: How to add `surveyid` and `start_time` condition types to the exodus bail system.

---

## 1. Current Condition Type Patterns

### Pattern A: Simple Conditions (Direct Column Match)

Simple conditions translate to a single SQL predicate against the `states` table alias `s`. No CTEs, no JOINs.

| Type | Required Fields in SimpleCondition | SQL Generated |
|------|------------------------------------|---------------|
| `form` | `value` | `s.current_form = $N` |
| `state` | `value` | `s.current_state = $N` |
| `error_code` | `value` | `s.state_json->'error'->>'code' = $N` |
| `current_question` | `value` | `s.state_json->>'question' = $N` |

All four use the `value` field of `SimpleCondition`. The field name in JSON is always `"value"`.

### Pattern B: CTE-Based Conditions (External Table Join)

CTE conditions join against a second table (`responses`) and generate a CTE block in the `WITH` clause plus a `JOIN` in the main query.

**`elapsed_time`** — joins `responses` and compares timestamps:
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
WHERE rt0.response_time + $3::INTERVAL < NOW()
```
Parameters: `[form_shortcode, question_ref, duration_string]`

Required fields: `since.event = "response"`, `since.details.form`, `since.details.question_ref`, `duration` (PostgreSQL interval string).

**`question_response`** — joins `responses` and checks for existence:
```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2 [AND response = $3]
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid
WHERE qr0.userid IS NOT NULL
```
Required fields: `form`, `question_ref`. Optional: `response` (absent = any answer).

### Key Architectural Constraint: NOT + CTE

CTE-based conditions (both `elapsed_time` and `question_response`) use INNER JOIN. This means the CTE cannot express "users who did NOT answer this question" -- it would require `LEFT JOIN ... IS NULL` semantics. This is why the `not` operator explicitly rejects wrapping these types:

- `types.go:231`: `containsCTECondition()` walks the tree recursively and rejects NOT if it finds `elapsed_time` or `question_response` anywhere.
- Any new CTE-based condition type must be added to `containsCTECondition()` as well.

---

## 2. Complete File Inventory: Where to Change

### exodus/types/types.go

```
Line 86-96:   SimpleCondition struct — fields for all types
Line 169-209: SimpleCondition.Validate() — switch/case for each type
Line 206:     Error message listing valid types (must update)
Line 240-253: containsCTECondition() — lists CTE-based types (must update if new type is CTE-based)
```

### exodus/query/builder.go

```
Line 89-106:  buildSimpleCondition() switch/case — routes to type-specific builders
Line 108-145: Four simple condition builders
Line 148-239: Two CTE condition builders
```

### dashboard-client/src/components/ConditionBuilder/ConditionBuilder.js

```
Line 23-30:  CONDITION_TYPES dict — add entry here to show in dropdown
Line 44-65:  handleTypeChange() — add case for new type's default state
Line 93-210: JSX rendering — add new <> block for type-specific fields
```

---

## 3. Database Schema: What Columns Are Available

### `states` Table Columns (complete list from migrations)

Source: `devops/migrations/01-init.sql` (lines 109-162) plus later migrations.

**Native columns:**
| Column | Type | Notes |
|--------|------|-------|
| `userid` | VARCHAR | PK component, Facebook PSID |
| `pageid` | VARCHAR | PK component, **Facebook page ID** — NOT a survey UUID |
| `updated` | TIMESTAMPTZ | Last write time to this row |
| `current_state` | VARCHAR | Machine state string |
| `state_json` | JSON | Full state blob |

**Computed columns (stored):**
| Column | Type | Source expression |
|--------|------|-------------------|
| `current_form` | VARCHAR | `state_json->'forms'->>-1` |
| `form_start_time` | TIMESTAMPTZ | `CEILING((state_json->'md'->>'startTime')::INT/1000)::INT::TIMESTAMPTZ` |
| `error_tag` | VARCHAR | `state_json->'error'->>'tag'` |
| `fb_error_code` | VARCHAR | `state_json->'error'->>'code'` |
| `stuck_on_question` | VARCHAR | Based on last 3 entries of `state_json->'qa'` |
| `timeout_date` | TIMESTAMPTZ | `state_json->'wait'` timeout calculation |
| `next_retry` | TIMESTAMP | Exponential backoff calculation |
| `payment_error_code` | VARCHAR | `state_json->'md'->>'e_payment_reloadly_error_code'` |
| `previous_is_followup` | BOOL | `state_json->'previousOutput'->>'followUp'` |
| `previous_with_token` | BOOL | `state_json->'previousOutput'->>'token'` |
| `message_pointer` | TIMESTAMPTZ | Added in migration 04 |

**Critical observation**: There is NO `survey_id` or `surveyid` column on the `states` table. The `pageid` column is the Facebook page ID (e.g., a numeric string like `"123456789"`), not a survey UUID.

### `surveys` Table (for surveyid lookups)

Relevant columns:
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Survey UUID (this is the `surveyid`) |
| `shortcode` | VARCHAR | The form shortcode (maps to `states.current_form`) |
| `userid` | UUID | Owner user |
| `survey_name` | VARCHAR | Logical survey grouping name |

The link from `states` to a survey is indirect:
```
states.current_form (shortcode) -> surveys.shortcode -> surveys.id (surveyid)
```

### `responses` Table (for CTE-based lookups)

Relevant columns for new condition types:
| Column | Type | Notes |
|--------|------|-------|
| `userid` | VARCHAR | Facebook PSID |
| `surveyid` | UUID | The UUID of the specific survey version |
| `shortcode` | VARCHAR | The form shortcode |
| `timestamp` | TIMESTAMPTZ | When the response was submitted |
| `pageid` | VARCHAR | Facebook page ID |

The `responses` table has `surveyid` as a UUID referencing `surveys.id`. This is the most direct source for a surveyid-based condition.

---

## 4. Recommendations: How to Implement `surveyid` and `start_time`

### 4.1 `surveyid` Condition

**What it means**: Match users whose current form (`states.current_form`) is a shortcode belonging to a specific survey (identified by UUID). This is useful to bail all users currently on any version of a specific named survey, regardless of which shortcode they're on.

**Two possible mappings:**

**Option A: Join through `surveys` table (JOIN-based, no CTE needed)**

```sql
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN surveys sv ON sv.shortcode = s.current_form AND sv.id = $1
WHERE ...
```

- Pro: Direct UUID equality, no CTE overhead.
- Con: Requires a JOIN against `surveys`, which is a new pattern for the query builder. Currently only `states` and `responses` are queried.
- Con: A shortcode can have multiple survey versions (different UUIDs). `current_form` is the shortcode, not the UUID. This JOIN would match any row in `surveys` with that shortcode AND that specific UUID — which is correct.

**Option B: Via `responses` table (CTE-based)**

```sql
WITH survey_users_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE surveyid = $1
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN survey_users_0 su0 ON s.userid = su0.userid
WHERE su0.userid IS NOT NULL
```

- Pro: Consistent with existing CTE pattern.
- Con: Matches users who HAVE EVER responded in that survey, not necessarily currently on it. This is a different semantic.
- Con: `surveyid` in `responses` is a UUID type; the parameter would need to be a UUID string.

**Recommendation**: Option A (JOIN against `surveys`) is the correct semantic for "users currently on this survey". The `surveyid` in the condition maps to `surveys.id`, and the JOIN filters `states.current_form` to shortcodes that belong to that survey UUID.

**JSON format for new condition:**
```json
{"type": "surveyid", "value": "uuid-of-the-survey"}
```

Fields needed in `SimpleCondition`: already has `Value *string`. Use `value` field for the UUID string.

**SQL pattern:**
```sql
s.current_form IN (SELECT shortcode FROM surveys WHERE id = $N)
```

Or with a JOIN:
```sql
EXISTS (SELECT 1 FROM surveys sv WHERE sv.shortcode = s.current_form AND sv.id = $N)
```

The subquery approach is simplest and matches the existing pattern of not introducing new JOIN clauses in the main FROM clause (the CTE-based types use JOIN but they join CTEs, not the base tables directly in the FROM clause). Using a subquery in WHERE keeps the query structure clean.

**Implementation classification**: Simple condition pattern (subquery in WHERE clause, no CTE needed). The `value` field holds the survey UUID string.

**NOT compatibility**: This is a simple equality-based condition (subquery in WHERE), so NOT wrapping is safe. It should NOT be added to `containsCTECondition()`.

### 4.2 `start_time` Condition

**What it means**: Match users based on when they started their current form. `form_start_time` is a stored computed column already on `states`.

**Database column**: `states.form_start_time` (TIMESTAMPTZ). Defined as:
```sql
form_start_time TIMESTAMPTZ AS (CEILING((state_json->'md'->>'startTime')::INT/1000)::INT::TIMESTAMPTZ) STORED
```

This is the epoch millisecond timestamp from `state_json.md.startTime`, converted to TIMESTAMPTZ.

**Condition semantics options:**

- "Started more than N [time unit] ago": `s.form_start_time + $duration::INTERVAL < NOW()`
- "Started before a specific datetime": `s.form_start_time < $datetime`
- "Started after a specific datetime": `s.form_start_time > $datetime`

The most useful for bail logic is "started more than N time ago" (parallel to `elapsed_time`), since bails are typically time-based recovery operations.

**JSON format for new condition (duration-based):**
```json
{"type": "start_time", "duration": "4 weeks"}
```

The `duration` field is already in `SimpleCondition` struct and validated by `validateDuration()` in the query builder.

**SQL pattern:**
```sql
s.form_start_time + $N::INTERVAL < NOW()
```

Or as "started before N ago":
```sql
s.form_start_time < NOW() - $N::INTERVAL
```

Both are semantically equivalent. The first is consistent with the `elapsed_time` pattern.

**Implementation classification**: Simple condition pattern (direct column comparison, no CTE needed). Uses `duration` field of `SimpleCondition`.

**NOT compatibility**: Safe for NOT wrapping. It is a direct column comparison. Should NOT be added to `containsCTECondition()`.

**Validation**: `duration` must pass `validateDuration()` (already exists). No `since` field needed since the reference event is always "form start" (implicit in the condition type name).

---

## 5. Implementation Checklist

### exodus/types/types.go changes

1. **`SimpleCondition.Validate()` switch (line 169)**: Add two new cases:
   ```go
   case "surveyid":
       if sc.Value == nil {
           return fmt.Errorf("value is required for surveyid condition")
       }
   case "start_time":
       if sc.Duration == nil {
           return fmt.Errorf("duration is required for start_time condition")
       }
   ```

2. **Error message (line 206)**: Update to include `surveyid` and `start_time` in the valid types list.

3. **`containsCTECondition()` (line 240)**: No change needed — neither new type uses CTEs.

### exodus/query/builder.go changes

1. **`buildSimpleCondition()` switch (line 90)**: Add two new cases:
   ```go
   case "surveyid":
       return qb.buildSurveyIDCondition(cond)
   case "start_time":
       return qb.buildStartTimeCondition(cond)
   ```

2. **New builder functions**:

   ```go
   // buildSurveyIDCondition matches users currently on a form belonging to a specific survey UUID.
   // Uses a subquery against the surveys table to map survey UUID to shortcode(s).
   func (qb *QueryBuilder) buildSurveyIDCondition(cond *types.SimpleCondition) (string, error) {
       if cond.Value == nil {
           return "", fmt.Errorf("value is required for surveyid condition")
       }
       paramNum := qb.addParam(*cond.Value)
       return fmt.Sprintf("s.current_form IN (SELECT shortcode FROM chatroach.surveys WHERE id = $%d)", paramNum), nil
   }

   // buildStartTimeCondition matches users whose form_start_time was more than duration ago.
   func (qb *QueryBuilder) buildStartTimeCondition(cond *types.SimpleCondition) (string, error) {
       if cond.Duration == nil {
           return "", fmt.Errorf("duration is required for start_time condition")
       }
       if err := validateDuration(*cond.Duration); err != nil {
           return "", fmt.Errorf("invalid duration: %w", err)
       }
       paramNum := qb.addParam(*cond.Duration)
       return fmt.Sprintf("s.form_start_time + $%d::INTERVAL < NOW()", paramNum), nil
   }
   ```

### dashboard-client/src/components/ConditionBuilder/ConditionBuilder.js changes

1. **`CONDITION_TYPES` dict (line 23)**: Add entries:
   ```js
   const CONDITION_TYPES = {
     form: { label: 'Form' },
     state: { label: 'State' },
     error_code: { label: 'Error Code' },
     current_question: { label: 'Current Question' },
     elapsed_time: { label: 'Elapsed Time' },
     question_response: { label: 'Question Response' },
     surveyid: { label: 'Survey ID' },        // NEW
     start_time: { label: 'Start Time' },     // NEW
   };
   ```

2. **`handleTypeChange()` (line 48)**: Add reset logic:
   ```js
   } else if (newType === 'surveyid') {
     newCondition.value = '';
   } else if (newType === 'start_time') {
     newCondition.duration = '1 week';
   }
   ```

3. **JSX rendering (after the `question_response` block)**: Add render blocks:
   ```jsx
   {(type === 'surveyid') && (
     <Input
       placeholder="Survey UUID (e.g., 550e8400-e29b-41d4-a716-446655440000)"
       value={condition.value || ''}
       onChange={(e) => handleFieldChange('value', e.target.value)}
       addonBefore="Survey ID"
     />
   )}

   {(type === 'start_time') && (
     <Input
       placeholder="e.g., 4 weeks, 30 days"
       value={condition.duration || ''}
       onChange={(e) => handleFieldChange('duration', e.target.value)}
       addonBefore="Started More Than"
     />
   )}
   ```

---

## 6. Constraints and Gotchas

### `pageid` is not a survey ID

The `states.pageid` column is the Facebook page ID (a numeric string), not a survey UUID. Do not confuse it with the survey concept. The survey UUID is in `surveys.id`, accessed via `surveys.shortcode = states.current_form`.

### `form_start_time` can be NULL

`form_start_time` is derived from `state_json->'md'->>'startTime'`. If a user's state was created by an unusual code path that doesn't set `md.startTime`, this column will be NULL. A `start_time` condition using `form_start_time + interval < NOW()` will evaluate to NULL (not TRUE) for those users, which means they won't match — correct behavior, but worth documenting.

### Schema qualification discrepancy in query builder

There is an existing inconsistency between the two query sources:
- `db/bails.go` uses `chatroach.bails`, `chatroach.bail_events` (schema-qualified)
- `query/builder.go` uses unqualified `states` and `responses` in all generated SQL

The unqualified names work because the connection string connects to the `chatroach` database (env: `CHATBASE_DATABASE`, default `"chatroach"`), and CockroachDB sets the search_path to the database name by default.

**For the new `surveyid` condition**: use unqualified `surveys` in the subquery, matching the existing convention in `query/builder.go`. Do NOT add `chatroach.` prefix — this would be inconsistent with how `states` and `responses` are referenced in the same file.

### `surveyid` type uses UUID input

The `value` field for `surveyid` is a string containing a UUID. The query passes it as a string parameter (`$N`), and CockroachDB will cast it to UUID when comparing with `surveys.id` (which is UUID type). This implicit cast works fine in PostgreSQL/CockroachDB. If strictness is required, add a `::UUID` cast: `WHERE id = $N::UUID`.

### NOT wrapping: both new types are safe

Unlike `elapsed_time` and `question_response`, the new types do not use INNER JOINs to the responses table. They use WHERE subqueries or direct column comparisons, which can be safely negated with NOT. No changes to `containsCTECondition()` are needed.

### Multiple CTEs and CTE index

Both new types are NOT CTE-based, so `qb.cteIndex` is not involved. The `cteIndex` only increments for `elapsed_time` and `question_response` builders.

### Duration validation for `start_time`

The existing `validateDuration()` regex in `query/builder.go` (line 294-304) accepts:
```
^\d+\s+(microseconds?|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)$
```
This covers all common cases. The same validation should be called for `start_time`'s duration field. Note: decimals like "4.5 weeks" are rejected by this regex — consistent with `elapsed_time` behavior.

---

## 7. Test Additions Needed

### exodus/query/builder_test.go

```go
func TestBuildQuery_SurveyIDCondition(t *testing.T) {
    // Verify: s.current_form IN (SELECT shortcode FROM surveys WHERE id = $1)
    // params: [$survey_uuid]
}

func TestBuildQuery_StartTimeCondition(t *testing.T) {
    // Verify: s.form_start_time + $1::INTERVAL < NOW()
    // params: [$duration]
}

func TestBuildQuery_StartTimeInvalidDuration(t *testing.T) {
    // Verify: error returned for "4.5 weeks" or "fouryears"
}

func TestBuildQuery_SurveyIDWithNOT(t *testing.T) {
    // Verify: NOT wrapping surveyid is allowed (no error from containsCTECondition)
    // SQL: NOT (s.current_form IN (SELECT shortcode FROM surveys WHERE id = $1))
}
```

### exodus/types/types_test.go

```go
// In TestSimpleConditionValidation:
{name: "valid surveyid", jsonStr: `{"type": "surveyid", "value": "some-uuid"}`, wantErr: false}
{name: "invalid surveyid missing value", jsonStr: `{"type": "surveyid"}`, wantErr: true}
{name: "valid start_time", jsonStr: `{"type": "start_time", "duration": "4 weeks"}`, wantErr: false}
{name: "invalid start_time missing duration", jsonStr: `{"type": "start_time"}`, wantErr: true}
```

---

## 8. Summary of Findings

| Aspect | Finding |
|--------|---------|
| `surveyid` database column | Not on `states` table. Must JOIN or subquery `surveys` table via `shortcode = current_form` |
| `start_time` database column | `states.form_start_time` (stored computed column) — already available, no new migration needed |
| `surveyid` implementation pattern | Simple condition with WHERE subquery: `s.current_form IN (SELECT shortcode FROM surveys WHERE id = $N)` |
| `start_time` implementation pattern | Simple condition with direct column: `s.form_start_time + $N::INTERVAL < NOW()` |
| Both types: NOT wrapping | Safe — neither uses INNER JOIN CTEs |
| Both types: migration needed | No — `form_start_time` is already a stored computed column; `surveys` table already exists |
| Frontend changes needed | `CONDITION_TYPES` dict + `handleTypeChange()` reset + JSX render blocks |
| Backend files to change | `types/types.go` (validate) + `query/builder.go` (build) — exactly 2 files |

---

## 9. Files Involved

| File | Location | Change Type |
|------|----------|-------------|
| `exodus/types/types.go` | Lines 169-209, 206, 240-253 | Add 2 new cases to `Validate()`, update error message |
| `exodus/query/builder.go` | Lines 90-106, new functions after line 239 | Add 2 cases to switch, add 2 builder functions |
| `exodus/types/types_test.go` | `TestSimpleConditionValidation` and `TestNotOperatorValidation` | Add test cases for new types |
| `exodus/query/builder_test.go` | After `TestBuildQuery_QuestionResponseWithoutResponse` | Add 4 new test functions |
| `dashboard-client/src/components/ConditionBuilder/ConditionBuilder.js` | Lines 23-30, 44-65, 93-210 | Update `CONDITION_TYPES`, `handleTypeChange`, JSX blocks |

No database migrations are needed. No new dependencies are needed.
