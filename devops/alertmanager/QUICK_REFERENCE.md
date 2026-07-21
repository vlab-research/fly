# AlertManager Config Quick Reference

**Purpose:** Severity-based alert routing with dead-man's switch  
**Status:** Designed, validated, NOT YET APPLIED  
**Repo:** `devops/alertmanager/`

---

## Routing at a Glance

| Alert Type | Receiver(s) | Repeat Interval | Notes |
|------------|-------------|-----------------|-------|
| `severity=critical` | `page` (PagerDuty) + `slack-critical` (#vlab-alerts-critical) | 1h | Fast grouping (10s wait, 2m interval) |
| `severity=warning` | `slack` (#vlab-alerts) | 12h | Current behavior preserved |
| `alertname=Watchdog` | `deadmans-switch` (heartbeat) | 1m | Liveness signal; external monitor pages if silent |
| No severity / FYI | `fyi` (email) | 24h | Low-priority catch-all |

---

## Files

| File | Purpose |
|------|---------|
| `alertmanager.yaml` | Version-controlled config (no secrets) |
| `README.md` | Full design, deployment guide, secrets required |
| `VALIDATION.md` | `amtool` validation + routing test results |
| `CUTOVER.md` | Exact cutover + rollback commands (UNEXECUTED) |
| `secret.yaml.template` | Template for k8s secret (copy → fill → apply) |
| `QUICK_REFERENCE.md` | This file |

---

## Secrets Needed

1. **Slack #vlab-alerts webhook** — HAVE (current live webhook, preserved)
2. **Slack #vlab-alerts-critical webhook** — NEED (create channel + webhook)
3. **PagerDuty routing key** — NEED (Events API v2 integration key)
4. **Dead-man's switch URL** — NEED (healthchecks.io / PagerDuty heartbeat)
5. **SMTP credentials** — NEED (SendGrid API key / AWS SES)

---

## Validation Status

✅ Syntax: `amtool check-config` PASS  
✅ Routing: All test cases PASS (see `VALIDATION.md`)

| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| Critical production | `page` + `slack-critical` | `page,slack-critical` | ✅ |
| Warning staging | `slack` | `slack` | ✅ |
| Watchdog | `deadmans-switch` | `deadmans-switch` | ✅ |
| No severity | `fyi` | `fyi` | ✅ |
| Critical + component | `page` + `slack-critical` | `page,slack-critical` | ✅ |

---

## Cutover Prerequisites

- [ ] All secrets provisioned (see §Secrets Needed above)
- [ ] `secret.yaml` created from template with real values
- [ ] Human review of config + validation complete
- [ ] Cutover window scheduled (low-traffic period)
- [ ] Team notified (alerting briefly disrupted during pod restart)

**Then:** Follow steps in `CUTOVER.md` (kubectl apply secret → create configmap → edit values.yaml → helm upgrade)

---

## Rollback

Revert `devops/prometheus/values.yaml`:
```yaml
alertmanager:
  alertmanagerSpec:
    useExistingSecret: true
    configSecret: "alertmanager"
```

Run: `helm upgrade prometheus ...` → kube-prometheus-stack regenerates original flat config.

---

## Grouping

**Current (live):** `[alertname]`  
**New:** `[alertname, env, consumergroup, survey]`

More intelligent batching — related alerts (e.g., all `KafkaConsumerStuck` for `survey=ourworld`) grouped together.

---

## Inhibition Rules

1. Critical broker issue → mutes consumer-lag warnings (same env)
2. `KafkaOfflinePartitions` → mutes `KafkaUnderReplicatedPartitions` (same env)
3. Platform-wide critical (no survey/consumergroup) → mutes per-survey warnings (same env)

Reduces noise when root cause is already firing.

---

## Contact

See `README.md` for full deployment guide.  
See `VALIDATION.md` for full validation output.  
See `CUTOVER.md` for exact commands (GATED — do not run until approved).
