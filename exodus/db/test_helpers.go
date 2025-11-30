package db

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4/pgxpool"
)

// TestPool creates a connection pool to the test database on port 5433
// Follows Dean's pattern - logs fatal on connection errors
func TestPool() *pgxpool.Pool {
	config, err := pgxpool.ParseConfig("postgres://root@localhost:5433/chatroach")
	if err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, config)
	if err != nil {
		log.Fatal(err)
	}

	return pool
}

// MustExec executes a SQL statement and fails the test if it errors
// Follows Dean's test_helpers.go pattern
func MustExec(t testing.TB, pool *pgxpool.Pool, sql string, args ...interface{}) (commandTag pgconn.CommandTag) {
	var err error
	if commandTag, err = pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("Exec unexpectedly failed with %v: %v", sql, err)
	}
	return
}

// ResetDB clears data from specified tables
// Returns error rather than panicking to allow test recovery
func ResetDB(pool *pgxpool.Pool, tables []string) error {
	query := ""
	for _, table := range tables {
		query += fmt.Sprintf("DELETE FROM chatroach.%s; ", table)
	}

	_, err := pool.Exec(context.Background(), query)
	return err
}

// Before resets the exodus tables and sets up common test data
// This prepares the database for a clean test run
func Before(pool *pgxpool.Pool) {
	// Reset exodus tables and any dependent data
	err := ResetDB(pool, []string{"bail_events", "bails", "surveys", "users"})
	if err != nil {
		log.Fatal(err)
	}
}

// SetupTestSurvey creates a minimal test survey and returns its ID
// This provides a valid survey_id for testing bails
func SetupTestSurvey(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	// First create a test user
	userID := uuid.New()
	MustExec(t, pool, `
		INSERT INTO chatroach.users (id, email)
		VALUES ($1, $2)
	`, userID, "test-"+userID.String()+"@example.com")

	// Create a test survey with all required fields
	surveyID := uuid.New()
	MustExec(t, pool, `
		INSERT INTO chatroach.surveys (id, userid, created, formid, form, shortcode, title)
		VALUES ($1, $2, now(), $3, $4, $5, $6)
	`, surveyID, userID, "test-form-id", "{}", "test-survey-"+surveyID.String(), "Test Survey")

	return surveyID
}

// CreateTestBailDefinition returns a valid test bail definition as JSON
func CreateTestBailDefinition() json.RawMessage {
	def := map[string]interface{}{
		"conditions": map[string]interface{}{
			"type":  "form",
			"value": "test-form",
		},
		"execution": map[string]interface{}{
			"timing": "immediate",
		},
		"action": map[string]interface{}{
			"destination_form": "exit-form",
		},
	}

	data, err := json.Marshal(def)
	if err != nil {
		log.Fatal(err)
	}

	return json.RawMessage(data)
}
