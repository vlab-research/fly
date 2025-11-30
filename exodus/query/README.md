# Exodus Query Builder

The query builder package translates bail DSL conditions into safe, parameterized SQL queries for PostgreSQL.

## Overview

This package provides a `BuildQuery` function that converts a `BailDefinition` (with nested conditions) into executable SQL that can be used to find users matching bail criteria.

## Features

- **Parameterized Queries**: All user values are passed as parameters (never interpolated), preventing SQL injection
- **Complex Conditions**: Supports AND/OR logical operators with arbitrary nesting
- **Time-Based Conditions**: Handles elapsed time conditions with automatic CTE generation
- **Type Safety**: Uses strongly-typed condition structs from the `types` package
- **Configurable Limits**: Default 100,000 row limit for safety

## Usage

```go
import (
    "github.com/vlab-research/exodus/query"
    "github.com/vlab-research/exodus/types"
)

// Create a bail definition (usually from JSON)
def := &types.BailDefinition{
    Conditions: cond,
    Execution: types.Execution{Timing: "immediate"},
    Action: types.Action{DestinationForm: "exit-survey"},
}

// Build the query
sql, params, err := query.BuildQuery(def)
if err != nil {
    // handle error
}

// Execute with database
rows, err := db.Query(sql, params...)
```

## Supported Condition Types

### Simple Conditions

1. **form**: Matches current form
   ```json
   {"type": "form", "value": "survey-123"}
   ```
   Generates: `s.current_form = $N`

2. **state**: Matches current state
   ```json
   {"type": "state", "value": "WAIT_EXTERNAL_EVENT"}
   ```
   Generates: `s.current_state = $N`

3. **error_code**: Matches error code in state_json
   ```json
   {"type": "error_code", "value": "TIMEOUT"}
   ```
   Generates: `s.state_json->'error'->>'code' = $N`

4. **current_question**: Matches current question
   ```json
   {"type": "current_question", "value": "consent"}
   ```
   Generates: `s.state_json->>'question' = $N`

5. **elapsed_time**: Time since a specific event
   ```json
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
   ```
   Generates a CTE and JOIN:
   ```sql
   WITH response_times_0 AS (
       SELECT userid, MIN(timestamp) as response_time
       FROM responses
       WHERE shortcode = $N AND question_ref = $M
       GROUP BY userid
   )
   SELECT DISTINCT s.userid, s.pageid
   FROM states s
   JOIN response_times_0 rt0 ON s.userid = rt0.userid
   WHERE rt0.response_time + $K::INTERVAL < NOW()
   ```

### Logical Operators

**AND**: All conditions must be true
```json
{
  "op": "and",
  "vars": [
    {"type": "form", "value": "survey-1"},
    {"type": "state", "value": "WAITING"}
  ]
}
```

**OR**: At least one condition must be true
```json
{
  "op": "or",
  "vars": [
    {"type": "form", "value": "survey-1"},
    {"type": "form", "value": "survey-2"}
  ]
}
```

Operators can be nested arbitrarily:
```json
{
  "op": "or",
  "vars": [
    {
      "op": "and",
      "vars": [
        {"type": "form", "value": "A"},
        {"type": "state", "value": "B"}
      ]
    },
    {"type": "error_code", "value": "C"}
  ]
}
```

## Example Output

For this condition:
```json
{
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
}
```

The builder generates:
```sql
WITH response_times_0 AS (
    SELECT userid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $3 AND question_ref = $4
    GROUP BY userid
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN response_times_0 rt0 ON s.userid = rt0.userid
WHERE (s.current_form = $1 AND s.current_state = $2 AND rt0.response_time + $5::INTERVAL < NOW())
LIMIT 100000
```

With parameters: `[myform, WAIT_EXTERNAL_EVENT, myform, q1, 4 weeks]`

## Safety Features

### SQL Injection Prevention
- All user-provided values are passed as parameters, never interpolated
- No string concatenation of user input into SQL
- All tests include SQL injection prevention verification

### Duration Validation
- Only accepts valid PostgreSQL interval formats
- Pattern: `<number> <unit>` (e.g., "4 weeks", "2 days")
- Supported units: microseconds, milliseconds, seconds, minutes, hours, days, weeks, months, years
- Rejects invalid formats before query generation

### Query Limits
- All queries include a LIMIT clause (default: 100,000)
- Prevents accidentally returning millions of rows
- Limit is configurable via QueryBuilder.queryLimit

## Database Schema Requirements

The query builder expects the following tables:

### states
- `userid` - User identifier
- `pageid` - Page identifier
- `current_form` - Current form shortcode
- `current_state` - Current state (e.g., "WAIT_EXTERNAL_EVENT")
- `state_json` - JSONB field containing state details
  - `state_json.error.code` - Error code (for error_code conditions)
  - `state_json.question` - Current question (for current_question conditions)

### responses
- `userid` - User identifier
- `shortcode` - Form shortcode
- `question_ref` - Question reference
- `timestamp` - Response timestamp

## Testing

The package includes comprehensive unit tests:
```bash
go test ./query/
```

Run with coverage:
```bash
go test ./query/ -cover
```

Tests cover:
- All simple condition types
- AND/OR logical operators
- Nested logical operators
- Elapsed time with CTE generation
- Multiple elapsed_time conditions (unique CTE names)
- SQL injection prevention
- Duration format validation
- Parameter ordering

## Architecture Notes

### Parameter Ordering
Parameters are added left-to-right as conditions are processed. For complex conditions with elapsed_time:
1. Simple conditions are processed first (form, state, etc.)
2. Elapsed_time conditions add CTE parameters (form, question_ref) then duration
3. This results in WHERE parameters appearing before CTE parameters in the list

### CTE Naming
Each elapsed_time condition creates a unique CTE with auto-incremented names:
- First: `response_times_0`, alias `rt0`
- Second: `response_times_1`, alias `rt1`
- And so on...

This allows multiple elapsed_time conditions in a single query.

### Query Structure
All generated queries follow this structure:
```sql
[WITH cte1 AS (...), cte2 AS (...)]  -- Optional CTEs
SELECT DISTINCT s.userid, s.pageid
FROM states s
[JOIN cte1 ON ...]                    -- Optional CTE joins
WHERE <conditions>
LIMIT N
```

## Future Enhancements

Potential additions:
- Support for additional event types beyond "response"
- Custom LIMIT values per query
- Support for ORDER BY clauses
- Additional JSON path conditions
- Time-based conditions for other events (form start, state change, etc.)
