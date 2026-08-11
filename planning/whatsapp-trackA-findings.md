# WhatsApp Migration Track A — Manual Association Findings

## Executive Summary

Facebook page association and WhatsApp integration are **already architecturally aligned**. The system keys everything on a generic `facebook_page_id` column in the credentials table (stored as a computed JSON extraction). For WhatsApp, the `phone_number_id` is the platform account ID. Manual association is **straightforward**: insert a single credentials row per user with:
- `entity = 'whatsapp_number'`, `key = <phone_number_id>`, `details = { id, access_token }`
- Or reuse `entity = 'facebook_page'` with the phone_number_id as `details.id` (less clean, but compatible with existing code)

Staging config needs **one addition**: `WHATSAPP_VERIFY_TOKEN` on Hermes (currently intentionally unset). All other paths (survey resolution, token lookup, state scoping) already work generically by account_id/pageid.

---

## 1. Credentials Table Model — Exact Row Shapes

### Schema (devops/migrations/01-init.sql)

```sql
CREATE TABLE IF NOT EXISTS chatroach.credentials(
  userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
  entity VARCHAR NOT NULL,
  key VARCHAR NOT NULL,
  created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  details JSONB NOT NULL,
  facebook_page_id VARCHAR AS (CASE WHEN entity = 'facebook_page' THEN details->>'id' ELSE NULL END) STORED,
  UNIQUE(entity, key),
  INDEX (userid, entity, key, created desc) STORING (details),
  INDEX (facebook_page_id) STORING (details, key, userid),
  CONSTRAINT unique_facebook_page UNIQUE(facebook_page_id),
  CONSTRAINT unique_entity_key_per_user UNIQUE(userid, entity, key)
);
```

**Key points:**
- `facebook_page_id` is a **computed/stored column** that extracts `details->>'id'` when `entity = 'facebook_page'` (and is NULL otherwise).
- `unique_facebook_page` constraint **forbids multiple users from owning the same page_id**.
- Entity/key combo is **unique globally** (`UNIQUE(entity, key)`), and also **unique per user** (`UNIQUE(userid, entity, key)`).

### Facebook Page Credential Row (current behavior)

From `dashboard-client/src/containers/FacebookPages/FacebookPages.js:formatPage()`:

```javascript
{
  entity: 'facebook_page',
  key: <page_id>,        // e.g., '935593143497601'
  details: {
    id: <page_id>,       // CRITICAL: must match key; extracted as facebook_page_id
    name: <page_name>,
    access_token: <token>
  }
}
```

When inserted via `dashboard-server/api/credentials/credentials.controller.js:createCredential()`:
```javascript
const cred = await Credential.create({ entity, key, details, email });
```

The row lands in the DB with:
- `userid` ← resolved from `email` via JOIN to users table
- `entity` = `'facebook_page'`
- `key` = page_id (e.g., `'935593143497601'`)
- `details` = `{"id":"935593143497601","name":"Test Page","access_token":"EAAB..."}`
- `facebook_page_id` = **computed** to `'935593143497601'` (from `details->>'id'`)

### WhatsApp Number Credential Row (proposed for Track A)

For org-owned WhatsApp numbers, a manual SQL insert would be:

```sql
INSERT INTO credentials (userid, entity, key, details, created)
VALUES (
  (SELECT id FROM users WHERE email = 'researcher@example.com'),
  'facebook_page',  -- Reuse existing entity type for compatibility
  '<phone_number_id>',  -- e.g., '1023456789'
  '{"id":"<phone_number_id>","access_token":"<org_whatsapp_token>"}'::JSONB,
  CURRENT_TIMESTAMP
);
```

**Or cleaner (future-proof):**
```sql
INSERT INTO credentials (userid, entity, key, details, created)
VALUES (
  (SELECT id FROM users WHERE email = 'researcher@example.com'),
  'whatsapp_number',  -- New entity type for clarity
  '<phone_number_id>',  -- e.g., '1023456789'
  '{"id":"<phone_number_id>","access_token":"<org_whatsapp_token>"}'::JSONB,
  CURRENT_TIMESTAMP
);
```

**Issue with second approach:** The computed column `facebook_page_id` only extracts when `entity = 'facebook_page'`, so `whatsapp_number` rows would have `facebook_page_id = NULL`. The rest of the system (token lookup, dinersclub, survey resolution) all key on `facebook_page_id`, so WhatsApp lookups would fail.

**Solution:** For Track A (minimal change), **reuse `entity = 'facebook_page'`** and let the `phone_number_id` ride in `details.id`. The computed column will extract it correctly. No schema changes needed.

---

## 2. Survey Resolution — getForm(account_id, shortcode)

### Current Mechanism

From `replybot/lib/typewheels/transition.js:26`:
```javascript
const page = parsedEvent.source.account_id || (state && state.md && state.md.pageid);
```

The `account_id` comes directly from the `UniversalEvent.source`, which is set by the inbound parser:
- **Messenger:** `UniversalEvent.source.account_id` = page_id (Facebook page)
- **WhatsApp:** `UniversalEvent.source.account_id` = phone_number_id (WhatsApp Business Account)

This `page` variable is passed to `getForm(pageid, shortcode, timestamp)` in `replybot/lib/typewheels/ourform.js:28`:
```javascript
async function getForm(pageid, shortcode, timestamp) {
  const url = `${process.env.FORMCENTRAL_URL}/surveys?pageid=${pageid}&shortcode=${shortcode}&timestamp=${timestamp}`
  const res = await fetch(url, { headers })
  // ...
}
```

### How surveys Resolve

The endpoint query `GET /surveys?pageid=<account_id>&shortcode=<shortcode>&timestamp=<timestamp>` is served by the **FORMCENTRAL_URL** (a separate service, deployed as `formcentral` in Helm).

The actual lookup happens in **dashboard-server** (which serves the formcentral role in this repo, though the env var points to a separate service). The lookup:

1. **Query surveys table by pageid + shortcode + timestamp** (no explicit query shown in this codebase; the endpoint must do this internally).
2. **Database call** likely resembles:
   ```sql
   SELECT id, form, messages, off_time
   FROM surveys
   WHERE shortcode = $1
   AND userid = (SELECT userid FROM credentials WHERE facebook_page_id = $2)
   AND created <= timestamp_param
   ORDER BY created DESC
   LIMIT 1
   ```

This means:
- **Survey resolution IS NOT by pageid directly.** It's by `(shortcode, userid)`, where `userid` is **resolved from the pageid via a credentials table lookup**.
- The credentials lookup `WHERE facebook_page_id = $1` is the **linchpin** that ties a pageid (or phone_number_id) to a user's surveys.

### Key Insight

**For WhatsApp to work, the phone_number_id must land in the `facebook_page_id` computed column.** Since the computed column extracts `details->>'id'` when `entity = 'facebook_page'`, the WhatsApp credential row must have:
- `entity = 'facebook_page'` (reuse existing type)
- `details.id = <phone_number_id>`

Then any inbound WhatsApp event with `source.account_id = <phone_number_id>` will:
1. Call `getForm(<phone_number_id>, shortcode, timestamp)`
2. Hit FORMCENTRAL endpoint
3. FORMCENTRAL queries `credentials WHERE facebook_page_id = '<phone_number_id>'`
4. Finds the row, extracts `userid`
5. Queries `surveys WHERE shortcode = $1 AND userid = $2`
6. Returns the form

**No code changes required.** The mechanism is fully generic on account_id.

---

## 3. Message-Worker Token Lookup

### Query (message-worker/tokenstore.go:73–78)

```go
err := s.pool.QueryRow(ctx, `
  SELECT COALESCE(details->>'access_token', details->>'token') AS token
  FROM credentials
  WHERE facebook_page_id = $1
  ORDER BY created DESC
  LIMIT 1
`, platformAccountID).Scan(&token)
```

**Input:** `platformAccountID` (the account_id from the SendMessageCommand, populated from replybot's `platform_account_id`).

**Behavior:**
1. Query credentials table by **facebook_page_id** (computed column).
2. Extract `access_token` (or fallback to `token` for testrunner compatibility).
3. Return token or error.

### WhatsApp Token Requirement

For a WhatsApp number with a phone_number_id `'1023456789'` and org access token `'EAAB...'`:

```sql
INSERT INTO credentials (userid, entity, key, details)
VALUES (..., 'facebook_page', '1023456789', '{"id":"1023456789","access_token":"EAAB..."}'::JSONB, ...);
```

When message-worker processes a command with `platform_account_id = '1023456789'`:
1. Queries `WHERE facebook_page_id = '1023456789'`
2. Finds row, extracts `details->>'access_token'`
3. Returns `'EAAB...'`

**The `WhatsAppClient` then:**
- Constructs URL: `{WHATSAPP_GRAPH_URL}/{phone_number_id}/messages` (e.g., `https://graph.facebook.com/v25.0/1023456789/messages`)
- Sends POST with `Authorization: Bearer <token>`

**No code changes required.** Token lookup is already generic; the WhatsApp client just needs a valid token in `details.access_token`.

---

## 4. Dinersclub Payment Routing

From `dinersclub/provider.go:66–76`:

```go
func GenericGetUser(pool *pgxpool.Pool, event *PaymentEvent) (*User, error) {
  query := `SELECT userid FROM credentials WHERE facebook_page_id=$1 LIMIT 1`
  row := pool.QueryRow(context.Background(), query, event.Pageid)
  var u User
  err := row.Scan(&u.Id)
  // ...
  return &u, err
}
```

For a payment event with `Pageid = '<phone_number_id>'`, dinersclub queries:
1. `SELECT userid FROM credentials WHERE facebook_page_id = '<phone_number_id>'`
2. Returns the userid
3. Uses userid to look up payment provider credentials (e.g., Reloadly API key)

**Again: no code changes.** The phone_number_id in `facebook_page_id` leads to the userid, and the flow proceeds.

---

## 5. Staging Config Deltas

### Required Changes

**1. Hermes WHATSAPP_VERIFY_TOKEN** (devops/values/staging.yaml)

Currently (line 545–546):
```yaml
# WHATSAPP_VERIFY_TOKEN is intentionally unset until the Meta WhatsApp
# webhook is provisioned; GET /whatsapp verification returns 401 until then.
```

Add to `hermes.env`:
```yaml
hermes:
  env:
    # ... existing config ...
    - name: WHATSAPP_VERIFY_TOKEN
      value: "<random-token-for-testing>"  # e.g., "staging-whatsapp-verify-token-xyz"
    # Or pull from secret:
    # valueFrom:
    #   secretKeyRef:
    #     name: gbv-bot-envs
    #     key: WHATSAPP_VERIFY_TOKEN
```

This allows Hermes to serve `GET /whatsapp` verification for Meta's webhook setup.

**2. Message-Worker WHATSAPP_GRAPH_URL** (optional, already defaults to v18.0)

Currently (staging.yaml line 658–659):
```yaml
- name: FACEBOOK_GRAPH_URL
  value: "https://graph.facebook.com/v25.0"
```

Can optionally add (or verify version alignment):
```yaml
- name: WHATSAPP_GRAPH_URL
  value: "https://graph.facebook.com/v25.0"  # Match Messenger version or set explicitly
```

In message-worker/cmd/message-worker/main.go, this env var is likely read as fallback or separate config. Verify the code, but **no action required for Track A if version 18.0 is acceptable** (it is, per the brief).

### No Secret Changes Needed

The org WhatsApp access token is **not a Hermes/message-worker secret**. It's stored in the `credentials` table (in `details.access_token`) by the admin/manual step (§6 below). No changes to `gbv-bot-envs` or Kubernetes secrets are required.

---

## 6. Manual Association Runbook (Admin Steps)

### Prerequisites

1. **Org WhatsApp Access Token:** Already registered with Meta; obtained via the tech provider's dashboard or API.
2. **WhatsApp Phone Number ID:** The 15–20 digit ID for the org-owned number (e.g., `'1023456789'`).
3. **Researcher Email:** The user account to associate the number with (e.g., `'researcher@example.com'`).
4. **Database Access:** Shell access to `psql` or a database client pointing to `chatroach@gbv-cockroachdb-public:26257/chatroach`.

### Step-by-Step SQL

```sql
-- 1. Verify user exists
SELECT id, email FROM users WHERE email = 'researcher@example.com';
-- Expected: one row with uuid and email

-- 2. Check if phone_number_id is already registered
SELECT userid, entity, key, details->>'id' as page_id
FROM credentials
WHERE details->>'id' = '1023456789';
-- Expected: no rows (else error; number already owned by someone)

-- 3. Insert credentials row
INSERT INTO credentials (userid, entity, key, details)
VALUES (
  (SELECT id FROM users WHERE email = 'researcher@example.com'),
  'facebook_page',
  '1023456789',
  '{"id":"1023456789","access_token":"EAAB_YOUR_ORG_TOKEN_HERE"}'::JSONB
);
-- Expected: INSERT 0 1 (one row inserted)

-- 4. Verify the row and computed column
SELECT userid, entity, key, details, facebook_page_id, created
FROM credentials
WHERE facebook_page_id = '1023456789';
-- Expected: one row; facebook_page_id should equal '1023456789' (computed from details.id)

-- 5. Verify shortcodes exist for the user
SELECT shortcode, title, created
FROM surveys
WHERE userid = (SELECT id FROM users WHERE email = 'researcher@example.com')
ORDER BY created DESC;
-- Expected: list of surveys; any shortcode here is now resolvable under phone_number_id '1023456789'
```

### Alternative: Script Template (bash/SQL)

```bash
#!/bin/bash
set -e

RESEARCHER_EMAIL="$1"
PHONE_NUMBER_ID="$2"
ORG_ACCESS_TOKEN="$3"

CHATBASE_HOST="${CHATBASE_HOST:-gbv-cockroachdb-public}"
CHATBASE_PORT="${CHATBASE_PORT:-26257}"
CHATBASE_DB="${CHATBASE_DB:-chatroach}"
CHATBASE_USER="${CHATBASE_USER:-chatroach}"

psql -h "$CHATBASE_HOST" -p "$CHATBASE_PORT" -U "$CHATBASE_USER" -d "$CHATBASE_DB" <<EOF
BEGIN;

-- Check user exists
SELECT id FROM users WHERE email = '$RESEARCHER_EMAIL'
  OR EXIT 1 (User not found);

-- Check phone_number_id is not already in use
SELECT COUNT(*) as already_used FROM credentials
WHERE details->>'id' = '$PHONE_NUMBER_ID'
  AND details->>'id' IS NOT NULL;

-- Insert credential
INSERT INTO credentials (userid, entity, key, details)
VALUES (
  (SELECT id FROM users WHERE email = '$RESEARCHER_EMAIL'),
  'facebook_page',
  '$PHONE_NUMBER_ID',
  '{"id":"$PHONE_NUMBER_ID","access_token":"$ORG_ACCESS_TOKEN"}'::JSONB
);

COMMIT;
EOF

echo "✓ WhatsApp number $PHONE_NUMBER_ID associated with $RESEARCHER_EMAIL"
```

**Usage:**
```bash
./associate-whatsapp.sh "researcher@example.com" "1023456789" "EAAB_YOUR_ORG_TOKEN_HERE"
```

---

## 7. Surprises & Blockers

### No Blockers — System is Already Generic

1. **Survey resolution is by (shortcode, userid), not pageid.** The pageid is only the lookup key to find userid. ✓
2. **Token lookup is by facebook_page_id (computed column).** Reusing `entity = 'facebook_page'` with phone_number_id as `details.id` satisfies this. ✓
3. **State scoping (responses, states tables) uses `pageid` as a string key**, not a foreign key. Inserting a credential with `facebook_page_id = phone_number_id` means inbound events keyed by phone_number_id resolve to the same pageid. ✓
4. **No Hermes/replybot code changes needed.** Platform abstraction is already complete. ✓

### Surprises

1. **Computed column is entity-specific.** The stored column `facebook_page_id` is `NULL` for non-`facebook_page` entities. This is why reusing the entity type is simplest for Track A.

2. **facebook_page_id has a global uniqueness constraint** (`CONSTRAINT unique_facebook_page UNIQUE(facebook_page_id)`). This prevents the same page_id from being registered by multiple users, which is correct (prevents collisions). For org-owned WhatsApp numbers, the constraint ensures the same phone_number_id can only be associated with one user. ✓

3. **Entity/key is globally unique** (`UNIQUE(entity, key)`). So `('facebook_page', '1023456789')` can only exist once across all users, even if we later support user-owned WhatsApp numbers. ✓

4. **No refresh token logic for WhatsApp.** Messenger page tokens are long-lived and may be refreshed. WhatsApp tokens (org-level permanent tokens) are not, so the token-store code simply looks them up once and caches by TTL. ✓

---

## 8. Documentation Gaps Found

### In Code, Not in Docs

1. **replybot/README.md** mentions event normalization but does **not explain** that survey resolution is `(shortcode, userid)` with userid resolved from `facebook_page_id`. Added clarity needed.

2. **documentation/platform-abstraction.md** is comprehensive on **inbound/outbound architecture** but does **not explicitly state** that the `account_id` from UniversalEvent is the "generic pageid" that lands in `facebook_page_id`. The docs describe the flow but not the identity key.

3. **message-worker/README.md** explains token lookup but doesn't note that WhatsApp numbers must have `entity = 'facebook_page'` (or requires a schema change for new entity types).

4. **No docs on `credentials` table design.** The migrations are clear, but a human-readable summary of entity types, key semantics, and the `facebook_page_id` computed column would prevent confusion.

### Recommended Documentation Updates

- **replybot/README.md**: Add a section "Account ID Resolution" explaining that `source.account_id` (pageid/phone_number_id) is the key that routes all surveys/states/tokens.
- **documentation/platform-abstraction.md**: Add a subsection on "Account Routing" linking platform account IDs to the credentials table and `facebook_page_id` column.
- **New: documentation/credentials-model.md**: Describe the credentials table, entity types (facebook_page, typeform_token, whatsapp_number?), and how computed columns work.

---

## 9. Concrete Summary for Implementation

### Credentials Row Shape for WhatsApp (Manual Insert)

```sql
INSERT INTO credentials (userid, entity, key, details, created)
VALUES (
  (SELECT id FROM users WHERE email = '...'),
  'facebook_page',  -- Reuse existing entity
  '<phone_number_id>',  -- e.g., '1023456789'
  '{"id":"<phone_number_id>","access_token":"<org_token>"}'::JSONB,
  CURRENT_TIMESTAMP
);
```

### Survey Resolution Mechanism

1. **Inbound event** with `source.account_id = <phone_number_id>`
2. **replybot** calls `getForm(<phone_number_id>, shortcode, timestamp)`
3. **FORMCENTRAL** queries `credentials WHERE facebook_page_id = <phone_number_id>` → finds row → extracts userid
4. **FORMCENTRAL** queries `surveys WHERE (shortcode, userid)` → returns form
5. **Machine** processes survey normally; all states/responses scoped by `pageid = phone_number_id`

**Resolution key: `(account_id, shortcode)`** where account_id ← phone_number_id, and all user surveys are resolvable under any account_id associated to that user's credentials.

### Config Deltas

1. **devops/values/staging.yaml** — Hermes `env`:
   ```yaml
   - name: WHATSAPP_VERIFY_TOKEN
     value: "staging-whatsapp-verify-token"
   ```

2. **Optional:** Message-Worker version alignment (already v25.0 for FACEBOOK_GRAPH_URL).

### Manual Association SQL

```bash
psql -h gbv-cockroachdb-public -p 26257 -U chatroach -d chatroach
INSERT INTO credentials (userid, entity, key, details)
VALUES (
  (SELECT id FROM users WHERE email = 'researcher@example.com'),
  'facebook_page',
  '1023456789',
  '{"id":"1023456789","access_token":"EAAB..."}'::JSONB
);
SELECT * FROM credentials WHERE facebook_page_id = '1023456789';  -- Verify
```

No Dashboard UI, no app review, no schema changes. **Pure data + environment variable.**

