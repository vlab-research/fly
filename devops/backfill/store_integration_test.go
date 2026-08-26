package main

import (
	"context"
	"testing"
	"time"
)

// The durable resume cursor, against a real CockroachDB. Same setup as
// integration_test.go:
//
//	make -C devops test-db PORT=5455
//	TEST_DATABASE_URL=postgres://root@localhost:5455/chatroach go test ./devops/backfill/...
//
// What these have to prove is narrow but load-bearing for a 41-hour job: the
// stored position is never AHEAD of the work, a restart that trusts it lands on
// a correct table anyway, and a rehearsal cannot move it.

func newStore(t *testing.T, key string) (*CursorStore, func()) {
	t.Helper()

	pool := testPool(t)
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `DELETE FROM `+CursorTable+` WHERE cursor_key = $1`, key); err != nil {
		t.Skipf("no %s -- apply devops/migrations/31-backfill-cursor.sql: %v", CursorTable, err)
	}

	return &CursorStore{Pool: pool, Key: key, Timeout: 30 * time.Second}, pool.Close
}

func TestCursorStoreRoundTripsAPosition(t *testing.T) {
	store, done := newStore(t, "roundtrip")
	defer done()
	ctx := context.Background()

	want := Cursor{Hsh: -42, UserID: "u'with quotes\"", Set: true}
	if err := store.Save(ctx, want, 3, 60, false); err != nil {
		t.Fatalf("save: %v", err)
	}

	got, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !got.Found || got.Cursor != want {
		t.Fatalf("cursor = %+v, want %+v", got.Cursor, want)
	}
	if got.Batches != 3 || got.Updated != 60 || got.Done {
		t.Fatalf("progress = %+v, want 3 batches / 60 rows / not done", got)
	}
}

func TestCursorStoreLoadOfAnUnknownKeyIsNotAnError(t *testing.T) {
	store, done := newStore(t, "never-written")
	defer done()

	got, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("an absent key must not be an error: %v", err)
	}
	if got.Found || got.Cursor.Set {
		t.Fatalf("got %+v, want the zero Progress", got)
	}
}

// An unset cursor means "started, nothing finished". If it round-tripped as
// hsh=0 a restart would resume just past the first row of the table, and those
// rows would never be revisited.
func TestCursorStoreRoundTripsAnUnsetCursorAsUnset(t *testing.T) {
	store, done := newStore(t, "unset")
	defer done()
	ctx := context.Background()

	if err := store.Save(ctx, Cursor{}, 0, 0, false); err != nil {
		t.Fatalf("save: %v", err)
	}

	got, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !got.Found {
		t.Fatalf("the row should exist")
	}
	if got.Cursor.Set {
		t.Fatalf("an unset cursor came back set: %+v", got.Cursor)
	}
}

// Totals are what an operator watches for two days. A restart must continue
// them, not reset them -- a run that reads 0 rows after 20 hours looks like it
// started over.
func TestCursorStoreAccumulatesTotalsAcrossRestarts(t *testing.T) {
	store, done := newStore(t, "totals")
	defer done()
	ctx := context.Background()

	if err := store.Save(ctx, Cursor{Hsh: 1, UserID: "a", Set: true}, 5, 100, false); err != nil {
		t.Fatalf("first process: %v", err)
	}

	prog, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	// What openCursor does on restart.
	restarted := &CursorStore{
		Pool: store.Pool, Key: store.Key, Timeout: store.Timeout,
		BaseBatches: prog.Batches, BaseUpdated: prog.Updated,
	}
	if err := restarted.Save(ctx, Cursor{Hsh: 2, UserID: "b", Set: true}, 2, 40, true); err != nil {
		t.Fatalf("second process: %v", err)
	}

	final, err := restarted.Load(ctx)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if final.Batches != 7 || final.Updated != 140 {
		t.Errorf("totals = %d batches / %d rows, want 7 / 140", final.Batches, final.Updated)
	}
	if !final.Done {
		t.Errorf("done should have been recorded")
	}
}

// --- The runner's use of it ---

// The saved cursor must never be ahead of the rows that were actually written,
// because a restart trusts it. This is the one ordering bug that would lose data.
func TestRunnerSavesTheCursorAndTheTableAgrees(t *testing.T) {
	store, done := newStore(t, "runner")
	defer done()
	ctx := context.Background()

	rows := fixtureRows()
	seed(t, store.Pool, rows)

	r := newRunner(t, store.Pool, 2)
	r.Sink = store

	// Stop short, the way a killed pod does.
	partial, err := r.Run(ctx, Cursor{}, 2)
	if err != nil {
		t.Fatalf("partial run: %v", err)
	}
	if partial.Done {
		t.Fatalf("the table was covered too quickly; this test proves nothing")
	}

	prog, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if prog.Cursor != partial.Cursor {
		t.Fatalf("stored cursor %+v, run reported %+v", prog.Cursor, partial.Cursor)
	}

	// Resume from the STORED cursor, as a restarted pod would, and the whole
	// table must still come out right.
	resumed, err := newRunnerWithSink(t, store, 2).Run(ctx, prog.Cursor, 100)
	if err != nil {
		t.Fatalf("resumed run: %v", err)
	}
	if !resumed.Done {
		t.Fatalf("the resumed run did not finish")
	}
	assertDerived(t, derived(t, store.Pool), rows)

	final, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !final.Done {
		t.Errorf("reaching the end of the table must record done")
	}
}

func newRunnerWithSink(t *testing.T, store *CursorStore, batchSize int) *Runner {
	t.Helper()
	r := newRunner(t, store.Pool, batchSize)
	r.Sink = store
	return r
}

// A rehearsal rolls its work back. If it also advanced the stored cursor, the
// next real run would skip every range it rehearsed -- rows silently never
// written, which is the failure mode this whole tool is careful about.
func TestARehearsalNeverMovesTheStoredCursor(t *testing.T) {
	store, done := newStore(t, "rehearsal")
	defer done()
	ctx := context.Background()

	seed(t, store.Pool, fixtureRows())

	r := newRunnerWithSink(t, store, 2)
	r.Rehearse = true
	if _, err := r.Run(ctx, Cursor{}, 100); err != nil {
		t.Fatalf("rehearsal: %v", err)
	}

	got, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got.Found {
		t.Fatalf("a rehearsal wrote a cursor: %+v", got)
	}
}

func TestADryRunNeverMovesTheStoredCursor(t *testing.T) {
	store, done := newStore(t, "dryrun")
	defer done()
	ctx := context.Background()

	seed(t, store.Pool, fixtureRows())

	r := newRunnerWithSink(t, store, 2)
	r.DryRun = true
	if _, err := r.Run(ctx, Cursor{}, 100); err != nil {
		t.Fatalf("dry run: %v", err)
	}

	got, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got.Found {
		t.Fatalf("a dry run wrote a cursor: %+v", got)
	}
}

// A run with no sink must behave exactly as it did before this existed.
func TestRunnerWithNoSinkStillWorks(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()

	rows := fixtureRows()
	seed(t, pool, rows)

	res, err := newRunner(t, pool, 3).Run(context.Background(), Cursor{}, 100)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !res.Done {
		t.Fatalf("did not reach the end of the table")
	}
	assertDerived(t, derived(t, pool), rows)
}
