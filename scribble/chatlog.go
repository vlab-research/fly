package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/jackc/pgx/v4/pgxpool"
)

type ChatLogEntry struct {
	Userid      string          `json:"userid" validate:"required"`
	Pageid      *string         `json:"pageid"`
	Timestamp   *JSTimestamp    `json:"timestamp" validate:"required"`
	Direction   string          `json:"direction" validate:"required"`
	Content     string          `json:"content" validate:"required"`
	QuestionRef *string         `json:"question_ref"`
	Shortcode   *string         `json:"shortcode"`
	Surveyid    *string         `json:"surveyid"`
	MessageType *string         `json:"message_type"`
	RawPayload  json.RawMessage `json:"raw_payload"`
	Metadata    json.RawMessage `json:"metadata"`
}

func (e *ChatLogEntry) GetRow() []interface{} {
	return []interface{}{
		e.Userid,
		e.Pageid,
		e.Timestamp.Time,
		e.Direction,
		e.Content,
		e.QuestionRef,
		e.Shortcode,
		e.Surveyid,
		e.MessageType,
		e.RawPayload,
		e.Metadata,
	}
}

type ChatLogScribbler struct {
	pool *pgxpool.Pool
}

func NewChatLogScribbler(pool *pgxpool.Pool) Scribbler {
	return &ChatLogScribbler{pool}
}

func (s *ChatLogScribbler) SendBatch(data []Writeable) error {
	values := BatchValues(data)
	fields := []string{
		"userid",
		"pageid",
		"timestamp",
		"direction",
		"content",
		"question_ref",
		"shortcode",
		"surveyid",
		"message_type",
		"raw_payload",
		"metadata",
	}
	query := SertQuery("INSERT", "chat_log", fields, len(data))
	query += " ON CONFLICT(userid, timestamp, direction) DO NOTHING"
	_, err := s.pool.Exec(context.Background(), query, values...)
	return err
}

func (s *ChatLogScribbler) Marshal(msg *kafka.Message) (Writeable, error) {
	m := new(ChatLogEntry)
	err := json.Unmarshal(msg.Value, m)
	if err != nil {
		return nil, err
	}

	return m, nil
}
