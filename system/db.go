package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v4/pgxpool"
)

func getPool(cfg *Config) *pgxpool.Pool {
	conn := fmt.Sprintf("postgresql://%s@%s:%s/%s?sslmode=disable", cfg.DbUser, cfg.DbHost, cfg.DbPort, cfg.DbName)
	dbConfig, err := pgxpool.ParseConfig(conn)
	handle(err)

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, dbConfig)
	handle(err)

	return pool
}
