package query

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/vlab-research/exodus/types"
)

// Helper function to create string pointer
func strPtr(s string) *string {
	return &s
}

// Helper function to create a condition from JSON
func conditionFromJSON(jsonStr string) types.Condition {
	var cond types.Condition
	if err := json.Unmarshal([]byte(jsonStr), &cond); err != nil {
		panic(err)
	}
	return cond
}

func TestBuildQuery_SimpleFormCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "form", "value": "myform"}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	// Verify SQL structure
	if !strings.Contains(sql, "SELECT DISTINCT s.userid, s.pageid") {
		t.Error("SQL missing SELECT clause")
	}
	if !strings.Contains(sql, "FROM states s") {
		t.Error("SQL missing FROM clause")
	}
	if !strings.Contains(sql, "WHERE s.current_form = $1") {
		t.Errorf("SQL missing correct WHERE clause, got: %s", sql)
	}
	if !strings.Contains(sql, "LIMIT 100000") {
		t.Error("SQL missing LIMIT clause")
	}

	// Verify parameters: $1=myform
	if len(params) != 1 {
		t.Errorf("Expected 1 parameter, got %d", len(params))
	}
	if params[0] != "myform" {
		t.Errorf("Expected parameter 'myform', got %v", params[0])
	}
}

func TestBuildQuery_SimpleStateCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "state", "value": "WAIT_EXTERNAL_EVENT"}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "s.current_state = $1") {
		t.Errorf("SQL missing state condition, got: %s", sql)
	}

	if len(params) != 1 || params[0] != "WAIT_EXTERNAL_EVENT" {
		t.Errorf("Incorrect parameters: %v", params)
	}
}

func TestBuildQuery_ErrorCodeCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "error_code", "value": "TIMEOUT"}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "s.state_json->'error'->>'code' = $1") {
		t.Errorf("SQL missing error_code condition, got: %s", sql)
	}

	if len(params) != 1 || params[0] != "TIMEOUT" {
		t.Errorf("Incorrect parameters: %v", params)
	}
}

func TestBuildQuery_CurrentQuestionCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "current_question", "value": "consent"}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "s.state_json->>'question' = $1") {
		t.Errorf("SQL missing current_question condition, got: %s", sql)
	}

	if len(params) != 1 || params[0] != "consent" {
		t.Errorf("Incorrect parameters: %v", params)
	}
}

func TestBuildQuery_ANDCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "and",
			"vars": [
				{"type": "form", "value": "myform"},
				{"type": "state", "value": "WAIT_EXTERNAL_EVENT"}
			]
		}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "AND") {
		t.Error("SQL missing AND operator")
	}

	// $1=myform, $2=WAIT_EXTERNAL_EVENT
	if !strings.Contains(sql, "s.current_form = $1") {
		t.Errorf("SQL missing form condition, got: %s", sql)
	}
	if !strings.Contains(sql, "s.current_state = $2") {
		t.Errorf("SQL missing state condition, got: %s", sql)
	}

	if len(params) != 2 {
		t.Fatalf("Expected 2 parameters, got %d", len(params))
	}
	if params[0] != "myform" {
		t.Errorf("Expected params[0]='myform', got %v", params[0])
	}
	if params[1] != "WAIT_EXTERNAL_EVENT" {
		t.Errorf("Expected params[1]='WAIT_EXTERNAL_EVENT', got %v", params[1])
	}
}

func TestBuildQuery_ORCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "or",
			"vars": [
				{"type": "form", "value": "form1"},
				{"type": "form", "value": "form2"}
			]
		}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "OR") {
		t.Error("SQL missing OR operator")
	}

	if !strings.Contains(sql, "s.current_form = $1") {
		t.Errorf("SQL missing first form condition, got: %s", sql)
	}
	if !strings.Contains(sql, "s.current_form = $2") {
		t.Errorf("SQL missing second form condition, got: %s", sql)
	}

	if len(params) != 2 || params[0] != "form1" || params[1] != "form2" {
		t.Errorf("Incorrect parameters: %v", params)
	}
}

func TestBuildQuery_NestedLogicalOperators(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "or",
			"vars": [
				{
					"op": "and",
					"vars": [
						{"type": "form", "value": "formA"},
						{"type": "state", "value": "stateB"}
					]
				},
				{"type": "error_code", "value": "errorC"}
			]
		}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "((") {
		t.Error("SQL missing nested parentheses")
	}
	if !strings.Contains(sql, "AND") || !strings.Contains(sql, "OR") {
		t.Error("SQL missing both AND and OR operators")
	}

	// $1=formA, $2=stateB, $3=errorC
	if !strings.Contains(sql, "s.current_form = $1") {
		t.Errorf("SQL missing form condition, got: %s", sql)
	}
	if !strings.Contains(sql, "s.current_state = $2") {
		t.Errorf("SQL missing state condition, got: %s", sql)
	}
	if !strings.Contains(sql, "s.state_json->'error'->>'code' = $3") {
		t.Errorf("SQL missing error_code condition, got: %s", sql)
	}

	if len(params) != 3 {
		t.Fatalf("Expected 3 parameters, got %d", len(params))
	}
	if params[0] != "formA" || params[1] != "stateB" || params[2] != "errorC" {
		t.Errorf("Incorrect parameters: %v", params)
	}
}

func TestBuildQuery_ElapsedTimeCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"type": "elapsed_time",
			"duration": "4 weeks",
			"since": {
				"event": "response",
				"details": {
					"question_ref": "q1",
					"form": "myform"
				}
			}
		}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "WITH response_times_0 AS") {
		t.Error("SQL missing CTE for response times")
	}
	if !strings.Contains(sql, "SELECT userid, MIN(timestamp) as response_time") {
		t.Error("CTE missing correct SELECT")
	}
	if !strings.Contains(sql, "FROM responses") {
		t.Error("CTE missing FROM responses")
	}
	// $1=myform (CTE), $2=q1 (CTE), $3=duration
	if !strings.Contains(sql, "WHERE shortcode = $1 AND question_ref = $2") {
		t.Errorf("CTE missing correct WHERE clause, got: %s", sql)
	}
	if !strings.Contains(sql, "GROUP BY userid") {
		t.Error("CTE missing GROUP BY")
	}
	if !strings.Contains(sql, "JOIN response_times_0 rt0 ON s.userid = rt0.userid") {
		t.Error("SQL missing JOIN for CTE")
	}
	if !strings.Contains(sql, "rt0.response_time + $3::INTERVAL < NOW()") {
		t.Errorf("SQL missing elapsed time condition, got: %s", sql)
	}

	if len(params) != 3 {
		t.Fatalf("Expected 3 parameters, got %d", len(params))
	}
	if params[0] != "myform" {
		t.Errorf("Expected params[0]='myform', got %v", params[0])
	}
	if params[1] != "q1" {
		t.Errorf("Expected params[1]='q1', got %v", params[1])
	}
	if params[2] != "4 weeks" {
		t.Errorf("Expected params[2]='4 weeks', got %v", params[2])
	}
}

func TestBuildQuery_ComplexWithElapsedTime(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "and",
			"vars": [
				{"type": "form", "value": "myform"},
				{"type": "state", "value": "WAIT_EXTERNAL_EVENT"},
				{
					"type": "elapsed_time",
					"duration": "4 weeks",
					"since": {
						"event": "response",
						"details": {
							"question_ref": "q1",
							"form": "myform"
						}
					}
				}
			]
		}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "WITH response_times_0 AS") {
		t.Error("SQL missing CTE")
	}
	if !strings.Contains(sql, "JOIN response_times_0 rt0") {
		t.Error("SQL missing CTE JOIN")
	}

	// $1=myform (WHERE), $2=WAIT (WHERE), $3=myform (CTE), $4=q1 (CTE), $5=duration
	if !strings.Contains(sql, "s.current_form = $1") {
		t.Errorf("SQL missing form condition, got: %s", sql)
	}
	if !strings.Contains(sql, "s.current_state = $2") {
		t.Errorf("SQL missing state condition, got: %s", sql)
	}
	if !strings.Contains(sql, "rt0.response_time + $5::INTERVAL < NOW()") {
		t.Errorf("SQL missing elapsed time condition, got: %s", sql)
	}

	andCount := strings.Count(sql, " AND ")
	if andCount < 2 {
		t.Errorf("Expected at least 2 AND operators in WHERE clause, found %d", andCount)
	}

	// $1=myform, $2=WAIT_EXTERNAL_EVENT, $3=myform(CTE), $4=q1, $5=4 weeks
	if len(params) != 5 {
		t.Fatalf("Expected 5 parameters, got %d", len(params))
	}
	if params[0] != "myform" {
		t.Errorf("Expected params[0]='myform', got %v", params[0])
	}
	if params[1] != "WAIT_EXTERNAL_EVENT" {
		t.Errorf("Expected params[1]='WAIT_EXTERNAL_EVENT', got %v", params[1])
	}
	if params[2] != "myform" {
		t.Errorf("Expected params[2]='myform', got %v", params[2])
	}
	if params[3] != "q1" {
		t.Errorf("Expected params[3]='q1', got %v", params[3])
	}
	if params[4] != "4 weeks" {
		t.Errorf("Expected params[4]='4 weeks', got %v", params[4])
	}
}

func TestBuildQuery_MultipleElapsedTimeConditions(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "and",
			"vars": [
				{
					"type": "elapsed_time",
					"duration": "1 week",
					"since": {
						"event": "response",
						"details": {
							"question_ref": "q1",
							"form": "form1"
						}
					}
				},
				{
					"type": "elapsed_time",
					"duration": "2 weeks",
					"since": {
						"event": "response",
						"details": {
							"question_ref": "q2",
							"form": "form2"
						}
					}
				}
			]
		}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "response_times_0") {
		t.Error("SQL missing first CTE (response_times_0)")
	}
	if !strings.Contains(sql, "response_times_1") {
		t.Error("SQL missing second CTE (response_times_1)")
	}
	if !strings.Contains(sql, "JOIN response_times_0 rt0") {
		t.Error("SQL missing first JOIN")
	}
	if !strings.Contains(sql, "JOIN response_times_1 rt1") {
		t.Error("SQL missing second JOIN")
	}

	// $1=form1, $2=q1, $3=duration1, $4=form2, $5=q2, $6=duration2
	if !strings.Contains(sql, "rt0.response_time + $3::INTERVAL < NOW()") {
		t.Errorf("SQL missing first elapsed time condition, got: %s", sql)
	}
	if !strings.Contains(sql, "rt1.response_time + $6::INTERVAL < NOW()") {
		t.Errorf("SQL missing second elapsed time condition, got: %s", sql)
	}

	if len(params) != 6 {
		t.Fatalf("Expected 6 parameters, got %d", len(params))
	}
}

func TestValidateDuration(t *testing.T) {
	tests := []struct {
		duration string
		valid    bool
	}{
		{"4 weeks", true},
		{"2 days", true},
		{"1 hour", true},
		{"30 minutes", true},
		{"1 second", true},
		{"5 months", true},
		{"1 year", true},
		{"10 milliseconds", true},
		{"4weeks", false},        // missing space
		{"four weeks", false},    // not a number
		{"4 invalid", false},     // invalid unit
		{"", false},              // empty
		{"4", false},             // no unit
		{"weeks", false},         // no number
		{"-4 weeks", false},      // negative
		{"4.5 weeks", false},     // decimal not supported by simple regex
	}

	for _, tt := range tests {
		t.Run(tt.duration, func(t *testing.T) {
			err := validateDuration(tt.duration)
			if tt.valid && err != nil {
				t.Errorf("Expected valid duration %q, got error: %v", tt.duration, err)
			}
			if !tt.valid && err == nil {
				t.Errorf("Expected invalid duration %q, got no error", tt.duration)
			}
		})
	}
}

func TestSQLInjectionPrevention(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "form", "value": "'; DROP TABLE states; --"}`),
		Execution: types.Execution{
			Timing: "immediate",
		},
		Action: types.Action{
			DestinationForm: "exit-form",
		},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if strings.Contains(sql, "DROP TABLE") {
		t.Error("SQL injection detected: user value found in SQL string")
	}

	// params[0]=malicious value
	if len(params) != 1 || params[0] != "'; DROP TABLE states; --" {
		t.Error("Parameter not correctly captured")
	}

	if !strings.Contains(sql, "= $1") {
		t.Error("SQL should use parameterized query")
	}
}

func TestBuildQuery_NotSimpleCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"op": "not", "vars": [{"type": "state", "value": "END"}]}`),
		Execution:  types.Execution{Timing: "immediate"},
		Action:     types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "NOT (s.current_state = $1)") {
		t.Errorf("SQL missing NOT wrapper, got: %s", sql)
	}
	if len(params) != 1 || params[0] != "END" {
		t.Errorf("Incorrect parameters: %v", params)
	}
}

func TestBuildQuery_NotWrappingAndGroup(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "not",
			"vars": [{
				"op": "and",
				"vars": [
					{"type": "form", "value": "survey_v1"},
					{"type": "state", "value": "END"}
				]
			}]
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "NOT (") {
		t.Errorf("SQL missing NOT wrapper, got: %s", sql)
	}
	if !strings.Contains(sql, "AND") {
		t.Errorf("SQL missing AND inside NOT, got: %s", sql)
	}
	if len(params) != 2 {
		t.Fatalf("Expected 2 parameters, got %d", len(params))
	}
}

func TestBuildQuery_NotInsideAnd(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "and",
			"vars": [
				{"type": "form", "value": "myform"},
				{"op": "not", "vars": [{"type": "state", "value": "END"}]}
			]
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	if !strings.Contains(sql, "s.current_form = $1") {
		t.Errorf("SQL missing form condition, got: %s", sql)
	}
	if !strings.Contains(sql, "NOT (s.current_state = $2)") {
		t.Errorf("SQL missing NOT(state) condition, got: %s", sql)
	}
	if len(params) != 2 {
		t.Fatalf("Expected 2 parameters, got %d", len(params))
	}
}

func TestBuildQuery_QuestionResponseWithResponse(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "question_response", "form": "myform", "question_ref": "q1", "response": "yes"}`),
		Execution:  types.Execution{Timing: "immediate"},
		Action:     types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	// CTE should exist
	if !strings.Contains(sql, "question_responses_0") {
		t.Errorf("SQL missing CTE name 'question_responses_0', got: %s", sql)
	}
	// CTE WHERE clause must filter by shortcode, question_ref, and response
	if !strings.Contains(sql, "WHERE shortcode = $1 AND question_ref = $2 AND response = $3") {
		t.Errorf("CTE missing expected WHERE clause, got: %s", sql)
	}
	// Main WHERE references the CTE alias
	if !strings.Contains(sql, "qr0.userid IS NOT NULL") {
		t.Errorf("SQL missing 'qr0.userid IS NOT NULL', got: %s", sql)
	}
	// JOIN must link CTE to states table
	if !strings.Contains(sql, "JOIN question_responses_0 qr0 ON s.userid = qr0.userid") {
		t.Errorf("SQL missing JOIN clause, got: %s", sql)
	}

	// params: $1=myform, $2=q1, $3=yes
	if len(params) != 3 {
		t.Fatalf("Expected 3 parameters, got %d", len(params))
	}
	if params[0] != "myform" {
		t.Errorf("Expected params[0]='myform', got %v", params[0])
	}
	if params[1] != "q1" {
		t.Errorf("Expected params[1]='q1', got %v", params[1])
	}
	if params[2] != "yes" {
		t.Errorf("Expected params[2]='yes', got %v", params[2])
	}
}

func TestBuildQuery_QuestionResponseWithoutResponse(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "question_response", "form": "myform", "question_ref": "q1"}`),
		Execution:  types.Execution{Timing: "immediate"},
		Action:     types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	// CTE should exist
	if !strings.Contains(sql, "question_responses_0") {
		t.Errorf("SQL missing CTE name 'question_responses_0', got: %s", sql)
	}
	// CTE WHERE clause must filter by shortcode and question_ref only (no response)
	if !strings.Contains(sql, "WHERE shortcode = $1 AND question_ref = $2") {
		t.Errorf("CTE missing expected WHERE clause, got: %s", sql)
	}
	// Must NOT contain a response parameter filter in the CTE
	if strings.Contains(sql, "AND response = ") {
		t.Errorf("SQL should not contain 'AND response =' when response is absent, got: %s", sql)
	}
	// Main WHERE references the CTE alias
	if !strings.Contains(sql, "qr0.userid IS NOT NULL") {
		t.Errorf("SQL missing 'qr0.userid IS NOT NULL', got: %s", sql)
	}

	// params: $1=myform, $2=q1
	if len(params) != 2 {
		t.Fatalf("Expected 2 parameters, got %d", len(params))
	}
	if params[0] != "myform" {
		t.Errorf("Expected params[0]='myform', got %v", params[0])
	}
	if params[1] != "q1" {
		t.Errorf("Expected params[1]='q1', got %v", params[1])
	}
}

func TestBuildQuery_SurveyIDCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}`),
		Execution:  types.Execution{Timing: "immediate"},
		Action:     types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	// Verify the subquery pattern
	if !strings.Contains(sql, "s.current_form IN (SELECT shortcode FROM surveys WHERE id = $1)") {
		t.Errorf("SQL missing surveyid subquery condition, got: %s", sql)
	}

	// Should be a plain SELECT with no CTEs
	if strings.Contains(sql, "WITH ") {
		t.Errorf("surveyid condition should not generate any CTEs, got: %s", sql)
	}

	// Verify parameters: $1=survey UUID
	if len(params) != 1 {
		t.Fatalf("Expected 1 parameter, got %d", len(params))
	}
	if params[0] != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("Expected params[0]='550e8400-e29b-41d4-a716-446655440000', got %v", params[0])
	}
}

func TestBuildQuery_NotSurveyIDCondition(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{"op": "not", "vars": [{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}]}`),
		Execution:  types.Execution{Timing: "immediate"},
		Action:     types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	// Verify NOT wraps the subquery
	if !strings.Contains(sql, "NOT (s.current_form IN (SELECT shortcode FROM surveys WHERE id = $1))") {
		t.Errorf("SQL missing NOT wrapper around surveyid subquery, got: %s", sql)
	}

	if len(params) != 1 {
		t.Fatalf("Expected 1 parameter, got %d", len(params))
	}
	if params[0] != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("Expected params[0]='550e8400-e29b-41d4-a716-446655440000', got %v", params[0])
	}
}

func TestBuildQuery_SurveyIDInsideAnd(t *testing.T) {
	def := &types.BailDefinition{
		Conditions: conditionFromJSON(`{
			"op": "and",
			"vars": [
				{"type": "state", "value": "WAIT_EXTERNAL_EVENT"},
				{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}
			]
		}`),
		Execution: types.Execution{Timing: "immediate"},
		Action:    types.Action{DestinationForm: "exit-form"},
	}

	sql, params, err := BuildQuery(def)
	if err != nil {
		t.Fatalf("BuildQuery failed: %v", err)
	}

	// $1=state value, $2=survey UUID — parameter numbering must be correct
	if !strings.Contains(sql, "s.current_state = $1") {
		t.Errorf("SQL missing state condition at $1, got: %s", sql)
	}
	if !strings.Contains(sql, "s.current_form IN (SELECT shortcode FROM surveys WHERE id = $2)") {
		t.Errorf("SQL missing surveyid subquery at $2, got: %s", sql)
	}
	if !strings.Contains(sql, "AND") {
		t.Error("SQL missing AND operator")
	}

	if len(params) != 2 {
		t.Fatalf("Expected 2 parameters, got %d", len(params))
	}
	if params[0] != "WAIT_EXTERNAL_EVENT" {
		t.Errorf("Expected params[0]='WAIT_EXTERNAL_EVENT', got %v", params[0])
	}
	if params[1] != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("Expected params[1]='550e8400-e29b-41d4-a716-446655440000', got %v", params[1])
	}
}
