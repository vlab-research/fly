package main

import (
	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/stretchr/testify/assert"
	"testing"
	"time"
)

func TestMessageWriterWritesGoodData(t *testing.T) {
	pool := testPool()
	defer pool.Close()
	before(pool)

	msgs := []*kafka.Message{
		{Value: []byte(`{ "foo": "bar "}`), Key: []byte("foo"), Timestamp: time.Now()},
		{Value: []byte(`{ "bar": "baz "}`), Key: []byte("foo"), Timestamp: time.Now()},
	}

	writer := GetWriter(NewMessageScribbler(pool))
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

	writer := GetWriter(NewMessageScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "messages", "content")
	assert.Equal(t, len(res), 1)
}
