package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// The shared cross-language fixture.
//
// testdata/event-envelope/messenger-account-derivation.json is the authoritative
// specification of the Messenger echo-inversion rule. It is already consumed by
// hermes' Rust tests (via include_str!) and replybot's JS tests (via require).
// This file makes scribble the third consumer rather than the third
// implementation -- the rule is 28.8% of production rows (~30M) and getting it
// backwards would mis-attribute every one of them to the participant instead of
// the account.
// ---------------------------------------------------------------------------

type fixtureFile struct {
	Vectors []fixtureVector `json:"vectors"`
}

type fixtureVector struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Event       json.RawMessage `json:"event"`
	Expected    struct {
		UserID    *string `json:"user_id"`
		AccountID *string `json:"account_id"`
		Platform  *string `json:"platform"`
	} `json:"expected"`
}

func loadMessengerFixture(t testing.TB) []fixtureVector {
	t.Helper()

	path := filepath.Join("..", "testdata", "event-envelope", "messenger-account-derivation.json")
	raw, err := os.ReadFile(path)
	require.NoError(t, err, "the shared fixture must be readable from scribble; "+
		"it lives at the repo root because the echo rule is jointly owned by hermes, "+
		"replybot and this package")

	f := new(fixtureFile)
	require.NoError(t, json.Unmarshal(raw, f))
	require.NotEmpty(t, f.Vectors, "fixture contained no vectors")

	return f.Vectors
}

// archivedContent turns a fixture vector's raw Meta item into the bytes that
// actually land in messages.content.
//
// The fixture deliberately holds the RAW webhook item, with no `source`, because
// that is what the derivation rule operates on in hermes. By the time scribble
// archives it, hermes has injected `source: "messenger"` -- confirmed present on
// 100% of a uniform 400,000-row production sample. Injecting it here is
// modelling the pipeline faithfully, not adjusting the fixture to fit the code.
func archivedContent(t testing.TB, event json.RawMessage) []byte {
	t.Helper()

	var m map[string]interface{}
	require.NoError(t, json.Unmarshal(event, &m))
	m["source"] = "messenger"

	out, err := json.Marshal(m)
	require.NoError(t, err)
	return out
}

func expectedStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func TestHistoricalExtractionMatchesSharedFixture(t *testing.T) {
	for _, v := range loadMessengerFixture(t) {
		t.Run(v.Name, func(t *testing.T) {
			conv := ConversationFromHistoricalContent(archivedContent(t, v.Event))

			assert.Equal(t, expectedStr(v.Expected.AccountID), conv.Account,
				"account_id mismatch for vector %q (%s)", v.Name, v.Description)
			assert.Equal(t, expectedStr(v.Expected.Platform), conv.Platform,
				"platform mismatch for vector %q", v.Name)
		})
	}
}

// TestHistoricalExtractionEchoInversionIsLoadBearing guards the specific way this
// rule fails. If the inversion were dropped, every non-echo vector would still
// pass -- so a suite that only checked "does it extract something" would look
// green while 30M echo rows were attributed to the participant. This asserts the
// two branches actually disagree about which field they read.
func TestHistoricalExtractionEchoInversionIsLoadBearing(t *testing.T) {
	inbound := []byte(`{"source":"messenger","sender":{"id":"PARTICIPANT"},"recipient":{"id":"ACCOUNT"},"message":{"text":"hi"}}`)
	echo := []byte(`{"source":"messenger","sender":{"id":"ACCOUNT"},"recipient":{"id":"PARTICIPANT"},"message":{"is_echo":true,"text":"hi"}}`)

	assert.Equal(t, "ACCOUNT", ConversationFromHistoricalContent(inbound).Account)
	assert.Equal(t, "ACCOUNT", ConversationFromHistoricalContent(echo).Account,
		"the echo branch must read sender.id -- an echo is a message the ACCOUNT sent")
}

func TestHistoricalExtractionPerShape(t *testing.T) {
	cases := []struct {
		name     string
		content  string
		account  string
		platform string
	}{
		{
			name:     "whatsapp reads phone_number_id",
			content:  `{"from":"15551234","phone_number_id":"106540352242922","source":"whatsapp","type":"text"}`,
			account:  "106540352242922",
			platform: "whatsapp",
		},
		{
			name:     "synthetic reads the deprecated page alias",
			content:  `{"user":"15551234","page":"935593143497601","source":"synthetic","event":{"type":"timeout"}}`,
			account:  "935593143497601",
			platform: "", // platform was optional on /synthetic; only dean sent it
		},
		{
			name:     "synthetic keeps an explicit platform when the poster sent one",
			content:  `{"user":"1","page":"2","platform":"whatsapp","source":"synthetic","event":{"type":"t"}}`,
			account:  "2",
			platform: "whatsapp",
		},
		{
			name:     "a numeric account id is coerced, not dropped",
			content:  `{"user":"1","page":935593143497601,"source":"synthetic","event":{"type":"t"}}`,
			account:  "935593143497601",
			platform: "",
		},
		{
			name:     "normalized account_id wins, so the backfill is idempotent",
			content:  `{"account_id":"NEW","platform":"whatsapp","source":"whatsapp","phone_number_id":"OLD"}`,
			account:  "NEW",
			platform: "whatsapp",
		},
		{
			name:     "synthetic with no account at all is not derivable",
			content:  `{"user":"15551234","source":"synthetic","event":{"type":"timeout"}}`,
			account:  "",
			platform: "",
		},
		{
			name:     "an empty-string account is not an account",
			content:  `{"from":"1","phone_number_id":"","source":"whatsapp"}`,
			account:  "",
			platform: "whatsapp",
		},
		{
			name:     "unknown source yields nothing rather than a guess",
			content:  `{"weird":"shape","source":"carrier-pigeon"}`,
			account:  "",
			platform: "",
		},
		{
			name:     "malformed content is not derivable and must not panic",
			content:  `this is not json at all`,
			account:  "",
			platform: "",
		},
		{
			name:     "empty content is not derivable and must not panic",
			content:  ``,
			account:  "",
			platform: "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			conv := ConversationFromHistoricalContent([]byte(c.content))
			assert.Equal(t, c.account, conv.Account)
			assert.Equal(t, c.platform, conv.Platform)
		})
	}
}

// TestForwardPathReadsOnlyTheNormalizedFields pins the rule that
// documentation/event-envelope.md makes the whole envelope design rest on: the
// forward path reads the normalized top-level fields and NOTHING else.
//
// The per-shape cases here are the important ones. They carry a perfectly
// readable account under its per-shape name and must STILL yield "not derivable",
// because a fallback would silently paper over a producer that stopped stamping
// the fields -- which is exactly the failure the normalized envelope exists to
// make loud.
func TestForwardPathReadsOnlyTheNormalizedFields(t *testing.T) {
	cases := []struct {
		name     string
		content  string
		account  string
		platform string
	}{
		{
			name:     "reads the normalized fields",
			content:  `{"sender":{"id":"u"},"recipient":{"id":"a"},"source":"messenger","account_id":"a","platform":"messenger"}`,
			account:  "a",
			platform: "messenger",
		},
		{
			name:     "does NOT fall back to phone_number_id",
			content:  `{"from":"u","phone_number_id":"a","source":"whatsapp"}`,
			account:  "",
			platform: "",
		},
		{
			name:     "does NOT fall back to recipient.id",
			content:  `{"sender":{"id":"u"},"recipient":{"id":"a"},"source":"messenger"}`,
			account:  "",
			platform: "",
		},
		{
			name:     "does NOT fall back to the page alias",
			content:  `{"user":"u","page":"a","source":"synthetic"}`,
			account:  "",
			platform: "",
		},
		{
			name:     "platform alone still lands when the account is absent",
			content:  `{"user":"u","platform":"whatsapp","source":"synthetic"}`,
			account:  "",
			platform: "whatsapp",
		},
		{
			name:     "malformed content must not panic",
			content:  `{"truncated":`,
			account:  "",
			platform: "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			conv := ConversationFromEnvelope([]byte(c.content))
			assert.Equal(t, c.account, conv.Account)
			assert.Equal(t, c.platform, conv.Platform)
		})
	}
}

func TestConversationRendersNotDerivableAsNull(t *testing.T) {
	empty := Conversation{}
	assert.Nil(t, empty.AccountID(), "an unknown account must be SQL NULL, never ''")
	assert.Nil(t, empty.PlatformOrNil())

	full := Conversation{Account: "a", Platform: "whatsapp"}
	require.NotNil(t, full.AccountID())
	require.NotNil(t, full.PlatformOrNil())
	assert.Equal(t, "a", *full.AccountID())
	assert.Equal(t, "whatsapp", *full.PlatformOrNil())
}

// ---------------------------------------------------------------------------
// The parity test. This is the one that earns the right to have the backfill
// written in SQL rather than in Go.
//
// The backfill cannot share ConversationFromHistoricalContent directly: it has to
// run inside the cluster with only a `cockroach sql` client available, and there
// is no Go toolchain in the migration path. So the rule exists twice -- once in
// Go above, once as SQL in devops/sql/messages-*-expr.sql.
//
// Rather than trusting the two to agree, this executes the actual SQL files
// against the same inputs as the Go and asserts identical results. Drift is a
// test failure, not a production surprise, and the SQL that ships is the SQL
// that was tested because the backfill script reads the same two files.
// ---------------------------------------------------------------------------

func loadSQLExpr(t testing.TB, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "devops", "sql", name))
	require.NoError(t, err, "the backfill's SQL expression files must be readable")
	// No comment stripping. The expression is wrapped in parentheses by the
	// caller with a leading newline before the closing paren, so whole-line `--`
	// comments inside the file are harmless.
	return string(raw)
}

func TestBackfillSQLMatchesGo(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	acctExpr := loadSQLExpr(t, "messages-account-id-expr.sql")
	platExpr := loadSQLExpr(t, "messages-platform-expr.sql")

	// Evaluated over a one-row VALUES aliased to `content`, so the expressions
	// are exercised against exactly the column name they see in the real UPDATE.
	query := "SELECT (" + acctExpr + "\n), (" + platExpr + "\n) FROM (VALUES ($1::VARCHAR)) AS t(content)"

	evalSQL := func(t *testing.T, content []byte) (string, string) {
		t.Helper()
		var acct, plat *string
		err := pool.QueryRow(context.Background(), query, string(content)).Scan(&acct, &plat)
		require.NoError(t, err, "the SQL expression files must be valid SQL")

		var a, p string
		if acct != nil {
			a = *acct
		}
		if plat != nil {
			p = *plat
		}
		return a, p
	}

	// Every shared fixture vector, so the echo rule is pinned identically in Go,
	// in SQL, in Rust and in JS.
	for _, v := range loadMessengerFixture(t) {
		t.Run("fixture/"+v.Name, func(t *testing.T) {
			content := archivedContent(t, v.Event)

			goConv := ConversationFromHistoricalContent(content)
			sqlAcct, sqlPlat := evalSQL(t, content)

			assert.Equal(t, goConv.Account, sqlAcct,
				"SQL and Go disagree on account_id for %q -- devops/sql/"+
					"messages-account-id-expr.sql has drifted from "+
					"ConversationFromHistoricalContent", v.Name)
			assert.Equal(t, goConv.Platform, sqlPlat,
				"SQL and Go disagree on platform for %q", v.Name)

			// Non-vacuity: a fixture vector that derives nothing cannot prove the
			// two implementations agree about anything. Most vectors must be
			// deriving a real account.
			if v.Expected.AccountID != nil {
				assert.NotEmpty(t, sqlAcct, "vector %q should derive an account", v.Name)
			}
		})
	}

	// The shapes the Messenger fixture does not cover.
	others := []string{
		`{"from":"u","phone_number_id":"106540352242922","source":"whatsapp","type":"text"}`,
		`{"from":"u","phone_number_id":"","source":"whatsapp"}`,
		`{"user":"u","page":"935593143497601","source":"synthetic","event":{"type":"timeout"}}`,
		`{"user":"u","page":"935593143497601","platform":"whatsapp","source":"synthetic"}`,
		`{"user":"u","page":935593143497601,"source":"synthetic"}`,
		`{"user":"u","source":"synthetic","event":{"type":"timeout"}}`,
		`{"account_id":"NEW","platform":"whatsapp","source":"whatsapp","phone_number_id":"OLD"}`,
		`{"account_id":"NEW","source":"whatsapp"}`,
		`{"weird":"shape","source":"carrier-pigeon"}`,
		`{"source":"messenger","sender":{"id":"a"},"message":{"is_echo":true}}`,
		`{"source":"messenger","sender":{"id":"u"},"message":{"text":"no recipient"}}`,
		`this is not json at all`,
		``,
	}

	for i, content := range others {
		t.Run("shape/"+string(rune('a'+i)), func(t *testing.T) {
			goConv := ConversationFromHistoricalContent([]byte(content))
			sqlAcct, sqlPlat := evalSQL(t, []byte(content))

			assert.Equal(t, goConv.Account, sqlAcct,
				"SQL and Go disagree on account_id for %s", content)
			assert.Equal(t, goConv.Platform, sqlPlat,
				"SQL and Go disagree on platform for %s", content)
		})
	}
}

// TestBackfillSQLHandlesMalformedContentWithoutRaising is the property that keeps
// a single bad row from permanently poisoning a 20,000-row batch. An unguarded
// ::JSONB cast raises 22P02, the batch fails, and the next attempt selects the
// same poison row forever. json_valid is what prevents that, and this asserts it
// rather than assuming it.
func TestBackfillSQLHandlesMalformedContentWithoutRaising(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	acctExpr := loadSQLExpr(t, "messages-account-id-expr.sql")
	platExpr := loadSQLExpr(t, "messages-platform-expr.sql")
	query := "SELECT (" + acctExpr + "\n), (" + platExpr + "\n) FROM (VALUES ($1::VARCHAR)) AS t(content)"

	for _, bad := range []string{
		`this is not json at all`,
		``,
		`{"truncated":`,
		`[1,2,3`,
		`{{{`,
		"\x00binary",
	} {
		var acct, plat *string
		err := pool.QueryRow(context.Background(), query, bad).Scan(&acct, &plat)
		require.NoError(t, err, "malformed content must yield NULL, not an error: %q", bad)
		assert.Nil(t, acct)
		assert.Nil(t, plat)
	}
}
