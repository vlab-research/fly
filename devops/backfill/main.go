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

	r := &Runner{
		Pool:      pool,
		AcctExpr:  acctExpr,
		PlatExpr:  platExpr,
		BatchSize: cfg.batchSize,
		DryRun:    cfg.dryRun,
		Rehearse:  cfg.rehearse,
		Timeout:   cfg.statementTO,
		Log:       func(s string) { fmt.Println(s) },
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
