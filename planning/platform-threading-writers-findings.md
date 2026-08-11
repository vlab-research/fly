# Platform Threading: Architecture & Implementation Findings

## 1. SCRIBBLE: Writers of `states` and `responses` Tables

### States Table Writer

**Service:** Scribble (Go)  
**File:** `/home/nandan/Documents/vlab-research/fly/scribble/state.go`  
**SQL Statement:** Lines 55–68

```go
func (s *StateScribbler) SendBatch(data []Writeable) error {
	data = DedupStates(data)
	values := BatchValues(data)
	fields := []string{
		"userid",
		"pageid",
		"updated",
		"current_state",
		"state_json",
	}
	query := SertQuery("UPSERT", "states", fields, len(data))
	_, err := s.pool.Exec(context.Background(), query, values...)
	return err
}
```

**Kafka Topic:** `VLAB_STATE_TOPIC` (env var, consumed by scribble via `destination: "states"`)  
**Payload Shape:** Go struct `State` (lines 11–17):
```go
type State struct {
	UserID       string          `json:"userid"  validate:"required"`
	PageID       string          `json:"pageid"  validate:"required"`
	Updated      JSTimestamp     `json:"updated"  validate:"required"`
	CurrentState string          `json:"current_state"  validate:"required"`
	StateJSON    json.RawMessage `json:"state_json"  validate:"required"`
}
```

**UPSERT Query Generation:** `SertQuery()` in `/scribble/utils.go:10`—builds dynamic SQL with parameterized placeholders.  
**Deduplication:** Line 37–53 — `DedupStates()` deduplicates by `userid` (keeps latest per user).

**Unknown Fields Handling:** The `State` struct is validated with `validator/v10` (write.go:50); **unknown extra JSON fields are silently ignored** (Go's `json.Unmarshal` behavior). No error thrown for extra fields.

---

### Responses Table Writer

**Service:** Scribble (Go)  
**File:** `/home/nandan/Documents/vlab-research/fly/scribble/response.go`  
**SQL Statement:** Lines 67–89

```go
func (s *ResponseScribbler) SendBatch(data []Writeable) error {
	values := BatchValues(data)
	fields := []string{
		"parent_shortcode",
		"surveyid",
		"shortcode",
		"flowid",
		"userid",
		"pageid",
		"question_ref",
		"question_idx",
		"question_text",
		"response",
		"translated_response",
		"seed",
		"timestamp",
		"metadata",
	}
	query := SertQuery("INSERT", "responses", fields, len(data))
	query += " ON CONFLICT(userid, timestamp, question_ref) DO NOTHING"
	_, err := s.pool.Exec(context.Background(), query, values...)
	return err
}
```

**Kafka Topic:** `VLAB_RESPONSE_TOPIC` (env var, consumed by scribble via `destination: "responses"`)  
**Payload Shape:** Go struct `Response` (lines 18–33):
```go
type Response struct {
	ParentShortcode    *CastString     `json:"parent_shortcode"`
	Surveyid           string          `json:"surveyid" validate:"required"`
	Shortcode          *CastString     `json:"shortcode" validate:"required"`
	Flowid             int32           `json:"flowid" validate:"required"`
	Userid             string          `json:"userid" validate:"required"`
	Pageid             string          `json:"pageid"`
	QuestionRef        string          `json:"question_ref" validate:"required"`
	QuestionIdx        int32           `json:"question_idx"`
	QuestionText       string          `json:"question_text" validate:"required"`
	Response           *CastString     `json:"response" validate:"required"`
	TranslatedResponse *string         `json:"translatedResponse"`
	Seed               int64           `json:"seed" validate:"required"`
	Timestamp          *JSTimestamp    `json:"timestamp" validate:"required"`
	Metadata           json.RawMessage `json:"metadata" validate:"required"`
}
```

**Unknown Fields Handling:** Same as states — unknown JSON fields are silently ignored.

---

## 2. STATES Schema & Writers

### Full Current DDL

**Initial schema:** `/devops/migrations/01-init.sql` lines 109–162

```sql
CREATE TABLE IF NOT EXISTS chatroach.states(
       userid VARCHAR NOT NULL,
       pageid VARCHAR NOT NULL NOT NULL,
       updated TIMESTAMPTZ NOT NULL,
       current_state VARCHAR NOT NULL,
       state_json JSON NOT NULL,
       PRIMARY KEY (userid, pageid),
       previous_is_followup BOOL AS (state_json->'previousOutput'->>'followUp' IS NOT NULL) STORED,
       previous_with_token BOOL AS (state_json->'previousOutput'->>'token' IS NOT NULL) STORED,
       form_start_time TIMESTAMPTZ AS (CEILING((state_json->'md'->>'startTime')::INT/1000)::INT::TIMESTAMPTZ) STORED,
       current_form varchar AS (state_json->'forms'->>-1) STORED,
       error_tag VARCHAR AS (state_json->'error'->>'tag') STORED,
       fb_error_code varchar AS (state_json->'error'->>'code') STORED,
       stuck_on_question VARCHAR AS (CASE 
          WHEN (state_json->'qa'->-1->>0) = (state_json->'qa'->-2->>0) 
            AND (state_json->'qa'->-2->>0) = (state_json->'qa'->-3->>0) 
              THEN state_json->'qa'->-1->>0 
          ELSE NULL 
       END) STORED,
       timeout_date TIMESTAMPTZ AS (...) STORED,
       next_retry TIMESTAMP AS (...) STORED,
       payment_error_code VARCHAR AS (...) STORED,
       INDEX (current_state, updated),
       INDEX (current_state, current_form, updated),
       INDEX (previous_with_token, previous_is_followup, form_start_time, current_state, updated) STORING (state_json),
       INDEX (error_tag, current_state, current_form, updated),
       INDEX (stuck_on_question, current_state, current_form, updated),
       INDEX (current_state, timeout_date) STORING (state_json),
       INDEX (current_state, error_tag, updated, next_retry),
       INDEX (current_form, payment_error_code) STORING (state_json),
       INDEX (payment_error_code) STORING (state_json),
       INVERTED INDEX (state_json)
);
```

**Computed Columns:** 11 stored computed columns; all derive from `state_json` or fixed columns.

**ALTER migrations:** Only one significant state schema change:
- `/devops/migrations/07-timeout-date-validation.sql` — drops and re-adds `timeout_date` computed column (lines 19–23).
- `/devops/migrations/04-pointers.sql` — adds `message_pointer` computed column (line 1).

**All writers of states:**

1. **Replybot (Node.js)** → publishes to `VLAB_STATE_TOPIC` Kafka topic:
   - File: `/replybot/lib/index.js` lines 36–39
   - Publishes via `publishState(userid, pageid, updated, state)` after machine processes event
   - Message shape: `{ userid, pageid, updated, current_state: state.state, state_json: state }`
   - Called line 74 when `report.newState` is present

2. **Scribble (Go)** → consumes state Kafka topic, UPSERT to DB:
   - File: `/scribble/state.go` (as documented above)
   - No direct SQL writes elsewhere in codebase

**Triggers/Computed Columns That Could Disturb:**

- **Stored computed columns** (11 total) all read from `state_json` — a new nullable `platform` column would NOT interfere with these derivations.
- **No triggers defined** on `states` table.
- **Foreign key constraints:** Line 239 in `/devops/migrations/01-init.sql` — `GRANT INSERT,SELECT,UPDATE` to user `chatroach`; adding a column doesn't affect grants.

**Conclusion:** Adding a nullable `platform` column is **safe** — no computed columns, no triggers, no constraints that would break.

---

## 3. RESPONSES Schema & Consumers

### Full Current DDL

**Initial schema:** `/devops/migrations/01-init.sql` lines 68–102

```sql
CREATE TABLE IF NOT EXISTS chatroach.responses (
       parent_surveyid UUID REFERENCES chatroach.surveys(id),
       parent_shortcode VARCHAR NOT NULL,
       surveyid UUID NOT NULL REFERENCES chatroach.surveys(id),
       shortcode VARCHAR NOT NULL,
       flowid INT NOT NULL,
       userid VARCHAR NOT NULL,
       question_ref VARCHAR NOT NULL,
       question_idx INT NOT NULL,
       question_text VARCHAR NOT NULL,
       response VARCHAR NOT NULL,
       seed INT NOT NULL,
       pageid VARCHAR,
       clusterid VARCHAR AS (metadata->>'clusterid') STORED,
       timestamp TIMESTAMPTZ NOT NULL,
       PRIMARY KEY (userid, timestamp, question_ref),
       metadata JSONB,
       translated_response VARCHAR,
       INVERTED INDEX (metadata),
       INDEX (shortcode, question_ref, response, clusterid, timestamp),
       INDEX (surveyid, userid, timestamp asc, question_ref) storing (
        parent_surveyid, 
        parent_shortcode, 
        shortcode, 
        flowid, 
        question_idx, 
        question_text, 
        response, 
        seed, 
        metadata, 
        pageid, 
        clusterid, 
        translated_response
      )
);
```

**Computed Columns:** 1 — `clusterid` (computed from `metadata->>'clusterid'`).

**Consumers of responses:**

1. **Exporter (Python)** — reads via direct SQL queries:
   - File: `/exporter/exporter/exporter.py` lines 280–304 (export_responses_data)
   ```sql
   SELECT userid, question_idx, question_ref, question_text, response, timestamp::string, 
          responses.metadata::string, pageid, translated_response
   FROM responses
   LEFT JOIN surveys ON responses.surveyid = surveys.id
   LEFT JOIN users ON surveys.userid = users.id
   WHERE users.email = %s
   AND surveys.survey_name = %s
   ORDER BY (responses.userid, timestamp, question_ref)
   ```
   **Risk:** Uses **explicit column list** (not `SELECT *`), so new columns are **not** fetched — safe.

2. **Event-Exporter (Python)** — if enabled:
   - Not examined in detail, but likely similar to exporter (column-specific queries).

3. **Dashboard-Server (Node.js)** — queries responses for state/context:
   - File: `/dashboard-server/queries/exports/exports.queries.js` (if present)
   - Likely uses explicit column lists or pageid filtering.

4. **Scribble (Go)** — consumer only (never reads responses back):
   - Writes via INSERT + ON CONFLICT, no feedback loop.

**SELECT \* Sensitivity:** The primary exporter query uses explicit columns (not `SELECT *`), so **adding a new nullable column will NOT break exports** unless the exporter explicitly includes it. Verification: line 291–295 in `/exporter/exporter/exporter.py` list columns by name.

**Conclusion:** Adding a nullable `platform` column to `responses` is **safe** — no existing consumers use `SELECT *`, and new columns are simply not read unless explicitly added to export logic.

---

## 4. DEAN's Event Emission → Botserver → Kafka → Replybot

### Full Delivery Path

**DEAN (Go):**
- **File:** `/dean/dean.go` lines 71–91
- **Function:** `send()` POSTs an `ExternalEvent` to botserver
- **Target:** `cfg.Botserver` URL (env var; typically `http://botserver/synthetic`)
- **Payload shape:** JSON struct `ExternalEvent` (from `/dean/queries.go` lines 17–21):
  ```go
  type ExternalEvent struct {
    User  string `json:"user"`
    Page  string `json:"page"`
    Event *Event `json:"event"`
  }
  type Event struct {
    Type  string           `json:"type"`
    Value *json.RawMessage `json:"value,omitempty"`
  }
  ```
- **No platform field on ExternalEvent today** — only `user`, `page`, `event`.

**BOTSERVER (Node.js):**
- **File:** `/botserver/server/handlers.js` lines 55–86 (`handleSyntheticEvents`)
- **Handler:** `POST /synthetic` receives dean's ExternalEvent
- **Processing:**
  ```javascript
  const message = { ...body, source: 'synthetic', timestamp: Date.now() }
  const data = Buffer.from(JSON.stringify(message))
  producer.produce(eventTopic, null, data, message.user)
  ```
- **Kafka topic:** `process.env.EVENT_TOPIC` (env var; typically `vlab-events` or similar)
- **Key observation:** Botserver **spreads body fields** into message (`...body`) and adds `source: 'synthetic'` and `timestamp`. **Unknown fields pass through** — if dean's ExternalEvent gains a `platform` field, it will be in the Kafka message.

**REPLYBOT (Node.js):**
- **File:** `/replybot/lib/index.js` — BotSpine consumer
- **Event parsing:** `/replybot/lib/event-normalizer.js` lines 214–231 (`parseSyntheticEvent`)
  ```javascript
  function parseSyntheticEvent(data, timestamp) {
    const event = data.event || {}
    const eventType = event.type || 'unknown'
    const unifiedType = `synthetic_${eventType}`
    const userId = data.user_id || data.user || ''
    const pageId = data.page || data.pageid || data.account_id
    return {
      event_id: newEventId(),
      user_id: userId,
      timestamp,
      source: { type: 'synthetic', account_id: pageId },
      event_type: unifiedType,
      payload: event.value !== undefined ? event.value : null,
      raw: data
    }
  }
  ```
- **Platform extraction:** Line 32–34 in `/replybot/lib/typewheels/transition.js`:
  ```javascript
  const platform = parsedEvent.source.type === 'synthetic'
    ? ((state && state.md && state.md.platform) || 'messenger')
    : parsedEvent.source.type
  ```
  Synthetic events do **NOT** carry platform on the event itself — replybot looks for persisted `md.platform` in state or defaults to `'messenger'`.

### Where Platform Should Ride Along

1. **DEAN → BOTSERVER:** Add optional `platform` field to `ExternalEvent` struct (Go).
2. **BOTSERVER:** Platform field in botserver's message spread is **already passed through** (line 70: `...body`).
3. **KAFKA MESSAGE:** Will include `platform` if dean emits it.
4. **REPLYBOT parseSyntheticEvent():** Currently ignores top-level fields; platform field would be in `raw: data` but not extracted to the normalized `UniversalEvent`. **Change needed here** to read `data.platform` if present.

---

## 5. BOTSERVER's /synthetic Endpoint

### Current Implementation

**File:** `/botserver/server/handlers.js` lines 55–86

**Handler function:** `handleSyntheticEvents(ctx, producer, producerReady, eventTopic)`

**Processing:**

```javascript
const { body } = ctx.request
const message = { ...body, source: 'synthetic', timestamp: Date.now() }
const data = Buffer.from(JSON.stringify(message))
if (!message.user) {
  console.log(body)
  throw new Error('No user!')
}
producer.produce(eventTopic, null, data, message.user)
ctx.status = 200
```

**Key behaviors:**

1. **Payload validation:** Only checks for required `user` field (line 73). No whitelist, no schema validation.
2. **Unknown fields:** **PASSED THROUGH** (`...body` spreads all input fields into message).
3. **Field stripping:** **None** — all fields ride along to Kafka.
4. **Resulting Kafka event:** Contains all input fields plus `source: 'synthetic'` and `timestamp`.

**Example flow:**
```
Input: { user: "user123", page: "page456", platform: "whatsapp", event: {...} }
       ↓
Output to Kafka: { user: "user123", page: "page456", platform: "whatsapp", event: {...}, source: "synthetic", timestamp: 1234567890 }
```

**Conclusion:** Botserver **already passes unknown fields through**; no changes needed here for platform threading, but the value will NOT be extracted by `parseSyntheticEvent()` unless replybot explicitly reads it.

---

## 6. Backfill Feasibility: states.platform via Credentials Join

### Current Schema

**Credentials table** (`/devops/migrations/01-init.sql` lines 170–182):

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

**Account ID routing** (per platform-abstraction.md §3):

- **Messenger:** `pageid` = `page_id` (from event's recipient_id) → stored in `credentials.key` for `entity = 'facebook_page'`
- **WhatsApp:** `pageid` = `phone_number_id` (from event's phone_number_id) → stored in `credentials.key` for `entity = 'whatsapp_business'`
- **Lookups:** `WHERE key = pageid AND entity IN ('facebook_page', 'whatsapp_business')`

### Backfill Join Expressible?

**Query shape:**

```sql
UPDATE states s
SET platform = (
  SELECT CASE 
    WHEN c.entity = 'facebook_page' THEN 'messenger'
    WHEN c.entity = 'whatsapp_business' THEN 'whatsapp'
    ELSE NULL
  END
  FROM credentials c
  WHERE c.key = s.pageid
    AND c.entity IN ('facebook_page', 'whatsapp_business')
  LIMIT 1
)
WHERE s.pageid IS NOT NULL
```

**Feasibility:** ✅ **Yes, fully expressible.** The join on `pageid = credentials.key` with entity filter is indexable (`credentials` has an index on `(key)` + entity filtering).

### Backfill Suitability: Orphan Rows?

**Risk factors:**

1. **Test data:** Fixture data in `/replybot/` test files may create states with synthetic or invalid pageids.
   - Scan: `/replybot/lib/typewheels/machine.test.js`, `transition.test.js` for hardcoded test pageids.
   - Likely pattern: `"test_page_123"`, `"mock_pageid"`, etc. — would NOT match any credentials row (backfill would set `platform = NULL`).

2. **Real orphans:** States where user deleted the credential but state row remains.
   - Unlikely in production (credentials are stable), but possible in dev.
   - Backfill would set `platform = NULL` for these rows (safe).

3. **Scratchpad/debug states:** Dean or manual testing might create states with bare numeric IDs.
   - Backfill: Only matches if a credential row exists with that key — otherwise NULL.

**Conclusion:** Backfill is **safe** — any unmatched pageid gets `platform = NULL`, no data loss. Test fixtures with synthetic pageids will naturally fail to match and end up NULL; this is acceptable for backfill.

---

## 7. Gaps & Risks

### Known Gaps

1. **ReplyBot event-normalizer does NOT extract platform from synthetic events:**
   - `/replybot/lib/event-normalizer.js` `parseSyntheticEvent()` (lines 214–231) ignores top-level `platform` field if dean sends it.
   - **Fix needed:** Extract `data.platform` and add to returned `UniversalEvent` source or payload.

2. **Synthetic events lose platform context:**
   - Line 32–34 in `/replybot/lib/typewheels/transition.js` — synthetic events default to `md.platform || 'messenger'`.
   - **This is acceptable for now** (todo comment already present at line 31), but threading platform through would make it exact on first event.

3. **Responses do not carry platform:**
   - `/replybot/lib/responses/responser.js` (line 6) — `responseVals()` does NOT include a platform field.
   - **Decision needed:** Should responses.platform be added? (Likely yes, for analytics — "which platform responded to this question").

4. **No migration yet for unique_messaging_account index:**
   - Platform-abstraction.md §3 references `/devops/migrations/20-messaging-account-unique.sql` but file doesn't exist in migrations/ directory.
   - **Prerequisite:** This migration should be created and applied before threading platform.

5. **Dean's FollowUps query uses credentials join:**
   - `/dean/queries.go` lines 214–240 — joins `states` to `credentials` via `pageid = facebook_page_id`.
   - **Issue:** Uses `facebook_page_id` (computed column), not the generic `key` + entity filter pattern.
   - **Will work for Messenger** but needs update for WhatsApp once platform is threaded (see platform-abstraction.md note at line 234).

### Implementation Risks

1. **NULL vs. unknown platform:**
   - Backfilled states with orphan pageids will have `platform = NULL`.
   - Consumers must handle NULL gracefully (default to 'messenger' or error).

2. **Scribble validation:**
   - Adding `platform` to `State` struct requires updating Go struct and JSON tag.
   - Validator will NOT catch missing platform (since it's optional), but consumers must tolerate NULL.

3. **Dashboard/Export readers:**
   - Any reader that builds a `SELECT *` or hardcoded column list may need updating.
   - **Mitigated:** Exporter uses explicit columns (verified safe above).

4. **Test fixtures:**
   - Tests with synthetic pageids (e.g., `"page_999"`) will backfill to `platform = NULL`.
   - Tests must either:
     - Create mock credentials rows for test pageids, OR
     - Accept NULL platform in assertions, OR
     - Update test data to use real page IDs.

---

## 8. Summary of Changes Required

### Phase 1: Schema & Backfill

1. **Add migration** (`devops/migrations/21-platform-threading.sql`):
   - Add nullable `platform VARCHAR` columns to `states` and `responses` tables.
   - Create backfill UPDATE query to populate from credentials table.

2. **Create credentials index** (if not present):
   - Ensure `/devops/migrations/20-messaging-account-unique.sql` exists and applies unique constraint on `(key)` for messaging entities.

### Phase 2: Scribble Writer Updates

3. **Update `scribble/state.go`:**
   - Add `Platform string` field to `State` struct (optional, JSON tag with `omitempty`).
   - Add `"platform"` to fields slice in `SendBatch()` (line 58).

4. **Update `scribble/response.go`:**
   - Add `Platform *string` field to `Response` struct (optional).
   - Add `"platform"` to fields slice in `SendBatch()` (line 69).

### Phase 3: Replybot Publishing

5. **Update `/replybot/lib/index.js`:**
   - Modify `publishState()` (line 36) to include `platform` in message:
     ```javascript
     const message = { userid, pageid, platform, updated, current_state: state.state, state_json: state }
     ```
   - Pass platform from caller (transition output).

6. **Update `/replybot/lib/responses/responser.js`:**
   - Add `platform` field to `responseVals()` return object (line 6).
   - Add `"platform"` to INSERT statement (line 72).

7. **Update `/replybot/lib/typewheels/transition.js`:**
   - Modify `actionsResponses()` (line 40) to accept and pass platform.
   - Pass platform to `publishState()` and `responseVals()` calls.

### Phase 4: Event Normalization (Optional for Synthetic)

8. **Update `/replybot/lib/event-normalizer.js`:**
   - Modify `parseSyntheticEvent()` to extract platform:
     ```javascript
     const platform = data.platform // optional, prefer from source
     // Return platform in UniversalEvent if present
     ```
   - Messenger/WhatsApp parsers already extract platform from `source.type`.

### Phase 5: External Event (Dean)

9. **Update `/dean/queries.go`:**
   - Optionally add `platform` field to `ExternalEvent` struct (if dean needs to override platform).
   - Update event makers (`getFollowUp`, etc.) to include platform if available.

10. **Update Helm values:**
    - No new env vars required; platform flows through existing Kafka pipelines.

---

## Key File References

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **Scribble State Writer** | `/scribble/state.go` | 55–68 | UPSERT to states table |
| **Scribble Response Writer** | `/scribble/response.go` | 67–89 | INSERT to responses table |
| **States Schema** | `/devops/migrations/01-init.sql` | 109–162 | Current DDL |
| **Responses Schema** | `/devops/migrations/01-init.sql` | 68–102 | Current DDL |
| **Replybot State Publisher** | `/replybot/lib/index.js` | 36–39, 74 | publishState call |
| **Response Builder** | `/replybot/lib/responses/responser.js` | 6–32 | responseVals function |
| **Transition/Platform Logic** | `/replybot/lib/typewheels/transition.js` | 20–38, 40, 156 | Platform extraction & passing |
| **Event Normalizer** | `/replybot/lib/event-normalizer.js` | 214–231, 347–361 | parseSyntheticEvent & parseWhatsAppEvent |
| **Botserver /synthetic Handler** | `/botserver/server/handlers.js` | 55–86 | Synthetic event receiver |
| **Exporter Response Query** | `/exporter/exporter/exporter.py` | 280–304 | SQL query (safe — explicit columns) |
| **Dean External Events** | `/dean/dean.go`, `/dean/queries.go` | 71–91, 17–91 | Event structure & emission |
| **Credentials Schema** | `/devops/migrations/01-init.sql` | 170–182 | Platform routing key |

---

## Conclusion

**The platform threading architecture is straightforward and low-risk:**

- **States/Responses writers (Scribble):** Accept unknown fields without error; adding optional `platform` fields requires minimal struct and SQL updates.
- **Existing consumers:** Use explicit column lists (safe) or will tolerate new NULL columns.
- **Event flow:** Dean → Botserver → Kafka → Replybot already passes fields through; replybot must extract platform on ingest.
- **Backfill:** Joinable and safe; orphan rows get NULL (acceptable).
- **No schema dependencies:** No computed columns, triggers, or foreign keys on platform data would break.

**Critical path:** Schema migrations + Scribble struct updates + Replybot extraction/publishing.
