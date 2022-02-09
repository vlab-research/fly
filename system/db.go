package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v4/pgxpool"
)

type Row struct {
	name                 string
	dataType             string
	isNullable           bool
	columnDefault        *string
	generationExpression string
	indices              []string
	isHidden             bool
}

func getRows(pool *pgxpool.Pool, tableName string) ([]Row, error) {
	query := fmt.Sprintf("SHOW COLUMNS FROM %s", tableName)
	rows, err := pool.Query(context.Background(), query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	rs := []Row{}
	for rows.Next() {
		var r Row
		err := rows.Scan(&r.name, &r.dataType, &r.isNullable, &r.columnDefault, &r.generationExpression, &r.indices, &r.isHidden)
		if err != nil {
			return nil, err
		}
		rs = append(rs, r)
	}
	return rs, nil
}

type Table struct {
	name string
	rows []Row
}

func getTables(pool *pgxpool.Pool, tableNames []string) ([]Table, error) {
	tables := []Table{}
	for _, table := range tableNames {
		rows, err := getRows(pool, table)
		if err != nil {
			return nil, err
		}
		table := Table{table, rows}
		tables = append(tables, table)
	}
	return tables, nil
}

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
		var tableName string
		err := rows.Scan(&tableName)
		if err != nil {
			return nil, err
		}
		tableNames = append(tableNames, tableName)
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
