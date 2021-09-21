package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v4/pgxpool"
)

func getPool(cfg *Config) *pgxpool.Pool {
	conn := fmt.Sprintf("postgresql://%s@%s:%s/%s?sslmode=disable", cfg.DbUser, cfg.DbHost, cfg.DbPort, cfg.DbName)
	config, err := pgxpool.ParseConfig(conn)
	handle(err)

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, config)
	handle(err)

	return pool
}

func resetDb(pool *pgxpool.Pool) error {
}
