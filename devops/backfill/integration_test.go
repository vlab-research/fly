package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v4/pgxpool"
)

// Integration tests against a real CockroachDB.
//
//	make -C devops test-db PORT=5455
//	TEST_DATABASE_URL=postgres://root@localhost:5455/chatroach go test ./devops/backfill/...
//
// These are the tests devops/backfill-messages-account.sh never had, and the
// ones facebot/testrunner/test.tc.ts deferred to a suite that did not exist:
// real shapes, idempotency, resumability, poison resilience, and the guarantee
// that a forward-written account is never overwritten.

func testDSN() string {
	if dsn := os.Getenv("TEST_DATABASE_URL"); dsn != "" {
		return dsn
	}
	return "postgres://root@localhost:5455/chatroach"
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	pool, err := pgxpool.Connect(ctx, testDSN())
	if err != nil {
		t.Skipf("no test database at %s (%v) -- run: make -C devops test-db PORT=5455", testDSN(), err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database not answering: %v", err)
	}
	return pool
}

// Real archived shapes, one per branch of the extraction rule.
type row struct {
	userid  string
	content string
	// what the rule must derive; "" means "not derivable, leave NULL"
	wantAccount  string
	wantPlatform string
}

func fixtureRows() []row {
	return []row{
		{
			userid:       "PARTICIPANT_1",
			content:      `{"source":"messenger","sender":{"id":"PARTICIPANT_1"},"recipient":{"id":"ACCOUNT_1"},"message":{"text":"hi"},"timestamp":1600000000000}`,
			wantAccount:  "ACCOUNT_1",
			wantPlatform: "messenger",
		},
		{
			// The echo inversion: the account is the SENDER. 28.8% of the real table.
			userid:       "PARTICIPANT_1",
			content:      `{"source":"messenger","sender":{"id":"ACCOUNT_1"},"recipient":{"id":"PARTICIPANT_1"},"message":{"is_echo":true,"text":"hello"},"timestamp":1600000001000}`,
			wantAccount:  "ACCOUNT_1",
			wantPlatform: "messenger",
		},
		{
			// An explicit false is an ordinary inbound message.
			userid:       "PARTICIPANT_2",
			content:      `{"source":"messenger","sender":{"id":"PARTICIPANT_2"},"recipient":{"id":"ACCOUNT_2"},"message":{"is_echo":false,"text":"hi"},"timestamp":1600000002000}`,
			wantAccount:  "ACCOUNT_2",
			wantPlatform: "messenger",
		},
		{
			// No `message` key at all: postbacks, referrals, delivery receipts.
			userid:       "PARTICIPANT_3",
			content:      `{"source":"messenger","sender":{"id":"PARTICIPANT_3"},"recipient":{"id":"ACCOUNT_3"},"postback":{"payload":"get_started"},"timestamp":1600000003000}`,
			wantAccount:  "ACCOUNT_3",
			wantPlatform: "messenger",
		},
		{
			userid:       "WA_PARTICIPANT",
			content:      `{"source":"whatsapp","phone_number_id":"PHONE_ID_1","from":"WA_PARTICIPANT","type":"text","timestamp":1600000004000}`,
			wantAccount:  "PHONE_ID_1",
			wantPlatform: "whatsapp",
		},
		{
			userid:       "PARTICIPANT_4",
			content:      `{"source":"synthetic","user":"PARTICIPANT_4","page":"ACCOUNT_1","event":{"type":"timeout"},"timestamp":1600000005000}`,
			wantAccount:  "ACCOUNT_1",
			wantPlatform: "",
		},
		{
			// Permanently unattributable: a synthetic event with no page. ~3,000
			// such rows exist in production and NULL is the honest answer.
			userid:      "PARTICIPANT_5",
			content:     `{"source":"synthetic","user":"PARTICIPANT_5","event":{"type":"timeout"},"timestamp":1600000006000}`,
			wantAccount: "",
		},
		{
			// Poison. 106M rows of archived payload going back to 2020; an
			// unguarded ::JSONB cast on one of these raises 22P02 and kills the
			// whole batch -- permanently, since the retry selects the same row.
			userid:      "PARTICIPANT_6",
			content:     `this is not json at all {{{`,
			wantAccount: "",
		},
	}
}

func seed(t *testing.T, pool *pgxpool.Pool, rows []row) {
	t.Helper()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `DELETE FROM chatroach.messages`); err != nil {
		t.Fatalf("clearing messages: %v", err)
	}
	for i, r := range rows {
		_, err := pool.Exec(ctx,
			`INSERT INTO chatroach.messages (userid, content, timestamp) VALUES ($1, $2, $3)`,
			r.userid, r.content, time.UnixMilli(int64(1600000000000+i*1000)).UTC())
		if err != nil {
			t.Fatalf("seeding row %d: %v", i, err)
		}
	}
}

func newRunner(t *testing.T, pool *pgxpool.Pool, batchSize int) *Runner {
	t.Helper()

	acct, err := ReadExpr("../sql/messages-account-id-expr.sql")
	if err != nil {
		t.Fatalf("reading account expression: %v", err)
	}
	plat, err := ReadExpr("../sql/messages-platform-expr.sql")
	if err != nil {
		t.Fatalf("reading platform expression: %v", err)
	}

	return &Runner{
		Pool:      pool,
		AcctExpr:  acct,
		PlatExpr:  plat,
		BatchSize: batchSize,
		Timeout:   30 * time.Second,
		Log:       func(string) {},
	}
}

// derived reads back what the backfill wrote, keyed by content so a row is
// identifiable regardless of the hash order the table is stored in.
func derived(t *testing.T, pool *pgxpool.Pool) map[string][2]string {
	t.Helper()

	rows, err := pool.Query(context.Background(),
		`SELECT content, coalesce(account_id, '<NULL>'), coalesce(platform, '<NULL>') FROM chatroach.messages`)
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	defer rows.Close()

	out := map[string][2]string{}
	for rows.Next() {
		var content, account, platform string
		if err := rows.Scan(&content, &account, &platform); err != nil {
			t.Fatalf("scanning: %v", err)
		}
		out[content] = [2]string{account, platform}
	}
	return out
}

func assertDerived(t *testing.T, got map[string][2]string, want []row) {
	t.Helper()

	for _, r := range want {
		g, ok := got[r.content]
		if !ok {
			t.Errorf("row vanished: %s", r.content)
			continue
		}

		wantAccount := r.wantAccount
		if wantAccount == "" {
			wantAccount = "<NULL>"
		}
		if g[0] != wantAccount {
			t.Errorf("account_id = %q, want %q\n  for %s", g[0], wantAccount, r.content)
		}
	}
}

func TestBackfillDerivesEveryRealShape(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	rows := fixtureRows()
	seed(t, pool, rows)

	res, err := newRunner(t, pool, 100).Run(context.Background(), Cursor{}, 100)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !res.Done {
		t.Fatalf("run did not reach the end of the table")
	}

	assertDerived(t, derived(t, pool), rows)
}

// One malformed row must not stop the batch it sits in. This is the failure the
// bash version's `json_valid` guard existed for, and it is now the expression's
// own first branch -- so it has to be proven, not assumed.
func TestBackfillSurvivesAPoisonRow(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	rows := fixtureRows()
	seed(t, pool, rows)

	// batchSize 100 puts every row, poison included, in one batch.
	if _, err := newRunner(t, pool, 100).Run(context.Background(), Cursor{}, 10); err != nil {
		t.Fatalf("a malformed row killed the batch: %v", err)
	}

	got := derived(t, pool)
	if got[`this is not json at all {{{`][0] != "<NULL>" {
		t.Errorf("the poison row should stay NULL, got %q", got[`this is not json at all {{{`][0])
	}
	// ...and its neighbours must still have been written.
	assertDerived(t, got, rows)
}

func TestBackfillIsIdempotent(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	rows := fixtureRows()
	seed(t, pool, rows)

	first, err := newRunner(t, pool, 3).Run(context.Background(), Cursor{}, 100)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	after := derived(t, pool)

	second, err := newRunner(t, pool, 3).Run(context.Background(), Cursor{}, 100)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}

	if second.Updated != 0 {
		t.Errorf("a second run updated %d rows; it must update none", second.Updated)
	}
	if first.Updated == 0 {
		t.Errorf("the first run updated nothing, so this proves little")
	}

	for content, want := range after {
		if got := derived(t, pool)[content]; got != want {
			t.Errorf("re-running changed a row: %s\n  %v -> %v", content, want, got)
		}
	}
}

// Correctness must not depend on resuming in the right place: `account_id IS
// NULL` is the guarantee and the cursor is only an optimization.
func TestBackfillResumesWhereItStopped(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	rows := fixtureRows()
	seed(t, pool, rows)

	r := newRunner(t, pool, 2)

	// Stop after a single batch, then resume from the cursor it reported.
	partial, err := r.Run(context.Background(), Cursor{}, 1)
	if err != nil {
		t.Fatalf("partial run: %v", err)
	}
	if partial.Done {
		t.Fatalf("the table was covered in one batch; this test proves nothing")
	}

	resumed, err := r.Run(context.Background(), partial.Cursor, 100)
	if err != nil {
		t.Fatalf("resumed run: %v", err)
	}
	if !resumed.Done {
		t.Fatalf("the resumed run did not finish")
	}

	assertDerived(t, derived(t, pool), rows)
}

// Restarting from scratch after a partial run must reach the same place: the
// rows already done are skipped by the predicate, not by the cursor.
func TestBackfillFromScratchAfterAPartialRunIsCorrect(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	rows := fixtureRows()
	seed(t, pool, rows)

	r := newRunner(t, pool, 2)
	if _, err := r.Run(context.Background(), Cursor{}, 1); err != nil {
		t.Fatalf("partial run: %v", err)
	}
	if _, err := r.Run(context.Background(), Cursor{}, 100); err != nil {
		t.Fatalf("restart: %v", err)
	}

	assertDerived(t, derived(t, pool), rows)
}

// A row scribble already wrote forward carries the account it was sent with.
// The backfill must never touch it -- that is what `AND account_id IS NULL` is
// for, and it is the reason there is no forward/backward overwrite seam.
func TestBackfillNeverOverwritesAForwardWrittenAccount(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	seed(t, pool, fixtureRows())

	ctx := context.Background()
	// Deliberately a value the rule would NOT derive, so any overwrite shows up.
	const content = `{"source":"messenger","sender":{"id":"PARTICIPANT_1"},"recipient":{"id":"ACCOUNT_1"},"message":{"text":"hi"},"timestamp":1600000000000}`
	if _, err := pool.Exec(ctx,
		`UPDATE chatroach.messages SET account_id = 'WRITTEN_FORWARD' WHERE content = $1`, content); err != nil {
		t.Fatalf("pre-setting the account: %v", err)
	}

	if _, err := newRunner(t, pool, 100).Run(ctx, Cursor{}, 10); err != nil {
		t.Fatalf("run: %v", err)
	}

	if got := derived(t, pool)[content][0]; got != "WRITTEN_FORWARD" {
		t.Errorf("the backfill clobbered a forward-written account: got %q", got)
	}
}

// Every row must be covered no matter how the batches fall.
func TestBackfillCoversTheTableAtEveryBatchSize(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	rows := fixtureRows()

	for _, size := range []int{1, 2, 3, 7, 100} {
		t.Run(fmt.Sprintf("batch-size-%d", size), func(t *testing.T) {
			seed(t, pool, rows)

			res, err := newRunner(t, pool, size).Run(context.Background(), Cursor{}, 1000)
			if err != nil {
				t.Fatalf("run: %v", err)
			}
			if !res.Done {
				t.Fatalf("did not reach the end of the table")
			}
			assertDerived(t, derived(t, pool), rows)
		})
	}
}

func TestDryRunCountsWithoutWriting(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	rows := fixtureRows()
	seed(t, pool, rows)

	r := newRunner(t, pool, 100)
	r.DryRun = true

	res, err := r.Run(context.Background(), Cursor{}, 10)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if res.Updated == 0 {
		t.Fatalf("a dry run over derivable rows should report a non-zero count")
	}

	for content, v := range derived(t, pool) {
		if v[0] != "<NULL>" {
			t.Errorf("dry run wrote to a row: %s -> %q", content, v[0])
		}
	}
}

// --- Rehearsal, and the cases that decide whether this is safe to run ---

// The pre-production check: run the real UPDATE, prove it executes, keep nothing.
func TestRehearsalExecutesTheRealUpdateAndPersistsNothing(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	rows := fixtureRows()
	seed(t, pool, rows)

	r := newRunner(t, pool, 100)
	r.Rehearse = true

	res, err := r.Run(context.Background(), Cursor{}, 10)
	if err != nil {
		t.Fatalf("rehearsal: %v", err)
	}

	// It must report the SAME count a real run would write -- a rehearsal that
	// under-reports is worse than none, because it under-states the work.
	if res.Updated == 0 {
		t.Fatalf("rehearsal reported no rows; it should report what a real run would write")
	}

	for content, v := range derived(t, pool) {
		if v[0] != "<NULL>" {
			t.Errorf("rehearsal persisted a row: %s -> %q", content, v[0])
		}
	}

	// And the table must still be fully backfillable afterwards.
	r.Rehearse = false
	if _, err := r.Run(context.Background(), Cursor{}, 10); err != nil {
		t.Fatalf("real run after rehearsal: %v", err)
	}
	assertDerived(t, derived(t, pool), rows)
}

func TestRehearsalReportsTheSameCountAsTheRealRun(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	rows := fixtureRows()

	seed(t, pool, rows)
	r := newRunner(t, pool, 3)
	r.Rehearse = true
	rehearsed, err := r.Run(context.Background(), Cursor{}, 100)
	if err != nil {
		t.Fatalf("rehearsal: %v", err)
	}

	seed(t, pool, rows)
	real, err := newRunner(t, pool, 3).Run(context.Background(), Cursor{}, 100)
	if err != nil {
		t.Fatalf("real run: %v", err)
	}

	if rehearsed.Updated != real.Updated {
		t.Errorf("rehearsal said %d rows, the real run wrote %d", rehearsed.Updated, real.Updated)
	}
}

// An empty table must terminate immediately rather than loop to --max-batches.
func TestBackfillOnAnEmptyTableFinishesAtOnce(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	seed(t, pool, nil)

	res, err := newRunner(t, pool, 100).Run(context.Background(), Cursor{}, 1000)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !res.Done {
		t.Errorf("an empty table should finish")
	}
	if res.Batches != 1 || res.Updated != 0 {
		t.Errorf("batches=%d updated=%d, want 1 and 0", res.Batches, res.Updated)
	}
}

// scribble keeps writing while this runs. A row inserted mid-run already carries
// its account, and lands at a random hsh -- possibly BEHIND the cursor, where
// this run will never look again. It must be unaffected either way.
func TestAForwardWrittenRowArrivingMidRunIsUntouched(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	ctx := context.Background()
	rows := fixtureRows()
	seed(t, pool, rows)

	r := newRunner(t, pool, 2)
	partial, err := r.Run(ctx, Cursor{}, 1)
	if err != nil {
		t.Fatalf("partial run: %v", err)
	}

	const live = `{"source":"messenger","sender":{"id":"P_LIVE"},"recipient":{"id":"ACCOUNT_LIVE"},"message":{"text":"mid-run"},"timestamp":1700000000000}`
	if _, err := pool.Exec(ctx,
		`INSERT INTO chatroach.messages (userid, content, timestamp, account_id, platform)
		 VALUES ($1, $2, now(), $3, $4)`,
		"P_LIVE", live, "ACCOUNT_LIVE", "messenger"); err != nil {
		t.Fatalf("simulating a live write: %v", err)
	}

	if _, err := r.Run(ctx, partial.Cursor, 100); err != nil {
		t.Fatalf("resumed run: %v", err)
	}

	got := derived(t, pool)[live]
	if got[0] != "ACCOUNT_LIVE" || got[1] != "messenger" {
		t.Errorf("a live row was disturbed: got %v, want [ACCOUNT_LIVE messenger]", got)
	}
}

// KNOWN AND DELIBERATE. The batch predicate is `(<account>) IS NOT NULL`, so a
// row whose account is not derivable is skipped whole -- even when its PLATFORM
// would have been derivable. Those rows keep a NULL platform.
//
// Measured on production 2026-08-20: of 300,000 sampled rows, 9 are synthetic
// with no `page`, and ZERO of those carry a `platform`. The gap is empty in
// practice, so the alternative -- a fourth evaluation of the expressions in the
// predicate, on a 384 GiB column -- buys nothing. Pinned here so that if the gap
// ever stops being empty, it is a decision someone revisits rather than a
// surprise.
func TestARowWithNoDerivableAccountIsSkippedEvenIfItsPlatformWasDerivable(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	ctx := context.Background()
	seed(t, pool, nil)

	const orphan = `{"source":"synthetic","user":"P_ORPHAN","platform":"whatsapp","event":{"type":"timeout"},"timestamp":1600000009000}`
	if _, err := pool.Exec(ctx,
		`INSERT INTO chatroach.messages (userid, content, timestamp) VALUES ($1, $2, now())`,
		"P_ORPHAN", orphan); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	if _, err := newRunner(t, pool, 100).Run(ctx, Cursor{}, 10); err != nil {
		t.Fatalf("run: %v", err)
	}

	got := derived(t, pool)[orphan]
	if got[0] != "<NULL>" {
		t.Errorf("account_id = %q, want <NULL>", got[0])
	}
	if got[1] != "<NULL>" {
		t.Errorf("platform = %q -- the known gap has closed; revisit the predicate", got[1])
	}
}

// The cursor is parameterized, so a userid is data. Prove it on a real database
// rather than only on the built string.
func TestAwkwardUserIDsSurviveTheCursor(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	ctx := context.Background()
	seed(t, pool, nil)

	awkward := []string{`u'; DROP TABLE chatroach.messages; --`, `üser-“quoted”`, `a\b`}
	for i, u := range awkward {
		c := fmt.Sprintf(`{"source":"messenger","sender":{"id":%q},"recipient":{"id":"ACCOUNT_X"},"message":{"text":"hi"},"timestamp":%d}`, u, 1600000000000+i)
		if _, err := pool.Exec(ctx,
			`INSERT INTO chatroach.messages (userid, content, timestamp) VALUES ($1, $2, now())`, u, c); err != nil {
			t.Fatalf("seeding %q: %v", u, err)
		}
	}

	// batchSize 1 forces every one of them to become a cursor value.
	res, err := newRunner(t, pool, 1).Run(ctx, Cursor{}, 100)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !res.Done {
		t.Fatalf("did not finish")
	}

	var remaining int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM chatroach.messages WHERE account_id IS NULL`).Scan(&remaining); err != nil {
		t.Fatalf("counting: %v", err)
	}
	if remaining != 0 {
		t.Errorf("%d rows left unbackfilled; an awkward userid broke the cursor", remaining)
	}
}
