package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v4"
	"github.com/labstack/echo/v4"
	"github.com/vlab-research/exodus/db"
	"github.com/vlab-research/exodus/types"
)

// mockDB implements the database interface for testing
type mockDB struct {
	bails      []*db.Bail
	events     []*db.BailEvent
	queryFunc  func(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error)
	createFunc func(ctx context.Context, bail *db.Bail) error
	updateFunc func(ctx context.Context, bail *db.Bail) error
	deleteFunc func(ctx context.Context, id uuid.UUID) error
}

func (m *mockDB) GetBailsByUser(ctx context.Context, userID uuid.UUID) ([]*db.Bail, error) {
	var result []*db.Bail
	for _, bail := range m.bails {
		if bail.UserID == userID {
			result = append(result, bail)
		}
	}
	return result, nil
}

func (m *mockDB) GetBailByID(ctx context.Context, id uuid.UUID) (*db.Bail, error) {
	for _, bail := range m.bails {
		if bail.ID == id {
			return bail, nil
		}
	}
	return nil, pgx.ErrNoRows
}

func (m *mockDB) CreateBail(ctx context.Context, bail *db.Bail) error {
	if m.createFunc != nil {
		return m.createFunc(ctx, bail)
	}
	bail.ID = uuid.New()
	bail.CreatedAt = time.Now()
	bail.UpdatedAt = time.Now()
	m.bails = append(m.bails, bail)
	return nil
}

func (m *mockDB) UpdateBail(ctx context.Context, bail *db.Bail) error {
	if m.updateFunc != nil {
		return m.updateFunc(ctx, bail)
	}
	for i, b := range m.bails {
		if b.ID == bail.ID {
			bail.UpdatedAt = time.Now()
			m.bails[i] = bail
			return nil
		}
	}
	return pgx.ErrNoRows
}

func (m *mockDB) DeleteBail(ctx context.Context, id uuid.UUID) error {
	if m.deleteFunc != nil {
		return m.deleteFunc(ctx, id)
	}
	for i, bail := range m.bails {
		if bail.ID == id {
			m.bails = append(m.bails[:i], m.bails[i+1:]...)
			return nil
		}
	}
	return pgx.ErrNoRows
}

func (m *mockDB) GetEventsByBailID(ctx context.Context, bailID uuid.UUID) ([]*db.BailEvent, error) {
	var result []*db.BailEvent
	for _, event := range m.events {
		if event.BailID != nil && *event.BailID == bailID {
			result = append(result, event)
		}
	}
	return result, nil
}

func (m *mockDB) GetEventsByUser(ctx context.Context, userID uuid.UUID, limit int) ([]*db.BailEvent, error) {
	var result []*db.BailEvent
	count := 0
	for _, event := range m.events {
		if event.UserID == userID {
			result = append(result, event)
			count++
			if count >= limit {
				break
			}
		}
	}
	return result, nil
}

func (m *mockDB) Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error) {
	if m.queryFunc != nil {
		return m.queryFunc(ctx, sql, args...)
	}
	return []map[string]interface{}{}, nil
}

func (m *mockDB) Close() {
	// no-op for mock
}

// Helper to create a test bail definition
func testBailDefinition() types.BailDefinition {
	return types.BailDefinition{
		Conditions: types.Condition{},
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
			Metadata:        map[string]interface{}{"reason": "test"},
		},
	}
}

// Helper to create a valid simple condition
func simpleFormCondition(formName string) types.Condition {
	cond := types.Condition{}
	cond.UnmarshalJSON([]byte(`{"type":"form","value":"` + formName + `"}`))
	return cond
}

func TestHealth(t *testing.T) {
	mock := &mockDB{}
	server := New(mock)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	c := server.echo.NewContext(req, rec)

	if err := server.Health(c); err != nil {
		t.Fatalf("Health check failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	var response map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if response["status"] != "ok" {
		t.Errorf("Expected status 'ok', got '%s'", response["status"])
	}
}

func TestListBails(t *testing.T) {
	userID := uuid.New()
	bailID := uuid.New()

	def := testBailDefinition()
	def.Conditions = simpleFormCondition("test-form")
	defJSON, _ := json.Marshal(def)

	mock := &mockDB{
		bails: []*db.Bail{
			{
				ID:               bailID,
				UserID:           userID,
				Name:             "Test Bail",
				Description:      "Test description",
				Enabled:          true,
				Definition:       defJSON,
				DestinationForm:  "exit-form",
				CreatedAt:        time.Now(),
				UpdatedAt:        time.Now(),
			},
		},
		events: []*db.BailEvent{
			{
				ID:                 uuid.New(),
				BailID:             &bailID,
				UserID:             userID,
				BailName:           "Test Bail",
				EventType:          "execution",
				Timestamp:          time.Now(),
				UsersMatched:       10,
				UsersBailed:        10,
				DefinitionSnapshot: defJSON,
			},
		},
	}

	server := New(mock)

	req := httptest.NewRequest(http.MethodGet, "/users/"+userID.String()+"/bails", nil)
	rec := httptest.NewRecorder()
	c := server.echo.NewContext(req, rec)
	c.SetPath("/users/:userId/bails")
	c.SetParamNames("userId")
	c.SetParamValues(userID.String())

	if err := server.ListBails(c); err != nil {
		t.Fatalf("ListBails failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	var response BailsListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if len(response.Bails) != 1 {
		t.Errorf("Expected 1 bail, got %d", len(response.Bails))
	}

	if response.Bails[0].Bail.Name != "Test Bail" {
		t.Errorf("Expected bail name 'Test Bail', got '%s'", response.Bails[0].Bail.Name)
	}

	if response.Bails[0].LastEvent == nil {
		t.Error("Expected last event to be present")
	}
}

func TestCreateBail_Success(t *testing.T) {
	userID := uuid.New()
	mock := &mockDB{
		bails: []*db.Bail{},
	}

	server := New(mock)

	def := testBailDefinition()
	def.Conditions = simpleFormCondition("test-form")

	reqBody := CreateBailRequest{
		Name:        "New Bail",
		Description: "Test description",
		Definition:  def,
	}
	reqJSON, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/users/"+userID.String()+"/bails", strings.NewReader(string(reqJSON)))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := server.echo.NewContext(req, rec)
	c.SetPath("/users/:userId/bails")
	c.SetParamNames("userId")
	c.SetParamValues(userID.String())

	if err := server.CreateBail(c); err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	if rec.Code != http.StatusCreated {
		t.Errorf("Expected status 201, got %d", rec.Code)
	}

	var response BailResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if response.Bail.Name != "New Bail" {
		t.Errorf("Expected bail name 'New Bail', got '%s'", response.Bail.Name)
	}

	if response.Bail.UserID != userID {
		t.Errorf("Expected user ID %s, got %s", userID, response.Bail.UserID)
	}

	if len(mock.bails) != 1 {
		t.Errorf("Expected 1 bail in mock, got %d", len(mock.bails))
	}
}

func TestCreateBail_InvalidDefinition(t *testing.T) {
	userID := uuid.New()
	mock := &mockDB{
		bails: []*db.Bail{},
	}

	server := New(mock)

	def := types.BailDefinition{
		Conditions: simpleFormCondition("test-form"),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "",
		},
	}

	reqBody := CreateBailRequest{
		Name:       "Invalid Bail",
		Definition: def,
	}
	reqJSON, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/users/"+userID.String()+"/bails", strings.NewReader(string(reqJSON)))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := server.echo.NewContext(req, rec)
	c.SetPath("/users/:userId/bails")
	c.SetParamNames("userId")
	c.SetParamValues(userID.String())

	if err := server.CreateBail(c); err != nil {
		t.Fatalf("CreateBail failed: %v", err)
	}

	if rec.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400, got %d", rec.Code)
	}

	var response ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if response.Error != "invalid_definition" {
		t.Errorf("Expected error 'invalid_definition', got '%s'", response.Error)
	}

	if len(mock.bails) != 0 {
		t.Errorf("Expected 0 bails in mock, got %d", len(mock.bails))
	}
}

func TestUpdateBail(t *testing.T) {
	userID := uuid.New()
	bailID := uuid.New()

	def := testBailDefinition()
	def.Conditions = simpleFormCondition("test-form")
	defJSON, _ := json.Marshal(def)

	mock := &mockDB{
		bails: []*db.Bail{
			{
				ID:               bailID,
				UserID:           userID,
				Name:             "Original Name",
				Description:      "Original description",
				Enabled:          true,
				Definition:       defJSON,
				DestinationForm:  "exit-form",
				CreatedAt:        time.Now(),
				UpdatedAt:        time.Now(),
			},
		},
	}

	server := New(mock)

	newName := "Updated Name"
	newEnabled := false
	reqBody := UpdateBailRequest{
		Name:    &newName,
		Enabled: &newEnabled,
	}
	reqJSON, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPut, "/users/"+userID.String()+"/bails/"+bailID.String(), strings.NewReader(string(reqJSON)))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := server.echo.NewContext(req, rec)
	c.SetPath("/users/:userId/bails/:id")
	c.SetParamNames("userId", "id")
	c.SetParamValues(userID.String(), bailID.String())

	if err := server.UpdateBail(c); err != nil {
		t.Fatalf("UpdateBail failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	var response BailResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if response.Bail.Name != "Updated Name" {
		t.Errorf("Expected bail name 'Updated Name', got '%s'", response.Bail.Name)
	}

	if response.Bail.Enabled {
		t.Error("Expected bail to be disabled")
	}

	if mock.bails[0].Name != "Updated Name" {
		t.Errorf("Expected bail name in mock to be 'Updated Name', got '%s'", mock.bails[0].Name)
	}
}

func TestDeleteBail(t *testing.T) {
	userID := uuid.New()
	bailID := uuid.New()

	def := testBailDefinition()
	def.Conditions = simpleFormCondition("test-form")
	defJSON, _ := json.Marshal(def)

	mock := &mockDB{
		bails: []*db.Bail{
			{
				ID:               bailID,
				UserID:           userID,
				Name:             "Test Bail",
				Description:      "Test description",
				Enabled:          true,
				Definition:       defJSON,
				DestinationForm:  "exit-form",
				CreatedAt:        time.Now(),
				UpdatedAt:        time.Now(),
			},
		},
	}

	server := New(mock)

	req := httptest.NewRequest(http.MethodDelete, "/users/"+userID.String()+"/bails/"+bailID.String(), nil)
	rec := httptest.NewRecorder()
	c := server.echo.NewContext(req, rec)
	c.SetPath("/users/:userId/bails/:id")
	c.SetParamNames("userId", "id")
	c.SetParamValues(userID.String(), bailID.String())

	if err := server.DeleteBail(c); err != nil {
		t.Fatalf("DeleteBail failed: %v", err)
	}

	if rec.Code != http.StatusNoContent {
		t.Errorf("Expected status 204, got %d", rec.Code)
	}

	if len(mock.bails) != 0 {
		t.Errorf("Expected 0 bails in mock after delete, got %d", len(mock.bails))
	}
}

func TestGetBailEvents(t *testing.T) {
	userID := uuid.New()
	bailID := uuid.New()

	def := testBailDefinition()
	def.Conditions = simpleFormCondition("test-form")
	defJSON, _ := json.Marshal(def)

	mock := &mockDB{
		bails: []*db.Bail{
			{
				ID:               bailID,
				UserID:           userID,
				Name:             "Test Bail",
				Description:      "Test description",
				Enabled:          true,
				Definition:       defJSON,
				DestinationForm:  "exit-form",
				CreatedAt:        time.Now(),
				UpdatedAt:        time.Now(),
			},
		},
		events: []*db.BailEvent{
			{
				ID:                 uuid.New(),
				BailID:             &bailID,
				UserID:             userID,
				BailName:           "Test Bail",
				EventType:          "execution",
				Timestamp:          time.Now(),
				UsersMatched:       10,
				UsersBailed:        10,
				DefinitionSnapshot: defJSON,
			},
			{
				ID:                 uuid.New(),
				BailID:             &bailID,
				UserID:             userID,
				BailName:           "Test Bail",
				EventType:          "execution",
				Timestamp:          time.Now().Add(-1 * time.Hour),
				UsersMatched:       5,
				UsersBailed:        5,
				DefinitionSnapshot: defJSON,
			},
		},
	}

	server := New(mock)

	req := httptest.NewRequest(http.MethodGet, "/users/"+userID.String()+"/bails/"+bailID.String()+"/events", nil)
	rec := httptest.NewRecorder()
	c := server.echo.NewContext(req, rec)
	c.SetPath("/users/:userId/bails/:id/events")
	c.SetParamNames("userId", "id")
	c.SetParamValues(userID.String(), bailID.String())

	if err := server.GetBailEvents(c); err != nil {
		t.Fatalf("GetBailEvents failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	var response EventsListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if len(response.Events) != 2 {
		t.Errorf("Expected 2 events, got %d", len(response.Events))
	}

	if response.Events[0].UsersMatched != 10 {
		t.Errorf("Expected 10 users matched, got %d", response.Events[0].UsersMatched)
	}
}

func TestPreviewBail(t *testing.T) {
	userID := uuid.New()

	mock := &mockDB{
		queryFunc: func(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error) {
			return []map[string]interface{}{
				{"userid": "user1", "pageid": "page1"},
				{"userid": "user2", "pageid": "page2"},
				{"userid": "user3", "pageid": "page3"},
			}, nil
		},
	}

	server := New(mock)

	def := testBailDefinition()
	def.Conditions = simpleFormCondition("test-form")

	reqBody := PreviewRequest{
		Definition: def,
	}
	reqJSON, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/users/"+userID.String()+"/bails/preview", strings.NewReader(string(reqJSON)))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := server.echo.NewContext(req, rec)
	c.SetPath("/users/:userId/bails/preview")
	c.SetParamNames("userId")
	c.SetParamValues(userID.String())

	if err := server.PreviewBail(c); err != nil {
		t.Fatalf("PreviewBail failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	var response PreviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if response.Count != 3 {
		t.Errorf("Expected count 3, got %d", response.Count)
	}

	if len(response.Users) != 3 {
		t.Errorf("Expected 3 users, got %d", len(response.Users))
	}

	if response.Users[0].UserID != "user1" {
		t.Errorf("Expected first user to be 'user1', got '%s'", response.Users[0].UserID)
	}
}
