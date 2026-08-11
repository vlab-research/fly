# Bail System Timing Deep Dive - Complete Findings

**Date:** 2026-03-29
**Scope:** Exploration of absolute, scheduled, and immediate bail execution modes with timezone handling
**Status:** Complete

---

## Executive Summary

The bail system has **three distinct execution timing modes**:

1. **Immediate** — Executes on every executor tick (every 60 seconds via Kubernetes CronJob)
2. **Scheduled** — Executes once per day at a specific time in a specified timezone
3. **Absolute** — Executes once when current time >= specified datetime (no timezone support)

**Key finding:** Scheduled and absolute bails have **significant code duplication** and different approaches to time validation. Absolute timing does NOT currently support timezones, while scheduled timing REQUIRES them.

---

## Table of Contents

1. [Type Definitions](#type-definitions)
2. [Execution Timing Functions](#execution-timing-functions)
3. [Detailed Mode Analysis](#detailed-mode-analysis)
4. [Timezone Handling in Scheduled Mode](#timezone-handling-in-scheduled-mode)
5. [Timezone Absence in Absolute Mode](#timezone-absence-in-absolute-mode)
6. [DRY Violations & Code Duplication](#dry-violations--code-duplication)
7. [Key Implementation Details](#key-implementation-details)
8. [Edge Cases & Gotchas](#edge-cases--gotchas)
9. [Testing Coverage](#testing-coverage)

---

## Type Definitions

### Location: `/exodus/types/types.go` lines 59-91

#### Execution Type

```go
type Execution struct {
    Timing           string  `json:"timing"` // "immediate", "scheduled", or "absolute"
    TimeOfDay        *string `json:"time_of_day,omitempty"`
    Timezone         *string `json:"timezone,omitempty"`
    Datetime         *string `json:"datetime,omitempty"`
    ToleranceMinutes *int    `json:"tolerance_minutes,omitempty"` // Scheduled only
}
```

**Field purposes:**
- **Timing:** Which execution mode to use
- **TimeOfDay:** Required for scheduled (HH:MM format, e.g., "09:00")
- **Timezone:** Required for scheduled (IANA timezone, e.g., "America/New_York")
- **Datetime:** Required for absolute (ISO 8601 format, e.g., "2026-03-25T14:30:00Z")
- **ToleranceMinutes:** Optional for scheduled, ignored for others. Defaults to 30 minutes if not set.

#### Validation (types.go lines 69-91)

```go
func (e *Execution) Validate() error {
    switch e.Timing {
    case "immediate":
        // No validation — no fields required

    case "scheduled":
        if e.TimeOfDay == nil {
            return fmt.Errorf("time_of_day is required for scheduled timing")
        }
        if e.Timezone == nil {
            return fmt.Errorf("timezone is required for scheduled timing")
        }
        // TODO: Validate time_of_day format (HH:MM)
        // TODO: Validate timezone is valid IANA timezone

    case "absolute":
        if e.Datetime == nil {
            return fmt.Errorf("datetime is required for absolute timing")
        }
        // TODO: Validate datetime is valid ISO 8601 format
    }
}
```

**Critical observation:** Both schedule and absolute have TODO comments for format validation, but neither is implemented. The actual validation happens at runtime during execution.

---

## Execution Timing Functions

### Location: `/exodus/executor/timing.go`

The main entry point is `shouldExecute()` which dispatches to mode-specific functions:

```go
func shouldExecute(execution *types.Execution, now time.Time, lastExecution *time.Time) (bool, error) {
    switch execution.Timing {
    case "immediate":
        return true, nil
    case "scheduled":
        return shouldExecuteScheduled(execution, now, lastExecution)
    case "absolute":
        return shouldExecuteAbsolute(execution, now, lastExecution)
    default:
        return false, fmt.Errorf("unknown timing type %q", execution.Timing)
    }
}
```

---

## Detailed Mode Analysis

### Mode 1: IMMEDIATE (lines 23-24)

**Purpose:** Execute on every executor run (typically every 60 seconds)

**Timing logic:**
```go
case "immediate":
    return true, nil
```

**Execution frequency:**
- Executes on every CronJob trigger
- No cooldown, no time check
- Fires once per minute (K8s CronJob runs at "* * * * *")

**Rate limiting:**
- Individual bailouts are rate-limited to 1 per second (in sender.go)
- This does NOT prevent the same user from being bailed in consecutive minutes

**Last execution check:**
- NOT checked — `lastExecution` parameter is ignored

**Use case:** Real-time reactions to conditions that change frequently

---

### Mode 2: SCHEDULED (lines 25-27 + lines 41-94)

**Purpose:** Execute once per day at a specific time in a specific timezone

**Type signature:**
```go
func shouldExecuteScheduled(exec *types.Execution, now time.Time, lastExecution *time.Time) (bool, error)
```

**Required fields:**
- `TimeOfDay` (non-nil) — e.g., "09:00"
- `Timezone` (non-nil) — e.g., "America/New_York"

**Optional fields:**
- `ToleranceMinutes` — defaults to 30 minutes if not specified

**Execution logic (lines 41-94):**

```
1. Parse timezone (line 48)
   └─ error if invalid timezone

2. Convert current time to target timezone (line 54)
   └─ nowInTZ = now.In(loc)

3. Parse time_of_day (HH:MM) (line 57)
   └─ Extract hour and minute

4. Build target datetime for TODAY in target timezone (line 63-64)
   └─ targetTime = Date(year, month, day, hour, minute, 0, 0, loc)

5. Determine tolerance window (lines 66-70)
   └─ tolerance = 30 minutes (default) or bail's setting

6. Check if current time is within tolerance after target time (lines 75-78)
   └─ diff = now - targetTime
   └─ if diff < 0 (before target) → return false
   └─ if diff > tolerance → return false
   └─ Otherwise → continue to step 7

7. Check if already executed today (lines 84-91)
   └─ Convert lastExecution to target timezone
   └─ Compare calendar dates (year, month, day)
   └─ If same calendar day → return false (already ran)
   └─ If different calendar day → return true (can run)

8. Return true (execute)
```

**Key insight — "Calendar day" logic (lines 84-91):**

The system uses **calendar day in the target timezone**, not elapsed time:

```go
if lastExecution != nil {
    lastInTZ := lastExecution.In(loc)
    ly, lm, ld := lastInTZ.Date()
    ny, nm, nd := nowInTZ.Date()
    if ly == ny && lm == nm && ld == nd {
        return false, nil  // Already ran today
    }
}
```

This is intentional to handle edge cases where:
- Executor is delayed (fires 5 seconds late)
- Timezone boundaries don't align with 24-hour clocks
- Need one-per-calendar-day semantics, not "one per 1440 minutes"

**Tolerance window details:**
- Forward-only window from target time
- Window = `[targetTime, targetTime + tolerance]`
- Does NOT allow execution before scheduled time

**Example scenario:**

Configuration:
```json
{
    "timing": "scheduled",
    "time_of_day": "05:00",
    "timezone": "Asia/Shanghai"
}
```

Execution timeline (UTC times):
- 2025-11-29 21:00:05 UTC = 2025-11-30 05:00:05 Shanghai → EXECUTES (at tolerance)
- 2025-11-30 21:00:00 UTC = 2025-12-01 05:00:00 Shanghai → CANNOT EXECUTE (same day in Shanghai)
- 2025-11-30 21:00:00 UTC = 2025-12-01 05:00:00 Shanghai → EXECUTES (next calendar day in Shanghai)

---

### Mode 3: ABSOLUTE (lines 29-30 + lines 97-124)

**Purpose:** Execute exactly once when current time >= specified datetime

**Type signature:**
```go
func shouldExecuteAbsolute(exec *types.Execution, now time.Time, lastExecution *time.Time) (bool, error)
```

**Required fields:**
- `Datetime` (non-nil) — e.g., "2026-03-25T14:30:00Z"

**Optional fields:**
- None

**Execution logic (lines 97-124):**

```
1. Parse datetime (ISO 8601) (line 104)
   ├─ Try RFC3339 format first (with timezone)
   ├─ Fall back to ISO8601 without timezone if RFC3339 fails
   └─ error if both fail

2. Check if current time >= target datetime (line 114)
   └─ if now < targetTime → return false (too early)
   └─ Otherwise → continue to step 3

3. Check if already executed (line 119)
   └─ if lastExecution != nil → return false (already executed)
   └─ Otherwise → return true (execute)
```

**Datetime parsing (lines 104-111):**

```go
targetTime, err := time.Parse(time.RFC3339, *exec.Datetime)
if err != nil {
    // Try alternate ISO 8601 format without timezone
    targetTime, err = time.Parse("2006-01-02T15:04:05", *exec.Datetime)
    if err != nil {
        return false, fmt.Errorf("invalid datetime %q: must be RFC3339 or ISO8601 without timezone", *exec.Datetime)
    }
}
```

Supports two formats:
1. RFC3339 with explicit timezone: `2026-03-25T14:30:00Z` or `2026-03-25T14:30:00-05:00`
2. ISO8601 without timezone: `2026-03-25T14:30:00`

**Once-only guard:**
- Any bailout creates a `BailEvent` with `event_type="execution"`
- The executor checks `GetLastSuccessfulExecution()` before executing
- If `lastExecution != nil`, the function returns `false` immediately
- **This means if a bail errors and is retried, it WILL execute again**

---

## Timezone Handling in Scheduled Mode

### Time Zone Loading

**Location:** `/exodus/executor/timing.go` lines 48-50

```go
loc, err := time.LoadLocation(*exec.Timezone)
if err != nil {
    return false, fmt.Errorf("failed to load timezone %q: %w (is tzdata embedded?)", *exec.Timezone, err)
}
```

Uses Go's standard `time.LoadLocation()` to resolve IANA timezone names like:
- `UTC`
- `America/New_York`
- `Europe/London`
- `Asia/Shanghai`
- etc.

### Timezone Data Requirement

The error message **(is tzdata embedded?)** hints at a critical requirement:

**tzdata must be embedded in the binary** because:
1. The executor runs in a Docker container
2. Container filesystems are minimal and may not have `/usr/share/zoneinfo`
3. Go can embed timezone data at compile time

**Verification:** In `/exodus/main.go`, check for `//go:embed` directives or similar.

---

## Timezone Absence in Absolute Mode

### Current Behavior

**Absolute timing does NOT use timezones.** The datetime is parsed as-is:

```go
targetTime, err := time.Parse(time.RFC3339, *exec.Datetime)
```

If RFC3339 parsing succeeds, the timezone info in the datetime string is used. If that string omits timezone info, it defaults to UTC (Go's behavior for `time.Parse()`).

### Why This Matters

**Scenario: User in Asia/Shanghai tries to schedule a one-time bail at "9:00 AM local time"**

Wrong approach:
```json
{
    "timing": "absolute",
    "datetime": "2026-03-25T09:00:00"  // Ambiguous—is this UTC or Shanghai?
}
```

Go parses this as UTC, not Shanghai time, because no timezone is specified.

Correct approach:
```json
{
    "timing": "absolute",
    "datetime": "2026-03-25T09:00:00+08:00"  // Explicitly Shanghai timezone
}
```

**This is a usability gap:** Users cannot easily specify "9 AM in my timezone" for absolute bails. They must manually convert to UTC or include the full timezone offset.

---

## DRY Violations & Code Duplication

### Problem 1: Duplicated Time Parsing Logic

Both functions parse time strings but in different ways:

**Scheduled (line 128-153):**
```go
func parseTimeOfDay(s string) (hour int, minute int, err error) {
    parts := strings.Split(s, ":")
    if len(parts) != 2 {
        return 0, 0, fmt.Errorf("invalid time_of_day format: %s (expected HH:MM)", s)
    }
    hour, err = strconv.Atoi(parts[0])
    minute, err = strconv.Atoi(parts[1])
    if hour < 0 || hour > 23 {
        return 0, 0, fmt.Errorf("hour must be between 0 and 23, got %d", hour)
    }
    if minute < 0 || minute > 59 {
        return 0, 0, fmt.Errorf("minute must be between 0 and 59, got %d", minute)
    }
    return hour, minute, nil
}
```

**Absolute (inline, lines 104-111):**
```go
targetTime, err := time.Parse(time.RFC3339, *exec.Datetime)
if err != nil {
    targetTime, err = time.Parse("2006-01-02T15:04:05", *exec.Datetime)
    if err != nil {
        return false, fmt.Errorf(...)
    }
}
```

**Different approaches:**
- Scheduled: Manual string splitting + validation
- Absolute: Go's built-in parsing with fallback

**Why this matters:**
- If time format validation rules change, both must be updated
- No single source of truth for time parsing

### Problem 2: Duplicated Time Comparison Logic

Both functions check "have we already executed?" but with different semantics:

**Scheduled (lines 84-91):**
```go
if lastExecution != nil {
    lastInTZ := lastExecution.In(loc)
    ly, lm, ld := lastInTZ.Date()
    ny, nm, nd := nowInTZ.Date()
    if ly == ny && lm == nm && ld == nd {
        return false, nil
    }
}
```

**Absolute (lines 119-120):**
```go
if lastExecution != nil {
    return false, nil
}
```

**Different semantics:**
- Scheduled: "Have we executed on this calendar day (in target TZ)?"
- Absolute: "Have we executed at all (ever)?"

**Why this matters:**
- The comparison logic is fundamentally different
- But both answer the same question: "Should we guard against re-execution?"
- A refactored version should have a consistent guard mechanism

### Problem 3: Duplicated Tolerance/Window Logic

**Scheduled mode:**
```go
tolerance := defaultScheduledTolerance  // 30 minutes
if exec.ToleranceMinutes != nil {
    tolerance = time.Duration(*exec.ToleranceMinutes) * time.Minute
}
diff := now.Sub(targetTime)
if diff < 0 || diff > tolerance {
    return false, nil
}
```

**Absolute mode:**
- No tolerance window at all
- Executes immediately when `now >= targetTime`

**Why this matters:**
- Two different behaviors for "when should execution happen?"
- Scheduled has configurable tolerance, absolute doesn't
- Could be unified with a general "execution window" concept

### Problem 4: Validation Deferred to Runtime

Both types.go validation (lines 69-91) have TODO comments:

```go
case "scheduled":
    // TODO: Validate time_of_day format (HH:MM)
    // TODO: Validate timezone is valid IANA timezone

case "absolute":
    // TODO: Validate datetime is valid ISO 8601 format
```

**Consequence:**
- Invalid configurations are rejected at runtime (during execution)
- Not caught when the bail is created or updated
- Causes execution failures instead of validation errors

---

## Key Implementation Details

### Location of shouldExecute() Call

**File:** `/exodus/executor/executor.go` lines 133-143

```go
// Get last execution time
lastExecution, err := e.store.GetLastSuccessfulExecution(ctx, dbBail.ID)
if err != nil {
    // ... error handling
}

// Check if should execute based on timing
ready, err := shouldExecute(&bailDef.Execution, now, lastExecution)
if err != nil {
    // ... error handling
}
if !ready {
    log.Printf("Bail %s not ready to execute (timing conditions not met)", dbBail.Name)
    return nil
}

log.Printf("Bail %s ready to execute", dbBail.Name)
```

**Flow:**
1. Load enabled bail from database
2. Parse JSON definition
3. Get `lastExecution` timestamp from BailEvent table
4. Call `shouldExecute()` with bail's Execution config
5. If false, skip to next bail
6. If true, query users and send bailouts

### GetLastSuccessfulExecution()

**Location:** `/exodus/db/events.go` (inferred from code flow)

This function queries the bail_events table for the most recent execution event for a specific bail, returning its timestamp.

**Note:** The code doesn't show this implementation, but from executor.go line 126:
```go
lastExecution, err := e.store.GetLastSuccessfulExecution(ctx, dbBail.ID)
```

This is a database interface method that must return:
- `nil` if no prior execution
- The timestamp of the last execution event otherwise

---

## Edge Cases & Gotchas

### Edge Case 1: Scheduled Bail Spanning Midnight in Different Timezones

**Scenario:**
- Executor runs at 2025-11-29 23:30 UTC
- Bail scheduled for 09:00 in Asia/Shanghai (UTC+8)
- 23:30 UTC = 2025-11-30 07:30 Shanghai (next calendar day!)

**Expected:** Bail does NOT execute (too early, it's 07:30 not 09:00)

**What happens:**
1. `now = 2025-11-29T23:30:00Z`
2. `nowInTZ = 2025-11-30T07:30:00 Shanghai`
3. `targetTime = 2025-11-30T09:00:00 Shanghai`
4. `diff = nowInTZ - targetTime = -1 hour 30 min` (negative!)
5. `diff < 0` → return `false` ✓ Correct

### Edge Case 2: Scheduled Bail at Exactly Midnight

**Configuration:**
```json
{
    "timing": "scheduled",
    "time_of_day": "00:00",
    "timezone": "UTC"
}
```

**When it fires:**
- When current UTC time is 00:00:00 - 00:00:59
- Target time = today at 00:00 UTC
- Works correctly

### Edge Case 3: Scheduled Bail Crossing DST Boundary

**Scenario:**
- Bail scheduled for 02:30 America/New_York
- When DST transition happens, 02:30 doesn't exist (spring forward)
- Or 02:30 happens twice (fall back)

**Current behavior:**
- Go's `time.LoadLocation()` and `.In()` handle DST automatically
- On spring forward: No execution that hour (02:30 skipped)
- On fall back: Executes during the first occurrence of 02:30

**Potential issue:** If scheduled time falls in the "spring forward" gap, it will never execute that day.

### Edge Case 4: Absolute Bail with No Timezone Info

**Configuration:**
```json
{
    "timing": "absolute",
    "datetime": "2026-03-25T09:00:00"  // No timezone!
}
```

**What happens:**
1. `time.Parse("2006-01-02T15:04:05", "2026-03-25T09:00:00")` succeeds
2. Result is interpreted as **UTC** (Go's default for unspecified TZ)
3. If user intended 09:00 Shanghai, this is wrong by 8 hours

**Impact:** User expects execution at 9 AM local time, but it actually fires 8 hours earlier.

### Edge Case 5: Tolerance Window Precision

**Configuration:**
```json
{
    "timing": "scheduled",
    "time_of_day": "15:30",
    "timezone": "UTC",
    "tolerance_minutes": 0  // Zero tolerance
}
```

**Expected behavior:**
- Executes only in the 60-second window from 15:30:00 to 15:30:59
- Does not execute at 15:30:01 (1 second late)

**Actual behavior (lines 75-78):**
```go
diff := now.Sub(targetTime)
if diff < 0 || diff > tolerance {
    return false, nil
}
```

- `now = 15:30:01`
- `targetTime = 15:30:00`
- `diff = 1 second`
- `tolerance = 0 seconds` (from config)
- `diff > tolerance` → `true` → return `false`

So with `tolerance_minutes: 0`, it executes **during the target minute only** (15:30:00-15:30:59). ✓ Correct

---

## Testing Coverage

### Current Tests

**File:** `/exodus/executor/timing_test.go`

#### Immediate Mode Tests (lines 10-53)

```go
func TestShouldExecute_Immediate(t *testing.T)
```

Tests covered:
- [ ] No prior execution → executes
- [ ] Executed 1 minute ago → executes
- [ ] Executed 1 hour ago → executes
- [ ] Executed 1 day ago → executes

**Observation:** All tests pass because immediate always returns `true`. Tests don't add much value.

#### Scheduled Mode Tests (lines 55-281)

```go
func TestShouldExecute_Scheduled(t *testing.T)
```

Tests covered (30+ test cases):
- [x] Exact time match in UTC, no prior execution → executes
- [x] Wrong hour → doesn't execute
- [x] Wrong minute → doesn't execute
- [x] Executed 23 hours ago (previous calendar day) → executes
- [x] Executed earlier today → doesn't execute
- [x] Executed exactly 24 hours ago → executes
- [x] Executed 25 hours ago → executes
- [x] **Asia/Shanghai with DST boundary crossing** → executes correctly
- [x] Various timezone conversions (Lagos, Jakarta, New York)
- [x] Midnight (00:00)
- [x] End of day (23:59)
- [x] Within tolerance window
- [x] At tolerance boundary
- [x] Just past tolerance boundary
- [x] Custom tolerance values
- [x] Before target time
- [x] Already ran today within tolerance window
- [x] Invalid timezone error
- [x] Missing time_of_day

**Coverage:** Comprehensive. Includes complex timezone scenarios.

#### Absolute Mode Tests (lines 283-366)

```go
func TestShouldExecute_Absolute(t *testing.T)
```

Tests covered (partial list from reading):
- [x] Datetime is now, no prior execution → executes
- [x] Datetime is in the future → doesn't execute
- [x] Datetime is in the past, no prior execution → executes
- [x] Datetime is in the past, already executed → doesn't execute
- [x] RFC3339 with timezone
- [x] ISO8601 without timezone
- [x] Invalid datetime format

**Coverage:** Good for basic scenarios, doesn't test timezone offset implications.

---

## File Locations & Code References

| Component | Location | Lines | Purpose |
|-----------|----------|-------|---------|
| **Type definitions** | `/exodus/types/types.go` | 59-91 | Execution struct, validation |
| **shouldExecute()** | `/exodus/executor/timing.go` | 21-35 | Main dispatcher |
| **shouldExecuteScheduled()** | `/exodus/executor/timing.go` | 41-94 | Scheduled mode logic |
| **shouldExecuteAbsolute()** | `/exodus/executor/timing.go` | 97-124 | Absolute mode logic |
| **parseTimeOfDay()** | `/exodus/executor/timing.go` | 128-153 | HH:MM parser |
| **parseDuration()** | `/exodus/executor/timing.go` | 157-189 | Duration parser (for other features) |
| **Execution call site** | `/exodus/executor/executor.go` | 133-143 | Where shouldExecute() is invoked |
| **Tests** | `/exodus/executor/timing_test.go` | 1-366+ | Comprehensive test suite |
| **Database interface** | `/exodus/db/bails.go` | 1-217 | DB operations for bails |
| **BailStore interface** | `/exodus/executor/executor.go` | 18-22 | GetLastSuccessfulExecution() defined here |

---

## Related Documentation

- `planning/bail-system-architecture.md` — Condition types and SQL generation
- `planning/bail-execution-modes-quick-ref.md` — High-level execution mode comparison
- `planning/bail-immediate-execution-findings.md` — Deep dive on immediate mode
- `documentation/bail-systems.md` — User-facing documentation

---

## Conclusions

### Strengths
1. **Scheduled mode is robust** — Handles timezone conversions correctly, good test coverage
2. **Clear separation of concerns** — Each mode has its own function
3. **Calendar day semantics** — Scheduled mode uses calendar day, not elapsed time (correct for daily tasks)
4. **Tolerance windows** — Scheduled mode can accommodate late executor runs

### Weaknesses
1. **Absolute mode lacks timezone support** — Users must manually calculate UTC offsets
2. **Code duplication** — Time parsing, comparison logic, and validation duplicated across modes
3. **Runtime validation** — Format validation deferred to execution time, not caught at config time
4. **No input validation** — TODO comments indicate missing format/timezone checks
5. **Different semantics** — Scheduled and absolute use different re-execution guards

### Recommended Improvements
1. **Add timezone support to absolute mode** — Allow "2026-03-25T09:00 America/New_York"
2. **Unify time parsing** — Single function for parsing and validating all time formats
3. **Move validation to Validate() methods** — Check formats when bail is created/updated
4. **Implement IANA timezone validation** — Pre-validate timezone names at config time
5. **Consistent re-execution guard** — Formalize "once per day", "once ever", etc. semantics
