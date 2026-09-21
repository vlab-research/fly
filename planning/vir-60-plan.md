# VIR-60 Implementation Plan: Platform Resolution for All Bails

**Status**: Phase 2 Plan (Revised)
**Date**: 2026-09-19
**Issue**: Both conditions-based and user_list bails guess platform instead of resolving from `credentials.entity` (owned by bail owner):
- **Conditions bails**: Query defaults NULL `states.platform` to 'messenger' via COALESCE; wrong for WhatsApp and fatal for erased-md conversations
- **User_list bails**: `platform` field was unvalidated caller input; now removed from API; execution must resolve from credentials
- **Fix scope**: Both bail types resolve from `credentials.entity` at validation and execution time, with skips recorded

---

## Required Reading for Implementers

1. `planning/vir-60-findings-exodus.md` — comprehensive scout findings
2. `planning/vir-60-findings-dashboard.md` — dashboard code structure
3. `documentation/platform-resolution.md` — §1-3 (fact vs carried value), §5 (failure mode), §7 (the rule: credentials is authoritative)
4. `planning/platform-guess-expiry.md` §0-1 — live incident
5. `documentation/bail-systems.md` — existing platform documentation (to be updated)
6. `exodus/README.md` — **NOW UPDATED to describe current (broken) behavior factually**

---

## Design: Platform Resolution for Both Bail Types

### Current Broken Behavior (Documented in exodus/README.md Now)

**Conditions-based bails**: Query projects `COALESCE(s.platform, 'messenger')`. For ~96% of rows where `states.platform` is NULL, defaults to 'messenger' — wrong for WhatsApp, catastrophic for erased-md conversations (states.platform NULL because md destroyed).

**User_list bails**: `Platform` field in `UserListEntry` was unvalidated caller input; omitted or empty produced `"platform": ""` in event, replybot guessed 'messenger'. Same failure as conditions bails for WhatsApp accounts.

### Fixed Design: Credentials-Based Resolution

Both bail types now resolve platform from `credentials.entity` (owned by bail owner):

**Conditions-based bails**:
```sql
-- INNER JOIN for owner-scoped credential resolution (fixes cross-tenant bug)
SELECT DISTINCT s.userid, s.pageid,
  CASE WHEN c.entity = 'facebook_page' THEN 'messenger'
       WHEN c.entity = 'whatsapp_business' THEN 'whatsapp'
       ELSE NULL END AS platform
FROM states s
INNER JOIN credentials c ON c.key = s.pageid 
  AND c.entity IN ('facebook_page','whatsapp_business')
  AND c.userid = <bail_owner>
WHERE [conditions]
LIMIT 100000
```
Note: `INNER JOIN` excludes non-owned pageids by construction; no privacy leak, no skip noise.

**User_list bails**:
```
Platform field REMOVED from UserListEntry struct (no longer in API)
CSV: 3 columns unchanged (userid, pageid, shortcode)
Validation at create/update: every pageid must resolve to owned credential; 400 if not
Execution: ResolvePlatforms resolves each pageid; skips recorded with reason
```

**Shared pure resolver** (used by both after query/parsing):
```go
// Given targets and a credential map (pageid → platform + owned?), partition into resolved and skipped
func ResolvePlatforms(targets []PendingTarget, credentialMap map[string]*Credential) 
  (resolved []UserTarget, skipped []SkippedTarget)

// Skipped targets recorded in bail_events.execution_results:
{
  "user_ids": ["u1", "u2"],
  "skipped": [
    {"userid": "u_skip1", "pageid": "p_missing", "reason": "credential_not_found"},
    {"userid": "u_skip2", "pageid": "p_owned_by_someone_else", "reason": "credential_not_owned"}
  ]
}
```

---

## Conditions Bails: Cross-Tenant Bug Fix & Ownership Scoping

**Current state — CROSS-TENANT BUG CONFIRMED**: Query builder does NOT scope conditions to bail owner. `exodus/query/builder.go:138-145` (`buildFormCondition`) matches only `s.current_form = shortcode` with no userid check. `exodus/query/builder.go:284-291` (`buildSurveyIDCondition`) matches `s.current_form IN (...)` from surveys by UUID, still no ownership enforcement. Result: if User A and User B both own a form with shortcode `survey_common`, a conditions bail from User A with `form: survey_common` matches ALL states rows with that shortcode, including User B's participants on User B's pageids. **This is a latent cross-tenant data leak.**

**Fix**: Use `INNER JOIN credentials c ON c.key = s.pageid AND c.entity IN ('facebook_page','whatsapp_business') AND c.userid = $owner_id`. Only owned pageids survive; non-owned rows are excluded by construction (not returned, not recorded as skips).

**Why INNER, not LEFT**:
- **LEFT JOIN would leak data**: Non-owned rows returned every tick, recorded in THIS owner's `execution_results` as skipped → participant IDs of other users leak into owner's event log. For immediate bails, unbounded noise.
- **INNER JOIN is clean**: Result set IS this owner's participants by construction. No data leak, no skip noise.
- **Error handling difference**: If credentials join produces NULL entity (should never happen with INNER), conditions bail treats as programmer error (loud), not runtime skip. Skip+record semantics only for user_list bails (owner explicitly targets).

**Pre-deploy verification** (read-only): Show user exactly which (bail, pageid, other_owner) rows would be excluded:

```sql
-- For each enabled conditions bail, list rows that would drop (cross-tenant matches)
SELECT b.id, b.name, s.userid, s.pageid, c_other.userid as currently_owned_by
FROM chatroach.bails b
  CROSS JOIN LATERAL (
    SELECT DISTINCT s.userid, s.pageid
    FROM states s
    WHERE [conditions_from_b.definition]
      AND NOT EXISTS (
        SELECT 1 FROM credentials c 
        WHERE c.key = s.pageid 
          AND c.entity IN ('facebook_page','whatsapp_business')
          AND c.userid = b.user_id
      )
    LIMIT 100000
  ) s
  LEFT JOIN credentials c_other ON c_other.key = s.pageid
    AND c_other.entity IN ('facebook_page','whatsapp_business')
WHERE b.enabled = true
  AND (b.definition->>'type' = 'conditions' OR b.definition->>'type' IS NULL)
ORDER BY b.id, s.pageid;

-- If result is empty: no cross-tenant matching today, behavior unchanged.
-- If non-empty: show user which bails would change; decide migration strategy.
```

---

## Work Chunks (Parallelizable)

### Chunk A: Query Builder — Owner-Scoped Credentials Resolution for Conditions Bails
**Files**: `exodus/query/builder.go` (modify), `exodus/query/builder_test.go` (update)
**Responsibility**: Replace COALESCE with credentials join; platform now resolved at query time for conditions bails.

**Changes**:
1. **Modify**: `exodus/query/builder.go` line 82
   - Replace: `SELECT DISTINCT s.userid, s.pageid, COALESCE(s.platform, 'messenger') AS platform`
   - With: 
   ```sql
   SELECT DISTINCT s.userid, s.pageid,
     CASE WHEN c.entity = 'facebook_page' THEN 'messenger'
          WHEN c.entity = 'whatsapp_business' THEN 'whatsapp'
          ELSE NULL END AS platform
   FROM states s
   INNER JOIN credentials c ON c.key = s.pageid 
     AND c.entity IN ('facebook_page','whatsapp_business')
     AND c.userid = $N  -- bail owner, passed as bound parameter
   ```

2. **Rewrite**: `exodus/query/builder.go` line 54-81 comment block
   - Delete rationale for COALESCE and s.platform NULL handling
   - Add new rationale: "INNER JOIN to credentials scopes results to owned pageids only (fixes cross-tenant leak from conditions matching forms globally). Platform resolved deterministically from credentials.entity (authoritative per documentation/platform-resolution.md §3, §7). Parameter: bail owner userid passed as bound parameter (safe from SQL injection). If JOIN produces NULL entity (should not happen with INNER), executor treats as programmer error, not runtime skip."

3. **Modify**: `exodus/query/builder.go` constructor or BuildQuery signature
   - Accept `bailOwnerID uuid.UUID` parameter
   - Pass through as bound parameter using existing `qb.addParam()` mechanism (verify this works with INNER JOIN's ON clause)

4. **Update**: `exodus/query/builder_test.go`
   - Update test fixtures and SELECT matching to expect new platform projection and INNER JOIN
   - Add test: INNER JOIN on form condition excludes non-owned pageids from result set
   - Test: two users sharing a shortcode → query returns only owned user's rows
   - Test: platform CASE projection correctness

**Tests**:
- Unit: `query/builder_test.go`
  - SQL string matching for new platform projection
  - Owner-scoped join correctness
- Integration: `query/db_integration_test.go`
  - Execute query against live DB with mixed owned/non-owned pageids
  - Verify NULL platform rows returned and handled correctly
- No breaking changes to existing semantics: deduplication still works, CTE safety unchanged

**Dependency**: None (independent); Chunk B must integrate this into executor

---

### Chunk B: Resolver & Executor — Platform Resolution Core (Both Bail Types)
**Files**: `exodus/types/types.go` (remove Platform field), `exodus/db/credentials.go` (new), `exodus/executor/resolver.go` (new), `exodus/executor/executor.go` (modify), `exodus/sender/sender.go` (guard)
**Responsibility**: Pure resolver, credential lookup, wire both bail types through shared resolution, guard against empty platform.

**Changes**:
1. **Modify**: `exodus/types/types.go` line 115
   - **DELETE**: `Platform string` field from `UserListEntry` struct
   - No other fields affected; backward compat: stored definitions with platform field still unmarshal (Go ignores unknown JSON fields)

2. **New file**: `exodus/db/credentials.go`
   - `func (d *DB) GetCredentialsForPageIDs(ctx context.Context, pageids []string, userID uuid.UUID) (map[string]*CredentialRow, error)`
   - Query: `SELECT key, entity, userid FROM credentials WHERE key = ANY($1) AND entity IN ('facebook_page','whatsapp_business')`
   - Returns: map[pageid] → {Platform: "messenger" | "whatsapp", OwnedByUser: bool}
   - Handle NULL userid (missing credential) as OwnedByUser=false

3. **New file**: `exodus/executor/resolver.go`
   - Pure function `ResolvePlatforms(targets []PendingTarget, credentialMap map[string]*CredentialRow) (resolved []UserTarget, skipped []SkippedTarget)`
   - Loop targets:
     - If credentialMap[pageid] absent or !OwnedByUser: add to skipped with reason
     - Otherwise: add to resolved with platform from credential
   - Return both lists
   - No context, no DB, 100% testable

4. **Modify**: `exodus/executor/executor.go`
   - Line 196-272 (conditions and user_list query branches):
     - For conditions: extract resolved pageids from query result; call `GetCredentialsForPageIDs` and `ResolvePlatforms`
     - For user_list: extract pageids from bailDef.UserList.Users; same flow
     - Partition into resolved and skipped
   - Line 177 (SendBailouts): pass only resolved targets
   - Modify `recordSuccess` signature: accept `skipped []SkippedTarget`; marshal into `execution_results` JSON

5. **Modify**: `exodus/sender/sender.go` SendBailouts
   - Add guard: before sending each target, check `if target.Platform == "" { return error("empty platform for userid X") }`
   - Fail loud; should never happen with Chunk A+B, but catch programmer errors

6. **Clarify executor handling of conditions results**:
   - Conditions bails query returns resolved `platform` from CASE expression
   - If entity is NULL (should not happen with INNER JOIN) → executor treats as programmer error, returns loud error
   - Skip+record semantics apply ONLY to user_list bails (explicit target lists)
   - Conditions bails: NULL/unrecognized platform stops the bail (fail loud)

**Tests**:
- Unit: `executor/resolver_test.go`
  - Pure function tests: no credential, owned, unowned, mixed batches
  - Both bail type inputs (different target structs but same resolver)
- Unit: `sender/sender_test.go`
  - Attempt send with empty platform → error
- Integration: `executor/executor_test.go`
  - Mock DB: return credentials for test pageids with mixed ownership
  - Verify user_list bails produce skipped targets in execution_results
  - Verify conditions bails fail loud on NULL platform (executor error, not skip)
- Integration: `query/db_integration_test.go`
  - Two users sharing a shortcode: conditions bail from User A matches only User A's pageids
  - User B's pageids excluded by INNER JOIN
- Backward compat: `examples_test.go`
  - Deserialize stored definition with `"platform": "whatsapp"` and `"platform": "messenger"`
  - Verify execution resolves platform from credentials, not stored value (test by checking event has correct platform despite stored value being wrong/different from resolved)

**Dependency**: None (Chunk A can run in parallel; Chunk B integrates both)

---

### Chunk C: Exodus API — Validation at Create/Update (User List Only)
**Files**: `exodus/api/handlers.go` (modify), `exodus/api/types.go` (modify)
**Responsibility**: Validate user_list pageids at create/update time; reject 400 if any pageid invalid/unowned.

**Changes**:
1. **New validation method**: `types.UserList.ValidateWithCredentials(ctx context.Context, db DB, userID uuid.UUID) error`
   - Calls `db.GetCredentialsForPageIDs(ctx, pageids, userID)`
   - Aggregates offending pageids (missing or unowned)
   - Returns 400 message: `"pageids {p1,p2} have no owned messaging credential (must be facebook_page or whatsapp_business)"`

2. **Modify**: `exodus/api/handlers.go` CreateBail (line 149)
   - After `req.Definition.Validate()`, add:
   ```go
   if req.Definition.Type == "user_list" && req.Definition.UserList != nil {
     if err := req.Definition.UserList.ValidateWithCredentials(c.Request().Context(), s.db, userID); err != nil {
       return respondError(c, http.StatusBadRequest, "invalid_pageids", err.Error())
     }
   }
   ```

3. **Modify**: `exodus/api/handlers.go` UpdateBail (line 240)
   - Add same validation as CreateBail

4. **Modify**: `exodus/api/handlers.go` PreviewBail (line ~300)
   - Add same validation; return 400 if invalid, so users see errors before saving

**Tests**:
- Unit: `api/handlers_test.go`
  - Valid user_list (all pageids owned): accept
  - Missing pageid: reject with 400, name the pageid
  - Unowned pageid: reject with 400
  - Mixed: reject with all bad pageids aggregated
  - Conditions bail: bypass this validation (no validation for conditions, they handle NULL platform at execution)

**Dependency**: Chunk B (Chunk B must have GetCredentialsForPageIDs and UserListEntry without Platform field)

---

### Chunk D: Dashboard Server — Remove Platform from MCP, Forward Enabled (VIR-58)
**Files**: `dashboard-server/api/mcp/mcp.core.js` (modify), `dashboard-server/api/bails/bails.controller.js` (modify), `dashboard-server/api/mcp/mcp.core.test.js` (update)
**Responsibility**: Update MCP schema (no platform), add enabled to create controller, relay exodus validation errors.

**Changes**:
1. **Verify & document**: `dashboard-server/api/mcp/mcp.core.js` line 1313-1323
   - Confirm user_list.users items have no `platform` property (already does; scout verified)
   - Confirm `additionalProperties: false` is set
   - Update description to: "Each user requires userid, pageid (messaging account ID), and shortcode (destination form). Platform is resolved automatically from the account's credential and cannot be set here."

2. **Modify**: `dashboard-server/api/bails/bails.controller.js` createBail (line 62)
   - Line 62: add `enabled` to destructuring: `const { name, description, definition, destination_form, enabled } = req.body;`
   - Line 68-73: pass `{ name, description, definition, destination_form, enabled }`

3. **Verify**: `dashboard-server/utils/bails/bails.util.js`
   - Already relays entire bail object to exodus; no change needed

4. **Add tests**: `dashboard-server/api/bails/bails.test.js`
   - POST create with `enabled: true` → returns bail enabled=true
   - POST create with `enabled: false` → returns bail enabled=false
   - POST create without enabled → returns bail enabled=true (default from exodus)
   - Verify exodus error relaying (400 from invalid pageids)

**Dependency**: Chunk C (exodus must return proper 400 errors)

---

### Chunk E: Dashboard Client — UX Improvement (CSV Error Message)
**Files**: `dashboard-client/src/components/CsvUpload/CsvUpload.js` (modify comments/error text)
**Responsibility**: Improve error message when 4th column uploaded.

**Changes**:
1. **Modify**: error message at line 24-26 (when column count != 3)
   - Old: `"Row ${i + 1}: expected 3 columns (userid, pageid, shortcode), got ${parts.length}"`
   - New: `"Row ${i + 1}: expected 3 columns (userid, pageid, shortcode), got ${parts.length}. Platform is resolved automatically from your messaging account."`

2. **Add comment** in BailForm (line 185-195)
   - Document: "Platform for each user is resolved from their pageid's messaging credential; it cannot be set in the CSV."

**Tests**:
- `dashboard-client/src/components/CsvUpload/CsvUpload.test.js` (if exists)
  - Verify error message is shown (message text may already be tested)

**Dependency**: None (purely UX/docs)

---

### Chunk F: Documentation — Update All References to Platform Resolution
**Files**: `documentation/bail-systems.md`, `documentation/platform-resolution.md`, `planning/multi-platform-plan.md`, `planning/platform-guess-expiry.md`, `dashboard-server/README.md`
**Responsibility**: Update docs to describe credentials-based resolution for BOTH bail types; remove incorrect wording.

**Changes**:
1. **Update**: `documentation/bail-systems.md` § "User List Type" (line 73-135)
   - Update example to remove platform field:
   ```json
   { "userid": "user1", "pageid": "page1", "shortcode": "survey_a" }
   ```
   - Replace line 105-123 section ("platform is required in practice..."):
   ```
   Platform is resolved at creation time from the account's messaging credential.
   Every pageid must correspond to a facebook_page or whatsapp_business credential 
   owned by the bail owner. If any pageid is invalid or not owned, the bail 
   create/update fails with 400. At execution time, targets whose credentials have 
   been deleted or transferred are skipped and recorded in bail_events.execution_results.
   ```
   - Update API paths doc: clarify that if a payload includes `platform` field, it is ignored silently (JSON unmarshal ignores unknown struct fields); resolved value is always from credentials.entity

2. **Add section**: `documentation/bail-systems.md` § "Conditions Type" 
   - Document that platform is also resolved from credentials.entity for conditions bails
   - Document owner scoping: INNER JOIN credentials ensures only this owner's pageids contribute to results

3. **Add section**: `documentation/platform-resolution.md` § "Bail Systems: User List and Conditions Resolution" (after §3, before §5)
   - Explain that both bail types now resolve platform from credentials at validation and execution
   - Reference §7 (the rule): credentials.entity is authoritative
   - Note: this closes the last path to a guessed platform

4. **Update**: `planning/multi-platform-plan.md` § "WhatsApp launch checklist"
   - Status: "W1.5: User list + conditions bail platform resolution (VIR-60) — COMPLETE or IN PROGRESS"

5. **Update**: `planning/platform-guess-expiry.md` § "Fixes"
   - Status: "Task C (Exodus platform resolution for all bail types): COMPLETE or IN PROGRESS"

6. **Update**: `dashboard-server/README.md` (if bail section exists)
   - Add: "Bail system validates that all user_list pageids are owned by the caller and have valid messaging credentials; platform is resolved automatically."

**Dependency**: All code chunks complete

---

### Chunk G: Fix for VIR-58 (Enabled Field in Create)
**Status**: Included in Chunk D (same file modification)

---

## Test Strategy

### Unit Tests (No DB)
- `exodus/executor/resolver_test.go`: pure function, no credentials, owned/unowned, mixed
- `exodus/sender/sender_test.go`: empty platform guard
- `exodus/query/builder_test.go`: updated SQL assertions, owner-scoped join
- `dashboard-client/src/components/CsvUpload/CsvUpload.test.js`: error message

### Integration Tests (Live DB)
- `exodus/query/db_integration_test.go`: conditions query with NULL platform partitioning
- `exodus/executor/executor_test.go`: end-to-end for both bail types with mixed owned/unowned pageids
- `dashboard-server/api/bails/bails.test.js`: create with enabled field, pageid validation errors

### Backward Compatibility Test
- `exodus/examples_test.go`: Stored definition with `"platform": "whatsapp"` deserializes without error; execution resolves platform from credentials, not stored value

### Zero Warnings
- Go: `go build -v` no warnings
- Node: `npm run lint` passes

---

## Acceptance Criteria

- [ ] **Conditions bails**: INNER JOIN credentials (owner-scoped) — fixes cross-tenant bug; only owned pageids matched
- [ ] **Conditions bails**: platform projected from credentials.entity via CASE expression; NULL/unrecognized entity → loud error (not skip)
- [ ] **Conditions bails**: comment block documents ownership scoping, INNER JOIN rationale, cross-tenant fix
- [ ] **Conditions bails**: parameter binding verified (owner userid as bound parameter, not string interpolated)
- [ ] **Conditions & user_list bails**: platform field in API payload ignored (resolved from credentials.entity regardless)
- [ ] User_list entries: Platform field removed from struct
- [ ] Both bail types partition targets through shared ResolvePlatforms() function
- [ ] **User_list bails only**: Skipped targets recorded in execution_results with reason
- [ ] **Conditions bails**: NULL platform → executor loud error, not skip
- [ ] Sender guard: refuse empty platform, fail loud
- [ ] Create/update validation: user_list pageids must resolve to owned credentials; 400 if not
- [ ] Stored definitions with platform field deserialize and execute correctly (platform resolved from credentials, not stored value)
- [ ] Dashboard create: enabled field forwarded and honored (VIR-58)
- [ ] MCP schema: no platform property (already verified)
- [ ] Dashboard client CSV error: improved message
- [ ] Pre-deploy check SQL: shows (bail, pageid, owner) rows excluded by INNER JOIN (cross-tenant matches)
- [ ] Documentation updated: bail-systems.md (both types, owner scoping), platform-resolution.md, READMEs
- [ ] Multi-platform-plan.md and platform-guess-expiry.md status lines updated
- [ ] All tests pass: unit, integration (two-owner form test), backward compat
- [ ] Zero build warnings (Go, Node)

---

## Pre-Deploy Production Check

**Check 1**: Measure owner-scoped conditions bail impact
```sql
-- Run once per enabled conditions bail; compare current vs owner-scoped result set
[See Design section above for full SQL]
```

**Check 2**: User_list bails and pageids
```sql
SELECT COUNT(*) FROM chatroach.bails WHERE definition->>'type' = 'user_list';
-- Sample any existing user_list bails and verify pageids would resolve with new credentials join
```

**Check 3**: Confirm platform field removal is safe
```sql
SELECT COUNT(*) FROM chatroach.bails 
WHERE definition->'user_list'->'users'->0->>'platform' IS NOT NULL;
-- Should be zero; if non-zero, those definitions will deserialize (Go ignores unknown fields)
```

---

## Deployment Order

1. **Exodus**: image build, helm update (Chunks A+B)
2. **Dashboard-server**: image build, helm update (Chunks C+D)
3. **Dashboard-client**: image build, helm update (Chunk E, UX only)

**Commit message**: Reference both VIR-60 and VIR-58.

---

## Chunks & Parallelization

| Chunk | Files | Dependency | Parallel With |
|-------|-------|-----------|----------------|
| A | exodus/query/ | None | B, E |
| B | exodus/types, db/, executor/, sender/ | A (integrates) | A, E |
| C | exodus/api/ | B (uses GetCredentialsForPageIDs) | D, E |
| D | dashboard-server/ | C (forwards errors) | E |
| E | dashboard-client/ | None | A, B, C, D |
| F | docs | All code | None |
| G | (in Chunk D) | B | D |

**Suggested flow**:
1. Launch A, E in parallel
2. Launch B (integrates A)
3. Launch C (uses B)
4. Launch D (relays C)
5. Launch F (docs, after all code)

---

## Open Questions

None — scope and decisions finalized.

