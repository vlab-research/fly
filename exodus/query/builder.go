package query

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/vlab-research/exodus/types"
)

// QueryBuilder tracks state while building SQL queries from bail conditions
type QueryBuilder struct {
	params       []interface{}      // Parameters for parameterized query ($1, $2, etc.)
	paramIndex   int                // Current parameter index
	ctes         []string           // Common Table Expressions (CTEs) to be prepended
	cteJoins     []string           // JOIN clauses for CTEs
	cteIndex     int                // Counter for unique CTE names
	queryLimit   int                // Maximum number of results to return
}

// NewQueryBuilder creates a new QueryBuilder with default settings
func NewQueryBuilder() *QueryBuilder {
	return &QueryBuilder{
		params:     make([]interface{}, 0),
		paramIndex: 1,
		ctes:       make([]string, 0),
		cteJoins:   make([]string, 0),
		cteIndex:   0,
		queryLimit: 100000, // Default limit for safety
	}
}

// BuildQuery generates SQL query and parameters from a BailDefinition
// Returns the complete SQL query string, parameters slice, and any error
func BuildQuery(def *types.BailDefinition) (string, []interface{}, error) {
	builder := NewQueryBuilder()

	// Build the WHERE clause from conditions
	whereClause, err := builder.buildCondition(&def.Conditions)
	if err != nil {
		return "", nil, fmt.Errorf("failed to build conditions: %w", err)
	}

	// Assemble the complete query
	var query strings.Builder

	// Add CTEs if any exist
	if len(builder.ctes) > 0 {
		query.WriteString("WITH ")
		query.WriteString(strings.Join(builder.ctes, ",\n"))
		query.WriteString("\n")
	}

	// Main SELECT statement
	query.WriteString("SELECT DISTINCT s.userid, s.pageid\nFROM states s")

	// Add CTE joins if any
	if len(builder.cteJoins) > 0 {
		query.WriteString("\n")
		query.WriteString(strings.Join(builder.cteJoins, "\n"))
	}

	// Add WHERE clause
	if whereClause != "" {
		query.WriteString("\nWHERE ")
		query.WriteString(whereClause)
	}

	// Add LIMIT for safety
	query.WriteString(fmt.Sprintf("\nLIMIT %d", builder.queryLimit))

	return query.String(), builder.params, nil
}

// buildCondition recursively builds SQL conditions from a Condition
func (qb *QueryBuilder) buildCondition(cond *types.Condition) (string, error) {
	if cond.IsSimple() {
		return qb.buildSimpleCondition(cond.GetSimple())
	}

	if cond.IsOperator() {
		return qb.buildLogicalOperator(cond.GetOperator())
	}

	return "", fmt.Errorf("invalid condition: neither simple nor operator")
}

// buildSimpleCondition handles individual condition types
func (qb *QueryBuilder) buildSimpleCondition(cond *types.SimpleCondition) (string, error) {
	switch cond.Type {
	case "form":
		return qb.buildFormCondition(cond)
	case "state":
		return qb.buildStateCondition(cond)
	case "error_code":
		return qb.buildErrorCodeCondition(cond)
	case "current_question":
		return qb.buildCurrentQuestionCondition(cond)
	case "elapsed_time":
		return qb.buildElapsedTimeCondition(cond)
	default:
		return "", fmt.Errorf("unsupported condition type: %s", cond.Type)
	}
}

// buildFormCondition creates SQL for form matching
func (qb *QueryBuilder) buildFormCondition(cond *types.SimpleCondition) (string, error) {
	if cond.Value == nil {
		return "", fmt.Errorf("value is required for form condition")
	}

	paramNum := qb.addParam(*cond.Value)
	return fmt.Sprintf("s.current_form = $%d", paramNum), nil
}

// buildStateCondition creates SQL for state matching
func (qb *QueryBuilder) buildStateCondition(cond *types.SimpleCondition) (string, error) {
	if cond.Value == nil {
		return "", fmt.Errorf("value is required for state condition")
	}

	paramNum := qb.addParam(*cond.Value)
	return fmt.Sprintf("s.current_state = $%d", paramNum), nil
}

// buildErrorCodeCondition creates SQL for error code matching in state_json
func (qb *QueryBuilder) buildErrorCodeCondition(cond *types.SimpleCondition) (string, error) {
	if cond.Value == nil {
		return "", fmt.Errorf("value is required for error_code condition")
	}

	paramNum := qb.addParam(*cond.Value)
	return fmt.Sprintf("s.state_json->'error'->>'code' = $%d", paramNum), nil
}

// buildCurrentQuestionCondition creates SQL for current question matching
func (qb *QueryBuilder) buildCurrentQuestionCondition(cond *types.SimpleCondition) (string, error) {
	if cond.Value == nil {
		return "", fmt.Errorf("value is required for current_question condition")
	}

	paramNum := qb.addParam(*cond.Value)
	return fmt.Sprintf("s.state_json->>'question' = $%d", paramNum), nil
}

// buildElapsedTimeCondition creates SQL for elapsed time conditions with CTEs
func (qb *QueryBuilder) buildElapsedTimeCondition(cond *types.SimpleCondition) (string, error) {
	if cond.Since == nil {
		return "", fmt.Errorf("since is required for elapsed_time condition")
	}
	if cond.Duration == nil {
		return "", fmt.Errorf("duration is required for elapsed_time condition")
	}

	// Validate duration format (e.g., "4 weeks", "2 days", "1 hour")
	if err := validateDuration(*cond.Duration); err != nil {
		return "", fmt.Errorf("invalid duration: %w", err)
	}

	// Currently only "response" event type is supported
	if cond.Since.Event != "response" {
		return "", fmt.Errorf("unsupported event type: %s", cond.Since.Event)
	}

	if cond.Since.Details == nil {
		return "", fmt.Errorf("details are required for response event")
	}

	// Create a unique CTE name for this elapsed_time condition
	cteName := fmt.Sprintf("response_times_%d", qb.cteIndex)
	qb.cteIndex++

	// Add parameters for the CTE
	formParam := qb.addParam(cond.Since.Details.Form)
	questionParam := qb.addParam(cond.Since.Details.QuestionRef)
	durationParam := qb.addParam(*cond.Duration)

	// Build the CTE for response times
	cte := fmt.Sprintf(`%s AS (
    SELECT userid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
    GROUP BY userid
)`, cteName, formParam, questionParam)

	qb.ctes = append(qb.ctes, cte)

	// Add JOIN clause for this CTE
	joinClause := fmt.Sprintf("JOIN %s rt%d ON s.userid = rt%d.userid",
		cteName, qb.cteIndex-1, qb.cteIndex-1)
	qb.cteJoins = append(qb.cteJoins, joinClause)

	// Return the WHERE condition using this CTE
	return fmt.Sprintf("rt%d.response_time + $%d::INTERVAL < NOW()",
		qb.cteIndex-1, durationParam), nil
}

// buildLogicalOperator handles AND/OR operations recursively
func (qb *QueryBuilder) buildLogicalOperator(op *types.LogicalOperator) (string, error) {
	if len(op.Vars) == 0 {
		return "", fmt.Errorf("logical operator must have at least one condition")
	}

	// Build each sub-condition
	var conditions []string
	for i, cond := range op.Vars {
		subCondition, err := qb.buildCondition(&cond)
		if err != nil {
			return "", fmt.Errorf("failed to build condition at index %d: %w", i, err)
		}
		conditions = append(conditions, subCondition)
	}

	// Join with appropriate operator
	var sqlOp string
	switch strings.ToLower(op.Op) {
	case "and":
		sqlOp = " AND "
	case "or":
		sqlOp = " OR "
	default:
		return "", fmt.Errorf("unsupported logical operator: %s", op.Op)
	}

	// Wrap in parentheses for proper precedence
	return "(" + strings.Join(conditions, sqlOp) + ")", nil
}

// addParam adds a parameter and returns its index
func (qb *QueryBuilder) addParam(value interface{}) int {
	qb.params = append(qb.params, value)
	idx := qb.paramIndex
	qb.paramIndex++
	return idx
}

// validateDuration checks if duration string is in valid PostgreSQL interval format
// Accepts formats like: "4 weeks", "2 days", "1 hour", "30 minutes"
func validateDuration(duration string) error {
	// PostgreSQL interval format: number + space + unit
	// Common units: microseconds, milliseconds, second, minute, hour, day, week, month, year
	// Plural forms also accepted
	validPattern := regexp.MustCompile(`^\d+\s+(microseconds?|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)$`)

	if !validPattern.MatchString(duration) {
		return fmt.Errorf("duration must be in format '<number> <unit>' (e.g., '4 weeks', '2 days')")
	}

	return nil
}
