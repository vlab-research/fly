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
	User string `json:"user"`
	Page string `json:"page"`
	// Platform is the messaging platform of the conversation
	// ('messenger' | 'whatsapp'), read as COALESCE(states.platform,
	// 'messenger') — legacy state rows without md.platform report
	// 'messenger'. Botserver's /synthetic endpoint passes unknown
	// fields through, so this rides along to replybot untouched.
	Platform string `json:"platform,omitempty"`
	Event    *Event `json:"event"`
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
	var userid, pageid, platform string
	err := rows.Scan(&userid, &pageid, &platform)
	handle(err)

	return &ExternalEvent{User: userid, Page: pageid, Platform: platform, Event: &Event{"redo", nil}}
}

func getTimeout(rows pgx.Rows) *ExternalEvent {
	var waitStart int64
	var userid, pageid, platform string
	err := rows.Scan(&waitStart, &userid, &pageid, &platform)
	handle(err)

	b, _ := json.Marshal(waitStart)
	value := json.RawMessage(b)

	return &ExternalEvent{User: userid, Page: pageid, Platform: platform, Event: &Event{"timeout", &value}}
}

func getPayment(rows pgx.Rows) *ExternalEvent {
	var userid, pageid, question, platform string
	err := rows.Scan(&userid, &pageid, &question, &platform)
	handle(err)

	v := struct {
		Question string `json:"question"`
	}{
		Question: question,
	}

	b, _ := json.Marshal(v)
	value := json.RawMessage(b)

	return &ExternalEvent{User: userid, Page: pageid, Platform: platform, Event: &Event{"repeat_payment", &value}}
}

func getFollowUp(rows pgx.Rows) *ExternalEvent {
	var question string
	var userid, pageid, platform string
	err := rows.Scan(&question, &userid, &pageid, &platform)
	handle(err)

	b, _ := json.Marshal(question)
	value := json.RawMessage(b)

	return &ExternalEvent{User: userid, Page: pageid, Platform: platform, Event: &Event{"follow_up", &value}}
}

func getBlockUser(rows pgx.Rows) *ExternalEvent {
	var userid, pageid, platform string
	err := rows.Scan(&userid, &pageid, &platform)
	handle(err)

	value := json.RawMessage([]byte(`null`))
	return &ExternalEvent{User: userid, Page: pageid, Platform: platform, Event: &Event{"block_user", &value}}
}

func Respondings(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
	query := `SELECT userid, pageid, COALESCE(platform, 'messenger')
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

	query := `SELECT userid, pageid, COALESCE(platform, 'messenger')
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

	query := `SELECT userid, pageid, COALESCE(platform, 'messenger')
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
	      SELECT userid, pageid, state_json->>'question' as question, COALESCE(platform, 'messenger')
	      FROM states
	      WHERE current_state = 'WAIT_EXTERNAL_EVENT'
	      AND state_json->'wait'->>'type' != 'timeout'
	      AND timezone('UCT', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + ($1)::INTERVAL)) < $4
              AND timezone('UCT', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + ($2)::INTERVAL)) > $4
              AND jsonb_array_length(COALESCE(state_json->'externalEvents','[]'::jsonb)) < $3
        `
	d := time.Now().UTC()

	return get(conn, getPayment, query, cfg.PaymentGrace, cfg.PaymentInterval, cfg.PaymentMaxAttempts, d)
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
                  COALESCE(s.platform, 'messenger') AS platform,
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
                  current_state = 'WAIT_EXTERNAL_EVENT' AND
                  jsonb_array_length(COALESCE(s.state_json->'externalEvents','[]'::jsonb)) < $3
              )
              SELECT waitStart, userid, pageid, platform
              FROM timeout_dates
              WHERE
                calculated_timeout_date < $1 AND
                calculated_timeout_date > $1 - ($2)::INTERVAL
        `
	d := time.Now().UTC()

	if len(cfg.TimeoutBlacklist) > 0 {
		query += ` AND NOT (current_form = ANY($4))`
		return get(conn, getTimeout, query, d, cfg.TimeoutMaxPast, cfg.TimeoutMaxAttempts, cfg.TimeoutBlacklist)
	}

	query += ` ORDER BY calculated_timeout_date DESC LIMIT 1`

	return get(conn, getTimeout, query, d, cfg.TimeoutMaxPast, cfg.TimeoutMaxAttempts)
}

// TODO: test cockroach perf and index
// states.pageid holds the platform account id, which equals credentials.key
// for messaging entities (uniqueness enforced by the unique_messaging_account
// partial index).
func FollowUps(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
	query := `WITH x AS
                (WITH t AS
                  (SELECT state_json->>'question' as question, states.userid, states.pageid, COALESCE(states.platform, 'messenger') AS platform, surveys.shortcode, has_followup, surveys.created
				  FROM states
                                  INNER JOIN credentials c
                                    ON pageid = c.key AND c.entity IN ('facebook_page', 'whatsapp_business')
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
              SELECT question, userid, pageid, platform
              FROM x
              WHERE
                row_number = 1 AND
                has_followup = TRUE`

	return get(conn, getFollowUp, query, cfg.FollowUpMin, cfg.FollowUpMax)
}

// Spamming users and send BLOCK_USER event
// if the past 25 questions are all the same, block the user,
// or if the user has too many externalEvents (OOM prevention).
func Spammers(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
	query := `
              SELECT s.userid, s.pageid, COALESCE(s.platform, 'messenger')
              FROM states s
              WHERE
                s.current_state != 'USER_BLOCKED'
                AND (
                  s.state_json->'qa'->-1->>0 = s.state_json->'qa'->-25->>0
                  OR (s.state_json ? 'externalEvents' AND jsonb_array_length(s.state_json->'externalEvents') > $1)
                )
        `

	return get(conn, getBlockUser, query, cfg.SpammerExternalEventsMax)
}
