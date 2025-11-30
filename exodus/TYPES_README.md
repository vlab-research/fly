# Exodus Types Documentation

## Overview

This document describes the Go types used in the exodus service for defining "bail" conditions - automated rules that determine when survey respondents should be redirected to a different form based on their current state, elapsed time, errors, or other criteria.

## Core Types

### BailDefinition

The main type representing a complete bail configuration:

```go
type BailDefinition struct {
    Conditions Condition `json:"conditions"`
    Execution  Execution `json:"execution"`
    Action     Action    `json:"action"`
}
```

- **Conditions**: Defines when the bail should trigger (simple or complex logic)
- **Execution**: Defines when the bail action should be executed
- **Action**: Defines what happens when the bail triggers

### Condition (Union Type)

A union type that can represent either a simple condition or a logical operator combining multiple conditions. This is implemented using unexported fields and custom JSON marshaling/unmarshaling.

#### Simple Conditions

Simple conditions check a single criterion:

- **form**: Match users in a specific form
  ```json
  {"type": "form", "value": "survey-123"}
  ```

- **state**: Match users in a specific state
  ```json
  {"type": "state", "value": "WAITING"}
  ```

- **error_code**: Match users with a specific error code
  ```json
  {"type": "error_code", "value": "TIMEOUT"}
  ```

- **current_question**: Match users at a specific question
  ```json
  {"type": "current_question", "value": "consent"}
  ```

- **elapsed_time**: Match users based on time elapsed since an event
  ```json
  {
    "type": "elapsed_time",
    "since": {
      "event": "response",
      "details": {
        "question_ref": "initial_consent",
        "form": "consent-form"
      }
    },
    "duration": "7 days"
  }
  ```

#### Logical Operators

Combine multiple conditions with `and` or `or` logic:

```json
{
  "op": "and",
  "vars": [
    {"type": "form", "value": "onboarding-survey"},
    {"type": "state", "value": "ERROR"}
  ]
}
```

Logical operators can be nested:

```json
{
  "op": "or",
  "vars": [
    {
      "op": "and",
      "vars": [
        {"type": "form", "value": "main-survey"},
        {"type": "state", "value": "WAITING"}
      ]
    },
    {"type": "error_code", "value": "TIMEOUT"}
  ]
}
```

### Execution

Defines when the bail action should be executed:

```go
type Execution struct {
    Timing    string  `json:"timing"`
    TimeOfDay *string `json:"time_of_day,omitempty"`
    Timezone  *string `json:"timezone,omitempty"`
    Datetime  *string `json:"datetime,omitempty"`
}
```

Three timing modes:

1. **immediate**: Execute as soon as conditions are met
   ```json
   {"timing": "immediate"}
   ```

2. **scheduled**: Execute at a specific time of day
   ```json
   {
     "timing": "scheduled",
     "time_of_day": "09:00",
     "timezone": "Africa/Lagos"
   }
   ```

3. **absolute**: Execute at a specific datetime
   ```json
   {
     "timing": "absolute",
     "datetime": "2025-12-15T10:00:00Z"
   }
   ```

### Action

Defines what happens when a bail triggers:

```go
type Action struct {
    DestinationForm string                 `json:"destination_form"`
    Metadata        map[string]interface{} `json:"metadata,omitempty"`
}
```

- **destination_form**: The form ID to redirect users to (required)
- **metadata**: Optional additional data to attach to the bail event

## Database Types

### Bail

Represents a bail configuration stored in the database:

```go
type Bail struct {
    ID              uuid.UUID
    SurveyID        uuid.UUID
    Name            string
    Description     string
    Enabled         bool
    Definition      BailDefinition
    DestinationForm string
    CreatedAt       time.Time
    UpdatedAt       time.Time
}
```

### BailEvent

Represents an event logged when a bail is executed or encounters an error:

```go
type BailEvent struct {
    ID                 uuid.UUID
    BailID             *uuid.UUID        // nullable
    SurveyID           uuid.UUID
    BailName           string
    EventType          string            // "execution" or "error"
    Timestamp          time.Time
    UsersMatched       int
    UsersBailed        int
    DefinitionSnapshot BailDefinition
    Error              *json.RawMessage  // nullable
}
```

## Validation

All major types include `Validate() error` methods that check:

- Required fields are present
- Field values are valid
- Nested structures are valid
- Business logic constraints are met (e.g., `users_bailed <= users_matched`)

Example usage:

```go
var def BailDefinition
err := json.Unmarshal(data, &def)
if err != nil {
    return err
}

if err := def.Validate(); err != nil {
    return fmt.Errorf("invalid bail definition: %w", err)
}
```

## JSON Marshaling Notes

### Condition Type Implementation

The `Condition` type uses unexported fields (`simple` and `operator`) with custom marshaling:

- **MarshalJSON**: Uses a **value receiver** to ensure it works when marshaling by value
- **UnmarshalJSON**: Uses a **pointer receiver** to modify the receiver

This design ensures that conditions can be properly serialized/deserialized even when nested in other structs by value.

## Example Definitions

See `examples.json` for complete examples of:

1. Simple state-based bail
2. Complex AND logic with scheduled execution
3. Nested OR/AND logic with absolute timing
4. Elapsed time-based bail with scheduled execution

## Testing

Run the test suite:

```bash
go test -v
```

Tests include:
- JSON marshaling/unmarshaling round-trips
- Validation logic for all types
- Complex nested condition structures
- Example JSON parsing from `examples.json`
