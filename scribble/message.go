package main

import (
	"context"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/jackc/pgx/v4/pgxpool"
)

type Message struct {
	Userid    string    `validate:"required"`
	Timestamp time.Time `validate:"required"`
	Content   []byte    `validate:"required"`

	// The conversation this archived event belongs to, read from the event
	// envelope's normalized top-level fields.
	//
	// Deliberately NOT `validate:"required"`. Either component may be absent --
	// synthetic events historically carried no platform, and a producer that
	// stops stamping the fields must not be able to stop the archive. scribble
	// treats a write error as fatal (scribble.go, log.Fatalf), so making identity
	// mandatory here would turn a missing envelope field into a crash-looping
	// consumer that archives nothing. The archive is the evidence: it takes the
	// row and records honestly that the identity was unknown.
	//
	// A NULL account_id is observable -- see the drain query in
	// devops/migrations/26-messages-account.sql -- so absence is loud in the
	// place that can act on it, without being fatal in the place that cannot.
	AccountID *string
	Platform  *string
}

func (message *Message) GetRow() []interface{} {
	return []interface{}{
		message.Userid,
		message.Timestamp,
		string(message.Content),
		message.AccountID,
		message.Platform,
	}
}

type MessageScribbler struct {
	pool *pgxpool.Pool
}

func NewMessageScribbler(pool *pgxpool.Pool) Scribbler {
	return &MessageScribbler{pool}
}

func (s *MessageScribbler) SendBatch(data []Writeable) error {
	values := BatchValues(data)
	fields := []string{"userid", "timestamp", "content", "account_id", "platform"}
	query := SertQuery("INSERT", "messages", fields, len(data))

	// The conflict target stays (hsh, userid) -- the primary key -- and is NOT
	// widened to include account_id. This is a deliberate reversal of the plan's
	// §7.4, established with evidence and approved 2026-08-17. See the header of
	// devops/migrations/26-messages-account.sql for the full argument; in short:
	//
	//   hsh is a STORED computed column, fnv64a(content) (01-init.sql:22), and
	//   the account identifier is INSIDE content in every shape. So (hsh, userid)
	//   is already transitively account-scoped -- two events on two accounts
	//   cannot collide, because the bytes that distinguish the accounts are among
	//   the bytes being hashed.
	//
	// Widening it would have required ALTER PRIMARY KEY on a 384 GiB table, and
	// would have narrowed only the CROSS-ACCOUNT subset of fnv64a collisions
	// while leaving same-account collisions -- the overwhelmingly larger
	// population -- untouched.
	//
	// Because the target is unchanged, this file has no schema/code deploy
	// ordering hazard: old and new scribble both run against both schemas. That
	// is the opposite of chatlog.go and response.go, whose new targets raise
	// 42P10 against the old schema.
	query += ` ON CONFLICT(hsh, userid) DO NOTHING`
	_, err := s.pool.Exec(context.Background(), query, values...)
	return err
}

// Marshal builds the archival row. The Kafka key is the user id; the body is the
// event envelope, archived verbatim into `content` and additionally read for the
// conversation's identity.
//
// This is the only place scribble parses the messages body. It reads the
// normalized top-level `account_id` and `platform` and nothing else -- no
// per-shape extraction, no fallback (documentation/event-envelope.md). The
// historical per-shape rule lives in ConversationFromHistoricalContent and is
// used only by the backfill.
//
// A parse failure is not an error here: ConversationFromEnvelope is total and
// yields "not derivable". The body is still archived byte-for-byte, which is what
// makes a bad payload recoverable later instead of lost.
func (s *MessageScribbler) Marshal(msg *kafka.Message) (Writeable, error) {
	conv := ConversationFromEnvelope(msg.Value)
	return &Message{
		Userid:    string(msg.Key),
		Timestamp: msg.Timestamp,
		Content:   msg.Value,
		AccountID: conv.AccountID(),
		Platform:  conv.PlatformOrNil(),
	}, nil
}
