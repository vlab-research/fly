// Package main is the batched backfill of chatroach.messages.account_id and
// .platform from the per-shape account fields inside each row's archived
// `content`.
//
// It replaces devops/backfill-messages-account.sh. The reason for the move is
// testability, not taste: the extraction RULE was already tested
// (scribble.TestBackfillSQLMatchesGo, over devops/sql/*-expr.sql), but the
// orchestration around it -- batching, the cursor, resume, error detection,
// idempotency -- was 240 lines of bash that nothing executed.
//
// The expressions still run SERVER-SIDE. `content` is 384 GiB and never crosses
// the wire; this process only issues UPDATEs and moves a cursor.
//
// This file is the functional core: every function in it is pure and total.
// main.go is the shell that opens the pool, confirms, and loops.
package main

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Cursor is a position in the messages PRIMARY KEY (hsh, userid). The zero
// value means "before the first row", which is where an unresumed run starts.
type Cursor struct {
	Hsh    int64
	UserID string
	Set    bool
}

func (c Cursor) String() string {
	if !c.Set {
		return "(start)"
	}
	return fmt.Sprintf("hsh=%d userid=%s", c.Hsh, c.UserID)
}

// ReadExpr loads one of the devops/sql/*-expr.sql files and strips its SQL
// comments. Those files are not runnable statements; they are single
// expressions substituted into the statements below, and they are the SAME
// files scribble's TestBackfillSQLMatchesGo evaluates against the shared
// fixture. There is deliberately no second copy of the rule in this package.
func ReadExpr(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", path, err)
	}

	expr := StripSQLComments(string(raw))
	if expr == "" {
		return "", fmt.Errorf("%s reduced to nothing after comment stripping", path)
	}
	return expr, nil
}

var lineComment = regexp.MustCompile(`(?m)^\s*--.*$`)

// StripSQLComments removes whole-line `--` comments and blank lines. Pure.
//
// Only WHOLE-LINE comments: a `--` inside a string literal would be mangled by
// a naive strip, and the expression files are written with their comments on
// their own lines precisely so this stays safe.
func StripSQLComments(s string) string {
	s = lineComment.ReplaceAllString(s, "")

	var kept []string
	for _, line := range strings.Split(s, "\n") {
		if strings.TrimSpace(line) != "" {
			kept = append(kept, line)
		}
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// BoundaryQuery returns the statement that finds the upper bound of the next
// batch: the row `batchSize` rows past the cursor, in primary-key order.
//
// Parameterized, unlike the bash it replaces, which interpolated the cursor
// into the SQL text and hand-escaped quotes with sed. A userid is not
// guaranteed to be numeric, and $1/$2 removes that whole class of bug.
func BoundaryQuery(cur Cursor, batchSize int) (string, []interface{}) {
	if !cur.Set {
		return `SELECT hsh, userid FROM chatroach.messages
                 ORDER BY hsh, userid OFFSET $1 LIMIT 1`,
			[]interface{}{batchSize}
	}

	return `SELECT hsh, userid FROM chatroach.messages
             WHERE (hsh, userid) > ($1, $2)
             ORDER BY hsh, userid OFFSET $3 LIMIT 1`,
		[]interface{}{cur.Hsh, cur.UserID, batchSize}
}

// UpdateQuery returns the batch UPDATE for the half-open range (lower, upper].
// An unset `upper` means "to the end of the table", which is the final batch.
//
// `AND account_id IS NULL` is the guarantee, not the cursor: re-running over
// already-done rows is a no-op, so correctness never depends on resuming at the
// right place. The cursor is only there to avoid the full-table rescan that a
// bare `WHERE account_id IS NULL LIMIT n` degrades into once most rows are done.
//
// `json_valid(content)` is deliberately NOT repeated here. The account
// expression's own first branch is `WHEN NOT json_valid(content) THEN NULL`, so
// `(<acct>) IS NOT NULL` already implies valid JSON. The bash carried both and
// paid for a third parse of a 384 GiB column to learn nothing.
func UpdateQuery(acctExpr, platExpr string, lower, upper Cursor) (string, []interface{}) {
	var where []string
	var args []interface{}

	if lower.Set {
		where = append(where, fmt.Sprintf("(hsh, userid) > ($%d, $%d)", len(args)+1, len(args)+2))
		args = append(args, lower.Hsh, lower.UserID)
	}
	if upper.Set {
		where = append(where, fmt.Sprintf("(hsh, userid) <= ($%d, $%d)", len(args)+1, len(args)+2))
		args = append(args, upper.Hsh, upper.UserID)
	}
	if len(where) == 0 {
		where = append(where, "true")
	}

	// Never overwrite an account already derived with certainty -- a row scribble
	// wrote forward, or a row an earlier run of this backfill completed.
	where = append(where, "account_id IS NULL")
	where = append(where, fmt.Sprintf("(%s) IS NOT NULL", acctExpr))

	q := fmt.Sprintf(
		"UPDATE chatroach.messages SET account_id = (%s), platform = (%s) WHERE %s",
		acctExpr, platExpr, strings.Join(where, " AND "),
	)
	return q, args
}

// --- The durable resume cursor (devops/migrations/31-backfill-cursor.sql) ---
//
// The cursor is printed on every batch, which was enough for a 25-minute run
// driven by hand. A 41-hour Job needs it to outlive the pod, so it is also
// written to a table. Still pure: these build the statements, store.go runs
// them.

// CursorTable is the one place the table name is written. It is interpolated
// rather than parameterized because a table name cannot be a placeholder --
// which is exactly why it is a constant and never anything caller-supplied.
const CursorTable = "chatroach.backfill_cursor"

// CursorLoadQuery reads back a saved position. The key is parameterized; only
// the constant table name reaches the SQL text.
func CursorLoadQuery(key string) (string, []interface{}) {
	return "SELECT hsh, userid, batches, rows_updated, done FROM " + CursorTable +
			" WHERE cursor_key = $1",
		[]interface{}{key}
}

// CursorSaveQuery upserts the position after a batch commits.
//
// `hsh`/`userid` are NULL for an unset cursor, which is a real state -- "the run
// has started but no batch has finished" -- and distinct from a genuine row at
// hsh 0. Progress is written as an UPSERT rather than an UPDATE so the first
// batch of a fresh run does not need a separate INSERT to have somewhere to go.
func CursorSaveQuery(key string, cur Cursor, batches int, updated int64, done bool) (string, []interface{}) {
	var hsh, userid interface{}
	if cur.Set {
		hsh, userid = cur.Hsh, cur.UserID
	}

	return "UPSERT INTO " + CursorTable +
			" (cursor_key, hsh, userid, batches, rows_updated, done, updated_at)" +
			" VALUES ($1, $2, $3, $4, $5, $6, now())",
		[]interface{}{key, hsh, userid, int64(batches), updated, done}
}
