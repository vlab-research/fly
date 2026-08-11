# PageID Selection: Code Reference Guide

**Quick-access code locations and snippets for pageid handling**

---

## 1. SQL Query Generation

### File: `/exodus/query/builder.go`

**Lines 44-72:** Main BuildQuery function

```go
func BuildQuery(def *types.BailDefinition) (string, []interface{}, error) {
    builder := NewQueryBuilder()

    whereClause, err := builder.buildCondition(def.Conditions)
    if err != nil {
        return "", nil, fmt.Errorf("failed to build conditions: %w", err)
    }

    var query strings.Builder

    // Add CTEs if any exist
    if len(builder.ctes) > 0 {
        query.WriteString("WITH ")
        query.WriteString(strings.Join(builder.ctes, ",\n"))
        query.WriteString("\n")
    }

    // Main SELECT statement — ALWAYS includes both userid and pageid
    query.WriteString("SELECT DISTINCT s.userid, s.pageid\nFROM states s")

    // Add CTE joins if any
    if len(builder.cteJoins) > 0 {
        query.WriteString("\n")
        query.WriteString(strings.Join(builder.cteJoins, "\n"))
    }

    // Add WHERE clause (filters on conditions, never on pageid)
    if whereClause != "" {
        query.WriteString("\nWHERE ")
        query.WriteString(whereClause)
    }

    // Add LIMIT for safety
    query.WriteString(fmt.Sprintf("\nLIMIT %d", builder.queryLimit))

    return query.String(), builder.params, nil
}
```

**Key Line 55:**
```go
query.WriteString("SELECT DISTINCT s.userid, s.pageid\nFROM states s")
```

---

## 2. Condition Building (No PageID Filtering)

### File: `/exodus/query/builder.go` lines 88-108

```go
func (qb *QueryBuilder) buildSimpleCondition(cond *types.SimpleCondition) (string, error) {
    switch cond.Type {
    case "form":
        return qb.buildFormCondition(cond)           // s.current_form = $N
    case "state":
        return qb.buildStateCondition(cond)          // s.current_state = $N
    case "error_code":
        return qb.buildErrorCodeCondition(cond)      // s.state_json->'error'->>'code' = $N
    case "current_question":
        return qb.buildCurrentQuestionCondition(cond) // s.state_json->>'question' = $N
    case "elapsed_time":
        return qb.buildElapsedTimeCondition(cond)    // CTE + time filter
    case "question_response":
        return qb.buildQuestionResponseCondition(cond) // CTE + response filter
    case "surveyid":
        return qb.buildSurveyIDCondition(cond)       // Subquery on surveys
    default:
        return "", fmt.Errorf("unsupported condition type: %s", cond.Type)
    }
}
```

**Observation:** No case for "pageid". PageID never appears in WHERE clause filtering.

---

## 3. Executor: Query Execution and Result Processing

### File: `/exodus/executor/executor.go` lines 184-232

```go
func (e *Executor) queryUsers(ctx context.Context, dbBail *db.Bail,
    bailDef *types.BailDefinition, bailType string) ([]sender.UserTarget, error) {

    // Handle user_list type bails: skip query, convert UserList directly
    if bailType == "user_list" {
        if bailDef.UserList == nil {
            return nil, fmt.Errorf("user_list is nil for user_list-type bail")
        }
        log.Printf("Converting user_list to targets for bail %s", dbBail.Name)
        return userListToTargets(bailDef.UserList), nil
    }

    // Handle conditions-based bails: execute SQL query
    sql, params, err := query.BuildQuery(bailDef)
    if err != nil {
        return nil, fmt.Errorf("failed to build query: %w", err)
    }

    log.Printf("Executing query for bail %s", dbBail.Name)

    // Execute query
    rows, err := e.query.Query(ctx, sql, params...)
    if err != nil {
        return nil, fmt.Errorf("failed to execute query: %w", err)
    }

    // Convert results to UserTarget structs with resolved destination form
    var users []sender.UserTarget
    for _, row := range rows {                      // ← LOOP OVER ALL ROWS
        userID, ok := row["userid"].(string)
        if !ok {
            log.Printf("Warning: Invalid userid type in query result: %T", row["userid"])
            continue
        }

        pageID, ok := row["pageid"].(string)        // ← EXTRACT PAGEID FROM EACH ROW
        if !ok {
            log.Printf("Warning: Invalid pageid type in query result: %T", row["pageid"])
            continue
        }

        users = append(users, sender.UserTarget{    // ← CREATE USERTARGET FOR EACH ROW
            UserID:          userID,
            PageID:          pageID,
            DestinationForm: bailDef.Action.DestinationForm,
        })
    }

    return users, nil
}
```

**Key Insight:**
- Line 211: Loop over ALL rows (no LIMIT, no filtering, no selection)
- Line 218-222: Type-check pageid, skip if invalid
- Line 227: Use pageid as-is (no transformation)
- Line 231: Return all created UserTargets

---

## 4. User List Path (Direct Entry)

### File: `/exodus/executor/executor.go` lines 234-246

```go
func userListToTargets(ul *types.UserList) []sender.UserTarget {
    targets := make([]sender.UserTarget, len(ul.Users))
    for i, entry := range ul.Users {
        targets[i] = sender.UserTarget{
            UserID:          entry.UserID,
            PageID:          entry.PageID,          // ← From JSON, already validated
            DestinationForm: entry.Shortcode,
        }
    }
    return targets
}
```

**Key:** PageID from JSON input, validated beforehand, used as-is.

---

## 5. Validation: User List Entries

### File: `/exodus/types/types.go` lines 119-138

```go
func (ul *UserList) Validate() error {
    if len(ul.Users) == 0 {
        return fmt.Errorf("user_list must contain at least one user")
    }
    if len(ul.Users) > 1000 {
        return fmt.Errorf("user_list must contain at most 1000 users (got %d)", len(ul.Users))
    }
    for i, entry := range ul.Users {
        if entry.UserID == "" {
            return fmt.Errorf("userid is required at index %d", i)
        }
        if entry.PageID == "" {                     // ← VALIDATION CHECK
            return fmt.Errorf("pageid is required at index %d", i)
        }
        if entry.Shortcode == "" {
            return fmt.Errorf("shortcode is required at index %d", i)
        }
    }
    return nil
}
```

**Effect:** Rejects any user_list with missing/empty pageid.

---

## 6. Sender: Bailout Events

### File: `/exodus/sender/sender.go` lines 106-146

```go
func (s *Sender) SendBailouts(ctx context.Context, users []sender.UserTarget,
    metadata map[string]interface{}) ([]string, error) {
    var bailedIDs []string
    var lastError error

    for i, user := range users {                    // ← ITERATE ALL USERTARGETS
        select {
        case <-ctx.Done():
            return bailedIDs, fmt.Errorf("context cancelled after %d successful sends: %w",
                len(bailedIDs), ctx.Err())
        default:
        }

        // Send bailout for this user using their destination form
        err := s.SendBailout(ctx, user.UserID, user.PageID, user.DestinationForm, metadata)
        if err != nil {
            log.Printf("Failed to bail user=%s page=%s: %v", user.UserID, user.PageID, err)
            lastError = err
        } else {
            bailedIDs = append(bailedIDs, user.UserID)
        }

        // Apply rate limiting (except after the last user)
        if i < len(users)-1 && s.rateLimit > 0 {
            select {
            case <-ctx.Done():
                return bailedIDs, fmt.Errorf("context cancelled during rate limit after %d successful sends: %w",
                    len(bailedIDs), ctx.Err())
            case <-time.After(s.rateLimit):
            }
        }
    }

    if lastError != nil && len(bailedIDs) < len(users) {
        return bailedIDs, fmt.Errorf("failed to bail %d users, last error: %w",
            len(users)-len(bailedIDs), lastError)
    }

    return bailedIDs, nil
}
```

**Key Line 121:**
```go
err := s.SendBailout(ctx, user.UserID, user.PageID, user.DestinationForm, metadata)
```

Each UserTarget becomes one bailout event.

### Individual SendBailout Call

**File:** `/exodus/sender/sender.go` lines 57-104

```go
func (s *Sender) SendBailout(ctx context.Context, userID, pageID, destinationForm string,
    metadata map[string]interface{}) error {
    event := &BailoutEvent{
        User: userID,
        Page: pageID,                               // ← PageID sent unchanged
        Event: &EventDetail{
            Type: "bailout",
            Value: &BailValue{
                Form:     destinationForm,
                Metadata: metadata,
            },
        },
    }

    if s.dryRun {
        log.Printf("[DRY RUN] Would bail user=%s page=%s to form=%s with metadata=%v",
            userID, pageID, destinationForm, metadata)
        return nil
    }

    // Marshal event to JSON
    body, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("failed to marshal bailout event: %w", err)
    }

    // Create request with context
    req, err := http.NewRequestWithContext(ctx, "POST", s.botserverURL, bytes.NewBuffer(body))
    if err != nil {
        return fmt.Errorf("failed to create request: %w", err)
    }
    req.Header.Set("Content-Type", "application/json")

    // Send request
    resp, err := s.client.Do(req)
    if err != nil {
        return fmt.Errorf("failed to send bailout to botserver: %w", err)
    }
    defer resp.Body.Close()

    // Check response status
    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("botserver returned non-200 status: %d", resp.StatusCode)
    }

    log.Printf("Successfully bailed user=%s page=%s to form=%s", userID, pageID, destinationForm)
    return nil
}
```

**Key Line 220:**
```go
Page: pageID,  // ← Sent unchanged to botserver
```

---

## 7. Database Schema: States Table

### File: `/devops/migrations/01-init.sql` lines 109-115

```sql
CREATE TABLE IF NOT EXISTS chatroach.states(
       userid VARCHAR NOT NULL,
       pageid VARCHAR NOT NULL NOT NULL,           -- Enforced NOT NULL
       updated TIMESTAMPTZ NOT NULL,
       current_state VARCHAR NOT NULL,
       state_json JSON NOT NULL,
       PRIMARY KEY (userid, pageid),               -- Composite key
       ...
);
```

**Key Lines:**
- Line 111: `pageid VARCHAR NOT NULL` — enforced, no default
- Line 115: `PRIMARY KEY (userid, pageid)` — composite key allows multiple pageids per userid

---

## 8. Integration Tests: State Insertion

### File: `/exodus/query/db_integration_test.go` lines 72-84

```go
func insertState(t *testing.T, pool *pgxpool.Pool, userid, shortcode string) {
    t.Helper()
    stateJSON := `{"forms": ["` + shortcode + `"]}`
    _, err := pool.Exec(context.Background(), `
        INSERT INTO chatroach.states (userid, pageid, updated, current_state, state_json)
        VALUES ($1, $2, now(), 'RESPONDING', $3)
    `, userid, userid+"-page", stateJSON)
    if err != nil {
        t.Fatalf("insertState: %v", err)
    }
}
```

**Key:** Pageid is passed explicitly (`userid+"-page"`).

---

## Summary of Code Flow

```
SQL Built:    SELECT DISTINCT s.userid, s.pageid FROM states WHERE [conditions not filtering pageid]
    ↓
Query Executed: Returns ALL (userid, pageid) pairs matching conditions
    ↓
Executor Loop:  for _, row := range rows { /* process each row */ }
    ↓
PageID Extract: pageID, ok := row["pageid"].(string)
    ↓
UserTarget:     {UserID: userid, PageID: pageID, DestinationForm: ...}
    ↓
Sender Loop:    for _, user := range users { SendBailout(user.PageID) }
    ↓
Botserver:      POST {user: userid, page: pageid, event: ...}
```

**No selection or filtering of pageid at any step.**
