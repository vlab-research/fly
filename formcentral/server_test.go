package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/vlab-research/trans"
)

const (
	surveyid = "00000000-0000-0000-0000-000000000000"
	userid = "55555555-5555-5555-5555-555555555555"
	insertUser = `INSERT INTO users(id, email) VALUES ($1, 'test@test.com');`
	insertSurvey = `
		INSERT INTO surveys(id, userid, form, formid, shortcode, title, created)
		VALUES ($1, $2, $3, 'test-form-id', 'test-sc', 'test-title', NOW());
	`
	insertWithTranslation = `
		INSERT INTO surveys(id, userid, form, translation_conf, formid, shortcode, title, created)
		VALUES ($1, $2, $3, $4, 'test-form-id', 'test-sc', 'test-title', NOW());
	`
	formA = `
		{
			"fields": [
				{
					"title": "What is your gender? ",
					"ref": "eng_foo",
					"properties": {
						"choices": [
							{ "label": "Male" },
							{ "label": "Female" },
							{ "label": "Other" }
						]
					},
					"type": "multiple_choice"
				},
				{
					"title": "Which state do you currently live in?\n- A. foo 91  bar\n- B. Jharkhand\n- C. Odisha\n- D. Uttar Pradesh",
					"ref": "eng_bar",
					"properties": {
						"choices": [
							{ "label": "A" },
							{ "label": "B" },
							{ "label": "C" },
							{ "label": "D" }
						]
					},
					"type": "multiple_choice"
				},
				{
					"title": "How old are you?",
					"ref": "eng_baz",
					"properties": {},
					"type": "number"
				}
			]
		}
	`
	formB = `
		{
			"title": "mytitle",
			"fields": [
				{
					"id": "vjl6LihKMtcX",
					"title": "आपका लिंग क्या है? ",
					"ref": "foo",
					"properties": {
						"choices": [
							{ "label": "पुरुष" },
							{ "label": "महिला" },
							{ "label": "अन्य" }
						]
					},
					"type": "multiple_choice"
				},
				{
					"id": "mdUpJMSY8Lct",
					"title": "वर्तमान में आप किस राज्य में रहते हैं?\n- A. छत्तीसगढ़\n- B. झारखंड\n- C. ओडिशा\n- D. उत्तर प्रदेश",
					"ref": "bar",
					"properties": {
						"choices": [
							{ "label": "A" },
							{ "label": "B" },
							{ "label": "C" },
							{ "label": "D" }
						]
					},
					"type": "multiple_choice"
				},
				{
					"id": "mdUpJMSY8Lct",
					"title": "वर्तमान में आप किस राज्य में रहते हैं?",
					"ref": "baz",
					"properties": {},
					"type": "number"
				}
			]
		}
	`
)

func before() {
	http.Get("http://system/resetdb")
}

func request(pool *pgxpool.Pool, method string, uri string, params string) (*httptest.ResponseRecorder, echo.Context, *Server) {
	data := bytes.NewReader([]byte(params))
	req := httptest.NewRequest(method, uri, data)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	s := &Server{pool}
	return rec, c, s
}

func TestTranslatorReturns404IfDestinationNotFound(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(&cfg)
	defer pool.Close()
	
	params := fmt.Sprintf(`{"destination": "foo", "form": %v}`, formA)
	_, c, s := request(pool, http.MethodPost, "/translator", params)
	err := s.CreateTranslator(c)

	assert.Equal(t, err.(*echo.HTTPError).Code, 404)
}

func TestTranslatorReturns400IfNotTranslatable(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(&cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser, userid)
	form := `
		{
			"title": "mytitle", 
			"fields": [
				{
					"id": "vjl6LihKMtcX",
					"title": "आपका लिंग क्या है? ",
					"ref": "foo",
					"properties": {
						"choices": [
							{ "label": "पुरुष" },
							{ "label": "महिला" },
							{ "label": "अन्य" }
						]
					},
					"type": "multiple_choice"
				},
				{
					"id": "mdUpJMSY8Lct",
					"title": "वर्तमान में आप किस राज्य में रहते हैं?",
					"ref": "baz",
					"properties": {},
					"type": "number"
				}
			]
		}
	`
	mustExec(t, pool, insertSurvey, surveyid, userid, form)

	params := fmt.Sprintf(`{"destination": surveyid, "form": %v}`, formA)
	_, c, s := request(pool, http.MethodPost, "/translator", params)
	err := s.CreateTranslator(c)

	assert.Equal(t, err.(*echo.HTTPError).Code, 400)
}

func TestTranslatorReturnsTranslator(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(&cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser, userid)
	mustExec(t, pool, insertSurvey, surveyid, userid, formB)

	params := fmt.Sprintf(`{"destination": "%v", "form": %v}`, surveyid, formA)
	rec, c, s := request(pool, http.MethodPost, "/translator", params)
	err := s.CreateTranslator(c)

	assert.Nil(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)

	ft := new(trans.FormTranslator)
	json.Unmarshal([]byte(rec.Body.String()), ft)

	assert.True(t, ft.Fields["eng_foo"].Translate)
}

func TestTranslatorWorksWithSelf(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(&cfg)
	defer pool.Close()

	params := fmt.Sprintf(`{"self": true, "form": %v}`, formA)
	rec, c, s := request(pool, http.MethodPost, "/translator", params)
	err := s.CreateTranslator(c)

	assert.Nil(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)

	ft := new(trans.FormTranslator)
	json.Unmarshal([]byte(rec.Body.String()), ft)

	assert.Equal(t, "Jharkhand", ft.Fields["eng_bar"].Mapping["B"])
}

func TestGetTranslatorGetsFromID(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(&cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser, userid)
	mustExec(t, pool, insertSurvey, "33333333-3333-3333-3333-333333333333", userid, formB)
	mustExec(t, pool, insertWithTranslation, surveyid, userid, formA, `{"destination": "33333333-3333-3333-3333-333333333333"}`)

	rec, c, s := request(pool, http.MethodGet, "/translator/foo", "")
	c.SetParamNames("surveyid")
	c.SetParamValues(surveyid)
	err := s.GetTranslator(c)

	assert.Nil(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)

	ft := new(trans.FormTranslator)
	json.Unmarshal([]byte(rec.Body.String()), ft)

	assert.True(t, ft.Fields["eng_foo"].Translate)
	assert.Equal(t, "पुरुष", ft.Fields["eng_foo"].Mapping["Male"])
}

func TestGetTranslatorGetsSelf(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(&cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser, userid)
	mustExec(t, pool, insertSurvey, "33333333-3333-3333-3333-333333333333", userid, formB)
	mustExec(t, pool, insertWithTranslation, surveyid, userid, formA, `{"self": true}`)

	rec, c, s := request(pool, http.MethodGet, "/translator/foo", "")
	c.SetParamNames("surveyid")
	c.SetParamValues(surveyid)
	err := s.GetTranslator(c)

	assert.Nil(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)

	ft := new(trans.FormTranslator)
	json.Unmarshal([]byte(rec.Body.String()), ft)

	assert.True(t, ft.Fields["eng_foo"].Translate)
	assert.Equal(t, "Jharkhand", ft.Fields["eng_bar"].Mapping["B"])
}

func TestGetTranslatorReturns404OnRawTranslationConf(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(&cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser, userid)
	mustExec(t, pool, insertSurvey, "33333333-3333-3333-3333-333333333333", userid, formB)
	mustExec(t, pool, insertWithTranslation, surveyid, userid, formA, `{}`)

	_, c, s := request(pool, http.MethodGet, "/translator/foo", "")
	c.SetParamNames("surveyid")
	c.SetParamValues("foo")
	err := s.GetTranslator(c)

	assert.Equal(t, err.(*echo.HTTPError).Code, 404)
}

func TestGetTranslatorReturns404OnMissingSourceForm(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(&cfg)
	defer pool.Close()

	_, c, s := request(pool, http.MethodGet, "/translator/foo", "")
	c.SetParamNames("surveyid")
	c.SetParamValues("baz")
	err := s.GetTranslator(c)

	assert.Equal(t, err.(*echo.HTTPError).Code, 404)
}

func TestGetTranslatorReturns500OnTranslationError(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(&cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser, userid)
	smallForm := `
		{
			"title": "mytitle",
			"fields": [
				{
					"id": "vjl6LihKMtcX",
          "title": "आपका लिंग क्या है? ",
          "ref": "foo",
          "properties": {
          	"choices": [
          		{ "label": "पुरुष" },
          		{ "label": "महिला" },
          		{ "label": "अन्य" }
          	]
          },
          "type": "multiple_choice"
        },
        {
        	"id": "mdUpJMSY8Lct",
					"title": "वर्तमान में आप किस राज्य में रहते हैं?",
					"ref": "baz",
					"properties": {},
					"type": "number"
				}
			]
		}
	`
	mustExec(t, pool, insertSurvey, "33333333-3333-3333-3333-333333333333", userid, smallForm)
	mustExec(t, pool, insertWithTranslation, surveyid, userid, formA, `{"destination": "33333333-3333-3333-3333-333333333333"}`)

	_, c, s := request(pool, http.MethodGet, "/translator/foo", "")
	c.SetParamNames("surveyid")
	c.SetParamValues(surveyid)
	err := s.GetTranslator(c)

	assert.Equal(t, err.(*echo.HTTPError).Code, 500)
}
