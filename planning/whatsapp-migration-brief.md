# WhatsApp Migration — Scope Brief (three-phase kickoff)

Confirmed scope for the WhatsApp platform work. Two parallel tracks. Detailed
Meta App Review requirements live in
[`planning/whatsapp-tech-provider-app-review.md`](./whatsapp-tech-provider-app-review.md).

## Context (verified in code)

The platform abstraction is done and WhatsApp code already exists end-to-end but
is **dormant** on staging (`WHATSAPP_VERIFY_TOKEN` unset, no Meta webhook). See
`documentation/platform-abstraction.md` and
`documentation/platform-abstraction-hardening.md`.

**Runtime routes everything by account id.** For WhatsApp the account id is the
`phone_number_id`, which behaves exactly like a Facebook `page_id`:
- Send target: `replybot/lib/typewheels/transition.js:26` —
  `page = parsedEvent.source.account_id || state.md.pageid`.
- Survey resolution: `getForm(pageid, shortcode)` keys on `(account_id, shortcode)`.
- Token lookup: `message-worker/tokenstore.go` — `SELECT details->>'access_token'
  FROM credentials WHERE facebook_page_id = $1` (column reused as generic account id).
- Dashboard/states scope by the same `facebook_page_id` column.

## Track A — Near-term: org-owned numbers (NO Meta review needed)

**Decision:** VLab owns all the WhatsApp numbers. A number is **manually
associated to a user** (an admin step, like adding a page today). Once associated,
**all of that user's shortcodes/surveys resolve under that `phone_number_id`** —
exactly the page model.

**CRITICAL FIX:** WhatsApp numbers are NOT reused on `entity='facebook_page'` (that
is a platform-abstraction seam-leak). Instead, they are **first-class platform
credentials** with `platform='whatsapp'` and `account_id=<phone_number_id>` in the
credentials table. See `planning/whatsapp-account-model-design.md` for the full
schema migration (adds `platform` and `account_id` columns; backfills existing
Messenger creds; dual-read window during consumer rollout).

What this needs (to be detailed in Plan phase):
- A safe, backward-compatible schema migration: add `platform` + `account_id` columns,
  backfill existing Messenger credentials, create index, update 8 consumers to query
  by `(platform, account_id)` instead of the legacy `facebook_page_id` computed column.
- Manual SQL registration script (admin step) to insert a WhatsApp credential row with
  `entity='whatsapp_business'`, `platform='whatsapp'`, `account_id=<phone_number_id>`,
  and org access token in `details.access_token`.
- `WHATSAPP_VERIFY_TOKEN` set on Hermes (staging first) so `GET /whatsapp` verifies.
- Optionally `WHATSAPP_GRAPH_URL=https://graph.facebook.com/v25.0` on message-worker
  (currently defaults to v18.0 while Messenger runs v25.0).
- The referral/entry-point question for starting a survey on WhatsApp
  (conversation_started fires on referral `form.<shortcode>` — how a test/real user
  starts a survey needs nailing down).

Guardrail: staging stays on `-wa` image tags; never promote `-wa` to
`production.yaml` (see `documentation/staging-tagging-and-deploy.md`).

## Track B — Long-term: Tech Provider + Embedded Signup (needs App Review)

**Goal:** self-serve "Connect WhatsApp" in the dashboard via WhatsApp Embedded
Signup, so researchers onboard their own WABA + number — the analog of today's
Facebook Page connect (`dashboard-server/api/facebook/facebook.controller.js` →
`exchangeToken`, credentials insert).

**Build for App Review:** a *minimal working* Embedded Signup popup + server-side
token exchange (Business Integration System User token) is sufficient to
demonstrate — a fully built dashboard is NOT required. This is the piece we build
now so we have something to screencast for review.

**Add temporary UI notes:** the App-Review dashboard surface must be visibly
labeled temporary/for-review.

**Critical path (from research):** Business Verification is the 1–2 week
bottleneck with no workaround — start Day 1, runs as paperwork in parallel with
the build. App Review itself is ~24–48h but needs **two separate screencast
videos** (one per permission: `whatsapp_business_messaging`,
`whatsapp_business_management`). Biggest rejection risk: reviewer can't
access/authenticate the app, or videos don't clearly show the permission in use.

There is currently **zero WhatsApp code in dashboard-server** — Track B is greenfield.

## Sequencing

1. Track A first (no Meta gate) — get WhatsApp live on staging with an org number.
2. Track B build (Embedded Signup minimal flow + token exchange + temporary UI)
   in parallel with Business Verification paperwork, to produce the App Review demo.
3. Post-approval: harden Embedded Signup into the real self-serve onboarding.

## Documentation follow-through (CLAUDE.md hard rule)

After Scout, before Plan: update `documentation/` — a new
`documentation/whatsapp-onboarding.md` (two models: org-owned vs Embedded Signup,
what's reusable, open decisions) and additions to
`documentation/platform-abstraction.md` / `-hardening.md`. Update `dashboard-server/README.md`
when the connect flow lands.
