# AlertManager Config Validation Results

**Date:** 2026-07-20  
**Config:** `/home/nandan/Documents/vlab-research/fly/devops/alertmanager/alertmanager.yaml`  
**Tool:** `amtool` (via `prom/alertmanager:latest` Docker image)

---

## 1. Config Syntax Validation

**Command:**
```bash
docker run --rm --entrypoint amtool \
  -v /home/nandan/Documents/vlab-research/fly/devops/alertmanager:/cfg \
  prom/alertmanager:latest check-config /cfg/alertmanager.yaml
```

**Result:**
```
Checking '/cfg/alertmanager.yaml'  SUCCESS
Found:
 - global config
 - route
 - 3 inhibit rules
 - 5 receivers
 - 0 templates
```

**Status:** ✅ PASS — Config is syntactically valid

---

## 2. Routing Tests

Simulated routing for representative label sets to prove each routes to the intended receiver.

### Test 1: Critical Production Alert → PagerDuty + Slack Critical

**Labels:** `severity=critical`, `env=production`, `alertname=KafkaOfflinePartitions`

**Command:**
```bash
docker run --rm --entrypoint amtool \
  -v $(pwd):/cfg prom/alertmanager:latest \
  config routes test --config.file=/cfg/alertmanager.yaml --tree \
  severity=critical env=production alertname=KafkaOfflinePartitions
```

**Result:**
```
Matching routes:
.
└── default-route
    ├── {severity="critical"}  receiver: page
    └── {severity="critical"}  receiver: slack-critical


page,slack-critical
```

**Expected:** `page` (PagerDuty) + `slack-critical` (#vlab-alerts-critical)  
**Actual:** `page,slack-critical`  
**Status:** ✅ PASS

---

### Test 2: Warning Staging Alert → Slack #vlab-alerts

**Labels:** `severity=warning`, `env=staging`, `alertname=KafkaConsumerStuck`, `consumergroup=replybot`

**Command:**
```bash
docker run --rm --entrypoint amtool \
  -v $(pwd):/cfg prom/alertmanager:latest \
  config routes test --config.file=/cfg/alertmanager.yaml --tree \
  severity=warning env=staging alertname=KafkaConsumerStuck consumergroup=replybot
```

**Result:**
```
Matching routes:
.
└── default-route
    └── {severity="warning"}  receiver: slack


slack
```

**Expected:** `slack` (#vlab-alerts, preserves current behavior)  
**Actual:** `slack`  
**Status:** ✅ PASS

---

### Test 3: Watchdog (Dead-Man's Switch) → External Heartbeat

**Labels:** `alertname=Watchdog`

**Command:**
```bash
docker run --rm --entrypoint amtool \
  -v $(pwd):/cfg prom/alertmanager:latest \
  config routes test --config.file=/cfg/alertmanager.yaml --tree \
  alertname=Watchdog
```

**Result:**
```
Matching routes:
.
└── default-route
    └── {alertname="Watchdog"}  receiver: deadmans-switch


deadmans-switch
```

**Expected:** `deadmans-switch` (external heartbeat monitor)  
**Actual:** `deadmans-switch`  
**Status:** ✅ PASS

---

### Test 4: No Severity (FYI) → Email

**Labels:** `env=production`, `alertname=KubeJobFailed` (no `severity` label)

**Command:**
```bash
docker run --rm --entrypoint amtool \
  -v $(pwd):/cfg prom/alertmanager:latest \
  config routes test --config.file=/cfg/alertmanager.yaml --tree \
  env=production alertname=KubeJobFailed
```

**Result:**
```
Matching routes:
.
└── default-route  receiver: fyi


fyi
```

**Expected:** `fyi` (email, default for untagged alerts)  
**Actual:** `fyi`  
**Status:** ✅ PASS

---

### Test 5: Critical with Component Label → PagerDuty + Slack Critical

**Labels:** `severity=critical`, `env=production`, `component=kafka-broker`, `alertname=KafkaBrokerDiskSpaceCritical`

**Command:**
```bash
docker run --rm --entrypoint amtool \
  -v $(pwd):/cfg prom/alertmanager:latest \
  config routes test --config.file=/cfg/alertmanager.yaml --tree \
  severity=critical env=production component=kafka-broker alertname=KafkaBrokerDiskSpaceCritical
```

**Result:**
```
Matching routes:
.
└── default-route
    ├── {severity="critical"}  receiver: page
    └── {severity="critical"}  receiver: slack-critical


page,slack-critical
```

**Expected:** `page` (PagerDuty) + `slack-critical` (#vlab-alerts-critical)  
**Actual:** `page,slack-critical`  
**Status:** ✅ PASS

---

## Summary

| Test Case | Expected Receiver(s) | Actual Receiver(s) | Status |
|-----------|---------------------|-------------------|--------|
| Critical production alert | `page`, `slack-critical` | `page`, `slack-critical` | ✅ PASS |
| Warning staging alert | `slack` | `slack` | ✅ PASS |
| Watchdog (dead-man's switch) | `deadmans-switch` | `deadmans-switch` | ✅ PASS |
| No severity (FYI) | `fyi` | `fyi` | ✅ PASS |
| Critical with component | `page`, `slack-critical` | `page`, `slack-critical` | ✅ PASS |

**All routing tests PASSED.** The config correctly routes alerts based on severity and special cases (Watchdog).

---

## Notes

1. **Syntax validation:** Config is valid AlertManager YAML (no syntax errors).
2. **Routing logic:** All test cases route to the intended receivers:
   - Critical → PagerDuty + Slack critical channel (dual fanout)
   - Warning → Slack #vlab-alerts (preserves current behavior)
   - Watchdog → external heartbeat (dead-man's switch)
   - No severity → email (FYI)
3. **Inhibition rules:** Not tested by `amtool config routes test` (requires live AlertManager with active alerts). Manual verification needed post-deployment.
4. **Secrets:** All secrets are referenced via `*_file` (Slack, PagerDuty, heartbeat) or noted as env vars (SMTP). No secrets in Git.
5. **SMTP auth:** AlertManager `email_configs` doesn't support `auth_username_file` / `auth_password_file`. SMTP auth must be provisioned via Helm env vars (`alertmanagerSpec.containers.env`) or external secrets. Config is commented to note this.

---

## Next Steps

1. **Provision secrets** (see `README.md` §Secrets Required):
   - [ ] Create `#vlab-alerts-critical` Slack channel + webhook
   - [ ] Create PagerDuty service + Events API v2 integration → copy routing key
   - [ ] Create healthchecks.io check → copy ping URL
   - [ ] Provision SMTP credentials (SendGrid API key / AWS SES)
2. **Create k8s secret** from `secret.yaml.template` (fill in real values)
3. **Create ConfigMap** from `alertmanager.yaml`
4. **Update Helm values** (`devops/prometheus/values.yaml`)
5. **Dry-run Helm upgrade** (catch template errors)
6. **Human review** of config + secrets before live cutover
7. **Apply** to cluster (GATED — do NOT run until approved)

**Validation complete. Config is ready for deployment after secrets are provisioned.**
