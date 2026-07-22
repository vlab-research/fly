package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v4"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/vlab-research/trans"
)

type Survey struct {
	ID               string     `json:"id"`
	Userid           string     `json:"userid"`
	Form_json        trans.Form `json:"form_json"`
	Form             string     `json:"form"`
	Shortcode        string     `json:"shortcode"`
	Translation_conf string     `json:"translation_conf"`
	Messages         string     `json:"messages"`
	Created          *time.Time `json:"created"`
	OffTime          *time.Time `json:"off_time"`
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

func getForm(pool *pgxpool.Pool, dest string) (*trans.Form, error) {
	query := `SELECT form_json FROM surveys WHERE id = $1`

	form := new(trans.Form)
	err := pool.QueryRow(context.Background(), query, dest).Scan(form)
	if err != nil {
		return nil, err
	}
	return form, err
}

func getTranslationForms(pool *pgxpool.Pool, surveyid string) (*trans.Form, *trans.Form, error) {
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

	src := new(trans.Form)
	dest := new(trans.Form)
	err := pool.QueryRow(context.Background(), query, surveyid).Scan(src, dest)

	return src, dest, err
}

// getSurveyByParams resolves a survey from the account id (pageid) that
// received the event. pageid holds the platform account id: a Facebook page
// id for Messenger, a phone_number_id for WhatsApp. The caller does not know
// the platform, so the lookup is by account_id alone (globally unique
// Meta-issued ids), with a dual-read fallback to the legacy facebook_page_id
// computed column during the migration window (planning/whatsapp-plan.md
// CHUNK 1). Remove the fallback in Phase 3.
func getSurveyByParams(pool *pgxpool.Pool, pageid string, shortcode string, created time.Time) (*Survey, error) {
	queryFmt := `
      SELECT id, s.userid, form_json, form, s.shortcode, translation_conf, messages, created, off_time
      FROM surveys s
      LEFT JOIN survey_settings
      ON s.id = survey_settings.surveyid
      WHERE s.userid=(SELECT userid FROM credentials WHERE %s=$1 LIMIT 1)
      AND s.shortcode=$2
      AND created<=$3
      ORDER BY created DESC
      LIMIT 1
   `
	s := &Survey{}
	row := pool.QueryRow(context.Background(), fmt.Sprintf(queryFmt, "account_id"), pageid, shortcode, created)
	err := row.Scan(&s.ID, &s.Userid, &s.Form_json, &s.Form, &s.Shortcode, &s.Translation_conf, &s.Messages, &s.Created, &s.OffTime)

	if err == pgx.ErrNoRows {
		// Dual-read fallback: credential may predate the platform/account_id
		// backfill (or have been written without the new columns).
		row = pool.QueryRow(context.Background(), fmt.Sprintf(queryFmt, "facebook_page_id"), pageid, shortcode, created)
		err = row.Scan(&s.ID, &s.Userid, &s.Form_json, &s.Form, &s.Shortcode, &s.Translation_conf, &s.Messages, &s.Created, &s.OffTime)
	}

	if err == pgx.ErrNoRows {
		return nil, nil
	}

	return s, err
}
