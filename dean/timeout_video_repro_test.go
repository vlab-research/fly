package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// waitJSONRelative1Week is the exact prod wait shape armed by the
// `thank_you_timeout_mentality` statement in the MENtality incentive form.
const waitJSONRelative1Week = `"wait": { "type": "timeout", "value": { "type": "relative", "timeout": "1 week" } }`

// fiveMoviehouseEvents are 5 synthetic video-player events (verbatim shape from
// prod state_json->externalEvents) accumulated earlier in the survey and never
// drained from the shared log.
const fiveMoviehouseEvents = `[
	{"source":"synthetic","event":{"type":"external","value":{"id":"1195793007","type":"moviehouse:play"}}},
	{"source":"synthetic","event":{"type":"external","value":{"id":"1195793007","type":"moviehouse:heartbeat"}}},
	{"source":"synthetic","event":{"type":"external","value":{"id":"1195793007","type":"moviehouse:heartbeat"}}},
	{"source":"synthetic","event":{"type":"external","value":{"id":"1195793007","type":"moviehouse:seeked"}}},
	{"source":"synthetic","event":{"type":"external","value":{"id":"1195793007","type":"moviehouse:pause"}}}
]`

// TestGetTimeouts_MaturedTimeoutFiresDespitePriorVideoEvents is the regression
// test for Linear VIR-8 ("Stuck in MENtality Incentive").
//
// A respondent parks at a matured 1-week timeout after watching a moviehouse
// video earlier in the survey. Before the fix, Dean's gate counted the TOTAL
// length of the shared, never-drained externalEvents log, so the unrelated
// video events falsely exhausted the DEAN_TIMEOUT_MAX_ATTEMPTS budget and the
// timeout was never fired — leaving the user parked, never stitching to endline.
//
// After the fix (count only `timeout` events emitted for THIS wait), the video
// events no longer count, so the matured timeout fires normally.
func TestGetTimeouts_MaturedTimeoutFiresDespitePriorVideoEvents(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	// waitStart 7d12h ago => "1 week" timeout matured ~12h ago: matured and
	// within the 72h MaxPast window.
	waitStart := time.Now().UTC().Add(-(7*24 + 12) * time.Hour)
	ws := waitStart.Unix() * 1000
	updated := time.Now().UTC().Add(-30 * time.Minute)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "bar"}`)
	mustExec(t, pool, surveyInsertSql, "mentalityincentive", time.Now().UTC().Add(-30*24*time.Hour), "{}")

	// STUCK user: matured timeout + 5 prior moviehouse events.
	mustExec(t, pool, insertQuery, "stuck", "bar", updated, "WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state":"WAIT_EXTERNAL_EVENT","forms":["mentalityincentive"],"waitStart":%v,"md":{"startTime":%v},%v,"externalEvents":%v}`,
			ws, ws, waitJSONRelative1Week, fiveMoviehouseEvents))

	// CONTROL user: identical matured timeout, no video events.
	mustExec(t, pool, insertQuery, "control", "bar", updated, "WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state":"WAIT_EXTERNAL_EVENT","forms":["mentalityincentive"],"waitStart":%v,"md":{"startTime":%v},%v,"externalEvents":[]}`,
			ws, ws, waitJSONRelative1Week))

	// Non-empty blacklist => Dean's no-LIMIT branch (as in prod, which has a
	// populated DEAN_TIMEOUT_BLACKLIST), so every eligible user is returned
	// rather than a single ORDER BY ... LIMIT 1 row.
	cfg := &Config{TimeoutMaxPast: "72 hours", TimeoutMaxAttempts: 5, TimeoutBlacklist: []string{"some-other-form"}}
	events := getEvents(Timeouts(cfg, pool))

	fired := map[string]bool{}
	for _, e := range events {
		fired[e.User] = true
	}
	t.Logf("Dean fired timeouts for: %v", fired)

	assert.True(t, fired["control"], "control user with a matured timeout should fire")
	assert.True(t, fired["stuck"],
		"FIXED (VIR-8): matured timeout must fire even though prior moviehouse video "+
			"events sit in externalEvents — they are not timeout attempts and must not count")
}

// TestGetTimeouts_RetryCapStillStopsAfterMaxTimeoutAttempts pins the ORIGINAL
// intent of the gate: Dean must stop re-firing a timeout that never resolves,
// after DEAN_TIMEOUT_MAX_ATTEMPTS synthetic timeout events for this wait. This
// guards against the fix accidentally removing the retry cap.
func TestGetTimeouts_RetryCapStillStopsAfterMaxTimeoutAttempts(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	waitStart := time.Now().UTC().Add(-(7*24 + 12) * time.Hour)
	ws := waitStart.Unix() * 1000
	updated := time.Now().UTC().Add(-30 * time.Minute)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "bar"}`)
	mustExec(t, pool, surveyInsertSql, "mentalityincentive", time.Now().UTC().Add(-30*24*time.Hour), "{}")

	// 5 timeout events already emitted for THIS wait (value == waitStart).
	fiveTimeoutAttempts := fmt.Sprintf(`[
		{"source":"synthetic","event":{"type":"timeout","value":%[1]v}},
		{"source":"synthetic","event":{"type":"timeout","value":%[1]v}},
		{"source":"synthetic","event":{"type":"timeout","value":%[1]v}},
		{"source":"synthetic","event":{"type":"timeout","value":%[1]v}},
		{"source":"synthetic","event":{"type":"timeout","value":%[1]v}}
	]`, ws)

	// exhausted: already retried 5 times -> must NOT fire again.
	mustExec(t, pool, insertQuery, "exhausted", "bar", updated, "WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state":"WAIT_EXTERNAL_EVENT","forms":["mentalityincentive"],"waitStart":%v,"md":{"startTime":%v},%v,"externalEvents":%v}`,
			ws, ws, waitJSONRelative1Week, fiveTimeoutAttempts))

	cfg := &Config{TimeoutMaxPast: "72 hours", TimeoutMaxAttempts: 5, TimeoutBlacklist: []string{"some-other-form"}}
	events := getEvents(Timeouts(cfg, pool))

	fired := map[string]bool{}
	for _, e := range events {
		fired[e.User] = true
	}
	assert.False(t, fired["exhausted"],
		"retry cap must still stop firing after DEAN_TIMEOUT_MAX_ATTEMPTS timeout events for this wait")
}
