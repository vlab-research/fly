package main

import (
	"testing"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/stretchr/testify/assert"
)

func TestMessageWriterWritesGoodData(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := []*kafka.Message{
		{Value: []byte(`{ "foo": "bar "}`), Key: []byte("foo"), Timestamp: time.Now()},
		{Value: []byte(`{ "bar": "baz "}`), Key: []byte("foo"), Timestamp: time.Now()},
	}

	writer := GetWriter(NewMessageScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "messages", "content")
	assert.Equal(t, len(res), 2)
}

func TestMessageWriterDoesNotThrowOnDuplicateMessage(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	ts := time.Now()

	msgs := []*kafka.Message{
		{Value: []byte(`{ "foo": "bar "}`), Key: []byte("foo"), Timestamp: ts},
		{Value: []byte(`{ "foo": "bar "}`), Key: []byte("foo"), Timestamp: ts},
	}

	writer := GetWriter(NewMessageScribbler(pool), &Config{})
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "messages", "content")
	assert.Equal(t, len(res), 1)
}

// TestMessageWriterStampsAccountAndPlatform is the §7.4 forward path: archived
// rows must carry the conversation the event belonged to, read from the
// envelope's normalized top-level fields.
func TestMessageWriterStampsAccountAndPlatform(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := []*kafka.Message{
		{
			Value: []byte(`{"sender":{"id":"u1"},"recipient":{"id":"ACCT_A"},"source":"messenger",` +
				`"account_id":"ACCT_A","platform":"messenger","message":{"text":"hi"}}`),
			Key:       []byte("u1"),
			Timestamp: time.Now(),
		},
		{
			Value: []byte(`{"from":"u1","phone_number_id":"ACCT_B","source":"whatsapp",` +
				`"account_id":"ACCT_B","platform":"whatsapp","type":"text"}`),
			Key:       []byte("u1"),
			Timestamp: time.Now(),
		},
	}

	writer := GetWriter(NewMessageScribbler(pool), &Config{})
	assert.Nil(t, writer.Write(msgs))

	assert.Equal(t, []string{"ACCT_A", "ACCT_B"}, colValues(getCol(pool, "messages", "account_id")))
	assert.Equal(t, []string{"messenger", "whatsapp"}, colValues(getCol(pool, "messages", "platform")))
}

// TestMessageWriterKeepsBothConversationsOfOneParticipant is the regression test
// for the bug §7.4 exists to fix, stated as the property that actually matters:
// one participant's events on TWO accounts must both survive archival and be
// distinguishable afterwards.
//
// It also demonstrates why the primary key did not need widening. Both rows share
// a userid and differ only in the account -- which is INSIDE content, so
// fnv64a(content) already differs and ON CONFLICT (hsh, userid) never fires.
func TestMessageWriterKeepsBothConversationsOfOneParticipant(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	ts := time.Now()
	msgs := []*kafka.Message{
		{
			Value:     []byte(`{"sender":{"id":"u1"},"recipient":{"id":"ACCT_A"},"source":"messenger","account_id":"ACCT_A","platform":"messenger","message":{"text":"same text"}}`),
			Key:       []byte("u1"),
			Timestamp: ts,
		},
		{
			Value:     []byte(`{"sender":{"id":"u1"},"recipient":{"id":"ACCT_B"},"source":"messenger","account_id":"ACCT_B","platform":"messenger","message":{"text":"same text"}}`),
			Key:       []byte("u1"),
			Timestamp: ts,
		},
	}

	writer := GetWriter(NewMessageScribbler(pool), &Config{})
	assert.Nil(t, writer.Write(msgs))

	assert.Equal(t, []string{"ACCT_A", "ACCT_B"}, colValues(getCol(pool, "messages", "account_id")),
		"both conversations must survive: identical message text, different account, "+
			"so the account bytes inside content make fnv64a(content) differ")
}

// TestMessageWriterArchivesEvenWithoutIdentity pins the choice not to validate
// the new columns. scribble treats a write error as fatal, so a required
// account_id would let a producer that stopped stamping the envelope crash-loop
// the archival consumer. The row is the evidence; it is stored either way, with
// the unknown identity recorded honestly as NULL.
func TestMessageWriterArchivesEvenWithoutIdentity(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := []*kafka.Message{
		{Value: []byte(`{"sender":{"id":"u1"},"recipient":{"id":"ACCT_A"},"source":"messenger"}`), Key: []byte("u1"), Timestamp: time.Now()},
		{Value: []byte(`not json at all`), Key: []byte("u2"), Timestamp: time.Now()},
	}

	writer := GetWriter(NewMessageScribbler(pool), &Config{})
	assert.Nil(t, writer.Write(msgs), "a missing or unreadable identity must not fail the batch")

	assert.Equal(t, 2, len(getCol(pool, "messages", "content")))
	assert.Equal(t, []string{"<nil>", "<nil>"}, colValues(getCol(pool, "messages", "account_id")),
		"no per-shape fallback on the forward path: recipient.id is present but must be ignored")
}
