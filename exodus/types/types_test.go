package types

import (
	"encoding/json"
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
					Conditions: Condition{
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
					Conditions: Condition{
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
					Conditions: Condition{
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
					Conditions: Condition{
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
					Conditions: Condition{
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
					Conditions: Condition{
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
