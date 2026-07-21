# AlertManager Configuration

**Version-controlled AlertManager config** with severity routing, dead-man's switch, and multi-receiver support. Replaces the generated secret with a reproducible Git-managed configuration.

---

## Design Overview

### Routing Model

```
All Alerts
    │
    ├─ Watchdog (liveness) ──────────────────► deadmans-switch (heartbeat)
    │
    ├─ severity=critical ───────┬───────────► page (PagerDuty)
    │                            └───────────► slack-critical (#vlab-alerts-critical)
    │
    ├─ severity=warning ────────────────────► slack (#vlab-alerts)
    │
    └─ default / FYI ───────────────────────► fyi (email)
```

### Key Features

1. **Severity-based routing**
   - `critical` → PagerDuty **AND** Slack #vlab-alerts-critical (1h repeat)
   - `warning` → Slack #vlab-alerts (12h repeat, preserves current behavior)
   - `info` / no severity → email (24h repeat)

2. **Dead-man's switch**
   - Routes the always-firing `Watchdog` alert to an external heartbeat
   - Silence = monitoring stack is down → external monitor pages
   - Check-in every ~1-2 minutes

3. **Intelligent grouping**
   - `group_by: [alertname, env, consumergroup, survey]`
   - Batch related alerts (e.g., all `KafkaConsumerStuck` for `survey=ourworld`)
   - Different timing per severity:
     - **critical**: 10s wait, 2m interval (fast response)
     - **warning**: 30s wait, 5m interval (current behavior)
     - **fyi**: 30s wait, 5m interval, 24h repeat

4. **Inhibition rules**
   - Platform-wide critical (e.g., `KafkaOfflinePartitions`) mutes per-survey warnings
   - Critical broker issues mute consumer-lag warnings
   - Reduces noise when root cause is already firing

5. **Secret management**
   - All sensitive data via `*_file` references → mounted k8s secret
   - No hardcoded webhooks/keys in Git
   - Separation: config (Git) vs. secrets (k8s secret)

---

## Secrets Required

The following secrets must be provisioned **before** applying this config. All are mounted to AlertManager via `alertmanagerSpec.secrets` in Helm values.

### 1. Slack Webhooks (already have one)

**Existing:** `#vlab-alerts` webhook  
**Current value:** `https://hooks.slack.com/services/REDACTED` (in live cluster secret)

**New:** `#vlab-alerts-critical` webhook (for critical alerts)

**How to create:**
1. In Slack, create channel `#vlab-alerts-critical`
2. Add Incoming Webhook integration → copy webhook URL
3. Store in k8s secret (see §Deployment below)

### 2. PagerDuty Routing Key

**What:** PagerDuty Events API v2 Integration Key (routes alerts to on-call rotation)

**How to create:**
1. In PagerDuty, create a new **Service** (e.g., "VLAB Production Alerts")
2. Add integration: **Events API v2**
3. Copy the **Integration Key** (32-char hex, e.g., `a1b2c3d4e5f6...`)
4. Store in k8s secret (see §Deployment)

**Doc:** https://support.pagerduty.com/docs/services-and-integrations#create-a-service

### 3. Dead-Man's Switch Heartbeat URL

**What:** A webhook that expects regular check-ins; alerts if silent

**Options:**
- **healthchecks.io** (free tier: 20 checks) → create a check, copy ping URL
- **PagerDuty Heartbeat** (if already using PagerDuty) → create heartbeat check
- **Cronitor** / **UptimeRobot** (alternatives)

**How to create (healthchecks.io example):**
1. Create account at https://healthchecks.io
2. Add Check → name: "VLAB Monitoring Heartbeat", period: 2 minutes, grace: 1 minute
3. Copy the **Ping URL** (e.g., `https://hc-ping.com/abcd1234-5678-90ef-...`)
4. Store in k8s secret

### 4. SMTP Credentials (for email receiver)

**What:** SMTP server + credentials for sending alert emails to `team@vlab-research.org`

**Placeholders in config:**
- `smtp_smarthost`: `smtp.example.com:587` (update with real host, e.g., `smtp.sendgrid.net:587`)
- `smtp_auth_username`: stored in secret
- `smtp_auth_password`: stored in secret

**How to provision:**
- If using **SendGrid**: create API key, use as password (username: `apikey`)
- If using **Gmail**: app-specific password (not recommended for prod; use SendGrid/SES)
- If using **AWS SES**: SMTP credentials from IAM

---

## Deployment

### Step 1: Create the k8s Secret

All secrets are consolidated into a **single secret** mounted to AlertManager.

Create `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/secret.yaml` (DO NOT commit this file; it's .gitignored):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: alertmanager-secrets
  namespace: monitoring
type: Opaque
stringData:
  # Slack webhooks
  slack-webhook: "https://hooks.slack.com/services/YOUR/EXISTING/WEBHOOK"  # EXISTING: copy from live cluster secret
  slack-critical-webhook: "https://hooks.slack.com/services/YOUR/CRITICAL/WEBHOOK"  # NEW: create #vlab-alerts-critical
  
  # PagerDuty routing key
  pagerduty-routing-key: "YOUR_PAGERDUTY_INTEGRATION_KEY_HERE"
  
  # Dead-man's switch heartbeat URL
  deadmans-switch-webhook: "https://hc-ping.com/YOUR_HEALTHCHECKS_UUID"
  
  # SMTP credentials
  smtp-username: "your-smtp-username"
  smtp-password: "your-smtp-password"
```

**Apply:**
```bash
kubectl apply -f /home/nandan/Documents/vlab-research/fly/devops/alertmanager/secret.yaml
```

**Note:** For production, consider using **External Secrets Operator** to pull from a secret manager (AWS Secrets Manager, Vault, etc.) instead of a static k8s secret.

### Step 2: Create the AlertManager ConfigMap

The `alertmanager.yaml` file is mounted as a ConfigMap (not a secret, since it contains no sensitive data — all secrets are `*_file` references).

```bash
kubectl create configmap alertmanager-config \
  -n monitoring \
  --from-file=alertmanager.yaml=/home/nandan/Documents/vlab-research/fly/devops/alertmanager/alertmanager.yaml \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Step 3: Update Helm Values

Modify `/home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml`:

**Current (generated secret):**
```yaml
alertmanager:
  enabled: true
  alertmanagerSpec:
    useExistingSecret: true
    configSecret: "alertmanager"
```

**New (ConfigMap + mounted secrets):**
```yaml
alertmanager:
  enabled: true
  alertmanagerSpec:
    # Use the version-controlled ConfigMap
    useExistingSecret: false
    configSecret: ""  # must be empty when using ConfigMap
    
    # Mount the config from ConfigMap
    configMaps:
      - alertmanager-config
    
    # Mount secrets for *_file references
    secrets:
      - alertmanager-secrets
    
    # Storage (unchanged)
    storage:
      volumeClaimTemplate:
        spec:
          accessModes:
          - ReadWriteOnce
          resources:
            requests:
              storage: 2Gi
```

**Note:** The kube-prometheus-stack chart mounts ConfigMaps to `/etc/alertmanager/configmaps/<name>/` and secrets to `/etc/alertmanager/secrets/<name>/`. Adjust the `*_file` paths in `alertmanager.yaml` to match:

```yaml
# In alertmanager.yaml, update paths:
api_url_file: '/etc/alertmanager/secrets/alertmanager-secrets/slack-webhook'
routing_key_file: '/etc/alertmanager/secrets/alertmanager-secrets/pagerduty-routing-key'
url_file: '/etc/alertmanager/secrets/alertmanager-secrets/deadmans-switch-webhook'
smtp_auth_username_file: '/etc/alertmanager/secrets/alertmanager-secrets/smtp-username'
smtp_auth_password_file: '/etc/alertmanager/secrets/alertmanager-secrets/smtp-password'
```

### Step 4: Upgrade Helm Release

**DRY RUN (validate first):**
```bash
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f /home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml \
  --dry-run --debug
```

**APPLY (DO NOT RUN until secrets are provisioned and validated):**
```bash
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f /home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml
```

**Verify:**
```bash
kubectl get pods -n monitoring | grep alertmanager
kubectl logs -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-0
```

---

## Validation

### Local Validation (amtool)

Use the Prometheus AlertManager CLI tool to validate the config **before** applying to the cluster.

**Install amtool:**
```bash
# Via Docker (no local install needed)
docker run --rm -v /home/nandan/Documents/vlab-research/fly/devops/alertmanager:/cfg \
  prom/alertmanager:latest amtool check-config /cfg/alertmanager.yaml
```

**Expected output:**
```
Checking '/cfg/alertmanager.yaml'  SUCCESS
Found:
 - global config
 - route
 - 0 inhibit rules
 - 5 receivers
 - 0 templates
```

### Routing Test

Simulate routing for representative label sets to prove each routes to the intended receiver.

**Test cases:**
```bash
# 1. Critical production alert → page + slack-critical
amtool config routes test --config.file=alertmanager.yaml \
  --tree \
  severity=critical env=production alertname=KafkaOfflinePartitions

# 2. Warning staging alert → slack
amtool config routes test --config.file=alertmanager.yaml \
  --tree \
  severity=warning env=staging alertname=KafkaConsumerStuck

# 3. Watchdog liveness → deadmans-switch
amtool config routes test --config.file=alertmanager.yaml \
  --tree \
  alertname=Watchdog

# 4. No severity (FYI) → fyi
amtool config routes test --config.file=alertmanager.yaml \
  --tree \
  env=production alertname=KubeJobFailed

# 5. Critical with consumergroup/survey → page + slack-critical
amtool config routes test --config.file=alertmanager.yaml \
  --tree \
  severity=critical env=production component=kafka-broker alertname=KafkaBrokerDiskSpaceCritical
```

**Run validation** (see §Validation Results below for output).

---

## Rollback

If the new config causes issues, rollback to the **generated secret** immediately:

**1. Revert Helm values:**
```yaml
alertmanager:
  enabled: true
  alertmanagerSpec:
    useExistingSecret: true
    configSecret: "alertmanager"  # back to generated secret
    storage: ...  # unchanged
```

**2. Re-upgrade:**
```bash
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f /home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml
```

**3. Verify:**
```bash
kubectl logs -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-0
```

The kube-prometheus-stack operator will regenerate the `alertmanager-prometheus-kube-prometheus-alertmanager-generated` secret with the original config.

---

## Migration Checklist

**PRE-DEPLOYMENT:**
- [ ] Create `#vlab-alerts-critical` Slack channel
- [ ] Generate Slack webhook for `#vlab-alerts-critical`
- [ ] Create PagerDuty service + Events API v2 integration → copy routing key
- [ ] Provision dead-man's switch heartbeat (healthchecks.io / PagerDuty)
- [ ] Configure SMTP credentials (SendGrid API key / SES credentials)
- [ ] Create `alertmanager-secrets` k8s secret with all values (§Deployment Step 1)
- [ ] Validate `alertmanager.yaml` with `amtool check-config` (§Validation)
- [ ] Test routing with `amtool config routes test` (§Validation)

**DEPLOYMENT:**
- [ ] Create ConfigMap from `alertmanager.yaml` (§Deployment Step 2)
- [ ] Update `devops/prometheus/values.yaml` with new `alertmanagerSpec` (§Deployment Step 3)
- [ ] Dry-run Helm upgrade (validate template rendering)
- [ ] Apply Helm upgrade (§Deployment Step 4)
- [ ] Verify AlertManager pod restarts successfully
- [ ] Check logs: `kubectl logs -n monitoring alertmanager-...-0`
- [ ] Port-forward AlertManager → verify UI shows routes: `http://localhost:19093/#/status`
- [ ] Trigger a test alert (e.g., scale a deployment to 0 → `ReplicasMismatch`) → verify routing

**POST-DEPLOYMENT:**
- [ ] Confirm `#vlab-alerts` still receives warnings (unchanged behavior)
- [ ] Confirm `#vlab-alerts-critical` receives critical alerts (new)
- [ ] Confirm dead-man's switch heartbeat is receiving Watchdog pings (healthchecks.io dashboard)
- [ ] Document any issues / learnings in this README
- [ ] Update `documentation/alerting.md` §2 with new routing model

---

## Secrets Summary

| Secret Type | Purpose | File Reference in Config | k8s Secret Key |
|-------------|---------|--------------------------|----------------|
| Slack #vlab-alerts webhook | Warning alerts (current) | `api_url_file: /etc/alertmanager/secrets/alertmanager-secrets/slack-webhook` | `slack-webhook` |
| Slack #vlab-alerts-critical webhook | Critical alerts (new) | `api_url_file: /etc/alertmanager/secrets/alertmanager-secrets/slack-critical-webhook` | `slack-critical-webhook` |
| PagerDuty routing key | Page on-call for critical | `routing_key_file: /etc/alertmanager/secrets/alertmanager-secrets/pagerduty-routing-key` | `pagerduty-routing-key` |
| Dead-man's switch URL | Heartbeat liveness check | `url_file: /etc/alertmanager/secrets/alertmanager-secrets/deadmans-switch-webhook` | `deadmans-switch-webhook` |
| SMTP username | Email alerts (FYI) | `smtp_auth_username_file: /etc/alertmanager/secrets/alertmanager-secrets/smtp-username` | `smtp-username` |
| SMTP password | Email alerts (FYI) | `smtp_auth_password_file: /etc/alertmanager/secrets/alertmanager-secrets/smtp-password` | `smtp-password` |

---

## File Paths

| File | Purpose |
|------|---------|
| `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/alertmanager.yaml` | Version-controlled AlertManager config (no secrets) |
| `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/README.md` | This document (design, deployment, validation) |
| `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/secret.yaml` | Template for k8s secret (DO NOT COMMIT; .gitignore this) |
| `/home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml` | Helm values (update `alertmanagerSpec`) |

---

## Next Steps

1. **Provision all secrets** (Slack, PagerDuty, heartbeat, SMTP) → see §Secrets Required
2. **Validate locally** with `amtool` → see §Validation
3. **Create k8s secret + ConfigMap** → see §Deployment Steps 1-2
4. **Update Helm values** (do NOT apply yet) → see §Deployment Step 3
5. **Dry-run Helm upgrade** to catch template errors
6. **Human review** of this README + config before live cutover
7. **Apply** after approval → see §Deployment Step 4

**DO NOT apply to the live cluster yet** — this is the alerting control plane. A bad config silently breaks ALL alerting.
