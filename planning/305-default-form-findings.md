# Finding: Default Form Shortcode (305) Hardcoding & Referral Resolution Flow

## Summary

The default form shortcode `305` is currently hardcoded as an **environment variable** (`FALLBACK_FORM=305`) in deployment manifests. When a user arrives via Facebook Messenger referral without a form specification, the system falls back to this single global default. The page identity **is available** at the fallback point, but there is **no per-page configuration table** to store page-specific defaults yet.

---

## 1. Where 305 is Hardcoded

**Location**: Kubernetes deployment configuration (not JavaScript code)

- **File**: `/home/nandan/Documents/vlab-research/fly/replybot/kube/deployment.yaml:56-57`
- **Value**: `FALLBACK_FORM: "305"`

Also defined in:
- `/home/nandan/Documents/vlab-research/fly/devops/values/production.yaml` (as reference anchor)
- `/home/nandan/Documents/vlab-research/fly/replybot/kube-dev/dev.yaml`
- `/home/nandan/Documents/vlab-research/fly/replybot/kube-scratch/scratch-deployment.yaml`

**Implementation**: Set as environment variable `process.env.FALLBACK_FORM` in Node.js code.

---

## 2. Referral → Form Resolution Flow

### 2.1 Event Entry Point (BotServer)

**File**: `/home/nandan/Documents/vlab-research/fly/botserver/server/handlers.js:54-91`

The `handleMessengerEvents()` function:
1. Accepts incoming Facebook webhook events
2. Loops through event types: `['messaging', 'messaging_handovers']`
3. Normalizes timestamp and adds `source: 'messenger'`
4. Produces event to Kafka topic (`eventTopic`)
5. **Current limitation**: Line 62 does NOT include `'messaging_referrals'` as an event type yet (only `messaging` and `messaging_handovers`)

### 2.2 Referral Event Categorization (Replybot)

**File**: `/home/nandu/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js:163-170`

`categorizeEvent(nxt)` identifies a REFERRAL event by detecting:
- `nxt.referral` (top-level referral object)
- `nxt.postback && nxt.postback.referral`
- `nxt.postback && nxt.postback.payload === 'get_started'`
- `_.get(nxt, ['postback', 'payload', 'referral'])`
- `_.get(nxt, ['message', 'quick_reply', 'payload', 'referral'])`

### 2.3 Form Shortcode Extraction (Referral Handler)

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js:254-279`

When `categorizeEvent()` returns `'REFERRAL'`:
1. Calls `getForm(nxt)` to extract the form shortcode
2. Checks if the form is a reset shortcode (`process.env.REPLYBOT_RESET_SHORTCODE`)
3. Validates that the user is not blocked and has not already seen this form
4. Calls `_blankStart(nxt)` to initiate the form

### 2.4 Form Shortcode Extraction with Fallback

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/utils.js:40-67`

The `getMetadata(event)` function extracts form shortcode from referral URL:

```javascript
const r = event.referral ||
  _.get(event, ['postback', 'referral']) ||
  _.get(event, ['postback', 'payload', 'referral']) ||
  _.get(event, ['message', 'quick_reply', 'payload', 'referral'])

const pairs = r.ref.split('.')  // Parse "form.SHORTCODE.key.value" format
md = _group(pairs.map(decodeURIComponent))
md.form = md.form || process.env.FALLBACK_FORM  // Fallback to 305 here
```

**Test case** (line 22-24 in `utils.test.js`):
```javascript
it('gets the fallback form when referral has no form', () => {
  u.getForm({ ...referral, referral: { ref: 'blah' } }).should.equal('fallback')
})
```

Referral URL format: `?ref=form.FOO.key.value` (key-value pairs after form shortcode)

### 2.5 Metadata Extraction Includes Page ID

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/utils.js:61`

The `getMetadata()` function calls:
```javascript
md.pageid = getPageFromEvent(event)
```

**Page ID extraction** (`@vlab-research/utils/lib/utils.js:40-55`):
- Checks `event.recipient.id` (Page ID from Facebook webhook)
- Checks `event.sender.id` (User ID - fallback for echo messages)
- Throws error if neither is found

**Critical**: Page ID is **available at the point of fallback** (line 61 of `utils.js` executes AFTER form extraction on line 59).

---

## 3. Database Schema: Facebook Pages Table

**Location**: `/home/nandan/Documents/vlab-research/fly/devops/all.sql:1285-1288`

Current schema:
```sql
CREATE TABLE chatroach.facebook_pages(
       pageid VARCHAR PRIMARY KEY,
       userid UUID REFERENCES chatroach.users(id) ON DELETE CASCADE
);

ALTER TABLE chatroach.facebook_pages ADD COLUMN token VARCHAR;
```

**Current columns**:
- `pageid` (VARCHAR PRIMARY KEY) — Facebook page ID
- `userid` (UUID) — Dashboard user who connected the page
- `token` (VARCHAR) — Page access token

**No existing `default_form_shortcode` column** — must be added for per-page configuration.

---

## 4. Data Model: Form/Survey Representation

**Location**: `/home/nandan/Documents/vlab-research/fly/devops/all.sql:1296-1307`

Surveys/forms are stored in a `surveys` table:
```sql
CREATE TABLE chatroach.surveys(
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       created TIMESTAMPTZ NOT NULL,
       formid VARCHAR NOT NULL,
       form VARCHAR NOT NULL,           -- Full Typeform definition (JSON)
       messages VARCHAR,
       shortcode VARCHAR NOT NULL,      -- The "305" / form code
       title VARCHAR NOT NULL,
       userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE
);
```

**Key point**: Shortcode (e.g., `305`) is the primary lookup key for forms. Forms are full Typeform survey definitions stored as JSON.

---

## 5. Current Referral URL Format

From test files (`utils.test.js:48-58` and `form.test.js`):

Example referral in test:
```javascript
referral: {
  ref: 'form.FOO.foo.bar'  // Parses to: { form: 'FOO', foo: 'bar' }
}
```

From botserver README:
```
https://m.me/testvirtuallab?ref=K41s40.001
```

Format: Key-value pairs separated by dots. The first pair is `form.SHORTCODE`, rest are arbitrary metadata (user-provided, stored in `state.md`).

---

## 6. Data Flow Diagram

```
Facebook Webhook (referral event)
    ↓
botserver/handlers.js (produces to Kafka)
    ↓
replybot/lib/index.js (processor receives event)
    ↓
machine.js:categorizeEvent() → identifies as REFERRAL
    ↓
machine.js:REFERRAL case handler
    ↓
utils.js:getForm() → calls getMetadata()
    ↓
Extracts referral.ref: "form.SHORTCODE.key.value"
    ↓
Parse: form=SHORTCODE, then md.pageid = getPageFromEvent(event)
    ↓
Fall back: md.form = md.form || process.env.FALLBACK_FORM (305)
    ↓
Load form from surveys table via shortcode
    ↓
_blankStart(nxt) → initiate survey
```

---

## 7. Key Observations & Gaps

### 7.1 Environment Variable is Global
- `FALLBACK_FORM` is set once per deployment cluster
- Cannot vary per page currently
- Must be overridden via Kubernetes manifest edit + pod restart

### 7.2 Page ID is Available for Resolution
- `getPageFromEvent(event)` extracts page ID from `event.recipient.id`
- Executed in the same `getMetadata()` call as form fallback
- No technical barrier to per-page lookup

### 7.3 No Per-Page Config Table Yet
- `facebook_pages` table exists but has no `default_form_shortcode` column
- Dashboard does not expose per-page default form configuration
- No query functions in `dashboard-server/queries/` for page defaults

### 7.4 BotServer Does Not Forward Referral Events
- Webhook handler only processes `['messaging', 'messaging_handovers']`
- Should add `'messaging_referrals'` to be explicit (currently caught by `messaging` array)

### 7.5 Form Lookup Is Not Page-Aware Currently
- Form is loaded by shortcode alone (no page-specific variant checking)
- Multiple pages can share the same shortcode
- If pages need different surveys with same shortcode, current design doesn't support that

---

## 8. Files Requiring Changes for Redesign

| Component | File | Current Role | Change Required |
|-----------|------|--------------|-----------------|
| **Database** | `/devops/all.sql` | Schema definition | Add `default_form_shortcode` column to `facebook_pages` |
| **Replybot** | `/replybot/lib/typewheels/utils.js:59` | Form fallback logic | Query `facebook_pages` table instead of env var |
| **Dashboard** | `/dashboard-server/api/facebook/` | Page management | Expose API to set/get per-page default form |
| **Queries** | `/dashboard-server/queries/` | (new file) | Add function to fetch page config (shortcode) by `pageid` |
| **BotServer** | `/botserver/server/handlers.js:62` | Event handling | Optional: explicitly add `messaging_referrals` to event types |

---

## 9. Test Coverage

### Existing Tests
- `/replybot/lib/typewheels/utils.test.js:22-24` — Tests fallback behavior (currently sets `FALLBACK_FORM='fallback'`)
- `/replybot/lib/typewheels/machine.test.js` — Tests REFERRAL categorization

### Will Need to Add
- Per-page default form resolution test (mock DB lookup)
- Edge case: page with no configured default (should it fall back to global? Or error?)
- Edge case: referral with form shortcode + page with different default (shortcode takes precedence)

---

## 10. Referenced Code Snippets

### getMetadata() Full Implementation
**File**: `/replybot/lib/typewheels/utils.js:40-67`

### REFERRAL Handler in Machine
**File**: `/replybot/lib/typewheels/machine.js:254-279`

### getPageFromEvent() Implementation
**File**: `@vlab-research/utils/lib/utils.js:40-55`
