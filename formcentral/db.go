package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/vlab-research/trans"
)

func getPool() *pgxpool.Pool {
	config := getConfig()
	conn := fmt.Sprintf("postgresql://%s@%s:%s/%s?sslmode=disable", config.User, config.Host, config.Port, config.Db)
	dbConfig, err := pgxpool.ParseConfig(conn)
	handle(err)

	dbConfig.MaxConns = int32(32)

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, dbConfig)
	handle(err)

	return pool
}

func getForm(pool *pgxpool.Pool, dest string) (*trans.FormJson, error) {
	query := `SELECT form_json FROM surveys WHERE id = $1`

	form := new(trans.FormJson)
	err := pool.QueryRow(context.Background(), query, dest).Scan(form)
	if err != nil {
		return nil, err
	}
	return form, err
}

func getTranslationForms(pool *pgxpool.Pool, surveyid string) (*trans.FormJson, *trans.FormJson, error) {
	query := `
        WITH t AS
           (SELECT
              form_json,
              (CASE WHEN (translation_conf->>'self')::BOOL = true
                    THEN id
                    ELSE (translation_conf->>'destination')::UUID
                    END) as dest
            FROM surveys
            WHERE id = $1)
        SELECT t.form_json, surveys.form_json
        FROM t INNER JOIN surveys ON surveys.id = t.dest
    `

	src := new(trans.FormJson)
	dest := new(trans.FormJson)
	err := pool.QueryRow(context.Background(), query, surveyid).Scan(src, dest)

	return src, dest, err
}
