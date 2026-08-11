# DingConnect Credentials Pattern Investigation

**Date:** March 3, 2026
**File Path:** `/home/nandan/Documents/vlab-research/fly-dingconnect/dinersclub/`

---

## Summary

The dinersclub payment processor supports multiple providers (Reloadly, HTTP, GiftCards, DingConnect) with **two distinct credential patterns**:

1. **Database-per-user pattern** (Reloadly, HTTP): Credentials stored per user in the `credentials` table, fetched dynamically by `Auth()`
2. **Global env-var pattern** (DingConnect): Single API key from environment at provider creation time

DingConnect currently uses the simpler env-var pattern, but should migrate to the database-per-user pattern to match Reloadly and provide per-user, per-key credential management.

---

## Detailed Analysis

### 1. Auth() Signature & Purpose

**Interface Definition** (`provider.go` lines 56-60):
```go
type Provider interface {
    GetUserFromPaymentEvent(*PaymentEvent) (*User, error)
    Auth(*User, string) error  // ← user + key string
    Payout(*PaymentEvent) (*Result, error)
}
```

**What Auth() Receives:**
- `*User` — The user struct with `Id` field (string UUID)
- `key string` — A string key from `PaymentEvent.Key` field; allows per-user/per-key credential sets

**What Auth() Returns:**
- `error` — Only returns error on failure; success is nil
- **Side Effect:** Modifies provider internal state (credentials/secrets cached in memory)

**Call Location** (`main.go` lines 113, 149):
```go
e := provider.Auth(user, pe.Key)  // Called in checkCache() before Payout()
```

---

### 2. Reloadly Pattern: Database-Per-User Credentials

**Reloadly Auth Implementation** (`reloadly.go` lines 77-100):

```go
func (p *ReloadlyProvider) Auth(user *User, key string) error {
    if key == "" {
        return fmt.Errorf(`No key provided for Reloadly provider...`)
    }

    crds, err := p.getCredentials(user.Id, key)  // ← Fetch from DB
    if err != nil {
        return err
    }
    if crds == nil {
        return fmt.Errorf(`No reloadly credentials were found for user: %s`, user.Id)
    }

    auth := struct {
        Id     string `json:"id"`
        Secret string `json:"secret"`
    }{}
    err = json.Unmarshal(*crds.Details, &auth)  // ← Parse JSON details
    if err != nil {
        return err
    }

    return p.svc.Auth(auth.Id, auth.Secret)  // ← Configure reloadly service
}
```

**Database Query** (`reloadly.go` lines 102-113):

```go
func (p *ReloadlyProvider) getCredentials(userid string, key string) (*Credentials, error) {
    query := `SELECT details FROM credentials WHERE entity='reloadly' AND userid=$1 AND key=$2 LIMIT 1`
    row := p.pool.QueryRow(context.Background(), query, userid, key)
    var c Credentials
    err := row.Scan(&c.Details)

    if err == pgx.ErrNoRows {
        return nil, nil
    }

    return &c, err
}
```

**Credentials Struct** (`db.go` lines 15-17):
```go
type Credentials struct {
    Details *json.RawMessage  // ← Stored as JSON blob
}
```

**Test Setup** (`reloadly_test.go` lines 86-90):
```go
insertReloadlySql := `
    INSERT INTO credentials(userid, entity, key, details)
    VALUES ('00000000-0000-0000-0000-000000000000', 'reloadly', 'test-key',
            '{"id": "test-id", "secret": "test-secret"}');
`
```

---

### 3. HTTP Provider Pattern: Database-per-user with Multiple Secrets

**HTTP Auth Implementation** (`http_provider.go` lines 34-60):

```go
func (p *HttpProvider) Auth(user *User, key string) error {
    // Query ALL secrets for the user (not keyed by key parameter)
    query := `SELECT key, details->>'value' FROM credentials WHERE entity='secrets' AND userid=$1`

    rows, err := p.pool.Query(context.Background(), query, user.Id)
    if err != nil {
        return err
    }

    defer rows.Close()

    for rows.Next() {
        var a string
        var b string
        err := rows.Scan(&a, &b)
        if err != nil {
            return err
        }
        p.secrets[a] = b  // ← Store in-memory map for interpolation
    }

    if rows.Err() != nil {
        return err
    }

    return nil
}
```

**Key Difference from Reloadly:**
- Fetches **all secrets** for the user in a single query (using `WHERE entity='secrets'`)
- Uses `details->>'value'` to extract the secret value from the JSON blob
- Stores in a map for later template interpolation with mustache syntax

---

### 4. DingConnect Current Pattern: Global Environment Variable

**DingConnect Auth Implementation** (`dingconnect.go` lines 97-99):

```go
func (p *DingConnectProvider) Auth(user *User, key string) error {
    return nil  // ← No-op!
}
```

**DingConnect Constructor** (`dingconnect.go` lines 78-88):

```go
func NewDingConnectProvider(pool *pgxpool.Pool) (Provider, error) {
    apiKey := os.Getenv("DINGCONNECT_API_KEY")  // ← Single global key
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

**Payout Usage** (`dingconnect.go` line 163):
```go
req.Header.Set("X-Api-Key", p.apiKey)  // ← Static field, set once at creation
```

---

### 5. Payout() Receives Auth Result

**Payout Flow in main.go** (`main.go` lines 105-120):

```go
func (dc *DC) checkCache(provider Provider, pe *PaymentEvent, user *User) (Provider, error) {
    key := pe.Provider + pe.Key + user.Id
    p, ok := dc.cache.Get(key)
    if ok {
        return p.(Provider), nil  // ← Cache hit: return authed provider
    }
    e := provider.Auth(user, pe.Key)  // ← Auth call
    if e != nil {
        return nil, e
    }

    dc.cache.SetWithTTL(key, provider, 1, dc.cfg.CacheTTL)  // ← Cache authed provider
    return provider, nil
}

func (dc *DC) Job(pe *PaymentEvent) error {
    // ...
    provider, e := dc.checkCache(provider, pe, user)  // ← Get authed provider
    if e != nil {
        return dc.sendResult(pe, authError(pe, e))
    }

    res := new(Result)
    op := func() error {
        r, e := provider.Payout(pe)  // ← Call Payout on authed provider
        if e != nil {
            return e
        }
        res = r
        return nil
    }
    // ...
}
```

**Key Points:**
1. The provider object is cached **after** successful `Auth()`
2. The `Auth()` call modifies the provider's internal state (for Reloadly: `p.svc.Auth()` is called)
3. `Payout()` is called on the **same provider instance** that was authed
4. This works because the provider holds references to the configured service/secrets

---

### 6. DingConnect vs Reloadly: Key Differences

| Aspect | Reloadly | DingConnect |
|--------|----------|-------------|
| **API Key Storage** | Database per user + key | Environment variable (global) |
| **Auth() Role** | Fetch creds from DB, configure service | No-op |
| **Key Parameter Used** | Yes, filters credentials by key | No, ignored |
| **Per-User Keys** | Yes, multiple keys per user supported | No, single global key |
| **Secrets in Payout** | Via `p.svc.Auth()` in Auth() | Directly from `p.apiKey` field |
| **Security Model** | Multi-tenant, key isolation | Single-key per deployment |

---

## Structural Requirements for Database-Based Credentials

### Table Schema (credentials table)

```sql
CREATE TABLE credentials (
    userid VARCHAR,
    entity VARCHAR,          -- 'reloadly', 'dingconnect', 'facebook_page', 'secrets', etc.
    key VARCHAR,             -- Provider-specific key (e.g., 'prod', 'test', or survey-specific)
    facebook_page_id VARCHAR,
    details JSONB            -- Flexible JSON structure per entity type
);
```

### For Reloadly:
- **entity:** `'reloadly'`
- **key:** Survey/account-specific identifier (e.g., `'test-key'`, `'prod-key'`)
- **details:** `{"id": "...", "secret": "..."}`

### For DingConnect (proposed):
- **entity:** `'dingconnect'`
- **key:** Survey/account-specific identifier (e.g., `'test-key'`, `'prod-key'`)
- **details:** `{"api_key": "..."}`

---

## Cache Behavior

**Cache Key Pattern** (`main.go` line 108):
```go
key := pe.Provider + pe.Key + user.Id
// e.g., "reloadlytest-key00000000-0000-0000-0000-000000000000"
```

- Cache provides per-user, per-key, per-provider isolation
- TTL configured via `CACHE_TTL` env var
- Cache stores the **entire provider instance** after Auth succeeds

---

## Summary: What Auth() Actually Does

1. **For Reloadly:**
   - Takes user ID and key string
   - Queries database for credentials with `entity='reloadly'`
   - Unmarshals JSON details into struct with `id` and `secret`
   - Calls `p.svc.Auth(id, secret)` to configure the service
   - Returns error if credentials missing/invalid

2. **For HTTP:**
   - Takes user ID (ignores key string)
   - Queries database for ALL credentials with `entity='secrets'`
   - Stores them in a map for template interpolation
   - Returns error if query fails

3. **For DingConnect (current):**
   - Does nothing (returns nil immediately)
   - API key was already loaded from environment at construction time

---

## Risks & Concerns

1. **Environment Variable Lifetime:** The env var approach means credentials cannot be updated without redeploying
2. **No Per-User Isolation:** All users share a single DingConnect API key (potential security issue)
3. **No Key Rotation:** Can't rotate keys per-user or per-account
4. **Inconsistent Pattern:** DingConnect should follow Reloadly's proven pattern for consistency
