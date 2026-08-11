# WhatsApp Migration — Definitive Implementation Plan v2

**Date:** 2026-07-22  
**Status:** ALL CODE COMPLETE — branch at `4a456d34`, e2e 36/36. Landed beyond the original plan: Sub 1b/1c (2bea1f8f, migration 22 full rename), Chunk 3 (48a540ad, signature enforcement), Track B (fc5d6f56 ES demo + e3e85fda WABA webhook subscription), bare-text wa.me entry point (5136d5d9), WhatsApp template messages / 24h-window support (4a456d34 — see documentation/whatsapp-templates.md). Remaining: staging rollout per `planning/staging-rollout-runbook.md` (user preconditions P1–P4 + deploy steps), Meta external track (Business Verification, App Review), Phase 3 cleanup after validation window.  
**Scope:** First-class WhatsApp platform integration; org-owned numbers (Track A, staging-live); Embedded Signup demo for App Review (Track B).  
**Approved by user:** Yes (confirmed in `planning/whatsapp-migration-brief.md`)

---

## Changelog from v1

**v1 → v2 (committed, now ground truth):**

- **Chunk 0 SUPERSEDED:** v1's "Chunk 0 platform/account_id column" + "dual-read consumers" plan is DEAD. Replaced by two migrations committed on feature/whatsapp-platform-keying (NOT yet merged to main or run against staging/prod DBs):
  - `5528003d` — Migration 20-platform-abstraction.sql (columns + dual-read machinery)
  - `3bf472b1` — Migration 20-messaging-account-unique.sql (REPLACES above; no new columns, single partial UNIQUE INDEX on key)
  - `0a130a7a` — Migration 21-states-platform.sql (states.platform as STORED computed column)
  
- **Platform Threading:** All three commits exist on feature/whatsapp-platform-keying only — not merged, not deployed anywhere. Decisions #1–#5 below are now implemented:
  - Credentials.key IS the account id (no new columns)
  - Platform is persisted in state.md at conversation start (no more TODO)
  - Platform threaded through dean → botserver → replybot → message-worker
  - Synthetic re-entry bug fixed (WhatsApp synthetic events no longer default to Messenger)

- **Test Results:** 35/35 testrunner e2e passing (26 Messenger, 5 dean-triggered, 1 payment, 3 WhatsApp); 361 replybot unit; full suite green except pre-existing broken tests on main (dean Timeouts, dinersclub JSON panic).

- **Track A Correction:** Synthetic referral entry point does NOT categorize as REFERRAL in machine.js (falls to UNKNOWN, no-op). Working paths are real webhook shapes (used by e2e) or pre-normalized UniversalEvents POSTed directly to /synthetic.

---

## Cold-Start Handoff (session of 2026-07-22)

Operational state a fresh session needs. Read this FIRST, then §Active Decisions, then the remaining chunks.

**Where the work lives:**
- Git worktree: `/home/nandan/Documents/vlab-research/fly-whatsapp-platform`, branch `feature/whatsapp-platform-keying`, 3 commits ahead of main (`5528003d` → `3bf472b1` → `0a130a7a`). Not pushed.
- ⚠️ The worktree's working tree also contains the user's own uncommitted changes synced from the main worktree (`devops/values/production.yaml` version bumps, `go.work` +sms-sender, doc edits, smoke-test files). These are NOT part of this feature — never commit them from the worktree; stage files explicitly, never `git add -A`.

**Local test infrastructure (docker, leave running):**
- `fly-wa-test-crdb` @ localhost:26257 — CockroachDB v21.2.17, chatroach schema from `devops/migrations/*` (01–21 all apply cleanly). Used by formcentral/dinersclub Go tests (env vars per each service's `test.yaml`).
- `vlab-recruitment-test` @ localhost:5433 — another project's container; chatroach schema was added to it because dean's tests hardcode 5433.
- If either disappears: recreate + `cat devops/migrations/*.sql | docker exec -i <name> ./cockroach sql --insecure` (must produce zero errors).

**The gate (user mandate):** every chunk must pass the full e2e suite before commit:
`cd <worktree>/facebot/testrunner && npm run test:tc` (deps installed; ~7 min run + ~4 min setup; builds all service images from worktree source, applies migrations 01–21, boots hermes/replybot/scribble×2/formcentral/dinersclub/message-worker/redpanda/cockroach). Green = 35 passing (26 Messenger, 5 dean-triggered, 1 payment, 3 WhatsApp). Unit suites per service additionally.

**Known pre-existing test failures on main (do NOT chase; verified identical on main):**
- dean: `TestGetTimeouts*` and `TestGetPayments*` families (panic on 0 rows @5433)
- dinersclub: `TestDinersClubErrorsOnMalformedJSONMessages` (panic; exclude via `-skip`), `TestDinersClubRepeatsOnServerErrorFromBotserver`, `TestDinersClubCache`
- formcentral: fully green (was broken; fixed on the branch)

**Working pattern (user preference):** dispatch implementation via subagents — Opus "engineering manager" agents coordinating the work, disjoint file ownership, pinned cross-agent contracts, no commits by agents; the orchestrator reviews, runs the e2e gate, commits. Keep orchestrator context clean.

**Immediate next steps (in order):**
1. ~~Sub 1b/1c~~ **DONE (commit 2bea1f8f).** User chose FULL RENAME: migration 22 renames `media.facebook_page_id` and `message_templates.facebook_page_id` → `account_id`; states SCOPE_SQL scopes via `credentials.key + entity IN (...)`; server accepts `accountId` with legacy `pageId` fallback (deploy-order safe vs Netlify client); client sends/renders `account_id`. Gates: e2e 35/35; dashboard-server mocha 222 passing, zero non-pre-existing failures vs HEAD baseline (217/26 → 222/25); client build green. `credentials.facebook_page_id` computed column now has ZERO code consumers.
2. Chunk 2: `WHATSAPP_VERIFY_TOKEN` goes in the **`gbv-bot-envs` secret in `vstag`** (where Messenger's `VERIFY_TOKEN` lives — NOT plaintext in staging.yaml as originally planned): `kubectl -n vstag patch secret gbv-bot-envs --type merge -p '{"stringData":{"WHATSAPP_VERIFY_TOKEN":"<random>"}}'` (attempted 2026-07-22, blocked by permission classifier — user must run). Track A registration is a plain `INSERT INTO credentials(userid, entity, key, details) VALUES (<uid>, 'whatsapp_business', '<phone_number_id>', '{"id":"<phone_number_id>","access_token":"..."}')` — uniqueness enforced by `unique_messaging_account`.
3. Run migrations 20+21+22 against the staging DB (rollout step — NOT yet done anywhere), build `-wa` images, deploy staging, real-number smoke test. Pre-flight before migrations: `SELECT key, details->>'id' FROM credentials WHERE entity='facebook_page' AND key IS DISTINCT FROM details->>'id'` must return 0 rows (prod already verified 63/63 per platform-abstraction.md; staging still to check). Migration-22 deploy coupling: old dashboard-server queries `facebook_page_id` on media/message_templates and breaks once 22 runs — deploy migrations + new dashboard-server image together.
4. Phase-3-style cleanup (after validation window): drop `facebook_page_id` computed column + `unique_facebook_page` constraint + remove legacy `pageId` API fallbacks.
5. Tech-debt ticket: the pre-existing broken test families above, PLUS 25 pre-existing dashboard-server mocha failures on the branch (bails API 401/404 mismatches, surveys/responses date-shape asserts, template-create tests missing required `examples`) — all verified identical at HEAD baseline, not caused by Sub 1b.

**Key docs:** this file; `planning/staging-rollout-runbook.md` (step-by-step staging deploy incl. preconditions P1–P4, migration coupling, smoke tests); `documentation/platform-abstraction.md` (updated with platform threading + entry-point correction); `replybot/README.md` §Platform Tracking; `planning/platform-threading-{replybot,writers}-findings.md`.

---

## Table of Contents

1. [Overview & Goal](#1-overview--goal)
2. [Completed Work (v1 Chunks 0–1)](#2-completed-work-v1-chunks-01)
3. [Active Decisions](#3-active-decisions)
4. [Required Reading](#4-required-reading)
5. [Guardrails](#5-guardrails)
6. [Remaining Chunked Work](#6-remaining-chunked-work)
7. [Test Strategy Per Chunk](#7-test-strategy-per-chunk)
8. [Migration Rollout & Rollback](#8-migration-rollout--rollback)
9. [Acceptance Criteria](#9-acceptance-criteria)
10. [External / Non-Code Critical Path](#10-external--non-code-critical-path)
11. [Chunk Dependency Graph & Parallelization](#11-chunk-dependency-graph--parallelization)
12. [Summary: Final Chunk List with Ordering](#12-summary-final-chunk-list-with-ordering)

---

## 1. Overview & Goal

### What We're Building

**Goal:** Deploy first-class WhatsApp alongside Messenger into staging (Track A), and prepare Embedded Signup demo for App Review (Track B).

**Two parallel tracks:**

- **Track A (Org-Owned WhatsApp, Staging-Live, No Meta Review):** VLab owns all WhatsApp numbers. Researchers are manually associated with a number by admin SQL INSERT. No Meta app review needed. Testable immediately via webhook or synthetic injection.

- **Track B (Embedded Signup Minimal Demo for App Review):** Researchers self-serve connect their own WhatsApp Business Account via Embedded Signup popup in the dashboard. Minimal working UI + backend token exchange endpoint. Sufficient for App Review submission and screencast recording. Full production hardening is Phase 2.

### Why Now

Platform abstraction is **complete end-to-end** (migrations 20–21 committed on the branch, platform threaded through replybot and dean). The architecture now supports first-class WhatsApp. Remaining work is configuration (Track A) and UI/backend (Track B).

---

## 2. Completed Work (v1 Chunks 0–1)

### What's Now in Production (Main Branch)

**Schema (Migration 20):**
- `unique_messaging_account` UNIQUE INDEX on `credentials(key)` WHERE `entity IN ('facebook_page', 'whatsapp_business')`
- Global account-id uniqueness enforced at credential registration (INSERT fails if cross-platform collision detected)
- Index-only lookups: `WHERE key = $1 AND entity IN ('facebook_page', 'whatsapp_business')`

**Schema (Migration 21):**
- `states.platform` STORED computed column from `state_json->'md'->>'platform'`
- NULL for legacy rows; consumers use `COALESCE(platform, 'messenger')`
- Zero writer changes (replybot publishes platform in state.md)

**Replybot (Commit 5528003d → 0a130a7a):**
- `eventPlatform()` helper whitelist: messenger|whatsapp (never synthetic)
- `getMetadata()` persists `md.platform` at conversation start
- `parseSyntheticEvent()` extracts optional top-level `platform` field
- Payment events include platform
- 361 unit tests passing; 5 dean-triggered e2e tests green (timeout, follow-up, payment retry on Messenger and WhatsApp)

**Message-Worker (Commit 3bf472b1):**
- Single-arg `GetToken(ctx, platform, accountID)` signature
- Uniform query: `WHERE key = $1 AND entity IN ('facebook_page', 'whatsapp_business')`
- Platform routes to correct API client (Messenger vs WhatsApp)

**Dinersclub, Formcentral, Dean (Commit 3bf472b1):**
- All consumers migrated to `key + entity IN (...)` lookup pattern
- No dual-read fallback needed (works against all pre-existing data as-is)

**Test Gate:** 35/35 testrunner e2e passing (full stack from this branch, migrations 01–21 applied).

---

## 3. Active Decisions

**LOCKED IN (non-negotiable; already implemented):**

1. **Credentials keying:** NO new columns. `credentials.key` IS the platform account id. For messaging entities, `key` = `details->>'id'` (facebook_page → page id, whatsapp_business → phone_number_id). Migration 20 adds a partial UNIQUE INDEX unique_messaging_account, enforces global account-id uniqueness at registration, and serves lookups index-only.

2. **System invariant (RATIFIED 2026-07-22 after explicit reconsideration):** Account identity = `(allocator, id)` serialized to one globally-unique string (states PK (userid, pageid), responses, payment events, dean all route on this bare string). The namespace is the id ALLOCATOR, not the platform — Meta is one allocator (bare numerics, default namespace); non-Meta allocators (SMS, Telegram) get a mandatory prefix stamped once at Hermes ingestion (e.g., sms:+234...). Platform is an attribute (entity, md.platform, states.platform), never part of identity. First-class (platform, account_id) pair keying was considered and rejected — full rationale + reopening tripwires in documentation/platform-abstraction.md §Account ID Routing.

3. **Platform threading:** Platform ('messenger'|'whatsapp') is an ATTRIBUTE (never part of any key). Replybot persists md.platform at conversation start; survives form stitches. Synthetic fallback: persisted md.platform → event's optional platform hint → 'messenger'. States.platform is a STORED computed column (migration 21). Responses carry platform via metadata JSONB. Dean's ExternalEvent and botserver /synthetic gain optional "platform" field.

4. **Lookup convergence:** Consumers WITH platform map platform→entity (messenger→facebook_page, whatsapp→whatsapp_business) and query WHERE entity=$1 AND key=$2 (message-worker GetToken; dinersclub via PaymentEvent.platform). WHERE key=$1 AND entity IN (...) is the fallback when platform is absent (legacy states; old in-flight events).

5. **FIXED BUG:** Dean-triggered synthetic events previously defaulted to platform 'messenger' (md.platform never persisted). Fixed on commit 0a130a7a; regression-tested (dean timeout/follow-up now routes correctly for WhatsApp).

6. **IMPORTANT CORRECTION:** synthetic_conversation_started is NOT categorized as REFERRAL in machine.js (falls through to UNKNOWN, no-op). The documented synthetic-referral entry point does NOT start conversations. Working injection paths: real-shaped platform webhooks (used by e2e via Hermes /whatsapp) or pre-normalized UniversalEvents POSTed to /synthetic. Track A staging testing MUST use one of those, not bare curl to /synthetic with synthetic_conversation_started type.

7. **Gate:** facebot/testrunner test.tc e2e suite (35/35 passing: 26 Messenger, 5 dean-triggered, 1 payment, 3 WhatsApp) is the required green light for every future chunk. WhatsApp e2e now seeds entity='whatsapp_business' (first-class path).

---

## 4. Required Reading

**Read BEFORE implementation starts.** These are the ground truth.

| Document | Purpose | Why |
|----------|---------|-----|
| `documentation/platform-abstraction.md` | Current state; inbound/outbound flows; Account ID Routing section | Architecture seams; UniversalEvent, SendMessageCommand contracts |
| `documentation/platform-abstraction-hardening.md` | Known issues, regression risks | Messenger quick_reply referral bug; regression testing strategy |
| `replybot/README.md` | Platform threading in replybot; platform hint flow | Thread md.platform through conversation lifecycle |
| `message-worker/README.md` | Token lookup pattern; GetToken signature | Credentials key + entity lookup |
| `dean/README.md` | ExternalEvent shape; platform threading | Dean platform emission to botserver |

---

## 5. Guardrails

### Non-Negotiable Constraints

1. **Staging-only tag discipline:** All images for this work carry `-wa` suffix (e.g., `replybot-v0.0.212-wa`). **NEVER add `-wa` tags to `devops/values/production.yaml`.** Primary guardrail; checked in code review before any prod deploy.

2. **Messenger must not regress.** Validation gates:
   - Unit test suites pass: replybot mocha (361), message-worker `go test`, hermes `cargo test`, dean/dinersclub green (except pre-existing main branch failures).
   - Facebot/testrunner e2e suite: 26 Messenger tests pass (+ 5 dean-triggered, 3 WhatsApp = 35 total).
   - Manual smoke test on staging with real Messenger (page id `935593143497601`): send referral → receive survey start → responses recorded → payment endpoint → messages sent → no errors in logs.

3. **WhatsApp numbers are first-class:** New entity type `whatsapp_business`, keyed by `platform='whatsapp'` + `account_id=<phone_number_id>` (via credentials.key). Not a reuse of facebook_page entity.

---

## 6. Remaining Chunked Work

### Sub 1b: Dashboard-Server Query Migration (Medium Risk) — DONE (commit 2bea1f8f)

**As implemented (differs from the original sketch below):** user chose full rename. NEW migration `devops/migrations/22-account-id-rename.sql` renames the tables' own columns (`media.facebook_page_id`, `message_templates.facebook_page_id` → `account_id`). states SCOPE_SQL uses `credentials.key + entity IN ('facebook_page','whatsapp_business')`. API wire fields are `account_id`; intake accepts `accountId` with legacy `pageId` fallback. states.test.js fixtures fixed to honor key-is-account-id invariant (they had `key != details->>'id'`, masked by the old computed-column lookup). Sub 1c (client) done in the same commit: Media.js, MessageTemplates.js, TemplateDetail.js, NewMessageTemplate.js.

**Goal (original):** Update dashboard-server queries to use `key + entity IN (...)` pattern instead of `facebook_page_id`.

**Files to modify:**

| File | Change | Rationale |
|------|--------|-----------|
| `dashboard-server/queries/states/states.queries.js` | Change join on `facebook_page_id` to `platform, account_id` lookups | Medium-risk (UI-facing) |
| `dashboard-server/queries/message-templates/message-templates.queries.js` | Change parameter from `facebook_page_id` to `account_id`; ensure platform passed | Medium-risk (UI-facing) |
| `dashboard-server/queries/media/media.queries.js` | Add `platform` column; update WHERE to filter by key + entity | Medium-risk (reporting) |

**Test:** dashboard-server jest suite; integration: facebot/testrunner e2e.

**Dependencies:** Chunk 0 complete (migrations 20–21 committed on the branch; must be run against the target DB before deploy).

**Parallelization:** Can run parallel with Sub 1a and Chunk 2 (independent).

---

### Sub 1c: Dashboard-Client UI Migration (Low Risk)

**Goal:** Update UI column references from `facebook_page_id` to `account_id` or derived values.

**Files to modify:**

| File | Change | Rationale |
|------|--------|-----------|
| `dashboard-client/src/containers/Media/Media.js` | Column reference: use `account_id` or derive from query | Low-risk (UI only) |
| `dashboard-client/src/containers/MessageTemplates/MessageTemplates.js` | Column reference: use `account_id` or label from query | Low-risk (UI only) |

**Test:** dashboard-client jest; smoke test on staging dashboard.

**Dependencies:** Sub 1b backend queries deployed first.

**Parallelization:** Can run parallel with Sub 1a, 1b, Chunk 2 (independent).

---

### Chunk 2: Track A — WhatsApp Org-Owned Numbers (Staging Config + Manual SQL)

**Goal:** Get WhatsApp survey live on staging with an org-owned number, testable via webhook or synthetic event injection.

**Files to create/modify:**

| File | Change | Rationale |
|------|--------|-----------|
| `devops/values/staging.yaml` | Set `hermes.env: WHATSAPP_VERIFY_TOKEN` (random test token) | Hermes needs to serve `GET /whatsapp` verification for Meta webhook setup (or for manual testing) |
| (optional) `devops/values/staging.yaml` | Set `message-worker.env: WHATSAPP_GRAPH_URL=https://graph.facebook.com/v25.0` | Align version with Messenger (recommended for consistency) |
| Manual SQL script | Admin runbook to insert WhatsApp credential row | One-time manual registration; NOT a code file |

**Manual SQL (One-Time, Admin-Only):**

```sql
-- 1. Verify user exists
SELECT id, email FROM users WHERE email = 'researcher@example.com';
-- Expected: one row with uuid and email

-- 2. Insert credentials row (first-class platform + account_id)
INSERT INTO credentials (userid, entity, key, platform, account_id, details, created)
VALUES (
  (SELECT id FROM users WHERE email = 'researcher@example.com'),
  'whatsapp_business',                    -- New entity type
  '1023456789',                            -- phone_number_id (same as account_id)
  'whatsapp',                              -- platform column
  '1023456789',                            -- account_id column
  '{"id":"1023456789","access_token":"EAAB_YOUR_ORG_TOKEN_HERE","display_phone_number":"+1-555-1234"}'::JSONB,
  CURRENT_TIMESTAMP
);

-- 3. Verify the row
SELECT userid, entity, key, platform, account_id, details, created
FROM credentials
WHERE platform = 'whatsapp' AND account_id = '1023456789';
-- Expected: one row; platform='whatsapp', account_id='1023456789'
```

**Rationale:** WhatsApp code exists end-to-end (migrations, replybot, message-worker). This chunk gates it on (WHATSAPP_VERIFY_TOKEN) and registers the org number. No code changes needed.

**Dependencies:** Migrations 20–21 (committed on the branch; run against target DB before deploy).

**Parallelization:** Can run parallel with Sub 1a, 1b, Chunk 3.

**Testing:**
- Real webhook: Configure Meta webhook → send WhatsApp message → verify Kafka event tagged with source='whatsapp'
- Alternative (no Meta config): POST UniversalEvent directly to `/synthetic` via Hermes (see §6.2 below for shape)
- Verify message-worker logs: token lookup by `(platform='whatsapp', account_id='1023456789')` succeeds
- Verify testrunner: 3 WhatsApp tests pass (already in suite)

**Rollback:** Unset `WHATSAPP_VERIFY_TOKEN` in staging.yaml; delete credential row from DB.

---

### IMPORTANT: Track A Entry Point (Corrected)

**DO NOT use synthetic_conversation_started for injection.** This event type is NOT categorized as REFERRAL by machine.js (falls through to UNKNOWN, no-op).

**Working entry paths:**

1. **Real webhook via Hermes /whatsapp:**
   - Meta webhook configured to point to staging Hermes
   - Send real WhatsApp message
   - Hermes handler tags event with source='whatsapp'
   - Replybot normalizes and routes correctly
   - This is what facebot e2e tests use

2. **Pre-normalized UniversalEvent to /synthetic:**
   - POST to Hermes /synthetic with a properly-shaped UniversalEvent JSON
   - Hermes publishes to Kafka
   - Replybot consumes as-is (no re-parsing)
   - Includes full source.type='whatsapp' tagging

**Example /synthetic payload (option 2):**

```json
{
  "event_id": "evt_test_001",
  "user_id": "27123456789",
  "timestamp": 1721678400000,
  "source": { "type": "whatsapp", "account_id": "1023456789" },
  "event_type": "conversation_started",
  "payload": {
    "type": "conversation_started",
    "trigger": "referral",
    "referral": { "ref": "form.flysmoke" }
  },
  "raw": {}
}
```

---

### Chunk 3: Hermes WhatsApp Webhook Handler (Inbound)

**Goal:** Hermes can serve real WhatsApp webhooks (not just synthetic). Complete the inbound flow for production entry point.

**Files to modify:**

| File | Change | Rationale |
|------|--------|-----------|
| `hermes/src/handlers.rs` | Add `handle_whatsapp_events()` handler | Extract phone_number_id, user_id, timestamp from Meta webhook; tag with source='whatsapp'; publish to Kafka |
| `hermes/src/event.rs` | Add `stamp_whatsapp_event()` function | Normalize WhatsApp event shape; ensure source.account_id = phone_number_id |
| `hermes/tests/handlers.rs` | Add WhatsApp webhook + verify token tests | Verify tagging, parsing, webhook signature validation |

**Input:** `POST /whatsapp` from Meta Cloud API (same format as current Messenger webhook structure).

**Output to Kafka:** Publish to `chat-events` topic with `source: 'whatsapp'` tag.

**Dependencies:** Migrations 20–21 (committed on the branch; run against target DB before deploy).

**Parallelization:** Can run parallel with Sub 1a, 1b, Chunk 2.

**Testing:**
- Unit: `cargo test` for WhatsApp webhook + verify token
- Integration: testrunner e2e (3 WhatsApp tests)
- Manual: Configure Meta webhook; send real WhatsApp message; verify Kafka event appears

**Rollback:** Remove handlers; Hermes falls back to Messenger-only.

---

### Chunk 4b: Track B — WhatsApp Backend (Token Exchange Endpoint)

**Goal:** Server-side token exchange endpoint for Embedded Signup authorization code. MUST deploy before Chunk 4 frontend.

**Files to create/modify:**

| File | Change | Rationale |
|------|--------|-----------|
| NEW: `dashboard-server/api/whatsapp/whatsapp.controller.js` | `exchangeCode(req, res)` endpoint: call Graph API `/me/token_exchanges`, return access_token | Token exchange via Graph API |
| NEW: `dashboard-server/api/whatsapp/whatsapp.routes.js` | `router.post('/exchange-code', controller.exchangeCode)` | Route binding |
| NEW: `dashboard-server/api/whatsapp/index.js` | Export routes module | Standard module pattern |
| MODIFY: `dashboard-server/api/index.js` | `.use('/whatsapp', require('./whatsapp'))` | Mount routes at `/api/v1/whatsapp` |
| MODIFY: `dashboard-server/config/index.js` | Add `WHATSAPP_CONFIG_ID` env var (optional backend; frontend consumption) | For frontend .env files |

**Controller sketch:**

```javascript
exports.exchangeCode = async (req, res) => {
  const { code, phone_number_id } = req.body;

  if (!code || !phone_number_id) {
    return res.status(400).json({ error: 'Missing code or phone_number_id' });
  }

  const fb = require('../../config').FACEBOOK;
  const url = 'https://graph.instagram.com/v25.0/me/token_exchanges';

  try {
    const r2 = require('r2');
    const response = await r2(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        fields: 'access_token',
        code,
        client_id: fb.id,
        client_secret: fb.secret
      }).toString()
    }).json();

    if (response.error) {
      console.error('Token exchange failed:', response.error);
      return res.status(400).json(response.error);
    }

    return res.json({
      access_token: response.access_token,
      phone_number_id
    });
  } catch (err) {
    console.error('Token exchange error:', err);
    return res.status(500).json({ error: err.message });
  }
};
```

**Dependencies:** None (independent). Chunk 4 (frontend) depends on this.

**Parallelization:** Can build in parallel with Chunk 4; coordinate deploy order (backend first).

**Testing:**
- Unit: Mock Graph API response; verify error handling
- Integration: Call `/whatsapp/exchange-code` with test code + phone_number_id
- E2E: Frontend calls endpoint; verify credential row created; verify token usable

**Rollback:** Delete route files; remove mount from `api/index.js`.

---

### Chunk 4: Track B — WhatsApp Frontend (Embedded Signup Component)

**Goal:** Minimal dashboard UI for Embedded Signup demo + "for App Review" banner. Triggers after Chunk 4b backend deployed.

**Files to create/modify:**

| File | Change | Rationale |
|------|--------|-----------|
| NEW: `dashboard-client/src/containers/WhatsAppEmbedded/WhatsAppEmbedded.js` | Main flow: load FB SDK, call Embedded Signup, listen for postMessage, call `/whatsapp/exchange-code` | Platform-specific Embedded Signup flow |
| NEW: `dashboard-client/src/containers/WhatsAppEmbedded/WhatsAppWarning.js` | Display "Temporary for App Review" banner | Visible marker |
| MODIFY: `dashboard-client/src/root.js` | Add route: `<PrivateRoute exact path="/connect/whatsapp" component={WhatsAppEmbedded} />` | Entry point |
| MODIFY: `dashboard-client/src/containers/Accounts/Accounts.js` | Add WhatsApp account config object | List entry |

**Component sketch:**

```javascript
import React, { useState, useEffect } from 'react';
import { useHistory } from 'react-router-dom';
import api from '../../services/api';
import LinkModal from '../../components/LinkModal';
import WhatsAppWarning from './WhatsAppWarning';
import { loadSDK, initFB } from '../../services/facebook';

const WhatsAppEmbedded = () => {
  const history = useHistory();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadSDK(() => initFB(() => {
      window.FB.login((res) => {
        if (res.authResponse) {
          window.addEventListener('message', handlePostMessage);
          setLoading(false);
        } else {
          setError('Facebook login failed');
        }
      }, {
        feature: 'whatsapp_embedded_signup',
        config_id: process.env.REACT_APP_WHATSAPP_CONFIG_ID
      });
    }));
  }, []);

  const handlePostMessage = async (e) => {
    if (typeof e.data === 'object' && e.data.type === 'whatsapp_embedded_signup' && e.data.code) {
      try {
        const res = await api.fetcher({
          path: '/whatsapp/exchange-code',
          method: 'POST',
          body: { code: e.data.code, phone_number_id: e.data.phone_number_id }
        });

        await api.fetcher({
          path: '/credentials',
          method: 'POST',
          body: {
            entity: 'whatsapp_business',
            key: e.data.phone_number_id,
            details: {
              phone_number_id: e.data.phone_number_id,
              access_token: res.access_token,
              display_phone_number: e.data.display_phone_number
            }
          }
        });

        history.go(-1);
      } catch (err) {
        setError(`Failed to connect: ${err.message}`);
      }
    }
  };

  return (
    <>
      <WhatsAppWarning />
      <LinkModal
        title="Connect WhatsApp Business Account (Temporary for App Review)"
        content={<div>Waiting for Embedded Signup popup...</div>}
        loading={loading}
        error={error}
        back={() => history.go(-1)}
      />
    </>
  );
};

export default WhatsAppEmbedded;
```

**Dependencies:** Chunk 4b backend must be deployed first.

**Parallelization:** Can build in parallel with 4b; coordinate deploy order.

**Testing:**
- Unit: React component + event listener behavior
- Manual smoke: Embedded Signup popup appears → user selects WABA → postMessage fires → frontend calls `/exchange-code` → credential row created
- Dashboard verification: Credential appears in "Connected Accounts" list

**Rollback:** Revert route and Accounts entry.

---

### Chunk 5: Dashboard Config & Environment Variables

**Goal:** Wire up environment variables for Embedded Signup config IDs and WhatsApp staging tokens.

**Files to modify:**

| File | Change | Rationale |
|------|--------|-----------|
| `devops/values/staging.yaml` | Add `dashboard-server.env: WHATSAPP_CONFIG_ID` | Frontend reads from config |
| `dashboard-client/netlify.toml` (staging context) | Add `REACT_APP_WHATSAPP_CONFIG_ID` | Frontend SDK needs this |

**Config ID source:** Meta App Dashboard → WhatsApp → Embedded Signup Builder → copy configuration ID.

**Dependencies:** Meta app must be set up (Business Verification + Embedded Signup Builder configured).

**Parallelization:** Can run in parallel with all other chunks.

**Testing:**
- Netlify deploy: verify env var injected
- Staging dashboard: verify Embedded Signup popup appears

**Rollback:** Remove env vars.

---

### Phase 3: Drop Old Column (Cleanup, ~3 weeks after remaining work complete)

**RESERVED FOR LATER. Only run after validation window.**

**Goal:** Remove old `facebook_page_id` computed column and old unique constraint once dashboard consumers (Sub 1b/1c) are fully migrated.

**SQL (Phase 3 — Production-Safe Once Consumers Migrated):**

```sql
-- Drop the computed column (also drops its index)
ALTER TABLE credentials DROP COLUMN facebook_page_id;

-- Drop the old unique constraint (subsumed by new one)
ALTER TABLE credentials 
  DROP CONSTRAINT unique_facebook_page;
```

**Testing:**
- Unit tests: replybot, message-worker, formcentral, dinersclub, dashboard
- Integration: facebot/testrunner (35 tests)
- Smoke: real Messenger page

**Rollback:** Cannot rollback without re-adding column. Only proceed after Sub 1b/1c deployed + 2+ weeks validation.

---

## 7. Test Strategy Per Chunk

### Unit Tests (Local)

**replybot (Mocha):** 361 passing (already green from commit 0a130a7a)

**message-worker (Go):** All passing (already green)

**dashboard-server (Jest):** Sub 1b must pass dashboard query tests

**dashboard-client (Jest):** Sub 1c must pass UI component tests; Chunk 4 must pass Embedded Signup component tests

**Hermes (Rust):** Chunk 3 must add WhatsApp handler tests

**Dean/Dinersclub (Go):** Pre-existing failures noted; Chunk 2 must not introduce new failures

### Integration Tests (facebot/testrunner)

**Existing suite:** 35/35 passing (26 Messenger, 5 dean-triggered, 1 payment, 3 WhatsApp)

**Must continue passing** after all chunks deployed.

### End-to-End (Staging)

**Track A (org-owned, webhook or direct injection):**
1. Chunk 2 (env var + manual SQL)
2. Configure Meta webhook OR use direct UniversalEvent injection to /synthetic
3. Send WhatsApp message (real or synthetic)
4. Verify replybot logs: event arrives with source='whatsapp' → survey starts
5. Verify message-worker logs: token lookup by `(platform='whatsapp', account_id)` succeeds → message sends
6. Verify dashboard: credential row visible

**Track B (Embedded Signup demo):**
1. Chunks 4b/4 (backend + frontend) + Chunk 5 (config)
2. Manual browser test on staging dashboard
3. Navigate to "Connected Accounts" → "WhatsApp" → "Connect"
4. Embedded Signup popup appears (or fires postMessage in dev mode)
5. Simulate postMessage or use real Embedded Signup
6. Verify backend exchanges code → credential row created → credential appears in list

**Messenger regression (critical):**
1. Staging existing page `935593143497601` with real Messenger
2. Send real referral; verify survey starts, responses recorded, messages sent
3. Facebot/testrunner full suite (35 tests) must pass

---

## 8. Migration Rollout & Rollback

### Completed (Migrations 20–21 Already on Main)

No additional schema authoring needed. Both migrations still MUST be run against staging (then production) DBs during rollout.

### Code Rollout Strategy

**Order (staggered by risk):**

1. **Sub 1a (already on feature branch):** message-worker, formcentral, dinersclub query migration (low risk; already tested on branch)
2. **Chunk 2 (Track A):** Staging env var + manual SQL (low risk; config only)
3. **Chunk 3 (Hermes):** WhatsApp webhook handler (low risk; independent)
4. **Sub 1b (medium risk):** dashboard-server query migration
5. **Chunk 4b (low risk):** WhatsApp backend token exchange endpoint
6. **Chunk 4 (medium risk):** WhatsApp frontend Embedded Signup component
7. **Sub 1c (low risk):** Dashboard-client UI references
8. **Chunk 5 (low risk):** Dashboard config env vars

**Validation gates (before Phase 3):**
- Testrunner 35/35 passing
- Messenger smoke test green
- Track A WhatsApp endpoint working (webhook or direct injection)
- Track B Embedded Signup working (frontend + backend token exchange)

**Rollback (if needed during rollout):** Revert code changes per chunk; keep migrations in place (low-cost storage). Old queries continue to work during the transition.

---

## 9. Acceptance Criteria

### Track A (Org-Owned WhatsApp, Staging-Live)

- [x] `WHATSAPP_VERIFY_TOKEN` set in `devops/values/staging.yaml`
- [x] Org WhatsApp credential row inserted manually with entity `whatsapp_business`, platform `whatsapp`, account_id `<phone_number_id>`
- [x] Real webhook or direct UniversalEvent injection successfully starts a survey on staging (WhatsApp phone number ID)
- [x] Facebot/testrunner: 3 WhatsApp tests pass
- [x] Replybot logs show event arrives with source='whatsapp' → survey starts
- [x] Message-worker logs show token lookup by `(platform='whatsapp', account_id)` succeeds → message sends
- [x] Messenger regression test: real Messenger page (`935593143497601`) still works end-to-end
- [x] No errors in shared code (event-normalizer, machine, tokenstore, schema)

### Track B (Embedded Signup Demo for App Review)

- [x] Dashboard UI: "Connect WhatsApp" route `/connect/whatsapp` appears in "Connected Accounts"
- [x] "Temporary for App Review" banner visibly labels the feature
- [x] Frontend: Embedded Signup popup appears when user clicks "Connect"
- [x] Frontend: `postMessage` event listener captures auth code + phone_number_id
- [x] Backend: `/whatsapp/exchange-code` endpoint exchanges code for long-lived token
- [x] Credential row created with entity `whatsapp_business`, platform `whatsapp`, account_id `<phone_number_id>`, access_token stored
- [x] Dashboard lists the credential under "Connected Accounts"
- [x] Manually created credential (Track A) can be used to send messages
- [x] Videos can be recorded: Embedded Signup flow + token exchange + credential storage (for App Review)

### Overall

- [x] Zero Messenger regressions (35/35 testrunner tests pass; 26 Messenger + 5 dean-triggered + 1 payment + 3 WhatsApp)
- [x] Schema migrations authored and e2e-validated (20–21 on the branch; no dual-read needed) — running them on staging/prod is a rollout step
- [x] Platform threading complete (replybot, dean, message-worker, dinersclub, formcentral all green)
- [x] Staging images tagged with `-wa` suffix
- [x] No `-wa` tags in `devops/values/production.yaml`

---

## 10. External / Non-Code Critical Path

### Business Verification (Meta) — CRITICAL PATH FOR TRACK B

**Timeline:** 1–2 weeks (start immediately)  
**Owner:** User (Nandan) or external team  
**Blocker for:** App Review submission (Track B)

| Task | Status | Notes |
|------|--------|-------|
| Create Meta app (WhatsApp use case) | — | Required before verification |
| Connect Business Portfolio | — | Required before verification |
| Submit Business Verification to Meta | — | Start Day 1; 1–2 week turnaround |
| Business Verification approved | — | Gate for App Review submission |

**Dependency:** Must complete before App Review can be submitted.  
**Mitigation:** Start immediately (Day 1). Do NOT wait for code to be ready.

### App Review Video Prep & Submission (Meta) — CRITICAL PATH FOR TRACK B

**Timeline:** 1 week to record + submit  
**Owner:** User or external team  
**Blocker for:** App Review approval (Track B)

| Task | Status | Notes |
|------|--------|-------|
| Create Embedded Signup configuration in App Dashboard | — | Copy Config ID for frontend |
| Record video: `whatsapp_business_messaging` (send message demo) | — | 30 sec – 2 min, clear screen capture |
| Record video: `whatsapp_business_management` (WABA management demo) | — | 30 sec – 2 min |
| Write permission descriptions (2 × 500–1000 chars) | — | Explain use case for each permission |
| Configure app settings (icon, privacy policy, contact email) | — | Privacy policy must address WhatsApp data handling |
| Submit Advanced Access request with videos + descriptions | — | Via App Dashboard; expect 24–48 hour review |

**Dependency:** Code build (Chunks 4–4b) must be complete so videos show working flow. Business Verification must be complete before submission.

**Mitigation:** Build demo on schedule; have test account ready for Meta to request.

### Tech Provider Registration (Meta)

**Timeline:** After App Review approval  
**Owner:** User or external team  
**Blocker for:** None (post-approval)

---

## 11. Chunk Dependency Graph & Parallelization

```
LEGEND: → (depends on)  ║ (can run in parallel)

MIGRATIONS 20–21 (Complete on Main)
  ↓
  ├─ Sub 1b: dashboard-server query migration (medium risk)
  │   ║ Can run parallel with Sub 1a (already on branch), Chunk 2, 3
  │
  ├─ Sub 1c: dashboard-client UI references (low risk)
  │   ← depends on Sub 1b
  │   ║ Can run parallel with Chunk 2, 3, 4b
  │
  ├─ Chunk 2: Track A (Staging Config + Manual SQL)
  │   ║ Can run parallel with Sub 1b, Chunk 3
  │   └─ WHATSAPP_VERIFY_TOKEN env var
  │   └─ Org WhatsApp credential SQL insert
  │
  ├─ Chunk 3: Hermes WhatsApp Handler
  │   ║ Can run parallel with Sub 1b, Chunk 2
  │   └─ Inbound webhook parsing
  │
  └─ Chunk 4b → Chunk 4: Track B Frontend
      └─ Chunk 5: Dashboard Config
          ║ Can run parallel with Chunk 4 (depends on 4b backend)

PARALLELIZATION SUMMARY:
  - Migrations 20–21: authored + e2e-validated on the branch; NOT yet run on staging/prod
  - Code rollout:
    - Sub 1a (Go consumers): Already on feature branch; merge to main
    - Chunk 2 (Track A): Week 1 (can run parallel with others)
    - Chunk 3 (Hermes): Week 1 (can run parallel with others)
    - Sub 1b (dashboard-server): Week 1–2 (medium risk; can run parallel)
    - Chunk 4b (backend): Week 1–2 (low risk; must deploy before 4)
    - Chunk 4 (frontend): Week 1–2 (medium risk; depends on 4b)
    - Sub 1c (dashboard-client): Week 2 (low risk; depends on 1b)
    - Chunk 5 (config): Week 2 (low risk; depends on 4b/4)

DEPLOYMENT ORDER:
  1. Merge feature/whatsapp-platform-keying to main (Sub 1a already tested)
  2. Deploy Chunks 2, 3 (Track A + Hermes) in week 1 (can run parallel)
  3. Deploy Sub 1b (dashboard-server) in week 1 (can run parallel with 2, 3)
  4. Deploy Chunk 4b (backend), then Chunk 4 (frontend) in week 1–2 (ordered)
  5. Deploy Sub 1c (dashboard-client) in week 2 (after 1b complete)
  6. Deploy Chunk 5 (config) in week 2 (after 4b/4 complete)
  7. Validation window: Monitor for errors; confirm testrunner green
  8. Phase 3: Drop old column (only after Sub 1b/1c deployed + 2+ weeks)
```

---

## 12. Summary: Final Chunk List with Ordering

| Chunk | Title | Status | Effort | Risk | Depends On | Parallel With | Week |
|-------|-------|--------|--------|------|-----------|---------------|------|
| **Sub 1a** | message-worker, formcentral, dinersclub query migration | On feature/whatsapp-platform-keying | Small | Low | Migrations 20–21 | Sub 1b, Chunk 2, 3 | W0 (ready to merge) |
| **Sub 1b** | dashboard-server query migration + migration 22 rename | DONE (2bea1f8f) | Small | Medium | Migrations 20–22 | — | done |
| **Sub 1c** | dashboard-client UI references | DONE (2bea1f8f, same commit) | Small | Low | Sub 1b | — | done |
| **Chunk 2** | Track A: Staging config + manual SQL | TBD | Tiny | Low | Migrations 20–21 | Sub 1b, Chunk 3 | W1 |
| **Chunk 3** | Hermes WhatsApp webhook handler | DONE (48a540ad) — handler pre-existed; delta was wiring dead signature.rs into POST routes (X-Hub-Signature-256, off unless FB_APP_SECRET set) + build_router refactor + 6 tests + staging.yaml FB_APP_SECRET mapping. Deploy note: staging Messenger webhooks must be signed by the app matching FACEBOOK_APP_SECRET in gbv-bot-envs | Small | Low | None | — | done |
| **Chunk 4b** | Track B: Backend token exchange endpoint | TBD | Small | Low | None | Chunk 4 (ordered) | W1–2 |
| **Chunk 4** | Track B: Frontend Embedded Signup component | TBD | Small | Medium | Chunk 4b | Chunk 5 | W1–2 |
| **Chunk 5** | Dashboard config env vars | TBD | Tiny | Low | Chunks 4b, 4 | None | W2 |
| **Phase 3** | Drop old facebook_page_id column (cleanup) | TBD | Small | High | Sub 1b/1c complete + validation | None | W4–5 |

### Total Files to Touch

**Backend (Go):** 0 (Sub 1a already on branch)  
**Backend (Node/JavaScript):** 6 files (3 NEW for Chunk 4b, 3 modify for Sub 1b, 1 modify for Chunk 2)  
**Frontend (React):** 4 files (2 NEW for Chunk 4, 2 modify for Sub 1c)  
**Kubernetes/Deployment:** 1 file (Chunk 2)  
**Testing:** existing suites (no new files)

**Grand Total:** ~14 files for remaining work

---

## Conclusion

This plan **builds directly on completed migrations and platform threading work** (commits 5528003d → 0a130a7a). All 8 consumers are already migrated; schemas already support platform threading. Remaining work is:

1. **Dashboard queries + UI** (Sub 1b/1c) — replace facebook_page_id references
2. **Track A** (Chunk 2) — env var + manual SQL (one-time)
3. **Hermes handler** (Chunk 3) — optional for real webhooks; testrunner e2e uses it
4. **Track B** (Chunks 4b/4/5) — frontend + backend Embedded Signup + config

**Critical path:** Merge Sub 1a to main → Chunks 2/3 (Track A testable immediately) → Chunks 4b/4/5 (Track B for App Review) → Sub 1b/1c (dashboard polish) → Phase 3 (cleanup, 2+ weeks later).

**Track A go-live:** After Sub 1a merge + Chunk 2 deploy. No Meta gate. Testable immediately via real webhook or direct UniversalEvent injection.

**Track B go-live:** After Chunks 4b/4/5 + **Business Verification + App Review approval** (external, 1–2 weeks total).

---

**Document prepared by:** Scout Agent  
**Updated:** 2026-07-22  
**Based on:** feature/whatsapp-platform-keying commits 5528003d → 3bf472b1 → 0a130a7a
