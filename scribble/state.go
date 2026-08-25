package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/jackc/pgx/v4/pgxpool"
)

type State struct {
	UserID       string          `json:"userid"  validate:"required"`
	PageID       string          `json:"pageid"  validate:"required"`
	Updated      JSTimestamp     `json:"updated"  validate:"required"`
	CurrentState string          `json:"current_state"  validate:"required"`
	StateJSON    json.RawMessage `json:"state_json"  validate:"required"`
}

func (state *State) GetRow() []interface{} {
	return []interface{}{
		state.UserID,
		state.PageID,
		state.Updated.Time,
		state.CurrentState,
		state.StateJSON,
	}
}

type StateScribbler struct {
	pool *pgxpool.Pool
}

func NewStateScribbler(pool *pgxpool.Pool) Scribbler {
	return &StateScribbler{pool}
}

// conversationKey identifies the conversation a row belongs to. A conversation
// is (platform, account_id, user_id) -- never a user id on its own. The same
// participant can hold a live conversation on every messaging account we run,
// and on WhatsApp they always do, because wa_id is their phone number and is
// identical across every business number they message.
//
// `states` already keys on the conversation: PRIMARY KEY (userid, pageid), with
// platform as a computed column (migration 21). This mirrors that key.
type conversationKey struct {
	UserID string
	PageID string
}

// DedupStates keeps the last state per conversation in a batch. It exists
// because UPSERT cannot affect the same row twice in one statement, so its key
// has to match the table's key exactly.
//
// Keyed on UserID alone this did not merely mis-scope: a batch carrying state
// for one participant on two accounts silently kept ONE and dropped the other
// before it ever reached the database.
func DedupStates(data []Writeable) []Writeable {
	dataMap := map[conversationKey]*State{}
	for _, d := range data {
		state, ok := d.(*State)
		if !ok {
			panic("Cannot decode state Writeable as State!")
		}
		dataMap[conversationKey{state.UserID, state.PageID}] = state
	}

	data = []Writeable{}
	for _, d := range dataMap {
		data = append(data, d)
	}

	return data
}

func (s *StateScribbler) SendBatch(data []Writeable) error {
	data = DedupStates(data)
	values := BatchValues(data)
	fields := []string{
		"userid",
		"pageid",
		"updated",
		"current_state",
		"state_json",
	}
	query := SertQuery("UPSERT", "states", fields, len(data))
	_, err := s.pool.Exec(context.Background(), query, values...)
	return err
}

func (s *StateScribbler) Marshal(msg *kafka.Message) (Writeable, error) {
	m := new(State)
	err := json.Unmarshal(msg.Value, m)
	if err != nil {
		return nil, err
	}

	return m, nil
}
