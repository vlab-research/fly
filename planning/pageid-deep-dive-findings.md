# PageID Selection in Bail Execution: Deep Dive Analysis

**Date:** 2026-03-22
**Investigator:** Claude Code (Exploration Agent)
**Status:** COMPLETE - Comprehensive Technical Analysis

---

## Executive Summary

The bail execution system's pageid selection is **straightforward and correct**. When a bail query executes and returns users, it returns **ALL pageids associated with matching users**, not a selected subset. Here's exactly what happens:

1. **SQL Query Pattern:** `SELECT DISTINCT s.userid, s.pageid FROM states s WHERE [conditions]`
   - Returns ALL `(userid, pageid)` combinations where userid matches the conditions
   - No filtering on pageid column itself
   - DISTINCT prevents duplicate (userid, pageid) pairs from the same states table

2. **Data Flow:**
   - Database stores composite key: `(userid, pageid)` in states table
   - Query execution returns **all matching combinations**
   - Executor creates a UserTarget for **each combination** returned
   - Each UserTarget sent separately to botserver

3. **Multi-Platform Reality:**
   - If a user has states on multiple pages: `(alice, page_fb_123)` AND `(alice, page_wa_456)`
   - Both rows returned from query
   - Both sent as separate bailout events
   - This is **intentional and correct**

---

## Part 1: How The SQL Query Works

### Query Builder Assembly

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go` (lines 44-72)

```go
// Main SELECT statement
query.WriteString("SELECT DISTINCT s.userid, s.pageid\nFROM states s")

// Add CTE joins if any (for elapsed_time, question_response conditions)
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
```

**Key Facts:**
- Line 55: Always selects `s.userid, s.pageid` from states table `s`
- Line 57-61: CTE joins are added if needed (for time-based conditions)
- Line 63-67: WHERE clause filters on state/form/question/responses—**NOT on pageid**
- No DISTINCT is applied at the column level; DISTINCT applies to the entire row

### What DISTINCT Actually Does

**Context:** The `SELECT DISTINCT` clause in line 55

```sql
SELECT DISTINCT s.userid, s.pageid FROM states s ...
```

**Effect:**
- Returns unique `(userid, pageid)` pairs
- Does NOT select "one pageid per user"
- Each unique combination is returned once (even if they match conditions multiple ways)

**Example:**
```sql
-- states table contents:
(userid: "alice", pageid: "fb_123", current_state: "RESPONDING")
(userid: "alice", pageid: "wa_456", current_state: "RESPONDING")
(userid: "bob",   pageid: "fb_123", current_state: "WAITING")

-- Query: SELECT DISTINCT s.userid, s.pageid FROM states s WHERE current_state = 'RESPONDING'
-- Returns:
(userid: "alice", pageid: "fb_123")  ← Alice on Facebook
(userid: "alice", pageid: "wa_456")  ← Alice on WhatsApp
```

**NOT:**
- `(alice, fb_123)` only
- `(alice, wa_456)` only
- The "first" or "last" pageid

---

## Part 2: No Filtering of PageID in WHERE Clause

### All Conditions are Checked BEFORE Pageid Selection

**Key Insight:** Pageid is **never part of the WHERE clause logic**.

Condition types in `/home/nandan/Documents/vlab-research/fly/exodus/types/types.go`:
- `form` → filters on `s.current_form`
- `state` → filters on `s.current_state`
- `error_code` → filters on `s.state_json->'error'->>'code'`
- `current_question` → filters on `s.state_json->>'question'`
- `elapsed_time` → joins CTEs, filters on time conditions
- `question_response` → joins response table, filters on responses
- `surveyid` → filters on `s.current_form IN (SELECT shortcode FROM surveys ...)`

**Evidence:** `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go` lines 88-108

```go
func (qb *QueryBuilder) buildSimpleCondition(cond *types.SimpleCondition) (string, error) {
    switch cond.Type {
    case "form":
        return qb.buildFormCondition(cond)        // s.current_form = $N
    case "state":
        return qb.buildStateCondition(cond)       // s.current_state = $N
    case "error_code":
        return qb.buildErrorCodeCondition(cond)   // s.state_json->'error'->>'code' = $N
    case "current_question":
        return qb.buildCurrentQuestionCondition(cond)  // s.state_json->>'question' = $N
    case "elapsed_time":
        return qb.buildElapsedTimeCondition(cond) // CTE join + time filter
    case "question_response":
        return qb.buildQuestionResponseCondition(cond) // CTE join + response filter
    case "surveyid":
        return qb.buildSurveyIDCondition(cond)    // Subquery on surveys table
    }
}
```

**No `case "pageid"` exists.** Pageid is never used in filtering logic.

---

## Part 3: How the Executor Processes Query Results

### Executor's queryUsers() Method

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 184-232)

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
    for _, row := range rows {                      // ← Iterate ALL rows
        userID, ok := row["userid"].(string)
        if !ok {
            log.Printf("Warning: Invalid userid type in query result: %T", row["userid"])
            continue
        }

        pageID, ok := row["pageid"].(string)        // ← Extract pageid from EACH row
        if !ok {
            log.Printf("Warning: Invalid pageid type in query result: %T", row["pageid"])
            continue
        }

        users = append(users, sender.UserTarget{    // ← Create UserTarget for EACH row
            UserID:          userID,
            PageID:          pageID,
            DestinationForm: bailDef.Action.DestinationForm,
        })
    }

    return users, nil
}
```

**Execution Flow:**

1. **Line 204:** Execute query against database
2. **Line 211:** Iterate over **all returned rows** (not a subset)
3. **Lines 218-222:** Extract pageid from **each row**
   - Type-check pageid (is it a string?)
   - Skip if invalid
   - **Use as-is if valid**
4. **Lines 224-228:** Create a UserTarget for **each row**
   - userid + pageid + destinationForm
5. **Line 231:** Return **all UserTargets**

**Critical Point:** There is **no deduplication, no selection, no "pick one pageid per user"** logic. Each row from the database becomes one UserTarget.

---

## Part 4: Sending Bailouts (Each Page Independently)

### Sender's SendBailouts() Method

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/sender/sender.go` (lines 106-146)

```go
func (s *Sender) SendBailouts(ctx context.Context, users []sender.UserTarget,
    metadata map[string]interface{}) ([]string, error) {
    var bailedIDs []string
    var lastError error

    for i, user := range users {                    // ← Iterate all UserTargets
        select {
        case <-ctx.Done():
            return bailedIDs, fmt.Errorf("context cancelled: %w", ctx.Err())
        default:
        }

        // Send bailout for this user using their destination form
        err := s.SendBailout(ctx, user.UserID, user.PageID, user.DestinationForm, metadata)
        if err != nil {
            log.Printf("Failed to bail user=%s page=%s: %v", user.UserID, user.PageID, err)
            lastError = err
            // Continue with remaining users even if one fails
        } else {
            bailedIDs = append(bailedIDs, user.UserID)
        }

        // Apply rate limiting (except after the last user)
        if i < len(users)-1 && s.rateLimit > 0 {
            select {
            case <-ctx.Done():
                return bailedIDs, fmt.Errorf("context cancelled: %w", ctx.Err())
            case <-time.After(s.rateLimit):
            }
        }
    }

    return bailedIDs, nil
}
```

**Key Points:**
- Line 112: Loops through **all UserTargets** (one per row from database)
- Line 121: Calls `SendBailout(ctx, user.UserID, user.PageID, user.DestinationForm)`
- **Each UserTarget is sent independently**
- **PageID is passed unchanged** to SendBailout

### Individual SendBailout() Call

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/sender/sender.go` (lines 57-104)

```go
func (s *Sender) SendBailout(ctx context.Context, userID, pageID, destinationForm string,
    metadata map[string]interface{}) error {
    event := &BailoutEvent{
        User: userID,
        Page: pageID,                               // ← PageID sent as-is
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

    body, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("failed to marshal bailout event: %w", err)
    }

    req, err := http.NewRequestWithContext(ctx, "POST", s.botserverURL, bytes.NewBuffer(body))
    if err != nil {
        return fmt.Errorf("failed to create request: %w", err)
    }
    req.Header.Set("Content-Type", "application/json")

    resp, err := s.client.Do(req)
    if err != nil {
        return fmt.Errorf("failed to send bailout to botserver: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("botserver returned non-200 status: %d", resp.StatusCode)
    }

    log.Printf("Successfully bailed user=%s page=%s to form=%s", userID, pageID, destinationForm)
    return nil
}
```

**What happens:**
1. Creates BailoutEvent with user/page/event
2. Marshals to JSON
3. Posts to botserver
4. Logs the bailout with userid and pageid

**JSON Sent to Botserver:**
```json
{
  "user": "<userid>",
  "page": "<pageid>",
  "event": {
    "type": "bailout",
    "value": {
      "form": "<destination_form>",
      "metadata": {}
    }
  }
}
```

---

## Part 5: Multi-User Case with Multiple PageIDs

### Concrete Example: User on Multiple Platforms

**Scenario:**
- User "alice" has Facebook messenger conversations on two different Facebook pages
- User "alice" also uses WhatsApp
- A bail matches alice based on `current_state = 'RESPONDING'`

**States Table:**
```
userid  | pageid              | current_state
--------|---------------------|---------------
alice   | facebook_page_123   | RESPONDING
alice   | facebook_page_456   | RESPONDING
alice   | whatsapp_wa_789     | WAITING
bob     | facebook_page_123   | RESPONDING
```

**Bail Conditions:**
```json
{
  "conditions": {"type": "state", "value": "RESPONDING"},
  "execution": {"timing": "immediate"},
  "action": {"destination_form": "exit-survey"}
}
```

**SQL Generated:**
```sql
SELECT DISTINCT s.userid, s.pageid
FROM states s
WHERE s.current_state = 'RESPONDING'
LIMIT 100000
```

**Query Result:**
```
userid  | pageid
--------|--------------------
alice   | facebook_page_123
alice   | facebook_page_456
bob     | facebook_page_123
```

**Executor Processing:**
```go
users := []sender.UserTarget{
    {UserID: "alice", PageID: "facebook_page_123", DestinationForm: "exit-survey"},
    {UserID: "alice", PageID: "facebook_page_456", DestinationForm: "exit-survey"},
    {UserID: "bob",   PageID: "facebook_page_123", DestinationForm: "exit-survey"},
}
```

**Bailouts Sent to Botserver:**
```
1. POST /synthetic
   {"user": "alice", "page": "facebook_page_123", "event": {...}}

2. POST /synthetic
   {"user": "alice", "page": "facebook_page_456", "event": {...}}

3. POST /synthetic
   {"user": "bob", "page": "facebook_page_123", "event": {...}}
```

**Result:** Alice gets **two separate bailout events**—one for each page she's on. This is **correct** because:
1. She has active states on both pages
2. Both match the condition
3. Each page has its own interaction context

---

## Part 6: Schema Verification

### States Table Primary Key

**File:** `/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql` (lines 109-162)

```sql
CREATE TABLE IF NOT EXISTS chatroach.states(
       userid VARCHAR NOT NULL,
       pageid VARCHAR NOT NULL NOT NULL,           -- ← Duplicate NOT NULL (typo?) but enforced
       updated TIMESTAMPTZ NOT NULL,
       current_state VARCHAR NOT NULL,
       state_json JSON NOT NULL,
       PRIMARY KEY (userid, pageid),               -- ← Composite primary key
       ...
);
```

**Key Facts:**
1. **Composite Primary Key:** `(userid, pageid)` together form the unique key
   - Same userid can appear multiple times (different pageids)
   - Same pageid can appear multiple times (different userids)
   - But `(userid, pageid)` pair must be unique

2. **Both Columns NOT NULL:**
   - `userid VARCHAR NOT NULL` — can never be null
   - `pageid VARCHAR NOT NULL` — can never be null
   - Database enforces this at insert time

3. **No Default Values:**
   - No `DEFAULT` clause for pageid
   - Row cannot be inserted without providing both columns
   - Replybot (upstream) responsible for providing both

---

## Part 7: Upstream: Where PageID Comes From (Replybot)

### getPageFromEvent() Function

**File:** `/home/nandan/Documents/vlab-research/fly/utils/lib/utils.js` (lines 40-55)

```javascript
function getPageFromEvent(event) {
  try {
    // Priority 1: Explicit page in synthetic events
    if (event.source === 'synthetic' && event.page) {
      return event.page
    }
    // Priority 2: Bot echo — use sender (the page that sent it)
    if (event.message && event.message.is_echo && event.sender.id) {
      return event.sender.id
    }
    // Priority 3: Normal case — use recipient (page being messaged)
    if (event.recipient.id) {
      return event.recipient.id
    }
  } catch (e) {}

  // Fail loud if all methods failed
  console.log('EVENT:\n', util.inspect(event, null, 8), '\n-----------------------\n')
  throw new Error('Could not get Facebook page from event!')
}
```

**How It Works:**
1. **Synthetic events** (explicit page field): Use that page
2. **Bot echoes** (message is_echo flag): Use sender.id (the page that sent the message)
3. **Normal events** (real user messages): Use recipient.id (the page being messaged)
4. **All fail**: Throw error (no silent defaults)

**Critical:** This function THROWS if pageid cannot be extracted. The system fails loudly rather than silently defaulting.

---

## Part 8: Data Validation Points

### Input Validation: User List Bails

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/types/types.go` (lines 119-138)

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
        if entry.PageID == "" {                    // ← Explicit check
            return fmt.Errorf("pageid is required at index %d", i)
        }
        if entry.Shortcode == "" {
            return fmt.Errorf("shortcode is required at index %d", i)
        }
    }
    return nil
}
```

**Effect:**
- Every UserListEntry must have non-empty pageid
- Dashboard/API rejects bail definitions with missing pageids
- Validation happens **before** any execution

---

## Part 9: Type Safety in Executor

### Type Assertion and Error Handling

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 218-222)

```go
pageID, ok := row["pageid"].(string)
if !ok {
    log.Printf("Warning: Invalid pageid type in query result: %T", row["pageid"])
    continue                                       // ← Skip this row
}
```

**Behavior:**
- Type-asserts pageid to string
- If assertion fails (e.g., pageid is null, number, or unknown type):
  - Log warning with actual type
  - Skip the row (don't create UserTarget)
  - Continue with next row
- No silent default or fallback

---

## Part 10: User List Bails (Direct Entry Path)

### UserListToTargets Function

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/executor.go` (lines 234-246)

```go
func userListToTargets(ul *types.UserList) []sender.UserTarget {
    targets := make([]sender.UserTarget, len(ul.Users))
    for i, entry := range ul.Users {
        targets[i] = sender.UserTarget{
            UserID:          entry.UserID,
            PageID:          entry.PageID,         // ← Direct from JSON
            DestinationForm: entry.Shortcode,     // ← Per-user destination form
        }
    }
    return targets
}
```

**Key Difference from Conditions-Based:**
- Pageid comes from JSON input instead of database query
- But once in UserTarget, treated identically
- Each entry is separate bailout

---

## Part 11: Test Evidence

### Unit Tests

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/executor/executor_test.go`

Mock query results demonstrate expected format:

```go
// Line 191-192
results: []map[string]interface{}{
    {"userid": "user1", "pageid": "page1"},
}

// Line 226-228
results: []map[string]interface{}{
    {"userid": "user1", "pageid": "page1"},
    {"userid": "user2", "pageid": "page2"},
}

// Line 432-434
results: []map[string]interface{}{
    {"userid": "user1", "pageid": "page1"},
    {"userid": "user2", "pageid": "page2"},
    {"userid": "user3", "pageid": "page3"},
}
```

**Observation:** Tests expect **each row to have both userid and pageid**, and **all rows are processed**.

### Integration Tests

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/query/db_integration_test.go` (lines 72-84)

```go
func insertState(t *testing.T, pool *pgxpool.Pool, userid, shortcode string) {
    t.Helper()
    stateJSON := `{"forms": ["` + shortcode + `"]}`
    _, err := pool.Exec(context.Background(), `
        INSERT INTO chatroach.states (userid, pageid, updated, current_state, state_json)
        VALUES ($1, $2, now(), 'RESPONDING', $3)
    `, userid, userid+"-page", stateJSON)  // ← pageid = userid+"-page"
}

// Line 110-114
var userid, pageid string
for rows.Next() {
    if err := rows.Scan(&userid, &pageid); err != nil { ... }
    userids = append(userids, userid)
}
```

**Observation:** Integration tests verify that:
1. States are inserted with pageid
2. Queries return pageid
3. Both are scanned and processed

---

## Part 12: Comparing with Surveys/Forms

### Why Pageid is Different from Shortcode

**Shortcode** (form identifier):
- Lives in `surveys.shortcode` column
- Referenced by `states.current_form` (stored JSON field)
- Controlled by survey configuration
- Can change if survey version changes
- Bail can target specific forms via surveyid condition

**PageID** (platform identifier):
- Lives in `states.pageid` column (part of primary key)
- Derived from event metadata (Facebook page ID, WhatsApp number, etc.)
- Set by upstream (replybot) based on webhook
- Cannot change unless new state created
- **Not used in bail filtering conditions**

**Key Insight:** Bail conditions never filter on pageid. They filter on forms, states, responses, etc. The pageid is **orthogonal** to condition matching.

---

## Part 13: CTE Handling and Pageid Preservation

### Question Response CTE Example

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go` (lines 202-242)

```go
func (qb *QueryBuilder) buildQuestionResponseCondition(cond *types.SimpleCondition) (string, error) {
    // ...

    var cte string
    if cond.Response != nil {
        responseParam := qb.addParam(*cond.Response)
        cte = fmt.Sprintf(`%s AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d AND response = $%d
)`, cteName, formParam, questionParam, responseParam)
    } else {
        cte = fmt.Sprintf(`%s AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
)`, cteName, formParam, questionParam)
    }

    qb.ctes = append(qb.ctes, cte)
    qb.cteJoins = append(qb.cteJoins,
        fmt.Sprintf("LEFT JOIN %s %s ON s.userid = %s.userid", cteName, alias, alias))

    return fmt.Sprintf("%s.userid IS NOT NULL", alias), nil
}
```

**What Happens:**
1. CTE selects only `userid` from responses table
2. JOIN matches users in CTE to states table by userid
3. **Main SELECT still uses `s.userid, s.pageid`** (from states table)
4. Pageid is not lost—it comes from the states table, not the CTE

**Generated SQL:**
```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2
)
SELECT DISTINCT s.userid, s.pageid            -- ← Pageid from states
FROM states s
LEFT JOIN question_responses_0 qr0 ON s.userid = qr0.userid
WHERE qr0.userid IS NOT NULL
```

---

## Part 14: Elapsed Time CTE Example

**File:** `/home/nandu/Documents/vlab-research/fly/exodus/query/builder.go` (lines 150-200)

```go
func (qb *QueryBuilder) buildElapsedTimeCondition(cond *types.SimpleCondition) (string, error) {
    // ...

    cteName := fmt.Sprintf("response_times_%d", qb.cteIndex)
    qb.cteIndex++

    formParam := qb.addParam(cond.Since.Details.Form)
    questionParam := qb.addParam(cond.Since.Details.QuestionRef)
    durationParam := qb.addParam(*cond.Duration)

    cte := fmt.Sprintf(`%s AS (
    SELECT userid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
    GROUP BY userid
)`, cteName, formParam, questionParam)

    qb.ctes = append(qb.ctes, cte)

    joinClause := fmt.Sprintf("LEFT JOIN %s rt%d ON s.userid = rt%d.userid",
        cteName, qb.cteIndex-1, qb.cteIndex-1)
    qb.cteJoins = append(qb.cteJoins, joinClause)

    return fmt.Sprintf("rt%d.response_time + $%d::INTERVAL < NOW()",
        qb.cteIndex-1, durationParam), nil
}
```

**Result:**
```sql
WITH response_times_0 AS (
    SELECT userid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2
    GROUP BY userid
)
SELECT DISTINCT s.userid, s.pageid            -- ← Pageid from states
FROM states s
LEFT JOIN response_times_0 rt0 ON s.userid = rt0.userid
WHERE rt0.response_time + $3::INTERVAL < NOW()
```

**Key:** Even with CTEs, the SELECT clause always pulls pageid from the states table.

---

## Part 15: Real-World Scenario: OR Conditions

### The LEFT JOIN Fix for OR Semantics

**Issue Fixed (from integration test):** When using OR conditions with question_response, multiple CTEs need LEFT JOINs to work correctly.

**File:** `/home/nandan/Documents/vlab-research/fly/exodus/query/builder.go` (line 239)

```go
qb.cteJoins = append(qb.cteJoins,
    fmt.Sprintf("LEFT JOIN %s %s ON s.userid = %s.userid", cteName, alias, alias))
```

**Why LEFT JOIN?** If we used INNER JOIN for OR conditions:
- User answers question_response_A: matches first CTE, skipped by second CTE → no result
- Correct: OR means "match if either is true"
- LEFT JOIN allows unmatched CTEs to return NULL, OR logic still works

**Does this affect pageid?** No:
- LEFT JOINs only affect filtering
- Pageid still comes from states table
- All matching `(userid, pageid)` pairs still returned

---

## Part 16: What Does NOT Happen

### Myths Debunked

**Myth 1: "Only one pageid per user is returned"**
- **Reality:** All pageids associated with matching userid are returned
- **Evidence:** DISTINCT applies to whole row, not per-user
- **Code:** executor.go loops over ALL rows, creates UserTarget for EACH

**Myth 2: "First pageid is chosen if multiple exist"**
- **Reality:** No "first" selection logic exists in code
- **Evidence:** No `LIMIT 1`, no `ORDER BY`, no `MIN()` or `MAX()`
- **Code:** Query returns all rows, executor processes all

**Myth 3: "Default pageid used if missing"**
- **Reality:** Schema enforces NOT NULL, replybot throws error if missing
- **Evidence:** `/devops/migrations/01-init.sql` has `pageid VARCHAR NOT NULL`
- **Code:** executor.go type-checks and skips if invalid, doesn't default

**Myth 4: "Bail system selects which page to bail"**
- **Reality:** Bail system doesn't select; it sends to all matching pageids
- **Evidence:** No filtering on pageid in WHERE clause
- **Code:** sendBailouts() loops and sends to each UserTarget

**Myth 5: "OR conditions might pick wrong pageid"**
- **Reality:** OR conditions don't affect pageid selection
- **Evidence:** pageid not in WHERE clause, all matches returned
- **Code:** builder.go never includes pageid in condition SQL

---

## Summary: What Actually Happens

### Step-by-Step Execution

1. **User triggers state update** (replybot)
   - `getPageFromEvent(event)` extracts pageid from webhook
   - Throws error if pageid cannot be determined
   - State stored: `(userid, pageid, updated, current_state, state_json)`

2. **Bail definition executed** (exodus executor)
   - Load enabled bails from database
   - Parse JSON definition

3. **Condition matching** (query builder)
   - Build SQL: `SELECT DISTINCT s.userid, s.pageid FROM states s WHERE [conditions]`
   - Conditions filter on state/form/responses, never pageid
   - Execute query

4. **Result processing** (executor)
   - Get all `(userid, pageid)` pairs matching conditions
   - For each pair:
     - Type-check pageid (must be string)
     - Create UserTarget(userid, pageid, destinationForm)
     - Add to list

5. **Bailout sending** (sender)
   - For each UserTarget:
     - Create BailoutEvent with user/page/event
     - POST to botserver
     - Log the send

6. **Result:**
   - One bailout per `(userid, pageid)` combination
   - If user has multiple pageids matching conditions: multiple bailouts sent
   - Each bailout targets the specific pageid

---

## Key Code References

| Location | Purpose | Key Line |
|----------|---------|----------|
| `/exodus/query/builder.go:55` | SQL SELECT | `SELECT DISTINCT s.userid, s.pageid` |
| `/exodus/executor/executor.go:219-230` | Extract pageid | Type-check and use as-is |
| `/exodus/executor/executor.go:235-247` | User list path | Direct from JSON entry |
| `/exodus/sender/sender.go:59-69` | Create event | Pass pageID unchanged |
| `/exodus/sender/sender.go:121` | Send loop | userTarget.PageID |
| `/devops/migrations/01-init.sql:115` | Schema | PRIMARY KEY (userid, pageid) |
| `/utils/lib/utils.js:40-55` | Upstream | getPageFromEvent() throws |

---

## Conclusion

**The pageid selection mechanism is simple, transparent, and correct:**

1. **No selection happens** — query returns all matching pageids
2. **No filtering on pageid** — conditions filter on other columns
3. **No defaults** — schema and upstream enforce NOT NULL
4. **No transformation** — pageid passed unchanged through pipeline
5. **Multi-platform support** — intentional design for users on multiple pages

The system elegantly handles:
- Users on single page: one bailout
- Users on multiple pages: separate bailout per page (correct!)
- Conditions with OR/AND/NOT: all matching pageids returned
- CTEs for time-based conditions: pageid preserved from states table

**The implementation is safe, correct, and maintainable.**
