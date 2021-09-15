package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/vlab-research/trans"
)

type Survey struct {
   ID               string         `json:"id"`
   Userid           string         `json:"userid"`
   Form_json        trans.FormJson `json:"form_json"`
   Shortcode        int            `json:"shortcode"`
   Translation_conf trans.FormJson `json:"translation_conf"`
   Created          time.Time      `json:"created"`
}

func getPool(cfg *Config) *pgxpool.Pool {
	con := fmt.Sprintf("postgresql://%s@%s:%d/%s?sslmode=disable", cfg.DbUser, cfg.DbHost, cfg.DbPort, cfg.DbName)
	config, err := pgxpool.ParseConfig(con)
	handle(err)

	config.MaxConns = int32(cfg.DbMaxConns)

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, config)
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

func getSurveysByParams(pool *pgxpool.Pool, pageid string, code string, created string) ([]Survey, error) {
   query := `
      SELECT id, userid, form_json, shortcode, translation_conf, created
      FROM surveys
      WHERE userid=(SELECT userid FROM credentials WHERE facebook_page_id=$1 LIMIT 1)
      AND shortcode=$2
      AND created<=$3
      ORDER BY created DESC
   `
   rows, err := pool.Query(context.Background(), query, pageid, code, created)

   surveys := []Survey{}
   for rows.Next() {
      s := Survey{}
      err := rows.Scan(&s.ID, &s.Userid, &s.Form_json, &s.Shortcode, &s.Translation_conf, &s.Created)
      if err != nil {
         fmt.Println(err)
      }
      surveys = append(surveys, s)
   }

   return surveys, err
}
