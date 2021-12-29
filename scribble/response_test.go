package main

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

const (
	surveyid = "00000000-0000-0000-0000-000000000000"
	insertUser = `
		INSERT INTO users(id, email)
		VALUES ('11111111-1111-1111-1111-111111111111', 'test@test.com');
	`
	insertSurvey = `
		INSERT INTO surveys(id, userid, form, formid, shortcode, title, created, translation_conf)
		VALUES ($1, '11111111-1111-1111-1111-111111111111', $2, 'test-form-id', 'test-sc', 'test-title', NOW(), $3);
	`
	insertCredentials = `
		INSERT INTO credentials(entity, key, details, userid)
		VALUES ('facebook_page', 'foo', '{"id": "foo"}', '11111111-1111-1111-1111-111111111111');
	`
	formA = `
		{
			"fields": [
				{
					"title": "What is your gender?",
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

func TestResponseWriterWritesGoodData(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)
	mustExec(t, pool, insertSurvey, surveyid, formA, `{}`)

	msgs := makeMessages([]string{
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "11111111-1111-1111-1111-111111111111",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "LOL",
			"seed": 858044518,
			"metadata": {
				"foo": "bar",
				"seed": 8978437
			},
			"timestamp": 1599039840517
		}`,
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "22222222-2222-2222-2222-2222222222222",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "LOL",
			"seed": 858044518,
			"metadata": {
				"foo": "bar",
				"seed": 8978437
			},
			"timestamp": 1599039840517
		}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "responses", "userid")
	assert.Equal(t, 2, len(res))
	assert.Equal(t, "11111111-1111-1111-1111-111111111111", *res[0])
	assert.Equal(t, "22222222-2222-2222-2222-2222222222222", *res[1])

	res = getCol(pool, "responses", "metadata->>'foo'")
	assert.Equal(t, 2, len(res))
	assert.Equal(t, "bar", *res[0])
	assert.Equal(t, "bar", *res[1])
}

func TestResponseWriterWritesNullPageIdIfNone(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)
	mustExec(t, pool, insertSurvey, surveyid, formA, `{}`)

	msgs := makeMessages([]string{
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "11111111-1111-1111-1111-111111111111",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "LOL",
			"seed": 858044518,
			"metadata": {
				"foo": "bar",
				"seed": 8978437
			},
			"timestamp": 1599039840517
		}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	q := "SELECT pageid FROM responses WHERE pageid IS NULL"
	rows, err := pool.Query(context.Background(), q)

	res := rowStrings(rows)
	assert.Equal(t, 1, len(res))
}

func TestResponseWriterWritesPageIdIfExists(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)
	mustExec(t, pool, insertSurvey, surveyid, formA, `{}`)

	msgs := makeMessages([]string{
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "11111111-1111-1111-1111-111111111111",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "LOL",
			"seed": 858044518,
			"metadata": {
				"foo": "bar",
				"seed": 8978437
			},
			"timestamp": 1599039840517
		}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "responses", "pageid")
	assert.Equal(t, 1, len(res))
	assert.Equal(t, "baz", *res[0])
}

func TestResponseWriterHandlesMixedResponseAndShortCodeTypes(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)
	mustExec(t, pool, insertSurvey, surveyid, formA, `{}`)

	msgs := makeMessages([]string{
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "11111111-1111-1111-1111-111111111111",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": true,
			"seed": 858044518,
			"metadata": {
				"foo": "bar",
				"seed": 8978437
			},
			"timestamp": 1599039840517
		}`,
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "11111111-1111-1111-1111-111111111111",
			"pageid": "baz",
			"question_ref": "baz",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "yes",
			"seed": 858044518,
			"metadata": {
				"foo": "bar",
				"seed": 8978437
			},
			"timestamp": 1599039840518
		}`,
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": 123,
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": 123,
			"flowid": 1,
			"userid": "11111111-1111-1111-1111-111111111111",
			"pageid": "baz",
			"question_ref": "qux",
			"question_idx": 1,
			"question_text": "foobar",
			"response": 25,
			"seed": 858044518,
			"metadata": {
				"foo": "bar",
				"seed": 8978437
			},
			"timestamp": 1599039840519
		}`,
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
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	msgs := makeMessages([]string{
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "foo",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"seed": 858044518,
			"metadata": {
				"foo": "bar",
				"seed": 8978437
			},
			"timestamp": 1599039840517
		}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.NotNil(t, err)

	res := getCol(pool, "responses", "userid")
	assert.Equal(t, 0, len(res))
}

func TestResponseWriterFailsOnMissingMetadata(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	msgs := makeMessages([]string{
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "foo",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "LOL",
			"seed": 858044518,
			"timestamp": 1599039840517
		}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.NotNil(t, err)

	res := getCol(pool, "responses", "userid")
	assert.Equal(t, 0, len(res))
}

func TestResponseWriterFailsIfMetadataFormatedPoorly(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	msgs := makeMessages([]string{
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "foo",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "LOL",
			"seed": 858044518,
			"metadata": "{\"foo\":\"bar\",\"startTime\":1599039840517}",
			"timestamp": 1599039840517
		}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.NotNil(t, err)

	res := getCol(pool, "responses", "metadata->>'foo'")
	assert.Equal(t, 0, len(res))
}

func TestResponseWriterSucceedsIfMetadataEmpty(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)
	mustExec(t, pool, insertSurvey, surveyid, formA, `{}`)

	msgs := makeMessages([]string{
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "foo",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "LOL",
			"seed": 858044518,
			"metadata": {},
			"timestamp": 1599039840517
		}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "responses", "metadata->>'foo'")
	assert.Equal(t, 1, len(res))
}

func TestResponseWriterIgnoresRepeatMessages(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)
	mustExec(t, pool, insertSurvey, surveyid, formA, `{}`)

	msgs := makeMessages([]string{
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "foo",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "LOL",
			"seed": 858044518,
			"metadata": {
				"foo": "bar",
				"seed": 8978437
			},
			"timestamp": 1599039840517
		}`,
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "foo",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "LOL",
			"seed": 858044518,
			"metadata": {
				"foo": "bar",
				"seed": 8978437
			},
			"timestamp": 1599039840517
		}`,
	})

	writer := GetWriter(NewResponseScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "responses", "userid")
	assert.Equal(t, 1, len(res))
	assert.Equal(t, "foo", *res[0])
}

func TestResponseWriterTranslatesSuccesfullyToOtherForm(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)
	mustExec(t, pool, insertSurvey, "88888888-8888-8888-8888-888888888888", formA, `{}`)
	mustExec(t, pool, insertSurvey, surveyid, formB, `{"destination": "88888888-8888-8888-8888-888888888888"}`)

	msgs := makeMessages([]string{
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "bar",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "LOL",
			"seed": 858044518,
			"metadata": {},
			"timestamp": 1599039840517
		}`,
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "bar",
			"pageid": "baz",
			"question_ref": "bar",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "A",
			"seed": 858044518,
			"metadata": {},
			"timestamp": 1999099840999
		}`,
		`{
			"parent_surveyid": "00000000-0000-0000-0000-000000000000",
			"parent_shortcode": "baz",
			"surveyid": "00000000-0000-0000-0000-000000000000",
			"shortcode": "baz",
			"flowid": 1,
			"userid": "bar",
			"pageid": "baz",
			"question_ref": "foo",
			"question_idx": 1,
			"question_text": "foobar",
			"response": "अन्य",
			"seed": 858044518,
			"metadata": {},
			"timestamp": 1999099840999
		}`,
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
