package executor

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/vlab-research/exodus/types"
)

// shouldExecute determines if a bail should execute based on its timing configuration
// and the current time. It returns (true, nil) if execution should proceed, (false, nil)
// if timing conditions are not met, or (false, err) if the bail configuration is invalid.
//
// Timing types:
// - immediate: Always returns true (execute on every tick)
// - scheduled: Returns true if current time matches time_of_day in the specified timezone,
//   and no execution has occurred in the last 24 hours
// - absolute: Returns true if current time >= datetime and no prior execution has occurred
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

// defaultScheduledTolerance is used when a bail has no tolerance_minutes configured.
const defaultScheduledTolerance = 30 * time.Minute

// loadTimezone parses an IANA timezone name and returns its location.
func loadTimezone(tz string) (*time.Location, error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, fmt.Errorf("failed to load timezone %q: %w (is tzdata embedded?)", tz, err)
	}
	return loc, nil
}

// shouldExecuteScheduled checks if a scheduled bail should execute now
func shouldExecuteScheduled(exec *types.Execution, now time.Time, lastExecution *time.Time) (bool, error) {
	// Parse required fields (validation should have caught missing fields)
	if exec.TimeOfDay == nil || exec.Timezone == nil {
		return false, nil
	}

	// Load timezone
	loc, err := loadTimezone(*exec.Timezone)
	if err != nil {
		return false, err
	}

	// Convert current time to target timezone
	nowInTZ := now.In(loc)

	// Parse time_of_day
	targetHour, targetMinute, err := parseTimeOfDay(*exec.TimeOfDay)
	if err != nil {
		return false, fmt.Errorf("invalid time_of_day %q: %w", *exec.TimeOfDay, err)
	}

	// Build the target datetime for today in the target timezone
	y, m, d := nowInTZ.Date()
	targetTime := time.Date(y, m, d, targetHour, targetMinute, 0, 0, loc)

	// Resolve tolerance: use bail-level config if set, otherwise fall back to the default.
	tolerance := defaultScheduledTolerance
	if exec.ToleranceMinutes != nil {
		tolerance = time.Duration(*exec.ToleranceMinutes) * time.Minute
	}

	// Allow execution if we're within the tolerance window after the target time.
	// Using a forward-only window (0 to +tolerance) so we never fire before the
	// scheduled time, but can catch up if the executor was delayed.
	diff := now.Sub(targetTime)
	if diff < 0 || diff > tolerance {
		return false, nil
	}

	// If we have a last execution, check if it already ran today (in the target timezone).
	// Using a same-calendar-day check rather than "< 24 hours" so that a bail that
	// records its event a few seconds after the window opens doesn't permanently miss
	// the next day's window.
	if lastExecution != nil {
		lastInTZ := lastExecution.In(loc)
		ly, lm, ld := lastInTZ.Date()
		ny, nm, nd := nowInTZ.Date()
		if ly == ny && lm == nm && ld == nd {
			return false, nil
		}
	}

	return true, nil
}

// shouldExecuteAbsolute checks if an absolute-timed bail should execute now
func shouldExecuteAbsolute(exec *types.Execution, now time.Time, lastExecution *time.Time) (bool, error) {
	// Parse required fields (validation should have caught missing fields)
	if exec.Datetime == nil || exec.Timezone == nil {
		return false, nil
	}

	// Load timezone
	loc, err := loadTimezone(*exec.Timezone)
	if err != nil {
		return false, err
	}

	// Parse datetime as local time in the specified timezone (YYYY-MM-DDTHH:MM:SS)
	targetTime, err := time.ParseInLocation("2006-01-02T15:04:05", *exec.Datetime, loc)
	if err != nil {
		return false, fmt.Errorf("invalid datetime %q: must be in YYYY-MM-DDTHH:MM:SS format", *exec.Datetime)
	}

	// Don't execute if we're before the target time
	if now.Before(targetTime) {
		return false, nil
	}

	// Don't execute if we've already executed
	if lastExecution != nil {
		return false, nil
	}

	return true, nil
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
