# Exodus Type Definitions Analysis - Findings

## Executive Summary

Analyzed all Go type definitions in the `exodus/` directory and produced comprehensive documentation in `documentation/exodus-type-definitions.md`. The exodus package uses a sophisticated type system with:

1. **Union types** via custom JSON marshaling (Condition can be SimpleCondition or LogicalOperator)
2. **Conditional field requirements** based on enum values (e.g., scheduled timing requires TimeOfDay + Timezone)
3. **Nested recursive structures** (LogicalOperator containing Conditions containing LogicalOperators)
4. **Type safety** with restricted enum values and eager validation
5. **Consistency constraints** (BailDefinition.Action.DestinationForm must match Bail.DestinationForm)

## Key Findings

### 1. Core Domain Model Structure

The exodus package has a clear separation of concerns:

**API/Domain Layer** (`exodus/types/types.go`):
- Contains all domain types with full struct definitions
- Uses `BailDefinition` as the polymorphic condition container
- Includes database model types (`Bail`, `BailEvent`)

**Database Layer** (`exodus/db/`):
- Mirror types with `json.RawMessage` for deferred unmarshaling
- Optimization to avoid unnecessary parsing until needed

**API Handler Layer** (`exodus/api/types.go`):
- Request types: `CreateBailRequest`, `UpdateBailRequest`, `PreviewRequest`
- Response types: `BailResponse`, `PreviewResponse`, `BailsListResponse`

### 2. Union Type Implementation (Condition)

The `Condition` struct is a elegantly designed union type:

```go
type Condition struct {
    simple   *SimpleCondition
    operator *LogicalOperator
}
```

**Marshaling Strategy**:
- `MarshalJSON()`: Returns the JSON of whichever field is non-nil
- `UnmarshalJSON()`: Inspects incoming JSON for `"op"` field
  - If `"op"` field with "and"/"or" value exists → unmarshals as LogicalOperator
  - Otherwise → unmarshals as SimpleCondition

**Helper Methods** (for safe access):
- `IsSimple()` / `IsOperator()` - Type checking
- `GetSimple()` / `GetOperator()` - Type-safe field access

**Design Benefits**:
- Supports arbitrary nesting depth
- Clean JSON representation (no wrapper objects)
- Type safety through helper methods

### 3. Conditional Field Requirements

Several types have fields that are required based on other field values:

**Execution Timing Types**:
| Timing | Required Fields | Purpose |
|--------|-----------------|---------|
| `immediate` | None | Always execute |
| `scheduled` | `TimeOfDay`, `Timezone` | Execute at specific time daily |
| `absolute` | `Datetime` | Execute once when time reached |

**SimpleCondition Types**:
| Condition Type | Required Fields | Database Query |
|---|---|---|
| `form` | `Value` | `s.current_form = ?` |
| `state` | `Value` | `s.current_state = ?` |
| `error_code` | `Value` | `s.state_json->'error'->>'code' = ?` |
| `current_question` | `Value` | `s.state_json->>'question' = ?` |
| `elapsed_time` | `Since`, `Duration` | CTE-based with time calculation |

### 4. Enum Values

Restricted string values across the system:

**Execution.Timing**: `"immediate"`, `"scheduled"`, `"absolute"`
**Condition.Type**: `"form"`, `"state"`, `"error_code"`, `"current_question"`, `"elapsed_time"`
**LogicalOperator.Op**: `"and"`, `"or"` (case-sensitive)
**BailEvent.EventType**: `"execution"`, `"error"`
**TimeReference.Event**: Currently only `"response"` supported (extensible for future event types)

### 5. Validation Architecture

All types implement `Validate()` method with consistent error handling:

**Error Pattern**: `"invalid <component>: <specific reason>"`

**Validation Flow**:
1. BailDefinition.Validate() → delegates to Conditions, Execution, Action
2. Condition.Validate() → delegates to SimpleCondition or LogicalOperator
3. LogicalOperator.Validate() → validates each Condition recursively
4. Bail.Validate() → validates Definition and checks DestinationForm consistency

**Error Reporting**:
- Specific field names and validation rules in error messages
- Index information for array validations
- Nested error context (e.g., "condition at index 2")

### 6. Key Constraints & Relationships

**Consistency Enforcement**:
- `Bail.DestinationForm` must exactly match `Bail.Definition.Action.DestinationForm`
- Checked during `Bail.Validate()` to prevent inconsistent state

**Counting Constraints**:
- `BailEvent.UsersBailed <= BailEvent.UsersMatched`
- Enforced to prevent impossible states

**Condition Union Invariant**:
- Exactly one of (SimpleCondition, LogicalOperator) must be non-nil in Condition
- Enforced by custom unmarshaling logic

### 7. Database Type Differences

**API Types** (`exodus/types/`):
- Use fully unmarshaled nested types
- `Bail.Definition: BailDefinition`
- `BailEvent.DefinitionSnapshot: BailDefinition`

**DB Types** (`exodus/db/`):
- Store definitions as `json.RawMessage`
- Defers unmarshaling to reduce load on large queries
- Unmarshaling happens in executor layer as needed

This is a deliberate performance optimization.

### 8. Duration Format

**Parser**: `exodus/executor/timing.go:parseTimeOfDay()` and validation in `exodus/query/builder.go`

**Format**: `"<number> <unit>"`
- Number: Non-negative integer
- Units: `seconds/minutes/hours/days/weeks` (singular or plural)
- PostgreSQL `INTERVAL` compatible

**Examples**:
- `"2 weeks"`
- `"4 days"`
- `"3 hours"`
- `"30 minutes"`

### 9. Timezone Handling

**Requirement**: Valid IANA timezone string
- Examples: `"UTC"`, `"America/New_York"`, `"Europe/London"`
- Loaded with `time.LoadLocation()` in executor
- Invalid timezones cause execution to fail fast

### 10. DateTime Format

**Requirement**: ISO 8601 format
- Preferred: `"2025-12-15T10:00:00Z"` (RFC3339)
- Fallback: `"2025-12-15T10:00:00"` (without timezone)
- Parsed with `time.Parse()` in timing validation

## File Structure

### Types Definition Files
- `/home/nandan/Documents/vlab-research/fly/exodus/types/types.go` - Core domain types
- `/home/nandan/Documents/vlab-research/fly/exodus/api/types.go` - API request/response types
- `/home/nandan/Documents/vlab-research/fly/exodus/db/bails.go` - DB operations
- `/home/nandan/Documents/vlab-research/fly/exodus/db/events.go` - Event DB operations

### Validation Files
- `/home/nandan/Documents/vlab-research/fly/exodus/executor/timing.go` - Timing validation and parsing
- `/home/nandan/Documents/vlab-research/fly/exodus/executor/executor.go` - Bail processing orchestration
- `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go` - SQL query generation

### Implementation Files
- `/home/nandan/Documents/vlab-research/fly/exodus/sender/sender.go` - Bailout event sending
- `/home/nandan/Documents/vlab-research/fly/exodus/db/db.go` - Database initialization

### Test Files
- `/home/nandan/Documents/vlab-research/fly/exodus/types/types_test.go` - Comprehensive type validation tests
- `/home/nandan/Documents/vlab-research/fly/exodus/examples_test.go` - End-to-end examples
- `/home/nandan/Documents/vlab-research/fly/exodus/query/builder_test.go` - Query builder tests
- `/home/nandan/Documents/vlab-research/fly/exodus/executor/timing_test.go` - Timing logic tests

## Common Integration Patterns

### Creating a Bail with Conditions

1. **Simple Condition**:
   ```json
   {
     "conditions": {"type": "state", "value": "WAITING"},
     "execution": {"timing": "immediate"},
     "action": {"destination_form": "exit-survey"}
   }
   ```

2. **AND Logic**:
   ```json
   {
     "conditions": {
       "op": "and",
       "vars": [
         {"type": "form", "value": "survey-123"},
         {"type": "state", "value": "WAITING"}
       ]
     },
     "execution": {"timing": "immediate"},
     "action": {"destination_form": "exit-survey"}
   }
   ```

3. **Nested Logic with Elapsed Time**:
   ```json
   {
     "conditions": {
       "op": "and",
       "vars": [
         {"type": "state", "value": "WAITING"},
         {
           "type": "elapsed_time",
           "since": {"event": "response", "details": {"form": "intake", "question_ref": "q1"}},
           "duration": "2 weeks"
         }
       ]
     },
     "execution": {"timing": "scheduled", "time_of_day": "09:00", "timezone": "UTC"},
     "action": {"destination_form": "exit-survey", "metadata": {"reason": "timeout"}}
   }
   ```

### Execution Flow

1. **Load**: `executor.GetEnabledBails()` → unmarshals `json.RawMessage` to `BailDefinition`
2. **Validate**: `bailDef.Validate()` → ensures all constraints met
3. **Check Timing**: `executor.shouldExecute()` → determines if execution should proceed
4. **Build Query**: `query.BuildQuery(bailDef)` → generates parameterized SQL
5. **Execute Query**: Finds matching users from database
6. **Send Bailouts**: `sender.SendBailouts()` → sends events to botserver
7. **Record Event**: `executor.recordSuccess()` or `recordError()` → logs outcome

## Notable Design Decisions

### 1. Custom JSON Marshaling for Union Types
**Why**: Avoids wrapping objects while maintaining type safety
**Trade-off**: More complex unmarshaling logic, but cleaner JSON representation

### 2. Deferred Unmarshaling in Database Layer
**Why**: Optimization to avoid parsing all definitions on bulk queries
**Trade-off**: Two parallel type definitions (API and DB), requires marshaling step in executor

### 3. Eager Validation
**Why**: "Fail fast and loud" principle - errors caught immediately with specific messages
**Trade-off**: Cannot create intermediate invalid states

### 4. Recursive Condition Structure
**Why**: Supports arbitrary boolean algebra on conditions
**Trade-off**: Requires careful recursive validation, potential for very deep nesting

### 5. String-based Enums
**Why**: JSON serialization, human-readable, extensible
**Trade-off**: No compile-time exhaustiveness checking, must validate at runtime

## Potential Gaps & TODOs in Code

From `exodus/types/types.go`, there are several TODOs noted in validation:

1. **TimeOfDay format validation** (line 52): Currently accepted as-is, needs HH:MM format check
2. **Timezone validation** (line 53): Currently accepted as-is, needs IANA timezone verification
3. **Datetime format validation** (line 58): Currently accepted as-is, needs ISO 8601 verification

These are likely intentional to defer validation cost, or rely on downstream parsing failures.

## Recommendations for Code Using These Types

1. **Always call Validate()** after unmarshaling, especially for user input
2. **Use helper methods** on Condition (IsSimple/IsOperator) rather than accessing private fields
3. **Set both Bail.DestinationForm and Definition.Action.DestinationForm** identically
4. **Handle UserTarget parsing errors** gracefully in executor query result processing
5. **Use context cancellation** when sending bailouts to allow graceful shutdown

## Documentation Location

Complete type reference: `/home/nandan/Documents/vlab-research/fly/documentation/exodus-type-definitions.md`

This file includes:
- Detailed field descriptions for every type
- JSON marshaling behavior
- Validation rules matrix
- Common validation errors and their causes
- Nested structure requirements
- Full JSON examples for each type
