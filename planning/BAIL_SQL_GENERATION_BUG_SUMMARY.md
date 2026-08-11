# Bail System SQL Generation Bug - Summary for Developers

**Severity:** HIGH (Incorrect query semantics)
**Status:** CONFIRMED BUG
**Investigation Date:** March 22, 2026
**Investigator:** Claude Code (Exploration)

---

## TL;DR

**The Bug:** When creating bail conditions with OR logic combining `question_response` or `elapsed_time` conditions, the generated SQL produces AND semantics instead of OR.

**Example:**
```json
{
  "op": "or",
  "vars": [
    {"type": "question_response", "form": "myform", "question_ref": "q1", "response": "yes"},
    {"type": "question_response", "form": "myform", "question_ref": "q2", "response": "no"}
  ]
}
```

**Expected:** Match users who answered q1 with "yes" **OR** q2 with "no"
**Actual:** Match users who answered **both** q1 with "yes" AND q2 with "no" (zero users, logically impossible)

---

## Root Cause

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go`

**Issue:** CTE-based conditions (question_response, elapsed_time) append JOIN statements to a global list that gets unconditionally added to the SQL, regardless of the logical operator combining them.

When processing an OR with two question_response conditions:
1. First condition creates `question_responses_0` CTE + appends `JOIN question_responses_0 qr0 ...`
2. Second condition creates `question_responses_1` CTE + appends `JOIN question_responses_1 qr1 ...`
3. buildLogicalOperator() returns `(qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)`
4. Final SQL has TWO INNER JOINs + WHERE with OR
5. **Problem:** Both JOINs execute → AND semantics, not OR

---

## Generated Broken SQL

```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid FROM responses
    WHERE shortcode = $1 AND question_ref = $2 AND response = $3
),
question_responses_1 AS (
    SELECT DISTINCT userid FROM responses
    WHERE shortcode = $4 AND question_ref = $5 AND response = $6
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN question_responses_0 qr0 ON s.userid = qr0.userid  ← AND intersection
JOIN question_responses_1 qr1 ON s.userid = qr1.userid  ← AND intersection
WHERE (qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)  ← Ineffective OR
LIMIT 100000
```

---

## What Should Be Generated

Use LEFT JOINs to allow the WHERE clause to control inclusion:

```sql
WITH question_responses_0 AS (...),
     question_responses_1 AS (...)
SELECT DISTINCT s.userid, s.pageid
FROM states s
LEFT JOIN question_responses_0 qr0 ON s.userid = qr0.userid
LEFT JOIN question_responses_1 qr1 ON s.userid = qr1.userid
WHERE (qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)  ← Effective OR
LIMIT 100000
```

With LEFT JOINs:
- User matches qr0 only → qr0 NOT NULL, qr1 IS NULL → WHERE is TRUE ✓
- User matches qr1 only → qr1 NOT NULL, qr0 IS NULL → WHERE is TRUE ✓
- User matches both → WHERE is TRUE ✓
- User matches neither → WHERE is FALSE ✗

---

## Affected Patterns

These bail conditions will produce incorrect SQL:

1. **OR with multiple question_response conditions**
   ```json
   {"op": "or", "vars": [{"type": "question_response", ...}, {"type": "question_response", ...}]}
   ```

2. **OR with multiple elapsed_time conditions**
   ```json
   {"op": "or", "vars": [{"type": "elapsed_time", ...}, {"type": "elapsed_time", ...}]}
   ```

3. **OR with mixed CTE-based conditions**
   ```json
   {"op": "or", "vars": [{"type": "question_response", ...}, {"type": "elapsed_time", ...}]}
   ```

4. **Nested OR containing CTE-based conditions**
   ```json
   {"op": "and", "vars": [{"type": "form", ...}, {"op": "or", "vars": [...CTE conditions...]}]}
   ```

---

## Code Locations

| File | Function | Issue |
|------|----------|-------|
| `/exodus/query/builder.go:35-73` | `BuildQuery()` | Line 58-60: Unconditionally adds all CTEs and JOINs |
| `/exodus/query/builder.go:202-242` | `buildQuestionResponseCondition()` | Lines 238-239: Appends JOIN unconditionally |
| `/exodus/query/builder.go:150-200` | `buildElapsedTimeCondition()` | Lines 190-195: Same issue |
| `/exodus/query/builder.go:257-297` | `buildLogicalOperator()` | No awareness of CTE join semantics |
| `/exodus/query/builder.go:11-19` | `QueryBuilder` struct | Line 16: `cteJoins` is global list, not operator-scoped |

---

## Test Coverage Gap

**File:** `/exodus/query/builder_test.go`

**Missing tests:**
- No tests for question_response with OR
- No tests for elapsed_time with OR
- No tests for mixed CTE conditions with OR
- No tests for nested structures with OR containing CTEs

Current tests only cover:
- Single condition types
- Simple AND/OR of non-CTE conditions
- Single CTE conditions
- Multiple CTEs with AND

---

## Fix Strategy

### Option 1: Propagate Operator Context (Recommended)

**Approach:** Pass "inside OR?" context down during condition building

**Changes needed:**
1. Add parameter to `buildCondition(cond, insideOR bool)`
2. In `buildLogicalOperator()`, set `insideOR = true` when operator is "or"
3. In `buildQuestionResponseCondition()` and `buildElapsedTimeCondition()`:
   - If `insideOR`, append LEFT JOIN instead of INNER JOIN
   - Or, don't append JOIN yet; return both the CTE and the join clause separately
4. In `BuildQuery()`, when assembling final SQL, apply appropriate JOIN types

**Pros:**
- Minimal changes to existing structure
- Preserves builder pattern
- Clear semantics

**Cons:**
- Requires threading parameter through all recursive calls
- Builder needs to be stateless about join types

### Option 2: UNION-based Approach

**Approach:** For OR with CTEs, generate separate SELECT statements and UNION them

**Pros:**
- Very clean SQL semantics
- Easy to understand

**Cons:**
- Major restructuring of query builder
- Less efficient queries (multiple scans)
- Complex implementation

### Option 3: Subquery-in-WHERE Approach

**Approach:** Replace JOINs with WHERE clause subqueries

**Pros:**
- No need to change JOIN strategy

**Cons:**
- Typically less efficient
- More complex WHERE clauses

---

## Implementation Checklist

If implementing Option 1 (recommended):

- [ ] Add `insideOR` parameter to `buildCondition()`
- [ ] Update `buildLogicalOperator()` to pass `insideOR = true` when `op == "or"`
- [ ] Modify `buildQuestionResponseCondition()` to use LEFT JOIN when `insideOR`
- [ ] Modify `buildElapsedTimeCondition()` to use LEFT JOIN when `insideOR`
- [ ] Add test for OR with two question_response conditions
- [ ] Add test for OR with two elapsed_time conditions
- [ ] Add test for nested OR/AND with CTEs
- [ ] Manually test generated SQL against test database
- [ ] Update `/exodus/README.md` to remove the bug warning
- [ ] Update `/documentation/bail-systems.md` if any examples are affected

---

## References

**Detailed Analysis:**
- `/planning/bail-sql-generation-bug-findings.md` — Complete bug investigation with test results
- `/planning/bail-system-architecture.md` — Architectural deep dive on how bail conditions work

**Code:**
- `/exodus/query/builder.go` — SQL generation logic
- `/exodus/types/types.go` — Condition type definitions
- `/exodus/query/builder_test.go` — Unit tests

**Documentation:**
- `/exodus/README.md` — Public API and architecture
- `/documentation/bail-systems.md` — User-facing bail system documentation

---

## Current Workarounds for Users

Until fixed, users should:

1. **Use AND logic only** — Don't combine CTE-based conditions with OR
2. **Split into multiple bails** — Create separate bail for each OR branch with same timing
3. **Restrict to simple conditions** — Use form/state/error_code/current_question with OR (these work correctly)

---

## Discussion Points for Implementation

1. **Impact on existing bails:** Are there any bails in production using OR with CTE conditions? (Check via logs/database)
2. **Migration strategy:** Do we need to update existing bails, or just fix for new ones?
3. **Testing approach:** Should we add property-based tests to catch similar issues?
4. **Documentation:** Should we add SQL generation tests that validate against actual database results?
