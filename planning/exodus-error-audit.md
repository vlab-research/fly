# Exodus Error Handling Audit

## Executive Summary

This audit reviewed all non-test Go files in the exodus codebase for error handling issues. The codebase exhibits **good error handling discipline overall**, with proper error propagation in most cases. However, several issues were identified that warrant attention, ranging from minor warnings being swallowed to potential silent failures.

**Critical Issues Found: 2**
**High-Priority Issues Found: 3**
**Medium-Priority Issues Found: 4**
**Low-Priority Issues Found: 2**

---

## Critical Issues

### 1. Database Connection Failure Converts Error to Fatal in db.New()

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/db/db.go` (lines 18-30)

**Code:**
```go
func New(connString string) (*DB, error) {
    config, err := pgxpool.ParseConfig(connString)
    if err != nil {
        return nil, err
    }

    ctx := context.Background()
    pool, err := pgxpool.ConnectConfig(ctx, config)
    if err != nil {
        log.Fatal(err)  // <-- PROBLEM
    }

    return &DB{pool: pool}, nil
}
```

**Problem:** The function signature declares it returns an error (`(*DB, error)`), but when connection fails, it calls `log.Fatal()` instead of returning the error. This is inconsistent and dangerous because:
- Callers expect to handle errors, but instead the process crashes
- In main.go, the call expects an error return, making the Fatal call invisible in normal flow analysis
- Makes the code harder to test (can't mock connection failures)

**Why it's critical:** The caller in `main.go:34` expects to handle the error gracefully, but the fatal call bypasses this entirely.

**Suggested Fix:**
```go
func New(connString string) (*DB, error) {
    config, err := pgxpool.ParseConfig(connString)
    if err != nil {
        return nil, fmt.Errorf("failed to parse connection string: %w", err)
    }

    ctx := context.Background()
    pool, err := pgxpool.ConnectConfig(ctx, config)
    if err != nil {
        return nil, fmt.Errorf("failed to connect to database: %w", err)
    }

    return &DB{pool: pool}, nil
}
```

Let the caller (main.go) decide whether to log.Fatal() or handle gracefully.

---

### 2. Goroutine Error in main.go runAPI() Is Logged-Only

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/main.go` (lines 57-63)

**Code:**
```go
go func() {
    addr := fmt.Sprintf(":%d", cfg.Port)
    log.Printf("Starting exodus API server on %s", addr)
    if err := server.Run(addr); err != nil {
        log.Printf("Server error: %v", err)  // <-- ONLY LOGS, DOESN'T PROPAGATE
    }
}()
```

**Problem:** The goroutine runs the API server, but if it crashes with an error, only a log message is printed. The main thread continues to wait for graceful shutdown signals, meaning:
- A critical server failure might be unnoticed if logs aren't monitored
- The process stays running even if the server can't start
- There's no mechanism to signal back to the main thread that a fatal error occurred

**Why it's critical:** This is a silent failure pattern. The server might crash, but the executor will continue running, creating monitoring/alerting blind spots.

**Suggested Fix:**
Add an error channel to signal failures back to main:
```go
errs := make(chan error, 1)
go func() {
    addr := fmt.Sprintf(":%d", cfg.Port)
    log.Printf("Starting exodus API server on %s", addr)
    errs <- server.Run(addr)  // Send error (or nil) back
}()

select {
case <-ctx.Done():
    log.Println("Shutting down gracefully...")
case err := <-errs:
    if err != nil {
        log.Fatalf("Server error: %v", err)
    }
}
```

---

## High-Priority Issues

### 3. Panic Recovery in executor.processBail() Calls recordError() Without Error Propagation

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 94-103)

**Code:**
```go
defer func() {
    if r := recover(); r != nil {
        err = fmt.Errorf("panic during bail execution: %v", r)
        log.Printf("PANIC in bail %s (%s): %v", dbBail.Name, dbBail.ID, r)

        // Record panic as error event
        e.recordError(ctx, dbBail, err)  // <-- PROBLEM
    }
}()
```

**Problem:** When `recordError()` encounters an error (e.g., database write fails), that error is silently dropped:
```go
if err := e.store.RecordEvent(ctx, event); err != nil {
    log.Printf("Warning: Failed to record error event for bail %s: %v", dbBail.Name, err)
    // Error is lost - not propagated back
}
```

This means:
- A panic is "handled" by trying to record it, but if recording fails, we lose the panic information
- The caller in Run() gets no indication that both the original problem AND the recovery failed

**Suggested Fix:**
```go
defer func() {
    if r := recover(); r != nil {
        err = fmt.Errorf("panic during bail execution: %v", r)
        log.Printf("PANIC in bail %s (%s): %v", dbBail.Name, dbBail.ID, r)

        // Record panic as error event - don't ignore failures
        if recordErr := e.recordError(ctx, dbBail, err); recordErr != nil {
            err = fmt.Errorf("panic: %v (also failed to record: %w)", r, recordErr)
        }
    }
}()
```

---

### 4. API Handler Conversion Errors Are Not Consistently Handled

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/api/handlers.go` (lines 456-468)

**Code:**
```go
users := make([]UserPreview, len(results))
for i, row := range results {
    userID, ok := row["userid"].(string)
    if !ok {
        return respondError(c, http.StatusInternalServerError, "conversion_error", "Failed to convert userid")
    }
    pageID, ok := row["pageid"].(string)
    if !ok {
        return respondError(c, http.StatusInternalServerError, "conversion_error", "Failed to convert pageid")
    }
    users[i] = UserPreview{
        UserID: userID,
        PageID: pageID,
    }
}
```

**Problem:** If conversion fails, the handler returns immediately, but this logic is repeated across multiple handlers without consistent patterns. The problem surfaces in:
- `ListBails()` at line 42-46 (type conversions during list response)
- `PreviewBail()` at lines 456-468 (type conversions during preview)

If a conversion fails for one item in the middle of a list, the entire request fails. There's no fallback, warning, or partial success.

**Suggested Fix:**
```go
users := make([]UserPreview, 0, len(results))
var skipped int
for i, row := range results {
    userID, ok := row["userid"].(string)
    if !ok {
        log.Printf("Warning: Skipping row %d: invalid userid type %T", i, row["userid"])
        skipped++
        continue
    }
    pageID, ok := row["pageid"].(string)
    if !ok {
        log.Printf("Warning: Skipping row %d: invalid pageid type %T", i, row["pageid"])
        skipped++
        continue
    }
    users = append(users, UserPreview{UserID: userID, PageID: pageID})
}
if skipped > 0 {
    log.Printf("Warning: Skipped %d rows due to conversion errors", skipped)
}
```

---

### 5. timing.go shouldExecuteAbsolute() Returns False on Parse Error Instead of Error

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/timing.go` (lines 97-125)

**Code:**
```go
func shouldExecuteAbsolute(exec *types.Execution, now time.Time, lastExecution *time.Time) bool {
    if exec.Datetime == nil {
        return false
    }

    targetTime, err := time.Parse(time.RFC3339, *exec.Datetime)
    if err != nil {
        // Try alternate ISO 8601 format without timezone
        targetTime, err = time.Parse("2006-01-02T15:04:05", *exec.Datetime)
        if err != nil {
            return false  // <-- SILENTLY RETURNS FALSE ON PARSE FAILURE
        }
    }

    // Don't execute if we're before the target time
    if now.Before(targetTime) {
        return false
    }

    // Don't execute if we've already executed
    if lastExecution != nil {
        return false
    }

    return true
}
```

**Problem:** If the datetime string is malformed, the function silently returns `false`, meaning:
- The bail is never executed (appears "not ready")
- No error is logged or surfaced to the caller
- A misconfigured bail will silently fail to run
- The caller in `processBail()` cannot distinguish between "timing not met" and "configuration error"

**Why it's a problem:** shouldExecuteAbsolute() signature returns only `bool`. But the caller expects errors from the wrapper shouldExecute():

```go
ready, err := shouldExecute(&bailDef.Execution, now, lastExecution)  // <-- expects error return
if err != nil {
    err := fmt.Errorf("timing check failed: %w", err)
    e.recordError(ctx, dbBail, err)
    return err
}
```

The signature is inconsistent: `shouldExecute()` returns `(bool, error)` but `shouldExecuteAbsolute()` returns only `bool`.

**Suggested Fix:**
```go
func shouldExecuteAbsolute(exec *types.Execution, now time.Time, lastExecution *time.Time) (bool, error) {
    if exec.Datetime == nil {
        return false, fmt.Errorf("datetime is required for absolute timing")
    }

    targetTime, err := time.Parse(time.RFC3339, *exec.Datetime)
    if err != nil {
        // Try alternate ISO 8601 format without timezone
        targetTime, err = time.Parse("2006-01-02T15:04:05", *exec.Datetime)
        if err != nil {
            return false, fmt.Errorf("invalid datetime format: %q (must be RFC3339 or ISO8601 without timezone): %w", *exec.Datetime, err)
        }
    }

    // Don't execute if we're before the target time
    if now.Before(targetTime) {
        return false, nil
    }

    // Don't execute if we've already executed
    if lastExecution != nil {
        return false, nil
    }

    return true, nil
}

// Update shouldExecute to handle the new signature
func shouldExecute(execution *types.Execution, now time.Time, lastExecution *time.Time) (bool, error) {
    switch execution.Timing {
    case "immediate":
        return true, nil
    case "scheduled":
        return shouldExecuteScheduled(execution, now, lastExecution)
    case "absolute":
        return shouldExecuteAbsolute(execution, now, lastExecution)  // Now returns (bool, error)
    default:
        return false, fmt.Errorf("invalid timing type: %s", execution.Timing)
    }
}
```

---

## Medium-Priority Issues

### 6. JSON Marshaling Error in recordSuccess() Is Logged but Continues

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 255-273)

**Code:**
```go
func (e *Executor) recordSuccess(ctx context.Context, dbBail *db.Bail, bailDef *types.BailDefinition, usersMatched int, bailedIDs []string) {
    // Marshal definition back to JSON for snapshot
    defJSON, err := json.Marshal(bailDef)
    if err != nil {
        log.Printf("Warning: Failed to marshal bail definition for event: %v", err)
        defJSON = []byte("{}")  // <-- SILENTLY USES EMPTY OBJECT
    }

    // Build execution_results from bailed IDs
    var executionResults *json.RawMessage
    if bailedIDs != nil {
        raw, err := json.Marshal(map[string]interface{}{"user_ids": bailedIDs})
        if err != nil {
            log.Printf("Warning: Failed to marshal execution results: %v", err)
            // <-- ERROR IS DROPPED, executionResults REMAINS NIL
        } else {
            msg := json.RawMessage(raw)
            executionResults = &msg
        }
    }
```

**Problem:**
- When bail definition marshaling fails, the event is recorded with an empty JSON `{}` instead of the actual definition
- When execution results marshaling fails, the field is simply omitted (nil)
- Both errors are logged but don't prevent the event from being recorded with partial/missing data
- Someone analyzing bail history won't know which records have corrupted or missing snapshot data

**Suggested Fix:**
```go
defJSON, err := json.Marshal(bailDef)
if err != nil {
    // Don't record a success event if we can't serialize the definition snapshot
    // Record this as an error instead
    log.Printf("Error: Cannot record success event - failed to marshal definition: %v", err)
    e.recordError(ctx, dbBail, fmt.Errorf("success event recording failed: %w", err))
    return
}

var executionResults *json.RawMessage
if bailedIDs != nil {
    raw, err := json.Marshal(map[string]interface{}{"user_ids": bailedIDs})
    if err != nil {
        log.Printf("Error: Cannot record success event - failed to marshal results: %v", err)
        e.recordError(ctx, dbBail, fmt.Errorf("success event recording failed: %w", err))
        return
    }
    msg := json.RawMessage(raw)
    executionResults = &msg
}
```

---

### 7. Sender.SendBailout() Doesn't Close Response Body on Error

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/sender/sender.go` (lines 84-104)

**Code:**
```go
req, err := http.NewRequestWithContext(ctx, "POST", s.botserverURL, bytes.NewBuffer(body))
if err != nil {
    return fmt.Errorf("failed to create request: %w", err)  // <-- Request creation error - no body to close
}
req.Header.Set("Content-Type", "application/json")

// Send request
resp, err := s.client.Do(req)
if err != nil {
    return fmt.Errorf("failed to send bailout to botserver: %w", err)  // <-- Request error - no response to close
}
defer resp.Body.Close()  // <-- Only closes if Do() succeeds

// Check response status
if resp.StatusCode != http.StatusOK {
    return fmt.Errorf("botserver returned non-200 status: %d", resp.StatusCode)  // <-- Returns without issue
}

log.Printf("Successfully bailed user=%s page=%s to form=%s", userID, pageID, destinationForm)
return nil
```

**Problem:** If `s.client.Do(req)` returns an error, we return immediately without having a response to close. However, the pattern is somewhat loose:
- If Do() succeeds but status is non-200, the body IS closed (by defer)
- If Do() fails, there's no response to close anyway (correct)

Actually, this is **not a bug** - Go's http.Client.Do() guarantees that if an error is returned, the response body is nil or needs no closing. **This is a false positive in my audit.** The code is correct.

**Status:** No fix needed - code is correct as-is.

---

### 8. Query Builder validateDuration() Doesn't Return Error from BuildQuery() Caller

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/query/builder.go` (lines 159-162)

**Code:**
```go
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
```

**Actual Status:** This is **correctly handled** - the error from validateDuration() is properly checked and wrapped. No issue here.

---

### 9. Executor.Run() Logs Bail Processing Errors but Continues

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 82-85)

**Code:**
```go
for _, bail := range bails {
    // Check for context cancellation
    select {
    case <-ctx.Done():
        return fmt.Errorf("execution cancelled: %w", ctx.Err())
    default:
    }

    // Process bail with panic recovery
    if err := e.processBail(ctx, bail, now); err != nil {
        log.Printf("Error processing bail %s (%s): %v", bail.Name, bail.ID, err)
        // Continue processing other bails  <-- INTENTIONAL, BY DESIGN
    }
}
```

**Assessment:** This is **intentional and correct** per the docstring at line 53-54:
> Returns an error only for critical system failures that should stop execution.
> Individual bail errors are logged and recorded but don't stop processing other bails.

This is a deliberate design decision to be resilient. **Not an issue.**

---

## Low-Priority Issues

### 10. Missing Nil Check Before Type Assertion in executor.queryUsers()

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 217-235)

**Code:**
```go
var users []sender.UserTarget
for _, row := range rows {
    userID, ok := row["userid"].(string)
    if !ok {
        log.Printf("Warning: Invalid userid type in query result: %T", row["userid"])
        continue  // <-- Skips malformed row gracefully
    }

    pageID, ok := row["pageid"].(string)
    if !ok {
        log.Printf("Warning: Invalid pageid type in query result: %T", row["pageid"])
        continue
    }

    users = append(users, sender.UserTarget{
        UserID:          userID,
        PageID:          pageID,
        DestinationForm: bailDef.Action.DestinationForm,
    })
}
```

**Problem:** If `row` is nil or `row["userid"]` is nil, the type assertion will succeed with ok=false (not panic). But it's worth noting that `row` being nil shouldn't happen (rows come from Query() which returns []map). This is **low-risk** because:
- The type assertion is safe
- Malformed rows are skipped with warnings
- The code won't panic

**Suggested Enhancement (optional):**
```go
if row == nil {
    log.Printf("Warning: Skipping nil row at index %d", i)
    continue
}
userID, ok := row["userid"]
if !ok || userID == nil {
    log.Printf("Warning: userid missing or nil at row %d", i)
    continue
}
userIDStr, ok := userID.(string)
if !ok {
    log.Printf("Warning: userid type is %T, expected string at row %d", userID, i)
    continue
}
```

---

### 11. No Error Return Path for Invalid Bail Type in executor.queryUsers()

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 144-148)

**Code:**
```go
// Branch on bail type: conditions-based or user_list-based
bailType := bailDef.Type
if bailType == "" {
    bailType = "conditions" // backward compatibility
}

// Query users matching bail conditions
users, err := e.queryUsers(ctx, dbBail, &bailDef, bailType)
if err != nil {
    err := fmt.Errorf("failed to query users: %w", err)
    e.recordError(ctx, dbBail, err)
    return err
}
```

But in `queryUsers()`:

```go
// Handle conditions-based bails: execute SQL query
// Build SQL query from bail definition
sql, params, err := query.BuildQuery(bailDef)
if err != nil {
    return nil, fmt.Errorf("failed to build query: %w", err)
}
```

**Problem:** If `bailDef.Type` is something unexpected (not "conditions" or "user_list"), the code doesn't validate this early. It would only error if BuildQuery() fails. If both Type and UserList are nil/empty, BuildQuery will fail, but the error message won't be clear about which field is the problem.

**Suggested Fix:**
```go
// Handle conditions-based bails: execute SQL query
if bailType == "conditions" {
    // ... existing code ...
} else if bailType == "user_list" {
    if bailDef.UserList == nil {
        return nil, fmt.Errorf("user_list is nil for user_list-type bail")
    }
    // ... existing code ...
} else {
    return nil, fmt.Errorf("unexpected bail type: %s (must be 'conditions' or 'user_list')", bailType)
}
```

Actually, looking more carefully at the code, the validation happens in types.BailDefinition.Validate() which is called before processBail() processes the bail. So the type is already validated. **This is low-priority because validation happens upstream.**

---

## Summary Table

| Priority | Issue | File | Line | Category |
|----------|-------|------|------|----------|
| Critical | DB connection fatal instead of error return | db/db.go | 27 | Error type mismatch |
| Critical | API goroutine error swallowed | main.go | 60 | Goroutine error handling |
| High | Panic recovery error drops recordError failure | executor/executor.go | 101 | Nested error loss |
| High | Type conversion errors not consistent | api/handlers.go | 456 | Partial failure handling |
| High | Absolute timing parse error returns false | executor/timing.go | 110 | Silent failure |
| Medium | Success event with corrupted snapshot | executor/executor.go | 257 | Partial data recording |
| Low | Malformed row handling | executor/executor.go | 217 | Type assertion (graceful) |
| Low | Bail type validation | executor/executor.go | 144 | Already validated upstream |

---

## Recommendations

### Immediate Action Required (Critical)

1. **Fix db.New()** to return errors instead of calling log.Fatal()
2. **Add error channel to API goroutine** in main.go to propagate critical errors
3. **Fix shouldExecuteAbsolute()** to return (bool, error) instead of swallowing parse errors

### Short Term (High Priority)

4. **Improve error handling in recordError()** to not lose errors from store.RecordEvent()
5. **Make conversion errors in handlers recoverable** or at least consistent
6. **Add validation layer** before recordSuccess() attempts marshaling

### Nice to Have (Low Priority)

7. **Add nil checks** in queryUsers() for defensive programming
8. **Improve error messages** in timing functions to distinguish configuration errors from timing conditions

---

## Testing Recommendations

Add integration tests for:
1. Database connection failures - verify error is returned, not fatal
2. Malformed absolute timing strings - verify error is propagated
3. Goroutine failures - verify signal handling works with server errors
4. JSON marshaling failures in success/error recording - verify full error context is captured

