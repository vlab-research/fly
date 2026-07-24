# ntfy — self-hosted push notifications for critical alerts

OSS push server ([ntfy.sh](https://ntfy.sh)) so **critical** AlertManager alerts
buzz your phone. Runs in the `monitoring` namespace at `https://ntfy.vlab.digital`.
The ntfy phone app subscribes to topic **`vlab-alerts`**; AlertManager publishes to
it with a bearer token.

> **Overview vs. push.** ntfy is only the *push* half. To *see all* active alerts
> on your phone (not just criticals), open **Karma** at `alerts.vlab.digital` in the
> phone browser (see `devops/karma/`). Full design: `documentation/alerting.md`.

## Why ntfy uses its own auth (not oauth2-proxy)

Karma is behind oauth2-proxy/Google because it's a browser UI. ntfy is **not** —
its clients are the **phone app** (subscribes to a streaming endpoint) and
**AlertManager** (machine publish). Neither can do an interactive OIDC cookie flow,
so ntfy uses its **native** auth: users + tokens + per-topic ACLs, with
`auth-default-access: deny-all` (nothing is readable/writable unless granted).

## Files
- `ntfy.yaml` — ConfigMap (`server.yml`), PVC (auth db + cache), Deployment,
  Service.
- `ingress.yaml` — TLS (cert-manager `letsencrypt-prod`) + streaming annotations.

## Deploy

```bash
kubectl apply -f devops/ntfy/ntfy.yaml
kubectl apply -f devops/ntfy/ingress.yaml
# wait for the cert
kubectl -n monitoring get certificate ntfy-tls -w
```

## One-time auth setup (run against the pod)

`deny-all` means we must create users and grant topic access explicitly.

```bash
NTFY="kubectl -n monitoring exec deploy/ntfy -- ntfy"

# 1) Publisher for AlertManager — write-only on the topic, then a token.
$NTFY user add alerts                 # set any password (unused; we use a token)
$NTFY access alerts vlab-alerts write # write-only
$NTFY token add alerts                # prints tk_... -> this is NTFY_TOKEN

# 2) Subscriber for your phone — read-only on the topic.
$NTFY user add phone                  # set a password you'll type in the app
$NTFY access phone vlab-alerts read
```

Put the publisher token into the AlertManager secret:
`devops/alertmanager/secret.env` → `NTFY_TOKEN=tk_...`, then re-run
`devops/alertmanager/apply.sh` (it injects the token and hot-reloads AlertManager).
Criticals now publish to `vlab-alerts` via `template=alertmanager`.

## Phone app
1. Install **ntfy** (iOS/Android).
2. Add subscription → **Server** `https://ntfy.vlab.digital`, **Topic**
   `vlab-alerts`, sign in as user `phone`.
3. Test push:
   ```bash
   curl -H "Authorization: Bearer <NTFY_TOKEN>" \
        -H "X-Title: test" -d "hello from ntfy" \
        https://ntfy.vlab.digital/vlab-alerts
   ```

## Notes / fallback
- `template=alertmanager` is a **built-in** ntfy template (formats firing/resolved,
  title, priority). It needs a recent ntfy — this chart pins `v2.11.0`. If a
  deployed version lacks it, drop `?template=alertmanager` from the webhook URL in
  `devops/alertmanager/alertmanager.yaml` (payload shows as JSON) until upgraded.
- Only **criticals** push (by design — see `documentation/alerting.md`). Everything
  is still in Slack and Karma.
- The auth db + message cache live on the `ntfy-data` PVC; deleting it drops users
  and history.
