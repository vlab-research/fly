package db

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v4"
)

// BailEvent represents an event logged when a bail is executed or errors
type BailEvent struct {
	ID                 uuid.UUID        `json:"id"`
	BailID             *uuid.UUID       `json:"bail_id,omitempty"`
	SurveyID           uuid.UUID        `json:"survey_id"`
	BailName           string           `json:"bail_name"`
	EventType          string           `json:"event_type"` // "execution" or "error"
	Timestamp          time.Time        `json:"timestamp"`
	UsersMatched       int              `json:"users_matched"`
	UsersBailed        int              `json:"users_bailed"`
	DefinitionSnapshot json.RawMessage  `json:"definition_snapshot"`
	Error              *json.RawMessage `json:"error,omitempty"`
}

// RecordEvent inserts a new bail event into the database
// The event.ID and event.Timestamp will be populated with generated values
func (d *DB) RecordEvent(ctx context.Context, event *BailEvent) error {
	query := `
		INSERT INTO chatroach.bail_events
		  (bail_id, survey_id, bail_name, event_type, users_matched, users_bailed,
		   definition_snapshot, error)
		VALUES
		  ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, timestamp
	`

	err := d.pool.QueryRow(
		ctx,
		query,
		event.BailID,
		event.SurveyID,
		event.BailName,
		event.EventType,
		event.UsersMatched,
		event.UsersBailed,
		event.DefinitionSnapshot,
		event.Error,
	).Scan(&event.ID, &event.Timestamp)

	if err != nil {
		return fmt.Errorf("failed to record event: %w", err)
	}

	return nil
}

// GetEventsByBailID retrieves all events for a specific bail, ordered by timestamp descending
func (d *DB) GetEventsByBailID(ctx context.Context, bailID uuid.UUID) ([]*BailEvent, error) {
	query := `
		SELECT id, bail_id, survey_id, bail_name, event_type, timestamp,
		       users_matched, users_bailed, definition_snapshot, error
		FROM chatroach.bail_events
		WHERE bail_id = $1
		ORDER BY timestamp DESC
	`

	rows, err := d.pool.Query(ctx, query, bailID)
	if err != nil {
		return nil, fmt.Errorf("failed to query events for bail: %w", err)
	}
	defer rows.Close()

	return scanEvents(rows)
}

// GetEventsBySurvey retrieves recent events for a specific survey with an optional limit
// Events are ordered by timestamp descending (most recent first)
func (d *DB) GetEventsBySurvey(ctx context.Context, surveyID uuid.UUID, limit int) ([]*BailEvent, error) {
	query := `
		SELECT id, bail_id, survey_id, bail_name, event_type, timestamp,
		       users_matched, users_bailed, definition_snapshot, error
		FROM chatroach.bail_events
		WHERE survey_id = $1
		ORDER BY timestamp DESC
		LIMIT $2
	`

	rows, err := d.pool.Query(ctx, query, surveyID, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query events for survey: %w", err)
	}
	defer rows.Close()

	return scanEvents(rows)
}

// GetLastSuccessfulExecution returns the timestamp of the last successful execution event
// for a given bail. Returns nil if no successful execution has occurred yet.
func (d *DB) GetLastSuccessfulExecution(ctx context.Context, bailID uuid.UUID) (*time.Time, error) {
	query := `
		SELECT timestamp
		FROM chatroach.bail_events
		WHERE bail_id = $1 AND event_type = 'execution'
		ORDER BY timestamp DESC
		LIMIT 1
	`

	var timestamp time.Time
	err := d.pool.QueryRow(ctx, query, bailID).Scan(&timestamp)

	if err == pgx.ErrNoRows {
		return nil, nil // No successful execution yet
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get last successful execution: %w", err)
	}

	return &timestamp, nil
}

// scanEvent scans a single event from a database row
func scanEvent(row pgx.Row) (*BailEvent, error) {
	event := &BailEvent{}
	err := row.Scan(
		&event.ID,
		&event.BailID,
		&event.SurveyID,
		&event.BailName,
		&event.EventType,
		&event.Timestamp,
		&event.UsersMatched,
		&event.UsersBailed,
		&event.DefinitionSnapshot,
		&event.Error,
	)
	if err != nil {
		return nil, err
	}
	return event, nil
}

// scanEvents scans multiple events from database rows
func scanEvents(rows pgx.Rows) ([]*BailEvent, error) {
	var events []*BailEvent

	for rows.Next() {
		event := &BailEvent{}
		err := rows.Scan(
			&event.ID,
			&event.BailID,
			&event.SurveyID,
			&event.BailName,
			&event.EventType,
			&event.Timestamp,
			&event.UsersMatched,
			&event.UsersBailed,
			&event.DefinitionSnapshot,
			&event.Error,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan event: %w", err)
		}
		events = append(events, event)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating events: %w", err)
	}

	return events, nil
}
