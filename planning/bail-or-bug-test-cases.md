# Bail System OR Logic Bug - Test Cases & Examples

**Purpose:** Concrete examples demonstrating the bug and what correct behavior should be.

---

## Test Case 1: Simple OR with Two question_response Conditions

### Condition Definition

```json
{
  "op": "or",
  "vars": [
    {
      "type": "question_response",
      "form": "intake_survey",
      "question_ref": "consent_question",
      "response": "Yes"
    },
    {
      "type": "question_response",
      "form": "intake_survey",
      "question_ref": "consent_question",
      "response": "No"
    }
  ]
}
```

### Intent

Bail users who answered the consent question at all (either "Yes" or "No").

### Database State

Assume `responses` table has:
```
userid   | question_ref      | response
---------|------------------|----------
user1    | consent_question  | Yes
user2    | consent_question  | No
user3    | other_question    | Maybe
user4    | consent_question  | Maybe
```

### Expected Result

**Users bailed:** user1, user2, user4

**Reasoning:** All users who answered `consent_question` (any value)

### Current Broken Result

**Users bailed:** (none)

**Reasoning:** Query looks for users who answered q with "Yes" AND with "No" simultaneously (impossible)

---

## Test Case 2: OR with Different question_response Questions

### Condition Definition

```json
{
  "op": "or",
  "vars": [
    {
      "type": "question_response",
      "form": "survey_a",
      "question_ref": "q1",
      "response": "option1"
    },
    {
      "type": "question_response",
      "form": "survey_a",
      "question_ref": "q2",
      "response": "option2"
    }
  ]
}
```

### Intent

Bail users who answered q1 with "option1" OR q2 with "option2" (or both).

### Database State

```
userid   | question_ref  | response
---------|---------------|----------
user1    | q1            | option1
user2    | q2            | option2
user3    | q1            | other
user4    | q2            | other
user5    | q1            | option1
user5    | q2            | option2
```

### Expected Result

**Users bailed:** user1, user2, user5

**Reasoning:**
- user1: answered q1 with option1 ✓
- user2: answered q2 with option2 ✓
- user5: answered both ✓

### Current Broken Result

**Users bailed:** user5 (only)

**Reasoning:** Query requires matching both q1=option1 AND q2=option2 simultaneously. Only user5 did this.

---

## Test Case 3: AND with question_response (Works Correctly)

### Condition Definition

```json
{
  "op": "and",
  "vars": [
    {
      "type": "question_response",
      "form": "survey_a",
      "question_ref": "q1",
      "response": "option1"
    },
    {
      "type": "question_response",
      "form": "survey_a",
      "question_ref": "q2",
      "response": "option2"
    }
  ]
}
```

### Intent

Bail users who answered q1 with "option1" AND q2 with "option2".

### Database State

Same as Test Case 2.

### Expected Result

**Users bailed:** user5

**Reasoning:** Only user5 answered both questions with the specified values.

### Current Result

**Users bailed:** user5 ✓

**Status:** WORKS CORRECTLY

---

## Test Case 4: OR with elapsed_time Conditions

### Condition Definition

```json
{
  "op": "or",
  "vars": [
    {
      "type": "elapsed_time",
      "duration": "2 weeks",
      "since": {
        "event": "response",
        "details": {
          "question_ref": "q1",
          "form": "survey_a"
        }
      }
    },
    {
      "type": "elapsed_time",
      "duration": "4 weeks",
      "since": {
        "event": "response",
        "details": {
          "question_ref": "q2",
          "form": "survey_a"
        }
      }
    }
  ]
}
```

### Intent

Bail users who haven't responded to q1 in 2 weeks OR haven't responded to q2 in 4 weeks.

### Database State (assume current time is 2026-03-22 13:00:00)

```
userid  | question_ref  | timestamp
--------|---------------|--------------------
user1   | q1            | 2026-03-08 13:00:00  (14 days ago)
user2   | q1            | 2026-03-15 13:00:00  (7 days ago)
user3   | q2            | 2026-02-22 13:00:00  (28 days ago)
user4   | q2            | 2026-03-15 13:00:00  (7 days ago)
user5   | q1            | 2026-03-08 13:00:00  (14 days ago)
user5   | q2            | 2026-02-22 13:00:00  (28 days ago)
```

### Expected Result

**Users bailed:** user1, user3, user5

**Reasoning:**
- user1: q1 response 14 days ago ≥ 2 weeks ✓
- user3: q2 response 28 days ago ≥ 4 weeks ✓
- user5: both conditions met ✓

### Current Broken Result

**Users bailed:** user5 (only)

**Reasoning:** Query requires BOTH conditions met (14 days for q1 AND 28 days for q2).

---

## Test Case 5: OR with question_response and elapsed_time Mixed

### Condition Definition

```json
{
  "op": "or",
  "vars": [
    {
      "type": "question_response",
      "form": "survey_a",
      "question_ref": "error_field",
      "response": "ERROR"
    },
    {
      "type": "elapsed_time",
      "duration": "3 days",
      "since": {
        "event": "response",
        "details": {
          "question_ref": "q1",
          "form": "survey_a"
        }
      }
    }
  ]
}
```

### Intent

Bail users who either:
1. Answered error_field with "ERROR", OR
2. Haven't responded to q1 in more than 3 days

### Expected Result

Users matching either condition.

### Current Result

Users matching BOTH conditions (AND semantics).

---

## Test Case 6: Nested OR with question_response (Inside AND)

### Condition Definition

```json
{
  "op": "and",
  "vars": [
    {
      "type": "form",
      "value": "survey_a"
    },
    {
      "op": "or",
      "vars": [
        {
          "type": "question_response",
          "form": "survey_a",
          "question_ref": "q1",
          "response": "yes"
        },
        {
          "type": "question_response",
          "form": "survey_a",
          "question_ref": "q1",
          "response": "no"
        }
      ]
    }
  ]
}
```

### Intent

Bail users who are on survey_a AND answered q1 (with any value).

### Database State

```
userid  | current_form  | question_ref  | response
--------|---------------|---------------|----------
user1   | survey_a      | q1            | yes
user2   | survey_a      | q1            | no
user3   | survey_b      | q1            | yes
user4   | survey_a      | q2            | yes
```

### Expected Result

**Users bailed:** user1, user2

**Reasoning:**
- user1: on survey_a AND answered q1 ✓
- user2: on survey_a AND answered q1 ✓

### Current Broken Result

**Users bailed:** (none)

**Reasoning:** Inner OR broken (requires both responses simultaneously), so outer AND gets empty set.

---

## Test Case 7: OR with Simple (Non-CTE) Conditions (Works Correctly)

### Condition Definition

```json
{
  "op": "or",
  "vars": [
    {
      "type": "form",
      "value": "survey_a"
    },
    {
      "type": "form",
      "value": "survey_b"
    }
  ]
}
```

### Intent

Bail users on either survey_a OR survey_b.

### Expected Result

**Users bailed:** All users on survey_a or survey_b

### Current Result

**Users bailed:** All users on survey_a or survey_b ✓

**Status:** WORKS CORRECTLY (no CTE involved)

---

## SQL Examples

### Current Broken: OR with Two question_response

```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = 'survey_a' AND question_ref = 'q1' AND response = 'yes'
),
question_responses_1 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = 'survey_a' AND question_ref = 'q1' AND response = 'no'
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid
JOIN question_responses_1 qr1 ON s.userid = qr1.userid
WHERE (qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)
LIMIT 100000
```

**Problem:** Both JOINs execute (AND intersection), WHERE clause is ineffective.

### Should Be: OR with Two question_response

```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = 'survey_a' AND question_ref = 'q1' AND response = 'yes'
),
question_responses_1 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = 'survey_a' AND question_ref = 'q1' AND response = 'no'
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
LEFT JOIN question_responses_0 qr0 ON s.userid = qr0.userid
LEFT JOIN question_responses_1 qr1 ON s.userid = qr1.userid
WHERE (qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)
LIMIT 100000
```

**Correct:** LEFT JOINs allow WHERE clause to control inclusion.

---

## Go Test Code

```go
func TestBuildQuery_QuestionResponseWithOR(t *testing.T) {
    def := &types.BailDefinition{
        Conditions: conditionFromJSON(`{
            "op": "or",
            "vars": [
                {"type": "question_response", "form": "myform", "question_ref": "q1", "response": "yes"},
                {"type": "question_response", "form": "myform", "question_ref": "q2", "response": "no"}
            ]
        }`),
        Execution: types.Execution{Timing: "immediate"},
        Action:    types.Action{DestinationForm: "exit-form"},
    }

    sql, params, err := BuildQuery(def)
    if err != nil {
        t.Fatalf("BuildQuery failed: %v", err)
    }

    // EXPECTED: LEFT JOINs for OR with CTEs
    if !strings.Contains(sql, "LEFT JOIN question_responses_0") {
        t.Errorf("SQL should use LEFT JOIN for OR with CTEs, got: %s", sql)
    }
    if !strings.Contains(sql, "LEFT JOIN question_responses_1") {
        t.Errorf("SQL should use LEFT JOIN for OR with CTEs, got: %s", sql)
    }

    // EXPECTED: OR in WHERE clause
    if !strings.Contains(sql, "OR") {
        t.Error("SQL missing OR operator in WHERE clause")
    }

    // Both CTEs must be referenced
    if !strings.Contains(sql, "qr0.userid IS NOT NULL") {
        t.Errorf("SQL missing qr0 check, got: %s", sql)
    }
    if !strings.Contains(sql, "qr1.userid IS NOT NULL") {
        t.Errorf("SQL missing qr1 check, got: %s", sql)
    }

    // Parameters
    if len(params) != 6 {
        t.Fatalf("Expected 6 parameters, got %d", len(params))
    }
}
```

---

## Manual Database Validation

After implementing fix, validate with actual database:

### Setup

```sql
-- Create test responses
INSERT INTO responses (userid, pageid, shortcode, question_ref, response, timestamp)
VALUES
  ('user1', 'page1', 'myform', 'q1', 'yes', NOW() - INTERVAL '1 day'),
  ('user2', 'page1', 'myform', 'q1', 'no', NOW() - INTERVAL '2 days'),
  ('user3', 'page1', 'myform', 'q2', 'maybe', NOW() - INTERVAL '3 days');

-- Create test states
INSERT INTO states (userid, pageid, current_form, current_state)
VALUES
  ('user1', 'page1', 'myform', 'QOUT'),
  ('user2', 'page1', 'myform', 'QOUT'),
  ('user3', 'page1', 'myform', 'QOUT');
```

### Run Generated Query

```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid FROM responses
    WHERE shortcode = 'myform' AND question_ref = 'q1' AND response = 'yes'
),
question_responses_1 AS (
    SELECT DISTINCT userid FROM responses
    WHERE shortcode = 'myform' AND question_ref = 'q1' AND response = 'no'
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
LEFT JOIN question_responses_0 qr0 ON s.userid = qr0.userid
LEFT JOIN question_responses_1 qr1 ON s.userid = qr1.userid
WHERE (qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)
LIMIT 100000;
```

### Expected Result

```
userid  | pageid
--------|-------
user1   | page1
user2   | page1
```

(user3 excluded because they didn't answer q1)

---

## Summary Matrix

| Test | Condition | Operator | Status | Expected | Actual |
|------|-----------|----------|--------|----------|--------|
| 1 | Same question, different responses | OR | BROKEN | all who answered | none |
| 2 | Different questions | OR | BROKEN | user1,user2,user5 | user5 only |
| 3 | Different questions | AND | WORKS | user5 only | user5 only |
| 4 | elapsed_time conditions | OR | BROKEN | user1,user3,user5 | user5 only |
| 5 | question_response + elapsed_time | OR | BROKEN | either condition | both conditions |
| 6 | Nested OR in AND | OR | BROKEN | user1,user2 | none |
| 7 | Simple (non-CTE) conditions | OR | WORKS | correct | correct |
