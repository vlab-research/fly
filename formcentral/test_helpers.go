package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4/pgxpool"
)

func mustExec(t testing.TB, conn *pgxpool.Pool, sql string, arguments ...interface{}) (commandTag pgconn.CommandTag) {
	var err error
	if commandTag, err = conn.Exec(context.Background(), sql, arguments...); err != nil {
		t.Fatalf("Exec unexpectedly failed with %v: %v", sql, err)
	}
	return
}

func before(t *testing.T, pool *pgxpool.Pool) {
	tables := []string{"users", "credentials", "surveys", "survey_settings"}
	for _, table := range tables {
		mustExec(t, pool, fmt.Sprintf("delete from %s;", table))
	}
}

// testConfig points the suite at whichever test database is available. The repo
// has two conventions and this has to satisfy both:
//
//	local: `make test-db` in devops/ runs CockroachDB on localhost:5433
//	       (devops/Makefile PORT=5433) and sets no environment.
//	CI:    ./test.sh runs formcentral/test.yaml, whose compose network puts
//	       CockroachDB at cockroachdb:26257 and exports CHATBASE_HOST/PORT.
//
// Hardcoding localhost:5433 pinned this to the local convention, so
// test_formcentral could never pass on CircleCI -- it dialled [::1]:5433 inside
// a container where nothing listens. Env wins; the local values are defaults.
func testConfig() *Config {
	return &Config{
		DbName:     "chatroach",
		DbHost:     envOr("CHATBASE_HOST", "localhost"),
		DbPort:     envOrInt("CHATBASE_PORT", 5433),
		DbUser:     envOr("CHATBASE_USER", "root"),
		DbMaxConns: 10,
		Port:       8000,
	}
}

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func envOrInt(key string, fallback int) int {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
