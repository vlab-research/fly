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

// accountOrUnknown renders the messaging account for the conversation key.
//
// pageid is part of chat_log's primary key as of migration 27, so it cannot be
// NULL -- an identity component has no null. Replybot published entries carrying
// no account on roughly 0.9% of writes (14,834 such rows in production), so
// instead of dropping them they are keyed under the empty-string "account
// unknown" sentinel -- the same value the migration backfilled the historical
// NULLs to.
//
// This path is quiescent but not dead: chat_log's producer
// (replybot/lib/chat-log/publisher.js) was deleted in 675c31bd and nothing has
// written the table since 2026-07-27. It will be restored, and the 0.9%
// account-less rate returns with it unless the producer is fixed at the same
// time. Coercing here is what stops a missing account becoming a fatal batch
// error, since scribble treats any write error as fatal.
func accountOrUnknown(pageid *string) string {
	if pageid == nil {
		return ""
	}
	return *pageid
}

func (e *ChatLogEntry) GetRow() []interface{} {
	return []interface{}{
		e.Userid,
		accountOrUnknown(e.Pageid),
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
	// The conflict target is the conversation, not the participant. Without
	// pageid, one participant's bot messages on two accounts in the same second
	// collided and the second was silently discarded. Requires migration 27,
	// which folds pageid into the primary key -- without it this raises 42P10.
	query += " ON CONFLICT(userid, pageid, timestamp, direction) DO NOTHING"
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
