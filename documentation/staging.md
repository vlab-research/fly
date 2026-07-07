# Staging Environment

## Overview

The staging environment runs in the `vstag` Kubernetes namespace on the same GKE cluster as production (`vprod`). It uses the same Helm chart (`devops/vlab`) with `devops/values/staging.yaml` as the values override.

## URLs

| Service | Staging URL | Production URL |
|---------|-------------|----------------|
| Frontend (Netlify) | `staging--vlab-research.netlify.app` | `fly.vlab.digital` |
| Dashboard API (K8s) | `staging.fly-dashboard-api.vlab.digital` | `fly-dashboard-api.vlab.digital` |
| Botserver (K8s) | `staging.fly-botserver.vlab.digital` | `fly-botserver.vlab.digital` |
| Linksniffer (K8s) | `staging.links.vlab.digital` | `links.vlab.digital` |

### DNS

All staging DNS records are CNAMEs to `vlab-cluster.vlab.digital` (the GKE ingress IP), managed in the Netlify DNS zone for `vlab.digital`. The frontend uses Netlify's auto-generated branch deploy URL (`staging--vlab-research.netlify.app`) because the Netlify account is on the Starter plan, which doesn't support branch subdomains.

### Netlify

- **Site**: `vlab-research` (ID: `57803b4c-bd0a-4650-985e-e24f8c496bb0`)
- **Production branch**: `main` → `fly.vlab.digital`
- **Staging branch**: `staging` → `staging--vlab-research.netlify.app`
- **Build config**: base `dashboard-client/`, command `npm run build`, publish `dashboard-client/build/`

## Auth0

Staging uses a **separate Auth0 tenant** from production:

| | Staging | Production |
|---|---------|-----------|
| Tenant | `virtuallab-staging.auth0.com` | `nandan.auth0.com` |
| SPA Client ID | `St54iAeLTaIn2OQBNnV9vshbH7art6eu` | `xgbYS1u1SevxmMmK8IuN9sugp6GH6qHf` |

### Auth0 SPA app settings (staging)

| Setting | Value |
|---------|-------|
| Application Login URI | `https://staging--vlab-research.netlify.app` |
| Allowed Callback URLs | `https://staging--vlab-research.netlify.app/auth` |
| Allowed Web Origins | `https://staging--vlab-research.netlify.app` |
| Allowed Logout URLs | `https://staging--vlab-research.netlify.app` |
| Allowed Origins (CORS) | `https://staging--vlab-research.netlify.app` |

### Server-to-server JWT (HS256)

The `AUTH0_DASHBOARD_SECRET` is **not from Auth0** — it's a homegrown HS256 shared secret used for internal service JWT signing and the `/auth/api-token` endpoint. Despite the `AUTH0_` prefix, this has been homegrown since June 2020 (commit `b179756`). Staging uses its own random secret.

## Kubernetes Secrets

### `gbv-bot-envs` (staging)

Created from `replybot/.env-staging` via:
```bash
cd devops && bash accounts.sh vstag ../replybot/.env-staging
```

Contains 13 keys:
- `VERIFY_TOKEN` — Facebook webhook verification
- `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` — Facebook test app credentials
- `AUTH0_HOST` / `AUTH0_CLIENT_ID` — staging Auth0 tenant
- `AUTH0_DASHBOARD_SECRET` / `AUTH0_DASHBOARD_CLIENT_ID` / `AUTH0_DASHBOARD_ID` — homegrown HS256 config
- `TYPEFORM_CLIENT_ID` / `TYPEFORM_CLIENT_SECRET` / `TYPEFORM_KEY` — Typeform OAuth (shared with prod)
- `RELOADLY_ID` / `RELOADLY_SECRET` — Reloadly API (shared with prod)

### `exporter` (staging)

Created manually (no script). Contains:
- `DATABASE_URL`, `STORAGE_BACKEND`, `S3_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_HOST`, `S3_SECRET_KEY`, `S3_SSL_ENABLED`

Kafka config (`KAFKA_BROKERS`, `KAFKA_TOPIC`, `KAFKA_GROUP_ID`) is set in `staging.yaml` `exporter.env` block, not the secret.

### `gbv-redis` (staging)

Contains `redis-password`.

## Facebook Test App

- **App ID**: `790352681363186` (https://developers.facebook.com/apps/790352681363186/webhooks/)
- **Webhook Callback URL**: `https://staging.fly-botserver.vlab.digital/webhooks`
- **Verify Token**: `heirloom hammock kickstarter selfies`
- **Valid OAuth Redirect URIs**: `https://staging--vlab-research.netlify.app`

Page access tokens are **not env vars** — they're stored per-page in the `credentials` table after a researcher connects their Facebook Page through the dashboard OAuth flow.

## Typeform

Single shared OAuth client across all environments. Only the redirect URL differs:
- **Staging redirect**: `https://staging--vlab-research.netlify.app/surveys/auth`
- **Production redirect**: `https://fly.vlab.digital/surveys/auth`

## Deploying

```bash
# Apply K8s secret (idempotent)
cd devops && bash accounts.sh vstag ../replybot/.env-staging

# Helm upgrade
cd devops && helm upgrade gbv vlab -f values/staging.yaml -n vstag

# Restart pods to pick up secret changes
kubectl rollout restart deployment/gbv-replybot deployment/gbv-botserver deployment/gbv-dashboard deployment/gbv-dinersclub -n vstag
```

The frontend deploys automatically via Netlify's Git integration on push to the `staging` branch.

## Known Issues

- **`checkSession` fails**: Auth0's silent renewal uses a hidden iframe, which fails with `login_required` when third-party cookies are blocked (default in modern browsers). Workaround: tokens are persisted in `sessionStorage` and restored on page reload. The return URL is saved before redirecting to login so OAuth flows (e.g. Typeform) survive the re-login.
- **Graph API version mismatch**: `netlify.toml` uses `REACT_APP_FACEBOOK_GRAPH_VERSION=25.0` (browser SDK), `staging.yaml` uses `FACEBOOK_GRAPH_URL=https://graph.facebook.com/v25.0` (server-side). Both are v25.0 now but the browser and server use different mechanisms.
