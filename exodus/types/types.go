package types

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// BailDefinition represents a complete bail configuration
type BailDefinition struct {
	Type       string     `json:"type,omitempty"`        // "conditions" (default) or "user_list"
	Conditions *Condition `json:"conditions,omitempty"`  // Required when Type="conditions"
	UserList   *UserList  `json:"user_list,omitempty"`   // Required when Type="user_list"
	Execution  Execution  `json:"execution"`
	Action     Action     `json:"action"`
}

// Validate checks if the BailDefinition is valid
func (bd *BailDefinition) Validate() error {
	bailType := bd.Type
	if bailType == "" {
		bailType = "conditions" // backward compatibility
	}

	switch bailType {
	case "conditions":
		if bd.Conditions == nil {
			return fmt.Errorf("conditions are required for conditions-type bail")
		}
		if err := bd.Conditions.Validate(); err != nil {
			return fmt.Errorf("invalid conditions: %w", err)
		}
	case "user_list":
		if bd.UserList == nil {
			return fmt.Errorf("user_list is required for user_list-type bail")
		}
		if err := bd.UserList.Validate(); err != nil {
			return fmt.Errorf("invalid user_list: %w", err)
		}
	default:
		return fmt.Errorf("invalid bail type: %s (must be 'conditions' or 'user_list')", bailType)
	}

	if err := bd.Execution.Validate(); err != nil {
		return fmt.Errorf("invalid execution: %w", err)
	}
	// For user_list bails, action.destination_form is optional (destinations are per-user)
	// Skip action validation for user_list type
	if bailType != "user_list" {
		if err := bd.Action.Validate(); err != nil {
			return fmt.Errorf("invalid action: %w", err)
		}
	}
	return nil
}

// Execution defines when a bail should be executed
type Execution struct {
	Timing    string  `json:"timing"` // "immediate", "scheduled", or "absolute"
	TimeOfDay *string `json:"time_of_day,omitempty"`
	Timezone  *string `json:"timezone,omitempty"`
	Datetime  *string `json:"datetime,omitempty"`
}

// Validate checks if the Execution configuration is valid
func (e *Execution) Validate() error {
	switch e.Timing {
	case "immediate":
		// No additional fields required
	case "scheduled":
		if e.TimeOfDay == nil {
			return fmt.Errorf("time_of_day is required for scheduled timing")
		}
		if e.Timezone == nil {
			return fmt.Errorf("timezone is required for scheduled timing")
		}
		// TODO: Validate time_of_day format (HH:MM)
		// TODO: Validate timezone is valid IANA timezone
	case "absolute":
		if e.Datetime == nil {
			return fmt.Errorf("datetime is required for absolute timing")
		}
		// TODO: Validate datetime is valid ISO 8601 format
	default:
		return fmt.Errorf("invalid timing type: %s (must be immediate, scheduled, or absolute)", e.Timing)
	}
	return nil
}

// Action defines what happens when a bail is triggered
type Action struct {
	DestinationForm string                 `json:"destination_form"`
	Metadata        map[string]interface{} `json:"metadata,omitempty"`
}

// Validate checks if the Action is valid
func (a *Action) Validate() error {
	if a.DestinationForm == "" {
		return fmt.Errorf("destination_form is required")
	}
	return nil
}

// UserListEntry represents a single user in a user list bail
type UserListEntry struct {
	UserID    string `json:"userid"`
	PageID    string `json:"pageid"`
	Shortcode string `json:"shortcode"` // per-user destination form
}

// UserList represents a list of users for user_list-type bails
type UserList struct {
	Users []UserListEntry `json:"users"`
}

// Validate checks if the UserList is valid
func (ul *UserList) Validate() error {
	if len(ul.Users) == 0 {
		return fmt.Errorf("user_list must contain at least one user")
	}
	if len(ul.Users) > 1000 {
		return fmt.Errorf("user_list must contain at most 1000 users (got %d)", len(ul.Users))
	}
	for i, entry := range ul.Users {
		if entry.UserID == "" {
			return fmt.Errorf("userid is required at index %d", i)
		}
		if entry.PageID == "" {
			return fmt.Errorf("pageid is required at index %d", i)
		}
		if entry.Shortcode == "" {
			return fmt.Errorf("shortcode is required at index %d", i)
		}
	}
	return nil
}

// Condition represents a union type that can be a simple condition or a logical operation
type Condition struct {
	simple   *SimpleCondition
	operator *LogicalOperator
}

// SimpleCondition represents basic condition types
type SimpleCondition struct {
	Type         string         `json:"type"`
	Value        *string        `json:"value,omitempty"`
	Since        *TimeReference `json:"since,omitempty"`
	Duration     *string        `json:"duration,omitempty"`
	ErrorCode    *string        `json:"error_code,omitempty"`
	QuestionRef  *string        `json:"question_ref,omitempty"`
	CurrentState *string        `json:"current_state,omitempty"`
	Form         *string        `json:"form,omitempty"`
	Response     *string        `json:"response,omitempty"`
}

// LogicalOperator represents and/or/not operations on conditions
type LogicalOperator struct {
	Op   string      `json:"op"`   // "and", "or", or "not"
	Vars []Condition `json:"vars"` // Array of conditions
}

// TimeReference specifies what event to measure time from
type TimeReference struct {
	Event   string             `json:"event"`
	Details *TimeEventDetails  `json:"details,omitempty"`
}

// TimeEventDetails provides context for time-based conditions
type TimeEventDetails struct {
	QuestionRef string `json:"question_ref"`
	Form        string `json:"form"`
}

// MarshalJSON implements custom JSON marshaling for Condition
// Uses value receiver to ensure it works when marshaling by value
func (c Condition) MarshalJSON() ([]byte, error) {
	if c.simple != nil {
		return json.Marshal(c.simple)
	}
	if c.operator != nil {
		return json.Marshal(c.operator)
	}
	return []byte("null"), nil
}

// UnmarshalJSON implements custom JSON unmarshaling for Condition
func (c *Condition) UnmarshalJSON(data []byte) error {
	// First try to unmarshal as a map to check if it has "op" field
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	// Check if this is a logical operator (has "op" and "vars" fields)
	if op, hasOp := raw["op"]; hasOp {
		if opStr, ok := op.(string); ok && (opStr == "and" || opStr == "or" || opStr == "not") {
			var logOp LogicalOperator
			if err := json.Unmarshal(data, &logOp); err != nil {
				return err
			}
			c.operator = &logOp
			return nil
		}
	}

	// Otherwise, treat as a simple condition
	var simple SimpleCondition
	if err := json.Unmarshal(data, &simple); err != nil {
		return err
	}
	c.simple = &simple
	return nil
}

// Validate checks if the Condition is valid
func (c *Condition) Validate() error {
	if c.simple != nil {
		return c.simple.Validate()
	}
	if c.operator != nil {
		return c.operator.Validate()
	}
	return fmt.Errorf("condition must be either a simple condition or logical operator")
}

// Validate checks if a SimpleCondition is valid
func (sc *SimpleCondition) Validate() error {
	switch sc.Type {
	case "form":
		if sc.Value == nil {
			return fmt.Errorf("value is required for form condition")
		}
	case "state":
		if sc.Value == nil {
			return fmt.Errorf("value is required for state condition")
		}
	case "error_code":
		if sc.Value == nil {
			return fmt.Errorf("value is required for error_code condition")
		}
	case "current_question":
		if sc.Value == nil {
			return fmt.Errorf("value is required for current_question condition")
		}
	case "elapsed_time":
		if sc.Since == nil {
			return fmt.Errorf("since is required for elapsed_time condition")
		}
		if sc.Duration == nil {
			return fmt.Errorf("duration is required for elapsed_time condition")
		}
		if err := sc.Since.Validate(); err != nil {
			return fmt.Errorf("invalid since reference: %w", err)
		}
	case "question_response":
		if sc.Form == nil || *sc.Form == "" {
			return fmt.Errorf("question_response condition requires 'form' field")
		}
		if sc.QuestionRef == nil || *sc.QuestionRef == "" {
			return fmt.Errorf("question_response condition requires 'question_ref' field")
		}
		// response is optional — no check needed
	case "surveyid":
		if sc.Value == nil || *sc.Value == "" {
			return fmt.Errorf("value is required for surveyid condition")
		}
	default:
		return fmt.Errorf("invalid condition type: %s (must be form, state, error_code, current_question, elapsed_time, question_response, or surveyid)", sc.Type)
	}
	return nil
}

// Validate checks if a LogicalOperator is valid
func (lo *LogicalOperator) Validate() error {
	switch lo.Op {
	case "and", "or":
		if len(lo.Vars) == 0 {
			return fmt.Errorf("logical operator must have at least one condition")
		}
	case "not":
		if len(lo.Vars) != 1 {
			return fmt.Errorf("not operator must have exactly one condition, got %d", len(lo.Vars))
		}
	default:
		return fmt.Errorf("invalid operator: %s (must be and, or, or not)", lo.Op)
	}
	for i, cond := range lo.Vars {
		if err := cond.Validate(); err != nil {
			return fmt.Errorf("invalid condition at index %d: %w", i, err)
		}
	}
	// Reject NOT wrapping elapsed_time or question_response (directly or transitively)
	if lo.Op == "not" {
		if containsCTECondition(&lo.Vars[0]) {
			return fmt.Errorf("not operator cannot negate elapsed_time or question_response conditions (not yet supported)")
		}
	}
	return nil
}

// containsCTECondition recursively checks if a condition tree contains an elapsed_time
// or question_response condition (both require CTE-based query generation)
func containsCTECondition(c *Condition) bool {
	if c.IsSimple() {
		t := c.GetSimple().Type
		return t == "elapsed_time" || t == "question_response"
	}
	if c.IsOperator() {
		for i := range c.GetOperator().Vars {
			if containsCTECondition(&c.GetOperator().Vars[i]) {
				return true
			}
		}
	}
	return false
}

// Validate checks if a TimeReference is valid
func (tr *TimeReference) Validate() error {
	switch tr.Event {
	case "response":
		if tr.Details == nil {
			return fmt.Errorf("details are required for response event")
		}
		if tr.Details.QuestionRef == "" {
			return fmt.Errorf("question_ref is required in details")
		}
		if tr.Details.Form == "" {
			return fmt.Errorf("form is required in details")
		}
	default:
		return fmt.Errorf("invalid event type: %s", tr.Event)
	}
	return nil
}

// IsSimple returns true if this is a simple condition
func (c *Condition) IsSimple() bool {
	return c.simple != nil
}

// IsOperator returns true if this is a logical operator
func (c *Condition) IsOperator() bool {
	return c.operator != nil
}

// GetSimple returns the simple condition or nil
func (c *Condition) GetSimple() *SimpleCondition {
	return c.simple
}

// GetOperator returns the logical operator or nil
func (c *Condition) GetOperator() *LogicalOperator {
	return c.operator
}

// Database model types

// Bail represents a bail configuration stored in the database
type Bail struct {
	ID               uuid.UUID      `json:"id"`
	UserID           uuid.UUID      `json:"user_id"`
	Name             string         `json:"name"`
	Description      string         `json:"description"`
	Enabled          bool           `json:"enabled"`
	Definition       BailDefinition `json:"definition"`
	DestinationForm  string         `json:"destination_form"`
	CreatedAt        time.Time      `json:"created_at"`
	UpdatedAt        time.Time      `json:"updated_at"`
}

// Validate checks if the Bail is valid
func (b *Bail) Validate() error {
	if b.UserID == uuid.Nil {
		return fmt.Errorf("user_id is required")
	}
	if b.Name == "" {
		return fmt.Errorf("name is required")
	}
	if b.DestinationForm == "" {
		return fmt.Errorf("destination_form is required")
	}
	if err := b.Definition.Validate(); err != nil {
		return fmt.Errorf("invalid definition: %w", err)
	}
	// Ensure destination_form in definition matches top-level field (only for conditions-type bails)
	bailType := b.Definition.Type
	if bailType == "" {
		bailType = "conditions" // backward compatibility
	}
	if bailType == "conditions" {
		if b.Definition.Action.DestinationForm != b.DestinationForm {
			return fmt.Errorf("destination_form mismatch between bail and definition")
		}
	}
	return nil
}

// BailEvent represents an event logged when a bail is executed or errors
type BailEvent struct {
	ID                 uuid.UUID        `json:"id"`
	BailID             *uuid.UUID       `json:"bail_id,omitempty"`
	UserID             uuid.UUID        `json:"user_id"`
	BailName           string           `json:"bail_name"`
	EventType          string           `json:"event_type"` // "execution" or "error"
	Timestamp          time.Time        `json:"timestamp"`
	UsersMatched       int              `json:"users_matched"`
	UsersBailed        int              `json:"users_bailed"`
	DefinitionSnapshot BailDefinition   `json:"definition_snapshot"`
	Error              *json.RawMessage `json:"error,omitempty"`
}

// Validate checks if the BailEvent is valid
func (be *BailEvent) Validate() error {
	if be.UserID == uuid.Nil {
		return fmt.Errorf("user_id is required")
	}
	if be.BailName == "" {
		return fmt.Errorf("bail_name is required")
	}
	if be.EventType != "execution" && be.EventType != "error" {
		return fmt.Errorf("event_type must be either 'execution' or 'error'")
	}
	if be.UsersMatched < 0 {
		return fmt.Errorf("users_matched cannot be negative")
	}
	if be.UsersBailed < 0 {
		return fmt.Errorf("users_bailed cannot be negative")
	}
	if be.UsersBailed > be.UsersMatched {
		return fmt.Errorf("users_bailed cannot exceed users_matched")
	}
	if err := be.DefinitionSnapshot.Validate(); err != nil {
		return fmt.Errorf("invalid definition_snapshot: %w", err)
	}
	return nil
}
