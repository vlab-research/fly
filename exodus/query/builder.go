package query

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/vlab-research/exodus/types"
)

// QueryBuilder tracks state while building SQL queries from bail conditions
type QueryBuilder struct {
	params     []interface{} // Parameters for parameterized query ($1, $2, etc.)
	paramIndex int           // Current parameter index
	ctes       []string      // Common Table Expressions (CTEs) to be prepended
	cteJoins   []string      // JOIN clauses for CTEs
	cteIndex   int           // Counter for unique CTE names
	queryLimit int           // Maximum number of results to return
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
	whereClause, err := builder.buildCondition(def.Conditions)
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

	// Main SELECT statement.
	//
	// A conversation is (platform, account, user), so the bail event has to carry
	// all three. Selecting only (userid, pageid) left conditions-based bails
	// posting an empty platform, while user_list bails -- whose platform comes
	// from the caller's definition -- carried one. Half a contract.
	//
	// Three things about this expression are load-bearing:
	//
	//   1. `AS platform` is required, not cosmetic. executor.go looks the value up
	//      as row["platform"]; an unaliased COALESCE lands under the key
	//      "coalesce", the lookup misses, and the platform silently stays empty --
	//      the fix would appear to ship and do nothing.
	//   2. COALESCE, not a bare s.platform. states.platform is a computed column
	//      over state_json->'md'->>'platform' and is NULL for every row predating
	//      that persistence -- 1,068,371 of 1,092,078 rows in production (97.8%).
	//      A bare column would leave those targets with an empty platform AND log
	//      "Invalid platform type in query result: <nil>" once per target, because
	//      executor.go type-asserts to string. Defaulting to 'messenger' is the
	//      consumer contract migration 21 documents, and it is exact: every
	//      states row on a whatsapp_business account carries platform='whatsapp'
	//      (verified in production), so all NULLs are Messenger.
	//   3. Adding a column to a SELECT DISTINCT normally risks splitting groups
	//      and bailing a participant twice. It cannot here: states is
	//      PRIMARY KEY (userid, pageid) -- verified in production, 1,092,078 rows
	//      and 1,092,078 distinct pairs -- so platform is functionally dependent
	//      on the DISTINCT key and cannot subdivide it. Safe by construction, not
	//      by the data happening to be clean.
	query.WriteString("SELECT DISTINCT s.userid, s.pageid, COALESCE(s.platform, 'messenger') AS platform\nFROM states s")

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
	case "question_response":
		return qb.buildQuestionResponseCondition(cond)
	case "surveyid":
		return qb.buildSurveyIDCondition(cond)
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

	// Build the CTE for response times, aggregated per conversation.
	// A conversation is (platform, account, user) — `pageid` is the legacy column
	// name for the account — so response times must be grouped per account, never
	// across all of them. Grouping by userid alone would let a response on one
	// messaging account set the elapsed-time clock for a different account.
	cte := fmt.Sprintf(`%s AS (
    SELECT userid, pageid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
    GROUP BY userid, pageid
)`, cteName, formParam, questionParam)

	qb.ctes = append(qb.ctes, cte)

	// Add JOIN clause for this CTE (LEFT JOIN so OR conditions work correctly).
	// Joined on the full conversation identity (userid, pageid), not userid alone.
	joinClause := fmt.Sprintf("LEFT JOIN %s rt%d ON s.userid = rt%d.userid AND s.pageid = rt%d.pageid",
		cteName, qb.cteIndex-1, qb.cteIndex-1, qb.cteIndex-1)
	qb.cteJoins = append(qb.cteJoins, joinClause)

	// Return the WHERE condition using this CTE
	return fmt.Sprintf("rt%d.response_time + $%d::INTERVAL < NOW()",
		qb.cteIndex-1, durationParam), nil
}

// buildQuestionResponseCondition creates SQL for question response conditions with CTEs.
// It matches users who answered a specific question in a specific form.
// If Form or QuestionRef is nil, an error is returned.
// When Response is non-nil, the CTE also filters by the specific response value.
// When Response is nil, any answer to the question qualifies (existence check only).
func (qb *QueryBuilder) buildQuestionResponseCondition(cond *types.SimpleCondition) (string, error) {
	if cond.Form == nil {
		return "", fmt.Errorf("form (shortcode) is required for question_response condition")
	}
	if cond.QuestionRef == nil {
		return "", fmt.Errorf("question_ref is required for question_response condition")
	}

	cteName := fmt.Sprintf("question_responses_%d", qb.cteIndex)
	alias := fmt.Sprintf("qr%d", qb.cteIndex)
	qb.cteIndex++

	formParam := qb.addParam(*cond.Form)
	questionParam := qb.addParam(*cond.QuestionRef)

	// The CTE projects (userid, pageid) so answers stay bound to the account they
	// were given on. A conversation is (platform, account, user) — `pageid` is the
	// legacy column name for the account — so a user id alone is not an identity.
	var cte string
	if cond.Response != nil {
		responseParam := qb.addParam(*cond.Response)
		cte = fmt.Sprintf(`%s AS (
    SELECT DISTINCT userid, pageid
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d AND response = $%d
)`, cteName, formParam, questionParam, responseParam)
	} else {
		cte = fmt.Sprintf(`%s AS (
    SELECT DISTINCT userid, pageid
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
)`, cteName, formParam, questionParam)
	}

	qb.ctes = append(qb.ctes, cte)
	// Joined on the full conversation identity (userid, pageid), not userid alone.
	qb.cteJoins = append(qb.cteJoins, fmt.Sprintf("LEFT JOIN %s %s ON s.userid = %s.userid AND s.pageid = %s.pageid", cteName, alias, alias, alias))

	return fmt.Sprintf("%s.userid IS NOT NULL", alias), nil
}

// buildSurveyIDCondition matches users whose current form belongs to a specific survey UUID.
// It uses a subquery against the surveys table to map the survey UUID to one or more shortcodes,
// then checks whether states.current_form is one of those shortcodes.
// A survey UUID can map to multiple shortcodes (one per published version), so IN is correct.
func (qb *QueryBuilder) buildSurveyIDCondition(cond *types.SimpleCondition) (string, error) {
	if cond.Value == nil || *cond.Value == "" {
		return "", fmt.Errorf("value is required for surveyid condition")
	}

	paramNum := qb.addParam(*cond.Value)
	return fmt.Sprintf("s.current_form IN (SELECT shortcode FROM surveys WHERE id = $%d)", paramNum), nil
}

// buildLogicalOperator handles AND/OR/NOT operations recursively
func (qb *QueryBuilder) buildLogicalOperator(op *types.LogicalOperator) (string, error) {
	if op.Op == "not" {
		if len(op.Vars) != 1 {
			return "", fmt.Errorf("not operator must have exactly one condition")
		}
		child, err := qb.buildCondition(&op.Vars[0])
		if err != nil {
			return "", fmt.Errorf("failed to build not condition: %w", err)
		}
		return "NOT (" + child + ")", nil
	}

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
