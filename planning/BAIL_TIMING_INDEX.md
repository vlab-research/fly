# Bail Timing System - Complete Index & Navigation Guide

**Date:** 2026-03-29
**Status:** Complete Exploration
**Scope:** Absolute, scheduled, and immediate bail execution modes with timezone handling

---

## Quick Navigation

### I Just Want To Understand...

| Topic | Read This | Time |
|-------|-----------|------|
| **What are the 3 execution modes?** | [Summary](#summaries) (bail-timing-summary.md) | 5 min |
| **How does scheduled work (with timezone)?** | [Quick Ref](#quick-references) (bail-timing-quick-reference.md) | 10 min |
| **How does absolute work (no timezone)?** | [Quick Ref](#quick-references) | 10 min |
| **What's broken / needs fixing?** | [Summary](#summaries) - DRY violations section | 10 min |
| **Show me the code** | [Architecture Diagram](#architecture) | 15 min |
| **Deep technical dive** | [Deep Dive](#deep-dives) (bail-timing-deep-dive-findings.md) | 30 min |

---

## Document Structure

### Summaries
Executive-level findings and recommendations.

- **`bail-timing-summary.md`** ⭐ START HERE
  - What I found (3 execution modes)
  - Where everything is (file locations)
  - Key findings (strengths + problems)
  - DRY violations (code duplication)
  - What should be fixed (priorities)

### Quick References
Practical lookup tables and checklists.

- **`bail-timing-quick-reference.md`**
  - Modes at a glance (comparison table)
  - Type definition (Go struct)
  - Each mode explained (immediate/scheduled/absolute)
  - Code locations
  - Common patterns
  - Key differences

### Deep Dives
Comprehensive technical analysis.

- **`bail-timing-deep-dive-findings.md`**
  - Complete type definitions with context
  - Execution functions with full code
  - Detailed mode analysis (20+ pages)
  - Timezone handling explanation
  - Edge cases & gotchas (5+ scenarios)
  - DRY violations explained
  - Testing coverage analysis
  - Conclusions & recommendations

### Architecture Diagrams
Visual guides and flowcharts.

- **`bail-timing-architecture-diagram.md`**
  - Overall architecture (flow chart)
  - Execution mode decision tree
  - Scheduled mode detailed logic (with examples)
  - Absolute mode detailed logic (with examples)
  - Configuration schema
  - Function signatures
  - State machine
  - Timezone considerations
  - Error paths
  - Key line references

---

## The 3 Execution Modes

### 1. Immediate
- **Timing:** Every CronJob tick (~60 seconds)
- **Timezone:** N/A
- **Code:** Returns `true` unconditionally
- **Guard:** None
- **Use case:** Real-time reactions

### 2. Scheduled
- **Timing:** Once per calendar day at specific time
- **Timezone:** Full IANA support (America/New_York, Asia/Shanghai, etc.)
- **Code:** Full timezone-aware implementation
- **Guard:** Calendar day check
- **Use case:** Daily recurring tasks

### 3. Absolute
- **Timing:** Exactly once when current time >= specified datetime
- **Timezone:** ❌ No dedicated field (only in datetime string offset)
- **Code:** Simple parsing + once-ever check
- **Guard:** Once-ever check
- **Use case:** One-time scheduled events

---

## Key Findings at a Glance

### ✅ What Works Well
- Scheduled mode is production-ready
- Timezone handling in scheduled mode is correct
- Calendar-day semantics prevent DST issues
- Comprehensive test coverage for scheduled mode
- Clear code structure (each mode has own function)

### ❌ What's Broken
- Absolute mode has no timezone field (users must calculate UTC offsets)
- Code duplication (time parsing, re-execution logic)
- Validation happens at runtime (not at config time)
- TODO comments indicate incomplete implementation
- Different re-execution semantics (confusing)

### ⚠️ DRY Violations
1. Time parsing logic duplicated (manual vs built-in)
2. Re-execution guards use different logic (calendar day vs once-ever)
3. Validation incomplete (format validation in TODOs)
4. No unified time validation for both modes

---

## Code Locations

### Main Files
| File | Purpose | Lines |
|------|---------|-------|
| `/exodus/executor/timing.go` | All execution timing logic | 1-190 |
| `/exodus/types/types.go` | Execution type definition | 59-91 |
| `/exodus/executor/executor.go` | Integration point | 134 |
| `/exodus/executor/timing_test.go` | Test suite | 1-366+ |

### Specific Functions
| Function | File | Lines | Purpose |
|----------|------|-------|---------|
| `shouldExecute()` | timing.go | 21-35 | Main dispatcher |
| `shouldExecuteScheduled()` | timing.go | 41-94 | Scheduled logic |
| `shouldExecuteAbsolute()` | timing.go | 97-124 | Absolute logic |
| `parseTimeOfDay()` | timing.go | 128-153 | HH:MM parser |

---

## How to Use This Documentation

### For Developers Fixing Bugs
1. Start with **bail-timing-summary.md** (understand the problem)
2. Jump to **bail-timing-quick-reference.md** (mode comparison)
3. Read relevant section in **bail-timing-deep-dive-findings.md** (detailed logic)
4. Reference **bail-timing-architecture-diagram.md** (visual flowcharts)
5. Look at actual code in `/exodus/executor/timing.go`

### For Managers/PMs
1. Read **bail-timing-summary.md** (executive summary)
2. Section "What Should Be Fixed" (priorities)
3. Section "DRY Violations" (code quality)

### For QA/Testing
1. Read **bail-timing-summary.md** (modes at a glance)
2. Section "Edge Cases & Testing" in **deep-dive** (what to test)
3. Reference `/exodus/executor/timing_test.go` (existing tests)

### For Architecture Review
1. Read **bail-timing-quick-reference.md** (modes overview)
2. Read **bail-timing-architecture-diagram.md** (flow diagrams)
3. Read "Timezone Handling" in **deep-dive**
4. Read "DRY Violations" in **deep-dive**

---

## Related Documentation

**In the planning/ directory:**
- `bail-system-architecture.md` — Condition types and SQL generation
- `bail-execution-modes-quick-ref.md` — High-level execution mode comparison
- `bail-immediate-execution-findings.md` — Deep dive on immediate mode
- `bail-system-summary.md` — Earlier system summary

**In the documentation/ directory:**
- `bail-systems.md` — User-facing documentation

---

## What Was Explored

### ✅ Complete
- [x] Immediate mode implementation (trivial but documented)
- [x] Scheduled mode implementation with timezone support
- [x] Absolute mode implementation without timezone support
- [x] Type definitions and validation
- [x] Code duplication analysis
- [x] Timezone handling in scheduled mode
- [x] Missing timezone support in absolute mode
- [x] Test coverage analysis
- [x] Edge cases and gotchas
- [x] File locations and code references

### Not Explored (Out of Scope)
- [ ] Database schema for bail_events table
- [ ] Condition evaluation (separate system)
- [ ] SQL query generation
- [ ] Bail sender implementation (botserver integration)
- [ ] Message worker integration

---

## Quick Reference Tables

### Execution Mode Comparison

| Aspect | Immediate | Scheduled | Absolute |
|--------|-----------|-----------|----------|
| **Config field** | "immediate" | "scheduled" | "absolute" |
| **Frequency** | Every 60 sec | Once/day | Once ever |
| **Timezone support** | N/A | ✅ Yes | ❌ No |
| **Re-execution check** | None | Calendar day | Once-ever |
| **Tolerance window** | N/A | ✅ Configurable | N/A |
| **Required fields** | None | time_of_day, timezone | datetime |
| **Optional fields** | N/A | tolerance_minutes | N/A |
| **Error path** | Never | Timezone validation | Datetime parsing |
| **Use case** | Real-time | Daily tasks | One-time events |

### Timezone Examples (Scheduled Mode)

| Timezone | UTC Offset | Example Time | Executes At |
|----------|-----------|--------------|-------------|
| `UTC` | ±0 | 09:00 | 09:00 UTC |
| `America/New_York` | -5/-4 | 09:00 | 14:00/13:00 UTC (EDT/EST) |
| `Europe/London` | ±0/+1 | 09:00 | 09:00/08:00 UTC (GMT/BST) |
| `Asia/Shanghai` | +8 | 09:00 | 01:00 UTC |
| `Australia/Sydney` | +10/+11 | 09:00 | 23:00/22:00 UTC (AEST/AEDT) |

---

## Issue Tracker

### High Priority
- [ ] Add timezone field to absolute mode
- [ ] Implement datetime format validation
- [ ] Implement timezone name validation

### Medium Priority
- [ ] Unify time parsing logic
- [ ] Document re-execution semantics
- [ ] Add integration tests for absolute with timezone

### Low Priority
- [ ] Validate time_of_day HH:MM format
- [ ] Improve error messages
- [ ] Add timezone offset validation

---

## Testing Checklist

From `/exodus/executor/timing_test.go`:

- [x] Immediate mode: 4 tests
- [x] Scheduled mode: 30+ tests (comprehensive)
  - [x] Timezone conversions (Shanghai, Lagos, Jakarta, NY)
  - [x] Calendar day boundaries
  - [x] DST boundary crossing
  - [x] Tolerance window boundaries
  - [x] Invalid timezone names
  - [x] Missing required fields
- [x] Absolute mode: 10+ tests
  - [x] RFC3339 parsing
  - [x] ISO8601 parsing
  - [x] Past/future/now scenarios
  - [x] Once-ever guard
  - [x] Invalid format handling

---

## Answers to Your Original Questions

### Q: How does "absolute" bail work (no timezone currently)?
**A:** Parses ISO 8601 datetime, executes once when current time >= that datetime, prevents re-execution with once-ever guard. No timezone field; timezone must be in the datetime string itself (e.g., `"2026-03-25T14:30:00-05:00"`).
**File:** `/exodus/executor/timing.go:97-124`

### Q: How does "scheduled" bail work (has timezone)?
**A:** Converts current time to target timezone, checks if current time matches specified HH:MM with configurable tolerance, prevents re-execution using calendar day check (in target timezone).
**File:** `/exodus/executor/timing.go:41-94`

### Q: What underlying functions handle time/timezone?
**A:** 
- `shouldExecuteScheduled()` — Full timezone support via `time.LoadLocation()` and `.In()`
- `shouldExecuteAbsolute()` — Only RFC3339/ISO8601 parsing, no timezone field
- `parseTimeOfDay()` — Parses HH:MM string for scheduled mode
**File:** `/exodus/executor/timing.go`

### Q: Where are bail type definitions?
**A:** 
- `Execution` struct: `/exodus/types/types.go:60-66`
- `BailDefinition` struct: `/exodus/types/types.go:12-18`
- Complete validation: `/exodus/types/types.go:69-91`

### Q: Where is bail execution/processing logic?
**A:** 
- Timing decision: `/exodus/executor/timing.go:21-124`
- Processing (query + send): `/exodus/executor/executor.go:93-190`
- Integration point: `/exodus/executor/executor.go:134`

### Q: What are the DRY violations?
**A:** 
1. **Time parsing duplicated** — Manual string splitting (scheduled) vs built-in parsing (absolute)
2. **Re-execution logic duplicated** — Calendar day check (scheduled) vs once-ever check (absolute)
3. **Validation incomplete** — TODO comments for format validation in both modes
4. **No timezone for absolute** — Inconsistent with scheduled mode

See "DRY Violations & Code Duplication" in `bail-timing-deep-dive-findings.md`

---

## Document Versions

| Document | Purpose | Pages | Audience |
|----------|---------|-------|----------|
| `bail-timing-summary.md` | Executive summary | 2-3 | Everyone |
| `bail-timing-quick-reference.md` | Practical lookup | 3-4 | Developers |
| `bail-timing-deep-dive-findings.md` | Technical deep dive | 15-20 | Developers, architects |
| `bail-timing-architecture-diagram.md` | Visual flowcharts | 10-15 | Visual learners, architects |

---

## File Manifest

All findings documented in `/planning/`:

```
planning/
├── BAIL_TIMING_INDEX.md                     ← You are here
├── bail-timing-summary.md                   ← START HERE
├── bail-timing-quick-reference.md           ← Practical lookup
├── bail-timing-deep-dive-findings.md        ← Technical details
└── bail-timing-architecture-diagram.md      ← Visual flowcharts
```

Source code in:
```
exodus/
├── executor/
│   ├── timing.go                            ← Main implementation
│   ├── timing_test.go                       ← Tests
│   └── executor.go                          ← Integration point
└── types/
    └── types.go                             ← Type definitions
```

---

## Contact & Questions

For questions about this exploration:
1. Check the relevant document (use the navigation table)
2. Search for your question in the document index
3. Look at the code references provided
4. Check `/exodus/executor/timing_test.go` for examples
