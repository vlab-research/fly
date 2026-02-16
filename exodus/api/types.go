package api

import (
	"github.com/vlab-research/exodus/types"
)

// CreateBailRequest represents the payload for creating a new bail
type CreateBailRequest struct {
	Name        string               `json:"name"`
	Description string               `json:"description,omitempty"`
	Definition  types.BailDefinition `json:"definition"`
	Enabled     bool                 `json:"enabled"`
}

// UpdateBailRequest represents the payload for updating an existing bail
// All fields are optional to support partial updates
type UpdateBailRequest struct {
	Name        *string               `json:"name,omitempty"`
	Description *string               `json:"description,omitempty"`
	Definition  *types.BailDefinition `json:"definition,omitempty"`
	Enabled     *bool                 `json:"enabled,omitempty"`
}

// BailResponse wraps a bail with its most recent event
type BailResponse struct {
	Bail      *types.Bail      `json:"bail"`
	LastEvent *types.BailEvent `json:"last_event,omitempty"`
}

// BailsListResponse contains a list of bails with their events
type BailsListResponse struct {
	Bails []*BailResponse `json:"bails"`
}

// EventsListResponse contains a list of bail events
type EventsListResponse struct {
	Events []*types.BailEvent `json:"events"`
}

// PreviewRequest represents the payload for previewing a bail definition
type PreviewRequest struct {
	Definition types.BailDefinition `json:"definition"`
}

// PreviewResponse contains the results of a bail preview
type PreviewResponse struct {
	Users []UserPreview `json:"users"`
	Count int           `json:"count"`
}

// UserPreview represents a user that matches bail conditions
type UserPreview struct {
	UserID string `json:"userid"`
	PageID string `json:"pageid"`
}

// ErrorResponse represents an error response
type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}
