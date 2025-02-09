package main

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

const (
	insertUserSql = `
		INSERT INTO users(id, email)
		VALUES ('e49cbb6b-45e1-4b9d-9516-094c63cc6ca2', 'test@test.com');
	`
	pageInsertSql = `INSERT INTO credentials(entity, key, userid, details) VALUES ('facebook_page', ($1)->>'id', 'e49cbb6b-45e1-4b9d-9516-094c63cc6ca2', $1)`

	surveyInsertSql = `INSERT INTO surveys(userid, formid, form, title, shortcode, created, messages) VALUES ('e49cbb6b-45e1-4b9d-9516-094c63cc6ca2', 'formid', '{}', 'title', $1, $2, $3);`

	settingsInsertSql = `INSERT INTO survey_settings(surveyid, timeouts, off_time) VALUES ((select id from surveys where shortcode = $1 AND created = $2), $3, $4)`

	insertQuery = `INSERT INTO
                   states(userid, pageid, updated, current_state, state_json)
                   VALUES ($1, $2, $3, $4, $5)`
)

func getEvents(ch <-chan *ExternalEvent) []*ExternalEvent {
	events := []*ExternalEvent{}
	for e := range ch {
		events = append(events, e)
	}
	return events
}

func makeMs(mins time.Duration) int64 {
	ts := time.Now().UTC().Add(mins)
	ms := ts.Unix() * 1000
	return ms
}

func makeStateJson(startTime time.Time, form, previousOutput string) string {
	base := `{"state": "QOUT", "md": { "startTime": %v }, "forms": ["%v"], "question": "foo", "previousOutput": %v }`

	return fmt.Sprintf(base, startTime.Unix()*1000, form, previousOutput)
}

func TestGetRespondingsGetsOnlyThoseInGivenInterval(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		time.Now().Add(-2*time.Hour),
		"RESPONDING",
		`{"state": "RESPONDING"}`)

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		time.Now().Add(-6*time.Hour),
		"RESPONDING",
		`{"state": "RESPONDING"}`)

	cfg := &Config{RespondingInterval: "4 hours", RespondingGrace: "1 hour", RetryMaxAttempts: 20}
	ch := Respondings(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)

}

func TestGetRespondingsOnlyGetsThoseOutsideOfGracePeriod(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		time.Now().Add(-30*time.Minute),
		"RESPONDING",
		`{"state": "RESPONDING"}`)

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		time.Now().Add(-90*time.Minute),
		"RESPONDING",
		`{"state": "RESPONDING"}`)

	cfg := &Config{RespondingInterval: "4 hours", RespondingGrace: "1 hour", RetryMaxAttempts: 20}
	ch := Respondings(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "baz", events[0].User)

}

func TestGetRespondingsIgnoresThoseWithTooManyRetries(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		time.Now().Add(-90*time.Minute),
		"RESPONDING",
		`{"state": "RESPONDING", "retries": [123, 1234, 12345, 123456]}`)

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		time.Now().Add(-90*time.Minute),
		"RESPONDING",
		`{"state": "RESPONDING", "retries": [123]}`)

	mustExec(t, pool, insertQuery,
		"qux",
		"bar",
		time.Now().Add(-90*time.Minute),
		"RESPONDING",
		`{"state": "RESPONDING"}`)

	cfg := &Config{RespondingInterval: "4 hours", RespondingGrace: "1 hour", RetryMaxAttempts: 3}
	ch := Respondings(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 2, len(events))
	assert.NotEqual(t, "foo", events[0].User)
	assert.NotEqual(t, "foo", events[0].User)
}

func TestGetBlockedOnlyGetsThoseWithCodesInsideWindow(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		time.Now().Add(-30*time.Minute),
		"BLOCKED",
		`{"state": "BLOCKED", "error": {"code": 2020}}`)
	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		time.Now().Add(-30*time.Minute),
		"BLOCKED",
		`{"state": "BLOCKED", "error": {"code": 9999}}`)
	mustExec(t, pool, insertQuery,
		"qux",
		"bar",
		time.Now().Add(-90*time.Minute),
		"BLOCKED",
		`{"state": "BLOCKED", "error": {"code": 2020}}`)

	cfg := &Config{BlockedInterval: "1 hour", Codes: []string{"2020", "-1"}, RetryMaxAttempts: 3}
	ch := Blocked(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)

}

func TestGetBlockedOnlyGetsThoseWithNextRetryPassed(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		time.Now().Add(-30*time.Minute),
		"BLOCKED",
		fmt.Sprintf(`{"state": "BLOCKED", "error": {"code": 2020}, "retries": [%d]}`, makeMs(-2*time.Minute)))
	mustExec(t, pool, insertQuery,
		"bar",
		"bar",
		time.Now().Add(-30*time.Minute),
		"BLOCKED",
		fmt.Sprintf(`{"state": "BLOCKED", "error": {"code": 2020}, "retries": [%d]}`, makeMs(-1*time.Minute)))

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		time.Now().Add(-30*time.Minute),
		"BLOCKED",
		fmt.Sprintf(`{"state": "BLOCKED", "error": {"code": 2020}, "retries": [%d, %d, %d]}`,
			makeMs(-12*time.Minute),
			makeMs(-10*time.Minute),
			makeMs(-6*time.Minute)))

	cfg := &Config{BlockedInterval: "1 hour", Codes: []string{"2020", "-1"}, RetryMaxAttempts: 3}
	ch := Blocked(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)

}

func TestGetErroredGetsByTag(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		time.Now().Add(-30*time.Minute),
		"ERROR",
		`{"state": "ERROR", "error": {"tag": "NETWORK"}}`)
	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		time.Now().Add(-30*time.Minute),
		"ERROR",
		`{"state": "ERROR", "error": {"tag": "NOTNET"}}`)

	cfg := &Config{ErrorInterval: "1 hour", ErrorTags: []string{"NETWORK"}, RetryMaxAttempts: 3}
	ch := Errored(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)

}

func TestGetTimeoutsGetsOnlyExpiredTimeouts(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	ts := time.Now().UTC().Add(-30 * time.Minute)
	ms := ts.Unix() * 1000

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "bar"}`)

	// Add surveys before states with the correct userid
	mustExec(t, pool, surveyInsertSql, "short1", time.Now().UTC().Add(-1*time.Hour), "{}")
	mustExec(t, pool, surveyInsertSql, "short2", time.Now().UTC().Add(-1*time.Hour), "{}")

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short2"],
                      "waitStart": %v,
                      "md": { "startTime": %v },
                      "wait": { "type": "timeout", "value": "20 minutes"}}`, ms, ms))

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short2"],
                      "waitStart": %v,
                      "md": { "startTime": %v },
                      "wait": { "type": "timeout", "value": "40 minutes"}}`, ms, ms))

	cfg := &Config{}
	ch := Timeouts(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)

	assert.Equal(t, "timeout", events[0].Event.Type)

	ev, _ := json.Marshal(events[0].Event)
	assert.Equal(t, string(ev), fmt.Sprintf(`{"type":"timeout","value":%v}`, ms))
}

func TestGetTimeoutsIgnoresBlacklistShortcodes(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	ts := time.Now().UTC().Add(-30 * time.Minute)
	ms := ts.Unix() * 1000

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "bar"}`)

	// Add surveys before states with the correct userid
	mustExec(t, pool, surveyInsertSql, "short1", time.Now().UTC().Add(-1*time.Hour), "{}")
	mustExec(t, pool, surveyInsertSql, "short2", time.Now().UTC().Add(-1*time.Hour), "{}")
	mustExec(t, pool, surveyInsertSql, "short3", time.Now().UTC().Add(-1*time.Hour), "{}")

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short2"],
                      "waitStart": %v,
                      "md": { "startTime": %v },
                      "wait": { "type": "timeout", "value": "20 minutes"}}`, ms, ms))

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short3"],
                      "waitStart": %v,
                      "md": { "startTime": %v },
                      "wait": { "type": "timeout", "value": "20 minutes"}}`, ms, ms))

	cfg := &Config{TimeoutBlacklist: []string{"short3"}}
	ch := Timeouts(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)

	assert.Equal(t, "timeout", events[0].Event.Type)

	ev, _ := json.Marshal(events[0].Event)
	assert.Equal(t, string(ev), fmt.Sprintf(`{"type":"timeout","value":%v}`, ms))
}

func TestGetTimeouts_WithRelativeVariableTimeout(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	ts := time.Now().UTC().Add(-30 * time.Minute)
	ms := ts.Unix() * 1000

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "bar"}`)

	// Add surveys before states
	surveyTime := time.Now().UTC().Add(-1 * time.Hour)
	mustExec(t, pool, surveyInsertSql, "short1", surveyTime, "{}")
	mustExec(t, pool, surveyInsertSql, "short2", surveyTime, "{}")

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short2"],
                      "waitStart": %v,
                      "md": { "startTime": %v },
                      "wait": { "type": "timeout", "value": { "type": "relative", "variable": "foo_var"}}}`, ms, ms))

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short2"],
                      "waitStart": %v,
                      "md": { "startTime": %v },
                      "wait": { "type": "timeout", "value": { "type": "relative", "variable": "bar_var"}}}`, ms, ms))

	mustExec(t, pool, settingsInsertSql, "short2", surveyTime,
		`[{"name": "foo_var", "type": "relative", "value": "20 minutes"}, {"name": "bar_var", "type": "relative", "value": "40 minutes"}]`, ts)

	cfg := &Config{}
	ch := Timeouts(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)
	assert.Equal(t, "timeout", events[0].Event.Type)

	ev, _ := json.Marshal(events[0].Event)
	assert.Equal(t, string(ev), fmt.Sprintf(`{"type":"timeout","value":%v}`, ms))
}

func TestGetTimeouts_WithAbsoluteVariableTimeout(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	now := time.Now().UTC()
	ts := now.Add(-30 * time.Minute)
	ms := ts.Unix() * 1000

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "bar"}`)

	// Add surveys before states
	surveyTime := time.Now().UTC().Add(-1 * time.Hour)
	mustExec(t, pool, surveyInsertSql, "short1", surveyTime, "{}")
	mustExec(t, pool, surveyInsertSql, "short2", surveyTime, "{}")

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short2"],
                      "waitStart": %v,
                      "md": { "startTime": %v },
                      "wait": { "type": "timeout", "value": { "type": "absolute", "variable": "foo_var"}}}`, ms, ms))

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short2"],
                      "waitStart": %v,
                      "md": { "startTime": %v },
                      "wait": { "type": "timeout", "value": { "type": "absolute", "variable": "bar_var"}}}`, ms, ms))

	mustExec(t, pool, settingsInsertSql, "short2", surveyTime,
		fmt.Sprintf(`[{"name": "foo_var", "type": "absolute", "value": "%v"}, {"name": "bar_var", "type": "absolute", "value": "%v"}]`,
			now.Format(time.RFC3339),
			now.Add(1*time.Minute).Format(time.RFC3339)),
		ts)

	cfg := &Config{}
	ch := Timeouts(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)
	assert.Equal(t, "timeout", events[0].Event.Type)

	ev, _ := json.Marshal(events[0].Event)
	assert.Equal(t, string(ev), fmt.Sprintf(`{"type":"timeout","value":%v}`, ms))
}

func TestGetTimeouts_OnlyWorksForCorrectSurveyVersion(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	now := time.Now().UTC()
	t1 := now.Add(-2 * time.Hour) // Earlier survey
	t2 := now.Add(-1 * time.Hour) // Later survey with timeout settings

	ts := now.Add(-30 * time.Minute)
	ms := ts.Unix() * 1000

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "bar"}`)

	// Add two versions of the same survey
	mustExec(t, pool, surveyInsertSql, "short1", t1, "{}") // Earlier version without timeout
	mustExec(t, pool, surveyInsertSql, "short1", t2, "{}") // Later version with timeout

	mustExec(t, pool, settingsInsertSql, "short1", t2,
		`[{"name": "foo_var", "type": "relative", "value": "20 minutes"}]`, ts)

	// User1's form_start_time is between t1 and t2 (should use earlier version without timeout)
	startTime1 := t1.Add(30*time.Minute).Unix() * 1000
	mustExec(t, pool, insertQuery,
		"user1",
		"bar",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1"],
                      "waitStart": %v,
                      "md": { "startTime": %v },
                      "wait": { "type": "timeout", "value": { "type": "relative", "variable": "foo_var"}}}`, ms, startTime1))

	// User2's form_start_time is after t2 (should use later version with timeout)
	startTime2 := t2.Add(10*time.Minute).Unix() * 1000
	mustExec(t, pool, insertQuery,
		"user2",
		"bar",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1"],
                      "waitStart": %v,
                      "md": { "startTime": %v },
                      "wait": { "type": "timeout", "value": { "type": "relative", "variable": "foo_var"}}}`, ms, startTime2))

	cfg := &Config{}
	ch := Timeouts(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "user2", events[0].User)
	assert.Equal(t, "timeout", events[0].Event.Type)

	ev, _ := json.Marshal(events[0].Event)
	assert.Equal(t, string(ev), fmt.Sprintf(`{"type":"timeout","value":%v}`, ms))
}

func TestFollowUpsGetsOnlyThoseBetweenMinAndMaxAndIgnoresAllSortsOfThings(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "bar"}`)
	mustExec(t, pool, pageInsertSql, `{"id": "qux"}`)
	mustExec(t, pool, pageInsertSql, `{"id": "quux"}`)

	mustExec(t, pool, surveyInsertSql, "with_followup", time.Now().UTC().Add(-50*time.Hour), `{"label.buttonHint.default": "this is follow up"}`)
	mustExec(t, pool, surveyInsertSql, "with_followup", time.Now().UTC().Add(-40*time.Hour), `{"label.buttonHint.default": "this is follow up"}`)
	mustExec(t, pool, surveyInsertSql, "with_followup", time.Now().UTC().Add(-20*time.Hour), `{"label.other": "not a follow up"}`)
	mustExec(t, pool, surveyInsertSql, "without_followup", time.Now().UTC().Add(-20*time.Hour), `{"label.other": "not a follow up"}`)

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		time.Now().UTC().Add(-30*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-30*time.Hour), "with_followup", `{"followUp": null}`))

	mustExec(t, pool, insertQuery,
		"quux",
		"bar",
		time.Now().UTC().Add(-30*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-10*time.Hour), "with_followup", `{"followUp": null}`))

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		time.Now().UTC().Add(-30*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-60*time.Hour), "without_followup", `{"followUp": null}`))

	mustExec(t, pool, insertQuery,
		"bar",
		"qux",
		time.Now().UTC().Add(-30*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-60*time.Hour), "with_followup", `{"followUp": true}`))

	mustExec(t, pool, insertQuery,
		"bar",
		"quux",
		time.Now().UTC().Add(-30*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-60*time.Hour), "with_followup", `{"token": "token"}`))

	mustExec(t, pool, insertQuery,
		"qux",
		"bar",
		time.Now().UTC().Add(-90*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-60*time.Hour), "with_followup", `{}`))

	cfg := &Config{FollowUpMin: "20 minutes", FollowUpMax: "60 minutes"}
	ch := FollowUps(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)
	assert.Equal(t, "follow_up", events[0].Event.Type)

	ev, _ := json.Marshal(events[0].Event)
	assert.Equal(t, string(ev), `{"type":"follow_up","value":"foo"}`)

}

func TestGetPaymentsGetsOnlyThoseWhovePassedGraceButNotInterval(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	tsA := time.Now().UTC().Add(-10 * time.Hour)
	tsB := time.Now().UTC().Add(-4 * time.Hour)
	tsC := time.Now().UTC().Add(-50 * time.Hour)

	msA := tsA.Unix() * 1000
	msB := tsB.Unix() * 1000
	msC := tsC.Unix() * 1000

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		tsA,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short2"],
                      "waitStart": %v,
                      "question": "foo_bar",
                      "wait": { "type": "external:reloadly", "value": {"type": "foo", "id": "payment_id"}}}`, msA))

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		tsB,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short2"],
                      "waitStart": %v,
                      "question": "foo_bar",
                      "wait": { "type": "external:reloadly", "value": {"type": "foo", "id": "payment_id"}}}`, msB))

	mustExec(t, pool, insertQuery,
		"qux",
		"bar",
		tsC,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`{"state": "WAIT_EXTERNAL_EVENT",
                      "forms": ["short1", "short2"],
                      "waitStart": %v,
                      "question": "foo_bar",
                      "wait": { "type": "external:reloadly", "value": {"type": "foo", "id": "payment_id"}}}`, msC))

	cfg := &Config{
		PaymentGrace:    "8 hours",
		PaymentInterval: "2 days",
	}

	ch := Payments(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)

	assert.Equal(t, "repeat_payment", events[0].Event.Type)

	ev, _ := json.Marshal(events[0].Event)
	assert.Equal(t, string(ev), `{"type":"repeat_payment","value":{"question":"foo_bar"}}`)
}

func TestGetSpammersGetsTheSpammer(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	now := time.Now().UTC()
	ts := now.Add(-30 * time.Minute)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "bar"}`)

	mustExec(t, pool, insertQuery,
		"foo",
		"bar",
		ts,
		"QOUT",
		fmt.Sprintf(`{"state": "QOUT", "qa": ["foo", "bar"],
                      "forms": ["open", "closed"]}`))

	// This user repeated the same question/answer f50 times
	qa := make([][]string, 50)
	for i := range qa {
		qa[i] = []string{"foo", fmt.Sprintf(`bar %d`, i)}
	}
	b, _ := json.Marshal(qa)
	qaString := string(b)

	mustExec(t, pool, insertQuery,
		"baz",
		"bar",
		ts,
		"QOUT",
		fmt.Sprintf(`{"state": "QOUT", "qa": %s,
                      "forms": ["closed", "open"]}`, qaString))

	cfg := &Config{}
	ch := Spammers(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "baz", events[0].User)

	assert.Equal(t, "block_user", events[0].Event.Type)
	ev, _ := json.Marshal(events[0].Event)
	assert.Equal(t, string(ev), `{"type":"block_user","value":null}`)
}
