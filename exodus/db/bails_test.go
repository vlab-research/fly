package db

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestCreateAndGetBail(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	surveyID := SetupTestSurvey(t, pool)
	db := &DB{pool: pool}

	// Create a test bail
	bail := &Bail{
		SurveyID:        surveyID,
		Name:            "test-bail",
		Description:     "Test bail for integration testing",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm: "exit-form",
	}

	// Test CreateBail
	err := db.CreateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	// Verify ID was generated
	if bail.ID == uuid.Nil {
		t.Error("Expected bail ID to be generated")
	}

	// Test GetBailByID
	retrieved, err := db.GetBailByID(context.Background(), bail.ID)
	if err != nil {
		t.Fatalf("GetBailByID failed: %v", err)
	}

	// Verify retrieved bail matches
	if retrieved.ID != bail.ID {
		t.Errorf("Expected ID %s, got %s", bail.ID, retrieved.ID)
	}
	if retrieved.Name != bail.Name {
		t.Errorf("Expected name %s, got %s", bail.Name, retrieved.Name)
	}
	if retrieved.SurveyID != bail.SurveyID {
		t.Errorf("Expected survey_id %s, got %s", bail.SurveyID, retrieved.SurveyID)
	}
	if retrieved.DestinationForm != bail.DestinationForm {
		t.Errorf("Expected destination_form %s, got %s", bail.DestinationForm, retrieved.DestinationForm)
	}
	if !retrieved.Enabled {
		t.Error("Expected enabled to be true")
	}
}

func TestGetEnabledBails(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	surveyID := SetupTestSurvey(t, pool)
	db := &DB{pool: pool}

	// Create multiple bails with different enabled states
	bail1 := &Bail{
		SurveyID:        surveyID,
		Name:            "enabled-bail-1",
		Description:     "Enabled bail 1",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm: "exit-form-1",
	}
	err := db.CreateBail(context.Background(), bail1)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	bail2 := &Bail{
		SurveyID:        surveyID,
		Name:            "disabled-bail",
		Description:     "Disabled bail",
		Enabled:         false,
		Definition:      CreateTestBailDefinition(),
		DestinationForm: "exit-form-2",
	}
	err = db.CreateBail(context.Background(), bail2)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	bail3 := &Bail{
		SurveyID:        surveyID,
		Name:            "enabled-bail-2",
		Description:     "Enabled bail 2",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm: "exit-form-3",
	}
	err = db.CreateBail(context.Background(), bail3)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	// Test GetEnabledBails
	enabled, err := db.GetEnabledBails(context.Background())
	if err != nil {
		t.Fatalf("GetEnabledBails failed: %v", err)
	}

	// Should only return the 2 enabled bails
	if len(enabled) != 2 {
		t.Errorf("Expected 2 enabled bails, got %d", len(enabled))
	}

	// Verify disabled bail is not included
	for _, b := range enabled {
		if b.Name == "disabled-bail" {
			t.Error("GetEnabledBails should not return disabled bails")
		}
		if !b.Enabled {
			t.Error("All returned bails should be enabled")
		}
	}
}

func TestUpdateBail(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	surveyID := SetupTestSurvey(t, pool)
	db := &DB{pool: pool}

	// Create a bail
	bail := &Bail{
		SurveyID:        surveyID,
		Name:            "update-test",
		Description:     "Original description",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm: "exit-form",
	}
	err := db.CreateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	originalUpdatedAt := bail.UpdatedAt

	// Update the bail
	bail.Name = "updated-name"
	bail.Description = "Updated description"
	bail.Enabled = false
	bail.DestinationForm = "new-exit-form"

	err = db.UpdateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("UpdateBail failed: %v", err)
	}

	// Verify updated_at changed
	if bail.UpdatedAt.Equal(originalUpdatedAt) {
		t.Error("Expected updated_at to change after update")
	}

	// Retrieve and verify changes
	retrieved, err := db.GetBailByID(context.Background(), bail.ID)
	if err != nil {
		t.Fatalf("GetBailByID failed: %v", err)
	}

	if retrieved.Name != "updated-name" {
		t.Errorf("Expected name 'updated-name', got %s", retrieved.Name)
	}
	if retrieved.Description != "Updated description" {
		t.Errorf("Expected description 'Updated description', got %s", retrieved.Description)
	}
	if retrieved.Enabled {
		t.Error("Expected enabled to be false")
	}
	if retrieved.DestinationForm != "new-exit-form" {
		t.Errorf("Expected destination_form 'new-exit-form', got %s", retrieved.DestinationForm)
	}
}

func TestDeleteBail(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	surveyID := SetupTestSurvey(t, pool)
	db := &DB{pool: pool}

	// Create a bail
	bail := &Bail{
		SurveyID:        surveyID,
		Name:            "delete-test",
		Description:     "Will be deleted",
		Enabled:         true,
		Definition:      CreateTestBailDefinition(),
		DestinationForm: "exit-form",
	}
	err := db.CreateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	// Delete the bail
	err = db.DeleteBail(context.Background(), bail.ID)
	if err != nil {
		t.Fatalf("DeleteBail failed: %v", err)
	}

	// Verify it's gone
	_, err = db.GetBailByID(context.Background(), bail.ID)
	if err == nil {
		t.Error("Expected GetBailByID to return error for deleted bail")
	}

	// Test deleting non-existent bail
	err = db.DeleteBail(context.Background(), uuid.New())
	if err == nil {
		t.Error("Expected DeleteBail to return error for non-existent bail")
	}
}

func TestGetBailsBySurvey(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	surveyID1 := SetupTestSurvey(t, pool)
	surveyID2 := SetupTestSurvey(t, pool)
	db := &DB{pool: pool}

	// Create bails for survey 1
	for i := 0; i < 3; i++ {
		bail := &Bail{
			SurveyID:        surveyID1,
			Name:            "survey1-bail-" + string(rune('a'+i)),
			Description:     "Bail for survey 1",
			Enabled:         true,
			Definition:      CreateTestBailDefinition(),
			DestinationForm: "exit-form",
		}
		err := db.CreateBail(context.Background(), bail)
		if err != nil {
			t.Fatalf("CreateBail failed: %v", err)
		}
	}

	// Create bails for survey 2
	for i := 0; i < 2; i++ {
		bail := &Bail{
			SurveyID:        surveyID2,
			Name:            "survey2-bail-" + string(rune('a'+i)),
			Description:     "Bail for survey 2",
			Enabled:         true,
			Definition:      CreateTestBailDefinition(),
			DestinationForm: "exit-form",
		}
		err := db.CreateBail(context.Background(), bail)
		if err != nil {
			t.Fatalf("CreateBail failed: %v", err)
		}
	}

	// Test GetBailsBySurvey for survey 1
	bails1, err := db.GetBailsBySurvey(context.Background(), surveyID1)
	if err != nil {
		t.Fatalf("GetBailsBySurvey failed: %v", err)
	}
	if len(bails1) != 3 {
		t.Errorf("Expected 3 bails for survey 1, got %d", len(bails1))
	}

	// Verify all returned bails belong to survey 1
	for _, b := range bails1 {
		if b.SurveyID != surveyID1 {
			t.Errorf("Expected bail to belong to survey %s, got %s", surveyID1, b.SurveyID)
		}
	}

	// Test GetBailsBySurvey for survey 2
	bails2, err := db.GetBailsBySurvey(context.Background(), surveyID2)
	if err != nil {
		t.Fatalf("GetBailsBySurvey failed: %v", err)
	}
	if len(bails2) != 2 {
		t.Errorf("Expected 2 bails for survey 2, got %d", len(bails2))
	}
}
