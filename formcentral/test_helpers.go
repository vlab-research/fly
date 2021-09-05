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

func testPool() *pgxpool.Pool {
	url := fmt.Sprintf("postgres://%s:%s@%s:%s/%s", PostgresUser, PostgresPassword, PostgresHost, PostgresPort, PostgresDb)
	config, err := pgxpool.ParseConfig(url)
	handle(err)

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, config)
	handle(err)

	return pool
}
