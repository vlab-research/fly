package db

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v4"
)

// Bail represents a bail configuration stored in the database
type Bail struct {
	ID              uuid.UUID      `json:"id"`
	SurveyID        uuid.UUID      `json:"survey_id"`
	Name            string         `json:"name"`
	Description     string         `json:"description"`
	Enabled         bool           `json:"enabled"`
	Definition      json.RawMessage `json:"definition"`
	DestinationForm string         `json:"destination_form"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

// GetEnabledBails retrieves all enabled bails from the database
func (d *DB) GetEnabledBails(ctx context.Context) ([]*Bail, error) {
	query := `
		SELECT id, survey_id, name, description, enabled, definition,
		       destination_form, created_at, updated_at
		FROM chatroach.bails
		WHERE enabled = true
		ORDER BY survey_id, name
	`

	rows, err := d.pool.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query enabled bails: %w", err)
	}
	defer rows.Close()

	return scanBails(rows)
}

// GetBailByID retrieves a specific bail by its ID
func (d *DB) GetBailByID(ctx context.Context, id uuid.UUID) (*Bail, error) {
	query := `
		SELECT id, survey_id, name, description, enabled, definition,
		       destination_form, created_at, updated_at
		FROM chatroach.bails
		WHERE id = $1
	`

	row := d.pool.QueryRow(ctx, query, id)

	bail, err := scanBail(row)
	if err == pgx.ErrNoRows {
		return nil, fmt.Errorf("bail not found: %s", id)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get bail: %w", err)
	}

	return bail, nil
}

// GetBailsBySurvey retrieves all bails for a specific survey
func (d *DB) GetBailsBySurvey(ctx context.Context, surveyID uuid.UUID) ([]*Bail, error) {
	query := `
		SELECT id, survey_id, name, description, enabled, definition,
		       destination_form, created_at, updated_at
		FROM chatroach.bails
		WHERE survey_id = $1
		ORDER BY name
	`

	rows, err := d.pool.Query(ctx, query, surveyID)
	if err != nil {
		return nil, fmt.Errorf("failed to query bails for survey: %w", err)
	}
	defer rows.Close()

	return scanBails(rows)
}

// CreateBail inserts a new bail into the database
// The bail.ID will be populated with the generated UUID
func (d *DB) CreateBail(ctx context.Context, bail *Bail) error {
	query := `
		INSERT INTO chatroach.bails
		  (survey_id, name, description, enabled, definition, destination_form)
		VALUES
		  ($1, $2, $3, $4, $5, $6)
		RETURNING id, created_at, updated_at
	`

	err := d.pool.QueryRow(
		ctx,
		query,
		bail.SurveyID,
		bail.Name,
		bail.Description,
		bail.Enabled,
		bail.Definition,
		bail.DestinationForm,
	).Scan(&bail.ID, &bail.CreatedAt, &bail.UpdatedAt)

	if err != nil {
		return fmt.Errorf("failed to create bail: %w", err)
	}

	return nil
}

// UpdateBail updates an existing bail in the database
// Updates all mutable fields and refreshes the updated_at timestamp
func (d *DB) UpdateBail(ctx context.Context, bail *Bail) error {
	query := `
		UPDATE chatroach.bails
		SET
		  name = $2,
		  description = $3,
		  enabled = $4,
		  definition = $5,
		  destination_form = $6,
		  updated_at = now()
		WHERE id = $1
		RETURNING updated_at
	`

	err := d.pool.QueryRow(
		ctx,
		query,
		bail.ID,
		bail.Name,
		bail.Description,
		bail.Enabled,
		bail.Definition,
		bail.DestinationForm,
	).Scan(&bail.UpdatedAt)

	if err == pgx.ErrNoRows {
		return fmt.Errorf("bail not found: %s", bail.ID)
	}
	if err != nil {
		return fmt.Errorf("failed to update bail: %w", err)
	}

	return nil
}

// DeleteBail removes a bail from the database
func (d *DB) DeleteBail(ctx context.Context, id uuid.UUID) error {
	query := `DELETE FROM chatroach.bails WHERE id = $1`

	result, err := d.pool.Exec(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete bail: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("bail not found: %s", id)
	}

	return nil
}

// scanBail scans a single bail from a database row
func scanBail(row pgx.Row) (*Bail, error) {
	bail := &Bail{}
	err := row.Scan(
		&bail.ID,
		&bail.SurveyID,
		&bail.Name,
		&bail.Description,
		&bail.Enabled,
		&bail.Definition,
		&bail.DestinationForm,
		&bail.CreatedAt,
		&bail.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return bail, nil
}

// scanBails scans multiple bails from database rows
func scanBails(rows pgx.Rows) ([]*Bail, error) {
	var bails []*Bail

	for rows.Next() {
		bail := &Bail{}
		err := rows.Scan(
			&bail.ID,
			&bail.SurveyID,
			&bail.Name,
			&bail.Description,
			&bail.Enabled,
			&bail.Definition,
			&bail.DestinationForm,
			&bail.CreatedAt,
			&bail.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan bail: %w", err)
		}
		bails = append(bails, bail)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating bails: %w", err)
	}

	return bails, nil
}
