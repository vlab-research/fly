# Alert overview + phone push — Karma + ntfy (with Google auth)

> **Goal.** Two things Slack `#vlab-alerts` doesn't give us:
> 1. **At-a-glance overview** of *all* live alerts (so chronic/recurring alerts
>    collapse instead of drowning the channel) → **Karma**.
> 2. **Phone push** on new/changed alerts → **ntfy** (OSS, self-hosted, native
>    iOS/Android apps).
>
> Both fully OSS, self-hosted. No SaaS pager (Grafana OnCall OSS is archived as of
> 2026-03-24 and its mobile push is dead). This plan leans on infra we already run.
>
> **Related:** `documentation/alerting.md`, `MONITORING_STACK.md`.

---

## 0. Grounding — what we already have

| Fact | Value | Source |
|---|---|---|
| Ingress controller | **nginx** (`ingressClassName: nginx`) | `devops/minio/ingress.yaml` |
| TLS | cert-manager **`letsencrypt-prod`** ClusterIssuer, http01/nginx | `devops/clusterissuer.yaml` |
| Domain | **`vlab.digital`** (prod), `staging.*.vlab.digital` (staging) | ingress hosts |
| Identity provider | **Auth0** tenant (dashboard-client uses it as a SPA) | `dashboard-client/README.md`, `.env-dev` |
| Monitoring stack | Prometheus/AlertManager/Grafana singleton in `monitoring` ns, **no ingress** (port-forward only) | `documentation/alerting.md` §7 |
| oauth2-proxy | **Does not exist yet** — net-new | repo grep |

New public hosts this plan introduces (need DNS A-records → nginx ingress LB IP):
- **`alerts.vlab.digital`** → Karma (browser UI, behind Google auth)
- **`ntfy.vlab.digital`** → ntfy (publish + subscribe API + web UI, ntfy-native auth)

---

## 1. The authentication problem — think it through first

This is the crux, because **the two services need *different* auth** and mixing
them up is the classic mistake.

### 1a. Why they differ

| Service | Who talks to it | Auth that fits |
|---|---|---|
| **Karma** | **Browsers only** (you, on laptop/phone) | Interactive OIDC via **oauth2-proxy** → Google. Perfect fit. |
| **ntfy** | **AlertManager** (machine, publishes) **+ the ntfy phone app** (subscribes to a streaming endpoint) **+** occasionally a browser | **ntfy's own token/user auth.** oauth2-proxy **cannot** cover this. |

Karma has **no built-in auth** → we put an auth proxy in front. Standard, clean.

ntfy is the trap: an OAuth2 cookie proxy in front of ntfy would **break the phone
app** (it can't do the interactive browser login dance against a streaming
subscribe endpoint) **and** break AlertManager's machine-to-machine publish. ntfy
already ships a full auth system (users, access tokens, per-topic ACLs) built for
exactly these non-browser clients. **So ntfy uses ntfy-native auth, not
oauth2-proxy.** We just give it TLS + a private topic + tokens.

> Rejected alternative for ntfy: public `ntfy.sh` with a random topic and no auth.
> Rejected because our alerts carry sensitive study/user data (user IDs, survey
> error detail). We self-host with token auth.

### 1b. Karma auth — recommended: oauth2-proxy → **Auth0 (OIDC)** with Google social login

You asked for **Google login**, and said **Auth0 is available if it helps**. The
recommended path gives you both: oauth2-proxy speaks OIDC to **Auth0**, and Auth0's
Universal Login shows the **"Sign in with Google"** button. Net result: you click
Google, Auth0 brokers it, oauth2-proxy sets the session cookie, nginx lets you into
Karma.

```
Browser ──► alerts.vlab.digital (nginx ingress)
              │  nginx external-auth annotations
              ▼
          oauth2-proxy ──(OIDC code flow)──► Auth0 Universal Login
              │                                   │ "Sign in with Google"
              │                                   ▼
              │                                 Google
              ▼
   cookie OK → proxy to Karma (monitoring ns) ──► AlertManager (in-cluster)
```

**Why Auth0-brokered over talking to Google directly:**
- Reuses the identity system we already run — one place to manage *who* has access
  (Auth0 users / allowlist / Actions), consistent with the dashboard.
- Team members aren't all on one Google Workspace domain (your login is a personal
  gmail), so a simple `--email-domain=` restriction wouldn't work anyway; Auth0
  gives a clean allowlist UI.
- Still literally "log in via Google."

**Lighter alternative (documented, not recommended):** oauth2-proxy → **Google
OIDC directly** (a new Google Cloud OAuth client), access gated by an
`--authenticated-emails-file` allowlist. One fewer hop, but a *second* identity
integration to maintain outside Auth0. Pick this only if you want to avoid touching
Auth0 at all. **← DECISION TO CONFIRM (see §8).**

**Important:** the dashboard's existing Auth0 app is a **SPA** (public client,
Bearer tokens). oauth2-proxy needs a **Regular Web Application** (confidential
client with a *client secret*, server-side code flow). → **create a new Auth0
Application**, do not reuse the dashboard's client ID.

### 1c. ntfy auth — ntfy-native tokens + private topic ACL

- Run ntfy with `auth-file` (SQLite) + `auth-default-access: deny-all`.
- One reserved private topic, e.g. **`vlab-alerts`**.
- **Publish token** for AlertManager (write-only on `vlab-alerts`).
- **User/token for your phone** (read on `vlab-alerts`) — entered once in the app.
- TLS via the same cert-manager pattern. No oauth2-proxy on this host.

---

## 2. Component layout (follows repo conventions)

All three land in the **`monitoring`** namespace (Karma/oauth2-proxy need to reach
AlertManager in-cluster; keeps the alerting stack together). Repo layout mirrors
existing `devops/<service>/` style (plain manifests like `minio`, or a small Helm
chart like `devops/alerts` — either is fine; manifests are simpler here):

```
devops/
  karma/            # Deployment + Service + Ingress + karma config
  oauth2-proxy/     # Deployment + Service + Ingress (/oauth2 path) + secret refs
  ntfy/             # Deployment + Service + Ingress + PVC (auth db + cache) + config
```

### 2a. Karma
- Image: `ghcr.io/prymitive/karma` (pin a version tag).
- Config `ALERTMANAGER_URI` → the in-cluster AlertManager service.
  **Confirm exact name:** `kubectl -n monitoring get svc | grep -i alertmanager`
  (kube-prometheus-stack usually exposes `<release>-kube-prometheus-...-alertmanager`
  and the headless `alertmanager-operated:9093`).
- Single replica; stateless. Optionally set Karma read-only if we don't want silence
  management from the board (recommended read-only to start).

### 2b. oauth2-proxy
- Image: `quay.io/oauth2-proxy/oauth2-proxy` (pin a version).
- Provider `oidc`, `--oidc-issuer-url=https://<AUTH0_DOMAIN>/`.
- Its ingress owns the `/oauth2` path on `alerts.vlab.digital`; Karma's ingress
  carries the nginx external-auth annotations:
  ```
  nginx.ingress.kubernetes.io/auth-url:    "http://oauth2-proxy.monitoring.svc.cluster.local:4180/oauth2/auth"
  nginx.ingress.kubernetes.io/auth-signin: "https://alerts.vlab.digital/oauth2/start?rd=$escaped_request_uri"
  ```
- Cookie session (no Redis needed at single-user scale); needs a random
  `cookie-secret`.

### 2c. ntfy
- Image: `binwiederhier/ntfy` (pin a version).
- Small PVC for `/var/lib/ntfy` (auth db + message cache).
- `base-url: https://ntfy.vlab.digital`, `behind-proxy: true`, `auth-file`,
  `auth-default-access: deny-all`.

---

## 3. Networking / DNS / TLS

1. Add DNS A-records: `alerts.vlab.digital` and `ntfy.vlab.digital` → the nginx
   ingress controller's external LB IP (same IP the other `*.vlab.digital` hosts
   resolve to — confirm with `kubectl get svc -n <ingress-ns>`).
2. Ingresses use `cert-manager.io/cluster-issuer: letsencrypt-prod` + a `tls:`
   block with a per-host secret (`karma-tls`, `ntfy-tls`) — copy the exact shape
   from `devops/minio/ingress.yaml`.
3. ntfy ingress needs streaming-friendly annotations (disable buffering / long
   read timeout) so the subscribe connection stays open:
   ```
   nginx.ingress.kubernetes.io/proxy-read-timeout:  "3600"
   nginx.ingress.kubernetes.io/proxy-send-timeout:  "3600"
   nginx.ingress.kubernetes.io/proxy-buffering:     "off"
   ```

---

## 4. AlertManager wiring (ntfy receiver alongside Slack)

Add a webhook receiver to `devops/alertmanager/alertmanager.yaml` **without
removing Slack** — ntfy is additive. ntfy accepts a generic webhook or (nicer) a
templated publish. Two shapes:

- **Simple:** AlertManager `webhook_configs` → `https://ntfy.vlab.digital/vlab-alerts`
  with an `Authorization: Bearer <publish-token>` header (via
  `http_config.authorization`). Body is AlertManager's JSON; ntfy shows it raw.
- **Nicer:** a tiny templated title/priority using ntfy's `X-Title`/`X-Priority`
  headers so criticals push with high priority. Can iterate after the simple
  version works.

Route: mirror the existing Slack route (all alerts, or `severity=critical`
first to keep phone noise down — recommend **critical → phone**, everything still
to Slack + Karma). Note the config is currently **GATED** per `alerting.md` §2;
this change should ride the same review/cutover discipline (`CUTOVER.md`).

---

## 5. Secrets required (none committed)

| Secret | For | How obtained |
|---|---|---|
| Auth0 **client secret** (new Regular Web App) | oauth2-proxy | Auth0 dashboard → new Application |
| oauth2-proxy **cookie-secret** | oauth2-proxy | `openssl rand -base64 32` |
| ntfy **publish token** | AlertManager → ntfy | `ntfy token add <user>` (write on topic) |
| ntfy **subscribe user/token** | phone app | `ntfy user add` + token |

Stored as k8s Secrets in `monitoring`, referenced by env — same pattern as the rest
of the stack. **Nothing secret goes in Git** (consistent with `alertmanager.yaml`
being secret-free).

Auth0 app config to set:
- **Allowed Callback URL:** `https://alerts.vlab.digital/oauth2/callback`
- **Allowed Logout URL:** `https://alerts.vlab.digital`
- Ensure the **Google social connection** is enabled on this application.
- Restrict access: Auth0 Action/Rule allowlist, or oauth2-proxy
  `--authenticated-emails-file`.

---

## 6. Phone setup (one-time)
1. Install **ntfy** app (iOS/Android).
2. Add subscription → server `https://ntfy.vlab.digital`, topic `vlab-alerts`,
   sign in with the subscribe user/token.
3. Test: `curl -H "Authorization: Bearer <token>" -d "test" https://ntfy.vlab.digital/vlab-alerts`
   → push should land on the phone.

---

## 7. Implementation phases

- **Phase 0 — Decisions.** Confirm §8 (Auth0-brokered vs direct-Google; which
  alerts push to phone; read-only Karma). *(blocks the rest)*
- **Phase 1 — ntfy first (independent, high value).** Deploy ntfy + ingress +
  auth, wire the AlertManager webhook receiver, verify phone push end-to-end.
  Delivers the "buzz my phone" win on its own.
- **Phase 2 — Karma + auth.** Deploy Karma, oauth2-proxy, Auth0 app, ingresses;
  verify Google login → board loads → alerts render.
- **Phase 3 — Polish.** ntfy title/priority templating; Karma read-only + grouping
  config; optional teammate allowlist.
- **Phase 4 — Docs (mandatory, per CLAUDE.md).** Update `documentation/alerting.md`
  (new §: "Alert overview + phone push") and add `devops/karma/README.md`,
  `devops/ntfy/README.md`. Do NOT skip — this is the doc-update pass.

Suggested worktree per CLAUDE.md (running/deploying code):
`git worktree add ../fly-alerting-ui -b feature/alerting-ui`.

## 8. Decisions — LOCKED
1. **Karma auth broker:** ✅ **Auth0-brokered Google** (oauth2-proxy → Auth0 OIDC →
   "Sign in with Google"). New Auth0 **Regular Web App** (not the dashboard SPA).
2. **Phone experience — two mechanisms:**
   - ✅ **See everything on phone** = **Karma** in the phone browser (all active
     alerts, always available, behind Google login). This is the "even without
     push" requirement.
   - ✅ **Push (ntfy)** = **`severity=critical` only** — keeps the phone quiet;
     nothing is hidden because Karma shows the full set.
3. **Karma silences:** ✅ **read-only** board to start.
4. **ntfy hosting:** ✅ self-hosted `ntfy.vlab.digital` (sensitive data).

*(Open only if you change your mind: whether non-critical alerts should also push.)*

## 9. Rollback
Each piece is additive and independent. Remove an Ingress/Deployment to back out;
Slack routing is untouched, so alerting keeps working throughout. The
AlertManager change is one added receiver/route — revert that block to drop ntfy.
