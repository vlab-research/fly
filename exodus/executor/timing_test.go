package executor

import (
	"testing"
	"time"
)

func TestShouldExecute_Immediate(t *testing.T) {
	tests := []struct {
		name          string
		lastExecution *time.Time
		want          bool
	}{
		{
			name:          "no prior execution",
			lastExecution: nil,
			want:          true,
		},
		{
			name:          "executed 1 minute ago",
			lastExecution: timePtr(time.Now().Add(-1 * time.Minute)),
			want:          true,
		},
		{
			name:          "executed 1 hour ago",
			lastExecution: timePtr(time.Now().Add(-1 * time.Hour)),
			want:          true,
		},
		{
			name:          "executed 1 day ago",
			lastExecution: timePtr(time.Now().Add(-24 * time.Hour)),
			want:          true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bail := &Bail{
				Execution: Execution{
					Timing: "immediate",
				},
			}

			got := shouldExecute(bail, time.Now(), tt.lastExecution)
			if got != tt.want {
				t.Errorf("shouldExecute() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestShouldExecute_Scheduled(t *testing.T) {
	// Test with a fixed "now" time for predictability
	testNow := time.Date(2025, 11, 30, 15, 30, 0, 0, time.UTC)

	tests := []struct {
		name          string
		timeOfDay     string
		timezone      string
		now           time.Time
		lastExecution *time.Time
		want          bool
	}{
		{
			name:          "exact time match in UTC, no prior execution",
			timeOfDay:     "15:30",
			timezone:      "UTC",
			now:           testNow,
			lastExecution: nil,
			want:          true,
		},
		{
			name:          "wrong hour",
			timeOfDay:     "14:30",
			timezone:      "UTC",
			now:           testNow,
			lastExecution: nil,
			want:          false,
		},
		{
			name:          "wrong minute",
			timeOfDay:     "15:31",
			timezone:      "UTC",
			now:           testNow,
			lastExecution: nil,
			want:          false,
		},
		{
			name:          "executed 23 hours ago - should not execute",
			timeOfDay:     "15:30",
			timezone:      "UTC",
			now:           testNow,
			lastExecution: timePtr(testNow.Add(-23 * time.Hour)),
			want:          false,
		},
		{
			name:          "executed exactly 24 hours ago - should execute",
			timeOfDay:     "15:30",
			timezone:      "UTC",
			now:           testNow,
			lastExecution: timePtr(testNow.Add(-24 * time.Hour)),
			want:          true,
		},
		{
			name:          "executed 25 hours ago - should execute",
			timeOfDay:     "15:30",
			timezone:      "UTC",
			now:           testNow,
			lastExecution: timePtr(testNow.Add(-25 * time.Hour)),
			want:          true,
		},
		{
			name:      "timezone conversion - Africa/Lagos (UTC+1)",
			timeOfDay: "16:30", // 16:30 in Lagos = 15:30 UTC
			timezone:  "Africa/Lagos",
			now:       testNow, // 15:30 UTC
			want:      true,
		},
		{
			name:      "timezone conversion - Asia/Jakarta (UTC+7)",
			timeOfDay: "22:30", // 22:30 in Jakarta = 15:30 UTC
			timezone:  "Asia/Jakarta",
			now:       testNow, // 15:30 UTC
			want:      true,
		},
		{
			name:      "timezone conversion - America/New_York (UTC-5)",
			timeOfDay: "10:30", // 10:30 in NY = 15:30 UTC (during EST)
			timezone:  "America/New_York",
			now:       testNow, // 15:30 UTC
			want:      true,
		},
		{
			name:      "midnight in UTC",
			timeOfDay: "00:00",
			timezone:  "UTC",
			now:       time.Date(2025, 11, 30, 0, 0, 0, 0, time.UTC),
			want:      true,
		},
		{
			name:      "23:59 in UTC",
			timeOfDay: "23:59",
			timezone:  "UTC",
			now:       time.Date(2025, 11, 30, 23, 59, 0, 0, time.UTC),
			want:      true,
		},
		{
			name:      "invalid timezone",
			timeOfDay: "15:30",
			timezone:  "Invalid/Timezone",
			now:       testNow,
			want:      false,
		},
		{
			name:      "missing time_of_day",
			timezone:  "UTC",
			now:       testNow,
			want:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bail := &Bail{
				Execution: Execution{
					Timing:   "scheduled",
					Timezone: &tt.timezone,
				},
			}

			if tt.timeOfDay != "" {
				bail.Execution.TimeOfDay = &tt.timeOfDay
			}

			got := shouldExecute(bail, tt.now, tt.lastExecution)
			if got != tt.want {
				t.Errorf("shouldExecute() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestShouldExecute_Absolute(t *testing.T) {
	testNow := time.Date(2025, 11, 30, 15, 30, 0, 0, time.UTC)

	tests := []struct {
		name          string
		datetime      string
		now           time.Time
		lastExecution *time.Time
		want          bool
	}{
		{
			name:          "datetime is now, no prior execution",
			datetime:      "2025-11-30T15:30:00Z",
			now:           testNow,
			lastExecution: nil,
			want:          true,
		},
		{
			name:          "datetime is in the past, no prior execution",
			datetime:      "2025-11-30T14:00:00Z",
			now:           testNow,
			lastExecution: nil,
			want:          true,
		},
		{
			name:          "datetime is in the future",
			datetime:      "2025-11-30T16:00:00Z",
			now:           testNow,
			lastExecution: nil,
			want:          false,
		},
		{
			name:          "datetime passed, but already executed",
			datetime:      "2025-11-30T14:00:00Z",
			now:           testNow,
			lastExecution: timePtr(time.Date(2025, 11, 30, 14, 5, 0, 0, time.UTC)),
			want:          false,
		},
		{
			name:          "datetime passed, executed long ago (should still not re-execute)",
			datetime:      "2025-11-30T14:00:00Z",
			now:           testNow,
			lastExecution: timePtr(time.Date(2025, 11, 29, 14, 0, 0, 0, time.UTC)),
			want:          false,
		},
		{
			name:     "datetime format without timezone",
			datetime: "2025-11-30T15:30:00",
			now:      testNow,
			want:     true,
		},
		{
			name:     "datetime with positive timezone offset",
			datetime: "2025-11-30T16:30:00+01:00",
			now:      testNow, // 15:30 UTC = 16:30 +01:00
			want:     true,
		},
		{
			name:     "datetime with negative timezone offset",
			datetime: "2025-11-30T10:30:00-05:00",
			now:      testNow, // 15:30 UTC = 10:30 -05:00
			want:     true,
		},
		{
			name:     "invalid datetime format",
			datetime: "not-a-date",
			now:      testNow,
			want:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bail := &Bail{
				Execution: Execution{
					Timing:   "absolute",
					Datetime: &tt.datetime,
				},
			}

			got := shouldExecute(bail, tt.now, tt.lastExecution)
			if got != tt.want {
				t.Errorf("shouldExecute() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestParseTimeOfDay(t *testing.T) {
	tests := []struct {
		name       string
		input      string
		wantHour   int
		wantMinute int
		wantErr    bool
	}{
		{
			name:       "valid morning time",
			input:      "09:30",
			wantHour:   9,
			wantMinute: 30,
			wantErr:    false,
		},
		{
			name:       "valid afternoon time",
			input:      "15:45",
			wantHour:   15,
			wantMinute: 45,
			wantErr:    false,
		},
		{
			name:       "midnight",
			input:      "00:00",
			wantHour:   0,
			wantMinute: 0,
			wantErr:    false,
		},
		{
			name:       "end of day",
			input:      "23:59",
			wantHour:   23,
			wantMinute: 59,
			wantErr:    false,
		},
		{
			name:    "invalid format - no colon",
			input:   "1530",
			wantErr: true,
		},
		{
			name:    "invalid format - too many parts",
			input:   "15:30:00",
			wantErr: true,
		},
		{
			name:    "invalid hour - negative",
			input:   "-1:30",
			wantErr: true,
		},
		{
			name:    "invalid hour - too large",
			input:   "24:30",
			wantErr: true,
		},
		{
			name:    "invalid minute - negative",
			input:   "15:-1",
			wantErr: true,
		},
		{
			name:    "invalid minute - too large",
			input:   "15:60",
			wantErr: true,
		},
		{
			name:    "invalid hour - not a number",
			input:   "xx:30",
			wantErr: true,
		},
		{
			name:    "invalid minute - not a number",
			input:   "15:xx",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotHour, gotMinute, err := parseTimeOfDay(tt.input)

			if tt.wantErr {
				if err == nil {
					t.Errorf("parseTimeOfDay() expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Errorf("parseTimeOfDay() unexpected error: %v", err)
				return
			}

			if gotHour != tt.wantHour {
				t.Errorf("parseTimeOfDay() hour = %v, want %v", gotHour, tt.wantHour)
			}

			if gotMinute != tt.wantMinute {
				t.Errorf("parseTimeOfDay() minute = %v, want %v", gotMinute, tt.wantMinute)
			}
		})
	}
}

func TestParseDuration(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    time.Duration
		wantErr bool
	}{
		{
			name:    "seconds singular",
			input:   "30 second",
			want:    30 * time.Second,
			wantErr: false,
		},
		{
			name:    "seconds plural",
			input:   "45 seconds",
			want:    45 * time.Second,
			wantErr: false,
		},
		{
			name:    "minutes singular",
			input:   "1 minute",
			want:    1 * time.Minute,
			wantErr: false,
		},
		{
			name:    "minutes plural",
			input:   "30 minutes",
			want:    30 * time.Minute,
			wantErr: false,
		},
		{
			name:    "hours singular",
			input:   "1 hour",
			want:    1 * time.Hour,
			wantErr: false,
		},
		{
			name:    "hours plural",
			input:   "3 hours",
			want:    3 * time.Hour,
			wantErr: false,
		},
		{
			name:    "days singular",
			input:   "1 day",
			want:    24 * time.Hour,
			wantErr: false,
		},
		{
			name:    "days plural",
			input:   "7 days",
			want:    7 * 24 * time.Hour,
			wantErr: false,
		},
		{
			name:    "weeks singular",
			input:   "1 week",
			want:    7 * 24 * time.Hour,
			wantErr: false,
		},
		{
			name:    "weeks plural",
			input:   "4 weeks",
			want:    4 * 7 * 24 * time.Hour,
			wantErr: false,
		},
		{
			name:    "zero duration",
			input:   "0 hours",
			want:    0,
			wantErr: false,
		},
		{
			name:    "invalid format - no space",
			input:   "30seconds",
			wantErr: true,
		},
		{
			name:    "invalid format - too many parts",
			input:   "30 seconds extra",
			wantErr: true,
		},
		{
			name:    "invalid value - not a number",
			input:   "abc hours",
			wantErr: true,
		},
		{
			name:    "invalid value - negative",
			input:   "-5 hours",
			wantErr: true,
		},
		{
			name:    "invalid unit",
			input:   "30 years",
			wantErr: true,
		},
		{
			name:    "case insensitive units",
			input:   "2 HOURS",
			want:    2 * time.Hour,
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseDuration(tt.input)

			if tt.wantErr {
				if err == nil {
					t.Errorf("parseDuration() expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Errorf("parseDuration() unexpected error: %v", err)
				return
			}

			if got != tt.want {
				t.Errorf("parseDuration() = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestScheduled_DSTTransition tests scheduled execution around DST transitions
func TestScheduled_DSTTransition(t *testing.T) {
	// US DST 2025: Begins March 9 at 2:00 AM, Ends November 2 at 2:00 AM

	tests := []struct {
		name          string
		timeOfDay     string
		timezone      string
		now           time.Time
		lastExecution *time.Time
		want          bool
	}{
		{
			name:      "before DST spring forward",
			timeOfDay: "10:00",
			timezone:  "America/New_York",
			now:       time.Date(2025, 3, 8, 15, 0, 0, 0, time.UTC), // 10:00 EST
			want:      true,
		},
		{
			name:      "after DST spring forward",
			timeOfDay: "10:00",
			timezone:  "America/New_York",
			now:       time.Date(2025, 3, 10, 14, 0, 0, 0, time.UTC), // 10:00 EDT
			want:      true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bail := &Bail{
				Execution: Execution{
					Timing:    "scheduled",
					TimeOfDay: &tt.timeOfDay,
					Timezone:  &tt.timezone,
				},
			}

			got := shouldExecute(bail, tt.now, tt.lastExecution)
			if got != tt.want {
				t.Errorf("shouldExecute() = %v, want %v", got, tt.want)
			}
		})
	}
}

// Helper function to create time pointer
func timePtr(t time.Time) *time.Time {
	return &t
}
