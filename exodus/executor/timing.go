package executor

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Bail represents the minimal bail structure needed for timing logic
// This avoids circular dependencies with the main package
type Bail struct {
	Execution Execution
}

// Execution represents the timing configuration for a bail
type Execution struct {
	Timing    string
	TimeOfDay *string
	Timezone  *string
	Datetime  *string
}

// shouldExecute determines if a bail should execute based on its timing configuration
// and the current time. It returns true if execution should proceed.
//
// Timing types:
// - immediate: Always returns true (execute on every tick)
// - scheduled: Returns true if current time matches time_of_day in the specified timezone,
//   and no execution has occurred in the last 24 hours
// - absolute: Returns true if current time >= datetime and no prior execution has occurred
func shouldExecute(bail *Bail, now time.Time, lastExecution *time.Time) bool {
	switch bail.Execution.Timing {
	case "immediate":
		return true

	case "scheduled":
		return shouldExecuteScheduled(bail.Execution, now, lastExecution)

	case "absolute":
		return shouldExecuteAbsolute(bail.Execution, now, lastExecution)

	default:
		// This should never happen if validation is correct, but fail fast if it does
		return false
	}
}

// shouldExecuteScheduled checks if a scheduled bail should execute now
func shouldExecuteScheduled(exec Execution, now time.Time, lastExecution *time.Time) bool {
	// Parse required fields (validation should have caught missing fields)
	if exec.TimeOfDay == nil || exec.Timezone == nil {
		return false
	}

	// Load timezone
	loc, err := time.LoadLocation(*exec.Timezone)
	if err != nil {
		// Invalid timezone - fail fast
		return false
	}

	// Convert current time to target timezone
	nowInTZ := now.In(loc)

	// Parse time_of_day
	targetHour, targetMinute, err := parseTimeOfDay(*exec.TimeOfDay)
	if err != nil {
		return false
	}

	// Check if current time matches the target time (minute precision)
	if nowInTZ.Hour() != targetHour || nowInTZ.Minute() != targetMinute {
		return false
	}

	// If we have a last execution, check if it was within the last 24 hours
	if lastExecution != nil {
		hoursSinceLastExecution := now.Sub(*lastExecution).Hours()
		if hoursSinceLastExecution < 24 {
			return false
		}
	}

	return true
}

// shouldExecuteAbsolute checks if an absolute-timed bail should execute now
func shouldExecuteAbsolute(exec Execution, now time.Time, lastExecution *time.Time) bool {
	// Parse required field (validation should have caught missing field)
	if exec.Datetime == nil {
		return false
	}

	// Parse datetime (ISO 8601 format)
	targetTime, err := time.Parse(time.RFC3339, *exec.Datetime)
	if err != nil {
		// Try alternate ISO 8601 format without timezone
		targetTime, err = time.Parse("2006-01-02T15:04:05", *exec.Datetime)
		if err != nil {
			return false
		}
	}

	// Don't execute if we're before the target time
	if now.Before(targetTime) {
		return false
	}

	// Don't execute if we've already executed
	if lastExecution != nil {
		return false
	}

	return true
}

// parseTimeOfDay parses a time string in HH:MM format
// Returns hour (0-23) and minute (0-59)
func parseTimeOfDay(s string) (hour int, minute int, err error) {
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid time_of_day format: %s (expected HH:MM)", s)
	}

	hour, err = strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("invalid hour in time_of_day: %s", parts[0])
	}

	minute, err = strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, fmt.Errorf("invalid minute in time_of_day: %s", parts[1])
	}

	if hour < 0 || hour > 23 {
		return 0, 0, fmt.Errorf("hour must be between 0 and 23, got %d", hour)
	}

	if minute < 0 || minute > 59 {
		return 0, 0, fmt.Errorf("minute must be between 0 and 59, got %d", minute)
	}

	return hour, minute, nil
}

// parseDuration parses a duration string like "4 weeks", "2 days", "3 hours"
// Returns a time.Duration representing the parsed duration
func parseDuration(s string) (time.Duration, error) {
	parts := strings.Fields(s)
	if len(parts) != 2 {
		return 0, fmt.Errorf("invalid duration format: %s (expected '<number> <unit>')", s)
	}

	value, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, fmt.Errorf("invalid duration value: %s", parts[0])
	}

	if value < 0 {
		return 0, fmt.Errorf("duration value must be non-negative, got %d", value)
	}

	unit := strings.ToLower(parts[1])

	// Handle both singular and plural forms
	switch unit {
	case "second", "seconds":
		return time.Duration(value) * time.Second, nil
	case "minute", "minutes":
		return time.Duration(value) * time.Minute, nil
	case "hour", "hours":
		return time.Duration(value) * time.Hour, nil
	case "day", "days":
		return time.Duration(value) * 24 * time.Hour, nil
	case "week", "weeks":
		return time.Duration(value) * 7 * 24 * time.Hour, nil
	default:
		return 0, fmt.Errorf("unsupported duration unit: %s (supported: seconds, minutes, hours, days, weeks)", unit)
	}
}
