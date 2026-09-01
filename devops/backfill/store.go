package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v4"
	"github.com/jackc/pgx/v4/pgxpool"
)

// The IO half of the durable cursor. The statements live in backfill.go; this
// file only runs them.

// CursorSink is what Runner needs in order to persist its position. It is an
// interface, and nil, so the loop is unchanged for every caller that does not
// want one -- `go run` against staging still writes nothing but stdout.
type CursorSink interface {
	Save(ctx context.Context, cur Cursor, batches int, updated int64, done bool) error
}

// Progress is a cursor row as read back at startup.
type Progress struct {
	Cursor  Cursor
	Batches int
	Updated int64
	Done    bool
	Found   bool
}

// CursorStore persists the resume cursor in CursorTable under one key.
//
// Base{Batches,Updated} are the totals already recorded by earlier processes.
// Runner counts only its own work, so the store adds the base back on the way
// out -- otherwise a restart would reset the running totals an operator is
// watching to zero, which reads as "it started over" when it did not.
type CursorStore struct {
	Pool    *pgxpool.Pool
	Key     string
	Timeout time.Duration

	BaseBatches int
	BaseUpdated int64
}

// Load reads the stored position, and doubles as the proof that the table
// exists and is readable. An error here is fatal at startup by design: better
// to refuse to begin than to discover 40 hours in that nothing was being saved.
func (s *CursorStore) Load(ctx context.Context) (Progress, error) {
	q, args := CursorLoadQuery(s.Key)

	ctx, cancel := context.WithTimeout(ctx, s.Timeout)
	defer cancel()

	var p Progress
	// hsh/userid are nullable: "started, nothing finished yet" is a real state.
	var hsh *int64
	var userid *string

	err := s.Pool.QueryRow(ctx, q, args...).Scan(&hsh, &userid, &p.Batches, &p.Updated, &p.Done)
	if err == pgx.ErrNoRows {
		return Progress{}, nil
	}
	if err != nil {
		return Progress{}, fmt.Errorf("reading %s: %w", CursorTable, err)
	}

	p.Found = true
	if hsh != nil && userid != nil {
		p.Cursor = Cursor{Hsh: *hsh, UserID: *userid, Set: true}
	}
	return p, nil
}

func (s *CursorStore) Save(ctx context.Context, cur Cursor, batches int, updated int64, done bool) error {
	q, args := CursorSaveQuery(s.Key, cur, s.BaseBatches+batches, s.BaseUpdated+updated, done)

	ctx, cancel := context.WithTimeout(ctx, s.Timeout)
	defer cancel()

	_, err := s.Pool.Exec(ctx, q, args...)
	if err != nil {
		return fmt.Errorf("writing %s: %w", CursorTable, err)
	}
	return nil
}
