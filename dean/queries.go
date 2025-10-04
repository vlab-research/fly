package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v4"
	"github.com/jackc/pgx/v4/pgxpool"
)

type Event struct {
	Type  string           `json:"type"`
	Value *json.RawMessage `json:"value,omitempty"`
}

type ExternalEvent struct {
	User  string `json:"user"`
	Page  string `json:"page"`
	Event *Event `json:"event"`
}

type EventMaker func(pgx.Rows) *ExternalEvent
type Query func(*Config, *pgxpool.Pool) <-chan *ExternalEvent

func get(conn *pgxpool.Pool, fn EventMaker, query string, args ...interface{}) <-chan *ExternalEvent {
	ch := make(chan *ExternalEvent)

	rows, err := conn.Query(context.Background(), query, args...)
	handle(err)

	go func() {
		defer rows.Close()
		defer close(ch)

		for rows.Next() {
			ch <- fn(rows)
		}
	}()

	return ch
}

func getRedo(rows pgx.Rows) *ExternalEvent {
	var userid, pageid string
	err := rows.Scan(&userid, &pageid)
	handle(err)

	return &ExternalEvent{userid, pageid, &Event{"redo", nil}}
}

func getTimeout(rows pgx.Rows) *ExternalEvent {
	var waitStart int64
	var userid, pageid string
	err := rows.Scan(&waitStart, &userid, &pageid)
	handle(err)

	b, _ := json.Marshal(waitStart)
	value := json.RawMessage(b)

	return &ExternalEvent{userid, pageid, &Event{"timeout", &value}}
}

func getPayment(rows pgx.Rows) *ExternalEvent {
	var userid, pageid, question string
	err := rows.Scan(&userid, &pageid, &question)
	handle(err)

	v := struct {
		Question string `json:"question"`
	}{
		Question: question,
	}

	b, _ := json.Marshal(v)
	value := json.RawMessage(b)

	return &ExternalEvent{userid, pageid, &Event{"repeat_payment", &value}}
}

func getFollowUp(rows pgx.Rows) *ExternalEvent {
	var question string
	var userid, pageid string
	err := rows.Scan(&question, &userid, &pageid)
	handle(err)

	b, _ := json.Marshal(question)
	value := json.RawMessage(b)

	return &ExternalEvent{userid, pageid, &Event{"follow_up", &value}}
}

func getBlockUser(rows pgx.Rows) *ExternalEvent {
	var userid, pageid string
	err := rows.Scan(&userid, &pageid)
	handle(err)

	value := json.RawMessage([]byte(`null`))
	return &ExternalEvent{userid, pageid, &Event{"block_user", &value}}
}

func Respondings(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
	query := `SELECT userid, pageid
              FROM states
              WHERE
                current_state = 'RESPONDING' AND
                updated + ($1)::INTERVAL > $4 AND
                ($4 - updated) > ($2)::INTERVAL AND
                (state_json->'retries' IS NULL OR JSON_ARRAY_LENGTH(state_json->'retries') < $3)`

	d := time.Now().UTC()
	return get(conn, getRedo, query, cfg.RespondingInterval, cfg.RespondingGrace, cfg.RetryMaxAttempts, d)
}

func Errored(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {

	query := `SELECT userid, pageid
              FROM states
              WHERE
                current_state = 'ERROR' AND
                error_tag = ANY($1) AND
                updated + ($2)::INTERVAL > $4 AND
                ($4 > next_retry OR next_retry IS NULL) AND
                (state_json->'retries' IS NULL OR JSON_ARRAY_LENGTH(state_json->'retries') < $3)`

	d := time.Now().UTC()
	return get(conn, getRedo, query, cfg.ErrorTags, cfg.ErrorInterval, cfg.RetryMaxAttempts, d)
}

func Blocked(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {

	query := `SELECT userid, pageid
              FROM states
              WHERE
                current_state = 'BLOCKED' AND
                fb_error_code = ANY($1) AND
                updated + ($2)::INTERVAL > $4 AND 
                ($4 > next_retry OR next_retry IS NULL) AND 
                (state_json->'retries' IS NULL OR JSON_ARRAY_LENGTH(state_json->'retries') < $3)`

	d := time.Now().UTC()
	return get(conn, getRedo, query, cfg.Codes, cfg.BlockedInterval, cfg.RetryMaxAttempts, d)
}

func Payments(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
	query := `
	      SELECT userid, pageid, state_json->>'question' as question
	      FROM states
	      WHERE current_state = 'WAIT_EXTERNAL_EVENT'
	      AND state_json->'wait'->>'type' != 'timeout'
	      AND timezone('UCT', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + ($1)::INTERVAL)) < $3
              AND timezone('UCT', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + ($2)::INTERVAL)) > $3
        `
	d := time.Now().UTC()

	return get(conn, getPayment, query, cfg.PaymentGrace, cfg.PaymentInterval, d)
}

func Timeouts(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
	query := `
              with unrolled_settings as (
                SELECT
                  surveyid,
                  json_array_elements(timeouts)->>'name' AS name,
                  json_array_elements(timeouts)->>'type' AS type,
                  json_array_elements(timeouts)->>'value' AS value
                FROM survey_settings
                WHERE timeouts IS NOT NULL
                  AND json_typeof(timeouts) = 'array'
              ),
              timeout_dates as (
                SELECT
                  s.userid,
                  s.pageid,
                  s.current_form,
                  (state_json->>'waitStart')::int as waitStart,
                  CASE
                    WHEN s.timeout_date IS NOT NULL THEN s.timeout_date
                    WHEN settings.type = 'relative' THEN timezone('UTC', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + (settings.value)::INTERVAL))
                    WHEN settings.type = 'absolute' THEN timezone('UTC',parse_timestamp(settings.value))
                  END as calculated_timeout_date
                FROM states s
                LEFT JOIN surveys surv
                  ON surv.shortcode = s.current_form
                LEFT JOIN unrolled_settings settings
                  ON settings.surveyid = surv.id
                  AND settings.name = s.state_json->'wait'->'value'->>'variable'
                WHERE
                  surv.created <= s.form_start_time AND
                  current_state = 'WAIT_EXTERNAL_EVENT'
              )
              SELECT waitStart, userid, pageid
              FROM timeout_dates
              WHERE
                calculated_timeout_date < $1 AND
                calculated_timeout_date > $1 - ($2)::INTERVAL
        `
	d := time.Now().UTC()

	if len(cfg.TimeoutBlacklist) > 0 {
		query += ` AND NOT (current_form = ANY($3))`
		return get(conn, getTimeout, query, d, cfg.TimeoutMaxPast, cfg.TimeoutBlacklist)
	}

	query += ` ORDER BY calculated_timeout_date DESC LIMIT 1`

	return get(conn, getTimeout, query, d, cfg.TimeoutMaxPast)
}

// TODO: test cockroach perf and index
func FollowUps(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
	query := `WITH x AS
                (WITH t AS
                  (SELECT state_json->>'question' as question, states.userid, states.pageid, surveys.shortcode, has_followup, surveys.created
				  FROM states
                                  INNER JOIN credentials c
                                    ON pageid = facebook_page_id
				  INNER JOIN surveys
                                    ON states.current_form = surveys.shortcode
                                    AND c.userid = surveys.userid
				  WHERE
					surveys.created <= form_start_time AND
					current_state = 'QOUT'  AND
					previous_is_followup = FALSE AND
					previous_with_token = FALSE AND
					(NOW() - updated) > ($1)::INTERVAL AND
					(NOW() - updated) < ($2)::INTERVAL
                  )
                SELECT *, ROW_NUMBER() OVER (PARTITION BY userid, pageid, shortcode ORDER BY created DESC)
                FROM t
              )
              SELECT question, userid, pageid
              FROM x
              WHERE
                row_number = 1 AND
                has_followup = TRUE`

	return get(conn, getFollowUp, query, cfg.FollowUpMin, cfg.FollowUpMax)
}

// Spamming users and send BLOCK_USER event
// if the past 25 questions are all the same, block the user.
func Spammers(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
	query := `
              SELECT s.userid, s.pageid
              FROM states s
              WHERE
                s.state_json->'qa'->-1->>0 = state_json->'qa'->-25->>0
        `

	return get(conn, getBlockUser, query)
}
