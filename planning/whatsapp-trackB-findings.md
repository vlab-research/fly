# Scout #3 Findings: WhatsApp Embedded Signup Flow Mapping (Track B)

**Date:** 2026-07-21  
**Goal:** Understand existing Facebook Page connect flow end-to-end to mirror it for WhatsApp Embedded Signup + server-side token exchange, with visible "temporary/for App Review" labels.

---

## 1. EXISTING FACEBOOK CONNECT FLOW (Dashboard-Server Backend)

### Request/Response Shapes & Flow

**Frontend → Backend pipeline (3 steps):**

1. **`POST /api/v1/facebook/exchange-token`** (FacebookPages.js:73)
   - **Request body:** `{ token: "<short-lived FB user token>" }`
   - **Response:** `{ access_token: "<long-lived page access token>" }`
   - **Controller:** `dashboard-server/api/facebook/facebook.controller.js:5-19`
   - **Mechanism:** Calls Facebook Graph API `/oauth/access_token?grant_type=fb_exchange_token` with app_id, app_secret, short-lived token
   - **Error handling:** Returns 400 if FB returns error object (no structured error type)

2. **`POST /api/v1/credentials`** (FacebookPages.js:147-155)
   - **Request body:** 
     ```javascript
     {
       entity: 'facebook_page',
       key: '<page_id>',
       details: {
         name: '<page_name>',
         id: '<page_id>',
         access_token: '<long-lived_access_token>'
       }
     }
     ```
   - **Response:** Full credential row (entity, key, details, created, userid, id)
   - **Controller:** `dashboard-server/api/credentials/credentials.controller.js:6-25`
   - **Query:** `dashboard-server/queries/credentials/credentials.queries.js:52-63` → INSERT into `credentials` table
   - **Database schema:** `credentials(entity, key, details, userid)` with composite unique key on `(entity, key, userid)`
   - **Error handling:** 400 if duplicate (code 23505), 500 for others

3. **`POST /api/v1/facebook/webhooks`** (FacebookPages.js:126-133)
   - **Request body:** `{ pageid: '<page_id>', token: '<access_token>' }`
   - **Response:** Facebook response object (with success/error)
   - **Mechanism:** Subscribe page to webhook fields (messages, postbacks, optins, etc.)
   - **Error handling:** Returns 400 if error, 201 if success

4. **`POST /api/v1/facebook/get-started`** (FacebookPages.js:135-142)
   - **Request body:** `{ token: '<access_token>' }`
   - **Response:** Facebook response object
   - **Mechanism:** Sets get_started button on messenger profile
   - **Error handling:** Returns 400 if error, 201 if success

### Configuration

**Backend environment variables** (`dashboard-server/config/index.js:59-63`):
```
FACEBOOK_APP_ID=<app_id>
FACEBOOK_APP_SECRET=<app_secret>
FACEBOOK_GRAPH_URL=https://graph.facebook.com/v25.0  (or v18.0 for message-worker)
```

**Frontend environment variables** (`dashboard-client/netlify.toml` production/staging contexts):
```
REACT_APP_FACEBOOK_APP_ID=699455733740842         (prod) / 790352681363186 (staging)
REACT_APP_FACEBOOK_GRAPH_VERSION=25.0
```

---

## 2. EXISTING FACEBOOK CONNECT FLOW (Dashboard-Client Frontend)

### UI Entry Point & Navigation

**Route:** `/connect/facebook-messenger` (root.js:37) → `<PrivateRoute>` → `FacebookPages` component
**Location in app:** Accessed from:
- **Accounts.js:10** — main "Connected Accounts" list (top-level account config page)
- **MessageTemplates.js, Media.js** — inline links saying "connect a Facebook page first"

**Frontend framework:**
- **Framework:** React 16.13.1 (via Create React App / react-scripts)
- **Router:** react-router-dom 5.2.0 (Browser History pattern, `useHistory` hooks)
- **State management:** useState (no Redux; local component state)
- **UI library:** Ant Design 4.8.6 for List/Card layout
- **HTTP client:** Custom `api.fetcher()` (src/services/api) that auto-attaches Auth0 Bearer token

### FB SDK Initialization & Login Flow

**File:** `dashboard-client/src/containers/FacebookPages/FacebookPages.js`

**SDK load + init (lines 6-41):**
```javascript
// loadSDK(): Injects script tag for FB SDK JS from https://connect.facebook.net/en_US/sdk.js
// initFB(cb): Calls window.FB.init({ version: `v${REACT_APP_FACEBOOK_GRAPH_VERSION}`, appId: REACT_APP_FACEBOOK_APP_ID, xfbml: true })
```

**Login prompt (lines 53-87):**
```javascript
window.FB.login((res) => { ... }, {
  scope: 'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,business_management,pages_utility_messaging',
  return_scopes: true
});
```
- Requests 6 permissions (pages, messaging, metadata, engagement, business)
- On success: extracts `res.authResponse.accessToken` (short-lived user token)
- Calls `/facebook/exchange-token` to get long-lived page token
- On success: calls `window.FB.api('/me/accounts', ...)` to fetch all pages user can manage

**UI Pattern (lines 90-232):**
- Uses `LinkModal` component (reusable modal dialog for selecting from a list)
- After FB login, displays modal with list of available pages
- User selects one page → calls `callback()` which creates credential row and sets up webhooks

---

## 3. MAPPING EMBEDDED SIGNUP REQUIREMENTS TO EXISTING STACK

### Frontend: Embedded Signup Flow vs. FB Login

**From `planning/whatsapp-tech-provider-app-review.md` Section 5:**

| Aspect | Facebook (Current) | WhatsApp Embedded Signup (New) |
|--------|---|---|
| **SDK entry** | `window.FB.init()` + `window.FB.login()` | `window.FB.login()` + message event listener |
| **Config ID** | None; permissions hardcoded in `scope` param | **NEW:** `REACT_APP_WHATSAPP_CONFIG_ID` (from App Dashboard) |
| **Feature flag** | None | `feature: 'whatsapp_embedded_signup'` |
| **Permission set** | User selects pages; browser grants permissions via Facebook scope | Embedded Signup dialog grants `whatsapp_business_messaging` + `whatsapp_business_management` |
| **Token return** | Short-lived token via `authResponse` | **CRITICAL:** Authorization code via `window.postMessage` event listener |
| **Server exchange** | Token → access_token via `/exchange-token` | **NEW:** Code → Business Integration System User token via Graph API `/me/token_exchanges` |
| **Data stored** | Page ID + access token in credentials row | **NEW:** Phone Number ID + long-lived business token |

### Backend: Token Exchange Endpoint (New)

**Required new endpoint:** `POST /api/v1/whatsapp/exchange-code` (or similar)

**Request body** (from frontend after receiving auth code):
```javascript
{
  code: '<authorization_code>',  // Returned by Embedded Signup
  phone_number_id: '<phone_number_id>'  // Also returned by signup
}
```

**Server-side logic:**
1. Call Graph API endpoint (Section 6.2 of app-review doc):
   ```
   POST https://graph.instagram.com/v25.0/me/token_exchanges
     ?fields=access_token
     &code=<AUTHORIZATION_CODE>
     &client_id=FACEBOOK_APP_ID
     &client_secret=FACEBOOK_APP_SECRET
   ```
2. Extract long-lived `access_token` from response
3. Create credentials row with:
   ```javascript
   {
     entity: 'whatsapp_business',     // New entity type
     key: '<phone_number_id>',         // Phone number ID is the key (like page_id)
     details: {
       phone_number_id: '<phone_number_id>',
       access_token: '<long-lived_business_token>',
       display_phone_number: '<formatted_number>'  // Optional; helpful for UI
     }
   }
   ```

**Response:** Credential row (mirrors `/credentials` POST response)

**Error handling:** Same as Facebook flow — 400 for auth errors, 500 for server errors, 201 for success

### Backend: Config for WhatsApp

**New environment variables** (add to `dashboard-server/config/index.js`):
```
WHATSAPP_CONFIG_ID=<config_id_from_app_dashboard>         // For frontend consumption
WHATSAPP_GRAPH_URL=https://graph.instagram.com/v25.0     // (reuse FACEBOOK_APP_ID and _SECRET)
```

**Frontend environment variables** (add to `dashboard-client/netlify.toml`):
```
REACT_APP_WHATSAPP_CONFIG_ID=<config_id>
REACT_APP_WHATSAPP_GRAPH_VERSION=25.0
```

---

## 4. MINIMAL DEMO FOR APP REVIEW (File Inventory)

### Frontend: New Files

**1. `dashboard-client/src/containers/WhatsAppEmbedded/WhatsAppEmbedded.js`** (NEW)
   - Mirrors FacebookPages.js structure
   - Loads FB SDK
   - Calls `window.FB.login()` with `feature: 'whatsapp_embedded_signup', config_id: REACT_APP_WHATSAPP_CONFIG_ID`
   - Sets up `window.postMessage` event listener to catch authorization code
   - On success: calls `/whatsapp/exchange-code` endpoint
   - On success: creates credential row (calls `POST /credentials`)
   - **Rationale:** Separate from FB flow; easier to test and label as "temporary"

**2. (Optional) `dashboard-client/src/containers/WhatsAppEmbedded/WhatsAppWarning.js`** (NEW)
   - Display warning banner: "This WhatsApp integration is for App Review only. This interface will be updated."
   - Shown above/below the Embedded Signup modal

**3. Update `dashboard-client/src/root.js`** (MODIFY)
   - Add new route: `<PrivateRoute exact path="/connect/whatsapp" component={WhatsAppEmbedded} auth={Auth} />`

**4. Update `dashboard-client/src/containers/Accounts/Accounts.js`** (MODIFY)
   - Add new account config object:
     ```javascript
     {
       to: '/connect/whatsapp',
       title: 'WhatsApp Business Account (Temporary — for App Review)',
       entity: 'whatsapp_business',
       description: 'This integration is temporary and will be updated. Connect your WhatsApp WABA via Embedded Signup.',
       getName: c => c.details.display_phone_number || c.key,
       buttonText: 'Connect',
     }
     ```

### Backend: New Files

**1. `dashboard-server/api/whatsapp/index.js`** (NEW)
   - Export routes module

**2. `dashboard-server/api/whatsapp/whatsapp.routes.js`** (NEW)
   ```javascript
   router.post('/exchange-code', controller.exchangeCode);
   ```

**3. `dashboard-server/api/whatsapp/whatsapp.controller.js`** (NEW)
   - Single endpoint: `exchangeCode(req, res)` that:
     1. Extracts `code` and `phone_number_id` from request body
     2. Calls Graph API `/me/token_exchanges` to exchange code for long-lived token
     3. Returns `{ access_token, phone_number_id }` to frontend
     4. Frontend then creates credentials row via `/credentials` POST

**4. Update `dashboard-server/api/index.js`** (MODIFY)
   - Add line: `.use('/whatsapp', require('./whatsapp'))`

**5. Update `dashboard-server/config/index.js`** (MODIFY)
   - Add env var schema for `WHATSAPP_CONFIG_ID`
   - Add config block:
     ```javascript
     WHATSAPP: {
       configId: envVars.WHATSAPP_CONFIG_ID,
       graphUrl: 'https://graph.instagram.com/v25.0'  // Could be env var too
     }
     ```

### No Changes Needed

- **`dashboard-server/queries/credentials/`** — existing `create()` query works as-is; just reuse with new entity type
- **`dashboard-server/api/credentials/`** — existing POST/PUT endpoints work as-is
- **Auth0, database schema, etc.** — all reusable

---

## 5. KEY TECHNICAL DECISIONS & RATIONALE

### Why Separate WhatsApp Endpoint from Facebook Flow?

- **Maintainability:** Facebook flow is proven; WhatsApp flow is new and likely to iterate
- **Testing:** Can test WhatsApp in isolation without touching existing Messenger setup
- **Frontend labeling:** Easier to add "temporary" warnings to WhatsApp component only
- **Backend extensibility:** When Track B matures, whatsapp controller can grow independently

### Why Use `phone_number_id` as Credential Key?

- **Mirrors Facebook pattern:** Just as pages are keyed by `page_id`, numbers are keyed by `phone_number_id`
- **Runtime routing:** Existing message-worker and replybot code already handle `account_id` generically (per migration brief, facebook_page_id column is reused). Phone number ID fits same pattern.
- **Uniqueness:** Phone numbers are unique per WABA; no ambiguity

### Why Store Authorization Code Handling on Frontend?

- **Embedded Signup design:** Meta's API sends the auth code via `postMessage` directly to the browser popup window
- **Security:** Code is short-lived (60 minutes); frontend must capture it immediately and send to backend for exchange
- **No alternative:** Backend never sees the code; it only gets the result of the code exchange (token)

### Why Not Implement Webhooks in Minimal Demo?

- **App Review scope:** Review focuses on permissions (`whatsapp_business_messaging`, `whatsapp_business_management`) and Embedded Signup flow
- **Webhooks are post-approval hardening** (per app-review doc Section 5.6)
- **Minimal demo only needs:** Signup → token exchange → storing token
- **Trade-off:** Videos must show the signup + token exchange working; webhooks can be a Phase 2 hardening task

---

## 6. OPEN QUESTIONS & RISKS

### Biggest Unknown: What Exactly Does Meta Return from Embedded Signup?

**Question:** The app-review doc says "authorization code" and mentions `window.postMessage` but doesn't specify:
- Exact message event payload shape (what fields are included?)
- What does `phone_number_id` look like in the response?
- Are there other fields (WABA ID, display phone number, etc.) that should be captured?

**Impact:** Tight; directly affects WhatsAppEmbedded.js event listener payload parsing

**Mitigation:** Check Meta's Embedded Signup implementation doc (not just app-review doc) — likely Section 5 of the app-review checklist points to the implementation guide with full API details

**Related:** `planning/whatsapp-tech-provider-app-review.md` Section 5.1-5.6 covers setup but NOT the detailed postMessage payload structure

### Risk: Unapproved Permissions Block Live Mode

**Risk:** If we deploy this to production before App Review approval, customers will see an empty Embedded Signup flow (no permissions) because live mode only shows approved permissions.

**Mitigation:** 
- Build this in a feature-flagged dev/staging branch (per CLAUDE.md)
- Don't merge to main/production until App Review approval comes through
- Use dev-mode app in staging to test the flow

### Risk: Token Expiration & Refresh

**Question:** Business Integration System User tokens are "long-lived" but the app-review doc doesn't specify:
- Actual TTL (hours? indefinite?)
- Refresh mechanism
- Do we need to implement refresh logic in Phase 2?

**Mitigation:** Not blocking for minimal demo; Phase 2 hardening task. Capture in post-approval documentation.

### Unknown: Webhook Integration for Actual Message Routing

**Question:** Once credentials are stored with WhatsApp token, how does replybot/message-worker use it?

**Current state** (per migration brief):
- `message-worker/tokenstore.go` — looks up token via `SELECT details->>'access_token' FROM credentials WHERE facebook_page_id = $1`
- At runtime, `facebook_page_id` column is reused as generic `account_id` (which is `phone_number_id` for WhatsApp)

**What's unclear:**
- Does message-worker need ANY changes, or does the column reuse work transparently?
- Do we need to wire up WebhookStore to listen for account_update events?
- Which replybot endpoints handle the WhatsApp message format?

**Mitigation:** This is Track A (org-owned numbers) and Track B (Embedded Signup) orthogonal concern. Scout #2 likely explored this. Check `planning/whatsapp-trackA-findings.md` if it exists.

---

## 7. FRONTEND COMPONENT PATTERN: WhatsAppEmbedded (Sketch)

```javascript
// dashboard-client/src/containers/WhatsAppEmbedded/WhatsAppEmbedded.js

const WhatsAppEmbedded = () => {
  const history = useHistory();
  const [code, setCode] = useState(null);
  const [phoneNumberId, setPhoneNumberId] = useState(null);
  
  // 1. Load FB SDK, init with WHATSAPP_CONFIG_ID
  useEffect(() => {
    loadSDK();
    initFB(() => {
      window.FB.login((res) => {
        // 2. Listen for postMessage with auth code
        window.addEventListener('message', (e) => {
          if (e.data.type === 'whatsapp_embedded_signup' && e.data.code) {
            setCode(e.data.code);
            setPhoneNumberId(e.data.phone_number_id);
            // 3. Call backend to exchange code for token
            exchangeCodeForToken(e.data.code);
          }
        });
      }, {
        feature: 'whatsapp_embedded_signup',
        config_id: process.env.REACT_APP_WHATSAPP_CONFIG_ID
      });
    });
  }, []);

  const exchangeCodeForToken = async (code) => {
    try {
      const res = await api.fetcher({
        path: '/whatsapp/exchange-code',
        method: 'POST',
        body: { code, phone_number_id: phoneNumberId }
      });
      const { access_token } = await res.json();
      
      // 4. Create credentials row
      await api.fetcher({
        path: '/credentials',
        method: 'POST',
        body: {
          entity: 'whatsapp_business',
          key: phoneNumberId,
          details: {
            phone_number_id: phoneNumberId,
            access_token,
            display_phone_number: phoneNumberId  // TODO: get actual number from signup response
          }
        }
      });
      
      history.go(-1);  // Back to Accounts
    } catch (e) {
      alert(`Failed: ${e}`);
    }
  };

  return (
    <WhatsAppWarning />
    <LinkModal
      title="Connect WhatsApp Business Account (Temporary for App Review)"
      content={<div>Waiting for Embedded Signup...</div>}
      loading={!code}
      back={() => history.go(-1)}
      success={() => {}}
    />
  );
};
```

---

## 8. BACKEND ENDPOINT SKETCH: WhatsApp Token Exchange

```javascript
// dashboard-server/api/whatsapp/whatsapp.controller.js

exports.exchangeCode = async (req, res) => {
  const { code, phone_number_id } = req.body;
  
  if (!code || !phone_number_id) {
    return res.status(400).json({ error: 'Missing code or phone_number_id' });
  }

  const wa = require('../../config').WHATSAPP;
  const fb = require('../../config').FACEBOOK;
  
  const url = `${wa.graphUrl}/me/token_exchanges`;
  const params = {
    fields: 'access_token',
    code,
    client_id: fb.id,
    client_secret: fb.secret
  };

  try {
    const r = await r2.post(url, { 
      body: new URLSearchParams(params).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }).json;
    
    if (r.error) {
      console.error(r.error);
      return res.status(400).json(r.error);
    }

    return res.json({ 
      access_token: r.access_token,
      phone_number_id 
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
```

---

## 9. DOCUMENTATION GAPS

**Identified gaps to fill after Scout phase (per CLAUDE.md hard rule):**

1. **`documentation/whatsapp-onboarding.md`** (NEW — per migration brief)
   - Two models: org-owned numbers (Track A) vs. Embedded Signup (Track B)
   - Data flow: signup → token exchange → credential storage → replybot/message-worker message routing
   - What's reusable between models
   - Open decisions (webhook timing, token refresh, etc.)

2. **`dashboard-server/README.md`** (APPEND)
   - Add WhatsApp section under "External Integrations" (similar to Cube.js, Kafka, Linear)
   - Document the `whatsapp_business` entity type and how it differs from `facebook_page`
   - Link to whatsapp-onboarding.md for high-level flow

3. **`documentation/platform-abstraction.md` / `-hardening.md`** (APPEND)
   - Clarify that both Facebook pages and WhatsApp numbers use the same `account_id` routing logic
   - Document how message-worker tokenstore works for WhatsApp (if any changes needed)

---

## Summary: The Facebook Connect Flow Shape

**3-endpoint sequence:**
1. Frontend captures FB user token → Backend exchanges for page token
2. Backend saves `(facebook_page, page_id, {name, id, access_token})` credential row
3. Backend subscribes page to webhooks + sets get_started button

**WhatsApp Embedded Signup mirrors this:**
1. Frontend captures Embedded Signup auth code → Backend exchanges for business token
2. Backend saves `(whatsapp_business, phone_number_id, {phone_number_id, access_token, ...})` credential row
3. (Phase 2 hardening) Backend sets up account_update webhook

**Frontend entry point:** React component on `/connect/<service>` route, routed from Accounts.js list.  
**Reusable UI:** LinkModal (selection dialog), api.fetcher (authenticated HTTP), auth via Auth0 Bearer token.

---

## Minimal File Manifest for App-Review Demo

**Frontend (4 files):**
- NEW: `dashboard-client/src/containers/WhatsAppEmbedded/WhatsAppEmbedded.js` (main flow)
- NEW: `dashboard-client/src/containers/WhatsAppEmbedded/WhatsAppWarning.js` (temp banner)
- MODIFY: `dashboard-client/src/root.js` (add route)
- MODIFY: `dashboard-client/src/containers/Accounts/Accounts.js` (add account config)

**Backend (4 files):**
- NEW: `dashboard-server/api/whatsapp/whatsapp.controller.js` (token exchange logic)
- NEW: `dashboard-server/api/whatsapp/whatsapp.routes.js` (route binding)
- NEW: `dashboard-server/api/whatsapp/index.js` (module export)
- MODIFY: `dashboard-server/api/index.js` (mount whatsapp routes)

**Config (1 file):**
- MODIFY: `dashboard-server/config/index.js` (add WHATSAPP env vars)

**Frontend config (env-only):**
- `dashboard-client/netlify.toml` contexts — add REACT_APP_WHATSAPP_CONFIG_ID and REACT_APP_WHATSAPP_GRAPH_VERSION (no code change)

**No schema changes needed** — credentials table is generic by design (entity/key/details).

---

**Biggest risk/unknown:** Exact structure of the `window.postMessage` payload from Embedded Signup (auth code + phone_number_id format). Blocking: need to check Meta's implementation guide, not just app-review checklist.
