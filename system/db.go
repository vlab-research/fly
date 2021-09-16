package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v4/pgxpool"
)


func createDb(pool *pgxpool.Pool, sqlFilepath string) {
	sql, err := os.ReadFile(sqlFilepath)
	handle(err)
	exec(pool, string(sql))
}

func exec(pool *pgxpool.Pool, sql string) {
	pool.Exec(context.Background(), sql)
}

func getPool(cfg *Config) *pgxpool.Pool {
	conn := fmt.Sprintf("postgresql://%s@%s:%s/%s?sslmode=disable", cfg.DbUser, cfg.DbHost, cfg.DbPort, cfg.DbName)
	dbConfig, err := pgxpool.ParseConfig(conn)
	handle(err)

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, dbConfig)
	handle(err)

	return pool
}

func resetDb(pool *pgxpool.Pool, sqlFilepath string) {
}
