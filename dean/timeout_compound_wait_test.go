package main

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Tests for states.timeout_date as defined by
// devops/migrations/34-states-timeout-date-compound-wait.sql (Linear VIR-28),
// and for dean's Timeouts query over it. The semantics are documented in
// documentation/waits-and-timeouts.md.

// fixedWaitStart is 2023-11-14T22:13:20Z. A fixed start makes every expected
// timeout_date exact.
const fixedWaitStart int64 = 1700000000000

var fixedStart = time.UnixMilli(fixedWaitStart).UTC()

func insertWait(t *testing.T, pool *pgxpool.Pool, userid string, waitStart int64, wait string) {
	t.Helper()
	mustExec(t, pool, insertQuery, userid, "bar", time.Now().UTC(), "WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state":"WAIT_EXTERNAL_EVENT","forms":["compound"],"waitStart":%v,"md":{"startTime":%v},"wait":%v}`,
			waitStart, waitStart, wait))
}

func timeoutDate(t *testing.T, pool *pgxpool.Pool, userid string) *time.Time {
	t.Helper()
	var d *time.Time
	err := pool.QueryRow(context.Background(), `SELECT timeout_date FROM states WHERE userid = $1`, userid).Scan(&d)
	require.NoError(t, err)
	if d != nil {
		u := d.UTC()
		return &u
	}
	return nil
}

func setupCompound(t *testing.T) *pgxpool.Pool {
	pool := testPool()
	before(pool)
	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "bar"}`)
	mustExec(t, pool, surveyInsertSql, "compound", time.Unix(0, 0).UTC(), "{}")
	return pool
}

func TestTimeoutDate_Schedules(t *testing.T) {
	pool := setupCompound(t)
	defer pool.Close()

	cases := []struct {
		name string
		wait string
		want *time.Duration
	}{
		// The shapes 07 already handled must compute exactly as before.
		{"top-level string", `{"type":"timeout","value":"20 minutes"}`, dur(20 * time.Minute)},
		{"top-level relative object", `{"type":"timeout","value":{"type":"relative","timeout":"2 days"}}`, dur(48 * time.Hour)},

		// VIR-28: the timeout arm of a compound wait.
		{"or: string arm", `{"op":"or","vars":[{"type":"external","value":{"type":"moviehouse:play","id":"v"}},{"type":"timeout","value":"1 day"}]}`, dur(24 * time.Hour)},
		{"or: relative object arm", `{"op":"or","vars":[{"type":"timeout","value":{"type":"relative","timeout":"1 hour"}},{"type":"external","value":{"type":"linksniffer:click"}}]}`, dur(time.Hour)},
		{"or: earliest of two timeout arms", `{"op":"or","vars":[{"type":"timeout","value":"3 hours"},{"type":"timeout","value":"1 hour"},{"type":"external","value":{"type":"x"}}]}`, dur(time.Hour)},
		{"and: latest of two timeout arms", `{"op":"and","vars":[{"type":"timeout","value":"3 hours"},{"type":"timeout","value":"1 hour"},{"type":"external","value":{"type":"x"}}]}`, dur(3 * time.Hour)},
		{"and: event plus timeout", `{"op":"and","vars":[{"type":"external","value":{"type":"moviehouse:play","id":"v"}},{"type":"timeout","value":"2 hours"}]}`, dur(2 * time.Hour)},
		{"or: fourth arm is read", `{"op":"or","vars":[{"type":"external","value":{"type":"a"}},{"type":"external","value":{"type":"b"}},{"type":"external","value":{"type":"c"}},{"type":"timeout","value":"5 minutes"}]}`, dur(5 * time.Minute)},
		{"or: unschedulable arm ignored", `{"op":"or","vars":[{"type":"timeout","value":"soon"},{"type":"timeout","value":"2 hours"}]}`, dur(2 * time.Hour)},

		// Wider interval syntax, top level and nested alike.
		{"90 mins", `{"type":"timeout","value":"90 mins"}`, dur(90 * time.Minute)},
		{"1.5 hours", `{"type":"timeout","value":"1.5 hours"}`, dur(90 * time.Minute)},
		{"1 day 2 hours", `{"type":"timeout","value":"1 day 2 hours"}`, dur(26 * time.Hour)},
		{"abbreviations", `{"type":"timeout","value":"1h30m"}`, dur(90 * time.Minute)},
		{"case-insensitive", `{"type":"timeout","value":"2 Hours"}`, dur(2 * time.Hour)},
		{"surrounding spaces", `{"type":"timeout","value":" 1 week "}`, dur(7 * 24 * time.Hour)},
		{"nested wider syntax", `{"op":"or","vars":[{"type":"external","value":{"type":"x"}},{"type":"timeout","value":{"type":"relative","timeout":"1 day 2 hours"}}]}`, dur(26 * time.Hour)},

		// Not scheduled: no timeout arm, or a shape outside the supported set.
		{"or: no timeout arm", `{"op":"or","vars":[{"type":"external","value":{"type":"a"}},{"type":"external","value":{"type":"b"}}]}`, nil},
		{"or: fifth arm is not read", `{"op":"or","vars":[{"type":"external","value":{"type":"a"}},{"type":"external","value":{"type":"b"}},{"type":"external","value":{"type":"c"}},{"type":"external","value":{"type":"d"}},{"type":"timeout","value":"5 minutes"}]}`, nil},
		{"nested compound", `{"op":"or","vars":[{"op":"or","vars":[{"type":"timeout","value":"1 hour"}]}]}`, nil},
		{"unknown op", `{"op":"xor","vars":[{"type":"timeout","value":"1 hour"}]}`, nil},
		{"external wait", `{"type":"external","value":{"type":"moviehouse:play"}}`, nil},
		{"variable timeout", `{"type":"timeout","value":{"type":"relative","variable":"reminder"}}`, nil},
		{"unit missing", `{"type":"timeout","value":"90"}`, nil},
		{"unknown unit", `{"type":"timeout","value":"2 fortnights"}`, nil},
		{"four parts", `{"type":"timeout","value":"1 day 1 hour 1 minute 1 second"}`, nil},
	}

	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			user := fmt.Sprintf("u%d", i)
			insertWait(t, pool, user, fixedWaitStart, c.wait)
			got := timeoutDate(t, pool, user)
			if c.want == nil {
				assert.Nil(t, got, "wait %s", c.wait)
				return
			}
			require.NotNil(t, got, "wait %s", c.wait)
			assert.Equal(t, fixedStart.Add(*c.want), *got, "wait %s", c.wait)
		})
	}
}

func TestTimeoutDate_TopLevelAbsoluteUnchanged(t *testing.T) {
	pool := setupCompound(t)
	defer pool.Close()

	insertWait(t, pool, "abs", fixedWaitStart, `{"type":"timeout","value":{"type":"absolute","timeout":"2026-09-01 12:00"}}`)
	got := timeoutDate(t, pool, "abs")
	require.NotNil(t, got)
	assert.Equal(t, time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC), *got)
}

// A computed-column error fails the write, and the states sink treats a failed
// write as fatal. Every one of these must insert and compute NULL.
func TestTimeoutDate_NeverFailsTheWrite(t *testing.T) {
	pool := setupCompound(t)
	defer pool.Close()

	waits := []string{
		// Would overflow TIMESTAMP if admitted.
		`{"type":"timeout","value":"999999 years"}`,
		`{"type":"timeout","value":"9999999999 seconds"}`,
		`{"op":"or","vars":[{"type":"timeout","value":"99999999999999999999 hours"}]}`,
		// parse_timestamp raises on these, so absolute arms are not read inside a compound.
		`{"op":"or","vars":[{"type":"timeout","value":{"type":"absolute","timeout":"not a date"}}]}`,
		`{"op":"and","vars":[{"type":"timeout","value":{"type":"absolute","timeout":"2026-02-31 12:00"}}]}`,
		// Malformed compounds.
		`{"op":"or","vars":"not an array"}`,
		`{"op":"or"}`,
		`{"op":"or","vars":[null, 3, "1 hour"]}`,
		`{"op":"or","vars":[{"type":"timeout","value":null}]}`,
		`{"op":"or","vars":[{"type":"timeout","value":{"type":"relative","timeout":7}}]}`,
	}

	for i, w := range waits {
		user := fmt.Sprintf("bad%d", i)
		insertWait(t, pool, user, fixedWaitStart, w)
		assert.Nil(t, timeoutDate(t, pool, user), "wait %s", w)
	}
}

// End to end at the SQL level: dean selects a matured compound-wait timeout,
// and emits the event replybot matches against the wait (value == waitStart).
func TestGetTimeouts_FiresMaturedCompoundWait(t *testing.T) {
	pool := setupCompound(t)
	defer pool.Close()

	matured := time.Now().UTC().Add(-25*time.Hour).Unix() * 1000
	pending := time.Now().UTC().Add(-1*time.Hour).Unix() * 1000

	orWait := `{"op":"or","vars":[{"type":"external","value":{"type":"moviehouse:play","id":"v"}},{"type":"timeout","value":"1 day"}]}`
	andWait := `{"op":"and","vars":[{"type":"external","value":{"type":"moviehouse:play","id":"v"}},{"type":"timeout","value":"1 day"}]}`
	noTimeout := `{"op":"or","vars":[{"type":"external","value":{"type":"moviehouse:play","id":"v"}},{"type":"external","value":{"type":"linksniffer:click"}}]}`

	insertWait(t, pool, "or-matured", matured, orWait)
	insertWait(t, pool, "and-matured", matured, andWait)
	insertWait(t, pool, "or-pending", pending, orWait)
	insertWait(t, pool, "no-timeout-arm", matured, noTimeout)

	cfg := &Config{TimeoutMaxPast: "72 hours", TimeoutMaxAttempts: 5, TimeoutBlacklist: []string{"some-other-form"}}
	events := getEvents(Timeouts(cfg, pool))

	fired := map[string]*ExternalEvent{}
	for _, e := range events {
		fired[e.User] = e
	}

	require.Contains(t, fired, "or-matured")
	assert.Equal(t, "timeout", fired["or-matured"].Event.Type)
	assert.JSONEq(t, fmt.Sprint(matured), string(*fired["or-matured"].Event.Value))
	assert.Contains(t, fired, "and-matured")
	assert.NotContains(t, fired, "or-pending")
	assert.NotContains(t, fired, "no-timeout-arm")
}

func dur(d time.Duration) *time.Duration { return &d }
