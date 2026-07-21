---
name: study-health
description: Assess platform + study health and return a structured verdict. Covers Prometheus alerts (Kafka broker + consumer + app health), AlertManager active alerts, CockroachDB error-state spike detection (per current_form, baseline-compared, PII-free), broker/consumer lag analysis, and synthesizes an overall status (green/degraded/critical) with actionable pointers. Returns JSON. Triggered by /study-health.
---

# Study Health Assessment

This skill runs an end-to-end health check across the cluster — **Prometheus + AlertManager + CockroachDB states** — and returns a **structured verdict** (JSON) identifying whether the platform or individual studies are degraded, and what actions to take.

## High-level overview

**What it checks:**
1. **Prometheus alerts** — currently-firing Kafka broker health (offline partitions, controller, under-replication, disk), consumer-lag drain SLOs, app health (`ReplyBotCrashing`).
2. **AlertManager** — the authoritative **active** (non-silenced) alert state from `/api/v2/alerts`.
3. **CockroachDB `states` table** — `ERROR`/`BLOCKED` counts by `current_form` for the last 1h and 24h, and a baseline-comparison spike detector (last-1h vs the form's prior-24h hourly average). PII-free: no owner emails in routine output.
4. **Multi-survey diagnosis** — if ≥3 surveys spike simultaneously = **platform regression** (page platform owner); if 1 survey = **study misconfiguration** (ticket to that owner).
5. **Kafka broker + consumer health** — summary of partition health, consumer lag seconds per group/topic, disk free %.

**Output:** JSON with sections for `platform_status` (green/degraded/critical), `broker_health`, `consumer_lag`, `error_anomalies`, and `verdict` (human-readable summary + actions).

## How to invoke

```bash
/study-health
```

The agent will:
1. Call the helper script at `.opencode/skills/study-health/study-health.sh`.
2. Parse the returned JSON.
3. Report the verdict to you.

## How it works (under the hood)

The script:
1. **Sets up port-forwards** on unique local ports:
   - `9190` → Prometheus (`monitoring` ns, `svc/prometheus-kube-prometheus-prometheus:9090`)
   - `9193` → AlertManager (`monitoring` ns, `svc/prometheus-kube-prometheus-alertmanager:9093`)
   - `26357` → CockroachDB (`vprod` ns, `svc/gbv-cockroachdb-public:26257`)

   (Uses a lock file to ensure only one set of forwards is active; other agents wait or reuse the existing forwards.)

2. **Queries Prometheus** (PromQL):
   - `ALERTS{alertstate="firing"}` — all firing alerts (names, labels, values).
   - `kafka:consumergroup_drain_seconds{...}` — consumer lag in seconds per (group_id, topic_name).
   - `kafka_controller_kafkacontroller_offlinepartitionscount`, `activecontrollercount`, `underreplicatedpartitions`.
   - `kubelet_volume_stats_available_bytes / kubelet_volume_stats_capacity_bytes` for Kafka PVCs (% free).

3. **Queries AlertManager** (`/api/v2/alerts`):
   - Returns all currently-firing, non-silenced alerts (JSON).

4. **Queries CockroachDB** (via kubectl port-forward + psql), READ-ONLY:
   - Context: `ERROR`/`BLOCKED` counts by `current_form` for the last 1h and 24h.
     Deliberately **no `surveys`/`users` join** — it fans out (a shortcode maps to
     many survey rows, inflating counts) and would pull owner-email PII into
     routine output. The listing is `form` + `state` + `count` only.
   - Spike detection: per form, compares the last-1h `ERROR`/`BLOCKED` count to
     that form's prior-24h hourly average. A form is **abnormal** only on a real
     spike (**≥5 recent AND >3× its baseline**) — merely having errors is normal
     background noise (users block the bot, dean retries) and must not page.

5. **Synthesizes verdict:**
   - **≥3 forms spiking simultaneously → `critical` / platform regression** (page).
   - **1–2 forms spiking → `degraded` / study-level** (ticket; resolve the owner as
     a targeted follow-up on the flagged `current_form`).
   - Broker offline/controller abnormal → `critical`; under-replication, low disk,
     or consumer drain over SLO → `degraded`.
   - Any datasource unreachable → `unknown` (never falsely reported `green`).
   - Otherwise → **green**.

6. **Tears down port-forwards** and exits.

## Interpreting the output

Example JSON (full details in the "Live sample" section below):

```json
{
  "timestamp": "2026-07-20T12:34:56Z",
  "platform_status": "green",
  "broker_health": {
    "offline_partitions": 0,
    "active_controller_count": 1,
    "under_replicated_partitions": 0,
    "kafka_pvc_free_percent": 78.5,
    "status": "healthy"
  },
  "consumer_lag": {
    "groups": [
      {
        "group_id": "replybot",
        "topic": "vlab-prod-incoming",
        "drain_seconds": 0,
        "drain_seconds_slo": 120,
        "status": "ok"
      }
    ]
  },
  "error_anomalies": {
    "abnormal_surveys": [],
    "abnormal_surveys_count": 0,
    "error_states_by_form_1h": [],
    "error_states_by_form_24h": [],
    "verdict": "no_anomalies",
    "unreachable": false
  },
  "firing_alerts": [],
  "verdict": {
    "status": "green",
    "summary": "Platform healthy — all brokers up, consumers draining, no error spikes.",
    "actions": []
  }
}
```

### Key fields:

- **`platform_status`:** `green` / `degraded` / `critical`.
- **`broker_health.status`:** `healthy` / `degraded` / `critical` (offline partitions = critical, under-replication = degraded).
- **`consumer_lag.groups[].drain_seconds`:** estimated seconds to clear the backlog. > SLO = alert.
- **`error_anomalies.abnormal_surveys_count`:** how many surveys are spiking. ≥3 = platform regression.
- **`firing_alerts`:** array of currently-firing Kafka/app alerts (from AlertManager).
- **`verdict.actions`:** suggested next steps (e.g., "investigate survey X", "check replybot logs", "expand Kafka PVC").

## Availability and fallbacks

- **Prometheus MCP preferred** — when available (after a Claude Code restart with mcp__prometheus configured), the script should prefer the MCP over curl + port-forward.
- **Fallback:** curl + port-forward (works today without MCP setup).
- **Database:** psql via kubectl port-forward (CockroachDB has no ingress; insecure connection from pod).
- **If any datasource is unreachable:** the script reports it clearly (e.g., "prometheus_unreachable": true) and skips that section rather than failing hard.

## Notes for engineers

### Port-forward collisions
This skill runs on **unique local ports** (9190, 9193, 26357) to avoid collisions with sibling agents (e.g., the triage-linear-tickets agent or other concurrent skills). The script uses a **lock file** (`/tmp/study-health-forwards.lock`) to serialize port-forward setup.

### Read-only only
All database queries are `SELECT` only. This tool does **not** mutate any state.

### Cluster assumptions
- Cluster: `gke_toixotoixo` (GKE).
- Monitoring: singleton stack in `monitoring` ns (Prometheus, AlertManager, Grafana).
- Apps: prod in `vprod` ns, staging in `vstag` ns.
- Kafka: one shared cluster in `default` ns; prod consumes `vlab-prod-*` topics, staging consumes `vlab-staging-*`.
- Database: CockroachDB `chatroach` in `vprod` ns, table `states` (analytics warehouse).

---

## Troubleshooting the skill

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| "prometheus_unreachable": true | Port-forward failed or Prometheus pod down | `kubectl -n monitoring get pods` — is `prometheus-*` running? |
| "alertmanager_unreachable": true | Port-forward failed or AlertManager pod down | `kubectl -n monitoring get pods` — is `alertmanager-*` running? |
| "database_unreachable": true | CockroachDB inaccessible or port-forward collision | `kubectl -n vprod get pods -l app=cockroachdb` — is it running? Check `ps aux \| grep kubectl` for stale forwards. |
| JSON parsing error | Script exited with corrupt output | Check `/tmp/study-health-<timestamp>.log` for stderr. |
| "error_anomalies" always empty | Table schema changed or queries timed out | Verify `states` table columns live (use `\d states` in psql). |

---

## References

- **Monitoring stack:** `documentation/MONITORING_STACK.md` + `documentation/alerting.md`.
- **Consumer-lag alerts:** `documentation/kafka-consumer-lag-alerting.md`.
- **Database schema:** triage-linear-tickets SKILL.md (§"Database access" + "What to look up").
- **Prometheus API:** https://prometheus.io/docs/prometheus/latest/querying/api/
- **AlertManager API:** https://prometheus.io/docs/alerting/latest/management_api/
