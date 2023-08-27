package main

import (
	"context"
	"github.com/stretchr/testify/assert"
	"testing"
)

const (
	insertUserSql = `INSERT INTO users(id, email) VALUES ('e49cbb6b-45e1-4b9d-9516-094c63cc6ca3', 'test@test.com');`

	insertSurveySql = `INSERT INTO surveys(userid, created, formid, shortcode, title, id, form, translation_conf) VALUES ('e49cbb6b-45e1-4b9d-9516-094c63cc6ca3', NOW(), 'foo', 'bar', 'bar-title', $1, $2, $3);`

	formA = `{"fields": [
          {"title": "What is your gender? ",
           "ref": "foo",
           "properties": {
              "choices": [{"label": "Male"},
                          {"label": "Female"},
                          {"label": "Other"}]},
           "type": "multiple_choice"},
          {"title": "Which state do you currently live in?\n- A. foo 91  bar\n- B. Jharkhand\n- C. Odisha\n- D. Uttar Pradesh",
           "ref": "bar",
           "properties": {"choices": [{"label": "A"},
                                      {"label": "B"},
                                      {"label": "C"},
                                      {"label": "D"}]},
           "type": "multiple_choice"},
           {"title": "How old are you?",
           "ref": "baz",
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

func TestResponseWriterWritesGoodData(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, insertSurveySql, "d6c21c81-fcd0-4aa4-8975-8584d8bdb820", formA, `{}`)

	msgs := makeMessages([]string{
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"LOL",
          "seed":858044518,
          "metadata": {"foo":"bar","seed": 8978437},
          "timestamp":1599039840517}`,
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"bar",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"LOL",
          "seed":858044518,
          "metadata": {"foo":"bar","seed": 8978437},
          "timestamp":1599039840517}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "responses", "userid")
	assert.Equal(t, 2, len(res))
	assert.Equal(t, "bar", *res[0])
	assert.Equal(t, "foo", *res[1])

	res = getCol(pool, "responses", "metadata->>'foo'")
	assert.Equal(t, 2, len(res))
	assert.Equal(t, "bar", *res[0])
	assert.Equal(t, "bar", *res[1])

}

func TestResponseWriterWritesNullPageIdIfNone(t *testing.T) {
	pool := testPool()
	defer pool.Close()

	before(pool)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, insertSurveySql, "d6c21c81-fcd0-4aa4-8975-8584d8bdb820", formA, `{}`)

	msgs := makeMessages([]string{
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"LOL",
          "seed":858044518,
          "metadata": {"foo":"bar","seed": 8978437},
          "timestamp":1599039840517}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	rows, err := pool.Query(context.Background(), "select pageid from responses where pageid is null")

	res := rowStrings(rows)
	assert.Equal(t, 1, len(res))

}

func TestResponseWriterWritesPageIdIfExists(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, insertSurveySql, "d6c21c81-fcd0-4aa4-8975-8584d8bdb820", formA, `{}`)

	msgs := makeMessages([]string{
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"LOL",
          "seed":858044518,
          "metadata": {"foo":"bar","seed": 8978437},
          "timestamp":1599039840517}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "responses", "pageid")
	assert.Equal(t, 1, len(res))
	assert.Equal(t, "baz", *res[0])

}

func TestResponseWriterHandlesMixedResponseAndShortCodeTypes(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, insertSurveySql, "d6c21c81-fcd0-4aa4-8975-8584d8bdb820", formA, `{}`)

	msgs := makeMessages([]string{
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":true,
          "seed":858044518,
          "metadata": {"foo":"bar","seed": 8978437},
          "timestamp":1599039840517}`,
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
          "pageid": "baz",
          "question_ref":"baz",
          "question_idx":1,
          "question_text":"foobar",
          "response":"yes",
          "seed":858044518,
          "metadata": {"foo":"bar","seed": 8978437},
          "timestamp":1599039840517}`,
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":123,
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":123,
          "flowid":1,
          "userid":"foo",
          "pageid": "baz",
          "question_ref":"qux",
          "question_idx":1,
          "question_text":"foobar",
          "response":25,
          "seed":858044518,
          "metadata": {"foo":"bar","seed": 8978437},
          "timestamp":1599039840517}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "responses", "response")
	assert.Equal(t, 3, len(res))
	assert.Equal(t, "25", *res[0])
	assert.Equal(t, "true", *res[1])
	assert.Equal(t, "yes", *res[2])

	res = getCol(pool, "responses", "shortcode")
	assert.Equal(t, 3, len(res))
	assert.Equal(t, "123", *res[0])
	assert.Equal(t, "baz", *res[2])

}

func TestResponseWriterFailsOnMissingData(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, insertSurveySql, "d6c21c81-fcd0-4aa4-8975-8584d8bdb820", formA, `{}`)

	msgs := makeMessages([]string{
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
"pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "seed":858044518,
          "metadata": {"foo":"bar","seed": 8978437},
          "timestamp":1599039840517}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.NotNil(t, err)

	res := getCol(pool, "responses", "userid")
	assert.Equal(t, 0, len(res))

}

func TestResponseWriterFailsOnMissingMetadata(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, insertSurveySql, "d6c21c81-fcd0-4aa4-8975-8584d8bdb820", formA, `{}`)

	msgs := makeMessages([]string{
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"LOL",
          "seed":858044518,
          "timestamp":1599039840517}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.NotNil(t, err)

	res := getCol(pool, "responses", "userid")
	assert.Equal(t, 0, len(res))

}

func TestResponseWriterWritesPoorlyFormattedMetadata(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, insertSurveySql, "d6c21c81-fcd0-4aa4-8975-8584d8bdb820", formA, `{}`)

	msgs := makeMessages([]string{
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"LOL",
          "seed":858044518,
          "metadata":"{\"foo\":\"bar\",\"startTime\":1599039840517}",
          "timestamp":1599039840517}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	// TODO: not sure what this is really testing...
	res := getCol(pool, "responses", "metadata")
	assert.Equal(t, `"{\"foo\":\"bar\",\"startTime\":1599039840517}"`, *res[0])
}

func TestResponseWriterSucceedsIfMetadataEmpty(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, insertSurveySql, "d6c21c81-fcd0-4aa4-8975-8584d8bdb820", formA, `{}`)

	msgs := makeMessages([]string{
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"LOL",
          "seed":858044518,
          "metadata":{},
          "timestamp":1599039840517}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "responses", "metadata->>'foo'")
	assert.Equal(t, 1, len(res))

}

func TestResponseWriterIgnoresRepeatMessages(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertUserSql)
	mustExec(t, pool, insertSurveySql, "d6c21c81-fcd0-4aa4-8975-8584d8bdb820", formA, `{}`)

	msgs := makeMessages([]string{
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"LOL",
          "seed":858044518,
          "metadata": {"foo":"bar","seed": 8978437},
          "timestamp":1599039840517}`,
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"foo",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"LOL",
          "seed":858044518,
          "metadata": {"foo":"bar","seed": 8978437},
          "timestamp":1599039840517}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "responses", "userid")
	assert.Equal(t, 1, len(res))
	assert.Equal(t, "foo", *res[0])

}

func TestResponseWriterTranslatesSuccesfullyToOtherForm(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	mustExec(t, pool, insertUserSql)

	mustExec(t, pool, insertSurveySql, "25d88630-8b7b-4f2b-8630-4e5f9085e888", formA, `{}`)
	mustExec(t, pool, insertSurveySql, "d6c21c81-fcd0-4aa4-8975-8584d8bdb820", formB, `{"destination": "25d88630-8b7b-4f2b-8630-4e5f9085e888"}`)

	msgs := makeMessages([]string{
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"bar",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"LOL",
          "seed":858044518,
          "metadata":{},
          "timestamp":1599039840517}`,
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"bar",
          "pageid": "baz",
          "question_ref":"bar",
          "question_idx":1,
          "question_text":"foobar",
          "response":"A",
          "seed":858044518,
          "metadata":{},
          "timestamp":1999099840999}`,
		`{"parent_surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "parent_shortcode":"baz",
          "surveyid":"d6c21c81-fcd0-4aa4-8975-8584d8bdb820",
          "shortcode":"baz",
          "flowid":1,
          "userid":"bar",
          "pageid": "baz",
          "question_ref":"foo",
          "question_idx":1,
          "question_text":"foobar",
          "response":"अन्य",
          "seed":858044518,
          "metadata":{},
          "timestamp":1999099840999}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs[:1])
	assert.Nil(t, err)

	err = writer.Write(msgs[1:])
	assert.Nil(t, err)

	res := getCol(pool, "responses", "response")
	assert.Equal(t, 3, len(res))
	assert.Equal(t, "A", *res[0])
	assert.Equal(t, "LOL", *res[1])
	assert.Equal(t, "अन्य", *res[2])

	res = getCol(pool, "responses", "translated_response")
	assert.Equal(t, 3, len(res))

	assert.Nil(t, res[0])
	assert.Equal(t, "foo 91  bar", *res[1])
	assert.Equal(t, "Other", *res[2])
}
