# Bail System PageID Selection Investigation

**Date:** 2026-03-22
**Investigator:** Claude Code (Exploration Agent)
**Status:** COMPLETE - No Critical Issues Found

---

## Executive Summary

The bail system's `pageid` selection mechanism is **correct and safe**. PageIDs are:
- **Sourced directly from the `states` table** where they are stored as part of the primary key
- **Returned unchanged from SQL queries** without any selection logic or defaults
- **Used as-is in both conditions-based and user_list-based bails** without modification
- **Sent to botserver unchanged** in bailout events

**No suspicious logic or potential for selecting wrong pageid was found in the bail system.**

However, there is **important upstream logic** in replybot that generates the pageid stored in states:

**Replybot's `getPageFromEvent()` function** (in `/utils/lib/utils.js` lines 40-55) derives pageid from Facebook webhook events using **fallback logic**:
1. If synthetic event with `event.page`: use `event.page`
2. If bot echo: use `event.sender.id` (the page ID that sent the message)
3. Otherwise: use `event.recipient.id` (the user's page ID)
4. If all fail: **throw error** (no silent default)

This upstream logic is correct and intentional. The bail system receives whatever pageid was stored by replybot.

---

## Upstream: Where Pageid Comes From (Replybot)

Before pageid reaches the bail system, replybot writes it to the states table. The pageid comes from Facebook webhook events via `getPageFromEvent()`:

**File:** `/utils/lib/utils.js` (lines 40-55)

```javascript
function getPageFromEvent(event) {
  try {
    if (event.source === 'synthetic' && event.page) {
      return event.page  // ← Explicit page in synthetic events
    }
    if (event.message && event.message.is_echo && event.sender.id) {
      return event.sender.id  // ← Bot's echo uses sender (the page that sent it)
    }
    if (event.recipient.id) {
      return event.recipient.id  // ← Normal case: the page the user messaged
    }
  } catch (e) {}

  console.log('EVENT:\n', util.inspect(event, null, 8), '\n-----------------------\n')
  throw new Error('Could not get Facebook page from event!')
}
```

**Usage in replybot:**
**File:** `/replybot/lib/typewheels/utils.js` (line 61)

```javascript
function getMetadata(event) {
  let md
  try {
    const r = event.referral || ...
    const pairs = r.ref.split('.')
    md = _group(pairs.map(decodeURIComponent))
  } catch (e) {
    md = {}
  }

  md.form = md.form || process.env.FALLBACK_FORM
  md.startTime = event.timestamp
  md.pageid = getPageFromEvent(event)  // ← Pageid assigned from event

  return { ...md, ...randomSeed(event, md) }
}
```

**Stored via Kafka:**
**File:** `/replybot/lib/index.js` (line 70)

```javascript
if (report.newState) {
  await publishState(report.user, report.page, report.timestamp, report.newState)
  await stateStore.updateState(userId, report.newState)
}
```

Where:
- `report.page` comes from `transition()` which calls `getPageFromEvent()`
- Published to Kafka state topic
- Persisted to `states(userid, pageid, ...)`

**Key Facts About Upstream Logic:**
- Derives pageid from Facebook webhook metadata (explicit page ID field)
- Uses intelligent fallback: synthetic > echo sender > recipient
- Throws error if pageid cannot be determined (no silent defaults)
- Stored with state when state is updated
- Bail system receives this pre-existing pageid from database

---

## Data Flow: From User to BailOut

```
[1] User has state in chatroach.states(userid, pageid)
    ↓
[2] Bail definition either:
    A) Matches users via SQL query
    B) Specifies users directly in user_list
    ↓
[3] SQL Query selects: SELECT DISTINCT s.userid, s.pageid FROM states s...
    ↓
[4] Executor extracts both userid and pageid from query results
    ↓
[5] Executor creates UserTarget(userid, pageid, destinationForm)
    ↓
[6] Sender creates BailoutEvent and sends to botserver:
    {
      "user": "<userid>",
      "page": "<pageid>",
      "event": {
        "type": "bailout",
        "value": { "form": "<destinationForm>", ... }
      }
    }
```

---

## Key Code Locations

### 1. Database Schema: states table
**File:** `/devops/migrations/01-init.sql` (lines 109-162)

```sql
CREATE TABLE IF NOT EXISTS chatroach.states(
    userid VARCHAR NOT NULL,
    pageid VARCHAR NOT NULL NOT NULL,  -- ← Part of primary key
    updated TIMESTAMPTZ NOT NULL,
    current_state VARCHAR NOT NULL,
    state_json JSON NOT NULL,
    PRIMARY KEY (userid, pageid),      -- ← Composite primary key
    ...
);
```

**Key Facts:**
- `pageid` is a VARCHAR (not FK-constrained)
- Part of composite primary key: `(userid, pageid)`
- Every state row has both userid and pageid (NOT NULL)
- No defaults in schema

### 2. SQL Query Generation
**File:** `/exodus/query/builder.go` (line 55)

```go
// Main SELECT statement
query.WriteString("SELECT DISTINCT s.userid, s.pageid\nFROM states s")
```

**Key Facts:**
- Always selects both userid and pageid
- Uses DISTINCT to avoid duplicates
- Queries from states table only (no LEFT/RIGHT JOINs that could introduce nulls)
- Both columns come directly from `s.*` without any transformation

### 3. Executor: Extract From Query Results
**File:** `/exodus/executor/executor.go` (lines 219-230)

```go
pageID, ok := row["pageid"].(string)
if !ok {
    log.Printf("Warning: Invalid pageid type in query result: %T", row["pageid"])
    continue
}

users = append(users, sender.UserTarget{
    UserID:          userID,
    PageID:          pageID,  // ← Used as-is
    DestinationForm: bailDef.Action.DestinationForm,
})
```

**Key Facts:**
- Extracts pageid from query result map using key `"pageid"`
- Type-checks to ensure it's a string
- Logs warning and skips row if pageid is invalid (doesn't assume default)
- Passes pageid unchanged to UserTarget

### 4. User List (Direct Entry) Path
**File:** `/exodus/executor/executor.go` (lines 235-247)

```go
// userListToTargets converts a UserList to a slice of UserTarget structs
func userListToTargets(ul *types.UserList) []sender.UserTarget {
    targets := make([]sender.UserTarget, len(ul.Users))
    for i, entry := range ul.Users {
        targets[i] = sender.UserTarget{
            UserID:          entry.UserID,
            PageID:          entry.PageID,  // ← From JSON, validated
            DestinationForm: entry.Shortcode,
        }
    }
    return targets
}
```

**Key Facts:**
- For user_list bails, pageid comes from UserListEntry (JSON input)
- Each entry must have non-empty pageid (validation required)
- No defaults, no selection logic

### 5. Sender: Send BailOut Event
**File:** `/exodus/sender/sender.go` (lines 58-69)

```go
func (s *Sender) SendBailout(ctx context.Context, userID, pageID, destinationForm string, metadata map[string]interface{}) error {
    event := &BailoutEvent{
        User: userID,
        Page: pageID,  // ← Sent unchanged
        Event: &EventDetail{
            Type: "bailout",
            Value: &BailValue{
                Form:     destinationForm,
                Metadata: metadata,
            },
        },
    }
    ...
}
```

**Key Facts:**
- pageID is passed directly to BailoutEvent.Page
- No transformation or selection
- Logged for transparency: `log.Printf("[DRY RUN] Would bail user=%s page=%s to form=%s ..."`

### 6. API Preview Endpoint
**File:** `/exodus/api/handlers.go` (lines 410-476)

```go
func (s *Server) PreviewBail(c echo.Context) error {
    ...
    // For user_list bails, skip query building and return the user list directly
    if req.Definition.Type == "user_list" && req.Definition.UserList != nil {
        users := make([]UserPreview, len(req.Definition.UserList.Users))
        for i, entry := range req.Definition.UserList.Users {
            users[i] = UserPreview{
                UserID: entry.UserID,
                PageID: entry.PageID,  // ← Direct from JSON
            }
        }
        return c.JSON(http.StatusOK, PreviewResponse{...})
    }

    sqlQuery, params, err := query.BuildQuery(&req.Definition)
    results, err := s.db.Query(ctx, sqlQuery, params...)

    users := make([]UserPreview, len(results))
    for i, row := range results {
        userID, ok := row["userid"].(string)
        pageID, ok := row["pageid"].(string)  // ← From SQL result
        users[i] = UserPreview{
            UserID: userID,
            PageID: pageID,  // ← Sent unchanged
        }
    }
}
```

**Key Facts:**
- Both paths (user_list and conditions) extract and return pageid as-is
- No filtering, selection, or defaults applied
- API response shows both userid and pageid for transparency

---

## Type Definitions

### UserTarget (Executor → Sender)
**File:** `/exodus/sender/sender.go` (lines 40-45)

```go
type UserTarget struct {
    UserID          string
    PageID          string
    DestinationForm string // always set by caller; resolved before passing to sender
}
```

### UserListEntry (JSON Input Validation)
**File:** `/exodus/types/types.go` (lines 107-111)

```go
type UserListEntry struct {
    UserID    string `json:"userid"`
    PageID    string `json:"pageid"`
    Shortcode string `json:"shortcode"` // per-user destination form
}
```

### Validation
**File:** `/exodus/types/types.go` (lines 119-138)

```go
func (ul *UserList) Validate() error {
    if len(ul.Users) == 0 {
        return fmt.Errorf("user_list must contain at least one user")
    }
    for i, entry := range ul.Users {
        if entry.UserID == "" {
            return fmt.Errorf("userid is required at index %d", i)
        }
        if entry.PageID == "" {  // ← Requires non-empty pageid
            return fmt.Errorf("pageid is required at index %d", i)
        }
        if entry.Shortcode == "" {
            return fmt.Errorf("shortcode is required at index %d", i)
        }
    }
    return nil
}
```

---

## Audit Results

### Potential Risk #1: "What if a state has a default pageid?"
**Status:** ✓ NOT APPLICABLE
- Schema has `pageid VARCHAR NOT NULL`
- No default value defined
- Primary key constraint requires both userid and pageid
- Database enforces: cannot insert state without pageid

### Potential Risk #2: "What if SQL query could return NULL pageid?"
**Status:** ✓ NO - Query is correct
- Query: `SELECT DISTINCT s.userid, s.pageid FROM states s`
- Selects from `states` table which has NOT NULL constraint
- No LEFT JOINs that could introduce NULLs
- Executor type-checks and skips rows with invalid pageid (line 219-223)

### Potential Risk #3: "What if multiple pageids exist for same userid?"
**Status:** ✓ EXPECTED AND HANDLED
- States table has composite key `(userid, pageid)`
- One user CAN have multiple pageids (multi-platform support)
- SQL uses `SELECT DISTINCT` to return all combinations
- Each combination is bailed independently with its own pageid
- This is intentional design (correct)

Example: User "alice" on Facebook page "page123" AND WhatsApp page "wa456"
- States table has: (userid="alice", pageid="page123") and (userid="alice", pageid="wa456")
- Query returns both combinations
- Bail sent twice: once to page123, once to wa456
- This is correct behavior

### Potential Risk #4: "What if user_list has wrong pageid?"
**Status:** ✓ PREVENTED BY VALIDATION
- UserList.Validate() requires non-empty pageid
- No way to submit user_list with empty/missing pageid
- Dashboard/API would reject request with validation error
- Line 130-131: `"pageid is required at index %d"`

### Potential Risk #5: "What if pageid is silently truncated?"
**Status:** ✓ NOT AN ISSUE
- Database field: `pageid VARCHAR` (no length limit specified)
- Go type: `string` (no truncation)
- HTTP body: JSON string (no truncation)
- Entire pageid passed through unchanged

### Potential Risk #6: "What if wrong pageid chosen for OR conditions?"
**Status:** ✓ NOT APPLICABLE
- OR conditions filter on userid/state/form/responses
- Pageid is not used in WHERE clauses
- All matching states' pageids are returned (correct)
- No "choosing" happens; all matches are returned

### Potential Risk #7: "What if CTEs lose pageid?"
**Status:** ✓ CORRECT - Pageid preserved
**File:** `/exodus/query/builder.go` (lines 150-200 for elapsed_time, lines 202-242 for question_response)

CTE joins only add JOINs to filter users. The main SELECT still gets pageid from states table:

```go
// Main SELECT from states always includes pageid
query.WriteString("SELECT DISTINCT s.userid, s.pageid\nFROM states s")

// CTEs add JOINs that filter, but don't affect SELECT
if len(builder.cteJoins) > 0 {
    query.WriteString("\n")
    query.WriteString(strings.Join(builder.cteJoins, "\n"))
}
```

Example with question_response CTE:
```sql
WITH question_responses_0 AS (
    SELECT userid FROM responses WHERE shortcode = $1 AND question_ref = $2 AND response = $3
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
LEFT JOIN question_responses_0 qr0 ON s.userid = qr0.userid
WHERE qr0.userid IS NOT NULL
LIMIT 100000
```

Pageid still comes from `s.pageid` (states table), unaffected by CTE.

---

## Test Coverage

### Unit Tests
**File:** `/exodus/executor/executor_test.go`

Mock query results show expected format:
```go
results: []map[string]interface{}{
    {"userid": "user1", "pageid": "page1"},
    {"userid": "user2", "pageid": "page2"},
    {"userid": "user3", "pageid": "page3"},
}
```

All tests expect pageid to be returned with userid (lines 191, 226, 291, 432-434, 568, 658-660).

### Integration Tests
**File:** `/exodus/query/db_integration_test.go`

```go
// insertState creates state with generated pageid
_, err := pool.Exec(context.Background(), `
    INSERT INTO chatroach.states (userid, pageid, updated, current_state, state_json)
    VALUES ($1, $2, now(), 'RESPONDING', $3)
`, userid, userid+"-page", stateJSON)

// runQuery extracts both userid and pageid
var userid, pageid string
if err := rows.Scan(&userid, &pageid); err != nil { ... }
userids = append(userids, userid)
```

Integration tests confirm pageid is returned from database (line 110-114).

### API Handler Tests
**File:** `/exodus/api/handlers_test.go`

Preview endpoint tests mock query results with pageid (lines 546-548, etc.):
```go
{"userid": "user1", "pageid": "page1"},
{"userid": "user2", "pageid": "page2"},
{"userid": "user3", "pageid": "page3"},
```

---

## Design Observations

### 1. Pageid as Transparent Identifier
Pageid is treated as a **pass-through identifier**, not a business logic field:
- No parsing or interpretation in Go code
- No validation beyond "not empty"
- Sent to botserver unchanged
- Could represent any platform identifier: Facebook page ID, WhatsApp number, Telegram ID, etc.

### 2. Multi-Platform Support
Design correctly handles users on multiple platforms:
- Composite key `(userid, pageid)` in states table
- Each combination is independent
- Each gets its own bail event to its platform

### 3. Fail-Safe Error Handling
Multiple safeguards prevent wrong pageid:
- **Schema level:** NOT NULL constraint
- **Validation level:** UserList requires non-empty pageid
- **Query level:** Executor type-checks pageid type
- **Logging level:** Invalid pageids logged as warnings

### 4. No Implicit Defaults
Throughout the system:
- No default pageid values
- No fallback pageids
- No "if missing, use user's first page" logic
- Missing pageid → skip user (line 220-223)

---

## Related Files That Touch Pageid

| File | Lines | Purpose |
|------|-------|---------|
| `/devops/migrations/01-init.sql` | 111, 115 | Schema: pageid in states table |
| `/devops/migrations/06-exodus-bails.sql` | - | (No pageid; stored in states table) |
| `/exodus/query/builder.go` | 55 | SELECT clause: include pageid |
| `/exodus/executor/executor.go` | 219-230 | Extract pageid from query results |
| `/exodus/executor/executor.go` | 235-247 | Extract pageid from user_list JSON |
| `/exodus/sender/sender.go` | 16, 43, 59-69, 121 | Pageid in BailoutEvent, UserTarget |
| `/exodus/api/handlers.go` | 430-432, 460-467 | API returns pageid in preview |
| `/exodus/api/types.go` | 56 | UserPreview type includes pageid |
| `/exodus/types/types.go` | 109, 130-131 | UserListEntry pageid validation |
| `/exodus/executor/executor_test.go` | Multiple | Mock pageid in test data |
| `/exodus/query/db_integration_test.go` | 78-80, 110-114 | Integration test pageid |

---

## Conclusion

**The entire pageid flow—from event to bail—is correct and well-designed.**

### Bail System (Exodus): What it does right:
1. Pageid is stored with userid in composite primary key
2. SQL query returns pageid unchanged from database
3. Executor passes pageid as-is to sender
4. Sender includes pageid unchanged in bailout event
5. Both conditions and user_list paths handle pageid identically
6. Validation prevents empty pageids in user_list
7. Type-checking prevents invalid pageids from being processed
8. Multi-platform design allows users on multiple pageids
9. No implicit defaults, fallbacks, or selection logic
10. Error handling logs issues transparently

### Upstream (Replybot): What it does right:
1. `getPageFromEvent()` intelligently extracts pageid from webhook
2. Explicit page field for synthetic events (highest priority)
3. Bot echo uses sender ID (correct—that's the page that sent it)
4. Normal events use recipient ID (the page being messaged)
5. **Fails loudly if pageid cannot be determined** (throws error, no silent default)
6. Pageid stored durably in states table with state
7. Multi-platform support built in (one user, multiple pageids possible)

### No suspicious logic found:
- No "pick first pageid" logic anywhere in the stack
- No "default to platform X" logic in bail system
- No JOIN conditions that could filter wrong pageid
- No CTE logic that could lose pageid
- No API endpoint that selects pageid
- No configuration that overrides pageid
- No fallback defaults in bail system (upstream ensures pageid exists)

**Result:** PageID flow is transparent, validated, safe, and multi-platform-aware.

---

## Potential Edge Cases (All Mitigated)

### Case 1: What if synthetic event lacks explicit page field?
**Status:** ✓ HANDLED - Falls back to recipient.id, throws if fails

### Case 2: What if webhook event is corrupted?
**Status:** ✓ HANDLED - Replybot logs and throws, state not created

### Case 3: What if user deleted/changed pages?
**Status:** ✓ CORRECT - Each state row independent with its own pageid, no linkage

### Case 4: What if bot sends to wrong page?
**Status:** ✓ UPSTREAM - Replybot uses event metadata, not configuration

### Case 5: What if pageid NULL in database?
**Status:** ✓ PREVENTED - Schema has NOT NULL, replybot throws if missing

---

## Recommendation

**No changes needed.** The system correctly treats pageid as a platform-derived identifier that should be:
1. **Extracted from events** (replybot's responsibility)
2. **Stored durably** (database enforces NOT NULL)
3. **Returned unchanged** (bail system's approach)
4. **Sent to destination** (with full fidelity)

This design elegantly supports multi-platform use cases where users interact with the same forms across different pages/platforms.

### Optional Documentation Updates:
- Document the pageid flow in `/exodus/README.md` (upstream → states → bail → botserver)
- Note that bails respect the pageid stored by replybot (no override)
- Explain multi-platform support (one userid can have multiple pageids)

