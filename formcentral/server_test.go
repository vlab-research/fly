package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
	"io"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/vlab-research/trans"
)

const (
	surveySql = `
		DROP TABLE IF EXISTS surveys;
		CREATE TABLE surveys(
			id UUID NOT NULL UNIQUE,
			userid VARCHAR NOT NULL,
			form_json JSON,
			shortcode INT NOT NULL,
			translation_conf JSON,
			created TIMESTAMPTZ NOT NULL
		);
  `

	insertSql = `INSERT INTO surveys(userid, created, id, form_json, shortcode) VALUES ('owner', NOW(), $1, $2, 1234);`

	formA = `{"fields": [
          {"title": "What is your gender? ",
           "ref": "eng_foo",
           "properties": {
              "choices": [{"label": "Male"},
                          {"label": "Female"},
                          {"label": "Other"}]},
           "type": "multiple_choice"},
          {"title": "Which state do you currently live in?\n- A. foo 91  bar\n- B. Jharkhand\n- C. Odisha\n- D. Uttar Pradesh",
           "ref": "eng_bar",
           "properties": {"choices": [{"label": "A"},
                                      {"label": "B"},
                                      {"label": "C"},
                                      {"label": "D"}]},
           "type": "multiple_choice"},
           {"title": "How old are you?",
           "ref": "eng_baz",
           "properties": {},
           "type": "number"}]}`

	formB = `{"title": "mytitle", "fields": [
          {"id": "vjl6LihKMtcX",
          "title": "आपका लिंग क्या है? ",
          "ref": "foo",
          "properties": {"choices": [{"label": "पुरुष"},
                                    {"label": "महिला"},
                                    {"label": "अन्य"}]},
          "type": "multiple_choice"},
          {"id": "mdUpJMSY8Lct",
           "title": "वर्तमान में आप किस राज्य में रहते हैं?\n- A. छत्तीसगढ़\n- B. झारखंड\n- C. ओडिशा\n- D. उत्तर प्रदेश",
           "ref": "bar",
           "properties": {"choices": [{"label": "A"},
                                      {"label": "B"},
                                      {"label": "C"},
                                      {"label": "D"}]},
           "type": "multiple_choice"},
          {"id": "mdUpJMSY8Lct",
           "title": "वर्तमान में आप किस राज्य में रहते हैं?",
           "ref": "baz",
           "properties": {},
           "type": "number"}]}`
)

func TestTranslatorReturns404IfDestinationNotFound(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	mustExec(t, pool, surveySql)

	request := fmt.Sprintf(`{"destination": "foo","form": %v}`, formA)
	body := bytes.NewReader([]byte(request))

	req := httptest.NewRequest(http.MethodPost, "/translator", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	s := &Server{pool}

	err := s.CreateTranslator(c)
	assert.Equal(t, err.(*echo.HTTPError).Code, 404)
}

func TestTranslatorReturns400IfNotTranslatable(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	f := `{"title": "mytitle", "fields": [
          {"id": "vjl6LihKMtcX",
          "title": "आपका लिंग क्या है? ",
          "ref": "foo",
          "properties": {"choices": [{"label": "पुरुष"},
                                    {"label": "महिला"},
                                    {"label": "अन्य"}]},
          "type": "multiple_choice"},
          {"id": "mdUpJMSY8Lct",
           "title": "वर्तमान में आप किस राज्य में रहते हैं?",
           "ref": "baz",
           "properties": {},
           "type": "number"}]}`

	mustExec(t, pool, surveySql)
	mustExec(t, pool, insertSql, "25d88630-8b7b-4f2b-8630-4e5f9085e888", f)

	request := fmt.Sprintf(`{"destination": "25d88630-8b7b-4f2b-8630-4e5f9085e888","form": %v}`, formA)
	body := bytes.NewReader([]byte(request))

	req := httptest.NewRequest(http.MethodPost, "/translator", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	s := &Server{pool}

	err := s.CreateTranslator(c)
	assert.Equal(t, err.(*echo.HTTPError).Code, 400)
}

func TestTranslatorReturnsTranslator(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	mustExec(t, pool, surveySql)
	mustExec(t, pool, insertSql, "25d88630-8b7b-4f2b-8630-4e5f9085e888", formB)

	request := fmt.Sprintf(`{"destination": "25d88630-8b7b-4f2b-8630-4e5f9085e888","form": %v}`, formA)
	body := bytes.NewReader([]byte(request))

	req := httptest.NewRequest(http.MethodPost, "/translator", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	s := &Server{pool}

	err := s.CreateTranslator(c)
	assert.Nil(t, err)

	assert.Equal(t, http.StatusOK, rec.Code)

	ft := new(trans.FormTranslator)
	json.Unmarshal([]byte(rec.Body.String()), ft)
	assert.True(t, ft.Fields["eng_foo"].Translate)
}

func TestTranslatorWorksWithSelf(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	mustExec(t, pool, surveySql)

	request := fmt.Sprintf(`{"self": true,"form": %v}`, formA)
	body := bytes.NewReader([]byte(request))

	req := httptest.NewRequest(http.MethodPost, "/translator", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	s := &Server{pool}

	err := s.CreateTranslator(c)
	assert.Nil(t, err)

	assert.Equal(t, http.StatusOK, rec.Code)

	ft := new(trans.FormTranslator)
	json.Unmarshal([]byte(rec.Body.String()), ft)
	assert.Equal(t, "Jharkhand", ft.Fields["eng_bar"].Mapping["B"])
}

func TestGetTranslatorGetsFromID(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	mustExec(t, pool, surveySql)
	mustExec(t, pool, insertSql, "f6807e0f-600b-40ee-9363-455fcc23aad4", formB)

	insertWithTranslation := `INSERT INTO surveys(userid, created, id, form_json, translation_conf, shortcode) VALUES ('owner', NOW(), $1, $2, $3, 1234);`
	mustExec(t, pool, insertWithTranslation, "25d88630-8b7b-4f2b-8630-4e5f9085e888", formA, `{"destination": "f6807e0f-600b-40ee-9363-455fcc23aad4"}`)

	req := httptest.NewRequest(http.MethodGet, "/translator/foo", nil)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	c.SetParamNames("surveyid")
	c.SetParamValues("25d88630-8b7b-4f2b-8630-4e5f9085e888")

	s := &Server{pool}

	err := s.GetTranslator(c)
	assert.Nil(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)

	ft := new(trans.FormTranslator)
	json.Unmarshal([]byte(rec.Body.String()), ft)
	assert.True(t, ft.Fields["eng_foo"].Translate)
	assert.Equal(t, "पुरुष", ft.Fields["eng_foo"].Mapping["Male"])
}

func TestGetTranslatorGetsSelf(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	mustExec(t, pool, surveySql)
	mustExec(t, pool, insertSql, "f6807e0f-600b-40ee-9363-455fcc23aad4", formB)

	insertWithTranslation := `INSERT INTO surveys(userid, created, id, form_json, translation_conf, shortcode) VALUES ('owner', NOW(), $1, $2, $3, 1234);`
	mustExec(t, pool, insertWithTranslation, "25d88630-8b7b-4f2b-8630-4e5f9085e888", formA, `{"self": true}`)

	req := httptest.NewRequest(http.MethodGet, "/translator/foo", nil)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	c.SetParamNames("surveyid")
	c.SetParamValues("25d88630-8b7b-4f2b-8630-4e5f9085e888")

	s := &Server{pool}

	err := s.GetTranslator(c)
	assert.Nil(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)

	ft := new(trans.FormTranslator)
	json.Unmarshal([]byte(rec.Body.String()), ft)
	assert.True(t, ft.Fields["eng_foo"].Translate)
	assert.Equal(t, "Jharkhand", ft.Fields["eng_bar"].Mapping["B"])
}

func TestGetTranslatorReturns404OnRawTranslationConf(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	mustExec(t, pool, surveySql)
	mustExec(t, pool, insertSql, "f6807e0f-600b-40ee-9363-455fcc23aad4", formB)

	insertWithTranslation := `INSERT INTO surveys(userid, created, id, form_json, translation_conf, shortcode) VALUES ('owner', NOW(), $1, $2, $3, 1234);`
	mustExec(t, pool, insertWithTranslation, "25d88630-8b7b-4f2b-8630-4e5f9085e888", formA, `{}`)

	req := httptest.NewRequest(http.MethodGet, "/translator/foo", nil)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	c.SetParamNames("surveyid")
	c.SetParamValues("foo")

	s := &Server{pool}

	err := s.GetTranslator(c)
	assert.Equal(t, err.(*echo.HTTPError).Code, 404)
}

func TestGetTranslatorReturns404OnMissingSourceForm(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	mustExec(t, pool, surveySql)
	mustExec(t, pool, insertSql, "f6807e0f-600b-40ee-9363-455fcc23aad4", formB)

	insertWithTranslation := `INSERT INTO surveys(userid, created, id, form_json, translation_conf, shortcode) VALUES ('owner', NOW(), $1, $2, $3, 1234);`
	mustExec(t, pool, insertWithTranslation, "25d88630-8b7b-4f2b-8630-4e5f9085e888", formA, `{}`)

	req := httptest.NewRequest(http.MethodGet, "/translator/foo", nil)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	c.SetParamNames("surveyid")
	c.SetParamValues("baz")

	s := &Server{pool}

	err := s.GetTranslator(c)
	assert.Equal(t, err.(*echo.HTTPError).Code, 404)
}

func TestGetTranslatorReturns500OnTranslationError(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	smallForm := `{"title": "mytitle", "fields": [
          {"id": "vjl6LihKMtcX",
          "title": "आपका लिंग क्या है? ",
          "ref": "foo",
          "properties": {"choices": [{"label": "पुरुष"},
                                    {"label": "महिला"},
                                    {"label": "अन्य"}]},
          "type": "multiple_choice"},
          {"id": "mdUpJMSY8Lct",
           "title": "वर्तमान में आप किस राज्य में रहते हैं?",
           "ref": "baz",
           "properties": {},
           "type": "number"}]}`

	mustExec(t, pool, surveySql)
	mustExec(t, pool, insertSql, "f6807e0f-600b-40ee-9363-455fcc23aad4", smallForm)

	insertWithTranslation := `INSERT INTO surveys(userid, created, id, form_json, translation_conf, shortcode) VALUES ('owner', NOW(), $1, $2, $3, 1234);`
	mustExec(t, pool, insertWithTranslation, "25d88630-8b7b-4f2b-8630-4e5f9085e888", formA, `{"destination": "f6807e0f-600b-40ee-9363-455fcc23aad4"}`)

	req := httptest.NewRequest(http.MethodGet, "/translator/foo", nil)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	c.SetParamNames("surveyid")
	c.SetParamValues("25d88630-8b7b-4f2b-8630-4e5f9085e888")

	s := &Server{pool}

	err := s.GetTranslator(c)
	assert.Equal(t, err.(*echo.HTTPError).Code, 500)
}

func TestGetSurveyByParams(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	mustExec(t, pool, surveySql)

 	credentialsSql := `
		DROP TABLE IF EXISTS credentials;
		CREATE TABLE credentials(
			userid VARCHAR NOT NULL,
			facebook_page_id VARCHAR NOT NULL
		)`
 	mustExec(t, pool, credentialsSql)

 	insertCredentialsSql := `INSERT INTO credentials(userid, facebook_page_id) VALUES ('user-test', 'page-test');`
 	mustExec(t, pool, insertCredentialsSql)

 	now := time.Time{}
 	nowFmt := now.Format(time.RFC3339)
 	insertSurveySql := `INSERT INTO surveys(id, userid, shortcode, created) VALUES ('25d88630-8b7b-4f2b-8630-4e5f9085e888', 'user-test', 1234, $1);`
 	mustExec(t, pool, insertSurveySql, nowFmt)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	c.SetParamNames("pageid", "shortcode", "timestamp")
	c.SetParamValues("page-test", "1234", nowFmt)
	s := &Server{pool}
	err := s.GetSurveysByParams(c)
	assert.Nil(t, err)
	
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	respSurvey := Survey{}
	json.Unmarshal(body, &respSurvey)

	form := trans.FormJson {
		Title: "",
		Fields: nil,
		ThankYouScreens: nil,
	}
	survey := Survey {
		ID: "25d88630-8b7b-4f2b-8630-4e5f9085e888",
		Userid: "user-test",
		Form_json: form,
		Shortcode: 1234,
		Translation_conf: form,
		Created: now,
	}

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, respSurvey, survey)
}
