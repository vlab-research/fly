package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/dgraph-io/ristretto"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/vlab-research/trans"
)

// TODO:
// A) JSON Schema validation if you want validation...
// OR
// B) Just validate the fields exist in the JSON (rawmessage, check all fields)
type Response struct {
	ParentShortcode    *CastString     `json:"parent_shortcode"`
	Surveyid           string          `json:"surveyid" validate:"required"`
	Shortcode          *CastString     `json:"shortcode" validate:"required"`
	Flowid             int32           `json:"flowid" validate:"required"`
	Userid             string          `json:"userid" validate:"required"`
	Pageid             string          `json:"pageid"`
	QuestionRef        string          `json:"question_ref" validate:"required"`
	QuestionIdx        int32           `json:"question_idx"` // no validate because 0 is valid...mierda
	QuestionText       string          `json:"question_text" validate:"required"`
	Response           *CastString     `json:"response" validate:"required"`
	TranslatedResponse *string         `json:"translatedResponse"`
	Seed               int64           `json:"seed" validate:"required"`
	Timestamp          *JSTimestamp    `json:"timestamp" validate:"required"`
	Metadata           json.RawMessage `json:"metadata" validate:"required"`
	Platform           string          `json:"platform"`
}

func (r *Response) GetRow() []interface{} {
	// pageid is part of responses' primary key as of migration 28, so it can no
	// longer be NULL -- an identity component has no null. An absent account is
	// written as the empty-string "account unknown" sentinel, the same value the
	// migration backfilled the historical NULLs to. This path is cold: the
	// newest NULL-pageid row in production dates from 2020-09-06.
	//
	// platform is NOT part of the primary key (migration 26 added it as a
	// nullable VARCHAR), so an absent platform is written as NULL, not ''.
	// This matches messages.platform (see account.go's nullIfEmpty / PlatformOrNil)
	// and differs from pageid deliberately: the column can say "unknown"
	// honestly without grouping every unattributable row under one fake platform.
	// Required fields are validated by validator, no need for nil checks
	return []interface{}{
		r.ParentShortcode.String,
		r.Surveyid,
		r.Shortcode.String,
		r.Flowid,
		r.Userid,
		r.Pageid,
		r.QuestionRef,
		r.QuestionIdx,
		r.QuestionText,
		r.Response.String,
		r.TranslatedResponse,
		r.Seed,
		r.Timestamp.Time,
		r.Metadata,
		nullIfEmpty(r.Platform),
	}
}

type ResponseScribbler struct {
	pool  *pgxpool.Pool
	cache *ristretto.Cache
}

func (s *ResponseScribbler) SendBatch(data []Writeable) error {
	values := BatchValues(data)
	fields := []string{
		"parent_shortcode",
		"surveyid",
		"shortcode",
		"flowid",
		"userid",
		"pageid",
		"question_ref",
		"question_idx",
		"question_text",
		"response",
		"translated_response",
		"seed",
		"timestamp",
		"metadata",
		"platform",
	}
	query := SertQuery("INSERT", "responses", fields, len(data))
	// The conflict target is the conversation, not the participant. Without
	// pageid, a participant answering the same question_ref at the same instant
	// on two accounts had one of the two answers silently discarded. Requires
	// migration 28, which folds pageid into the primary key -- without it this
	// raises 42P10.
	query += " ON CONFLICT(userid, pageid, timestamp, question_ref) DO NOTHING"
	_, err := s.pool.Exec(context.Background(), query, values...)
	return err
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

func (r ResponseScribbler) cachedTranslator(response *Response) (*trans.FormTranslator, error) {
	res, ok := r.cache.Get(response.Surveyid)
	if ok {
		if res == nil {
			return nil, nil
		}
		return res.(*trans.FormTranslator), nil
	}

	src, dest, err := getTranslationForms(r.pool, response.Surveyid)
	if err != nil {
		// not found error is not an error, just no translation
		r.cache.Set(response.Surveyid, nil, 1)
		return nil, nil
	}

	translator, err := trans.MakeTranslatorByRef(src, dest)
	if err != nil {
		// This shouldn't happen, it's an error!
		return nil, err
	}

	r.cache.Set(response.Surveyid, translator, 1)
	return translator, nil
}

func (r ResponseScribbler) Translate(response *Response) (*string, error) {
	translator, err := r.cachedTranslator(response)
	if err != nil {
		log.Println(err)
		return nil, nil
	}

	if translator == nil {
		return nil, nil
	}

	return trans.Translate(response.QuestionRef, response.Response.String, translator)
}

func NewResponseScribbler(pool *pgxpool.Pool) Scribbler {
	cache, err := ristretto.NewCache(&ristretto.Config{
		NumCounters: 1e4,
		MaxCost:     1e4,
		BufferItems: 64,
	})
	if err != nil {
		panic(err)
	}

	return &ResponseScribbler{pool, cache}
}

func (s *ResponseScribbler) Marshal(msg *kafka.Message) (Writeable, error) {
	m := new(Response)
	err := json.Unmarshal(msg.Value, m)
	if err != nil {
		return nil, err
	}

	tr, err := s.Translate(m)
	if err != nil {
		return nil, err
	}

	m.TranslatedResponse = tr
	return m, nil
}
