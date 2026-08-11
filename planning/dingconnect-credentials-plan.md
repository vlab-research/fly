# DingConnect Credentials Migration Plan

**Target:** Migrate DingConnect from environment-variable credentials to database-per-user pattern matching Reloadly

**Status:** Planning phase
**Last Updated:** March 3, 2026

---

## Overview

Refactor `DingConnectProvider` to fetch credentials from the database per user/key, matching the proven pattern established by Reloadly. This enables:
- Multi-tenant credential management
- Per-user API key isolation
- Key rotation without redeployment
- Consistent provider interface across all payment processors

---

## Changes Required

### 1. DingConnectProvider Struct Changes

**Current State** (`dingconnect.go` lines 16-21):
```go
type DingConnectProvider struct {
    apiKey string           // ← Currently holds single global API key
    client *http.Client
    pool   *pgxpool.Pool
}
```

**New State:**
```go
type DingConnectProvider struct {
    // Remove: apiKey string
    client *http.Client
    pool   *pgxpool.Pool
}
```

**Rationale:**
- Remove the static `apiKey` field
- API key will be fetched from database during `Auth()` and stored in a temporary/scoped variable
- No persistent key storage in the provider struct (matches Reloadly's approach)

---

### 2. NewDingConnectProvider Constructor Changes

**Current State** (`dingconnect.go` lines 78-88):
```go
func NewDingConnectProvider(pool *pgxpool.Pool) (Provider, error) {
    apiKey := os.Getenv("DINGCONNECT_API_KEY")
    if apiKey == "" {
        return nil, fmt.Errorf("DINGCONNECT_API_KEY environment variable not set")
    }
    return &DingConnectProvider{
        apiKey: apiKey,
        client: http.DefaultClient,
        pool:   pool,
    }, nil
}
```

**New State:**
```go
func NewDingConnectProvider(pool *pgxpool.Pool) (Provider, error) {
    return &DingConnectProvider{
        client: http.DefaultClient,
        pool:   pool,
    }, nil
}
```

**Rationale:**
- No longer validates environment variable at construction time
- Constructor becomes simple and lightweight
- Database validation happens at Auth() time (fail-fast on actual payment attempt, not startup)

**Note on DINGCONNECT_API_KEY env var:**
- **REMOVE the requirement** from documentation
- Can be safely deleted from environment/Helm values
- If present, it will be ignored (safe cleanup path)

---

### 3. Auth() Implementation

**Current State** (`dingconnect.go` lines 97-99):
```go
func (p *DingConnectProvider) Auth(user *User, key string) error {
    return nil
}
```

**New State:**
```go
func (p *DingConnectProvider) Auth(user *User, key string) error {
    if key == "" {
        return fmt.Errorf(`No key provided for DingConnect provider. A key is required for DingConnect Payment Events!`)
    }

    crds, err := p.getCredentials(user.Id, key)
    if err != nil {
        return err
    }
    if crds == nil {
        return fmt.Errorf(`No dingconnect credentials were found for user: %s`, user.Id)
    }

    auth := struct {
        ApiKey string `json:"api_key"`
    }{}
    err = json.Unmarshal(*crds.Details, &auth)
    if err != nil {
        return err
    }

    // Store the API key in the provider instance for use in Payout()
    p.apiKey = auth.ApiKey
    return nil
}
```

**New Private Method - getCredentials():**
```go
func (p *DingConnectProvider) getCredentials(userid string, key string) (*Credentials, error) {
    query := `SELECT details FROM credentials WHERE entity='dingconnect' AND userid=$1 AND key=$2 LIMIT 1`
    row := p.pool.QueryRow(context.Background(), query, userid, key)
    var c Credentials
    err := row.Scan(&c.Details)

    if err == pgx.ErrNoRows {
        return nil, nil
    }

    return &c, err
}
```

**Key Design Decisions:**

1. **Temporary API Key Storage:**
   - Add back the `apiKey` field to `DingConnectProvider` struct (temporarily during Auth/Payout cycle)
   - This field is populated ONLY during `Auth()`
   - Cleared implicitly when the provider is evicted from cache
   - This matches Reloadly's model where `p.svc` is configured in Auth()

2. **Entity Value:** `'dingconnect'` (lowercase, matches Reloadly's `'reloadly'`)

3. **Key Parameter:** Required (non-empty string), allows multiple API keys per user

4. **Details Structure:** `{"api_key": "..."}` (simpler than Reloadly which needs id+secret)

5. **Error Messages:** Match Reloadly's error text patterns for consistency

---

### 4. Payout() Changes

**Current State** (`dingconnect.go` lines 103-228):
```go
func (p *DingConnectProvider) Payout(event *PaymentEvent) (*Result, error) {
    // ... validation code ...
    req.Header.Set("X-Api-Key", p.apiKey)  // ← Uses p.apiKey field
    // ... rest of implementation ...
}
```

**New State:**
No changes needed to Payout() logic—it will continue to use `p.apiKey` which was populated by `Auth()`.

**Important Assumption:**
- `Payout()` is **always** called on a provider instance that has been authenticated via `Auth()` first
- This is guaranteed by the cache + checkCache pattern in main.go
- If `Auth()` fails, Payout is never called on that provider

---

### 5. GetUserFromPaymentEvent() Changes

**Current State** (`dingconnect.go` lines 91-93):
```go
func (p *DingConnectProvider) GetUserFromPaymentEvent(event *PaymentEvent) (*User, error) {
    return GenericGetUser(p.pool, event)
}
```

**New State:**
No changes needed. This remains the same.

---

## Database Schema Requirements

### Credentials Table Entry for DingConnect

**Insert Example:**
```sql
INSERT INTO credentials(userid, entity, key, details)
VALUES (
    '00000000-0000-0000-0000-000000000000',
    'dingconnect',
    'prod-key',
    '{"api_key": "dc_live_xxxxx..."}'
);
```

**Field Mapping:**
- `userid`: User UUID (matches credentials from user lookup)
- `entity`: `'dingconnect'` (literal string identifier)
- `key`: Account/environment identifier (e.g., `'prod'`, `'staging'`, `'test'`, or survey-specific)
- `details`: JSON blob with single field `api_key` containing the DingConnect API key

---

## Environment Variable Cleanup

### DINGCONNECT_API_KEY

**Current State:** Required, read at provider construction time

**New State:**
- No longer required
- No longer used by dinersclub
- Should be removed from:
  - `.env` files
  - Docker container environment
  - Helm values (`devops/values/production.yaml`, `devops/values/staging.yaml`, etc.)
  - Any deployment documentation

**Migration Path:**
1. After code changes are deployed, verify credentials are in database for all users
2. Remove the env var from environment in next deployment
3. Update documentation/setup guides

**Safety Note:**
- If env var is present but not read, no harm (just unused)
- Keep it in `.env.example` with a deprecation notice until all deployments are updated

---

## Testing Strategy

### Unit Tests to Add/Update

1. **TestDingConnectAuth_FetchesFromDatabase**
   - Insert credentials with `entity='dingconnect'`
   - Call `Auth(user, key)`
   - Verify `p.apiKey` is set correctly

2. **TestDingConnectAuth_MissingCredentials**
   - Call `Auth()` for user with no dingconnect credentials
   - Verify error: "No dingconnect credentials were found for user: ..."

3. **TestDingConnectAuth_EmptyKey**
   - Call `Auth(user, "")`
   - Verify error: "No key provided for DingConnect provider..."

4. **TestDingConnectAuth_InvalidJSON**
   - Insert credentials with malformed JSON details
   - Call `Auth()`
   - Verify JSON unmarshal error is returned

5. **TestDingConnectPayout_WorksWithAuthenticatedProvider**
   - Insert valid dingconnect credentials in DB
   - Call Auth() successfully
   - Call Payout() with valid payment details
   - Verify Payout uses the apiKey from Auth

### Integration Tests

Use the same pattern as Reloadly tests:
- Set up test database
- Insert user, facebook_page, and dingconnect credentials
- Call GetUserFromPaymentEvent → Auth → Payout sequence
- Verify entire flow works end-to-end

### Test Database Setup

```sql
-- Test user
INSERT INTO users(id, email)
VALUES ('00000000-0000-0000-0000-000000000000', 'test@test.com');

-- Facebook page reference
INSERT INTO credentials(userid, entity, key, details)
VALUES ('00000000-0000-0000-0000-000000000000', 'facebook_page', 'test-key', '{"id": "page"}');

-- DingConnect API key
INSERT INTO credentials(userid, entity, key, details)
VALUES ('00000000-0000-0000-0000-000000000000', 'dingconnect', 'test-key',
        '{"api_key": "test_api_key_12345"}');
```

---

## Deployment Considerations

### Helm Values Changes

**Files to Update:**
- `devops/values/production.yaml`
- `devops/values/staging.yaml`
- `devops/values/development.yaml`

**Changes:**
```yaml
# BEFORE
dinersclub:
  env:
    DINGCONNECT_API_KEY: "dc_live_xxxxx"

# AFTER
dinersclub:
  env:
    # DINGCONNECT_API_KEY removed
    # Credentials now fetched from database per user
```

### Database Migration

No schema changes needed (credentials table already exists and is used by Reloadly).

Pre-deployment checklist:
- [ ] Verify all users who need DingConnect have credentials inserted in credentials table
- [ ] Credentials have `entity='dingconnect'` and valid JSON details with `api_key` field
- [ ] Test in staging environment first
- [ ] Have rollback plan (revert code + restore env var if needed)

---

## Rollback Plan

If issues arise:

1. **Code Rollback:** Revert `dingconnect.go` to previous version (before Auth() changes)
2. **Restore Env Var:** Add `DINGCONNECT_API_KEY` back to environment
3. **No Database Changes Needed:** Credentials remain in place for future re-enablement

---

## Validation Checklist

Before marking implementation complete:

- [ ] `DingConnectProvider` struct no longer has `apiKey` field (added back during Auth)
- [ ] `Auth()` validates key parameter is non-empty
- [ ] `Auth()` queries credentials table with `entity='dingconnect'`
- [ ] `Auth()` unmarshals details as `{"api_key": "..."}`
- [ ] `Auth()` stores apiKey in provider for Payout to use
- [ ] `getCredentials()` private method implemented (copied from Reloadly)
- [ ] `NewDingConnectProvider()` no longer reads env var
- [ ] All existing Payout() logic unchanged (uses `p.apiKey`)
- [ ] New unit tests pass (all 5 test cases above)
- [ ] Integration tests pass (full Auth → Payout flow)
- [ ] Error messages match Reloadly style
- [ ] DINGCONNECT_API_KEY removed from Helm values
- [ ] Documentation updated

---

## Files to Modify

1. `/home/nandan/Documents/vlab-research/fly-dingconnect/dinersclub/dingconnect.go`
   - Modify struct definition
   - Rewrite NewDingConnectProvider()
   - Rewrite Auth()
   - Add getCredentials()

2. `/home/nandan/Documents/vlab-research/fly-dingconnect/dinersclub/dingconnect_test.go`
   - Add/update unit tests (5+ new test cases)
   - Update integration test setup

3. `/home/nandan/Documents/vlab-research/devops/values/production.yaml`
   - Remove DINGCONNECT_API_KEY env var

4. `/home/nandan/Documents/vlab-research/devops/values/staging.yaml`
   - Remove DINGCONNECT_API_KEY env var

5. `/home/nandan/Documents/vlab-research/fly-dingconnect/dinersclub/.env`
   - Remove DINGCONNECT_API_KEY (or mark as deprecated)

---

## Implementation Order

1. **Update provider struct & Auth()** in dingconnect.go
2. **Add getCredentials() private method**
3. **Update NewDingConnectProvider() constructor**
4. **Write unit tests** (test database operations)
5. **Write integration tests** (full flow with Payout)
6. **Update Helm values** (remove env var)
7. **Update .env** files
8. **Test in staging environment**
9. **Verify database credentials are in place for all users**
10. **Deploy to production with monitoring**

---

## Success Metrics

- Auth() no longer uses environment variables
- All payment requests require database credentials
- Tests pass with various credential scenarios
- Error messages are clear when credentials missing
- DingConnect follows same pattern as Reloadly
