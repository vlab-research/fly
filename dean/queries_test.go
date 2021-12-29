package main

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
	"net/http"

	"github.com/stretchr/testify/assert"
)

const (
	pageInsertSql = `
		INSERT INTO credentials(entity, key, userid, details)
		VALUES ('facebook_page', ($1)->>'id', '00000000-0000-0000-0000-000000000000', $1)`
	surveyInsertSql = `
		INSERT INTO surveys(userid, shortcode, created, messages, formid, form, title)
		VALUES ('00000000-0000-0000-0000-000000000000', $1, $2, $3, 'test-id', '{}', 'test-title');`
	insertQuery = `
		INSERT INTO states(userid, pageid, updated, current_state, state_json)
		VALUES ($1, $2, $3, $4, $5)`
	insertUserSql = `
		INSERT INTO users(id, email) 
		VALUES ('00000000-0000-0000-0000-000000000000', 'test@test.com');
	`
)

func before() {
	_, err := http.Get("http://system/resetdb")
	if err != nil {
		panic(err)
	}
}

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
	before()

	dbCfg := getConfig()
	pool := getConn(dbCfg)
	defer pool.Close()

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "11111111-1111-1111-1111-111111111111"}`)

	mustExec(t, pool, insertQuery,
		"foo",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-2*time.Hour),
		"RESPONDING",
		`{"state": "RESPONDING"}`)

	mustExec(t, pool, insertQuery,
		"baz",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-6*time.Hour),
		"RESPONDING",
		`{"state": "RESPONDING"}`)

	cfg := &Config{RespondingInterval: "4 hours", RespondingGrace: "1 hour"}
	ch := Respondings(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)
}

func TestGetRespondingsOnlyGetsThoseOutsideOfGracePeriod(t *testing.T) {
	before()

	dbCfg := getConfig()
	pool := getConn(dbCfg)
	defer pool.Close()

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "11111111-1111-1111-1111-111111111111"}`)

	mustExec(t, pool, insertQuery,
		"foo",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-30*time.Minute),
		"RESPONDING",
		`{"state": "RESPONDING"}`)

	mustExec(t, pool, insertQuery,
		"baz",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-90*time.Minute),
		"RESPONDING",
		`{"state": "RESPONDING"}`)

	cfg := &Config{RespondingInterval: "4 hours", RespondingGrace: "1 hour"}
	ch := Respondings(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "baz", events[0].User)
}

func TestGetBlockedOnlyGetsThoseWithCodesInsideWindow(t *testing.T) {
	before()

	dbCfg := getConfig()
	pool := getConn(dbCfg)
	defer pool.Close()

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "11111111-1111-1111-1111-111111111111"}`)

	mustExec(t, pool, insertQuery,
		"foo",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-30*time.Minute),
		"BLOCKED",
		`{"state": "BLOCKED", "error": {"code": 2020}}`)
	mustExec(t, pool, insertQuery,
		"baz",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-30*time.Minute),
		"BLOCKED",
		`{"state": "BLOCKED", "error": {"code": 9999}}`)
	mustExec(t, pool, insertQuery,
		"qux",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-90*time.Minute),
		"BLOCKED",
		`{"state": "BLOCKED", "error": {"code": 2020}}`)

	cfg := &Config{BlockedInterval: "1 hour", Codes: []string{"2020", "-1"}}
	ch := Blocked(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)
}

func TestGetBlockedOnlyGetsThoseWithNextRetryPassed(t *testing.T) {
	before()

	dbCfg := getConfig()
	pool := getConn(dbCfg)
	defer pool.Close()

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "11111111-1111-1111-1111-111111111111"}`)

	mustExec(t, pool, insertQuery,
		"foo",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-30*time.Minute),
		"BLOCKED",
		fmt.Sprintf(`{"state": "BLOCKED", "error": {"code": 2020}, "retries": [%d]}`, makeMs(-2*time.Minute)))
	mustExec(t, pool, insertQuery,
		"bar",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-30*time.Minute),
		"BLOCKED",
		fmt.Sprintf(`{"state": "BLOCKED", "error": {"code": 2020}, "retries": [%d]}`, makeMs(-1*time.Minute)))

	mustExec(t, pool, insertQuery,
		"baz",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-30*time.Minute),
		"BLOCKED",
		fmt.Sprintf(`{"state": "BLOCKED", "error": {"code": 2020}, "retries": [%d, %d, %d]}`,
			makeMs(-12*time.Minute),
			makeMs(-10*time.Minute),
			makeMs(-6*time.Minute)))

	cfg := &Config{BlockedInterval: "1 hour", Codes: []string{"2020", "-1"}}
	ch := Blocked(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)
}

func TestGetErroredGetsByTag(t *testing.T) {
	before()

	dbCfg := getConfig()
	pool := getConn(dbCfg)
	defer pool.Close()

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "11111111-1111-1111-1111-111111111111"}`)

	mustExec(t, pool, insertQuery,
		"foo",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-30*time.Minute),
		"ERROR",
		`{"state": "ERROR", "error": {"tag": "NETWORK"}}`)
	mustExec(t, pool, insertQuery,
		"baz",
		"11111111-1111-1111-1111-111111111111",
		time.Now().Add(-30*time.Minute),
		"ERROR",
		`{"state": "ERROR", "error": {"tag": "NOTNET"}}`)

	cfg := &Config{ErrorInterval: "1 hour", ErrorTags: []string{"NETWORK"}}
	ch := Errored(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)
}

func TestGetTimeoutsGetsOnlyExpiredTimeouts(t *testing.T) {
	before()

	dbCfg := getConfig()
	pool := getConn(dbCfg)
	defer pool.Close()

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "11111111-1111-1111-1111-111111111111"}`)

	ts := time.Now().UTC().Add(-30 * time.Minute)
	ms := ts.Unix() * 1000
	mustExec(t, pool, insertQuery,
		"foo",
		"11111111-1111-1111-1111-111111111111",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`
			{
				"state": "WAIT_EXTERNAL_EVENT",
				"waitStart": %v,
				"wait": {
					"type": "timeout",
					"value": "20 minutes"
				}
			}
		`, ms),
	)

	mustExec(t, pool, insertQuery,
		"baz",
		"11111111-1111-1111-1111-111111111111",
		ts,
		"WAIT_EXTERNAL_EVENT",
		fmt.Sprintf(`
			{
				"state": "WAIT_EXTERNAL_EVENT",
				"waitStart": %v,
				"wait": {
					"type": "timeout",
					"value": "40 minutes"
				}
			}
		`, ms),
	)

	cfg := &Config{}
	ch := Timeouts(cfg, pool)
	events := getEvents(ch)

	assert.Equal(t, 1, len(events))
	assert.Equal(t, "foo", events[0].User)

	assert.Equal(t, "timeout", events[0].Event.Type)

	ev, _ := json.Marshal(events[0].Event)
	assert.Equal(t, string(ev), fmt.Sprintf(`{"type":"timeout","value":%v}`, ms))
}

func TestFollowUpsGetsOnlyThoseBetweenMinAndMaxAndIgnoresAllSortsOfThings(t *testing.T) {
	before()

	dbCfg := getConfig()
	pool := getConn(dbCfg)
	defer pool.Close()

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, pageInsertSql, `{"id": "11111111-1111-1111-1111-111111111111"}`)
	mustExec(t, pool, pageInsertSql, `{"id": "22222222-2222-2222-2222-222222222222"}`)
	mustExec(t, pool, pageInsertSql, `{"id": "33333333-3333-3333-3333-333333333333"}`)
	mustExec(t, pool, surveyInsertSql, "with_followup", time.Now().UTC().Add(-50*time.Hour), `{"label.buttonHint.default": "this is follow up"}`)
	mustExec(t, pool, surveyInsertSql, "with_followup", time.Now().UTC().Add(-40*time.Hour), `{"label.buttonHint.default": "this is follow up"}`)
	mustExec(t, pool, surveyInsertSql, "with_followup", time.Now().UTC().Add(-20*time.Hour), `{"label.other": "not a follow up"}`)
	mustExec(t, pool, surveyInsertSql, "without_followup", time.Now().UTC().Add(-20*time.Hour), `{"label.other": "not a follow up"}`)

	mustExec(t, pool, insertQuery,
		"foo",
		"11111111-1111-1111-1111-111111111111",
		time.Now().UTC().Add(-30*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-30*time.Hour), "with_followup", `{"followUp": null}`))

	mustExec(t, pool, insertQuery,
		"quux",
		"11111111-1111-1111-1111-111111111111",
		time.Now().UTC().Add(-30*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-10*time.Hour), "with_followup", `{"followUp": null}`))

	mustExec(t, pool, insertQuery,
		"baz",
		"11111111-1111-1111-1111-111111111111",
		time.Now().UTC().Add(-30*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-60*time.Hour), "without_followup", `{"followUp": null}`))

	mustExec(t, pool, insertQuery,
		"bar",
		"22222222-2222-2222-2222-222222222222",
		time.Now().UTC().Add(-30*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-60*time.Hour), "with_followup", `{"followUp": true}`))

	mustExec(t, pool, insertQuery,
		"bar",
		"33333333-3333-3333-3333-333333333333",
		time.Now().UTC().Add(-30*time.Minute),
		"QOUT",
		makeStateJson(time.Now().UTC().Add(-60*time.Hour), "with_followup", `{"token": "token"}`))

	mustExec(t, pool, insertQuery,
		"qux",
		"11111111-1111-1111-1111-111111111111",
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
