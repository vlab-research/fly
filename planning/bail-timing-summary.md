# Bail Timing System - Executive Summary

**Explorer:** Claude Code
**Date:** 2026-03-29
**Status:** Complete Exploration

---

## What I Found

The bail system has **three distinct execution modes**:

### 1. Immediate
- **Executes:** Every CronJob tick (~60 seconds)
- **Code:** Returns `true` unconditionally
- **Files:** `exodus/executor/timing.go:23-24`
- **Config:** Just `"timing": "immediate"`
- **Use case:** Real-time reactions

### 2. Scheduled
- **Executes:** Once per calendar day at a specific time
- **Code:** Full timezone support, tolerance window, calendar-day guard
- **Files:** `exodus/executor/timing.go:41-94`
- **Config:** Requires `time_of_day` and `timezone`
- **Timezone:** Full IANA support (America/New_York, Asia/Shanghai, etc.)
- **Use case:** Daily recurring tasks

### 3. Absolute
- **Executes:** Exactly once when current time >= specified datetime
- **Code:** No timezone field (uses datetime string offset)
- **Files:** `exodus/executor/timing.go:97-124`
- **Config:** Requires `datetime`
- **Timezone:** No dedicated field — use offset in datetime string
- **Use case:** One-time scheduled events

---

## Where Everything Is

| Component | Location | Purpose |
|-----------|----------|---------|
| **Type definitions** | `/exodus/types/types.go:59-91` | `Execution` struct with all fields |
| **Main dispatcher** | `/exodus/executor/timing.go:21-35` | `shouldExecute()` routes to correct function |
| **Scheduled logic** | `/exodus/executor/timing.go:41-94` | `shouldExecuteScheduled()` — timezone-aware |
| **Absolute logic** | `/exodus/executor/timing.go:97-124` | `shouldExecuteAbsolute()` — no timezone field |
| **Time parsers** | `/exodus/executor/timing.go:128-153` | `parseTimeOfDay()` for HH:MM parsing |
| **Execution call** | `/exodus/executor/executor.go:134` | Where `shouldExecute()` is invoked |
| **Tests** | `/exodus/executor/timing_test.go` | 50+ test cases, comprehensive coverage |
| **Database ops** | `/exodus/db/bails.go:27-44` | `GetEnabledBails()` retrieves configured bails |

---

## Key Findings

### ✅ Strengths

1. **Scheduled mode is production-ready**
   - Correctly handles timezone conversions
   - Uses calendar-day semantics (not elapsed time)
   - Configurable tolerance window (default 30 min)
   - Comprehensive test coverage

2. **Clear code structure**
   - Each execution mode has its own function
   - Main dispatcher `shouldExecute()` is simple
   - Tests cover normal cases + edge cases

3. **Smart design choices**
   - Calendar-day check prevents DST/boundary issues
   - Tolerance window allows for delayed executor runs
   - Once-ever guard prevents duplicate absolute executions

### ❌ Problems

1. **Absolute mode has no timezone field**
   - Users must manually calculate UTC offsets
   - Wrong format leads to silently incorrect execution times
   - Example: User in Shanghai writes `"datetime": "2026-03-25T09:00:00"` (no offset) → executes at 09:00 UTC, not Shanghai time → 8 hours too early

2. **Code duplication across modes**
   - Time parsing logic duplicated (manual vs built-in)
   - Re-execution guards use different logic (calendar day vs once-ever)
   - No unified validation for time formats
   - TODO comments indicate incomplete validation

3. **Validation happens at runtime**
   - Invalid timezone names only caught during execution
   - Invalid datetime formats only caught during execution
   - Should be caught when bail is created/updated
   - Causes "bail execution failed" instead of "invalid configuration"

4. **Different re-execution semantics**
   - Scheduled: "Once per calendar day (in target TZ)"
   - Absolute: "Once ever (across all time)"
   - Not clearly documented

---

## DRY Violations Identified

### Violation 1: Time Parsing
```
Scheduled:  Manual string splitting + validation
Absolute:   Go's time.Parse() with fallback
Result:     Two different approaches, hard to maintain
```

### Violation 2: Re-execution Guards
```
Scheduled:  Compare calendar dates in target timezone
Absolute:   Check if lastExecution exists at all
Result:     Different logic for same concept
```

### Violation 3: Datetime Validation
```
Type definition:  "TODO: Validate datetime format"
Scheduled:        "TODO: Validate time_of_day format"
Absolute:         "TODO: Validate datetime format"
Result:           Format validation not implemented anywhere
```

---

## Timezone Handling

### Scheduled Mode ✅
```go
loc, err := time.LoadLocation(*exec.Timezone)
nowInTZ := now.In(loc)
```
- Full IANA timezone support
- Requires tzdata in binary (error message: "is tzdata embedded?")
- Handles DST automatically
- Examples: "America/New_York", "Asia/Shanghai", "UTC"

### Absolute Mode ❌
```go
targetTime, err := time.Parse(time.RFC3339, *exec.Datetime)
```
- No timezone field in Execution struct
- Timezone info comes from datetime string: `"2026-03-25T09:00:00-05:00"`
- Ambiguous format without offset: `"2026-03-25T09:00:00"` defaults to UTC
- Inconsistent with scheduled mode

---

## Edge Cases & Testing

### Tested ✅
- Timezone conversions (Shanghai, Lagos, Jakarta, New York)
- Calendar day boundaries across timezone changes
- DST boundary crossing (at 02:30 when clocks spring forward)
- Tolerance window boundaries (at/before/after tolerance limit)
- Invalid timezone names
- Missing required fields

### Not Tested ❌
- Absolute mode with ambiguous datetime (no offset)
- Different behavior expectations between modes
- Format validation errors
- Timezone validation errors

---

## What Should Be Fixed

### High Priority
1. **Add timezone field to absolute mode** — Allow `"timezone": "America/New_York"` in addition to or instead of offset in datetime string
2. **Implement datetime format validation** — Remove TODO, validate in `Execution.Validate()` method
3. **Implement timezone validation** — Check IANA timezone names at config time, not execution time

### Medium Priority
1. **Unify time parsing logic** — Create shared time parsing functions to avoid duplication
2. **Document re-execution semantics** — Clearly explain "once per calendar day" vs "once ever"
3. **Add integration tests** — Test absolute mode with timezone offsets

### Low Priority
1. **Validate time_of_day format** — Check HH:MM format in Validate() method
2. **Better error messages** — Distinguish between "timezone not found" vs "timezone not in binary"

---

## Code Examples

### Scheduled (Correct)
```json
{
    "timing": "scheduled",
    "time_of_day": "09:00",
    "timezone": "America/New_York",
    "tolerance_minutes": 45
}
```

### Absolute (Timezone in offset)
```json
{
    "timing": "absolute",
    "datetime": "2026-03-25T09:00:00-04:00"
}
```

### Absolute (UTC with offset in offset)
```json
{
    "timing": "absolute",
    "datetime": "2026-03-25T09:00:00Z"
}
```

### Absolute (WRONG - no offset, assumes UTC)
```json
{
    "timing": "absolute",
    "datetime": "2026-03-25T09:00:00"
}
```

---

## Files to Read

**For understanding the system:**
1. Start: `planning/bail-timing-quick-reference.md` (this file's sibling)
2. Deep dive: `planning/bail-timing-deep-dive-findings.md` (comprehensive analysis)
3. Architecture: `planning/bail-system-architecture.md` (conditions and SQL)
4. Execution modes: `planning/bail-execution-modes-quick-ref.md` (execution flow diagram)

**For implementation:**
1. Type definitions: `/exodus/types/types.go:59-91`
2. Timing logic: `/exodus/executor/timing.go:21-124`
3. Integration: `/exodus/executor/executor.go:133-143`
4. Tests: `/exodus/executor/timing_test.go`

---

## Key Code Sections

### Main Entry Point
```go
// exodus/executor/timing.go:21-35
func shouldExecute(execution *types.Execution, now time.Time, lastExecution *time.Time) (bool, error) {
    switch execution.Timing {
    case "immediate":
        return true, nil
    case "scheduled":
        return shouldExecuteScheduled(execution, now, lastExecution)
    case "absolute":
        return shouldExecuteAbsolute(execution, now, lastExecution)
    }
}
```

### Called From
```go
// exodus/executor/executor.go:134
ready, err := shouldExecute(&bailDef.Execution, now, lastExecution)
```

### Type Definition
```go
// exodus/types/types.go:60-66
type Execution struct {
    Timing           string  `json:"timing"`
    TimeOfDay        *string `json:"time_of_day,omitempty"`
    Timezone         *string `json:"timezone,omitempty"`
    Datetime         *string `json:"datetime,omitempty"`
    ToleranceMinutes *int    `json:"tolerance_minutes,omitempty"`
}
```

---

## Bottom Line

The bail system is **well-designed for scheduled mode** but **incomplete for absolute mode** (missing timezone field). Both modes have **code duplication** and **incomplete validation** (TODO comments).

The system is **production-ready for scheduled bails** but users of absolute bails must understand datetime offset formatting to avoid silent failures.

---

## Questions Answered

**Q: How does "absolute" bail work?**
A: Parses datetime string, executes once when current time >= datetime, prevents re-execution with once-ever guard.

**Q: How does "scheduled" bail work?**
A: Converts time to target timezone, checks if current time matches specified HH:MM with configurable tolerance, prevents re-execution using calendar day check.

**Q: Do both support timezones?**
A: Scheduled ✅ (dedicated field). Absolute ❌ (only in datetime string offset).

**Q: What functions implement each mode?**
A: `shouldExecuteScheduled()` for scheduled, `shouldExecuteAbsolute()` for absolute, both in `exodus/executor/timing.go`.

**Q: Where are the test cases?**
A: `/exodus/executor/timing_test.go` with 50+ test cases, comprehensive coverage for all modes.
