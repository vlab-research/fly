# Staging Smoke Test Plan

## Goal

Enable end-to-end smoke testing against the staging environment (`vstag`), mirroring the existing production smoke test (`smoke-test/` + `smoke-echo/`) but targeting staging URLs, staging Facebook apps, and staging Kafka topics.

## Current state

The production smoke test is a manual, two-component system:
- **`smoke-test/deploy.py`** — deploys Typeform survey forms (form-a, form-b) that exercise logic jumps, Reloadly payments, thread-control handoff, stitches, and timeouts. Hardcoded to a production Typeform workspace and production FB app IDs.
- **`smoke-echo`** — a minimal Messenger app deployed to production (`fly-smoke-echo.vlab.digital`) that acts as the handoff partner. Hardcoded to production FB app ID `976665718578167` and Fly production app ID `699455733740842`.

Neither component has any staging support — no staging URLs, no environment parameterization, no `vstag` deployment.

## Plan

### Phase 1: Deploy smoke-echo to staging

**1.1 Create staging smoke-echo Kubernetes manifests**

Create `smoke-echo/kube-staging/` with modified copies of the existing `kube/` manifests:
- `deployment.yaml` — same image, but `FACEBOOK_GRAPH_URL` → `https://graph.facebook.com/v25.0` (match staging)
- `ingress.yaml` — host `staging.fly-smoke-echo.vlab.digital`, secret `staging-smoke-echo-cert`
- `service.yaml` — unchanged

**1.2 Create DNS record**

CNAME `staging.fly-smoke-echo.vlab.digital` → `vlab-cluster.vlab.digital` (via Netlify API, same as other staging ingresses).

**1.3 Create staging smoke-echo secret**

Create `smoke-echo/.env-staging` (gitignored) with:
- `FACEBOOK_APP_ID` — the new staging echo Facebook app ID (from Phase 2)
- `PAGE_ACCESS_TOKEN` — page token for the staging echo app
- `FACEBOOK_PAGE_ID` — same page as the staging Fly app (790352681363186's page)
- `FACEBOOK_APP_SECRET` — staging echo app secret
- `FACEBOOK_VERIFY_TOKEN` — a new verify token string
- `FLY_APP_ID` — `790352681363186` (the staging Fly test app ID)

Create the K8s secret:
```bash
kubectl -n vstag create secret generic smoke-echo-env --from-env-file=smoke-echo/.env-staging --dry-run=client -o yaml | kubectl apply -f -
```

**1.4 Deploy**

```bash
kubectl apply -f smoke-echo/kube-staging/ -n vstag
```

cert-manager will provision a TLS cert for `staging.fly-smoke-echo.vlab.digital` automatically.

### Phase 2: Create staging echo Facebook app

**2.1 Create a second Facebook test app**

Go to https://developers.facebook.com/ and create a new app (e.g. "Fly Staging Smoke Echo"). Leave it in Development Mode.

**2.2 Configure the app**

- Add Messenger to the app
- Connect it to the same Facebook Page used by the staging Fly test app (`790352681363186`)
- Subscribe webhook to `messages` and `messaging_handovers`
- Set webhook callback URL: `https://staging.fly-smoke-echo.vlab.digital/webhook`
- Set verify token: (your chosen string)
- Note down: App ID, Page Access Token, App Secret

**2.3 Add yourself as Tester/Admin**

Required for Development Mode apps to work with your Facebook account.

### Phase 3: Parameterize smoke-test for staging

**3.1 Add environment support to deploy.py**

Modify `smoke-test/deploy.py` to accept an `--env` flag (`prod` or `staging`):
- `--env prod` (default) → existing behavior (production form IDs in `.ids`)
- `--env staging` → writes to `.ids-staging`, uses staging form JSONs

**3.2 Create staging form JSONs**

Copy `form-a.json` → `form-a.staging.json` and `form-b.json` → `form-b.staging.json` with:
- `target_app_id` → staging echo app ID (from Phase 2)
- Any other environment-specific references updated

The Typeform workspace and token are **shared** between staging and production — no separate workspace needed. The same `TYPEFORM_TOKEN` in `smoke-test/.env` works for both.

**3.3 Deploy staging forms**

```bash
cd smoke-test
python3 deploy.py --env staging create both
```

This creates new forms in the same Typeform workspace and saves IDs to `.ids-staging`.

### Phase 4: Run the staging smoke test

**4.1 Verify all services are up**

```bash
kubectl get pods -n vstag --field-selector=status.phase=Running
curl -s https://staging.fly-botserver.vlab.digital/health
curl -s https://staging.fly-smoke-echo.vlab.digital/health
```

**4.2 Trigger the smoke test**

Send a message to the staging Facebook Page with `ref: form.flysmoke` (or whatever shortcode the staging forms use). The full flow should exercise:
- Message receipt (botserver → Kafka → replybot)
- Survey form loading (formcentral)
- Question flow (logic jumps, statements)
- Payment (dinersclub with `fake` provider or sandbox Reloadly)
- Thread handoff (Fly → smoke-echo → Fly)
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
- How to deploy smoke-echo to staging
- How to run the staging smoke test
- Staging form shortcodes and Typeform workspace

## File changes summary

| File | Action |
|------|--------|
| `smoke-echo/kube-staging/deployment.yaml` | New — staging deployment manifest |
| `smoke-echo/kube-staging/ingress.yaml` | New — staging ingress |
| `smoke-echo/kube-staging/service.yaml` | New — staging service |
| `smoke-echo/.env-staging` | New (gitignored) — staging FB credentials |
| `smoke-echo/.gitignore` | Update — add `.env-staging` |
| `smoke-test/deploy.py` | Modify — add `--env` flag |
| `smoke-test/form-a.staging.json` | New — staging form with staging echo app ID |
| `smoke-test/form-b.staging.json` | New — staging form B |
| `smoke-test/.ids-staging` | New (gitignored) — staging form IDs |
| `documentation/staging.md` | Update — document staging smoke test |

## Prerequisites (manual, outside the repo)

- [ ] Create staging echo Facebook app (Phase 2)
- [ ] Connect both staging FB apps (Fly + echo) to the same Facebook Page

## Estimation

- Phase 1 (code): ~1 hour
- Phase 2 (manual FB setup): ~30 min
- Phase 3 (code): ~1 hour
- Phase 4 (testing): ~30 min
- Phase 5 (docs): ~20 min
