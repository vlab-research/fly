package db

import (
	"context"
	"log"

	"github.com/jackc/pgx/v4/pgxpool"
)

// DB wraps a connection pool for database operations
type DB struct {
	pool *pgxpool.Pool
}

// New creates a new DB instance with a connection pool
// Returns error for invalid connection strings, but logs fatal for connection failures
// following the Dean pattern
func New(connString string) (*DB, error) {
	config, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, err
	}

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, config)
	if err != nil {
		log.Fatal(err)
	}

	return &DB{pool: pool}, nil
}

// Close closes the database connection pool
func (d *DB) Close() {
	d.pool.Close()
}

// Query executes a SQL query and returns results as a slice of maps
// This is used by the executor to run dynamically built queries
func (d *DB) Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error) {
	rows, err := d.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Get column names
	fieldDescs := rows.FieldDescriptions()
	columns := make([]string, len(fieldDescs))
	for i, fd := range fieldDescs {
		columns[i] = string(fd.Name)
	}

	// Scan all rows
	var results []map[string]interface{}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}

		row := make(map[string]interface{})
		for i, col := range columns {
			row[col] = values[i]
		}
		results = append(results, row)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return results, nil
}
