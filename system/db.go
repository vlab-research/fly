package main

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jackc/pgx/v4/pgxpool"
)

func getPool(cfg *Config) *pgxpool.Pool {
	con := fmt.Sprintf("postgresql://%s@%s:%d/%s?sslmode=disable", cfg.DbUser, cfg.DbHost, cfg.DbPort, cfg.DbName)
	config, err := pgxpool.ParseConfig(con)
	handle(err)

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, config)
	handle(err)

	return pool
}

func getTableNames(pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(context.Background(), "SHOW TABLES;")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tableNames := []string{}
	for rows.Next() {
		var tableName, schemaName, tableType, owner, locality sql.NullString
		var estimatedRowCount int
		if err := rows.Scan(&schemaName, &tableName, &tableType, &owner, &estimatedRowCount, &locality); err != nil {

			return nil, err
		}
		tableNames = append(tableNames, tableName.String)
	}
	return tableNames, nil
}

func resetDb(pool *pgxpool.Pool, tableNames []string) error {
	query := ""
	for _, table := range tableNames {
		query += fmt.Sprintf("DELETE FROM %s; ", table)
	}

	_, err := pool.Exec(context.Background(), query)
	return err
}
