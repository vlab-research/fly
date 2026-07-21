# AlertManager Config Cutover Commands

**GATED DEPLOYMENT** — Do NOT execute until:
1. All secrets are provisioned (Slack, PagerDuty, heartbeat, SMTP)
2. Human review of config + validation results is complete
3. Cutover window is scheduled (low-traffic period)

---

## Prerequisites Checklist

Before running any commands:

- [ ] `#vlab-alerts-critical` Slack channel created
- [ ] `#vlab-alerts-critical` webhook created and copied
- [ ] PagerDuty service created (e.g., "VLAB Production Alerts")
- [ ] PagerDuty Events API v2 integration key copied
- [ ] healthchecks.io (or equivalent) heartbeat check created, ping URL copied
- [ ] SMTP credentials provisioned (SendGrid API key / AWS SES / Gmail app password)
- [ ] `secret.yaml` created from `secret.yaml.template` with **real values** (DO NOT COMMIT)
- [ ] Config validated locally with `amtool check-config` (see `VALIDATION.md`)
- [ ] Routing tests passed (see `VALIDATION.md`)

---

## Cutover Commands (UNEXECUTED)

### Step 1: Apply the Secrets

**Command:**
```bash
kubectl apply -f /home/nandan/Documents/vlab-research/fly/devops/alertmanager/secret.yaml
```

**Verify:**
```bash
kubectl get secret -n monitoring alertmanager-secrets
kubectl describe secret -n monitoring alertmanager-secrets
```

**Expected output:**
```
Name:         alertmanager-secrets
Namespace:    monitoring
...
Data
====
deadmans-switch-webhook:  XX bytes
pagerduty-routing-key:    XX bytes
slack-critical-webhook:   XX bytes
slack-webhook:            XX bytes
smtp-password:            XX bytes
smtp-username:            XX bytes
```

---

### Step 2: Create the ConfigMap

**Command:**
```bash
kubectl create configmap alertmanager-config \
  -n monitoring \
  --from-file=alertmanager.yaml=/home/nandan/Documents/vlab-research/fly/devops/alertmanager/alertmanager.yaml \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Verify:**
```bash
kubectl get configmap -n monitoring alertmanager-config
kubectl describe configmap -n monitoring alertmanager-config
```

**Expected output:**
```
Name:         alertmanager-config
Namespace:    monitoring
Data
====
alertmanager.yaml:
----
global:
  resolve_timeout: 5m
  ...
```

---

### Step 3: Update Helm Values (Manual Edit Required)

**File to edit:** `/home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml`

**Current section (lines 35-47):**
```yaml
alertmanager:
  enabled: true
  alertmanagerSpec:
    useExistingSecret: true
    configSecret: "alertmanager"
    storage:
      volumeClaimTemplate:
        spec:
          accessModes:
          - ReadWriteOnce
          resources:
            requests:
              storage: 2Gi
```

**Replace with:**
```yaml
alertmanager:
  enabled: true
  alertmanagerSpec:
    # Use version-controlled ConfigMap (not generated secret)
    useExistingSecret: false
    configSecret: ""
    
    # Mount the config from ConfigMap
    configMaps:
      - alertmanager-config
    
    # Mount secrets for *_file references
    secrets:
      - alertmanager-secrets
    
    # SMTP auth via env vars (email_configs doesn't support *_file)
    containers:
      - name: alertmanager
        env:
          - name: SMTP_AUTH_USERNAME
            valueFrom:
              secretKeyRef:
                name: alertmanager-secrets
                key: smtp-username
          - name: SMTP_AUTH_PASSWORD
            valueFrom:
              secretKeyRef:
                name: alertmanager-secrets
                key: smtp-password
    
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

**NOTE:** After editing, verify the file is valid YAML:
```bash
yq eval /home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml > /dev/null
# No output = valid YAML
```

---

### Step 4: Dry-Run Helm Upgrade

**Command:**
```bash
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f /home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml \
  --dry-run --debug | tee /tmp/alertmanager-helm-dryrun.yaml
```

**Review:**
- Check that `alertmanager-config` ConfigMap is referenced in the StatefulSet
- Check that `alertmanager-secrets` secret is mounted at `/etc/alertmanager/secrets/alertmanager-secrets/`
- Check that env vars `SMTP_AUTH_USERNAME` / `SMTP_AUTH_PASSWORD` are injected
- Look for errors in the output (template rendering failures, missing resources)

**If errors:** Fix the values file and re-run dry-run. **DO NOT proceed to Step 5 until dry-run is clean.**

---

### Step 5: Apply Helm Upgrade (LIVE CUTOVER)

**FINAL CHECKPOINT:**
- [ ] Dry-run passed (no errors)
- [ ] All secrets verified in cluster
- [ ] ConfigMap verified in cluster
- [ ] Human review complete
- [ ] Cutover window scheduled
- [ ] Team notified (alerting may be briefly disrupted during pod restart)

**Command:**
```bash
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f /home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml
```

**Expected output:**
```
Release "prometheus" has been upgraded. Happy Helming!
NAME: prometheus
LAST DEPLOYED: <timestamp>
NAMESPACE: monitoring
STATUS: deployed
...
```

---

### Step 6: Verify Deployment

**1. Check AlertManager pod restarts:**
```bash
kubectl get pods -n monitoring | grep alertmanager
# Expect: alertmanager-prometheus-kube-prometheus-alertmanager-0  2/2  Running
```

**2. Check pod logs for errors:**
```bash
kubectl logs -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-0 -c alertmanager --tail=100
```

**Expected:** No errors like `failed to load config`, `secret not found`, `webhook unreachable`  
**Look for:** `Completed loading of configuration file` or similar success message

**3. Port-forward AlertManager UI:**
```bash
kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-alertmanager 19093:9093
```

Visit: `http://localhost:19093/#/status`

**Check:**
- **Config** tab shows the new routing tree (critical → page + slack-critical, warning → slack, Watchdog → deadmans-switch)
- **Receivers** section lists: `page`, `slack-critical`, `slack`, `deadmans-switch`, `fyi`
- **Inhibition Rules** section shows 3 rules

**4. Verify active alerts are routing:**
```bash
# In AlertManager UI, click "Alerts" tab
# Confirm existing alerts (e.g., Watchdog) are firing and routed to correct receiver
```

**5. Check Slack channels:**
- [ ] `#vlab-alerts` still receives alerts (warnings, unchanged behavior)
- [ ] `#vlab-alerts-critical` receives critical alerts (NEW)

**6. Check dead-man's switch heartbeat:**
- Visit healthchecks.io dashboard (or PagerDuty heartbeat status)
- Confirm check-ins are arriving every ~1-2 minutes from Watchdog alert

---

## Rollback Commands (If Issues Occur)

If the new config causes problems (alerts not routing, pod crash-looping, etc.), **immediately rollback**:

### Rollback Step 1: Revert Helm Values

**Edit:** `/home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml`

**Revert to original (lines 35-47):**
```yaml
alertmanager:
  enabled: true
  alertmanagerSpec:
    useExistingSecret: true
    configSecret: "alertmanager"
    storage:
      volumeClaimTemplate:
        spec:
          accessModes:
          - ReadWriteOnce
          resources:
            requests:
              storage: 2Gi
```

### Rollback Step 2: Re-Upgrade Helm

**Command:**
```bash
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f /home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml
```

### Rollback Step 3: Verify

**Check pod restarts:**
```bash
kubectl get pods -n monitoring | grep alertmanager
```

**Check logs:**
```bash
kubectl logs -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-0 -c alertmanager --tail=50
```

**Check Slack:**
- Confirm `#vlab-alerts` is receiving alerts again (existing webhook should still work)

**What happens:**
- The kube-prometheus-stack operator regenerates the `alertmanager-prometheus-kube-prometheus-alertmanager-generated` secret with the original config
- AlertManager restarts with the old config (single `slack` receiver, flat routing)
- All alerts route to `#vlab-alerts` as before

---

## Post-Cutover Tasks

After successful cutover:

1. **Monitor for 24 hours:**
   - [ ] Confirm critical alerts route to PagerDuty + Slack critical
   - [ ] Confirm warnings route to `#vlab-alerts` (unchanged)
   - [ ] Confirm Watchdog heartbeat is stable (healthchecks.io)
   - [ ] Confirm no alert storms or misrouted alerts

2. **Update documentation:**
   - [ ] Update `documentation/alerting.md` §2 with new routing model (see below)
   - [ ] Document any issues / learnings in `CUTOVER.md` (this file)

3. **Clean up (optional):**
   - [ ] Delete the old generated secret (it's no longer used):
     ```bash
     kubectl delete secret -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-generated
     ```
   - [ ] Archive `secret.yaml` to a secure location (password manager / secret store), then delete from disk

---

## Documentation Update (Post-Cutover)

After successful cutover, update `documentation/alerting.md` §2 with this content:

```markdown
## 2. AlertManager → Slack + PagerDuty + Email

**Config:** Version-controlled in `devops/alertmanager/alertmanager.yaml` (mounted as ConfigMap).

**Routing model:**
- **Critical** (`severity=critical`) → **PagerDuty** (page on-call) **AND** **Slack #vlab-alerts-critical** (visibility)
  - Repeat interval: 1h (re-page if not resolved)
- **Warning** (`severity=warning`) → **Slack #vlab-alerts** (ticket, preserves original behavior)
  - Repeat interval: 12h
- **FYI** (no severity or `severity=info`) → **Email** (`team@vlab-research.org`)
  - Repeat interval: 24h
- **Watchdog** (always-firing liveness signal) → **Dead-man's switch** (external heartbeat monitor)
  - Check-in every ~1-2 minutes; external monitor pages if silent (monitoring stack is down)

**Inhibition rules:**
- Platform-wide critical alerts (e.g., `KafkaOfflinePartitions`) mute per-survey/component warnings
- Critical broker issues mute consumer-lag warnings
- Reduces noise when root cause is already firing

**Secrets:** All receiver credentials (Slack webhooks, PagerDuty routing key, heartbeat URL, SMTP) are stored in the `alertmanager-secrets` k8s secret (not in Git). Config references secrets via `*_file` paths.

**Deployment:** See `devops/alertmanager/README.md` for config design, secrets required, and deployment process.
```

---

## Secrets Summary (For Reference)

| Secret Key | Purpose | Where Used |
|------------|---------|------------|
| `slack-webhook` | `#vlab-alerts` webhook (warnings) | `slack` receiver |
| `slack-critical-webhook` | `#vlab-alerts-critical` webhook (critical) | `slack-critical` receiver |
| `pagerduty-routing-key` | PagerDuty Events API v2 integration key | `page` receiver |
| `deadmans-switch-webhook` | healthchecks.io / PagerDuty heartbeat URL | `deadmans-switch` receiver |
| `smtp-username` | SMTP auth username (SendGrid / SES) | env var `SMTP_AUTH_USERNAME` |
| `smtp-password` | SMTP auth password (SendGrid / SES) | env var `SMTP_AUTH_PASSWORD` |

---

## File Paths (For Reference)

| File | Purpose |
|------|---------|
| `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/alertmanager.yaml` | Version-controlled config (no secrets) |
| `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/README.md` | Design, deployment, validation |
| `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/VALIDATION.md` | amtool validation + routing test results |
| `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/CUTOVER.md` | This file (cutover + rollback commands) |
| `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/secret.yaml.template` | Template for k8s secret (copy → fill → apply) |
| `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/secret.yaml` | Real secret file (DO NOT COMMIT; .gitignored) |
| `/home/nandan/Documents/vlab-research/fly/devops/prometheus/values.yaml` | Helm values (update `alertmanagerSpec`) |

---

**END OF CUTOVER COMMANDS**

**DO NOT execute Step 5 (Apply Helm Upgrade) until all prerequisites are met and human review is complete.**
