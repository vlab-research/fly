package main

import (
	"context"
	"fmt"
	"testing"

	"github.com/confluentinc/confluent-kafka-go/kafka"
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

func getCol(pool *pgxpool.Pool, table string, col string) []*string {
	q := fmt.Sprintf("SELECT %v FROM %v", col, table)
	rows, err := pool.Query(context.Background(), q)
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
