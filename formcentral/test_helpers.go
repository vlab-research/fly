package main

import (
	"context"
	"fmt"
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

func testConfig() *Config {
	return &Config{
		DbName:     "chatroach",
		DbHost:     "localhost",
		DbPort:     5433,
		DbUser:     "root",
		DbMaxConns: 10,
		Port:       8000,
	}
}
