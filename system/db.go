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
	rows, err := pool.Query(context.Background(), "SHOW TABLES;")
	if err != nil {
		return err
	}
	defer rows.Close()

	tablenames := []string{}
	for rows.Next() {
		var tablename string
		if err := rows.Scan(&tablename); err != nil {
			return err
		}
		tablenames = append(tablenames, tablename)
	}

	query := fmt.Sprintf("TRUNCATE %s;", strings.Join(tablenames[:], ","))
	err = pool.QueryRow(context.Background(), query)
	if err != nil {
		return err
	}
}
