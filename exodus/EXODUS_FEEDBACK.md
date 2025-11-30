# Exodus Service - Code Review Feedback

**Last Updated:** 2025-11-30 12:28 UTC

## Overall Status: MAJOR PROGRESS - Most Components Implemented

Significant progress! Most Phase 1 components are now implemented. One test is failing in query builder.

---

## Test Results Summary

```
PASS: db tests (bails, events)
PASS: sender tests (including rate limiting, dry run, partial failure)
PASS: executor/timing tests
PASS: types tests
FAIL: query/builder_test.go - TestBuildQuery_ComplexWithElapsedTime
```

**Failing Test Issue:** Parameter ordering mismatch. The test expects a specific parameter order (`$1=form(CTE)`, `$2=question(CTE)`, `$3=form(WHERE)`, `$4=state`, `$5=duration`), but the actual order differs because conditions are processed in tree-walk order. Either the test expectations need adjusting, or the builder needs to ensure deterministic parameter ordering.

---

## New Files Implemented

### 1. `query/builder.go` - DSL to SQL Translation

**Status:** Working, one test failing

**Strengths:**
- Clean recursive condition tree walking
- Unique CTE naming (`response_times_0`, `response_times_1`, etc.) - matches plan
- Parameterized queries prevent SQL injection
- Duration validation with regex
- Shortcode filter on response CTE - matches plan fix
- Proper handling of AND/OR operators with parentheses

**Issue:**
- `TestBuildQuery_ComplexWithElapsedTime` fails due to parameter order expectations

### 2. `executor/timing.go` - Execution Timing Logic

**Status:** Excellent - All tests pass

**Implements:**
- `shouldExecute()` function matching the plan exactly
- 24-hour deduplication window for scheduled bails
- Absolute timing with one-shot execution
- Immediate timing (always execute)
- Proper timezone handling with `time.LoadLocation`
- `parseTimeOfDay()` for HH:MM format
- `parseDuration()` for interval parsing

### 3. `sender/sender.go` - HTTP POST to Botserver

**Status:** Excellent - All tests pass

**Implements:**
- `BailoutEvent` struct matching botserver API
- Rate limiting between sends
- Dry run mode for testing
- Context cancellation support
- Partial failure handling (continues after individual user errors)
- Proper logging

### 4. `db/db.go` - Database Connection

**Status:** Good

- Uses pgxpool for connection pooling
- Follows Dean pattern (log.Fatal on connection failure)

### 5. `db/bails.go` - Bail CRUD Operations

**Status:** Excellent

**Implements:**
- `GetEnabledBails()` - for executor loop
- `GetBailByID()` - single bail lookup
- `GetBailsBySurvey()` - for API
- `CreateBail()` - with RETURNING for ID/timestamps
- `UpdateBail()` - updates all mutable fields
- `DeleteBail()` - with existence check

### 6. `db/events.go` - Bail Event Log

**Status:** Excellent

**Implements:**
- `RecordEvent()` - for execution logging
- `GetEventsByBailID()` - event history for a bail
- `GetEventsBySurvey()` - survey-level event history with limit
- `GetLastSuccessfulExecution()` - for deduplication (matches plan!)

### 7. `types/types.go` - Moved to subpackage

**Status:** Good - Types moved to separate package to avoid circular dependencies

---

## Components Still Missing

- [ ] `config/config.go` - Environment configuration
- [ ] `executor/executor.go` - Main execution loop (timing.go is done)
- [ ] `main.go` - Entry point with mode switching
- [ ] `api/` - REST API handlers (Phase 2)
- [ ] `chart/` - Kubernetes manifests

---

## Issues to Address

### 1. Query Builder Test Failure

The test `TestBuildQuery_ComplexWithElapsedTime` expects:
```
params[0] = "myform"      (CTE shortcode)
params[1] = "q1"          (CTE question_ref)
params[2] = "myform"      (WHERE form)
params[3] = "WAIT_EXTERNAL_EVENT" (WHERE state)
params[4] = "4 weeks"     (duration)
```

But the actual order has `params[1]` and `params[3]` swapped. This is because the AND conditions are processed left-to-right, and if `elapsed_time` is not first in the `vars` array, the CTE params come after other WHERE params.

**Recommendation:** Either:
1. Fix test to match actual parameter ordering (preferred - order shouldn't matter for correctness)
2. Or ensure CTE params always come first in builder logic

---

## Architecture Notes

**Good Decisions:**
- Types in separate `types/` package avoids circular dependencies
- `executor/timing.go` is pure logic, easily testable
- `sender/` has full test coverage including edge cases
- Database layer uses pgxpool with proper error handling
- All components follow plan closely

---

## Review History

| Time | Notes |
|------|-------|
| 12:10 | Initial review - types.go and migration look good |
| 12:12 | Found critical marshal bug |
| 12:14 | Marshal bug fixed! All tests pass. TYPES_README.md added |
| 12:16 | No new changes |
| 12:28 | MAJOR UPDATE: query/, executor/, sender/, db/ all implemented! One test failing |
