# Staging Smoke Test Plan

## Goal

Enable end-to-end smoke testing against the staging environment (`vstag`), exercising the same features as the production smoke test (logic jumps, payments, thread-control handoff, stitches, timeouts) but targeting staging URLs and staging Kafka topics.

## Key simplification: shared smoke-echo

The production smoke-echo app (`976665718578167`, deployed at `fly-smoke-echo.vlab.digital`) is **shared** between production and staging. This works because smoke-echo is completely stateless — no DB, no Kafka, no persistent state. It just receives a thread handoff, echoes the user's message, and hands control back to Fly.

This means:
- No staging smoke-echo deployment needed
- No second Facebook echo app needed
- No staging-specific `target_app_id` in the form JSON — same `976665718578167` for both environments
- No staging webhook setup for smoke-echo

**Prerequisite**: The staging Facebook Page (`935593143497601`) must be connected to the production smoke-echo app (`976665718578167`). This is done in the Facebook dashboard for app `976665718578167` → Messenger → Access Tokens → Add Page.

## Current state

- All staging services deployed and running in `vstag` (replybot, botserver, dashboard, dinersclub, dean, scribble, exodus, exporter, formcentral, linksniffer, cockroachdb, redis)
- Staging Facebook test app (`790352681363186`) webhook verified at `staging.fly-botserver.vlab.digital/webhooks`
- Auth0 staging tenant configured (`virtuallab-staging.auth0.com`)
- Staging DB is empty — no surveys, no users, no credentials
- Staging page `935593143497601` connected to production smoke-echo app

## Plan

### Phase 1: Set up staging dashboard

**1.1 Log into staging dashboard**

Go to `https://staging--vlab-research.netlify.app`, log in via Auth0 (`virtuallab-staging.auth0.com`). Create a user in the Auth0 staging tenant if you haven't already.

**1.2 Connect Facebook page**

Use the dashboard UI to connect page `935593143497601` to the staging Fly test app. This:
- Exchanges the short-lived FB token for a long-lived page token
- Stores it in the `credentials` table (`entity='facebook_page'`)
- Subscribes the page to webhook events via `POST /{pageid}/subscribed_apps`
- Sets the `get_started` payload on the page

### Phase 2: Create staging smoke test forms

The Typeform workspace and token are **shared** with production — no separate workspace needed.

**2.1 Deploy forms**

The existing `smoke-test/form-a.json` and `form-b.json` can be reused as-is since `target_app_id` is `976665718578167` (the shared smoke-echo app). However, we need separate form instances so staging and production don't collide.

Option A: Create new forms with different titles (e.g. "Fly Smoke Test A - Staging"):
```bash
cd smoke-test
TYPEFORM_TOKEN=<token> python3 deploy.py create both
```
Then save the new form IDs separately (e.g. in `.ids-staging`).

Option B: Add an `--env` flag to `deploy.py` that writes to `.ids-staging` instead of `.ids`, and optionally prefixes form titles with "Staging".

**2.2 Create survey in staging dashboard**

From the staging dashboard UI, create a new survey from the Typeform form. Use shortcode `flysmoke` (or `flysmoke-staging` to avoid collision with production). This inserts a row in the `surveys` table with the form JSON and shortcode.

### Phase 3: (Optional) Add payment credentials

For testing payments via dinersclub in staging:

**Using the `fake` provider** — no credentials needed. The payment event's `details` JSON must contain a `result` object. This is the simplest option for basic smoke testing.

**Using sandbox Reloadly** — insert credentials into the staging DB:
```sql
INSERT INTO credentials (entity, key, details, userid)
VALUES ('reloadly', 'default', '{"id": "<sandbox_id>", "secret": "<sandbox_secret>"}', '<your-email>');
```

`RELOADLY_SANDBOX=true` is already set in `staging.yaml`, so dinersclub will hit Reloadly's sandbox API.

### Phase 4: Run the staging smoke test

**4.1 Verify all services are up**

```bash
kubectl get pods -n vstag --field-selector=status.phase=Running
curl -s https://staging.fly-botserver.vlab.digital/health
curl -s https://staging.fly-smoke-echo.vlab.digital/health
```

**4.2 Trigger the smoke test**

Send a message to the staging Facebook Page (`935593143497601`) with `ref: form.flysmoke` (or whatever shortcode the staging survey uses). The full flow should exercise:
- Message receipt (botserver → Kafka → replybot)
- Survey form loading (formcentral)
- Question flow (logic jumps, statements)
- Payment (dinersclub with `fake` provider or sandbox Reloadly)
- Thread handoff (Fly → smoke-echo at `fly-smoke-echo.vlab.digital` → Fly)
- Stitch (form-a → form-b)
- Timeout behavior

**4.3 Verify in database**

```bash
kubectl exec gbv-cockroachdb-0 -n vstag -- ./cockroach sql --insecure --database chatroach -e \
  "SELECT userid, content, timestamp FROM messages ORDER BY timestamp DESC LIMIT 20;"
```

### Phase 5: Documentation

Update `documentation/staging.md` with:
- Staging smoke test overview
- Shared smoke-echo approach
- How to run the staging smoke test
- Staging form shortcodes

## File changes

| File | Action |
|------|--------|
| `smoke-test/deploy.py` | Modify — add `--env` flag (optional, for separate `.ids-staging`) |
| `documentation/staging.md` | Update — document staging smoke test |

## Prerequisites (manual, outside the repo)

- [x] Connect staging page (`935593143497601`) to production smoke-echo app (`976665718578167`)
- [ ] Create user in Auth0 staging tenant (`virtuallab-staging.auth0.com`)
- [ ] Log into staging dashboard and connect Facebook page
- [ ] (Optional) Obtain Reloadly sandbox credentials for payment testing

## Estimation

- Phase 1 (dashboard login + FB page connect): ~15 min
- Phase 2 (Typeform forms + survey creation): ~30 min
- Phase 3 (payment creds, optional): ~15 min
- Phase 4 (run + verify): ~30 min
- Phase 5 (docs): ~15 min
