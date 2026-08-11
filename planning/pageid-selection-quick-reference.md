# PageID Selection: Quick Reference

**Status:** ✓ SAFE - No issues found

---

## TL;DR

PageIDs in the bail system are:
1. **Stored** in `states(userid, pageid)` composite primary key
2. **Selected** via `SELECT DISTINCT s.userid, s.pageid FROM states s` (no filtering of pageid)
3. **Passed** unchanged through executor → sender → botserver
4. **Validated** at input (user_list) to reject empty pageids
5. **Type-checked** at extraction (executor) to skip invalid rows

**No selection logic, defaults, or suspicious behavior found.**

---

## Quick Facts

| Aspect | Details |
|--------|---------|
| **Source** | Database `states` table (part of primary key) |
| **Selection** | All pageids returned for matching userid |
| **Transformation** | None - passed unchanged |
| **Validation** | Non-empty required (user_list); type-check (executor) |
| **Error handling** | Logs warning and skips if invalid type |
| **Multi-platform** | Correct: user can have multiple pageids |
| **Defaults** | None (would be a bug if there were) |

---

## Code Paths

### For Conditions-Based Bails:
```
SQL Query Execution
  ↓ Returns: [(userid, pageid), ...]
Executor queryUsers()
  ↓ Line 219: pageID, ok := row["pageid"].(string)
  ↓ Line 227: PageID: pageID,
UserTarget Creation
  ↓ Passed to Sender
Sender.SendBailouts()
  ↓ Line 121: user.PageID
BailoutEvent Creation
  ↓ Page: pageID,
Sent to botserver
```

### For User List Bails:
```
JSON Input: UserList.Users[].PageID
  ↓ Validation (line 130): pageid required, non-empty
UserListToTargets()
  ↓ Line 242: PageID: entry.PageID,
UserTarget Creation
  ↓ Passed to Sender
[Rest is identical to conditions path]
```

---

## Where PageID Comes From

| Bail Type | Source | Storage |
|-----------|--------|---------|
| **Conditions-based** | SQL query result | From `states.pageid` column |
| **User list** | JSON input | From `user_list[].pageid` field |

Both ultimately respect what's in the database or what user explicitly provides.

---

## Validation Points

| Level | Validation | Code Location |
|-------|-----------|---|
| **Schema** | NOT NULL constraint | `/devops/migrations/01-init.sql` line 111 |
| **API Input** | NonEmpty required | `/exodus/types/types.go` line 130 |
| **Executor** | Type check (string) | `/exodus/executor/executor.go` line 220 |
| **Executor** | Skip if invalid | `/exodus/executor/executor.go` line 222 |

---

## Potential Issues Checked (All Resolved)

| Concern | Status | Why |
|---------|--------|-----|
| Default pageid used? | ✓ NO | Schema has NOT NULL, no defaults |
| Query returns NULL? | ✓ NO | States table has NOT NULL, no LEFT JOINs |
| Wrong pageid selected? | ✓ NO | DISTINCT returns all, no filtering |
| CTE loses pageid? | ✓ NO | SELECT still from states, CTEs only filter |
| OR logic breaks pageid? | ✓ NO | Pageid not in WHERE clause, all matches returned |
| User list validation? | ✓ STRONG | Required non-empty, all entries checked |
| Type safety? | ✓ GOOD | Executor type-checks, logs warnings on failure |
| Truncation? | ✓ NO | VARCHAR unlimited, string type unlimited |

---

## Key Code Lines

**Query building:** `/exodus/query/builder.go:55`
```go
query.WriteString("SELECT DISTINCT s.userid, s.pageid\nFROM states s")
```

**Executor extraction:** `/exodus/executor/executor.go:219-230`
```go
pageID, ok := row["pageid"].(string)
if !ok {
    log.Printf("Warning: Invalid pageid type in query result: %T", row["pageid"])
    continue
}
users = append(users, sender.UserTarget{...PageID: pageID...})
```

**User list path:** `/exodus/executor/executor.go:235-247`
```go
PageID: entry.PageID,  // Direct from validated JSON
```

**Validation:** `/exodus/types/types.go:130-131`
```go
if entry.PageID == "" {
    return fmt.Errorf("pageid is required at index %d", i)
}
```

**Sender creation:** `/exodus/sender/sender.go:59-69`
```go
event := &BailoutEvent{
    User: userID,
    Page: pageID,  // Unchanged
    ...
}
```

---

## Test Coverage

**Integration tests:** `/exodus/query/db_integration_test.go`
- Creates states with pageid: `userid, userid+"-page"`
- Verifies pageid is returned from queries
- Tests OR/AND conditions preserve pageids

**Unit tests:** `/exodus/executor/executor_test.go`
- Mock results include pageid
- Tests executor handles pageid correctly
- Tests both conditions and user_list paths

**API tests:** `/exodus/api/handlers_test.go`
- Preview endpoint returns pageid
- Tests both bail types return correct pageids

---

## Summary

The pageid mechanism is **simple, transparent, and correct**:
- One pageid per state (with userid)
- Query returns all pageid-userid pairs that match conditions
- Each pair gets its own bailout event
- No selection, defaults, or logic—just data flow

This is the right design for multi-platform support. No changes needed.
