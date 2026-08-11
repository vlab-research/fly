# Bail System SQL Generation Bug: Multiple Question_Response Conditions with OR Logic

**Date:** March 22, 2026
**Status:** CONFIRMED BUG
**Severity:** HIGH - Incorrect query semantics affecting bail targeting

## Executive Summary

The bail system has a critical bug in SQL generation when using **multiple `question_response` conditions combined with OR logic**. The generator creates two separate CTEs (Common Table Expressions) and **INNER JOINs both to the main query**, which produces AND semantics instead of the intended OR semantics.

**The bug:** When you create a bail with `OR` conditions on question responses, the SQL uses INNER JOINs for both conditions, which requires users to match **both** conditions simultaneously — making it impossible to match users who satisfy only one condition.

---

## The Bug in Detail

### Current Broken Behavior

When building this condition:
```json
{
  "op": "or",
  "vars": [
    {"type": "question_response", "form": "myform", "question_ref": "q1", "response": "yes"},
    {"type": "question_response", "form": "myform", "question_ref": "q2", "response": "no"}
  ]
}
```

The query builder generates this SQL:
```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2 AND response = $3
),
question_responses_1 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $4 AND question_ref = $5 AND response = $6
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid
JOIN question_responses_1 qr1 ON s.userid = qr1.userid
WHERE (qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)
LIMIT 100000
```

### Why This Is Wrong

The two `JOIN` statements create an **INNER JOIN intersection**:
- Line 1: `JOIN question_responses_0 qr0` — Only rows where userid exists in qr0
- Line 2: `JOIN question_responses_1 qr1` — Only rows where userid exists in BOTH qr0 AND qr1

The WHERE clause `(qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)` is redundant and does nothing — both qr0 and qr1 already exist due to the JOINs.

**Result:** The query matches users who answered Q1 with "yes" **AND** Q2 with "no" — the opposite of the OR intention.

### Correct Semantics (What Should Happen)

For OR logic to work correctly, the query should use **LEFT JOINs** and let the WHERE clause do the OR filtering:

```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2 AND response = $3
),
question_responses_1 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $4 AND question_ref = $5 AND response = $6
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
LEFT JOIN question_responses_0 qr0 ON s.userid = qr0.userid
LEFT JOIN question_responses_1 qr1 ON s.userid = qr1.userid
WHERE (qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)
LIMIT 100000
```

With LEFT JOINs:
- A user can match qr0 (and qr1 is NULL) — matches the OR condition
- A user can match qr1 (and qr0 is NULL) — matches the OR condition
- A user can match both — matches the OR condition
- A user matches neither — WHERE clause filters them out

---

## Root Cause Analysis

### Location of Bug

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go`
**Function:** `buildLogicalOperator` (lines 257-297)
**Core Issue:** Lines 274-281

The function builds a WHERE clause by:
1. Recursively building each child condition
2. Joining them with the appropriate SQL operator (AND/OR)

When a child is a `question_response` condition:
- Line 238-239: `buildQuestionResponseCondition` adds a CTE and a **JOIN clause** to `qb.cteJoins`
- Line 239: It appends the JOIN directly: `qb.cteJoins.append("JOIN question_responses_0 qr0 ON ...")`

The problem: **ALL CTEs are JOINed to the main query regardless of the logical operator structure.**

### How the Bug Manifests

When `buildLogicalOperator` processes an OR with two question_response children:

1. First child calls `buildQuestionResponseCondition`:
   - Creates `question_responses_0` CTE
   - Appends `JOIN question_responses_0 qr0 ON ...` to `cteJoins`
   - Returns `"qr0.userid IS NOT NULL"`

2. Second child calls `buildQuestionResponseCondition`:
   - Creates `question_responses_1` CTE
   - Appends `JOIN question_responses_1 qr1 ON ...` to `cteJoins`
   - Returns `"qr1.userid IS NOT NULL"`

3. `buildLogicalOperator` combines these with OR:
   - Returns `"(qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)"`

4. In `BuildQuery` (line 58-60):
   - All CTEs from `cteJoins` are unconditionally appended to the SQL
   - Result: Both `JOIN` statements execute, creating an AND intersection

### The Core Design Flaw

**Issue:** CTE-based conditions (`elapsed_time`, `question_response`) have a side effect:
- They add both a CTE definition AND a JOIN clause
- The JOIN happens **unconditionally** when the CTE is created
- The WHERE clause condition is secondary

This design conflates:
1. **CTE creation** — logical, necessary for query building
2. **JOINing** — implementation detail that should depend on logical operators

When you need OR logic with CTEs, you must:
- Create both CTEs
- JOIN both tables (unavoidable in SQL)
- Use WHERE clause logic to control which rows are included

But **INNER JOIN always filters to the intersection**, so OR logic requires **conditional JOINs** (LEFT JOIN + IS NULL checks).

---

## Impact Assessment

### Affected Scenarios

1. **OR conditions with multiple question_response conditions** — BROKEN
   - Expected: Users who answered question A with value X **OR** question B with value Y
   - Actual: Users who answered **both**

2. **OR inside AND with question_response** — May work or fail depending on structure
   - Example: `(state="BLOCKED") AND (response="yes" OR response="no")`
   - Behavior depends on which conditions are at which nesting level

3. **Complex nested conditions** — Unpredictable results
   - Any OR operator containing question_response will behave incorrectly

4. **elapsed_time conditions with OR** — Same issue
   - Multiple elapsed_time conditions with OR also broken (same CTE mechanism)

### Test Case Demonstrating Bug

The following bail condition is documented but **produces incorrect SQL**:

```json
{
  "op": "or",
  "vars": [
    {"type": "question_response", "form": "intake", "question_ref": "consent_question", "response": "Yes"},
    {"type": "question_response", "form": "intake", "question_ref": "consent_question", "response": "No"}
  ]
}
```

**Intent:** Bail users who answered the consent question with either "Yes" or "No" (i.e., all users who answered it).

**Current Result:** Bails zero users (impossible to answer "Yes" AND "No" simultaneously).

**Correct Result:** Bails all users who answered the question at all.

---

## Design Constraints & Trade-offs

### Why This Bug Is Hard to Fix

The `question_response` and `elapsed_time` conditions use CTEs with INNER JOINs because:

1. **They must join to the `responses` table**, which isn't part of the main `states` table
2. **A single condition can match multiple users**, so a CTE is needed to collect them
3. **The CTE is scoped to that condition's filtering logic** — only returns users matching that condition

The current code handles **AND logic correctly** — each JOIN filters the result set further, which is the desired AND behavior.

For **OR logic to work**, the design needs to support conditional JOINs:

**Option 1: LEFT JOIN + WHERE** (Most correct)
- Use LEFT JOIN for all CTE joins when inside an OR operator
- Let the WHERE clause control inclusion
- **Complexity:** Requires propagating context up the builder (which operator am I inside?)

**Option 2: UNION QUERIES** (Alternative approach)
- For each OR branch with CTEs, build a separate SELECT
- Use UNION to combine results
- **Complexity:** Requires restructuring entire query builder

**Option 3: Subqueries in WHERE** (Another alternative)
- Instead of CTEs+JOINs, move to WHERE clause subqueries
- `WHERE userid IN (SELECT ... WHERE cond1) OR userid IN (SELECT ... WHERE cond2)`
- **Complexity:** Less efficient, less maintainable

---

## Evidence & Test Results

### Reproduction Test

Location: `/tmp/test_or_conditions.go` (created during investigation)

Running the test generates this SQL for OR of two question_response conditions:

```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2 AND response = $3
),
question_responses_1 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $4 AND question_ref = $5 AND response = $6
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid
JOIN question_responses_1 qr1 ON s.userid = qr1.userid
WHERE (qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)
```

**Problem:** Both `JOIN` statements (lines 15-16) create an AND intersection, making the OR in the WHERE clause useless.

### Existing Tests

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/query/builder_test.go`

Currently, there are **NO tests** for:
- Multiple question_response conditions with OR
- Multiple elapsed_time conditions with OR
- question_response inside an OR operator

This gap explains how the bug went undetected.

---

## Code Locations

### Core Query Builder

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go`

- **Lines 11-19:** `QueryBuilder` struct — stores CTEs and JOINs globally
- **Lines 35-73:** `BuildQuery` — Main entry point, assembles final SQL
  - Line 50: `"WITH " + strings.Join(builder.ctes, ...)`
  - Line 59: `strings.Join(builder.cteJoins, "\n")` — Problem: unconditionally adds all JOINs
- **Lines 202-242:** `buildQuestionResponseCondition`
  - Lines 238-239: Creates both CTE and JOIN, stores in builder
- **Lines 150-200:** `buildElapsedTimeCondition` — Same issue
- **Lines 257-297:** `buildLogicalOperator` — Combines conditions with AND/OR
  - Line 286-293: Joins conditions with appropriate SQL operator
  - Problem: No awareness of CTE JOINs or whether they should be INNER vs LEFT

### Type Definitions

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/types/types.go`

- Lines 140-163: `Condition`, `LogicalOperator` — Define the condition tree structure
- Lines 296-301: Validation for NOT operator with elapsed_time/question_response — acknowledges CTE limitations

---

## Workarounds for Users

Until this bug is fixed, users cannot reliably create bails with OR conditions on question_response or elapsed_time.

**Current Workarounds:**

1. **Use AND logic only** — Restrict bails to AND combinations
2. **Split into multiple bails** — Create separate bails for each OR branch
   - Bail 1: Users who answered Q1 with "yes"
   - Bail 2: Users who answered Q2 with "no"
   - Same execution timing ensures they run together

3. **Use simple conditions with AND** — Only combine form/state/error_code/current_question with AND

---

## Fix Strategy (High-Level)

The fix must make one of these changes:

1. **Propagate operator context to condition builders**
   - Pass down: "Are you inside an OR?" flag
   - Use LEFT JOIN when inside OR, INNER JOIN otherwise

2. **Build conditional JOIN logic into the WHERE clause**
   - For OR operators with CTEs, generate WHERE clause that handles LEFT JOINs
   - Complex but more flexible

3. **Restructure to use UNION instead of JOINs**
   - For each OR branch, build a complete SELECT
   - UNION the results
   - More complex but cleaner logic

The first option (propagate operator context) is likely the least invasive and most maintainable.

---

## Related Documentation

- `/home/nandan/Documents/vlab-research/fly/documentation/bail-systems.md` — Comprehensive bail system documentation
  - Line 202-223: Logical operators section (claims OR works, doesn't reflect bug)
  - Line 246: Constraint on NOT with elapsed_time/question_response — similar limitation
  - Line 286-318: SQL generation examples (examples are for single conditions, not combined with OR)

---

## Testing Needed

After fixing, must add test cases:

1. **Two question_response conditions with OR**
   - Should use LEFT JOINs, not INNER JOINs
   - Should match users who satisfy either condition

2. **Two elapsed_time conditions with OR**
   - Same as above

3. **question_response in nested OR expressions**
   - OR inside AND
   - AND inside OR

4. **Multiple CTEs with mixed AND/OR**
   - Complex nesting to ensure precedence is respected

5. **SQL validation**
   - Generate SQL, verify it produces correct result set on test database
   - Compare to expected user set for various condition combinations
