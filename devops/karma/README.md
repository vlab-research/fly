# Karma — alert overview board (behind Google/Auth0 login)

[Karma](https://github.com/prymitive/karma) gives an at-a-glance view of **all**
live AlertManager alerts at `https://alerts.vlab.digital` — the fix for "I can't
tell the state of things when several alerts are always firing in Slack." Works in
a phone browser too, so it's also how you **see everything on your phone** (ntfy
only *pushes* criticals; Karma *shows* all).

## Architecture

```
Browser ─► alerts.vlab.digital (nginx ingress)
   │  nginx auth_request ─► oauth2-proxy /oauth2/auth
   │        (no session) ─► /oauth2/start ─► Auth0 ─► "Sign in with Google" ─► Google
   ▼ (session OK)
 Karma ─► prometheus-kube-prometheus-alertmanager.monitoring:9093 (read-only)
```

- **Karma** (`karma.yaml`) — reads AlertManager in-cluster, `readonly: true`.
- **oauth2-proxy** (`../oauth2-proxy/oauth2-proxy.yaml`) — OIDC to **Auth0**
  (`https://virtuallab.auth0.com/`); Auth0's Universal Login shows the Google button.
  Access is gated by an **email allowlist** (`oauth2-proxy-emails` ConfigMap) — add
  teammates there.
- **Ingresses** (`ingress.yaml`) — two objects on `alerts.vlab.digital`:
  `/oauth2/*` → oauth2-proxy (open), `/` → Karma (auth-required).

## Prerequisites (you do these — outside the repo)

1. **DNS:** `alerts.vlab.digital` → nginx ingress LB IP. *(done)*
2. **Auth0 app:** a **Regular Web Application** (NOT the dashboard SPA). On it:
   - Enable the **Google** social connection.
   - **Allowed Callback URLs:** `https://alerts.vlab.digital/oauth2/callback`
   - **Allowed Logout URLs:** `https://alerts.vlab.digital`
   - Client ID + secret are in `devops/alerts/.env-karma` (gitignored).

## Deploy

```bash
# 1) oauth2-proxy secret: Auth0 creds (from .env-karma) + a generated cookie secret.
set -a; . devops/alerts/.env-karma; set +a
kubectl -n monitoring create secret generic oauth2-proxy \
  --from-literal=client-id="$AUTH0_CLIENT_ID" \
  --from-literal=client-secret="$AUTH0_CLIENT_SECRET" \
  --from-literal=cookie-secret="$(openssl rand -base64 32)"

# 2) Apply everything.
kubectl apply -f devops/oauth2-proxy/oauth2-proxy.yaml
kubectl apply -f devops/karma/karma.yaml
kubectl apply -f devops/karma/ingress.yaml

# 3) Wait for the TLS cert, then open https://alerts.vlab.digital
kubectl -n monitoring get certificate alerts-tls -w
```

## Verify
- Visit `https://alerts.vlab.digital` → redirected to Auth0 → "Sign in with Google"
  → back to the Karma board showing current alerts.
- An email **not** in the allowlist should be denied after Google login.

## Troubleshooting
- **Login loops / 400 at Auth0:** callback URL mismatch, or the app isn't a Regular
  Web App. Re-check the two Auth0 URLs above.
- **403 after Google login:** your email isn't in `oauth2-proxy-emails` — add it and
  `kubectl apply` + `kubectl -n monitoring rollout restart deploy/oauth2-proxy`.
- **502 from Karma:** confirm the AlertManager service name
  (`kubectl -n monitoring get svc | grep alertmanager`) matches `karma.yaml`.
- **Changing who has access:** edit the `oauth2-proxy-emails` ConfigMap.
