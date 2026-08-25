package main

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/jackc/pgx/v4/pgxpool"
)

func makeMessages(vals []string) []*kafka.Message {
	msgs := []*kafka.Message{}
	for _, v := range vals {
		msg := &kafka.Message{}
		msg.Value = []byte(v)
		msgs = append(msgs, msg)
	}

	return msgs
}

func rowStrings(rows pgx.Rows) []*string {
	res := []*string{}
	for rows.Next() {
		col := new(string)
		_ = rows.Scan(&col)
		res = append(res, col)
	}
	return res
}

// colValues dereferences a getCol result so a whole column can be asserted as a
// single slice. A length mismatch then reports as a readable diff instead of
// panicking on an out-of-range index, which matters for the account-scoping
// tests: their failure mode IS a missing row.
func colValues(cols []*string) []string {
	out := []string{}
	for _, c := range cols {
		if c == nil {
			out = append(out, "<nil>")
			continue
		}
		out = append(out, *c)
	}
	return out
}

func getCol(pool *pgxpool.Pool, table string, col string) []*string {
	rows, err := pool.Query(context.Background(), fmt.Sprintf("select %v from %v", col, table))
	if err != nil {
		panic(err)
	}

	return rowStrings(rows)
}

func mustExec(t testing.TB, conn *pgxpool.Pool, sql string, arguments ...interface{}) (commandTag pgconn.CommandTag) {
	var err error
	if commandTag, err = conn.Exec(context.Background(), sql, arguments...); err != nil {
		t.Fatalf("Exec unexpectedly failed with %v: %v", sql, err)
	}
	return
}

// testDSN is the CockroachDB the integration tests write against. It defaults
// to the port `make -C devops test-db` publishes, and TEST_DATABASE_URL
// overrides it -- the same escape hatch exodus/query's integration tests use,
// so a second database can be stood up on a free port without a shared one
// being torn down underneath another test run.
func testDSN() string {
	if dsn := os.Getenv("TEST_DATABASE_URL"); dsn != "" {
		return dsn
	}
	return "postgres://root@localhost:5433/chatroach"
}

func testPool() *pgxpool.Pool {
	config, err := pgxpool.ParseConfig(testDSN())
	handle(err)

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, config)
	handle(err)

	return pool
}

func resetDb(pool *pgxpool.Pool, tableNames []string) error {
	query := ""
	for _, table := range tableNames {
		query += fmt.Sprintf("DELETE FROM %s; ", table)
	}

	_, err := pool.Exec(context.Background(), query)
	return err
}

func before(pool *pgxpool.Pool) {
	err := resetDb(pool, []string{"chat_log", "messages", "states", "responses", "surveys", "credentials", "users"})
	if err != nil {
		fmt.Printf("ERROR in before(): %v", err)
	}
}
