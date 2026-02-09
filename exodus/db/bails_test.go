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

	userID := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	bail := &Bail{
		UserID:           userID,
		Name:             "test-bail",
		Description:      "Test bail for integration testing",
		Enabled:          true,
		Definition:       CreateTestBailDefinition(),
		DestinationForm:  "exit-form",
	}

	err := db.CreateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	if bail.ID == uuid.Nil {
		t.Error("Expected bail ID to be generated")
	}

	retrieved, err := db.GetBailByID(context.Background(), bail.ID)
	if err != nil {
		t.Fatalf("GetBailByID failed: %v", err)
	}

	if retrieved.ID != bail.ID {
		t.Errorf("Expected ID %s, got %s", bail.ID, retrieved.ID)
	}
	if retrieved.Name != bail.Name {
		t.Errorf("Expected name %s, got %s", bail.Name, retrieved.Name)
	}
	if retrieved.UserID != bail.UserID {
		t.Errorf("Expected user_id %s, got %s", bail.UserID, retrieved.UserID)
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

	userID := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	bail1 := &Bail{
		UserID:           userID,
		Name:             "enabled-bail-1",
		Description:      "Enabled bail 1",
		Enabled:          true,
		Definition:       CreateTestBailDefinition(),
		DestinationForm:  "exit-form-1",
	}
	err := db.CreateBail(context.Background(), bail1)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	bail2 := &Bail{
		UserID:           userID,
		Name:             "disabled-bail",
		Description:      "Disabled bail",
		Enabled:          false,
		Definition:       CreateTestBailDefinition(),
		DestinationForm:  "exit-form-2",
	}
	err = db.CreateBail(context.Background(), bail2)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	bail3 := &Bail{
		UserID:           userID,
		Name:             "enabled-bail-2",
		Description:      "Enabled bail 2",
		Enabled:          true,
		Definition:       CreateTestBailDefinition(),
		DestinationForm:  "exit-form-3",
	}
	err = db.CreateBail(context.Background(), bail3)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	enabled, err := db.GetEnabledBails(context.Background())
	if err != nil {
		t.Fatalf("GetEnabledBails failed: %v", err)
	}

	if len(enabled) != 2 {
		t.Errorf("Expected 2 enabled bails, got %d", len(enabled))
	}

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

	userID := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	bail := &Bail{
		UserID:           userID,
		Name:             "update-test",
		Description:      "Original description",
		Enabled:          true,
		Definition:       CreateTestBailDefinition(),
		DestinationForm:  "exit-form",
	}
	err := db.CreateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	originalUpdatedAt := bail.UpdatedAt

	bail.Name = "updated-name"
	bail.Description = "Updated description"
	bail.Enabled = false
	bail.DestinationForm = "new-exit-form"
	err = db.UpdateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("UpdateBail failed: %v", err)
	}

	if bail.UpdatedAt.Equal(originalUpdatedAt) {
		t.Error("Expected updated_at to change after update")
	}

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

	userID := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	bail := &Bail{
		UserID:           userID,
		Name:             "delete-test",
		Description:      "Will be deleted",
		Enabled:          true,
		Definition:       CreateTestBailDefinition(),
		DestinationForm:  "exit-form",
	}
	err := db.CreateBail(context.Background(), bail)
	if err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	err = db.DeleteBail(context.Background(), bail.ID)
	if err != nil {
		t.Fatalf("DeleteBail failed: %v", err)
	}

	_, err = db.GetBailByID(context.Background(), bail.ID)
	if err == nil {
		t.Error("Expected GetBailByID to return error for deleted bail")
	}

	err = db.DeleteBail(context.Background(), uuid.New())
	if err == nil {
		t.Error("Expected DeleteBail to return error for non-existent bail")
	}
}

func TestGetBailsByUser(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	userID1 := SetupTestUser(t, pool)
	userID2 := SetupTestUser(t, pool)
	db := &DB{pool: pool}

	for i := 0; i < 3; i++ {
		bail := &Bail{
			UserID:           userID1,
			Name:             "user1-bail-" + string(rune('a'+i)),
			Description:      "Bail for user 1",
			Enabled:          true,
			Definition:       CreateTestBailDefinition(),
			DestinationForm:  "exit-form",
			}
		err := db.CreateBail(context.Background(), bail)
		if err != nil {
			t.Fatalf("CreateBail failed: %v", err)
		}
	}

	for i := 0; i < 2; i++ {
		bail := &Bail{
			UserID:           userID2,
			Name:             "user2-bail-" + string(rune('a'+i)),
			Description:      "Bail for user 2",
			Enabled:          true,
			Definition:       CreateTestBailDefinition(),
			DestinationForm:  "exit-form",
			}
		err := db.CreateBail(context.Background(), bail)
		if err != nil {
			t.Fatalf("CreateBail failed: %v", err)
		}
	}

	bails1, err := db.GetBailsByUser(context.Background(), userID1)
	if err != nil {
		t.Fatalf("GetBailsByUser failed: %v", err)
	}
	if len(bails1) != 3 {
		t.Errorf("Expected 3 bails for user 1, got %d", len(bails1))
	}

	for _, b := range bails1 {
		if b.UserID != userID1 {
			t.Errorf("Expected bail to belong to user %s, got %s", userID1, b.UserID)
		}
	}

	bails2, err := db.GetBailsByUser(context.Background(), userID2)
	if err != nil {
		t.Fatalf("GetBailsByUser failed: %v", err)
	}
	if len(bails2) != 2 {
		t.Errorf("Expected 2 bails for user 2, got %d", len(bails2))
	}
}
