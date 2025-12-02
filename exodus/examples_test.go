package main

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/vlab-research/exodus/types"
)

func TestExamplesJSONParsing(t *testing.T) {
	// Read the examples.json file
	data, err := os.ReadFile("examples.json")
	if err != nil {
		t.Fatalf("Failed to read examples.json: %v", err)
	}

	// Parse as a map of example names to definitions
	var examples map[string]json.RawMessage
	err = json.Unmarshal(data, &examples)
	if err != nil {
		t.Fatalf("Failed to parse examples.json: %v", err)
	}

	testCases := []string{
		"simple_bail_example",
		"complex_bail_with_and",
		"complex_bail_with_nested_logic",
		"elapsed_time_bail",
	}

	for _, name := range testCases {
		t.Run(name, func(t *testing.T) {
			exampleData, ok := examples[name]
			if !ok {
				t.Fatalf("Example %s not found in examples.json", name)
			}

			// Parse the definition field
			var exampleStruct struct {
				Name            string               `json:"name"`
				Description     string               `json:"description"`
				SurveyID        string               `json:"survey_id"`
				Enabled         bool                 `json:"enabled"`
				DestinationForm string               `json:"destination_form"`
				Definition      types.BailDefinition `json:"definition"`
			}

			err := json.Unmarshal(exampleData, &exampleStruct)
			if err != nil {
				t.Fatalf("Failed to parse example %s: %v", name, err)
			}

			// Debug the initial unmarshal
			t.Logf("After initial unmarshal - IsSimple: %v, IsOperator: %v", exampleStruct.Definition.Conditions.IsSimple(), exampleStruct.Definition.Conditions.IsOperator())
			if exampleStruct.Definition.Conditions.IsSimple() {
				simple := exampleStruct.Definition.Conditions.GetSimple()
				t.Logf("Initial simple condition type: '%s'", simple.Type)
				if simple.Value != nil {
					t.Logf("Initial simple value: '%s'", *simple.Value)
				}
			}

			// Validate the definition
			err = exampleStruct.Definition.Validate()
			if err != nil {
				t.Errorf("Example %s failed validation: %v", name, err)
			}

			// Test round-trip
			defData, err := json.Marshal(exampleStruct.Definition)
			if err != nil {
				t.Errorf("Failed to marshal definition: %v", err)
			}

			t.Logf("Marshaled definition: %s", string(defData))

			var def2 types.BailDefinition
			err = json.Unmarshal(defData, &def2)
			if err != nil {
				t.Errorf("Failed to unmarshal round-trip: %v", err)
			}

			t.Logf("After unmarshal - IsSimple: %v, IsOperator: %v", def2.Conditions.IsSimple(), def2.Conditions.IsOperator())
			if def2.Conditions.IsSimple() {
				simple := def2.Conditions.GetSimple()
				t.Logf("Simple condition type: '%s'", simple.Type)
			}

			err = def2.Validate()
			if err != nil {
				t.Errorf("Round-trip definition failed validation: %v", err)
			}
		})
	}
}

func TestExamplesPrettyPrint(t *testing.T) {
	// This test just ensures we can pretty-print the examples
	data, err := os.ReadFile("examples.json")
	if err != nil {
		t.Skip("examples.json not found, skipping")
	}

	var examples map[string]json.RawMessage
	err = json.Unmarshal(data, &examples)
	if err != nil {
		t.Fatalf("Failed to parse examples.json: %v", err)
	}

	// Just log the keys to show we can iterate
	t.Logf("Found %d examples", len(examples))
	for key := range examples {
		t.Logf("  - %s", key)
	}
}
