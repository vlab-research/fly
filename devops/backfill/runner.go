package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v4"
	"github.com/jackc/pgx/v4/pgxpool"
)

// Runner is the loop. It owns the pool; the statements it runs are built by the
// pure functions in backfill.go.
type Runner struct {
	Pool      *pgxpool.Pool
	AcctExpr  string
	PlatExpr  string
	BatchSize int
	DryRun    bool
	Rehearse  bool
	Timeout   time.Duration
	Log       func(string)
}

// Result reports where a run stopped and why. `Cursor` is always the last
// position it is safe to resume from, including on error -- so a failed run is
// restartable without re-scanning what it already did.
type Result struct {
	Updated int64
	Batches int
	Cursor  Cursor
	Done    bool
}

// Run walks the primary key from `start`, updating one batch at a time, until
// the table ends or maxBatches is reached.
//
// Failure is not partial: each batch is one statement, so a batch either lands
// whole or not at all, and the cursor only advances past a batch that committed.
func (r *Runner) Run(ctx context.Context, start Cursor, maxBatches int) (Result, error) {
	res := Result{Cursor: start}

	for res.Batches < maxBatches {
		res.Batches++

		upper, hasUpper, err := r.boundary(ctx, res.Cursor)
		if err != nil {
			return res, fmt.Errorf("boundary query: %w", err)
		}

		n, err := r.update(ctx, res.Cursor, upper)
		if err != nil {
			return res, fmt.Errorf("batch %d: %w", res.Batches, err)
		}
		res.Updated += n

		verb := "updated"
		switch {
		case r.DryRun:
			verb = "would update"
		case r.Rehearse:
			verb = "rehearsed (rolled back)"
		}
		next := "END"
		if hasUpper {
			next = upper.String()
		}
		r.logf("batch %d: %s %d rows (total %d) cursor %s", res.Batches, verb, n, res.Updated, next)

		if !hasUpper {
			res.Done = true
			return res, nil
		}
		res.Cursor = upper
	}

	return res, nil
}

func (r *Runner) boundary(ctx context.Context, cur Cursor) (Cursor, bool, error) {
	q, args := BoundaryQuery(cur, r.BatchSize)

	ctx, cancel := context.WithTimeout(ctx, r.Timeout)
	defer cancel()

	var next Cursor
	err := r.Pool.QueryRow(ctx, q, args...).Scan(&next.Hsh, &next.UserID)
	if err == pgx.ErrNoRows {
		// Fewer than BatchSize rows remain: this is the final batch, unbounded above.
		return Cursor{}, false, nil
	}
	if err != nil {
		return Cursor{}, false, err
	}

	next.Set = true
	return next, true, nil
}

func (r *Runner) update(ctx context.Context, lower, upper Cursor) (int64, error) {
	q, args := UpdateQuery(r.AcctExpr, r.PlatExpr, lower, upper)

	ctx, cancel := context.WithTimeout(ctx, r.Timeout)
	defer cancel()

	if r.DryRun {
		// Same predicate, no write and no locks. Cheap enough to run over the whole
		// table to find out how much work there is.
		var n int64
		countQ := "SELECT count(*) FROM chatroach.messages WHERE " + afterWhere(q)
		if err := r.Pool.QueryRow(ctx, countQ, args...).Scan(&n); err != nil {
			return 0, err
		}
		return n, nil
	}

	if r.Rehearse {
		return r.rehearse(ctx, q, args)
	}

	tag, err := r.Pool.Exec(ctx, q, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// rehearse runs the REAL UPDATE inside a transaction and then rolls it back.
//
// This is strictly stronger than --dry-run, and it is the thing to run before
// touching production. A count proves the predicate matches rows; a rehearsal
// proves the whole statement executes -- the expressions evaluate against every
// real shape in the range, the writes pass every constraint and index on the
// table, and the batch fits in one transaction -- and then leaves nothing behind.
//
// It is NOT free: the rollback discards the work but the work still happened, so
// a rehearsal costs roughly what the real run costs and takes real locks for the
// duration of the batch. Rehearse a few batches, not the table.
func (r *Runner) rehearse(ctx context.Context, q string, args []interface{}) (int64, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	// Rollback unconditionally. The deferred call is the safety net; the explicit
	// one below is the intent. Rolling back twice is a no-op.
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, q, args...)
	if err != nil {
		return 0, err
	}

	if err := tx.Rollback(ctx); err != nil {
		// A failed rollback is the one outcome that could leave a rehearsal
		// persisted, so it is an error rather than something to swallow.
		return 0, fmt.Errorf("ROLLBACK FAILED after rehearsing %d rows: %w", tag.RowsAffected(), err)
	}
	return tag.RowsAffected(), nil
}

// afterWhere returns everything following the first " WHERE " in a statement.
// Used only to turn the batch UPDATE into its counting twin for --dry-run, so
// the two cannot describe different rows.
func afterWhere(q string) string {
	_, after, found := strings.Cut(q, " WHERE ")
	if !found {
		return "true"
	}
	return after
}

func (r *Runner) logf(format string, a ...interface{}) {
	if r.Log == nil {
		return
	}
	r.Log(fmt.Sprintf(format, a...))
}
