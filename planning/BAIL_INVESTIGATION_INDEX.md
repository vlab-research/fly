# Bail System Investigation Index

**Investigation Date:** March 22, 2026
**Investigator:** Claude Code (Exploration Agent)
**Status:** COMPLETE - HIGH SEVERITY BUG CONFIRMED AND DOCUMENTED

---

## Quick Start

**For Quick Summary:** Read `BAIL_SQL_GENERATION_BUG_SUMMARY.md` (10-15 min read)

**For Implementation:** Follow the checklist in `BAIL_SQL_GENERATION_BUG_SUMMARY.md` after reading this index.

**For Understanding:** Read `bail-system-architecture.md` for deep technical context.

**For Testing:** Use test cases from `bail-or-bug-test-cases.md`

---

## Document Overview

### 1. BAIL_SQL_GENERATION_BUG_SUMMARY.md (7.9 KB)

**Purpose:** Executive summary for developers implementing the fix.

**Contents:**
- TL;DR of the bug
- Root cause explanation
- Broken vs correct SQL examples
- Affected patterns list
- Code locations with line numbers
- Test coverage gaps
- 3 fix strategy options (with pros/cons)
- Implementation checklist
- Workarounds for users

**Read Time:** 10-15 minutes

**When to Read:** First, before anything else

**Key Takeaway:** The bug causes OR logic with CTE-based conditions to produce AND semantics. Fix requires changing INNER JOINs to LEFT JOINs when inside OR operators.

---

### 2. bail-sql-generation-bug-findings.md (13 KB)

**Purpose:** Comprehensive investigation with evidence and analysis.

**Contents:**
- Executive summary
- Detailed bug explanation with examples
- Why the bug is wrong
- Root cause analysis with code references
- Impact assessment (affected scenarios, test case)
- Design constraints and trade-offs
- Evidence and test results
- Code locations with line references
- Workarounds for users
- Fix strategy (high-level overview)
- Related documentation pointers
- Testing requirements

**Read Time:** 30-45 minutes

**When to Read:** After reading SUMMARY, for deeper understanding before implementation.

**Key Takeaway:** Comprehensive understanding of how the bug manifests, why it happens, and what constraints the fix must work within.

---

### 3. bail-system-architecture.md (19 KB)

**Purpose:** Technical reference for understanding bail system architecture and SQL generation process.

**Contents:**
- Table of contents
- Condition type system (7 types explained in detail)
- Type definitions (Go structs)
- SQL query building process (step-by-step)
- CTE-based conditions deep dive
- Parameter management and numbering
- Full data flow from creation to execution
- How question_response conditions work
- References to source files

**Read Time:** 45-60 minutes (typically skimmed as reference)

**When to Read:** For understanding the architecture; use as reference while implementing.

**Key Takeaway:** Detailed understanding of how conditions are defined, validated, and converted to SQL. Essential for understanding the fix context.

---

### 4. bail-or-bug-test-cases.md (12 KB)

**Purpose:** Concrete test cases and examples demonstrating the bug.

**Contents:**
- 7 detailed test cases with database states
- Expected vs current results for each
- SQL examples (broken and correct)
- Go test code for unit tests
- Manual database validation steps
- Summary matrix of all tests

**Read Time:** 20-30 minutes

**When to Read:** While implementing fixes, and for database validation.

**Key Takeaway:** Concrete validation that the bug exists and examples of what correct behavior should be.

---

## Related Files

### Updated Documentation

**File:** `/exodus/README.md`

**What Changed:** Added ⚠️ Known Bug section explaining the OR logic issue.

**Location:** Lines ~171-191

**Contents:** Bug warning with reference to detailed documentation.

---

### Source Code Files (Not Modified)

**Core Query Builder:**
- `/exodus/query/builder.go` — SQL generation logic (lines 11-321)
- `/exodus/types/types.go` — Type definitions (lines 1-442)
- `/exodus/query/builder_test.go` — Unit tests (lines 1-811)

**Related:**
- `/documentation/bail-systems.md` — User-facing documentation
- `/exodus/api/handlers.go` — API handlers
- `/exodus/executor/executor.go` — Execution logic

---

## The Bug at a Glance

**What:** OR logic with question_response or elapsed_time conditions produces AND semantics.

**Why:** CTE-based conditions append JOIN statements to a global list that executes unconditionally, before the builder knows what logical operator will combine them.

**Where:** `/exodus/query/builder.go` lines 11-19, 35-73, 202-242, 150-200, 257-297

**Severity:** HIGH - Causes bails to match zero or incorrect users

**Impact:** Any bail using OR with CTE-based conditions will not work as intended.

**Fix:** Use LEFT JOINs instead of INNER JOINs when CTE conditions are inside OR operators.

---

## Implementation Path

### Phase 1: Understanding (1-2 hours)

1. Read `BAIL_SQL_GENERATION_BUG_SUMMARY.md` (executive summary)
2. Skim `bail-system-architecture.md` for context
3. Look at test cases in `bail-or-bug-test-cases.md`

### Phase 2: Planning (1-2 hours)

1. Decide which fix strategy to use (Option 1 recommended: propagate operator context)
2. Review code locations in `/exodus/query/builder.go`
3. Plan changes (rough pseudocode)
4. Identify all affected functions

### Phase 3: Implementation (4-8 hours)

1. Modify `buildCondition()` to accept `insideOR` parameter
2. Update `buildLogicalOperator()` to set `insideOR = true` for OR operators
3. Modify `buildQuestionResponseCondition()` to use LEFT JOIN when `insideOR`
4. Modify `buildElapsedTimeCondition()` to use LEFT JOIN when `insideOR`
5. Ensure parameter numbering remains correct
6. Update comments explaining the change

### Phase 4: Testing (2-4 hours)

1. Add unit tests from `bail-or-bug-test-cases.md`
2. Run existing test suite to ensure no regressions
3. Manual database validation against test database
4. Integration testing with preview endpoint

### Phase 5: Documentation & Deployment (1-2 hours)

1. Update `/exodus/README.md` to remove the bug warning
2. Add comments to explain the operator context logic
3. Consider adding architecture documentation note
4. Plan migration strategy for existing bails
5. Deploy and monitor

**Total Estimated Time:** 9-18 hours depending on fix strategy and testing depth

---

## Key Code References

### QueryBuilder State Management
```go
type QueryBuilder struct {
    params       []interface{}  // Parameters for parameterized query
    paramIndex   int            // Current parameter counter (starts at 1)
    ctes         []string       // CTE definitions (WITH clause content)
    cteJoins     []string       // JOIN clauses (for CTEs) ← PROBLEM: global list
    cteIndex     int            // Counter for unique CTE names
    queryLimit   int            // Safety limit (100,000)
}
```

### Problem Code Location
```go
// buildQuestionResponseCondition (line 202-242)
qb.ctes = append(qb.ctes, cte)
qb.cteJoins = append(qb.cteJoins, fmt.Sprintf("JOIN %s %s ON ...", cteName, alias))
// ^ This JOIN is appended unconditionally, without knowing if it's inside OR
```

### BuildQuery Assembly
```go
// BuildQuery (line 58-60)
if len(builder.cteJoins) > 0 {
    query.WriteString("\n")
    query.WriteString(strings.Join(builder.cteJoins, "\n"))
    // ^ All JOINs added unconditionally
}
```

---

## Testing Strategy

### Unit Tests to Add

From `bail-or-bug-test-cases.md`:

1. `TestBuildQuery_QuestionResponseWithOR` — Two question_response conditions with OR
2. `TestBuildQuery_ElapsedTimeWithOR` — Two elapsed_time conditions with OR
3. `TestBuildQuery_MixedCTEConditionsWithOR` — question_response + elapsed_time with OR
4. `TestBuildQuery_NestedORWithCTE` — OR inside AND containing CTEs
5. `TestBuildQuery_ComplexNestedWithOR` — Complex nesting with multiple operators and CTEs

### SQL Validation

After fix, generate SQL and validate:

```sql
-- Should use LEFT JOINs
LEFT JOIN question_responses_0 qr0 ON s.userid = qr0.userid
LEFT JOIN question_responses_1 qr1 ON s.userid = qr1.userid

-- Should have OR in WHERE
WHERE (qr0.userid IS NOT NULL OR qr1.userid IS NOT NULL)
```

### Database Testing

Run against test database with sample data:
1. Create users with various response combinations
2. Run generated query
3. Verify result matches expected (union of both conditions, not intersection)

---

## Deployment Considerations

### Backward Compatibility

This fix changes SQL generation for OR conditions with CTEs.

**Impact:**
- Existing bails with AND logic: No change (already work correctly)
- Existing bails with OR + CTE: Will now work correctly (fixing the bug)
- Simple (non-CTE) OR conditions: No change

**User Communication:**
- Document that OR with CTE conditions now works correctly
- No migration needed (existing broken bails will just start working)
- Consider audit of existing bails to warn users about previously broken ones

### Testing Before Deploy

1. Canary deployment to test environment
2. Run full test suite
3. Manual testing of example bails
4. Validate against production bail definitions (if any)

---

## Maintenance Notes

### Similar Issues

The same CTE JOIN issue affects `elapsed_time` conditions. Both use INNER JOIN and will have the same OR logic problem.

### Future Improvements

1. Add property-based testing for condition combinations
2. Add integration tests that validate SQL against actual database
3. Consider moving from CTE-based approach to cleaner SQL generation
4. Document the operator context requirement in code comments

---

## Questions for Implementer

Before starting:

1. **Priority:** Is this blocking any users? Should we prioritize for next release?
2. **Testing:** Do we have test environment with sample bails to validate?
3. **Migration:** Are there production bails using OR that we should monitor?
4. **Strategy:** Agree on Option 1 (propagate context) vs alternatives?
5. **Timeline:** What's the deployment timeline?

---

## Document Access

All documents located in: `/planning/`

Quick links:
- **Summary:** `BAIL_SQL_GENERATION_BUG_SUMMARY.md`
- **Details:** `bail-sql-generation-bug-findings.md`
- **Architecture:** `bail-system-architecture.md`
- **Tests:** `bail-or-bug-test-cases.md`
- **Index:** `BAIL_INVESTIGATION_INDEX.md` (this file)

---

## Investigation Completeness

- [x] Bug identified and confirmed
- [x] Root cause analyzed
- [x] Test case demonstrated
- [x] Code locations identified
- [x] SQL examples provided (broken and correct)
- [x] Architecture documented
- [x] Type system documented
- [x] Impact assessed
- [x] Test cases defined
- [x] Fix strategies outlined
- [x] Implementation checklist provided
- [x] Related documentation updated

**Status:** Ready for implementation phase

---

**For next steps, start with `BAIL_SQL_GENERATION_BUG_SUMMARY.md`**
