# AlertManager routing

## Deployed state (live)

**Slack-only, two-channel severity routing** — no PagerDuty/email/paging.

| Alert | Channel |
|---|---|
| `severity=critical` (e.g. `KubeProxyDown`, our `Platform*` rules) | **`#vlab-alerts-critical`** |
| `severity=warning` / `info` (default) | **`#vlab-alerts`** |
| `Watchdog` (heartbeat) | silenced (`null` receiver) |

Both channels are Slack incoming webhooks in the same workspace. All receivers
use `send_resolved: true`, so a firing alert gets a green "resolved" follow-up.

### How it's wired

AlertManager (kube-prometheus-stack) reads its base config from the **`alertmanager`
secret** in the `monitoring` namespace (`useExistingSecret: true`, `configSecret:
"alertmanager"` in `devops/prometheus/values.yaml`). The operator regenerates the
mounted `alertmanager-…-generated` secret from it, and AlertManager hot-reloads —
**no helm upgrade needed** to change routing.

## Files

| File | Purpose |
|---|---|
| `alertmanager.yaml` | The live config, with `${SLACK_WEBHOOK_*}` placeholders (no secrets) |
| `apply.sh` | Renders the webhooks in + validates (`amtool`) + updates the secret |
| `secret.env.template` | Copy to `secret.env` (gitignored), fill in the two webhook URLs |
| `alertmanager-full.yaml.example` | The fuller design (PagerDuty + email + dead-man's-switch) — **not deployed**; kept as a reference for adding paging |

## Change / reproduce the config

```bash
cp devops/alertmanager/secret.env.template devops/alertmanager/secret.env
# fill in the two hooks.slack.com URLs, then:
devops/alertmanager/apply.sh          # validates, backs up, applies, hot-reloads
```
`apply.sh` writes `alertmanager.live-backup.yaml` (gitignored) first; roll back with
the command it prints.

## Adding real paging later (no SaaS needed)

You are **not** getting paged today — critical alerts just land in a separate Slack
channel. To add an actual phone page, add an open-source push receiver and route
`severity=critical` to it as well (keep the Slack copy):

- **ntfy** (self-host or ntfy.sh): AlertManager `webhook_configs` → ntfy topic → phone push with priority.
- **Telegram bot**: AlertManager → Telegram → phone.

`alertmanager-full.yaml.example` shows the shape of a multi-receiver config
(swap its PagerDuty receiver for ntfy/Telegram). A dead-man's-switch (route
`Watchdog` to an external heartbeat like healthchecks.io so silence = monitoring
is down) is the other piece to add there.
