# WhatsApp Platform-Agnostic Account Model Design

**Status:** Design (not yet implemented)  
**Scope:** First-class platform abstraction for WhatsApp, Instagram, TikTok (and beyond)  
**REJECTED:** Track A's prior proposal to reuse `entity='facebook_page'` for WhatsApp. That is a hack; this design fixes it.

---

## Executive Summary

The Kafka command already carries `platform` and `platform_account_id` fields. The database schema's `facebook_page_id` computed column only extracts for `entity='facebook_page'`, forcing hacks at query time. **Recommendation: introduce a generic `platform` column in the credentials table, and generalize the account ID lookup to dispatch by platform + account_id instead of reusing a Facebook-specific column.**

**Key decision:** Add real columns `platform` and `account_id` alongside the existing `entity` + `key` structure, with backward-compatible defaults. Rewrite all 8 consumers to query by `(platform, account_id)` instead of `facebook_page_id`. Keep the `facebook_page_id` computed column for one migration window (2 weeks), then drop it. This approach:
- ✅ Makes WhatsApp, Instagram, TikTok, etc. first-class (not hidden in entity types)
- ✅ Enables clean indexing per platform without computed columns or JSON extraction
- ✅ Preserves all existing Messenger credentials without data migration
- ✅ Decouples platform keying from entity/key uniqueness constraints
- ✅ Minimal code churn: same 8 consumers, just different WHERE clause

---

## 1. Current Credentials Schema

### Existing DDL (devops/migrations/01-init.sql, lines 170–182)

```sql
CREATE TABLE IF NOT EXISTS chatroach.credentials(
  userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
  entity VARCHAR NOT NULL,
  key VARCHAR NOT NULL,
  created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  details JSONB NOT NULL,
  facebook_page_id VARCHAR AS (
    CASE WHEN entity = 'facebook_page' 
    THEN details->>'id' 
    ELSE NULL 
    END
  ) STORED,
  UNIQUE(entity, key),
  INDEX (userid, entity, key, created desc) STORING (details),
  INDEX (facebook_page_id) STORING (details, key, userid),
  CONSTRAINT unique_facebook_page UNIQUE(facebook_page_id),
  CONSTRAINT unique_entity_key_per_user UNIQUE(userid, entity, key)
);
```

### Current Constraints & Computed Column Logic

- **`facebook_page_id` is a stored (materialized) computed column** that extracts `details->>'id'` only when `entity = 'facebook_page'`; otherwise NULL.
- **Uniqueness is global:** `unique_facebook_page` ensures the same Facebook page_id can only be registered by one user.
- **Entity + key are globally unique:** `UNIQUE(entity, key)` prevents duplicate credentials, e.g., two users registering the same Facebook page.
- **Per-user uniqueness:** `UNIQUE(userid, entity, key)` is redundant given the global uniqueness, but kept for clarity.
- **CockroachDB constraints:** ALTER on STORED computed columns is **very restrictive** (cannot add new dependencies to an existing column). The column cannot be "converted" from STORED to VIRTUAL, and changing its expression requires a full rewrite with a new column name.

### Existing Consumers of `facebook_page_id`

The computed column is currently queried at 8 locations:

| File | Line(s) | Query Pattern | Purpose |
|------|---------|---------------|---------|
| `message-worker/tokenstore.go` | 76 | `WHERE facebook_page_id = $1` | Token lookup for SendMessageCommand |
| `formcentral/db.go` | 78 | `WHERE s.userid=(SELECT userid FROM credentials WHERE facebook_page_id=$1 LIMIT 1)` | Survey resolution (get form by pageid) |
| `dinersclub/provider.go` | 67 | `WHERE facebook_page_id=$1 LIMIT 1` | Payment event routing (get userid from pageid) |
| `dashboard-server/queries/states/states.queries.js` | 50–54 | `SELECT facebook_page_id FROM credentials WHERE u.email = ... AND facebook_page_id IS NOT NULL` | Scope states by user's account IDs |
| `dashboard-server/queries/message-templates/message-templates.queries.js` | 35 | Parameter in WHERE clause for listing templates | Message template lookup by page |
| `dashboard-server/queries/media/media.queries.js` | 19 | Parameter in SELECT for media rows | Media asset lookup by page |
| `dashboard-client/src/containers/Media/Media.js` | 106–107 | Column name in UI data table | Dashboard UI display |
| `dashboard-client/src/containers/MessageTemplates/MessageTemplates.js` | 145, 112 | Column reference in UI table/detail | Dashboard UI display |

### Existing Entity Types in Use

Currently only `'facebook_page'` extracts to `facebook_page_id`. Other entity types are dormant:
- `'facebook_page'` — Messenger pages, fully in use
- `'facebook_ad_user'` — Ad campaign credentials (campaigns table references this)
- `'typeform_token'` — Historical; possibly unused
- `'whatsapp_number'` — Proposed in Track A findings but rejected

---

## 2. Target Model: Generic Platform + Account ID

### Recommended Approach: Add Real Columns

Add two new **real (non-computed) columns** to credentials:

```sql
ALTER TABLE chatroach.credentials ADD COLUMN platform VARCHAR;
ALTER TABLE chatroach.credentials ADD COLUMN account_id VARCHAR;

-- Backfill existing Messenger credentials
UPDATE credentials 
SET platform = 'messenger', account_id = details->>'id'
WHERE entity = 'facebook_page' AND details->>'id' IS NOT NULL;

-- New unique constraint: platform + account_id (replaces facebook_page_id globally unique constraint)
ALTER TABLE chatroach.credentials 
  DROP CONSTRAINT unique_facebook_page;
ALTER TABLE chatroach.credentials 
  ADD CONSTRAINT unique_platform_account UNIQUE(platform, account_id);

-- Index for fast lookup by platform + account_id (used by all 8 consumers)
CREATE INDEX ON chatroach.credentials(platform, account_id) 
  STORING (details, key, userid, entity);

-- Transition: keep facebook_page_id computed column for 2 weeks, then drop
-- (allows rollback if needed; consumers can dual-write/dual-read during switchover)
```

### Why This Approach

| Aspect | Pro | Con | Alternative Considered |
|--------|-----|-----|------------------------|
| **Real columns vs. computed** | Explicit, queryable, indexable directly | Requires backfill + migration | Computed columns have CRDB rewrite constraints |
| **Generalized key: `platform` + `account_id`** | First-class for all platforms; no entity type hacks | Adds two columns | Reuse entity type to encode platform (too hacky) |
| **Backward compatibility** | Existing Messenger creds work unchanged (backfilled); no user-visible impact | Two-phase rollout (dual-read window) | Hard cutover (risky on production) |
| **Migration window** | Rollback safety; parallel validation | Temporary data inconsistency (if backfill incomplete) | No transition (only for greenfield) |

### Alternative: Generalize the Computed Column

❌ **Rejected:** Redefine `facebook_page_id` to extract `account_id` for *any* platform. This is more complex:
- CRDB forbids changing a STORED column's expression.
- Would require creating a *new* column `account_id` and dropping the old `facebook_page_id`, plus renaming.
- All consumers must update column references simultaneously (no transition window).
- Doesn't solve the semantic issue: the column name still embeds "facebook_page," even if it now holds WhatsApp phone IDs.

---

## 3. Credential & Entity Types Per Platform

### Platform-Credential Mapping

| Platform | Entity Type | Account ID | Details Example | First-Class? |
|----------|-------------|------------|-----------------|--------------|
| **Messenger** | `facebook_page` | `page_id` (e.g., `'935593143497601'`) | `{ "id": "935593143497601", "name": "My Page", "access_token": "EAAB..." }` | ✅ Yes (via `platform='messenger'`) |
| **WhatsApp** | `whatsapp_business` | `phone_number_id` (e.g., `'1023456789'`) | `{ "id": "1023456789", "access_token": "EAAB...", "display_phone_number": "+1-234-567-8900" }` | ✅ Yes (via `platform='whatsapp'`) |
| **Instagram** | `instagram_account` | `ig_user_id` (e.g., `'123456789'`) | `{ "id": "123456789", "access_token": "EAAB...", "username": "..." }` | ✅ Yes (future; `platform='instagram'`) |
| **TikTok** | `tiktok_account` | `tiktok_open_id` (e.g., `'oa1234...'`) | `{ "id": "oa1234...", "access_token": "...", "username": "..." }` | ✅ Yes (future; `platform='tiktok'`) |

### Mapping in Code

**Platform enum** (already in `message-worker/types/command.go`):
```go
const (
  PlatformMessenger PlatformType = "messenger"
  PlatformWhatsApp  PlatformType = "whatsapp"
  PlatformInstagram PlatformType = "instagram"
  PlatformTelegram  PlatformType = "telegram"
)
```

**Dashboard credential creation** (how each platform's credentials are registered):

- **Messenger (today):** `POST /api/v1/facebook/exchange-token` → `POST /api/v1/credentials` with `entity='facebook_page'` (will be updated to set `platform='messenger'` in the backfill).
- **WhatsApp (Track A):** Manual SQL INSERT with `entity='whatsapp_business'`, `platform='whatsapp'`, `account_id=<phone_number_id>` (new admin flow).
- **WhatsApp (Track B):** `POST /api/v1/whatsapp/exchange-code` → `POST /api/v1/credentials` with `entity='whatsapp_business'`, `platform='whatsapp'` (Embedded Signup flow, post-App Review).
- **Instagram (future):** Similar to WhatsApp, via Instagram's OAuth flow.

---

## 4. Consumer Changes: The Exact Query Migration

### Current Query Pattern (all 8 consumers)

```sql
WHERE facebook_page_id = $1
```

### New Query Pattern

```sql
WHERE platform = $1 AND account_id = $2
```

### Example: Message-Worker TokenStore (message-worker/tokenstore.go:76)

**Before:**
```go
err := s.pool.QueryRow(ctx, `
  SELECT COALESCE(details->>'access_token', details->>'token') AS token
  FROM credentials
  WHERE facebook_page_id = $1
  ORDER BY created DESC
  LIMIT 1
`, platformAccountID).Scan(&token)
```

**After:**
```go
err := s.pool.QueryRow(ctx, `
  SELECT COALESCE(details->>'access_token', details->>'token') AS token
  FROM credentials
  WHERE platform = $1 AND account_id = $2
  ORDER BY created DESC
  LIMIT 1
`, platform, platformAccountID).Scan(&token)
```

**Caller context** (worker.go): The `SendMessageCommand` already carries both `platform` and `platform_account_id`:
```go
cmd := types.SendMessageCommand{
  Platform:          types.PlatformMessenger,  // "messenger" or "whatsapp"
  PlatformAccountID: "935593143497601",        // page_id or phone_number_id
  // ...
}

// In ProcessCommand:
token, err := s.tokenStore.GetToken(ctx, cmd.Platform.String(), cmd.PlatformAccountID)
```

### Full Consumer Change List

1. **message-worker/tokenstore.go:76** → Change query from `facebook_page_id = $1` to `platform = $1 AND account_id = $2`; pass `(cmd.Platform, cmd.PlatformAccountID)`.

2. **formcentral/db.go:78** → Change query:
   ```sql
   -- Before:
   WHERE s.userid=(SELECT userid FROM credentials WHERE facebook_page_id=$1 LIMIT 1)
   
   -- After:
   WHERE s.userid=(SELECT userid FROM credentials WHERE platform=$1 AND account_id=$2 LIMIT 1)
   ```
   Pass `(platform, account_id)` from the inbound event (already in `UniversalEvent.source`).

3. **dinersclub/provider.go:67** → Change query:
   ```sql
   -- Before:
   SELECT userid FROM credentials WHERE facebook_page_id=$1 LIMIT 1
   
   -- After:
   SELECT userid FROM credentials WHERE platform=$1 AND account_id=$2 LIMIT 1
   ```
   Pass `(event.Platform, event.Pageid)` from `PaymentEvent`.

4. **dashboard-server/queries/states/states.queries.js:50–54** → Change subquery:
   ```sql
   -- Before:
   SELECT facebook_page_id FROM credentials WHERE ...
   
   -- After:
   SELECT platform, account_id FROM credentials WHERE ...
   ```
   Then adjust the join: `states.pageid IN (SELECT account_id FROM credentials ...)` (pageid is always the account_id in states).

5. **dashboard-server/queries/message-templates/message-templates.queries.js:35** → Change query parameter binding from `facebook_page_id` to `account_id` (and ensure platform is passed).

6. **dashboard-server/queries/media/media.queries.js:5, 19** → Change table column from `facebook_page_id` to `account_id` (or add `platform` column); rewrite queries accordingly.

7. **dashboard-client/src/containers/Media/Media.js:106–107** → Change column reference from `facebook_page_id` to `account_id` in the UI table definition.

8. **dashboard-client/src/containers/MessageTemplates/MessageTemplates.js:145, 112** → Change column reference from `facebook_page_id` to display label (or derive from credentials lookup if needed).

### How Platform Flows Through the System

The **platform information is already available** at every layer, so the change is straightforward:

- **Hermes (inbound):** Tags events with `source: { type: "messenger" | "whatsapp", account_id: ... }` before publishing to Kafka.
- **replybot (event-normalizer.js):** Normalizes events to `UniversalEvent.source = { type, account_id }`.
- **message-worker (worker.go):** Receives `SendMessageCommand` with `platform` and `platform_account_id` fields.
- **replybot's tokenstore calls:** Pass `(platform, account_id)` to the token lookup.
- **formcentral/dinersclub:** Receive source/event with platform info.

No architectural change needed; just thread the platform through the queries.

---

## 5. Migration Strategy (Backward-Compatible, Risk-Minimized)

### Phase 1: Schema Changes (production deploy, no downtime)

**Week 1, Tuesday:**

```sql
-- Add new columns (nullable, defaults NULL)
ALTER TABLE chatroach.credentials ADD COLUMN platform VARCHAR;
ALTER TABLE chatroach.credentials ADD COLUMN account_id VARCHAR;

-- Backfill existing Messenger credentials
UPDATE credentials 
SET platform = 'messenger', account_id = details->>'id'
WHERE entity = 'facebook_page' AND details->>'id' IS NOT NULL;

-- Create new unique constraint (allow NULL for now)
ALTER TABLE chatroach.credentials 
  ADD CONSTRAINT unique_platform_account UNIQUE(platform, account_id);

-- Create index for the new query pattern
CREATE INDEX ON chatroach.credentials(platform, account_id) 
  STORING (details, key, userid, entity);

-- Make columns NOT NULL *after* backfill confirms it succeeded
ALTER TABLE chatroach.credentials 
  ALTER COLUMN platform SET NOT NULL,
  ALTER COLUMN account_id SET NOT NULL;
```

**At this point:**
- ✅ All existing Messenger credentials have `(platform='messenger', account_id=<page_id>)`.
- ✅ New WhatsApp credentials can be inserted with `(platform='whatsapp', account_id=<phone_number_id>)`.
- ✅ Old `facebook_page_id` column still works (computed from `entity='facebook_page'`).
- ✅ Production code can continue running on the old query pattern.

### Phase 2: Dual-Read Consumer Rollout (staggered, ~1 week)

**Week 1–2: Message-Worker & Go Services (lowest risk)**

Update consumers in this order:
1. `message-worker/tokenstore.go` — Try new query pattern; fall back to old if NULL.
2. `formcentral/db.go` — Try new query; fall back to old.
3. `dinersclub/provider.go` — Try new query; fall back to old.

Example dual-read pattern (Go):
```go
// Try new pattern
var token string
err := s.pool.QueryRow(ctx, `
  SELECT COALESCE(details->>'access_token', details->>'token')
  FROM credentials
  WHERE platform = $1 AND account_id = $2
  LIMIT 1
`, platform, platformAccountID).Scan(&token)

if err != nil && err == pgx.ErrNoRows {
  // Fallback to old pattern (for pre-migration data or old clients)
  err = s.pool.QueryRow(ctx, `
    SELECT COALESCE(details->>'access_token', details->>'token')
    FROM credentials
    WHERE facebook_page_id = $1
    LIMIT 1
  `, platformAccountID).Scan(&token)
}
```

**Week 2: Dashboard-Server (medium risk)**

Update JavaScript queries in `dashboard-server/queries/`:
- `states/states.queries.js`
- `message-templates/message-templates.queries.js`
- `media/media.queries.js`

These can use dual logic too (try new, fall back to old).

**Week 2: Dashboard-Client (lowest risk)**

Update React component column bindings:
- `Media/Media.js`
- `MessageTemplates/MessageTemplates.js`

Since these are UI-only references, they're safe to update independently.

### Phase 3: Remove Old Column (after 2–3 weeks)

**Week 3 or later, after confirming zero logs of the old pattern:**

```sql
-- Drop the computed column (also drops its index)
ALTER TABLE chatroach.credentials DROP COLUMN facebook_page_id;

-- Drop the old unique constraint (subsumed by new one)
ALTER TABLE chatroach.credentials 
  DROP CONSTRAINT unique_facebook_page;

-- Remove dual-read fallback logic from all 8 consumers
-- (Update all queries to use only the new pattern)
```

### Rollback Plan

If a consumer fails after updating (week 1–3):

1. **Revert the consumer code** to use old query pattern only.
2. **Keep the new columns** (platform, account_id) in the database.
3. **Re-backfill** if any WhatsApp credentials were added: `UPDATE credentials SET platform='whatsapp', account_id=... WHERE entity='whatsapp_business'`.

No schema rollback needed; the old `facebook_page_id` computed column is still functional during the dual-read window.

---

## 6. Org-Owned WhatsApp Number Registration (Track A)

Under the new model, an org-owned WhatsApp number is registered **first-class**, not as a Facebook page hack:

### Manual Registration (Admin SQL)

```sql
INSERT INTO credentials (userid, entity, key, platform, account_id, details, created)
VALUES (
  (SELECT id FROM users WHERE email = 'researcher@example.com'),
  'whatsapp_business',       -- New entity type
  '1023456789',              -- phone_number_id (same as account_id)
  'whatsapp',                -- NEW: platform column
  '1023456789',              -- NEW: account_id column
  '{"id":"1023456789","access_token":"EAAB_ORG_TOKEN_HERE","display_phone_number":"+1-555-1234"}'::JSONB,
  CURRENT_TIMESTAMP
);
```

### At Runtime (Message-Worker)

When a `SendMessageCommand` arrives with `platform='whatsapp'` and `platform_account_id='1023456789'`:

1. **tokenstore.GetToken()** queries: `WHERE platform='whatsapp' AND account_id='1023456789'` → finds row → returns token.
2. **WhatsAppClient.SendMessage()** uses token to call `https://graph.facebook.com/v25.0/1023456789/messages`.

### At Runtime (Inbound — Formcentral)

When a survey starts via WhatsApp with `phone_number_id='1023456789'`:

1. **formcentral.getSurveyByParams()** queries: `WHERE s.userid=(SELECT userid FROM credentials WHERE platform='whatsapp' AND account_id='1023456789')` → finds researcher's userid → looks up shortcode → returns form.

---

## 7. Known Risks & Mitigation

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Backfill incomplete** (some Messenger creds miss `platform`/`account_id`) | High | Validate backfill count before Phase 2; add alert if count differs from expected |
| **Dual-read complexity** (consumers must handle both patterns, more code) | Medium | Use templated fallback pattern in all 8 consumers; test dual-read thoroughly in staging |
| **Query performance during Phase 2** (two concurrent query attempts) | Low | Index on new columns is created in Phase 1; old index still exists; no performance degradation |
| **Dashboard UI breaks if column doesn't exist** (e.g., old clients calling new DB) | Low | Computed column stays through Phase 2; backward-compatible |
| **Messaging platform gets mixed up** (e.g., Messenger query runs against WhatsApp cred) | Medium | The `platform` column acts as a gate; wrong platform → no match → "token not found" error (safe) |

---

## 8. Documentation Updates Needed (Post-Implementation)

- **`documentation/platform-abstraction.md`** → Add section on "Account Routing" explaining the `platform` + `account_id` model.
- **`documentation/platform-abstraction-hardening.md`** → Note the migration steps (if this design is implemented before hardening is complete).
- **`message-worker/README.md`** → Document that TokenStore now dispatches by platform + account_id.
- **`dashboard-server/README.md`** → Clarify that credentials are keyed by platform (not entity type).
- **NEW: `documentation/whatsapp-onboarding.md`** → Describe Track A (org-owned) and Track B (Embedded Signup) under the new first-class model.

---

## 9. Summary: The Keying Decision

### Old (Broken)

- Computed column `facebook_page_id` extracts only for `entity='facebook_page'`.
- WhatsApp would need `entity='whatsapp_business'` but no computed column → hacks at query time.
- Platform information is implicit (derived from entity type).

### New (First-Class)

- Explicit columns `platform` and `account_id`.
- All platforms query by `WHERE platform = $1 AND account_id = $2`.
- Platform information is explicit and indexed.
- Entity type is orthogonal to platform (allows future platforms without schema changes).

### Concrete Example

**Messenger page 123:**
- `entity='facebook_page'`, `key='123'`, `platform='messenger'`, `account_id='123'`
- Query: `WHERE platform='messenger' AND account_id='123'` ✅

**WhatsApp number 456:**
- `entity='whatsapp_business'`, `key='456'`, `platform='whatsapp'`, `account_id='456'`
- Query: `WHERE platform='whatsapp' AND account_id='456'` ✅

**Instagram account 789:**
- `entity='instagram_account'`, `key='789'`, `platform='instagram'`, `account_id='789'`
- Query: `WHERE platform='instagram' AND account_id='789'` ✅

---

## 10. Specific Files to Modify

| File | Change | Effort |
|------|--------|--------|
| `devops/migrations/01-init.sql` | (No change; old schema frozen) | - |
| `devops/migrations/19-platform-abstraction.sql` (NEW) | Add `platform`, `account_id` columns; backfill; create index + constraint | Medium |
| `message-worker/tokenstore.go` | Update query; dual-read fallback | Low |
| `formcentral/db.go` | Update query; dual-read fallback | Low |
| `dinersclub/provider.go` | Update query; dual-read fallback | Low |
| `dashboard-server/queries/states/states.queries.js` | Update subquery; dual-read | Low |
| `dashboard-server/queries/message-templates/message-templates.queries.js` | Update params; dual-read | Low |
| `dashboard-server/queries/media/media.queries.js` | Add `platform` column to table; update query | Low |
| `dashboard-client/src/containers/Media/Media.js` | Update column reference | Low |
| `dashboard-client/src/containers/MessageTemplates/MessageTemplates.js` | Update column reference | Low |
| `devops/migrations/20-cleanup.sql` (later) | Drop old `facebook_page_id`, unique constraint | Low |

---

## Recommendation

**Implement this design for WhatsApp migration.** The new `platform` + `account_id` model:
- Unblocks WhatsApp as a first-class platform (not a hack).
- Future-proofs for Instagram, TikTok, etc. without schema changes.
- Is backward-compatible (existing Messenger creds work unchanged).
- Has a clear, low-risk two-phase rollout (schema → dual-read → cleanup).
- Keeps code changes minimal (same 8 consumers, just different WHERE clause).

**Risk profile:** Medium (schema changes in production), but mitigated by:
- Backfill validation before consumer cutover.
- Two-week dual-read window.
- Rollback plan if needed.
- Existing index coverage (no performance cliff).
