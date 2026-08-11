# WhatsApp Platform — Staging Rollout Runbook

**Branch:** `feature/whatsapp-platform-keying` (worktree `../fly-whatsapp-platform`)
**Scope:** migrations 20–22 + all branch services onto staging (`vstag`), Track A live, Track B demo-ready.
**Prepared:** 2026-07-22. Companion to `planning/whatsapp-plan.md`.

Everything below is written to be executed top-to-bottom; each step names its rollback.

---

## 0. Preconditions (user / external — can happen anytime before deploy)

| # | Action | Owner | Status |
|---|--------|-------|--------|
| P1 | `WHATSAPP_VERIFY_TOKEN` into staging secret: `TOKEN=$(openssl rand -hex 24); kubectl -n vstag patch secret gbv-bot-envs --type merge -p "{\"stringData\":{\"WHATSAPP_VERIFY_TOKEN\":\"$TOKEN\"}}"; echo "token: $TOKEN"` — keep the token for Meta webhook config. Also add the key to `replybot/.env-staging` so `accounts.sh` re-runs don't drop it. | user (Claude was permission-blocked) | ☐ |
| P2 | Confirm `FACEBOOK_APP_SECRET` in `gbv-bot-envs` is the secret of the SAME Meta app that signs staging webhooks. The new hermes enforces `X-Hub-Signature-256` on POST `/webhooks` + `/whatsapp` once `FB_APP_SECRET` is set (staging.yaml now maps it). Mismatch ⇒ all inbound 401s. `kubectl -n vstag get secret gbv-bot-envs -o jsonpath='{.data.FACEBOOK_APP_SECRET}' \| base64 -d` and compare against Meta App Dashboard → Settings → Basic. | user | ☐ |
| P3 | Org WhatsApp number for Track A: `phone_number_id` + permanent access token (System User token with `whatsapp_business_messaging`). | user | ☐ |
| P4 | Track B external: Meta app w/ WhatsApp product, Business Verification submitted, Embedded Signup configuration created → **Config ID** for Netlify env (`REACT_APP_WHATSAPP_CONFIG_ID`). Not a blocker for Track A. | user | ☐ |

## 1. Push branch & tag images (CI builds → GHCR)

The branch is currently **not pushed**. CI (`.github/workflows/release.yml`) builds any tag matching `<service>-v<semver>[-suffix]`; all needed services are in its case list.

```bash
cd ../fly-whatsapp-platform
git push -u origin feature/whatsapp-platform-keying

# Tag HEAD for every service changed on the branch (bump each to the next
# free version; check existing tags with: git tag -l 'replybot-v*' | sort -V | tail -3)
for t in replybot-v0.0.209-wa message-worker-v0.1.15-wa hermes-v0.0.2-wa \
         dean-v0.0.42-wa dinersclub-v0.0.42-wa formcentral-v0.0.13-wa \
         dashboard-v0.0.65-wa; do git tag "$t"; done
git push origin --tags   # or push the specific tags
```

Changed-on-branch services requiring new images: **replybot, message-worker, hermes, dean, dinersclub, formcentral, dashboard(-server)**. (dashboard-client ships via Netlify, not GHCR — step 5.)

**Guardrail:** `-wa` tags NEVER go in `devops/values/production.yaml`.

## 2. Pre-flight: data invariant check (staging DB)

The key-based lookups (message-worker GetToken, dean FollowUps, dashboard states SCOPE_SQL) assume `credentials.key = details->>'id'` for messaging entities. Prod verified 63/63; staging not yet:

```sql
SELECT key, details->>'id' AS details_id FROM chatroach.credentials
WHERE entity = 'facebook_page' AND key IS DISTINCT FROM details->>'id';
-- MUST return 0 rows. If not, fix rows BEFORE migrations (UPDATE key = details->>'id').
```

## 3. Migrations 20 + 21 + 22 (staging DB)

```bash
# Same client pattern as devops/all.sql header / run-prod-migration.sh, against vstag:
for f in 20-messaging-account-unique.sql 21-states-platform.sql 22-account-id-rename.sql; do
  cat devops/migrations/$f | kubectl run -i --rm cockroach-client-$RANDOM \
    --image=cockroachdb/cockroach:v21.2.17 --restart=Never -n vstag --command -- \
    ./cockroach sql --insecure --host gbv-cockroachdb-public
done
```

- 20/21 are additive (index + computed column) — safe with old code running.
- **22 is a RENAME — the old dashboard image breaks on it** (`media`/`message_templates` queries). Run 22 immediately before the helm upgrade in step 4, same maintenance window.

**Rollback:** 20/21: drop index / drop column. 22: `ALTER TABLE ... RENAME COLUMN account_id TO facebook_page_id` (both tables) + redeploy old dashboard image.

## 4. Helm deploy (staging)

```bash
cd ../fly-whatsapp-platform/devops
# staging.yaml version bumps: replybot v0.0.209-wa, message-worker v0.1.15-wa,
# hermes v0.0.2-wa, dean v0.0.42-wa, dinersclub v0.0.42-wa,
# formcentral v0.0.13-wa, dashboard v0.0.65-wa   (commit this bump on the branch)
helm upgrade gbv vlab -f values/staging.yaml -n vstag
kubectl -n vstag rollout status deployment/gbv-hermes deployment/gbv-dashboard deployment/gbv-replybot
```

Note: hermes deploy also activates signature enforcement (P2) and picks up `WHATSAPP_VERIFY_TOKEN` (P1).

**Rollback:** re-run helm upgrade with previous versions (helm history / `helm get values gbv -n vstag` first).

## 5. Frontend (Netlify)

- Add `REACT_APP_WHATSAPP_CONFIG_ID` (from P4) to Netlify staging context (site `vlab-research`).
- Push/merge the branch's `dashboard-client` changes to the `staging` branch → auto-deploy to `staging--vlab-research.netlify.app`.
- Deploy-order safety: server accepts legacy `pageId` params, so client/server deploy order doesn't matter.

## 6. Track A registration (one-time SQL)

```sql
INSERT INTO chatroach.credentials (userid, entity, key, details)
VALUES (
  (SELECT id FROM chatroach.users WHERE email = '<researcher email>'),
  'whatsapp_business',
  '<phone_number_id>',
  '{"id":"<phone_number_id>","waba_id":"<waba_id>","access_token":"<org token>","display_phone_number":"<+...>"}'
);
-- key MUST equal details->>'id' (invariant). unique_messaging_account enforces
-- global uniqueness; INSERT fails loudly on collision.
-- waba_id is REQUIRED for template management (WhatsApp template CRUD is a
-- WABA-level API — see documentation/whatsapp-templates.md); the dashboard
-- fails loudly if it's absent.
```

Then configure the Meta webhook: callback `https://staging.fly-botserver.vlab.digital/whatsapp`, verify token from P1, subscribe `messages`.

## 7. Smoke tests (in order)

1. **Hermes handshake:** `curl 'https://staging.fly-botserver.vlab.digital/whatsapp?hub.verify_token=<P1 token>&hub.challenge=ok'` → `200 ok`.
2. **Signature enforcement live:** unsigned `curl -X POST .../whatsapp -d '{"entry":[]}' -H 'content-type: application/json'` → **401** (proves FB_APP_SECRET wired).
3. **Messenger regression (CRITICAL):** real message/referral to page `935593143497601` → survey starts, responses recorded, no hermes 401s in logs (`kubectl -n vstag logs deploy/gbv-hermes | grep -i 'signature'` should be empty of failures for Meta traffic).
4. **WhatsApp inbound:** from a real phone, send `form.<shortcode>` as a plain text to the org number (bare-text entry now starts surveys — commit on branch; a `wa.me/<number>?text=form.<shortcode>` link prefills exactly this). Alternatives: CTWA-shaped referral webhook, or a pre-normalized UniversalEvent to `/synthetic` (NOT `synthetic_conversation_started`, see plan §Track A Entry Point). → replybot logs show `source='whatsapp'`; survey starts.
5. **WhatsApp outbound:** message-worker logs show token lookup success for the phone_number_id; message arrives on the phone.
6. **Dashboard:** states page shows WhatsApp state rows; media/templates pages render (`account_id` columns); Track B `/connect/whatsapp` route renders its App-Review banner (full ES flow needs P4).

## 8. Post-deploy

- Watch `vstag` error rates + hermes logs for 24h (signature rejections from legit Meta traffic = P2 mismatch).
- Validation window (2+ weeks) before Phase 3 (`DROP COLUMN facebook_page_id` on credentials + `unique_facebook_page` constraint + remove legacy `pageId` API fallbacks).
