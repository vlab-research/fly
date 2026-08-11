# PageID Selection: Executive Summary

**Investigation Date:** 2026-03-22
**Status:** COMPLETE - All Concerns Addressed

---

## Answer to Your Question

**Q: How is pageid chosen when bails are executed?**

**A:** PageID is **not chosen or selected**. Instead, **all pageids associated with matching users are returned from the SQL query**, and each gets its own bailout event sent to botserver.

---

## The Facts

### 1. SQL Query Returns ALL Matching PageIDs
```sql
SELECT DISTINCT s.userid, s.pageid
FROM states s
WHERE [conditions filter on state/form/responses, NOT pageid]
LIMIT 100000
```

- **DISTINCT** prevents duplicate `(userid, pageid)` pairs
- Does **NOT** select "one pageid per user"
- Returns ALL combinations where userid matches conditions

### 2. No PageID Filtering in Conditions
Bail conditions can filter on:
- Form (`s.current_form`)
- State (`s.current_state`)
- Error codes (`s.state_json->'error'->>'code'`)
- Question responses (via CTE)
- Elapsed time (via CTE)

**PageID is never used in WHERE clauses.** It's never filtered, compared, or selected by logic.

### 3. Executor Processes ALL Query Rows
**File:** `/exodus/executor/executor.go:211-230`

```go
for _, row := range rows {                    // ← ALL rows
    pageID := row["pageid"].(string)
    users = append(users, UserTarget{
        UserID:          userID,
        PageID:          pageID,                // ← Each pageid used as-is
        DestinationForm: bailDef.Action.DestinationForm,
    })
}
```

- Loops through **all** database rows
- Creates one UserTarget per row
- No deduplication or selection logic

### 4. Each PageID Gets Its Own Bailout Event
**File:** `/exodus/sender/sender.go:121`

```go
for i, user := range users {
    err := s.SendBailout(ctx, user.UserID, user.PageID, user.DestinationForm, metadata)
    // Each iteration sends one bailout to one page
}
```

---

## Multi-Platform Example

**States table:**
```
userid: "alice", pageid: "facebook_page_123", current_state: "RESPONDING"
userid: "alice", pageid: "whatsapp_wa_456",   current_state: "RESPONDING"
```

**Bail condition:** `current_state = 'RESPONDING'`

**Query result:**
```
(alice, facebook_page_123)
(alice, whatsapp_wa_456)
```

**Bailouts sent:** 2
- One to facebook_page_123
- One to whatsapp_wa_456

**This is correct.** Alice is on both platforms; both get bailed independently.

---

## Key Code Locations

| What | File | Line | Code |
|------|------|------|------|
| **SQL Query** | `/exodus/query/builder.go` | 55 | `SELECT DISTINCT s.userid, s.pageid` |
| **Executor Loop** | `/exodus/executor/executor.go` | 211-230 | Processes all rows, no selection |
| **PageID Extraction** | `/exodus/executor/executor.go` | 219 | `pageID := row["pageid"].(string)` |
| **Sender Loop** | `/exodus/sender/sender.go` | 112-121 | Sends each UserTarget separately |
| **Database Schema** | `/devops/migrations/01-init.sql` | 115 | `PRIMARY KEY (userid, pageid)` |

---

## What I Verified

✓ **SQL query:** Returns all matching pageids
✓ **WHERE clause:** Never filters on pageid
✓ **Executor logic:** No selection or deduplication logic
✓ **CTE handling:** PageID preserved from states table
✓ **OR/AND conditions:** Don't affect pageid selection
✓ **User list bails:** PageID comes from JSON input (validated)
✓ **Sender:** Sends each pageid to botserver unchanged
✓ **Type safety:** Type-checks pageid, skips invalid rows
✓ **Schema:** NOT NULL constraint enforces pageid presence
✓ **Test coverage:** Unit and integration tests confirm flow

---

## No Suspicious Logic Found

❌ No "pick first pageid" logic
❌ No "default to platform X" logic
❌ No conditional filtering on pageid
❌ No "choose one page per user" logic
❌ No truncation or transformation
❌ No fallback defaults
❌ No JOIN conditions that could select wrong pageid
❌ No CTE logic that could lose pageid

---

## Conclusion

The pageid selection mechanism is **correct and transparent**:

1. Query returns all matching `(userid, pageid)` combinations
2. Each combination becomes one bailout event
3. Users on multiple platforms get multiple bailouts (intentional)
4. No selection or filtering logic applied to pageid
5. PageID passed unchanged from database to botserver

**This design is correct for multi-platform support and requires no changes.**

---

## Related Findings

- **Upstream (Replybot):** PageID extracted from Facebook webhook via `getPageFromEvent()` — fails loudly if missing, no silent defaults
- **Database:** Composite primary key `(userid, pageid)` supports multiple pages per user
- **Sender:** Includes pageid in every bailout event
- **Logging:** PageID visible in logs for transparency

**Complete investigation results:** See `pageid-deep-dive-findings.md` for full technical analysis.
