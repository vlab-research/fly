package types

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSimpleConditionMarshalUnmarshal(t *testing.T) {
	tests := []struct {
		name     string
		jsonStr  string
		wantErr  bool
		checkVal func(*Condition) bool
	}{
		{
			name:    "form condition",
			jsonStr: `{"type": "form", "value": "survey-123"}`,
			wantErr: false,
			checkVal: func(c *Condition) bool {
				return c.IsSimple() && c.GetSimple().Type == "form" && *c.GetSimple().Value == "survey-123"
			},
		},
		{
			name:    "state condition",
			jsonStr: `{"type": "state", "value": "WAITING"}`,
			wantErr: false,
			checkVal: func(c *Condition) bool {
				return c.IsSimple() && c.GetSimple().Type == "state" && *c.GetSimple().Value == "WAITING"
			},
		},
		{
			name:    "error_code condition",
			jsonStr: `{"type": "error_code", "value": "TIMEOUT"}`,
			wantErr: false,
			checkVal: func(c *Condition) bool {
				return c.IsSimple() && c.GetSimple().Type == "error_code" && *c.GetSimple().Value == "TIMEOUT"
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var cond Condition
			err := json.Unmarshal([]byte(tt.jsonStr), &cond)
			if (err != nil) != tt.wantErr {
				t.Errorf("Unmarshal() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr && !tt.checkVal(&cond) {
				t.Errorf("Condition values don't match expected")
			}

			// Test round-trip
			data, err := json.Marshal(&cond)
			if err != nil {
				t.Errorf("Marshal() error = %v", err)
				return
			}

			var cond2 Condition
			err = json.Unmarshal(data, &cond2)
			if err != nil {
				t.Errorf("Unmarshal() round-trip error = %v", err)
				return
			}
		})
	}
}

func TestLogicalOperatorMarshalUnmarshal(t *testing.T) {
	jsonStr := `{
		"op": "and",
		"vars": [
			{"type": "form", "value": "survey-123"},
			{"type": "state", "value": "WAITING"}
		]
	}`

	var cond Condition
	err := json.Unmarshal([]byte(jsonStr), &cond)
	if err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}

	if !cond.IsOperator() {
		t.Error("Expected logical operator, got simple condition")
	}

	op := cond.GetOperator()
	if op.Op != "and" {
		t.Errorf("Expected op = 'and', got %s", op.Op)
	}

	if len(op.Vars) != 2 {
		t.Errorf("Expected 2 conditions, got %d", len(op.Vars))
	}

	// Test round-trip
	data, err := json.Marshal(&cond)
	if err != nil {
		t.Errorf("Marshal() error = %v", err)
		return
	}

	var cond2 Condition
	err = json.Unmarshal(data, &cond2)
	if err != nil {
		t.Errorf("Unmarshal() round-trip error = %v", err)
	}
}

func TestNestedLogicalOperators(t *testing.T) {
	jsonStr := `{
		"op": "or",
		"vars": [
			{
				"op": "and",
				"vars": [
					{"type": "form", "value": "survey-123"},
					{"type": "state", "value": "WAITING"}
				]
			},
			{"type": "error_code", "value": "TIMEOUT"}
		]
	}`

	var cond Condition
	err := json.Unmarshal([]byte(jsonStr), &cond)
	if err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}

	if !cond.IsOperator() {
		t.Error("Expected logical operator")
	}

	op := cond.GetOperator()
	if op.Op != "or" {
		t.Errorf("Expected op = 'or', got %s", op.Op)
	}

	if len(op.Vars) != 2 {
		t.Errorf("Expected 2 conditions, got %d", len(op.Vars))
	}

	// First condition should be an "and" operator
	if !op.Vars[0].IsOperator() {
		t.Error("Expected first condition to be an operator")
	}

	// Second condition should be a simple condition
	if !op.Vars[1].IsSimple() {
		t.Error("Expected second condition to be simple")
	}
}

func TestBailDefinitionMarshalUnmarshal(t *testing.T) {
	jsonStr := `{
		"conditions": {
			"type": "state",
			"value": "WAITING"
		},
		"execution": {
			"timing": "immediate"
		},
		"action": {
			"destination_form": "exit-survey",
			"metadata": {
				"reason": "timeout"
			}
		}
	}`

	var def BailDefinition
	err := json.Unmarshal([]byte(jsonStr), &def)
	if err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}

	if err := def.Validate(); err != nil {
		t.Errorf("Validate() error = %v", err)
	}

	if def.Execution.Timing != "immediate" {
		t.Errorf("Expected timing = 'immediate', got %s", def.Execution.Timing)
	}

	if def.Action.DestinationForm != "exit-survey" {
		t.Errorf("Expected destination_form = 'exit-survey', got %s", def.Action.DestinationForm)
	}

	// Test round-trip
	data, err := json.Marshal(&def)
	if err != nil {
		t.Errorf("Marshal() error = %v", err)
		return
	}

	var def2 BailDefinition
	err = json.Unmarshal(data, &def2)
	if err != nil {
		t.Errorf("Unmarshal() round-trip error = %v", err)
	}
}

func TestExecutionValidation(t *testing.T) {
	tests := []struct {
		name    string
		exec    Execution
		wantErr bool
	}{
		{
			name: "immediate timing - valid",
			exec: Execution{
				Timing: "immediate",
			},
			wantErr: false,
		},
		{
			name: "scheduled timing - valid",
			exec: Execution{
				Timing:    "scheduled",
				TimeOfDay: strPtr("09:00"),
				Timezone:  strPtr("UTC"),
			},
			wantErr: false,
		},
		{
			name: "scheduled timing - missing time_of_day",
			exec: Execution{
				Timing:   "scheduled",
				Timezone: strPtr("UTC"),
			},
			wantErr: true,
		},
		{
			name: "absolute timing - valid",
			exec: Execution{
				Timing:   "absolute",
				Datetime: strPtr("2025-12-15T10:00:00Z"),
			},
			wantErr: false,
		},
		{
			name: "invalid timing type",
			exec: Execution{
				Timing: "invalid",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.exec.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestBailValidation(t *testing.T) {
	userID := uuid.New()

	tests := []struct {
		name    string
		bail    Bail
		wantErr bool
	}{
		{
			name: "valid bail",
			bail: Bail{
				UserID:          userID,
				Name:            "timeout-bail",
				DestinationForm: "exit-survey",
				Definition: BailDefinition{
					Conditions: &Condition{
						simple: &SimpleCondition{
							Type:  "state",
							Value: strPtr("WAITING"),
						},
					},
					Execution: Execution{
						Timing: "immediate",
					},
					Action: Action{
						DestinationForm: "exit-survey",
					},
				},
			},
			wantErr: false,
		},
		{
			name: "missing user_id",
			bail: Bail{
				Name:            "timeout-bail",
				DestinationForm: "exit-survey",
				Definition: BailDefinition{
					Conditions: &Condition{
						simple: &SimpleCondition{
							Type:  "state",
							Value: strPtr("WAITING"),
						},
					},
					Execution: Execution{
						Timing: "immediate",
					},
					Action: Action{
						DestinationForm: "exit-survey",
					},
				},
			},
			wantErr: true,
		},
		{
			name: "destination_form mismatch",
			bail: Bail{
				UserID:          userID,
				Name:            "timeout-bail",
				DestinationForm: "exit-survey",
				Definition: BailDefinition{
					Conditions: &Condition{
						simple: &SimpleCondition{
							Type:  "state",
							Value: strPtr("WAITING"),
						},
					},
					Execution: Execution{
						Timing: "immediate",
					},
					Action: Action{
						DestinationForm: "different-survey",
					},
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.bail.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestBailEventValidation(t *testing.T) {
	userID := uuid.New()
	bailID := uuid.New()

	tests := []struct {
		name    string
		event   BailEvent
		wantErr bool
	}{
		{
			name: "valid execution event",
			event: BailEvent{
				BailID:       &bailID,
				UserID:     userID,
				BailName:     "timeout-bail",
				EventType:    "execution",
				Timestamp:    time.Now(),
				UsersMatched: 10,
				UsersBailed:  8,
				DefinitionSnapshot: BailDefinition{
					Conditions: &Condition{
						simple: &SimpleCondition{
							Type:  "state",
							Value: strPtr("WAITING"),
						},
					},
					Execution: Execution{
						Timing: "immediate",
					},
					Action: Action{
						DestinationForm: "exit-survey",
					},
				},
			},
			wantErr: false,
		},
		{
			name: "invalid event type",
			event: BailEvent{
				BailID:       &bailID,
				UserID:     userID,
				BailName:     "timeout-bail",
				EventType:    "invalid",
				Timestamp:    time.Now(),
				UsersMatched: 10,
				UsersBailed:  8,
				DefinitionSnapshot: BailDefinition{
					Conditions: &Condition{
						simple: &SimpleCondition{
							Type:  "state",
							Value: strPtr("WAITING"),
						},
					},
					Execution: Execution{
						Timing: "immediate",
					},
					Action: Action{
						DestinationForm: "exit-survey",
					},
				},
			},
			wantErr: true,
		},
		{
			name: "users_bailed exceeds users_matched",
			event: BailEvent{
				BailID:       &bailID,
				UserID:     userID,
				BailName:     "timeout-bail",
				EventType:    "execution",
				Timestamp:    time.Now(),
				UsersMatched: 5,
				UsersBailed:  10,
				DefinitionSnapshot: BailDefinition{
					Conditions: &Condition{
						simple: &SimpleCondition{
							Type:  "state",
							Value: strPtr("WAITING"),
						},
					},
					Execution: Execution{
						Timing: "immediate",
					},
					Action: Action{
						DestinationForm: "exit-survey",
					},
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.event.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// Helper function to create string pointers
func strPtr(s string) *string {
	return &s
}

func TestSimpleConditionValidation(t *testing.T) {
	tests := []struct {
		name    string
		jsonStr string
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid question_response with all three fields",
			jsonStr: `{"type": "question_response", "form": "myform", "question_ref": "q1", "response": "yes"}`,
			wantErr: false,
		},
		{
			name:    "valid question_response with only form and question_ref",
			jsonStr: `{"type": "question_response", "form": "myform", "question_ref": "q1"}`,
			wantErr: false,
		},
		{
			name:    "invalid question_response missing form",
			jsonStr: `{"type": "question_response", "question_ref": "q1", "response": "yes"}`,
			wantErr: true,
			errMsg:  "question_response condition requires 'form' field",
		},
		{
			name:    "invalid question_response missing question_ref",
			jsonStr: `{"type": "question_response", "form": "myform", "response": "yes"}`,
			wantErr: true,
			errMsg:  "question_response condition requires 'question_ref' field",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var cond Condition
			err := json.Unmarshal([]byte(tt.jsonStr), &cond)
			if err != nil {
				t.Fatalf("Unmarshal() error = %v", err)
			}
			err = cond.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr && err != nil && tt.errMsg != "" {
				if !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("Expected error containing %q, got %q", tt.errMsg, err.Error())
				}
			}
		})
	}
}

func TestSurveyIDConditionValidation(t *testing.T) {
	tests := []struct {
		name    string
		jsonStr string
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid surveyid with non-empty value",
			jsonStr: `{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}`,
			wantErr: false,
		},
		{
			name:    "invalid surveyid with empty value",
			jsonStr: `{"type": "surveyid", "value": ""}`,
			wantErr: true,
			errMsg:  "value is required for surveyid condition",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var cond Condition
			err := json.Unmarshal([]byte(tt.jsonStr), &cond)
			if err != nil {
				t.Fatalf("Unmarshal() error = %v", err)
			}
			err = cond.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr && err != nil && tt.errMsg != "" {
				if !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("Expected error containing %q, got %q", tt.errMsg, err.Error())
				}
			}
		})
	}
}

func TestSurveyIDConditionMissingValue(t *testing.T) {
	// A surveyid condition with no value field at all (nil pointer) must fail validation.
	var cond Condition
	err := json.Unmarshal([]byte(`{"type": "surveyid"}`), &cond)
	if err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	err = cond.Validate()
	if err == nil {
		t.Error("Expected validation error for surveyid with nil value, got nil")
	}
	if !strings.Contains(err.Error(), "value is required for surveyid condition") {
		t.Errorf("Unexpected error message: %q", err.Error())
	}
}

func TestNotOperatorValidation(t *testing.T) {
	tests := []struct {
		name    string
		jsonStr string
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid not with simple condition",
			jsonStr: `{"op": "not", "vars": [{"type": "form", "value": "myform"}]}`,
			wantErr: false,
		},
		{
			name:    "valid not with and group",
			jsonStr: `{"op": "not", "vars": [{"op": "and", "vars": [{"type": "form", "value": "f"}, {"type": "state", "value": "END"}]}]}`,
			wantErr: false,
		},
		{
			name:    "valid not with surveyid",
			jsonStr: `{"op": "not", "vars": [{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}]}`,
			wantErr: false,
		},
		{
			name:    "invalid not with zero children",
			jsonStr: `{"op": "not", "vars": []}`,
			wantErr: true,
			errMsg:  "not operator must have exactly one condition",
		},
		{
			name:    "invalid not with two children",
			jsonStr: `{"op": "not", "vars": [{"type": "form", "value": "f1"}, {"type": "form", "value": "f2"}]}`,
			wantErr: true,
			errMsg:  "not operator must have exactly one condition",
		},
		{
			name:    "invalid not with elapsed_time",
			jsonStr: `{"op": "not", "vars": [{"type": "elapsed_time", "since": {"event": "response", "details": {"question_ref": "q1", "form": "f1"}}, "duration": "4 weeks"}]}`,
			wantErr: true,
			errMsg:  "not operator cannot negate elapsed_time",
		},
		{
			name:    "invalid not with nested elapsed_time",
			jsonStr: `{"op": "not", "vars": [{"op": "and", "vars": [{"type": "form", "value": "f"}, {"type": "elapsed_time", "since": {"event": "response", "details": {"question_ref": "q1", "form": "f1"}}, "duration": "1 week"}]}]}`,
			wantErr: true,
			errMsg:  "not operator cannot negate elapsed_time",
		},
		{
			name:    "invalid not with question_response",
			jsonStr: `{"op": "not", "vars": [{"type": "question_response", "form": "myform", "question_ref": "q1"}]}`,
			wantErr: true,
			errMsg:  "not operator cannot negate",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var cond Condition
			err := json.Unmarshal([]byte(tt.jsonStr), &cond)
			if err != nil {
				t.Fatalf("Unmarshal() error = %v", err)
			}
			err = cond.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr && err != nil && tt.errMsg != "" {
				if !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("Expected error containing %q, got %q", tt.errMsg, err.Error())
				}
			}
		})
	}
}

func TestUserListValidation(t *testing.T) {
	tests := []struct {
		name    string
		ul      UserList
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid user list - single user",
			ul: UserList{
				Users: []UserListEntry{
					{UserID: "user1", PageID: "page1", Shortcode: "exit-survey"},
				},
			},
			wantErr: false,
		},
		{
			name: "valid user list - multiple users",
			ul: UserList{
				Users: []UserListEntry{
					{UserID: "user1", PageID: "page1", Shortcode: "form1"},
					{UserID: "user2", PageID: "page2", Shortcode: "form2"},
					{UserID: "user3", PageID: "page3", Shortcode: "form3"},
				},
			},
			wantErr: false,
		},
		{
			name:    "empty user list",
			ul:      UserList{Users: []UserListEntry{}},
			wantErr: true,
			errMsg:  "user_list must contain at least one user",
		},
		{
			name:    "user list exceeds max 1000",
			ul:      UserList{Users: make([]UserListEntry, 1001)},
			wantErr: true,
			errMsg:  "user_list must contain at most 1000 users",
		},
		{
			name: "missing userid at index 0",
			ul: UserList{
				Users: []UserListEntry{
					{UserID: "", PageID: "page1", Shortcode: "form1"},
				},
			},
			wantErr: true,
			errMsg:  "userid is required at index 0",
		},
		{
			name: "missing pageid at index 1",
			ul: UserList{
				Users: []UserListEntry{
					{UserID: "user1", PageID: "page1", Shortcode: "form1"},
					{UserID: "user2", PageID: "", Shortcode: "form2"},
				},
			},
			wantErr: true,
			errMsg:  "pageid is required at index 1",
		},
		{
			name: "missing shortcode at index 2",
			ul: UserList{
				Users: []UserListEntry{
					{UserID: "user1", PageID: "page1", Shortcode: "form1"},
					{UserID: "user2", PageID: "page2", Shortcode: "form2"},
					{UserID: "user3", PageID: "page3", Shortcode: ""},
				},
			},
			wantErr: true,
			errMsg:  "shortcode is required at index 2",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.ul.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr && err != nil && tt.errMsg != "" {
				if !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("Expected error containing %q, got %q", tt.errMsg, err.Error())
				}
			}
		})
	}
}

func TestBailDefinitionValidation_UserListType(t *testing.T) {
	tests := []struct {
		name    string
		def     BailDefinition
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid user_list definition",
			def: BailDefinition{
				Type: "user_list",
				UserList: &UserList{
					Users: []UserListEntry{
						{UserID: "user1", PageID: "page1", Shortcode: "form1"},
						{UserID: "user2", PageID: "page2", Shortcode: "form2"},
					},
				},
				Execution: Execution{
					Timing: "immediate",
				},
				Action: Action{
					DestinationForm: "form1",
				},
			},
			wantErr: false,
		},
		{
			name: "user_list type but missing user_list field",
			def: BailDefinition{
				Type:     "user_list",
				UserList: nil,
				Execution: Execution{
					Timing: "immediate",
				},
				Action: Action{
					DestinationForm: "form1",
				},
			},
			wantErr: true,
			errMsg:  "user_list is required for user_list-type bail",
		},
		{
			name: "conditions type still works",
			def: BailDefinition{
				Type: "conditions",
				Conditions: &Condition{
					simple: &SimpleCondition{
						Type:  "state",
						Value: strPtr("WAITING"),
					},
				},
				Execution: Execution{
					Timing: "immediate",
				},
				Action: Action{
					DestinationForm: "exit-survey",
				},
			},
			wantErr: false,
		},
		{
			name: "conditions type missing conditions",
			def: BailDefinition{
				Type:       "conditions",
				Conditions: nil,
				Execution: Execution{
					Timing: "immediate",
				},
				Action: Action{
					DestinationForm: "exit-survey",
				},
			},
			wantErr: true,
			errMsg:  "conditions are required for conditions-type bail",
		},
		{
			name: "invalid bail type",
			def: BailDefinition{
				Type: "invalid_type",
				Conditions: &Condition{
					simple: &SimpleCondition{
						Type:  "state",
						Value: strPtr("WAITING"),
					},
				},
				Execution: Execution{
					Timing: "immediate",
				},
				Action: Action{
					DestinationForm: "exit-survey",
				},
			},
			wantErr: true,
			errMsg:  "invalid bail type",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.def.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr && err != nil && tt.errMsg != "" {
				if !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("Expected error containing %q, got %q", tt.errMsg, err.Error())
				}
			}
		})
	}
}

func TestBailDefinitionValidation_BackwardCompat(t *testing.T) {
	jsonStr := `{
		"conditions": {
			"type": "state",
			"value": "WAITING"
		},
		"execution": {
			"timing": "immediate"
		},
		"action": {
			"destination_form": "exit-survey"
		}
	}`

	var def BailDefinition
	err := json.Unmarshal([]byte(jsonStr), &def)
	if err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}

	if def.Type != "" {
		t.Errorf("Expected Type to be empty string, got %q", def.Type)
	}

	if def.Conditions == nil {
		t.Error("Expected Conditions to be non-nil")
	}

	err = def.Validate()
	if err != nil {
		t.Errorf("Validate() error = %v, expected nil", err)
	}
}

func TestBailDefinitionMarshalUnmarshal_UserList(t *testing.T) {
	def := BailDefinition{
		Type: "user_list",
		UserList: &UserList{
			Users: []UserListEntry{
				{UserID: "user1", PageID: "page1", Shortcode: "form1"},
				{UserID: "user2", PageID: "page2", Shortcode: "form2"},
			},
		},
		Execution: Execution{
			Timing: "immediate",
		},
		Action: Action{
			DestinationForm: "form1",
		},
	}

	data, err := json.Marshal(&def)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	var def2 BailDefinition
	err = json.Unmarshal(data, &def2)
	if err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}

	if def2.Type != "user_list" {
		t.Errorf("Expected Type='user_list', got %q", def2.Type)
	}

	if def2.UserList == nil {
		t.Error("Expected UserList to be non-nil")
	} else if len(def2.UserList.Users) != 2 {
		t.Errorf("Expected 2 users, got %d", len(def2.UserList.Users))
	}
}

func TestBailValidation_UserListType(t *testing.T) {
	userID := uuid.New()

	tests := []struct {
		name    string
		bail    Bail
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid user_list bail",
			bail: Bail{
				UserID:          userID,
				Name:            "user-list-bail",
				DestinationForm: "form1",
				Definition: BailDefinition{
					Type: "user_list",
					UserList: &UserList{
						Users: []UserListEntry{
							{UserID: "user1", PageID: "page1", Shortcode: "form1"},
							{UserID: "user2", PageID: "page2", Shortcode: "form2"},
						},
					},
					Execution: Execution{
						Timing: "immediate",
					},
					Action: Action{
						DestinationForm: "form1",
					},
				},
			},
			wantErr: false,
		},
		{
			name: "user_list bail with mismatched destination_form",
			bail: Bail{
				UserID:          userID,
				Name:            "user-list-bail",
				DestinationForm: "form1",
				Definition: BailDefinition{
					Type: "user_list",
					UserList: &UserList{
						Users: []UserListEntry{
							{UserID: "user1", PageID: "page1", Shortcode: "form1"},
							{UserID: "user2", PageID: "page2", Shortcode: "form2"},
						},
					},
					Execution: Execution{
						Timing: "immediate",
					},
					Action: Action{
						DestinationForm: "different-form",
					},
				},
			},
			wantErr: false,
		},
		{
			name: "conditions bail with mismatched destination_form",
			bail: Bail{
				UserID:          userID,
				Name:            "conditions-bail",
				DestinationForm: "form1",
				Definition: BailDefinition{
					Type: "conditions",
					Conditions: &Condition{
						simple: &SimpleCondition{
							Type:  "state",
							Value: strPtr("WAITING"),
						},
					},
					Execution: Execution{
						Timing: "immediate",
					},
					Action: Action{
						DestinationForm: "different-form",
					},
				},
			},
			wantErr: true,
			errMsg:  "destination_form mismatch",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.bail.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr && err != nil && tt.errMsg != "" {
				if !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("Expected error containing %q, got %q", tt.errMsg, err.Error())
				}
			}
		})
	}
}
