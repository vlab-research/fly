package main

import (
	"strings"
	"testing"
)

// The pure core. No database: these pin the statements we build, which is where
// the bash version's real bugs lived (hand-escaped quotes, a predicate repeated
// three times, a cursor interpolated into SQL text).

func TestStripSQLCommentsKeepsTheExpression(t *testing.T) {
	in := `-- a leading comment
CASE
  -- an inner comment
  WHEN a THEN b

  ELSE c
END`

	got := StripSQLComments(in)

	if strings.Contains(got, "comment") {
		t.Fatalf("comments survived: %q", got)
	}
	for _, want := range []string{"CASE", "WHEN a THEN b", "ELSE c", "END"} {
		if !strings.Contains(got, want) {
			t.Errorf("stripped away %q: %q", want, got)
		}
	}
	if strings.Contains(got, "\n\n") {
		t.Errorf("blank lines survived: %q", got)
	}
}

func TestBoundaryQueryFromTheStartTakesOnlyTheBatchSize(t *testing.T) {
	q, args := BoundaryQuery(Cursor{}, 20000)

	if strings.Contains(q, "WHERE") {
		t.Errorf("an unset cursor must not bound below: %s", q)
	}
	if len(args) != 1 || args[0] != 20000 {
		t.Errorf("args = %v, want [20000]", args)
	}
}

func TestBoundaryQueryFromACursorBoundsBelow(t *testing.T) {
	q, args := BoundaryQuery(Cursor{Hsh: 42, UserID: "u1", Set: true}, 100)

	if !strings.Contains(q, "(hsh, userid) > ($1, $2)") {
		t.Errorf("missing lower bound: %s", q)
	}
	if len(args) != 3 || args[0] != int64(42) || args[1] != "u1" || args[2] != 100 {
		t.Errorf("args = %v, want [42 u1 100]", args)
	}
}

// The bug this whole package exists to make impossible: the bash interpolated
// the userid into the SQL and escaped quotes with sed.
func TestTheCursorIsParameterizedNotInterpolated(t *testing.T) {
	nasty := "u'; DROP TABLE messages; --"

	q, args := UpdateQuery("ACCT", "PLAT", Cursor{Hsh: 1, UserID: nasty, Set: true}, Cursor{})

	if strings.Contains(q, "DROP TABLE") {
		t.Fatalf("the userid reached the SQL text: %s", q)
	}
	if len(args) != 2 || args[1] != nasty {
		t.Fatalf("the userid must arrive as an argument, got %v", args)
	}
}

func TestUpdateQueryNeverOverwritesAnAccountWeAlreadyHave(t *testing.T) {
	q, _ := UpdateQuery("ACCT", "PLAT", Cursor{}, Cursor{})

	if !strings.Contains(q, "account_id IS NULL") {
		t.Fatalf("missing the idempotency guard: %s", q)
	}
}

func TestUpdateQuerySkipsRowsTheRuleCannotAttribute(t *testing.T) {
	q, _ := UpdateQuery("ACCT", "PLAT", Cursor{}, Cursor{})

	if !strings.Contains(q, "(ACCT) IS NOT NULL") {
		t.Fatalf("missing the not-derivable guard: %s", q)
	}
}

// json_valid is the first branch of the account expression itself, so repeating
// it in the predicate buys a third parse of a 384 GiB column and nothing else.
func TestUpdateQueryDoesNotRepeatJSONValid(t *testing.T) {
	q, _ := UpdateQuery("ACCT", "PLAT", Cursor{}, Cursor{})

	if strings.Contains(q, "json_valid") {
		t.Fatalf("json_valid should come from the expression, not the predicate: %s", q)
	}
}

func TestUpdateQueryBoundsBothEndsOfAMiddleBatch(t *testing.T) {
	lower := Cursor{Hsh: 1, UserID: "a", Set: true}
	upper := Cursor{Hsh: 9, UserID: "z", Set: true}

	q, args := UpdateQuery("ACCT", "PLAT", lower, upper)

	if !strings.Contains(q, "(hsh, userid) > ($1, $2)") {
		t.Errorf("missing lower bound: %s", q)
	}
	if !strings.Contains(q, "(hsh, userid) <= ($3, $4)") {
		t.Errorf("missing upper bound: %s", q)
	}
	if len(args) != 4 {
		t.Errorf("args = %v, want 4", args)
	}
}

// The last batch has no upper bound -- that is how the loop knows it is done.
func TestUpdateQueryLeavesTheFinalBatchUnbounded(t *testing.T) {
	q, args := UpdateQuery("ACCT", "PLAT", Cursor{Hsh: 1, UserID: "a", Set: true}, Cursor{})

	if strings.Contains(q, "<=") {
		t.Errorf("the final batch must not bound above: %s", q)
	}
	if len(args) != 2 {
		t.Errorf("args = %v, want 2", args)
	}
}

func TestRedactDSNHidesThePassword(t *testing.T) {
	got := redactDSN("postgres://root:hunter2@host:26257/chatroach")

	if strings.Contains(got, "hunter2") {
		t.Fatalf("password survived: %s", got)
	}
	if !strings.Contains(got, "root") {
		t.Fatalf("user should survive: %s", got)
	}
}
