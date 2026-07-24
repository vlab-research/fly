# AlertManager routing

> **Reading/investigating alerts?** See `documentation/alerting.md` §7
> ("Connect → read → investigate alerts") for the agent runbook (AM v2 API,
> port-forwards, Karma) and §§3–6 for per-alert runbooks. This file is about the
> **routing config** and how to change it.

## Deployed state (live)

**Severity-based routing → Slack, plus phone push for criticals via ntfy.**

| Alert | Destination |
|---|---|
| `severity=critical` (e.g. `KubeProxyDown`, our `Platform*` rules) | **`#vlab-alerts-critical`** Slack **+ ntfy phone push** (topic `vlab-alerts`) |
| `severity=warning` / `info` (default) | **`#vlab-alerts`** Slack |
| `Watchdog` (heartbeat) | silenced (`null` receiver) |
| `KubeJobFailed` / `KubeJobNotCompleted` | silenced (replaced by cronjob-health rules) |

Slack channels are incoming webhooks in the same workspace. Criticals **also** post
to the self-hosted ntfy server (`ntfy.vlab.digital`) via a `webhook_configs` on the
`slack-critical` receiver (inline template → `🔴 FIRING: <alertname>`, priority 4).
See `devops/ntfy/README.md`. All receivers use `send_resolved: true`, so a firing
alert gets a green "resolved" follow-up.

### How it's wired

AlertManager (kube-prometheus-stack) reads its base config from the **`alertmanager`
secret** in the `monitoring` namespace (`useExistingSecret: true`, `configSecret:
"alertmanager"` in `devops/prometheus/values.yaml`). The operator regenerates the
mounted `alertmanager-…-generated` secret from it, and AlertManager hot-reloads —
**no helm upgrade needed** to change routing.

## Files

| File | Purpose |
|---|---|
| `alertmanager.yaml` | The live config, with `${SLACK_WEBHOOK_*}` + `${NTFY_TOKEN}` placeholders (no secrets) |
| `apply.sh` | Renders the webhooks/token in + validates (`amtool`) + updates the secret |
| `secret.env.template` | Copy to `secret.env` (gitignored): two Slack webhook URLs + the ntfy publish token |
| `alertmanager-full.yaml.example` | The fuller design (PagerDuty + email + dead-man's-switch) — **not deployed**; kept as a reference |

## Change / reproduce the config

```bash
cp devops/alertmanager/secret.env.template devops/alertmanager/secret.env
# fill in the two hooks.slack.com URLs, then:
devops/alertmanager/apply.sh          # validates, backs up, applies, hot-reloads
```
`apply.sh` writes `alertmanager.live-backup.yaml` (gitignored) first; roll back with
the command it prints.

## Phone push (live via ntfy)

Critical alerts now push to a phone: the `slack-critical` receiver has a
`webhook_configs` → self-hosted **ntfy** (`ntfy.vlab.digital`, topic `vlab-alerts`),
authenticated with a write-only bearer token injected as `${NTFY_TOKEN}` from
`secret.env`. Setup, tokens, and the phone app are documented in
`devops/ntfy/README.md`. The overview/state board is **Karma**
(`devops/karma/`, `alerts.vlab.digital`) — not a receiver, it *reads* AlertManager.

### Still not wired (future)
- **Dead-man's-switch:** route `Watchdog` to an external heartbeat (healthchecks.io)
  so *silence = monitoring is down*.
- **PagerDuty/email/escalation:** `alertmanager-full.yaml.example` shows the shape
  (on-call rotations/escalation are the one thing ntfy doesn't do).
