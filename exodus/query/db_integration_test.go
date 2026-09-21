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
		DELETE FROM chatroach.credentials;
		DELETE FROM chatroach.users;
	`)
	if err != nil {
		t.Fatalf("resetTablesForQuery: %v", err)
	}
}

// insertOwner creates a researcher, the identity that owns both surveys and
// messaging accounts and that every bail query is scoped to.
func insertOwner(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	ownerID := uuid.New()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO chatroach.users (id, email) VALUES ($1, $2)
	`, ownerID, "owner-"+ownerID.String()+"@test.com")
	if err != nil {
		t.Fatalf("insertOwner: %v", err)
	}
	return ownerID
}

// insertSurveyFor creates a survey owned by ownerID with the given shortcode.
// Returns the survey UUID needed for response inserts.
func insertSurveyFor(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID, shortcode string) uuid.UUID {
	t.Helper()
	surveyID := uuid.New()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO chatroach.surveys (id, userid, created, formid, form, shortcode, title)
		VALUES ($1, $2, now(), $3, $4, $5, $6)
	`, surveyID, ownerID, "form-id-"+shortcode, "{}", shortcode, "Test Survey")
	if err != nil {
		t.Fatalf("insertSurveyFor: insert survey: %v", err)
	}
	return surveyID
}

// insertMessagingCredential connects a messaging account to an owner. `details`
// carries the account id because migration 01 derives facebook_page_id from it
// under a unique constraint.
func insertMessagingCredential(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID, entity, pageid string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO chatroach.credentials (userid, entity, key, details)
		VALUES ($1, $2, $3, jsonb_build_object('id', $3::string))
		ON CONFLICT DO NOTHING
	`, ownerID, entity, pageid)
	if err != nil {
		t.Fatalf("insertMessagingCredential: %v", err)
	}
}

// defaultPageid is the messaging account used by tests that do not care about
// account scoping. A conversation is keyed (platform, account, user); pageid is
// the legacy column name for the account. Tests that only exercise boolean
// condition logic keep state and responses on this single account so they stay
// account-consistent.
func defaultPageid(userid string) string { return userid + "-page" }

// insertStateOn creates a state row for a participant's conversation on a specific
// messaging account (pageid), with the given shortcode as current_form, and
// connects that account to ownerID as a Messenger account. A bail matches only
// accounts its owner connected, so a state row without one is invisible.
// userid and pageid are plain strings (VARCHAR in states table, not FK-constrained).
func insertStateOn(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID, userid, pageid, shortcode string) {
	t.Helper()
	insertMessagingCredential(t, pool, ownerID, "facebook_page", pageid)
	insertStateWithoutCredential(t, pool, userid, pageid, shortcode)
}

// insertStateWithoutCredential creates a state row on an account nobody has
// connected.
func insertStateWithoutCredential(t *testing.T, pool *pgxpool.Pool, userid, pageid, shortcode string) {
	t.Helper()
	stateJSON := `{"forms": ["` + shortcode + `"]}`
	_, err := pool.Exec(context.Background(), `
		INSERT INTO chatroach.states (userid, pageid, updated, current_state, state_json)
		VALUES ($1, $2, now(), 'RESPONDING', $3)
	`, userid, pageid, stateJSON)
	if err != nil {
		t.Fatalf("insertStateWithoutCredential: %v", err)
	}
}

// insertStateOnWithPlatform creates a state row whose state_json carries
// md.platform, which is what the states.platform computed column reads. It takes
// no credential: callers connect the account themselves to set up a case where
// the two disagree.
func insertStateOnWithPlatform(t *testing.T, pool *pgxpool.Pool, userid, pageid, shortcode, platform string) {
	t.Helper()
	stateJSON := `{"forms": ["` + shortcode + `"], "md": {"platform": "` + platform + `"}}`
	_, err := pool.Exec(context.Background(), `
		INSERT INTO chatroach.states (userid, pageid, updated, current_state, state_json)
		VALUES ($1, $2, now(), 'RESPONDING', $3)
	`, userid, pageid, stateJSON)
	if err != nil {
		t.Fatalf("insertStateOnWithPlatform: %v", err)
	}
}

// insertState creates a state row on the participant's default account.
func insertState(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID, userid, shortcode string) {
	t.Helper()
	insertStateOn(t, pool, ownerID, userid, defaultPageid(userid), shortcode)
}

// insertResponseFull creates a response row attributed to a specific messaging
// account (pageid) at a specific timestamp.
func insertResponseFull(t *testing.T, pool *pgxpool.Pool, surveyID uuid.UUID, userid, pageid, shortcode, questionRef, response string, ts time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO chatroach.responses
			(surveyid, parent_shortcode, shortcode, flowid, userid, pageid, question_ref, question_idx, question_text, response, seed, timestamp)
		VALUES ($1, $2, $3, 0, $4, $5, $6, 0, $7, $8, 0, $9)
	`, surveyID, shortcode, shortcode, userid, pageid, questionRef, questionRef, response, ts)
	if err != nil {
		t.Fatalf("insertResponseFull: %v", err)
	}
}

// insertResponseOn creates a response row attributed to a specific messaging account.
func insertResponseOn(t *testing.T, pool *pgxpool.Pool, surveyID uuid.UUID, userid, pageid, shortcode, questionRef, response string) {
	t.Helper()
	insertResponseFull(t, pool, surveyID, userid, pageid, shortcode, questionRef, response, time.Now())
}

// insertResponse creates a response row on the participant's default account.
func insertResponse(t *testing.T, pool *pgxpool.Pool, surveyID uuid.UUID, userid, shortcode, questionRef, response string) {
	t.Helper()
	insertResponseFull(t, pool, surveyID, userid, defaultPageid(userid), shortcode, questionRef, response, time.Now())
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
		var userid, pageid, platform string
		if err := rows.Scan(&userid, &pageid, &platform); err != nil {
			t.Fatalf("runQuery scan: %v", err)
		}
		userids = append(userids, userid)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("runQuery rows: %v", err)
	}
	return userids
}

// conversation is the identity of a single conversation: (platform, account, user),
// where the account is the legacy column name pageid. Bail targeting returns
// conversations, not users, so account-scoping assertions must inspect all three.
type conversation struct {
	userid   string
	pageid   string
	platform string
}

// runQueryConversations executes the generated SQL and returns the matched
// conversations.
func runQueryConversations(t *testing.T, pool *pgxpool.Pool, sql string, params []interface{}) []conversation {
	t.Helper()
	rows, err := pool.Query(context.Background(), sql, params...)
	if err != nil {
		t.Fatalf("runQueryConversations: %v\nSQL:\n%s\nParams: %v", err, sql, params)
	}
	defer rows.Close()

	var out []conversation
	for rows.Next() {
		var c conversation
		if err := rows.Scan(&c.userid, &c.pageid, &c.platform); err != nil {
			t.Fatalf("runQueryConversations scan: %v", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("runQueryConversations rows: %v", err)
	}
	return out
}

// platformOf returns the platform the query attributed to a conversation, or ""
// if the conversation did not match at all.
func platformOf(cs []conversation, userid, pageid string) string {
	for _, c := range cs {
		if c.userid == userid && c.pageid == pageid {
			return c.platform
		}
	}
	return ""
}

func containsConversation(cs []conversation, userid, pageid string) bool {
	for _, c := range cs {
		if c.userid == userid && c.pageid == pageid {
			return true
		}
	}
	return false
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

	owner := insertOwner(t, pool)
	surveyID := insertSurveyFor(t, pool, owner, "hpv-form")

	// userA answered "2", userB answered "3", userC answered "1"
	userA, userB, userC := "user-or-a", "user-or-b", "user-or-c"
	for _, u := range []string{userA, userB, userC} {
		insertState(t, pool, owner, u, "hpv-form")
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

	sql, params, err := BuildQuery(def, owner)
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

	owner := insertOwner(t, pool)
	surveyID := insertSurveyFor(t, pool, owner, "consent-form")

	// userA answered both questions, userB answered only q1
	userA, userB := "user-and-a", "user-and-b"
	insertState(t, pool, owner, userA, "consent-form")
	insertState(t, pool, owner, userB, "consent-form")
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

	sql, params, err := BuildQuery(def, owner)
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

	owner := insertOwner(t, pool)
	surveyID := insertSurveyFor(t, pool, owner, "screen-form")

	// userA answered hpv_girl=1 (should NOT match), userB answered hpv_girl=2 (should match)
	userA, userB := "user-not-a", "user-not-b"
	insertState(t, pool, owner, userA, "screen-form")
	insertState(t, pool, owner, userB, "screen-form")
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

	sql, params, err := BuildQuery(def, owner)
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

// A conversation is (platform, account, user), so a bail event must carry all
// three. The platform comes from the account's credential, which is the
// authoritative account -> transport map.
func TestIntegration_ConditionsBail_CarriesPlatform(t *testing.T) {
	pool := integrationPool(t)
	defer pool.Close()
	resetTablesForQuery(t, pool)

	owner := insertOwner(t, pool)
	insertSurveyFor(t, pool, owner, "platform-form")

	const waUser, waPage = "user-on-whatsapp", "account-wa"
	const fbUser, fbPage = "user-on-messenger", "account-fb"
	const staleUser = "user-with-stale-md"

	insertMessagingCredential(t, pool, owner, "whatsapp_business", waPage)
	insertMessagingCredential(t, pool, owner, "facebook_page", fbPage)

	insertStateWithoutCredential(t, pool, waUser, waPage, "platform-form")
	insertStateWithoutCredential(t, pool, fbUser, fbPage, "platform-form")
	// A conversation on the WhatsApp account whose state_json claims Messenger.
	insertStateOnWithPlatform(t, pool, staleUser, waPage, "platform-form", "messenger")

	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"type": "form",
			"value": "platform-form"
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def, owner)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	matched := runQueryConversations(t, pool, sql, params)

	if got := platformOf(matched, waUser, waPage); got != "whatsapp" {
		t.Errorf("a conversation on a whatsapp_business account must bail as 'whatsapp', got %q (matched: %v)", got, matched)
	}
	if got := platformOf(matched, fbUser, fbPage); got != "messenger" {
		t.Errorf("a conversation on a facebook_page account must bail as 'messenger', got %q (matched: %v)", got, matched)
	}
	if got := platformOf(matched, staleUser, waPage); got != "whatsapp" {
		t.Errorf("the account's credential decides the platform, not states.platform: got %q (matched: %v)", got, matched)
	}
}

// A state row on an account nobody connected cannot be bailed: there is no
// credential to send with, so the target is excluded rather than guessed at.
func TestIntegration_ConditionsBail_ExcludesUnconnectedAccount(t *testing.T) {
	pool := integrationPool(t)
	defer pool.Close()
	resetTablesForQuery(t, pool)

	owner := insertOwner(t, pool)
	insertSurveyFor(t, pool, owner, "orphan-form")

	const connectedUser, connectedPage = "user-connected", "account-connected"
	const orphanUser, orphanPage = "user-orphan", "account-orphan"

	insertStateOn(t, pool, owner, connectedUser, connectedPage, "orphan-form")
	insertStateWithoutCredential(t, pool, orphanUser, orphanPage, "orphan-form")

	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "form", "value": "orphan-form"}`),
		Execution:  types.Execution{Timing: "immediate"},
		Action:     types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def, owner)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	matched := runQueryConversations(t, pool, sql, params)

	if !containsConversation(matched, connectedUser, connectedPage) {
		t.Errorf("expected the conversation on the connected account to match, got: %v", matched)
	}
	if containsConversation(matched, orphanUser, orphanPage) {
		t.Errorf("a conversation on an account with no credential must not be bailed, got: %v", matched)
	}
}

// Shortcodes are not unique across researchers, so a condition on one matches
// other researchers' participants too. The owner-scoped credentials join is what
// keeps a bail inside its owner's accounts.
func TestIntegration_ConditionsBail_CrossTenantShortcode(t *testing.T) {
	pool := integrationPool(t)
	defer pool.Close()
	resetTablesForQuery(t, pool)

	ownerA := insertOwner(t, pool)
	ownerB := insertOwner(t, pool)

	const shortcode = "shared-shortcode"
	insertSurveyFor(t, pool, ownerA, shortcode)

	const userA, pageA = "user-tenant-a", "account-tenant-a"
	const userB, pageB = "user-tenant-b", "account-tenant-b"

	insertStateOn(t, pool, ownerA, userA, pageA, shortcode)
	insertStateOn(t, pool, ownerB, userB, pageB, shortcode)

	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "form", "value": "` + shortcode + `"}`),
		Execution:  types.Execution{Timing: "immediate"},
		Action:     types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def, ownerA)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	matched := runQueryConversations(t, pool, sql, params)

	if !containsConversation(matched, userA, pageA) {
		t.Errorf("expected owner A's own conversation to match, got: %v", matched)
	}
	if containsConversation(matched, userB, pageB) {
		t.Errorf("cross-tenant leak: owner A's bail matched a conversation on owner B's account, got: %v", matched)
	}
	if len(matched) != 1 {
		t.Errorf("expected exactly owner A's conversation, got: %v", matched)
	}
}

func TestIntegration_QuestionResponse_AccountScoped(t *testing.T) {
	pool := integrationPool(t)
	defer pool.Close()
	resetTablesForQuery(t, pool)

	owner := insertOwner(t, pool)
	surveyID := insertSurveyFor(t, pool, owner, "shared-form")

	const user = "user-cross-account"
	const pageA, pageB = "account-A", "account-B"

	// One participant id, two independent conversations on two accounts.
	insertStateOn(t, pool, owner, user, pageA, "shared-form")
	insertStateOn(t, pool, owner, user, pageB, "shared-form")

	// The participant answered the question ONLY on account A.
	insertResponseOn(t, pool, surveyID, user, pageA, "shared-form", "consent", "yes")

	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"type": "question_response",
			"form": "shared-form",
			"question_ref": "consent",
			"response": "yes"
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def, owner)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	matched := runQueryConversations(t, pool, sql, params)

	if !containsConversation(matched, user, pageA) {
		t.Errorf("expected the account-A conversation (where the answer was given) to match, got: %v", matched)
	}
	if containsConversation(matched, user, pageB) {
		t.Errorf("cross-account leak: the account-B conversation matched a bail on an answer given on account A, got: %v", matched)
	}
}

// TestIntegration_ElapsedTime_AccountScoped is the same regression test for the
// elapsed_time condition, whose response_times CTE had the identical defect.
func TestIntegration_ElapsedTime_AccountScoped(t *testing.T) {
	pool := integrationPool(t)
	defer pool.Close()
	resetTablesForQuery(t, pool)

	owner := insertOwner(t, pool)
	surveyID := insertSurveyFor(t, pool, owner, "elapsed-form")

	const user = "user-elapsed-cross-account"
	const pageA, pageB = "elapsed-account-A", "elapsed-account-B"

	insertStateOn(t, pool, owner, user, pageA, "elapsed-form")
	insertStateOn(t, pool, owner, user, pageB, "elapsed-form")

	// The participant responded a week ago, ONLY on account A.
	weekAgo := time.Now().Add(-7 * 24 * time.Hour)
	insertResponseFull(t, pool, surveyID, user, pageA, "elapsed-form", "q1", "hello", weekAgo)

	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"type": "elapsed_time",
			"duration": "1 hour",
			"since": {
				"event": "response",
				"details": {"question_ref": "q1", "form": "elapsed-form"}
			}
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def, owner)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	matched := runQueryConversations(t, pool, sql, params)

	if !containsConversation(matched, user, pageA) {
		t.Errorf("expected the account-A conversation (where the response happened) to match, got: %v", matched)
	}
	if containsConversation(matched, user, pageB) {
		t.Errorf("cross-account leak: the account-B conversation matched an elapsed_time bail based on a response on account A, got: %v", matched)
	}
}

func TestIntegration_QuestionResponse_NoMatch(t *testing.T) {
	pool := integrationPool(t)
	defer pool.Close()
	resetTablesForQuery(t, pool)

	owner := insertOwner(t, pool)
	surveyID := insertSurveyFor(t, pool, owner, "nomatch-form")

	userA := "user-nomatch-a"
	insertState(t, pool, owner, userA, "nomatch-form")
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

	sql, params, err := BuildQuery(def, owner)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	matched := runQuery(t, pool, sql, params)

	if len(matched) != 0 {
		t.Errorf("expected no matches, got: %v", matched)
	}
}
