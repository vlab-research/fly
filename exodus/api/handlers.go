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

// ListBails retrieves all bails for a user with their most recent events
// GET /users/:userId/bails
func (s *Server) ListBails(c echo.Context) error {
	userIDStr := c.Param("userId")
	userID, err := uuid.Parse(userIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_user_id", "User ID must be a valid UUID")
	}

	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbBails, err := s.db.GetBailsByUser(ctx, userID)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	bailResponses := make([]*BailResponse, len(dbBails))
	for i, dbBail := range dbBails {
		typeBail, err := dbBailToTypesBail(dbBail)
		if err != nil {
			return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert bail: %v", err))
		}

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
// GET /users/:userId/bails/:id
func (s *Server) GetBail(c echo.Context) error {
	userIDStr := c.Param("userId")
	userID, err := uuid.Parse(userIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_user_id", "User ID must be a valid UUID")
	}

	bailIDStr := c.Param("id")
	bailID, err := uuid.Parse(bailIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_bail_id", "Bail ID must be a valid UUID")
	}

	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbBail, err := s.db.GetBailByID(ctx, bailID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found")
		}
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Verify bail belongs to the user
	if dbBail.UserID != userID {
		return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found for this user")
	}

	typeBail, err := dbBailToTypesBail(dbBail)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert bail: %v", err))
	}

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

// CreateBail creates a new bail for a user
// POST /users/:userId/bails
func (s *Server) CreateBail(c echo.Context) error {
	userIDStr := c.Param("userId")
	userID, err := uuid.Parse(userIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_user_id", "User ID must be a valid UUID")
	}

	var req CreateBailRequest
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_request", "Failed to parse request body")
	}

	if req.Name == "" {
		return respondError(c, http.StatusBadRequest, "missing_field", "Name is required")
	}

	if err := req.Definition.Validate(); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_definition", err.Error())
	}

	definitionJSON, err := json.Marshal(req.Definition)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "marshal_error", "Failed to marshal definition")
	}

	dbBail := &db.Bail{
		UserID:          userID,
		Name:            req.Name,
		Description:     req.Description,
		Enabled:         true,
		Definition:      definitionJSON,
		DestinationForm: req.Definition.Action.DestinationForm,
	}

	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	if err := s.db.CreateBail(ctx, dbBail); err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

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
// PUT /users/:userId/bails/:id
func (s *Server) UpdateBail(c echo.Context) error {
	userIDStr := c.Param("userId")
	userID, err := uuid.Parse(userIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_user_id", "User ID must be a valid UUID")
	}

	bailIDStr := c.Param("id")
	bailID, err := uuid.Parse(bailIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_bail_id", "Bail ID must be a valid UUID")
	}

	var req UpdateBailRequest
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_request", "Failed to parse request body")
	}

	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbBail, err := s.db.GetBailByID(ctx, bailID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found")
		}
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Verify bail belongs to the user
	if dbBail.UserID != userID {
		return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found for this user")
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
		if err := req.Definition.Validate(); err != nil {
			return respondError(c, http.StatusBadRequest, "invalid_definition", err.Error())
		}

		definitionJSON, err := json.Marshal(req.Definition)
		if err != nil {
			return respondError(c, http.StatusInternalServerError, "marshal_error", "Failed to marshal definition")
		}

		dbBail.Definition = definitionJSON
		dbBail.DestinationForm = req.Definition.Action.DestinationForm
	}

	if err := s.db.UpdateBail(ctx, dbBail); err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	typeBail, err := dbBailToTypesBail(dbBail)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "conversion_error", fmt.Sprintf("Failed to convert bail: %v", err))
	}

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
// DELETE /users/:userId/bails/:id
func (s *Server) DeleteBail(c echo.Context) error {
	userIDStr := c.Param("userId")
	userID, err := uuid.Parse(userIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_user_id", "User ID must be a valid UUID")
	}

	bailIDStr := c.Param("id")
	bailID, err := uuid.Parse(bailIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_bail_id", "Bail ID must be a valid UUID")
	}

	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbBail, err := s.db.GetBailByID(ctx, bailID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found")
		}
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Verify bail belongs to the user
	if dbBail.UserID != userID {
		return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found for this user")
	}

	if err := s.db.DeleteBail(ctx, bailID); err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	return c.NoContent(http.StatusNoContent)
}

// GetBailEvents retrieves event history for a specific bail
// GET /users/:userId/bails/:id/events
func (s *Server) GetBailEvents(c echo.Context) error {
	userIDStr := c.Param("userId")
	userID, err := uuid.Parse(userIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_user_id", "User ID must be a valid UUID")
	}

	bailIDStr := c.Param("id")
	bailID, err := uuid.Parse(bailIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_bail_id", "Bail ID must be a valid UUID")
	}

	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbBail, err := s.db.GetBailByID(ctx, bailID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found")
		}
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

	// Verify bail belongs to the user
	if dbBail.UserID != userID {
		return respondError(c, http.StatusNotFound, "bail_not_found", "Bail not found for this user")
	}

	dbEvents, err := s.db.GetEventsByBailID(ctx, bailID)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

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

// GetUserEvents retrieves recent event history for a user
// GET /users/:userId/bail-events
func (s *Server) GetUserEvents(c echo.Context) error {
	userIDStr := c.Param("userId")
	userID, err := uuid.Parse(userIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_user_id", "User ID must be a valid UUID")
	}

	limit := 100
	if limitStr := c.QueryParam("limit"); limitStr != "" {
		if _, err := fmt.Sscanf(limitStr, "%d", &limit); err != nil {
			return respondError(c, http.StatusBadRequest, "invalid_limit", "Limit must be a number")
		}
		if limit < 1 || limit > 1000 {
			return respondError(c, http.StatusBadRequest, "invalid_limit", "Limit must be between 1 and 1000")
		}
	}

	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	dbEvents, err := s.db.GetEventsByUser(ctx, userID, limit)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "database_error", err.Error())
	}

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
// POST /users/:userId/bails/preview
func (s *Server) PreviewBail(c echo.Context) error {
	userIDStr := c.Param("userId")
	_, err := uuid.Parse(userIDStr)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_user_id", "User ID must be a valid UUID")
	}

	var req PreviewRequest
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_request", "Failed to parse request body")
	}

	if err := req.Definition.Validate(); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid_definition", err.Error())
	}

	sqlQuery, params, err := query.BuildQuery(&req.Definition)
	if err != nil {
		return respondError(c, http.StatusBadRequest, "query_build_error", err.Error())
	}

	ctx, cancel := parseTimeout(c.Request().Context())
	defer cancel()

	results, err := s.db.Query(ctx, sqlQuery, params...)
	if err != nil {
		return respondError(c, http.StatusInternalServerError, "query_error", err.Error())
	}

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
		UserID:          dbBail.UserID,
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
		UserID:             dbEvent.UserID,
		BailName:           dbEvent.BailName,
		EventType:          dbEvent.EventType,
		Timestamp:          dbEvent.Timestamp,
		UsersMatched:       dbEvent.UsersMatched,
		UsersBailed:        dbEvent.UsersBailed,
		DefinitionSnapshot: definition,
		Error:              dbEvent.Error,
	}, nil
}
