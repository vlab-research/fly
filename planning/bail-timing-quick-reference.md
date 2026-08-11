# Bail Timing Systems - Quick Reference

**Quick lookup for absolute, scheduled, and immediate bail execution modes.**

---

## Modes at a Glance

| Aspect | Immediate | Scheduled | Absolute |
|--------|-----------|-----------|----------|
| **Timing Field** | `timing: "immediate"` | `timing: "scheduled"` | `timing: "absolute"` |
| **Required Config** | None | `time_of_day`, `timezone` | `datetime` |
| **Timezone Support** | N/A | ✅ Full (IANA) | ❌ Only if in datetime string |
| **Executes How Often** | Every executor tick (~60 sec) | Once per calendar day | Once ever |
| **Re-execution Guard** | None | Calendar day check | Once-ever check |
| **Tolerance Window** | N/A | 30 min default (configurable) | None |

---

## Type Definition

```go
type Execution struct {
    Timing           string  // "immediate", "scheduled", or "absolute"
    TimeOfDay        *string // e.g., "09:00" (scheduled only)
    Timezone         *string // e.g., "America/New_York" (scheduled only)
    Datetime         *string // e.g., "2026-03-25T14:30:00Z" (absolute only)
    ToleranceMinutes *int    // e.g., 30 (scheduled only, optional)
}
```

---

## Immediate Mode

**Code:** `/exodus/executor/timing.go` lines 23-24

```go
case "immediate":
    return true, nil
```

**What it does:**
- Returns `true` on every check
- Executes on every CronJob trigger (typically every 60 seconds)
- No timing condition, no cooldown

**Example JSON:**
```json
{
    "execution": {
        "timing": "immediate"
    }
}
```

**Rate limiting:**
- Individual bailouts are rate-limited to 1/second (in sender.go)
- Does NOT prevent same user being bailed in consecutive minutes

---

## Scheduled Mode

**Code:** `/exodus/executor/timing.go` lines 41-94

**What it does:**
1. Converts current time to target timezone
2. Builds target datetime for TODAY at specified time
3. Checks if now is within tolerance after target time
4. Checks if already executed on this calendar day
5. Returns true if all checks pass

**Execution flow:**

```
now ──> [load timezone] ──> [convert to TZ] ──> [parse HH:MM] ──> [build target time]
                                                                         │
                                                                         ↓
                                  [check: now >= target?] ◄─── [check: within tolerance?] ◄──
                                         │
                        ┌────────────────┴────────────────┐
                        │                                  │
                      NO (skip)                         YES (continue)
                                                          │
                                                          ↓
                                  [check: same calendar day as lastExecution?]
                                         │
                        ┌────────────────┴────────────────┐
                        │                                  │
                      YES (skip)                         NO (execute)
                                                          │
                                                          ↓
                                                      return TRUE
```

**Required configuration:**

```json
{
    "execution": {
        "timing": "scheduled",
        "time_of_day": "09:00",
        "timezone": "America/New_York"
    }
}
```

**Optional configuration:**

```json
{
    "execution": {
        "timing": "scheduled",
        "time_of_day": "09:00",
        "timezone": "America/New_York",
        "tolerance_minutes": 60
    }
}
```

**Key points:**
- **time_of_day** must be in `HH:MM` format (24-hour)
- **timezone** must be valid IANA timezone name (e.g., "UTC", "America/Los_Angeles", "Asia/Shanghai")
- **tolerance_minutes** defaults to 30 if not specified
- Executes once per calendar day in the target timezone
- Tolerance window is forward-only: `[target_time, target_time + tolerance]`

**Timezone examples:**

| Name | UTC Offset | Example |
|------|-----------|---------|
| `UTC` | ±0 | Matches UTC 09:00 exactly |
| `America/New_York` | -5 (EST) / -4 (EDT) | 09:00 Eastern = 13:00/14:00 UTC |
| `Europe/London` | ±0 / +1 | Depends on BST |
| `Asia/Shanghai` | +8 | 09:00 Shanghai = 01:00 UTC |

---

## Absolute Mode

**Code:** `/exodus/executor/timing.go` lines 97-124

**What it does:**
1. Parses datetime (ISO 8601 format)
2. Checks if now >= datetime
3. Checks if already executed (once-ever guard)
4. Returns true only on first time >= datetime

**Execution flow:**

```
datetime ──> [parse ISO 8601] ──> [check: now >= datetime?]
                                         │
                        ┌────────────────┴────────────────┐
                        │                                  │
                      NO (skip)                         YES (continue)
                                                          │
                                                          ↓
                                  [check: lastExecution != nil?]
                                         │
                        ┌────────────────┴────────────────┐
                        │                                  │
                      YES (skip)                         NO (execute)
                                                          │
                                                          ↓
                                                      return TRUE
```

**Required configuration:**

```json
{
    "execution": {
        "timing": "absolute",
        "datetime": "2026-03-25T14:30:00Z"
    }
}
```

**Supported datetime formats:**
1. RFC3339 (with timezone): `2026-03-25T14:30:00Z` or `2026-03-25T14:30:00-05:00`
2. ISO8601 (without timezone): `2026-03-25T14:30:00` (interpreted as UTC)

**Key points:**
- Executes exactly once when current time >= datetime
- ❌ No timezone field available (use datetime offset instead)
- No tolerance window
- No re-execution possible (once-ever guard)

**Warning — No timezone field:**

If you want 9 AM Shanghai time on March 25:
- ❌ WRONG: `"datetime": "2026-03-25T09:00:00"` (this is UTC, 8 hours too early)
- ✅ RIGHT: `"datetime": "2026-03-25T01:00:00Z"` (9 AM Shanghai = 1 AM UTC)
- ✅ RIGHT: `"datetime": "2026-03-25T09:00:00+08:00"` (explicit offset)

---

## Timezone Handling

### For Scheduled Mode

```go
loc, err := time.LoadLocation(*exec.Timezone)
if err != nil {
    return false, fmt.Errorf("failed to load timezone %q: %w (is tzdata embedded?)", *exec.Timezone, err)
}
nowInTZ := now.In(loc)
```

**Requirements:**
- Valid IANA timezone name (e.g., "America/New_York", not "EST")
- tzdata must be embedded in binary (checked at runtime)
- DST transitions handled automatically by Go's time library

**Valid timezone formats:**
- UTC: `"UTC"`, `"GMT"`, `"Etc/UTC"`
- US: `"America/New_York"`, `"America/Los_Angeles"`, `"America/Chicago"`
- Europe: `"Europe/London"`, `"Europe/Paris"`, `"Europe/Berlin"`
- Asia: `"Asia/Shanghai"`, `"Asia/Tokyo"`, `"Asia/Bangkok"`
- Australia: `"Australia/Sydney"`, `"Australia/Melbourne"`
- [Full list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)

### For Absolute Mode

Timezone is **part of the datetime string**:

```
2026-03-25T09:00:00Z          ← UTC (Z = +00:00)
2026-03-25T09:00:00-05:00     ← Eastern Time (EST, UTC-5)
2026-03-25T09:00:00+08:00     ← Shanghai (UTC+8)
2026-03-25T09:00:00           ← Ambiguous! Defaults to UTC
```

---

## Code Locations

| Function | File | Lines | Purpose |
|----------|------|-------|---------|
| `shouldExecute()` | `exodus/executor/timing.go` | 21-35 | Main dispatcher |
| `shouldExecuteScheduled()` | `exodus/executor/timing.go` | 41-94 | Scheduled logic |
| `shouldExecuteAbsolute()` | `exodus/executor/timing.go` | 97-124 | Absolute logic |
| `(Execution).Validate()` | `exodus/types/types.go` | 69-91 | Validation |
| **Called from** | `exodus/executor/executor.go` | 134 | In `processBail()` |

---

## Common Patterns

### Daily Report at 9 AM Eastern Time

```json
{
    "execution": {
        "timing": "scheduled",
        "time_of_day": "09:00",
        "timezone": "America/New_York"
    }
}
```

### One-Time Event on Specific Date/Time

```json
{
    "execution": {
        "timing": "absolute",
        "datetime": "2026-04-15T14:30:00-04:00"  // EDT (UTC-4)
    }
}
```

### Real-Time Reaction (Every Minute)

```json
{
    "execution": {
        "timing": "immediate"
    }
}
```

### Scheduled with Extended Tolerance (1 hour window)

```json
{
    "execution": {
        "timing": "scheduled",
        "time_of_day": "15:00",
        "timezone": "UTC",
        "tolerance_minutes": 60
    }
}
```

---

## Key Differences Summary

### Scheduled vs Absolute Timing

| Aspect | Scheduled | Absolute |
|--------|-----------|----------|
| **Repeats?** | Yes, daily | No, once only |
| **Timezone** | Required field | In datetime string only |
| **Window** | Time ± tolerance | Instant >= datetime |
| **Guard** | Calendar day check | Once-ever check |
| **Use case** | Daily tasks | One-time events |

### DRY Issues to Fix

1. **Time parsing duplicated** — Scheduled uses manual parsing, absolute uses Go's parsing
2. **Re-execution logic different** — Scheduled checks calendar day, absolute checks "ever executed"
3. **Validation incomplete** — TODOs in types.go for format validation
4. **No timezone for absolute** — Should support both modes identically

---

## Testing

### Test File
`/exodus/executor/timing_test.go`

### Test Coverage

- **Immediate:** 4 basic tests (all pass because it always returns true)
- **Scheduled:** 30+ tests including timezone conversions, DST boundaries, tolerance windows
- **Absolute:** 10+ tests for parsing and timing logic

### Edge Cases Tested

- [x] Timezone conversions (Shanghai, Lagos, Jakarta, New York)
- [x] Calendar day boundaries with different timezones
- [x] Midnight and end-of-day times
- [x] Tolerance window boundaries
- [x] Invalid timezone names
- [x] Missing required fields
- [x] Past vs future datetime in absolute mode

---

## See Also

- **Deep Dive:** `planning/bail-timing-deep-dive-findings.md`
- **Architecture:** `planning/bail-system-architecture.md`
- **Execution Modes:** `planning/bail-execution-modes-quick-ref.md`
