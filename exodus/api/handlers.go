package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v4"
	"github.com/labstack/echo/v4"
	"github.com/vlab-research/exodus/db"
	"github.com/vlab-research/exodus/query"
	"github.com/vlab-research/exodus/types"
)

// Health returns a simple health check response
// GET /health
func (s *Server) Health(c echo.Context) error {
	return c.JSON(http.StatusOK, map[string]string{
		"status": "ok",
	})
}

// ListBails retrieves all bails for a survey with their most recent events
// GET /surveys/:surveyId/bails
func (s *Server) ListBails(c echo.Context) error {
	// Parse survey ID from path
	surveyIDStr := c.Param("surveyId")
	surveyID, err := uuid.Parse(surveyIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_survey_id", "Survey ID must be a valid UUID")
	}

	// Get bails from database
	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbBails, err := s.db.GetBailsBySurvey(ctx, surveyID)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Convert db.Bail to types.Bail and fetch last events
	bailResponses := make([]*BailResponse, len(dbBails))
	for i, dbBail := range dbBails {
		typeBail, err := dbBailToTypesBail(dbBail)
		if err != nil {
			return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert bail: %v", err))
		}

		// Get most recent event for this bail
		events, err := s.db.GetEventsByBailID(ctx, dbBail.ID)
		if err != nil {
			return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
		}

		var lastEvent *types.BailEvent
		if len(events) > 0 {
			lastEvent, err = dbEventToTypesEvent(events[0])
			if err != nil {
				return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert event: %v", err))
			}
		}

		bailResponses[i] = &BailResponse{
			Bail:      typeBail,
			LastEvent: lastEvent,
		}
	}

	return c.JSON(http.StatusOK, BailsListResponse{Bails: bailResponses})
}

// GetBail retrieves a single bail by ID
// GET /surveys/:surveyId/bails/:id
func (s *Server) GetBail(c echo.Context) error {
	// Parse survey ID
	surveyIDStr := c.Param("surveyId")
	surveyID, err := uuid.Parse(surveyIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_survey_id", "Survey ID must be a valid UUID")
	}

	// Parse bail ID
	bailIDStr := c.Param("id")
	bailID, err := uuid.Parse(bailIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_bail_id", "Bail ID must be a valid UUID")
	}

	// Get bail from database
	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbBail, err := s.db.GetBailByID(ctx, bailID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found")
		}
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Verify bail belongs to the survey
	if dbBail.SurveyID != surveyID {
		return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found in this survey")
	}

	// Convert to types.Bail
	typeBail, err := dbBailToTypesBail(dbBail)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert bail: %v", err))
	}

	// Get most recent event
	events, err := s.db.GetEventsByBailID(ctx, bailID)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	var lastEvent *types.BailEvent
	if len(events) > 0 {
		lastEvent, err = dbEventToTypesEvent(events[0])
		if err != nil {
			return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert event: %v", err))
		}
	}

	return c.JSON(http.StatusOK, BailResponse{
		Bail:      typeBail,
		LastEvent: lastEvent,
	})
}

// CreateBail creates a new bail for a survey
// POST /surveys/:surveyId/bails
func (s *Server) CreateBail(c echo.Context) error {
	// Parse survey ID
	surveyIDStr := c.Param("surveyId")
	surveyID, err := uuid.Parse(surveyIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_survey_id", "Survey ID must be a valid UUID")
	}

	// Parse request body
	var req CreateBailRequest
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_request", "Failed to parse request body")
	}

	// Validate required fields
	if req.Name == "" {
		return respondError(c, http.StatusBadRequest, "missing_field", "Name is required")
	}

	// Validate bail definition
	if err := req.Definition.Validate(); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_definition", err.Error())
	}

	// Marshal definition to JSON
	definitionJSON, err := json.Marshal(req.Definition)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "marshal_error", "Failed to marshal definition")
	}

	// Create db.Bail
	dbBail := &db.Bail{
		SurveyID:        surveyID,
		Name:            req.Name,
		Description:     req.Description,
		Enabled:         true, // Default to enabled
		Definition:      definitionJSON,
		DestinationForm: req.Definition.Action.DestinationForm,
	}

	// Insert into database
	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	if err := s.db.CreateBail(ctx, dbBail); err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Convert to types.Bail for response
	typeBail, err := dbBailToTypesBail(dbBail)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert bail: %v", err))
	}

	return c.JSON(http.StatusCreated, BailResponse{
		Bail:      typeBail,
		LastEvent: nil,
	})
}

// UpdateBail updates an existing bail
// PUT /surveys/:surveyId/bails/:id
func (s *Server) UpdateBail(c echo.Context) error {
	// Parse survey ID
	surveyIDStr := c.Param("surveyId")
	surveyID, err := uuid.Parse(surveyIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_survey_id", "Survey ID must be a valid UUID")
	}

	// Parse bail ID
	bailIDStr := c.Param("id")
	bailID, err := uuid.Parse(bailIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_bail_id", "Bail ID must be a valid UUID")
	}

	// Parse request body
	var req UpdateBailRequest
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_request", "Failed to parse request body")
	}

	// Get existing bail
	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbBail, err := s.db.GetBailByID(ctx, bailID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found")
		}
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Verify bail belongs to the survey
	if dbBail.SurveyID != surveyID {
		return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found in this survey")
	}

	// Apply updates
	if req.Name != nil {
		dbBail.Name = *req.Name
	}
	if req.Description != nil {
		dbBail.Description = *req.Description
	}
	if req.Enabled != nil {
		dbBail.Enabled = *req.Enabled
	}
	if req.Definition != nil {
		// Validate new definition
		if err := req.Definition.Validate(); err != nil {
			return respondError(c, http.StatusBadRequest, "invalid_definition", err.Error())
		}

		// Marshal new definition
		definitionJSON, err := json.Marshal(req.Definition)
		if err != nil {
			return respondError(c, http.StatusInternalServerError, "marshal_error", "Failed to marshal definition")
		}

		dbBail.Definition = definitionJSON
		dbBail.DestinationForm = req.Definition.Action.DestinationForm
	}

	// Update in database
	if err := s.db.UpdateBail(ctx, dbBail); err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Convert to types.Bail for response
	typeBail, err := dbBailToTypesBail(dbBail)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert bail: %v", err))
	}

	// Get most recent event
	events, err := s.db.GetEventsByBailID(ctx, bailID)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	var lastEvent *types.BailEvent
	if len(events) > 0 {
		lastEvent, err = dbEventToTypesEvent(events[0])
		if err != nil {
			return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert event: %v", err))
		}
	}

	return c.JSON(http.StatusOK, BailResponse{
		Bail:      typeBail,
		LastEvent: lastEvent,
	})
}

// DeleteBail removes a bail from the database
// DELETE /surveys/:surveyId/bails/:id
func (s *Server) DeleteBail(c echo.Context) error {
	// Parse survey ID
	surveyIDStr := c.Param("surveyId")
	surveyID, err := uuid.Parse(surveyIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_survey_id", "Survey ID must be a valid UUID")
	}

	// Parse bail ID
	bailIDStr := c.Param("id")
	bailID, err := uuid.Parse(bailIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_bail_id", "Bail ID must be a valid UUID")
	}

	// Get bail to verify it belongs to survey
	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbBail, err := s.db.GetBailByID(ctx, bailID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found")
		}
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Verify bail belongs to the survey
	if dbBail.SurveyID != surveyID {
		return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found in this survey")
	}

	// Delete from database
	if err := s.db.DeleteBail(ctx, bailID); err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	return c.NoContent(http.StatusNoContent)
}

// GetBailEvents retrieves event history for a specific bail
// GET /surveys/:surveyId/bails/:id/events
func (s *Server) GetBailEvents(c echo.Context) error {
	// Parse survey ID
	surveyIDStr := c.Param("surveyId")
	surveyID, err := uuid.Parse(surveyIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_survey_id", "Survey ID must be a valid UUID")
	}

	// Parse bail ID
	bailIDStr := c.Param("id")
	bailID, err := uuid.Parse(bailIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_bail_id", "Bail ID must be a valid UUID")
	}

	// Get bail to verify it exists and belongs to survey
	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbBail, err := s.db.GetBailByID(ctx, bailID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found")
		}
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Verify bail belongs to the survey
	if dbBail.SurveyID != surveyID {
		return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found in this survey")
	}

	// Get events
	dbEvents, err := s.db.GetEventsByBailID(ctx, bailID)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Convert to types.BailEvent
	events := make([]*types.BailEvent, len(dbEvents))
	for i, dbEvent := range dbEvents {
		typeEvent, err := dbEventToTypesEvent(dbEvent)
		if err != nil {
			return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert event: %v", err))
		}
		events[i] = typeEvent
	}

	return c.JSON(http.StatusOK, EventsListResponse{Events: events})
}

// GetSurveyEvents retrieves recent event history for a survey
// GET /surveys/:surveyId/bail-events
func (s *Server) GetSurveyEvents(c echo.Context) error {
	// Parse survey ID
	surveyIDStr := c.Param("surveyId")
	surveyID, err := uuid.Parse(surveyIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_survey_id", "Survey ID must be a valid UUID")
	}

	// Get limit from query parameter (default 100)
	limit := 100
	if limitStr := c.QueryParam("limit"); limitStr != "" {
		if _, err := fmt.Sscanf(limitStr, "%d", &limit); err != nil {
			return respondError(c, http.StatusBadRequest, "invalid_limit", "Limit must be a number")
		}
		if limit < 1 || limit > 1000 {
			return respondError(c, http.StatusBadRequest, "invalid_limit", "Limit must be between 1 and 1000")
		}
	}

	// Get events from database
	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbEvents, err := s.db.GetEventsBySurvey(ctx, surveyID, limit)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Convert to types.BailEvent
	events := make([]*types.BailEvent, len(dbEvents))
	for i, dbEvent := range dbEvents {
		typeEvent, err := dbEventToTypesEvent(dbEvent)
		if err != nil {
			return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert event: %v", err))
		}
		events[i] = typeEvent
	}

	return c.JSON(http.StatusOK, EventsListResponse{Events: events})
}

// PreviewBail performs a dry run of a bail definition without saving
// POST /surveys/:surveyId/bails/preview
func (s *Server) PreviewBail(c echo.Context) error {
	// Parse survey ID (for context, though not strictly needed for preview)
	surveyIDStr := c.Param("surveyId")
	_, err := uuid.Parse(surveyIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_survey_id", "Survey ID must be a valid UUID")
	}

	// Parse request body
	var req PreviewRequest
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_request", "Failed to parse request body")
	}

	// Validate definition
	if err := req.Definition.Validate(); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_definition", err.Error())
	}

	// Build query from definition
	sqlQuery, params, err := query.BuildQuery(&req.Definition)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "query_build_error", err.Error())
	}

	// Execute query to get matching users (limited to 100)
	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	results, err := s.db.Query(ctx, sqlQuery, params...)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "query_error", err.Error())
	}

	// Convert results to UserPreview
	users := make([]UserPreview, len(results))
	for i, row := range results {
		userID, ok := row["userid"].(string)
		if !ok {
			return respondError(c, http.StatusInternalServerError, "conversion_error", "Failed to convert userid")
		}
		pageID, ok := row["pageid"].(string)
		if !ok {
			return respondError(c, http.StatusInternalServerError, "conversion_error", "Failed to convert pageid")
		}
		users[i] = UserPreview{
			UserID: userID,
			PageID: pageID,
		}
	}

	return c.JSON(http.StatusOK, PreviewResponse{
		Users: users,
		Count: len(users),
	})
}

// dbBailToTypesBail converts a db.Bail to types.Bail
func dbBailToTypesBail(dbBail *db.Bail) (*types.Bail, error) {
	var definition types.BailDefinition
	if err := json.Unmarshal(dbBail.Definition, &definition); err != nil {
		return nil, fmt.Errorf("failed to unmarshal definition: %w", err)
	}

	return &types.Bail{
		ID:              dbBail.ID,
		SurveyID:        dbBail.SurveyID,
		Name:            dbBail.Name,
		Description:     dbBail.Description,
		Enabled:         dbBail.Enabled,
		Definition:      definition,
		DestinationForm: dbBail.DestinationForm,
		CreatedAt:       dbBail.CreatedAt,
		UpdatedAt:       dbBail.UpdatedAt,
	}, nil
}

// dbEventToTypesEvent converts a db.BailEvent to types.BailEvent
func dbEventToTypesEvent(dbEvent *db.BailEvent) (*types.BailEvent, error) {
	var definition types.BailDefinition
	if err := json.Unmarshal(dbEvent.DefinitionSnapshot, &definition); err != nil {
		return nil, fmt.Errorf("failed to unmarshal definition snapshot: %w", err)
	}

	return &types.BailEvent{
		ID:                 dbEvent.ID,
		BailID:             dbEvent.BailID,
		SurveyID:           dbEvent.SurveyID,
		BailName:           dbEvent.BailName,
		EventType:          dbEvent.EventType,
		Timestamp:          dbEvent.Timestamp,
		UsersMatched:       dbEvent.UsersMatched,
		UsersBailed:        dbEvent.UsersBailed,
		DefinitionSnapshot: definition,
		Error:              dbEvent.Error,
	}, nil
}
