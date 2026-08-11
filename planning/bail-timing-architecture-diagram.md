# Bail Timing Architecture - Visual Reference

**Comprehensive visual guide to bail execution timing modes and their implementations.**

---

## Overall Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Kubernetes CronJob (triggers every 60 seconds)                │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ↓
        ┌────────────────────────────┐
        │   Exodus Executor Pod      │
        │   (--mode=executor)        │
        └────────────┬───────────────┘
                     │
                     ↓
     ┌───────────────────────────────────┐
     │ Load all enabled bails from DB    │ /exodus/db/bails.go:27-44
     │ (GetEnabledBails)                 │
     └────────────┬──────────────────────┘
                  │
                  ├─ Bail #1
                  ├─ Bail #2
                  └─ Bail #N
                  │
        ┌─────────↓──────────────┐
        │  For each bail...      │
        └─────────┬──────────────┘
                  │
                  ↓
       ┌──────────────────────────┐
       │ Parse Bail Definition    │ /exodus/types/types.go:12-18
       │ Validate                 │
       └──────────┬───────────────┘
                  │
                  ↓
       ┌──────────────────────────────────┐
       │ Get LastExecution timestamp      │ /exodus/executor/executor.go:126
       │ (from BailEvent table)           │
       └──────────┬───────────────────────┘
                  │
                  ↓
       ┌──────────────────────────────────────────────┐
       │ Call shouldExecute()                         │ /exodus/executor/timing.go:21-35
       │ (dispatch to mode-specific function)        │
       └──────────┬─────────────────────────────────┘
                  │
          ┌───────┼────────┐
          │       │        │
    ┌─────↓──┐ ┌──↓────┐ ┌─↓────────┐
    │immediate│ │schedul│ │absolute  │
    │:return  │ │ed:    │ │:         │
    │true     │ │check  │ │check     │
    │         │ │timing │ │timing    │
    └─────┬──┘ └──┬────┘ └─┬────────┘
          │       │        │
          └───────┼────────┘
                  │
                  ↓
         ┌─ ready to execute?
         │
    ┌────┴─────────┐
    │              │
   NO              YES
    │               │
    ↓               ↓
  SKIP         EXECUTE:
              • Query users matching conditions
              • Send bailouts
              • Record execution event
                  │
                  ↓
            ┌──────────────┐
            │ Next bail... │
            └──────────────┘
```

---

## Execution Mode Decision Tree

```
              Bail Configuration
                     │
                     ↓
         ┌─ Check "timing" field
         │
    ┌────┴──────────────────────────┐
    │                               │
    ↓                               ↓
"immediate"                    Not "immediate"?
    │                               │
    │                          ┌────┴───────┐
    │                          │            │
    │                          ↓            ↓
    │                    "scheduled"   "absolute"
    │                          │            │
    ↓                          ↓            ↓
shouldExecute()         shouldExecuteScheduled()
  case "immediate":       case "scheduled":
    return true           • Load timezone
                          • Convert now to TZ
                          • Parse HH:MM
                          • Build target datetime
                          • Check tolerance window
                          • Check calendar day
                          • Return true/false

                                       shouldExecuteAbsolute()
                                         case "absolute":
                                           • Parse datetime (ISO8601)
                                           • Check: now >= datetime?
                                           • Check: already executed?
                                           • Return true/false
```

---

## Scheduled Mode: Detailed Execution Logic

```
Input: exec (Execution), now (time.Time), lastExecution (*time.Time)
File:  /exodus/executor/timing.go:41-94

┌──────────────────────────────────────────────────────────────┐
│ shouldExecuteScheduled(exec, now, lastExecution)             │
└──────────────────────┬───────────────────────────────────────┘
                       │
        ┌──────────────↓──────────────┐
        │ Extract config fields       │ /exodus/executor/timing.go:43-45
        │  • TimeOfDay (e.g., "09:00")│
        │  • Timezone (e.g., "EST")   │
        └──────────────┬──────────────┘
                       │
     ┌─────────────────↓────────────────────┐
     │ 1. Load Timezone                     │ line 48
     │    loc := time.LoadLocation(timezone)│
     │                                      │
     │    If error → "timezone not found"   │
     └─────────────────┬────────────────────┘
                       │
     ┌─────────────────↓──────────────────────────┐
     │ 2. Convert Current Time to Target TZ       │ line 54
     │    nowInTZ := now.In(loc)                  │
     │    Example:                                │
     │      now = 2025-11-30T21:00:00Z           │
     │      timezone = Asia/Shanghai (+8)        │
     │      nowInTZ = 2025-12-01T05:00:00 CST    │
     └─────────────────┬──────────────────────────┘
                       │
     ┌─────────────────↓────────────────┐
     │ 3. Parse HH:MM Format            │ line 57-60
     │    parseTimeOfDay("09:00")       │ calls /exodus/executor/timing.go:128-153
     │    Returns: hour=9, minute=0     │
     │                                  │
     │    If error → "invalid format"   │
     └─────────────────┬────────────────┘
                       │
     ┌─────────────────↓─────────────────────────────┐
     │ 4. Build Target Datetime for TODAY in TZ      │ line 63-64
     │    y, m, d := nowInTZ.Date()                  │
     │    targetTime := Date(y, m, d, 9, 0, 0, 0, loc)
     │                                               │
     │    Example (continuing from step 2):          │
     │      nowInTZ = 2025-12-01T05:00:00 CST       │
     │      targetTime = 2025-12-01T09:00:00 CST    │
     └─────────────────┬─────────────────────────────┘
                       │
     ┌─────────────────↓────────────────────────────┐
     │ 5. Resolve Tolerance Window                  │ line 66-70
     │    if ToleranceMinutes == nil:               │
     │        tolerance = 30 minutes (default)      │
     │    else:                                     │
     │        tolerance = ToleranceMinutes minutes  │
     └─────────────────┬────────────────────────────┘
                       │
     ┌─────────────────↓──────────────────────────┐
     │ 6. Check if Now is Within Tolerance        │ line 75-78
     │    diff := now - targetTime                │
     │    if diff < 0: return false (too early)   │
     │    if diff > tolerance: return false (late)│
     │                                            │
     │    Example:                                │
     │      now = 2025-11-30T21:10:00Z            │
     │      (= 2025-12-01T05:10:00 CST)           │
     │      targetTime = 2025-12-01T09:00:00 CST  │
     │      diff = -3 hours 50 min                │
     │      → return false (too early)            │
     │                                            │
     │    OR:                                     │
     │      now = 2025-11-30T21:35:00Z            │
     │      (= 2025-12-01T05:35:00 CST)           │
     │      diff = +35 min > tolerance(30 min)    │
     │      → return false (outside window)       │
     └─────────────────┬──────────────────────────┘
                       │
     ┌─────────────────↓────────────────────────────┐
     │ 7. Check if Already Executed This Calendar  │ line 84-91
     │    Day (in Target TZ)                       │
     │                                             │
     │    if lastExecution != nil:                 │
     │        lastInTZ := lastExecution.In(loc)   │
     │        lastYear, lastMonth, lastDay := lastInTZ.Date()
     │        nowYear, nowMonth, nowDay := nowInTZ.Date()
     │                                             │
     │        if lastYear == nowYear AND           │
     │           lastMonth == nowMonth AND         │
     │           lastDay == nowDay:                │
     │            return false (already ran today) │
     └─────────────────┬────────────────────────────┘
                       │
                    ┌──↓──┐
                    │     │
                  NO      YES
                    │     │
                   ↓      ↓
               return   return
                true    false
```

---

## Absolute Mode: Detailed Execution Logic

```
Input: exec (Execution), now (time.Time), lastExecution (*time.Time)
File:  /exodus/executor/timing.go:97-124

┌──────────────────────────────────────────────────────────────┐
│ shouldExecuteAbsolute(exec, now, lastExecution)              │
└──────────────────────┬───────────────────────────────────────┘
                       │
        ┌──────────────↓──────────────┐
        │ Extract config field        │ line 99-100
        │  • Datetime (e.g.,          │
        │    "2026-03-25T14:30:00Z")  │
        └──────────────┬──────────────┘
                       │
     ┌─────────────────↓────────────────────────────┐
     │ 1. Parse Datetime (ISO 8601)                 │ line 104-111
     │    Try format #1: RFC3339 (with TZ)         │
     │      time.Parse(time.RFC3339, datetime)     │
     │      Example: "2026-03-25T14:30:00Z"        │
     │                "2026-03-25T14:30:00-05:00" │
     │                                             │
     │    If fails, try format #2: ISO8601 (no TZ) │
     │      time.Parse("2006-01-02T15:04:05", ...) │
     │      Example: "2026-03-25T14:30:00"        │
     │      → Interpreted as UTC by default        │
     │                                             │
     │    If both fail → return error              │
     └─────────────────┬────────────────────────────┘
                       │
     ┌─────────────────↓──────────────────────────┐
     │ 2. Check if Current Time >= Target Time     │ line 114-116
     │    if now.Before(targetTime):               │
     │        return false (too early)             │
     │                                            │
     │    Example:                                │
     │      now = 2026-03-25T14:00:00Z            │
     │      targetTime = 2026-03-25T14:30:00Z     │
     │      → return false (30 min too early)     │
     │                                            │
     │    OR:                                     │
     │      now = 2026-03-25T14:35:00Z            │
     │      targetTime = 2026-03-25T14:30:00Z     │
     │      → continue to step 3 (time reached)   │
     └─────────────────┬──────────────────────────┘
                       │
     ┌─────────────────↓────────────────────────┐
     │ 3. Check if Already Executed               │ line 119-121
     │    (Once-ever guard)                       │
     │                                            │
     │    if lastExecution != nil:                │
     │        return false (already executed)     │
     │                                            │
     │    Example:                                │
     │      lastExecution = 2026-03-25T14:30:15Z │
     │      → return false (prevent re-execution)│
     └─────────────────┬────────────────────────┘
                       │
                    ┌──↓──┐
                    │     │
                   YES    NO (last != nil)
                    │     │
                   ↓      ↓
               return   return
                true    false
```

---

## Configuration Schema

### Execution Type (Type Definitions)

**File:** `/exodus/types/types.go:60-66`

```go
type Execution struct {
    Timing           string  `json:"timing"`                    // REQUIRED
    TimeOfDay        *string `json:"time_of_day,omitempty"`    // scheduled only
    Timezone         *string `json:"timezone,omitempty"`       // scheduled only
    Datetime         *string `json:"datetime,omitempty"`       // absolute only
    ToleranceMinutes *int    `json:"tolerance_minutes,omitempty"` // scheduled only
}
```

### Validation Method

**File:** `/exodus/types/types.go:69-91`

```
Execution.Validate():
├─ immediate: No validation
├─ scheduled: Require time_of_day + timezone
│            (TODOs: validate formats)
└─ absolute:  Require datetime
             (TODO: validate format)
```

---

## Function Signatures

### Main Dispatcher

```go
// /exodus/executor/timing.go:21-35
func shouldExecute(execution *types.Execution, now time.Time, lastExecution *time.Time) (bool, error)
```

Returns:
- `(true, nil)` — Execute the bail
- `(false, nil)` — Skip this bail
- `(false, error)` — Configuration error

### Mode-Specific Functions

```go
// /exodus/executor/timing.go:41-94
func shouldExecuteScheduled(exec *types.Execution, now time.Time, lastExecution *time.Time) (bool, error)

// /exodus/executor/timing.go:97-124
func shouldExecuteAbsolute(exec *types.Execution, now time.Time, lastExecution *time.Time) (bool, error)
```

### Helper Functions

```go
// /exodus/executor/timing.go:128-153
func parseTimeOfDay(s string) (hour int, minute int, err error)

// /exodus/executor/timing.go:157-189
func parseDuration(s string) (time.Duration, error)  // Used by other conditions
```

---

## State Machine: Execution Decision

```
START
  │
  ├─ Bail enabled? (from database)
  │   └─ YES
  │
  ├─ Definition valid? (Validate())
  │   └─ YES
  │
  ├─ Get lastExecution timestamp
  │   └─ OK (may be nil)
  │
  ├─ Call shouldExecute()
  │   │
  │   ├─ Timing == "immediate"?
  │   │   └─ YES → return true
  │   │   └─ NO → continue
  │   │
  │   ├─ Timing == "scheduled"?
  │   │   ├─ Check timezone valid
  │   │   ├─ Check current time in tolerance window
  │   │   ├─ Check not same calendar day as last execution
  │   │   └─ Return true/false
  │   │   └─ NO → continue
  │   │
  │   ├─ Timing == "absolute"?
  │   │   ├─ Parse datetime
  │   │   ├─ Check: now >= datetime?
  │   │   ├─ Check: lastExecution == nil?
  │   │   └─ Return true/false
  │
  ├─ shouldExecute() returned true?
  │   ├─ YES:
  │   │   ├─ Query matching users
  │   │   ├─ Send bailouts
  │   │   ├─ Record execution event
  │   │   └─ DONE
  │   │
  │   └─ NO:
  │       └─ Skip (continue to next bail)
  │
  └─ END (process next bail)
```

---

## Timezone Considerations

### Supported Timezones
**Any IANA timezone name from the tz database:**

```
UTC, GMT, Etc/UTC
America/New_York, America/Los_Angeles, America/Chicago
Europe/London, Europe/Paris, Europe/Berlin
Asia/Shanghai, Asia/Tokyo, Asia/Bangkok, Asia/Kolkata
Australia/Sydney, Australia/Melbourne
Africa/Lagos, Africa/Johannesburg
[...100+ more]
```

### Timezone Data
- **Requirement:** tzdata must be embedded in binary
- **Error if missing:** `"failed to load timezone ... (is tzdata embedded?)"`
- **Go's behavior:** Automatically handles DST transitions

### Datetime with Timezone Offset (Absolute Mode)
```
RFC3339 format:
  2026-03-25T09:00:00Z            ← UTC (Z = +00:00)
  2026-03-25T09:00:00-05:00       ← Eastern Time (EST)
  2026-03-25T09:00:00+08:00       ← Shanghai Time

ISO8601 without timezone:
  2026-03-25T09:00:00             ← Ambiguous! Defaults to UTC
```

---

## Error Paths

### Invalid Timezone (Scheduled Mode)
```
shouldExecuteScheduled() → time.LoadLocation() fails
Result: (false, fmt.Errorf("failed to load timezone %q...", name))
```

### Invalid Time Format (Scheduled Mode)
```
parseTimeOfDay() → strconv.Atoi() fails or range check fails
Result: (0, 0, fmt.Errorf("invalid hour..."))
```

### Invalid Datetime Format (Absolute Mode)
```
time.Parse(RFC3339) fails AND time.Parse(ISO8601) fails
Result: (false, fmt.Errorf("invalid datetime %q...", datetime))
```

---

## Key Line References

| Function | File | Lines | Purpose |
|----------|------|-------|---------|
| `shouldExecute()` | timing.go | 21-35 | Dispatcher |
| `shouldExecuteScheduled()` | timing.go | 41-94 | Scheduled logic |
| `shouldExecuteAbsolute()` | timing.go | 97-124 | Absolute logic |
| `parseTimeOfDay()` | timing.go | 128-153 | HH:MM parser |
| `parseDuration()` | timing.go | 157-189 | Duration parser |
| `(Execution).Validate()` | types.go | 69-91 | Config validation |
| `Execution` struct | types.go | 60-66 | Type definition |
| Execution call | executor.go | 134 | Where shouldExecute() is called |

