package query

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/vlab-research/exodus/types"
)

// integrationPool connects to the test database, skipping if unavailable.
// Uses TEST_DATABASE_URL env var if set, otherwise defaults to localhost:5433.
func integrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	connStr := os.Getenv("TEST_DATABASE_URL")
	if connStr == "" {
		connStr = "postgres://root@localhost:5433/chatroach"
	}
	config, err := pgxpool.ParseConfig(connStr)
	if err != nil {
		t.Skipf("skipping integration test: invalid DB config: %v", err)
	}
	pool, err := pgxpool.ConnectConfig(context.Background(), config)
	if err != nil {
		t.Skipf("skipping integration test: database unavailable (%v) — run `make test-db` in devops/", err)
	}
	return pool
}

// resetTablesForQuery clears tables used by query integration tests.
func resetTablesForQuery(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		DELETE FROM chatroach.bail_events;
		DELETE FROM chatroach.bails;
		DELETE FROM chatroach.responses;
		DELETE FROM chatroach.states;
		DELETE FROM chatroach.surveys;
		DELETE FROM chatroach.users;
	`)
	if err != nil {
		t.Fatalf("resetTablesForQuery: %v", err)
	}
}

// insertSurvey creates an owner user and a survey with the given shortcode.
// Returns the survey UUID needed for response inserts.
func insertSurvey(t *testing.T, pool *pgxpool.Pool, shortcode string) uuid.UUID {
	t.Helper()
	ownerID := uuid.New()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO chatroach.users (id, email) VALUES ($1, $2)
	`, ownerID, "owner-"+ownerID.String()+"@test.com")
	if err != nil {
		t.Fatalf("insertSurvey: insert user: %v", err)
	}

	surveyID := uuid.New()
	_, err = pool.Exec(context.Background(), `
		INSERT INTO chatroach.surveys (id, userid, created, formid, form, shortcode, title)
		VALUES ($1, $2, now(), $3, $4, $5, $6)
	`, surveyID, ownerID, "form-id-"+shortcode, "{}", shortcode, "Test Survey")
	if err != nil {
		t.Fatalf("insertSurvey: insert survey: %v", err)
	}
	return surveyID
}

// insertState creates a state row for a participant with the given shortcode as current_form.
// userid is a plain string (VARCHAR in states table, not FK-constrained).
func insertState(t *testing.T, pool *pgxpool.Pool, userid, shortcode string) {
	t.Helper()
	stateJSON := `{"forms": ["` + shortcode + `"]}`
	_, err := pool.Exec(context.Background(), `
		INSERT INTO chatroach.states (userid, pageid, updated, current_state, state_json)
		VALUES ($1, $2, now(), 'RESPONDING', $3)
	`, userid, userid+"-page", stateJSON)
	if err != nil {
		t.Fatalf("insertState: %v", err)
	}
}

// insertResponse creates a response row for a participant.
func insertResponse(t *testing.T, pool *pgxpool.Pool, surveyID uuid.UUID, userid, shortcode, questionRef, response string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO chatroach.responses
			(surveyid, parent_shortcode, shortcode, flowid, userid, question_ref, question_idx, question_text, response, seed, timestamp)
		VALUES ($1, $2, $3, 0, $4, $5, 0, $6, $7, 0, $8)
	`, surveyID, shortcode, shortcode, userid, questionRef, questionRef, response, time.Now())
	if err != nil {
		t.Fatalf("insertResponse: %v", err)
	}
}

// runQuery executes the generated SQL and returns the matched userids.
func runQuery(t *testing.T, pool *pgxpool.Pool, sql string, params []interface{}) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), sql, params...)
	if err != nil {
		t.Fatalf("runQuery: %v\nSQL:\n%s\nParams: %v", err, sql, params)
	}
	defer rows.Close()

	var userids []string
	for rows.Next() {
		var userid, pageid string
		if err := rows.Scan(&userid, &pageid); err != nil {
			t.Fatalf("runQuery scan: %v", err)
		}
		userids = append(userids, userid)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("runQuery rows: %v", err)
	}
	return userids
}

func containsUserid(userids []string, target string) bool {
	for _, u := range userids {
		if u == target {
			return true
		}
	}
	return false
}

// TestIntegration_OR_QuestionResponse is the regression test for the LEFT JOIN fix.
// Before the fix, INNER JOIN caused OR conditions to require both responses simultaneously
// (impossible for the same question), returning zero rows.
func TestIntegration_OR_QuestionResponse(t *testing.T) {
	pool := integrationPool(t)
	defer pool.Close()
	resetTablesForQuery(t, pool)

	surveyID := insertSurvey(t, pool, "hpv-form")

	// userA answered "2", userB answered "3", userC answered "1"
	userA, userB, userC := "user-or-a", "user-or-b", "user-or-c"
	for _, u := range []string{userA, userB, userC} {
		insertState(t, pool, u, "hpv-form")
	}
	insertResponse(t, pool, surveyID, userA, "hpv-form", "hpv_girl", "2")
	insertResponse(t, pool, surveyID, userB, "hpv-form", "hpv_girl", "3")
	insertResponse(t, pool, surveyID, userC, "hpv-form", "hpv_girl", "1")

	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "or",
			"vars": [
				{"type": "question_response", "form": "hpv-form", "question_ref": "hpv_girl", "response": "2"},
				{"type": "question_response", "form": "hpv-form", "question_ref": "hpv_girl", "response": "3"}
			]
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	matched := runQuery(t, pool, sql, params)

	if !containsUserid(matched, userA) {
		t.Errorf("expected userA (response=2) to match OR condition, got: %v", matched)
	}
	if !containsUserid(matched, userB) {
		t.Errorf("expected userB (response=3) to match OR condition, got: %v", matched)
	}
	if containsUserid(matched, userC) {
		t.Errorf("expected userC (response=1) NOT to match OR condition, got: %v", matched)
	}
}

func TestIntegration_AND_QuestionResponse(t *testing.T) {
	pool := integrationPool(t)
	defer pool.Close()
	resetTablesForQuery(t, pool)

	surveyID := insertSurvey(t, pool, "consent-form")

	// userA answered both questions, userB answered only q1
	userA, userB := "user-and-a", "user-and-b"
	insertState(t, pool, userA, "consent-form")
	insertState(t, pool, userB, "consent-form")
	insertResponse(t, pool, surveyID, userA, "consent-form", "q1", "yes")
	insertResponse(t, pool, surveyID, userA, "consent-form", "q2", "yes")
	insertResponse(t, pool, surveyID, userB, "consent-form", "q1", "yes")

	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "and",
			"vars": [
				{"type": "question_response", "form": "consent-form", "question_ref": "q1", "response": "yes"},
				{"type": "question_response", "form": "consent-form", "question_ref": "q2", "response": "yes"}
			]
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	matched := runQuery(t, pool, sql, params)

	if !containsUserid(matched, userA) {
		t.Errorf("expected userA (answered both) to match AND condition, got: %v", matched)
	}
	if containsUserid(matched, userB) {
		t.Errorf("expected userB (answered only q1) NOT to match AND condition, got: %v", matched)
	}
}

func TestIntegration_NOT_QuestionResponse(t *testing.T) {
	pool := integrationPool(t)
	defer pool.Close()
	resetTablesForQuery(t, pool)

	surveyID := insertSurvey(t, pool, "screen-form")

	// userA answered hpv_girl=1 (should NOT match), userB answered hpv_girl=2 (should match)
	userA, userB := "user-not-a", "user-not-b"
	insertState(t, pool, userA, "screen-form")
	insertState(t, pool, userB, "screen-form")
	insertResponse(t, pool, surveyID, userA, "screen-form", "hpv_girl", "1")
	insertResponse(t, pool, surveyID, userB, "screen-form", "hpv_girl", "2")

	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "not",
			"vars": [
				{"type": "question_response", "form": "screen-form", "question_ref": "hpv_girl", "response": "1"}
			]
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	matched := runQuery(t, pool, sql, params)

	if containsUserid(matched, userA) {
		t.Errorf("expected userA (response=1) NOT to match NOT condition, got: %v", matched)
	}
	if !containsUserid(matched, userB) {
		t.Errorf("expected userB (response=2) to match NOT condition, got: %v", matched)
	}
}

func TestIntegration_QuestionResponse_NoMatch(t *testing.T) {
	pool := integrationPool(t)
	defer pool.Close()
	resetTablesForQuery(t, pool)

	surveyID := insertSurvey(t, pool, "nomatch-form")

	userA := "user-nomatch-a"
	insertState(t, pool, userA, "nomatch-form")
	insertResponse(t, pool, surveyID, userA, "nomatch-form", "hpv_girl", "99")

	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"type": "question_response",
			"form": "nomatch-form",
			"question_ref": "hpv_girl",
			"response": "1"
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	matched := runQuery(t, pool, sql, params)

	if len(matched) != 0 {
		t.Errorf("expected no matches, got: %v", matched)
	}
}
