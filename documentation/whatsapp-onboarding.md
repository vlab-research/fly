# WhatsApp Platform Onboarding — Two Models

This document describes two approaches to onboarding researchers onto WhatsApp, their data flows, reusable patterns, and open decisions.

---

## Track A: Org-Owned Numbers (Near-Term, No Meta Review)

**Timeline:** Immediate. **Requirements:** None beyond existing infrastructure. **Decision:** VLab owns all WhatsApp numbers. A researcher is manually associated with a number by an admin via SQL INSERT.

### Model

- **Number ownership:** VLab owns the WhatsApp Business Account and all phone numbers.
- **Researcher assignment:** Admin manually inserts a credentials row associating the number with the researcher's userid.
- **Survey scope:** All surveys created by that researcher are resolvable under that phone number.
- **Authorization:** VLab holds the organization-level access token (no per-researcher token exchange).

### Data Flow

```
Admin SQL INSERT
  ├─ userid ← researcher@example.com
  ├─ entity ← 'whatsapp_business'
  ├─ key ← <phone_number_id>
  ├─ platform ← 'whatsapp'         (NEW after credentials table migration)
  ├─ account_id ← <phone_number_id> (NEW after credentials table migration)
  └─ details.access_token ← <org_whatsapp_token>
       │
       ▼
credentials table
       │
       ▼
Researcher creates survey in dashboard
       │
       ├─ Survey stored in `surveys` table, keyed by (shortcode, userid)
       │
       ▼
User clicks Click-to-WhatsApp referral link (form.SHORTCODE)
       │
       ├─ Hermes receives webhook, tags event with phone_number_id
       ├─ Replybot extracts shortcode from referral.ref
       │
       ▼
formcentral (dashboard-server)
       │
       ├─ Query credentials: WHERE (platform='whatsapp' AND account_id=phone_number_id)
       ├─ Extract userid
       ├─ Query surveys: WHERE (shortcode AND userid)
       │
       ▼
Survey starts, all responses scoped by phone_number_id
```

### Credential Row Shape

`key` **is** the account id — the number's Meta graph `phone_number_id`, not its
phone number. `details.waba_id` is required, not optional: template CRUD happens
at WABA level and the dashboard 400s without it (see
`documentation/whatsapp-templates.md`).

```sql
INSERT INTO chatroach.credentials (userid, entity, key, details)
VALUES (
  (SELECT id FROM chatroach.users WHERE email = 'researcher@example.com'),
  'whatsapp_business',
  '1023456789',                    -- phone_number_id
  '{"id":"1023456789","waba_id":"2098765432","access_token":"EAAB_ORG_TOKEN","display_phone_number":"+1-555-1234"}'::JSONB
);
```

Use `devops/associate-whatsapp-number.sh` rather than hand-writing this — it
checks the researcher exists and that the account id is unclaimed, so a
collision reports the current owner instead of raising an opaque
`unique_messaging_account` violation:

```bash
WHATSAPP_ACCESS_TOKEN=EAAB... bash devops/associate-whatsapp-number.sh \
  vprod researcher@example.com 1023456789 2098765432 "+1-555-1234"
```

### Production Prerequisites (Track A)

Everything below `credentials` is already deployed and migrated in `vprod` —
hermes `/whatsapp`, the replybot normalizer, the real `WhatsAppClient`, and
migrations 20/21/22. Onboarding a first number needs four things, in order:

**1. The number must live on the environment's existing Meta app.** WhatsApp is
not a separate app. Hermes verifies `X-Hub-Signature-256` on `POST /webhooks`
and `POST /whatsapp` with the **same** `FB_APP_SECRET`, so a number registered
under a different app 401s on every inbound webhook — with no clue as to why.
Production is app `699455733740842`; staging is the test app `790352681363186`.

**2. `WHATSAPP_VERIFY_TOKEN` in the `gbv-bot-envs` secret.** Separate from the
Messenger `VERIFY_TOKEN` so the callback can be provisioned independently. While
it is absent, `GET /whatsapp` returns 401 and Meta refuses to save the callback
URL; Messenger ingest is unaffected. Add it to the env file and apply — never
`kubectl patch` (`documentation/secrets.md`):

```bash
cd devops && bash accounts.sh vprod ../replybot/.env-production
kubectl rollout restart deployment/gbv-hermes -n vprod
```

**3. `WHATSAPP_GRAPH_URL` on message-worker.** `message-worker/config.go`
defaults it to **v18.0** independently of `FACEBOOK_GRAPH_URL`, and Meta has
sunset v18.0. Unset means Messenger keeps working while every WhatsApp send
fails. Set in `devops/values/<env>.yaml`.

**4. The webhook subscription.** In the Meta app's WhatsApp → Configuration:
callback `https://fly-botserver.vlab.digital/whatsapp` (staging:
`https://staging.fly-botserver.vlab.digital/whatsapp`), the verify token from
step 2, then **subscribe the WABA to the `messages` field** — the subscription
is per-WABA, and verifying the callback alone delivers nothing.

### Entry Points for Testing

Three ways to start a survey, cheapest-to-set-up first. See
`documentation/platform-abstraction.md` §6 for the full behaviour of each.

**1. Bare-text form ref — no ad, no Meta setup beyond the webhook.** Text
`form.<shortcode>` to the number from any phone (or open
`wa.me/<number>?text=form.<shortcode>`). The normalizer full-matches
`/^(?:start\s+)?form\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/i` and synthesizes
the same `conversation_started` event a real referral produces; trailing
`.key.value` pairs ride along into `state.md`. This is the practical end-to-end
test: it exercises Meta → hermes → Kafka → replybot → message-worker → Cloud
API, and back.

**2. `POST /synthetic`** — skips Meta ingestion entirely, so it isolates
everything downstream of the webhook and is repeatable. It still performs a
**real** outbound send, so the credential and token must be valid.

**3. Click-to-WhatsApp referral** — the production path, needs an actual paid CTWA
ad. There is no unpaid "referral link" that produces a referral object; see below.

### Entry links: there is no `ref` on WhatsApp

Verified against Meta docs 2026-08-09. **WhatsApp has no equivalent of
`m.me/<page>?ref=<REF>`.** The only structured referral channel — the inbound
`messages[0].referral` object — is emitted *only* for paid Click-to-WhatsApp ads,
and its fields are Meta-assigned or per-creative, never per-click-arbitrary:

| Field | Settable by us? |
|---|---|
| `source_id` | No — Meta-assigned **ad id** (not our string) |
| `source_url` | No — a Meta `fb.me` redirect, not our URL; cannot carry our querystring |
| `ctwa_clid` | No — Meta-generated per-click id (useful for Conversions API attribution) |
| `source_type`, `media_type`, `*_url` | No |
| `headline`, `body`, `welcome_message.text` | **Yes — but per *creative*, not per click** |

So targeting metadata via CTWA means **one ad creative per targeting cell**. Note
CTWA context is **mobile-only** — Meta does not deliver it for WhatsApp Web/Desktop
users — and `referral` arrives on the **first** inbound message only.

**The referral object usually carries no form ref, so we read the ad's autofill
message instead (since `v0.0.218`).** Nothing in the documented field list is a
form shortcode, and `getMetadata` guards on `if (r && r.ref)` — so a CTWA click
would otherwise resolve to `FALLBACK_FORM`, reproducing VIR-19 on the production
ad path. A CTWA ad's `autofill_message` prefills the user's first message, which
means the same entry token the `wa.me` path uses arrives on `text.body` next to
the referral. When the referral has no usable `ref`, the normalizer derives one
from that text.

**Setting up a CTWA ad therefore requires putting the entry token in the ad's
autofill/message template**, e.g. `form.hpvintrotriple.creative.3b.gender.men`.
An ad whose autofill text is a friendly greeting instead will start every clicker
on `FALLBACK_FORM`. This is the single easiest way to misconfigure a WhatsApp ad.

An explicit `referral.ref` still wins if Meta does send one, and `ctwa_clid` is
preserved either way for Conversions API attribution.

**`wa.me` strips unknown query params.** `wa.me/<num>?ref=X` 302s to
`api.whatsapp.com/send/?phone=…&text=…&type=phone_number&app_absent=0` with `ref`
dropped. (`wa.me` is a pure shortener in front of `api.whatsapp.com`, not the other
way round — the widely-repeated claim that `api.whatsapp.com/send` is deprecated is
false.) A `utm_*` allowlist survives onto WhatsApp's own interstitial page but never
reaches the business webhook.

**The only carrier is prefilled text**: `wa.me/<number>?text=<urlencoded>`. It
arrives as an ordinary `text.body` — indistinguishable from the user typing your
number by hand — which is exactly what our bare-text entry path consumes. Caveats
that matter:

- **The user can edit or delete the prefilled text before sending**, and must press
  send. Never assume verbatim arrival; always keep a fallback.
- **Raw `&` and `#` in `text=` silently truncate the message.** Percent-encode them
  (`%26`, `%23`). Our ASCII `form.SHORTCODE.key.val` scheme is safe unless a
  targeting *value* ever contains one.
- **`wa.me` corrupts many emoji** to U+FFFD; `api.whatsapp.com/send` preserves them.
  Irrelevant for ASCII refs.
- No practical length cap below the 4,096-char message-body max. The **140-char
  limit is QR/short-link-specific**, not a `wa.me?text=` limit.
- On desktop `wa.me` shows an interstitial requiring a second click.

**QR codes / short links** (`POST /{phone-number-id}/message_qrdls`, giving a
`wa.me/message/<CODE>` deep link) are just a managed wrapper around prefilled text:
scanning delivers the text with **no referral object and no `code`** — Meta
deliberately logs nothing, "to protect user privacy". Capped at 2,000 codes per
number × 140 chars. They buy nothing over a plain `wa.me?text=` link.

**One untested lead:** Meta's Welcome Message Sequences guide shows a `ref` field
inside the referral object annotated `// New field in referral`. It appears on that
page only, no doc explains how to set it, and one BSP (Zendesk) claims it can be set
when creating the ad. If real, it is the exact `m.me?ref=` analogue — cheap to test
once a CTWA ad exists, and worth doing before building around per-creative refs.

**Prefilled-text links carry full metadata (since `replybot-v0.0.217`).** The
bare-text pattern in `replybot/lib/event-normalizer.js` is:

```js
/^(?:start\s+)?form\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/i
```

The **whole** matched ref body is forwarded as `payload.referral.ref`; parsing
stays in `getMetadata()`/`_group` (`typewheels/utils.js`), which is already
order-independent and platform-agnostic. So

```
wa.me/<number>?text=form.hpvintrotriple.creative.3b.gender.men
```

reaches `state.md` as `{form:'hpvintrotriple', creative:'3b', gender:'men'}` —
parity with `m.me?ref=`.

- The pattern stays **anchored/full-match**, so a mid-survey free-text answer
  still cannot re-trigger entry. That is the property the strictness exists for.
- Only the literal `form.` prefix is lowercased; the shortcode and every
  metadata token preserve the case as typed.
- **An odd token count is deliberately allowed.** `form.ABC.creative` (dangling
  key, no value) matches; `_group` pairs two at a time and leaves the trailing
  key `undefined` rather than throwing. The survey starts and `md.creative` is
  `undefined` — failing open beats silently dropping a participant's entry.
- Before v0.0.217 the character class excluded `.`, so WhatsApp entry carried the
  shortcode and nothing else. Historical `state.md` from WhatsApp entries predating
  that tag will have no `creative`/`gender`/`geography` keys.

Coverage: `replybot/lib/event-normalizer.test.js` (multi-pair, odd-token,
case preservation, and the strictness negatives) and
`replybot/lib/typewheels/machine.test.js` → `WhatsApp bare-text entry carries
Messenger-parity metadata`, which drives a **raw** webhook through `parseEvent`
into `getState`.

`user` is the recipient's phone number in E.164 without `+` (it becomes the
Cloud API `to`), and `page` is the `phone_number_id`:

```bash
curl -X POST https://fly-botserver.vlab.digital/synthetic \
  -H 'Content-Type: application/json' \
  -d '{
    "user": "27123456789",
    "source": "synthetic",
    "page": "1023456789",
    "event": {
      "type": "conversation_started",
      "value": {
        "trigger": "referral",
        "referral": { "ref": "form.flysmoke" }
      }
    }
  }'
```

Note the 24-hour rule: a synthetic send to someone who has not messaged the
number in the last 24 hours is outside the customer-service window and Meta
rejects it unless it is an approved template. Text the number first, then inject.

### What Reuses From Messenger

- **Credentials table, unchanged.** `key` holds the account id for both platforms; `entity` distinguishes them. Migration 20's `unique_messaging_account` partial index enforces global account-id uniqueness and serves the lookup.
- **Token lookup:** `message-worker/tokenstore.go` `GetToken(ctx, platform, accountID)` → `WHERE entity = 'whatsapp_business' AND key = <phone_number_id>`, falling back to `WHERE key = $1 AND entity IN ('facebook_page','whatsapp_business')` when platform is absent.
- **Survey resolution:** formcentral maps account id → userid, then resolves `(shortcode, userid)`.
- **State scoping:** Dashboard states/responses filtered by account id (same generic pattern as Messenger).
- **Message routing:** Replybot normalizes inbound events to `UniversalEvent`, machine is platform-agnostic.

### What's Different From Messenger

- **No page management UI in dashboard** (Track A is org-owned, not researcher-managed).
- **No token exchange endpoint** (token is stored directly by admin SQL, not via OAuth).
- **The WABA must be subscribed to the `messages` webhook field.** Unlike Messenger pages — which the dashboard subscribes on connect — nothing in this repo subscribes a WABA. Verifying the callback URL alone delivers no events.
- **Entry is by referral *or* bare `form.<shortcode>` text** — there is no "Get Started" button equivalent, but the bare-text path means no ad is needed to start a survey.
- **Free-form sends are limited to the 24-hour customer-service window.** Anything outside it — dean timeouts and follow-ups, payment retries — must be an approved template (`documentation/whatsapp-templates.md`). Messenger has no such constraint.
- **No handoff.** WhatsApp has no `pass_thread_control` equivalent; handoff fields are unimplemented on this platform.
- **No quick_reply / postback bug** (WhatsApp interactive buttons don't have the Messenger quick_reply payload parsing issue; see platform-abstraction-hardening.md §7).
- **Question option limits are hard errors.** ≤3 options → interactive buttons, 4–10 → a list, >10 → `ErrTooManyOptions`. A survey that works on Messenger can fail to send on WhatsApp for this reason alone.

### Environment Status (Track A)

| | `vstag` | `vprod` |
|---|---|---|
| hermes `/whatsapp` routes | ✅ `v0.0.3-wa` | ✅ `v0.0.3-wa` |
| replybot WhatsApp normalizer | ✅ | ✅ (on `main` since `f1712e91`) |
| message-worker `WhatsAppClient` | ✅ | ✅ `v0.1.17-wa` |
| Migrations 20 / 21 / 22 | ✅ | ✅ |
| `WHATSAPP_VERIFY_TOKEN` in `gbv-bot-envs` | ✅ | ❌ add to `replybot/.env-production` |
| `WHATSAPP_GRAPH_URL` on message-worker | ❌ defaults to sunset v18.0 | ✅ v25.0 |
| `whatsapp_business` credential | ❌ none | ❌ none |

Recorded 2026-08-05. Neither environment has onboarded a number yet; the code
and schema are ready in both, so the remaining work is config plus the Meta-side
assets listed under "Production Prerequisites" above.

Staging still needs `WHATSAPP_GRAPH_URL` added to `devops/values/staging.yaml`
(on the `staging` branch — see `documentation/staging.md` on why not `main`).

### How Many Numbers Track A Needs, and What Meta Caps

**One number serves exactly one dashboard account.** `formcentral/db.go:82` resolves
a survey via `s.userid = (SELECT userid FROM credentials WHERE key = <account_id>)`,
and `unique_messaging_account` makes that mapping strictly one-to-one. So a
researcher with 29 Facebook pages still needs only *one* WhatsApp number — but two
researchers can never share one. Track A therefore needs **one number per researcher
login**, which is the constraint Track B exists to remove.

As of 2026-08-05 vprod has 20 distinct users holding `facebook_page` credentials
(63 pages between them). Full WhatsApp parity under Track A would mean 20 numbers.

**Meta's caps** (verified against Meta docs 2026-08-05; they revise these):

| | New portfolio | After verification |
|---|---|---|
| Business phone numbers | 2 | 20 |
| Messaging limit (unique recipients / 24h) | 250 | 2,000 |

- The phone-number cap is **per WABA**, not per business portfolio.
- The ladder is 250 → 2,000 → 10,000 → 100,000 → unlimited. There is no 1,000 tier,
  and **the 250 start does not depend on verification** — every new portfolio begins
  there. Verification is one of three ways off it; the others are partner
  verification, or delivering 2,000 high-quality template messages to unique numbers
  within 30 days.
- The two caps are linked: reaching a messaging limit of 2,000 *also* raises the
  phone-number cap to 20, whichever way you get there.
- Past 2,000, upgrades are automatic within 6 hours, but require having used at
  least half the current limit in the preceding 7 days at good quality.

**The limit counts only messages sent outside the 24-hour customer service window.**
This is the part that matters for survey design: CTWA referrals and bare-text
`form.<shortcode>` starts are *user*-initiated, so survey starts and all in-window
back-and-forth are uncapped. What counts against the tier is dean timeouts,
follow-ups, and payment retries that land out of window — i.e. template sends. A
study whose respondents all reply promptly consumes almost no quota; one that leans
on follow-ups can exhaust 250/24h at a few hundred respondents.

**Two throughput limits sit underneath all of this**, independent of tier: 80
messages/second overall, and **1 message per 6 seconds to the same user**. The
per-user pair limit is the one to watch when dean fans out a bulk follow-up.

**Track A needs no App Review.** Business Verification (Meta verifying your legal
business identity) is what governs everything in this section. Advanced Access for
`whatsapp_business_messaging` / `whatsapp_business_management` is a *separate*
process governing whether third parties can connect *their* numbers through the app
— that is Track B only. Conflating them sends you down a weeks-long App Review path
that org-owned numbers never require.

---

## Track B: Self-Serve Embedded Signup (Long-Term, Requires App Review)

**Timeline:** 1-2 weeks (parallel with Business Verification paperwork). **Requirements:** Meta App Review approval. **Decision:** Researchers self-serve connect their own WABA + phone number via WhatsApp Embedded Signup popup.

### Model

- **Number ownership:** Researcher owns their WhatsApp Business Account and phone numbers.
- **Signup flow:** Researcher clicks "Connect WhatsApp" in the dashboard → Embedded Signup popup → selects WABA + number → grants `whatsapp_business_messaging` + `whatsapp_business_management` permissions.
- **Token exchange:** Backend exchanges Embedded Signup authorization code for Business Integration System User (long-lived) access token.
- **Credential storage:** Token stored in credentials table with platform metadata.
- **Survey scope:** All surveys created by that researcher are resolvable under that phone number.
- **Authorization:** Researcher's account (via Business Verification) is the source of authority.

### Data Flow

```
Dashboard UI: Researcher clicks "Connect WhatsApp"
       │
       ▼
Embedded Signup popup (via FB SDK)
       │
       ├─ window.FB.login({ feature: 'whatsapp_embedded_signup', config_id: CONFIG_ID })
       ├─ Meta popup renders; researcher selects WABA + number
       ├─ Researcher grants whatsapp_business_* permissions
       │
       ▼
postMessage event → authorization code to frontend
       │
       ├─ event.data = { type: 'whatsapp_embedded_signup', code: '<auth_code>', phone_number_id: '...' }
       │
       ▼
Dashboard frontend: POST /api/v1/whatsapp/exchange-code
       │
       ├─ Request: { code, phone_number_id }
       │
       ▼
Dashboard backend: exchangeCode()
       │
       ├─ Call Graph API: POST /me/token_exchanges?code=...&client_id=...&client_secret=...
       ├─ Extract long-lived access_token
       │
       ▼
Dashboard frontend: POST /api/v1/credentials
       │
       ├─ Request: { entity: 'whatsapp_business', key: phone_number_id, details: { ... access_token ... } }
       │
       ▼
credentials table (same schema as Track A)
       │
       ▼
Researcher creates survey in dashboard
       │
       └─ (Survey start flow identical to Track A)
```

### Credential Row Shape

Identical to Track A:

```sql
INSERT INTO credentials (userid, entity, key, details, created)
VALUES (
  (SELECT id FROM users WHERE email = 'researcher@example.com'),
  'whatsapp_business',
  '<phone_number_id>',
  '{"id":"<phone_number_id>","access_token":"<business_integration_token>",...}'::JSONB,
  CURRENT_TIMESTAMP
);
```

### What Reuses From Messenger Facebook Connect Flow

**Frontend:**
- Entry point routing in dashboard (`Accounts.js` → route to `/connect/whatsapp`).
- Reusable UI pattern: `LinkModal` (selection dialog), `api.fetcher()` (authenticated HTTP client).
- Auth0 Bearer token injection for all API calls.

**Backend:**
- Credentials table POST endpoint (`POST /api/v1/credentials`).
- Credential row schema and validation.
- Token storage in `details.access_token`.

**Post-signup workflow:**
- Identical to Messenger: stored token is used by message-worker to send messages.
- Survey resolution by `(shortcode, userid)` is identical (credentials lookup by account_id).

### What's Different From Facebook Connect Flow

| Aspect | Facebook (Messenger) | WhatsApp (Embedded Signup) |
|--------|---|---|
| **Signup UI** | `window.FB.login()` with `scope` list → login → select pages | `window.FB.login()` with `feature: 'whatsapp_embedded_signup'` → popup → select WABA |
| **Token return method** | `authResponse.accessToken` (standard OAuth) | `window.postMessage` event (custom callback) |
| **Exchange endpoint** | `POST /facebook/exchange-token` | `POST /whatsapp/exchange-code` |
| **Exchange API** | Facebook `/oauth/access_token?grant_type=fb_exchange_token` | Graph API `/me/token_exchanges` |
| **Token type** | User page access token (per-page) | Business Integration System User token (org-level) |
| **Webhook setup** | Backend calls `POST /webhooks` + `POST /get-started` | (Phase 2 hardening; not in minimal demo) |

### Dashboard Endpoints (Track B Minimal Demo)

**Frontend:**
- NEW: `dashboard-client/src/containers/WhatsAppEmbedded/WhatsAppEmbedded.js` (main signup flow component).
- NEW: `dashboard-client/src/containers/WhatsAppEmbedded/WhatsAppWarning.js` (temporary/for-review banner).
- MODIFY: `dashboard-client/src/root.js` (add route `/connect/whatsapp`).
- MODIFY: `dashboard-client/src/containers/Accounts/Accounts.js` (add WhatsApp account config).

**Backend:**
- NEW: `dashboard-server/api/whatsapp/whatsapp.controller.js` (exchangeCode endpoint).
- NEW: `dashboard-server/api/whatsapp/whatsapp.routes.js` (route binding).
- NEW: `dashboard-server/api/whatsapp/index.js` (module export).
- MODIFY: `dashboard-server/api/index.js` (mount whatsapp routes).
- MODIFY: `dashboard-server/config/index.js` (add `WHATSAPP_CONFIG_ID` env var).

**Environment:**
- `dashboard-client/netlify.toml` — add `REACT_APP_WHATSAPP_CONFIG_ID` and `REACT_APP_WHATSAPP_GRAPH_VERSION` in staging/production contexts.

No database schema changes.

### App Review Requirements

**Timeline:**
- **Business Verification:** 1-2 weeks (started first; no code dependency).
- **Build + video creation:** 1 week (parallel with verification).
- **App Review:** 24-48 hours.

**Submission scope:** Minimal working Embedded Signup popup + server-side token exchange. Full dashboard integration is Phase 2 hardening.

**Permission scope:**
- `whatsapp_business_messaging` — send messages to customers.
- `whatsapp_business_management` — read/write WABA configuration.

**Screencast requirements:** Two separate videos (one per permission), showing the Embedded Signup popup and the resulting token exchange.

**Biggest risk:** Incomplete Business Verification at submission time (no workaround). Start the verification paperwork immediately (Day 1 of build).

See `planning/whatsapp-tech-provider-app-review.md` for full App Review checklist and timeline.

---

## Comparing the Two Models

| Aspect | Track A (Org-Owned) | Track B (Embedded Signup) |
|--------|---|---|
| **When** | Now | 1-2 weeks |
| **App Review** | None | Yes |
| **Researcher effort** | None (admin assigns) | Click connect → approve permissions |
| **Number ownership** | VLab | Researcher |
| **Token source** | Org-level permanent token | Business Integration System User token (via Embedded Signup) |
| **Scaling** | Manual admin step per researcher | Self-serve, unlimited |
| **Credential storage** | Same table | Same table |
| **Message routing** | Same tokenstore.go pattern | Same tokenstore.go pattern |
| **Survey resolution** | Same formcentral pattern | Same formcentral pattern |

---

## Open Decisions & Follow-Up Tasks

### Track A

1. **Credentials table migration** — When to add `platform` and `account_id` columns and backfill existing Messenger credentials? See `planning/whatsapp-account-model-design.md` §5-6 for the schema migration plan.

2. **Staging test repeatability** — Synthetic referral injection via `POST /synthetic` is repeatable but doesn't exercise the real Click-to-WhatsApp referral path. Once a real Meta webhook is configured, manual testing via `wa.me/<number>?text=form.<shortcode>` (or QR code) is needed. **There is no `m.me?ref=` equivalent on WhatsApp** — see "Entry links: there is no `ref` on WhatsApp" below.

3. **Token rotation & expiration** — Org tokens are long-lived/permanent. Do we need refresh logic in message-worker, or can we assume indefinite TTL? Capture this in post-Track-A documentation.

### Track B

1. **Embedded Signup postMessage payload** — Exact shape of `window.postMessage` event from Meta's Embedded Signup (fields, auth code format, phone_number_id presence) is not yet fully specified. Must check Meta's implementation guide (not just app-review checklist) before building the frontend event listener.

2. **Webhook integration** — Once credentials are stored, do inbound WhatsApp webhooks "just work" (same as Track A), or is there additional webhook setup needed? Likely "just work" but confirm during build.

3. **Token expiration & refresh (Track B)** — Business Integration System User tokens are long-lived. Determine actual TTL and whether refresh logic is needed in production. Not blocking for minimal demo (Phase 1), but needed for Phase 2 hardening.

4. **Message template / account_update webhook subscription (Phase 2)** — Track B minimal demo does not subscribe the researcher's WABA to webhooks or set up message templates. This is post-approval hardening (see platform-abstraction.md §7 "Botserver — Webhook Verification").

---

## Cross-References

- **`documentation/platform-abstraction.md`** — Account ID routing, normalized events, platform-agnostic machine.
- **`documentation/platform-abstraction-hardening.md`** — Regression testing, production readiness, known issues (including Messenger quick_reply bug).
- **`documentation/staging.md`** — Staging environment config, Facebook test app, Netlify integration.
- **`planning/whatsapp-tech-provider-app-review.md`** — Full App Review checklist, Business Verification timeline, permission scope, screencast requirements.
- **`planning/whatsapp-account-model-design.md`** — Credentials table schema migration, 8-consumer query changes, rollback plan.
- **`planning/whatsapp-trackA-findings.md`** — Survey resolution mechanism, token lookup, manual association SQL.
- **`planning/whatsapp-trackA-entrypoint-findings.md`** — Referral behavior, synthetic entry point payload shape.
- **`planning/whatsapp-trackB-findings.md`** — Embedded Signup flow, token exchange endpoint shape, file inventory.
