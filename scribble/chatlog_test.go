package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/stretchr/testify/assert"
)

// --- Marshal tests ---

func TestChatLogMarshalAllFields(t *testing.T) {
	msg := &kafka.Message{
		Value: []byte(`{
			"userid": "user123",
			"pageid": "page456",
			"timestamp": 1598706047838,
			"direction": "outgoing",
			"content": "Hello, how are you?",
			"question_ref": "q1",
			"shortcode": "sc1",
			"surveyid": "550e8400-e29b-41d4-a716-446655440789",
			"message_type": "text",
			"raw_payload": {"type": "text", "text": "Hello"},
			"metadata": {"source": "facebook"}
		}`),
	}

	scribbler := &ChatLogScribbler{}
	w, err := scribbler.Marshal(msg)
	assert.Nil(t, err)

	entry, ok := w.(*ChatLogEntry)
	assert.True(t, ok)

	assert.Equal(t, "user123", entry.Userid)
	assert.NotNil(t, entry.Pageid)
	assert.Equal(t, "page456", *entry.Pageid)
	assert.NotNil(t, entry.Timestamp)
	assert.Equal(t, time.Unix(0, 1598706047838*1000000).UTC(), entry.Timestamp.Time)
	assert.Equal(t, "outgoing", entry.Direction)
	assert.Equal(t, "Hello, how are you?", entry.Content)
	assert.NotNil(t, entry.QuestionRef)
	assert.Equal(t, "q1", *entry.QuestionRef)
	assert.NotNil(t, entry.Shortcode)
	assert.Equal(t, "sc1", *entry.Shortcode)
	assert.NotNil(t, entry.Surveyid)
	assert.Equal(t, "550e8400-e29b-41d4-a716-446655440789", *entry.Surveyid)
	assert.NotNil(t, entry.MessageType)
	assert.Equal(t, "text", *entry.MessageType)
	assert.NotNil(t, entry.RawPayload)
	assert.NotNil(t, entry.Metadata)
}

func TestChatLogMarshalNullableFieldsAbsent(t *testing.T) {
	msg := &kafka.Message{
		Value: []byte(`{
			"userid": "user123",
			"timestamp": 1598706047838,
			"direction": "incoming",
			"content": "Hi there"
		}`),
	}

	scribbler := &ChatLogScribbler{}
	w, err := scribbler.Marshal(msg)
	assert.Nil(t, err)

	entry, ok := w.(*ChatLogEntry)
	assert.True(t, ok)

	assert.Equal(t, "user123", entry.Userid)
	assert.Nil(t, entry.Pageid)
	assert.Equal(t, "incoming", entry.Direction)
	assert.Equal(t, "Hi there", entry.Content)
	assert.Nil(t, entry.QuestionRef)
	assert.Nil(t, entry.Shortcode)
	assert.Nil(t, entry.Surveyid)
	assert.Nil(t, entry.MessageType)
}

func TestChatLogMarshalNullableFieldsExplicitNull(t *testing.T) {
	msg := &kafka.Message{
		Value: []byte(`{
			"userid": "user123",
			"pageid": null,
			"timestamp": 1598706047838,
			"direction": "incoming",
			"content": "Hi there",
			"question_ref": null,
			"shortcode": null,
			"surveyid": null,
			"message_type": null,
			"raw_payload": null,
			"metadata": null
		}`),
	}

	scribbler := &ChatLogScribbler{}
	w, err := scribbler.Marshal(msg)
	assert.Nil(t, err)

	entry, ok := w.(*ChatLogEntry)
	assert.True(t, ok)

	assert.Equal(t, "user123", entry.Userid)
	assert.Nil(t, entry.Pageid)
	assert.Nil(t, entry.QuestionRef)
	assert.Nil(t, entry.Shortcode)
	assert.Nil(t, entry.Surveyid)
	assert.Nil(t, entry.MessageType)
	// json.RawMessage for explicit JSON null stores the literal bytes "null"
	assert.Equal(t, json.RawMessage("null"), entry.RawPayload)
	assert.Equal(t, json.RawMessage("null"), entry.Metadata)
}

func TestChatLogMarshalInvalidJSON(t *testing.T) {
	msg := &kafka.Message{
		Value: []byte(`{not valid json`),
	}

	scribbler := &ChatLogScribbler{}
	w, err := scribbler.Marshal(msg)
	assert.NotNil(t, err)
	assert.Nil(t, w)
}

func TestChatLogMarshalEmptyJSON(t *testing.T) {
	msg := &kafka.Message{
		Value: []byte(`{}`),
	}

	scribbler := &ChatLogScribbler{}
	w, err := scribbler.Marshal(msg)
	assert.Nil(t, err)

	entry, ok := w.(*ChatLogEntry)
	assert.True(t, ok)

	assert.Equal(t, "", entry.Userid)
	assert.Equal(t, "", entry.Direction)
	assert.Equal(t, "", entry.Content)
	assert.Nil(t, entry.Pageid)
	assert.Nil(t, entry.Timestamp)
}

func TestChatLogMarshalTimestampParsedCorrectly(t *testing.T) {
	msg := &kafka.Message{
		Value: []byte(`{
			"userid": "user1",
			"timestamp": 1599039840517,
			"direction": "incoming",
			"content": "test"
		}`),
	}

	scribbler := &ChatLogScribbler{}
	w, err := scribbler.Marshal(msg)
	assert.Nil(t, err)

	entry := w.(*ChatLogEntry)
	// JSTimestamp converts milliseconds to time.Time via time.Unix(0, ms*1000000)
	expected := time.Unix(0, 1599039840517*1000000).UTC()
	assert.Equal(t, expected, entry.Timestamp.Time)
}

func TestChatLogMarshalRawPayloadPreserved(t *testing.T) {
	rawPayload := `{"type":"image","url":"https://example.com/img.png","caption":"test"}`
	msg := &kafka.Message{
		Value: []byte(`{
			"userid": "user1",
			"timestamp": 1598706047838,
			"direction": "incoming",
			"content": "test",
			"raw_payload": ` + rawPayload + `
		}`),
	}

	scribbler := &ChatLogScribbler{}
	w, err := scribbler.Marshal(msg)
	assert.Nil(t, err)

	entry := w.(*ChatLogEntry)

	// Verify the raw_payload is preserved as JSON
	var parsed map[string]interface{}
	err = json.Unmarshal(entry.RawPayload, &parsed)
	assert.Nil(t, err)
	assert.Equal(t, "image", parsed["type"])
	assert.Equal(t, "https://example.com/img.png", parsed["url"])
	assert.Equal(t, "test", parsed["caption"])
}

func TestChatLogMarshalMetadataPreserved(t *testing.T) {
	msg := &kafka.Message{
		Value: []byte(`{
			"userid": "user1",
			"timestamp": 1598706047838,
			"direction": "incoming",
			"content": "test",
			"metadata": {"key1": "value1", "key2": 42}
		}`),
	}

	scribbler := &ChatLogScribbler{}
	w, err := scribbler.Marshal(msg)
	assert.Nil(t, err)

	entry := w.(*ChatLogEntry)

	var parsed map[string]interface{}
	err = json.Unmarshal(entry.Metadata, &parsed)
	assert.Nil(t, err)
	assert.Equal(t, "value1", parsed["key1"])
	assert.Equal(t, float64(42), parsed["key2"])
}

// --- GetRow tests ---

func TestChatLogGetRowReturnsCorrectOrder(t *testing.T) {
	pageid := "page456"
	qref := "q1"
	shortcode := "sc1"
	surveyid := "550e8400-e29b-41d4-a716-446655440789"
	msgType := "text"
	ts := &JSTimestamp{time.Date(2020, 8, 29, 10, 0, 0, 0, time.UTC)}

	entry := &ChatLogEntry{
		Userid:      "user123",
		Pageid:      &pageid,
		Timestamp:   ts,
		Direction:   "outgoing",
		Content:     "Hello",
		QuestionRef: &qref,
		Shortcode:   &shortcode,
		Surveyid:    &surveyid,
		MessageType: &msgType,
		RawPayload:  json.RawMessage(`{"foo":"bar"}`),
		Metadata:    json.RawMessage(`{"key":"value"}`),
	}

	row := entry.GetRow()
	assert.Equal(t, 11, len(row))

	assert.Equal(t, "user123", row[0])
	// pageid is part of the primary key (migration 27), so the row carries the
	// account as a plain value rather than a nullable pointer.
	assert.Equal(t, pageid, row[1])
	assert.Equal(t, ts.Time, row[2])
	assert.Equal(t, "outgoing", row[3])
	assert.Equal(t, "Hello", row[4])
	assert.Equal(t, &qref, row[5])
	assert.Equal(t, &shortcode, row[6])
	assert.Equal(t, &surveyid, row[7])
	assert.Equal(t, &msgType, row[8])
	assert.Equal(t, json.RawMessage(`{"foo":"bar"}`), row[9])
	assert.Equal(t, json.RawMessage(`{"key":"value"}`), row[10])
}

func TestChatLogGetRowWithNilOptionalFields(t *testing.T) {
	ts := &JSTimestamp{time.Date(2020, 8, 29, 10, 0, 0, 0, time.UTC)}

	entry := &ChatLogEntry{
		Userid:    "user123",
		Pageid:    nil,
		Timestamp: ts,
		Direction: "incoming",
		Content:   "Hello",
	}

	row := entry.GetRow()
	assert.Equal(t, 11, len(row))

	assert.Equal(t, "user123", row[0])
	// pageid cannot be NULL now that it is part of the primary key: an absent
	// account is written as the empty-string "account unknown" sentinel rather
	// than dropping the row. See scribble/chatlog.go accountOrUnknown.
	assert.Equal(t, "", row[1])
	assert.Equal(t, ts.Time, row[2])
	assert.Equal(t, "incoming", row[3])
	assert.Equal(t, "Hello", row[4])
	assert.Nil(t, row[5])  // question_ref
	assert.Nil(t, row[6])  // shortcode
	assert.Nil(t, row[7])  // surveyid
	assert.Nil(t, row[8])  // message_type
	assert.Nil(t, row[9])  // raw_payload
	assert.Nil(t, row[10]) // metadata
}

// --- SendBatch / integration tests ---

func TestChatLogWriterWritesGoodData(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := makeMessages([]string{
		`{"userid": "user1",
		  "pageid": "page1",
		  "timestamp": 1598706047838,
		  "direction": "incoming",
		  "content": "Hello bot",
		  "question_ref": "q1",
		  "shortcode": "sc1",
		  "surveyid": "550e8400-e29b-41d4-a716-446655440001",
		  "message_type": "text",
		  "raw_payload": {"type": "text"},
		  "metadata": {"source": "fb"}}`,
		`{"userid": "user2",
		  "pageid": "page1",
		  "timestamp": 1598706047838,
		  "direction": "outgoing",
		  "content": "Hi user",
		  "question_ref": "q2",
		  "shortcode": "sc1",
		  "surveyid": "550e8400-e29b-41d4-a716-446655440001",
		  "message_type": "text",
		  "raw_payload": {"type": "text"},
		  "metadata": {"source": "fb"}}`,
	})

	writer := GetWriter(NewChatLogScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "chat_log", "userid")
	assert.Equal(t, 2, len(res))
}

func TestChatLogWriterWritesNullableFieldsAsNull(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := makeMessages([]string{
		`{"userid": "user1",
		  "timestamp": 1598706047838,
		  "direction": "incoming",
		  "content": "Hello bot"}`,
	})

	writer := GetWriter(NewChatLogScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "chat_log", "userid")
	assert.Equal(t, 1, len(res))
	assert.Equal(t, "user1", *res[0])
}

func TestChatLogWriterIgnoresDuplicateMessages(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := makeMessages([]string{
		`{"userid": "user1",
		  "timestamp": 1598706047838,
		  "direction": "incoming",
		  "content": "Hello bot"}`,
		`{"userid": "user1",
		  "timestamp": 1598706047838,
		  "direction": "incoming",
		  "content": "Different content but same conflict key"}`,
	})

	writer := GetWriter(NewChatLogScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "chat_log", "content")
	assert.Equal(t, 1, len(res))
}

func TestChatLogWriterAllowsSameUserDifferentDirections(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := makeMessages([]string{
		`{"userid": "user1",
		  "timestamp": 1598706047838,
		  "direction": "incoming",
		  "content": "Hello bot"}`,
		`{"userid": "user1",
		  "timestamp": 1598706047838,
		  "direction": "outgoing",
		  "content": "Hi user"}`,
	})

	writer := GetWriter(NewChatLogScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "chat_log", "direction")
	assert.Equal(t, 2, len(res))
}

func TestChatLogWriterAllowsSameUserDifferentTimestamps(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := makeMessages([]string{
		`{"userid": "user1",
		  "timestamp": 1598706047838,
		  "direction": "incoming",
		  "content": "First message"}`,
		`{"userid": "user1",
		  "timestamp": 1598706057838,
		  "direction": "incoming",
		  "content": "Second message"}`,
	})

	writer := GetWriter(NewChatLogScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "chat_log", "content")
	assert.Equal(t, 2, len(res))
}

// A conversation is (platform, account_id, user_id). chat_log's conflict target
// omitted the account, and its timestamp is at second granularity, so two bot
// messages sent to the same participant in the same second on two of our
// messaging accounts collided -- and a collision here is not an error, it is a
// silent DO NOTHING. One researcher's message simply vanished. This is the most
// exposed of the three conflict keys, and this test fails against the old target.
func TestChatLogWriterKeepsBothAccountsInTheSameSecond(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := makeMessages([]string{
		`{"userid": "user1",
		  "pageid": "page1",
		  "timestamp": 1598706047838,
		  "direction": "outgoing",
		  "content": "Question from the study on page1"}`,
		`{"userid": "user1",
		  "pageid": "page2",
		  "timestamp": 1598706047838,
		  "direction": "outgoing",
		  "content": "Question from the study on page2"}`,
	})

	writer := GetWriter(NewChatLogScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.Nil(t, err)

	assert.Equal(t, []string{"page1", "page2"}, colValues(getCol(pool, "chat_log", "pageid")))
	assert.Equal(t,
		[]string{"Question from the study on page1", "Question from the study on page2"},
		colValues(getCol(pool, "chat_log", "content")))
}

// The account joins the key; it does not replace it. A genuine repeat within one
// conversation must still collapse.
func TestChatLogWriterStillIgnoresDuplicatesWithinOneAccount(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := makeMessages([]string{
		`{"userid": "user1",
		  "pageid": "page1",
		  "timestamp": 1598706047838,
		  "direction": "incoming",
		  "content": "Hello bot"}`,
		`{"userid": "user1",
		  "pageid": "page1",
		  "timestamp": 1598706047838,
		  "direction": "incoming",
		  "content": "Different content, same conversation key"}`,
	})

	writer := GetWriter(NewChatLogScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.Nil(t, err)

	assert.Equal(t, []string{"Hello bot"}, colValues(getCol(pool, "chat_log", "content")))
}

// Replybot published chat log entries with no account at all on ~0.9% of writes
// (14,834 rows in production). pageid is NOT NULL now that it is part of the
// primary key, so those entries must land under the empty-string "account unknown"
// sentinel rather than failing the batch. scribble treats a write error as fatal
// (scribble.go:36-39), so getting this wrong is a crash loop.
//
// The producer is currently deleted (675c31bd; no chat_log writes since
// 2026-07-27), so this contract is unexercised in production -- which is precisely
// why the test matters. It is the only thing holding the contract until the
// producer is restored.
func TestChatLogWriterWritesUnknownAccountSentinelWhenPageidAbsent(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := makeMessages([]string{
		`{"userid": "user1",
		  "timestamp": 1598706047838,
		  "direction": "incoming",
		  "content": "Hello bot"}`,
	})

	writer := GetWriter(NewChatLogScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.Nil(t, err)

	assert.Equal(t, []string{""}, colValues(getCol(pool, "chat_log", "pageid")))
}

func TestChatLogWriterFailsOnInvalidJSON(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := makeMessages([]string{
		`{not valid json}`,
	})

	writer := GetWriter(NewChatLogScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.NotNil(t, err)

	res := getCol(pool, "chat_log", "userid")
	assert.Equal(t, 0, len(res))
}
