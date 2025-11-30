package query

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/vlab-research/exodus/types"
)

// Example test showing how to use the query builder
func ExampleBuildQuery() {
	// Create a simple bail condition
	condJSON := `{
		"op": "and",
		"vars": [
			{"type": "form", "value": "survey-123"},
			{"type": "state", "value": "WAITING"}
		]
	}`

	var cond types.Condition
	json.Unmarshal([]byte(condJSON), &cond)

	def := &types.BailDefinition{
		Conditions: cond,
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	_, params, _ := BuildQuery(def)

	fmt.Printf("SQL generated with %d parameters\n", len(params))
	fmt.Printf("Parameters: %v\n", params)
	// Output:
	// SQL generated with 2 parameters
	// Parameters: [survey-123 WAITING]
}

// Test demonstrating the SQL structure for elapsed_time conditions
func TestQueryStructure_ElapsedTime(t *testing.T) {
	condJSON := `{
		"type": "elapsed_time",
		"duration": "7 days",
		"since": {
			"event": "response",
			"details": {
				"question_ref": "consent_question",
				"form": "consent_form"
			}
		}
	}`

	var cond types.Condition
	if err := json.Unmarshal([]byte(condJSON), &cond); err != nil {
		t.Fatal(err)
	}

	def := &types.BailDefinition{
		Conditions: cond,
		Execution:  types.Execution{Timing: "immediate"},
		Action:     types.Action{DestinationForm: "followup"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatal(err)
	}

	t.Logf("SQL for elapsed_time condition:\n%s", sql)
	t.Logf("Parameters: %v", params)

	// Verify key components
	if len(params) != 3 {
		t.Errorf("Expected 3 parameters, got %d", len(params))
	}

	// Check CTE is created
	if !containsSubstring(sql, "WITH response_times_0 AS") {
		t.Error("Missing CTE for response times")
	}

	// Check JOIN clause
	if !containsSubstring(sql, "JOIN response_times_0") {
		t.Error("Missing JOIN for CTE")
	}

	// Check interval comparison
	if !containsSubstring(sql, "INTERVAL < NOW()") {
		t.Error("Missing interval comparison")
	}
}

func containsSubstring(s, substr string) bool {
	return len(s) >= len(substr) && findSubstring(s, substr)
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
