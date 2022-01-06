package main

import (
	"testing"
	"net/http"
	"time"

	"github.com/confluentinc/confluent-kafka-go/kafka"
	"github.com/stretchr/testify/assert"
)

func before() {
	http.Get("http://system/resetdb")
}

func TestMessageWriterWritesGoodData(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	msgs := []*kafka.Message{
		&kafka.Message{Value: []byte(`{ "foo": "bar "}`), Key: []byte("foo"), Timestamp: time.Now()},
		&kafka.Message{Value: []byte(`{ "bar": "baz "}`), Key: []byte("foo"), Timestamp: time.Now()},
	}

	writer := GetWriter(NewMessageScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "messages", "content")
	assert.Equal(t, len(res), 2)
}

func TestMessageWriterDoesNotThrowOnDuplicateMessage(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	msgs := []*kafka.Message{
		&kafka.Message{Value: []byte(`{ "foo": "bar "}`), Key: []byte("foo"), Timestamp: time.Now()},
		&kafka.Message{Value: []byte(`{ "foo": "bar "}`), Key: []byte("foo"), Timestamp: time.Now()},
	}

	writer := GetWriter(NewMessageScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "messages", "content")
	assert.Equal(t, len(res), 1)
}
