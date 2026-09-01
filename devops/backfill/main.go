package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v4/pgxpool"
)

// The imperative shell. All IO lives here; the decisions live in backfill.go.

const prodNamespaceDSNHint = "vprod"

type config struct {
	dsn         string
	batchSize   int
	maxBatches  int
	start       Cursor
	sqlDir      string
	dryRun      bool
	rehearse    bool
	assumeYes   bool
	statementTO time.Duration
	cursorKey   string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(1)
	}
}

func parseFlags() (config, error) {
	var c config
	var startHsh int64
	var startUserID string

	flag.StringVar(&c.dsn, "dsn", os.Getenv("BACKFILL_DSN"),
		"CockroachDB connection string. Defaults to $BACKFILL_DSN.")
	flag.IntVar(&c.batchSize, "batch-size", 20000, "rows per UPDATE")
	flag.IntVar(&c.maxBatches, "max-batches", 20000, "safety stop")
	flag.Int64Var(&startHsh, "start-hsh", 0, "resume cursor: hsh of the last completed batch")
	flag.StringVar(&startUserID, "start-userid", "", "resume cursor: userid of the last completed batch")
	flag.StringVar(&c.sqlDir, "sql-dir", "", "directory holding the *-expr.sql files (default: ../sql relative to this binary's source)")
	flag.BoolVar(&c.dryRun, "dry-run", false, "count what each batch WOULD update, write nothing")
	flag.BoolVar(&c.rehearse, "rehearse", false, "run the real UPDATE in a transaction and ROLL IT BACK -- proves the statement executes against real rows, persists nothing")
	flag.BoolVar(&c.assumeYes, "yes", false, "skip the interactive confirmation")
	flag.StringVar(&c.cursorKey, "cursor-key", os.Getenv("BACKFILL_CURSOR_KEY"),
		"persist the resume cursor in "+CursorTable+" under this key, and resume from it automatically. Empty (the default) keeps the cursor on stdout only. Defaults to $BACKFILL_CURSOR_KEY.")
	flag.DurationVar(&c.statementTO, "statement-timeout", 10*time.Minute, "per-statement timeout")
	flag.Parse()

	if c.dsn == "" {
		return c, fmt.Errorf("no --dsn and no $BACKFILL_DSN")
	}
	if c.dryRun && c.rehearse {
		return c, fmt.Errorf("--dry-run and --rehearse are different things; pick one")
	}
	if c.batchSize < 1 {
		return c, fmt.Errorf("--batch-size must be positive, got %d", c.batchSize)
	}
	// A resume cursor is both halves or neither: half a cursor silently skips or
	// re-does an arbitrary slice of the table.
	if (startHsh != 0) != (startUserID != "") {
		return c, fmt.Errorf("--start-hsh and --start-userid must be given together")
	}
	if startUserID != "" {
		c.start = Cursor{Hsh: startHsh, UserID: startUserID, Set: true}
	}
	if c.sqlDir == "" {
		c.sqlDir = "devops/sql"
	}
	return c, nil
}

func run() error {
	cfg, err := parseFlags()
	if err != nil {
		return err
	}

	acctExpr, err := ReadExpr(filepath.Join(cfg.sqlDir, "messages-account-id-expr.sql"))
	if err != nil {
		return err
	}
	platExpr, err := ReadExpr(filepath.Join(cfg.sqlDir, "messages-platform-expr.sql"))
	if err != nil {
		return err
	}

	fmt.Println("=========================================")
	fmt.Println("  MESSAGES ACCOUNT / PLATFORM BACKFILL")
	fmt.Println("=========================================")
	fmt.Printf("  target      %s\n", redactDSN(cfg.dsn))
	fmt.Printf("  batch size  %d\n", cfg.batchSize)
	fmt.Printf("  rule        %s/messages-{account-id,platform}-expr.sql\n", cfg.sqlDir)
	fmt.Printf("  resuming    %s\n", cfg.start)
	if cfg.cursorKey != "" {
		fmt.Printf("  cursor      %s key=%s\n", CursorTable, cfg.cursorKey)
	}
	if cfg.dryRun {
		fmt.Println("  DRY RUN     counting only, nothing will be written")
	}
	if cfg.rehearse {
		fmt.Println("  REHEARSAL   real UPDATEs, rolled back -- nothing will persist")
	}
	fmt.Println("=========================================")

	if !cfg.assumeYes && !cfg.dryRun && !cfg.rehearse {
		if err := confirm(cfg.dsn); err != nil {
			return err
		}
	}

	ctx := context.Background()
	pool, err := pgxpool.Connect(ctx, cfg.dsn)
	if err != nil {
		return fmt.Errorf("connecting: %w", err)
	}
	defer pool.Close()

	sink, alreadyDone, err := openCursor(ctx, pool, &cfg)
	if err != nil {
		return err
	}
	if alreadyDone {
		return nil
	}

	r := &Runner{
		Pool:      pool,
		AcctExpr:  acctExpr,
		PlatExpr:  platExpr,
		BatchSize: cfg.batchSize,
		DryRun:    cfg.dryRun,
		Rehearse:  cfg.rehearse,
		Timeout:   cfg.statementTO,
		Log:       func(s string) { fmt.Println(s) },
		Sink:      sink,
	}

	res, err := r.Run(ctx, cfg.start, cfg.maxBatches)
	if err != nil {
		fmt.Fprintf(os.Stderr, "\nfailed at %s\n", res.Cursor)
		fmt.Fprintf(os.Stderr, "resume with: --start-hsh=%d --start-userid=%q\n", res.Cursor.Hsh, res.Cursor.UserID)
		return err
	}

	if res.Done {
		fmt.Printf("DONE: reached the end of the table. %d rows updated across %d batches.\n", res.Updated, res.Batches)
		return nil
	}

	fmt.Printf("STOPPED at --max-batches=%d. %d rows updated.\n", cfg.maxBatches, res.Updated)
	fmt.Printf("resume with: --start-hsh=%d --start-userid=%q\n", res.Cursor.Hsh, res.Cursor.UserID)
	return nil
}

func confirm(dsn string) error {
	prompt := "Proceed? (yes/no): "
	want := "yes"

	// Typing the word is a low bar; typing it against production should be a
	// deliberate act, so production asks for something you cannot answer by
	// reflex.
	if isProd(dsn) {
		fmt.Println()
		fmt.Println("WARNING: this targets PRODUCTION and walks all 106M rows of a 384 GiB table.")
		prompt = fmt.Sprintf("Type %q to proceed: ", prodNamespaceDSNHint)
		want = prodNamespaceDSNHint
	}

	fmt.Print(prompt)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return fmt.Errorf("reading confirmation: %w", err)
	}
	if trim(line) != want {
		return fmt.Errorf("cancelled")
	}
	return nil
}

// openCursor prepares the durable resume cursor, if one was asked for. It
// returns the sink to hand the Runner, and whether the work is already finished.
//
// It also RESOLVES cfg.start: an explicit --start-hsh/--start-userid always
// wins, because an operator overriding the stored position is doing so
// deliberately and usually to recover from something. Otherwise the stored
// position is used.
//
// Every failure in here is fatal. That is the point of doing it at startup: the
// two things that break a durable cursor -- the table not existing and the user
// not being able to write it -- are both configuration, both permanent, and both
// far cheaper to hit now than 40 hours in.
func openCursor(ctx context.Context, pool *pgxpool.Pool, cfg *config) (CursorSink, bool, error) {
	if cfg.cursorKey == "" {
		return nil, false, nil
	}

	// A dry run and a rehearsal persist nothing, and the cursor is part of
	// "nothing". Saying so is better than silently ignoring the flag.
	if cfg.dryRun || cfg.rehearse {
		fmt.Println("NOTE: --cursor-key is inert under --dry-run/--rehearse; nothing will be persisted.")
		return nil, false, nil
	}

	store := &CursorStore{Pool: pool, Key: cfg.cursorKey, Timeout: cfg.statementTO}

	prog, err := store.Load(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("%w\n(is devops/migrations/31-backfill-cursor.sql applied, and can this user write %s?)", err, CursorTable)
	}

	switch {
	case cfg.start.Set:
		if prog.Found {
			fmt.Printf("NOTE: --start-hsh/--start-userid override the stored cursor (%s).\n", prog.Cursor)
		}
	case prog.Done:
		fmt.Printf("ALREADY DONE: %s key=%s records a completed run -- %d rows across %d batches.\n",
			CursorTable, cfg.cursorKey, prog.Updated, prog.Batches)
		fmt.Println("Nothing to do. Pass --start-hsh/--start-userid to run anyway.")
		return nil, true, nil
	case prog.Cursor.Set:
		cfg.start = prog.Cursor
		fmt.Printf("RESUMING from the stored cursor: %s (%d rows across %d batches so far)\n",
			prog.Cursor, prog.Updated, prog.Batches)
	}

	// Totals are cumulative across restarts; the Runner only counts its own.
	store.BaseBatches = prog.Batches
	store.BaseUpdated = prog.Updated

	// Prove the sink WRITES before any work depends on it. Load only proved it
	// reads, and SELECT and UPSERT are different privileges.
	if err := store.Save(ctx, cfg.start, 0, 0, false); err != nil {
		return nil, false, fmt.Errorf("%w\n(the cursor table is readable but not writable by this user)", err)
	}

	return store, false, nil
}
