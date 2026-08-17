# Kafka Consumer-Lag Alerting

> Alerting on the health of every Kafka consumer group across the shared
> cluster, for both production and staging. This doc is the **runbook** the
> alerts link to (`runbook_url`), plus the design and deploy reference.
>
> **Related:** `MONITORING_STACK.md` (whole observability stack),
> `documentation/platform-abstraction-hardening.md` (§6 operational readiness).

---

## 1. The shape of the problem (read first)

There is **one** of each of these, shared by prod and staging:

- **One Kafka cluster** — `kafka-headless.default.svc.cluster.local:29092`.
  Production consumes `vlab-prod-*` topics; staging consumes `vlab-staging-*`.
- **One Prometheus / AlertManager / Grafana** — all in the `monitoring`
  namespace. Prometheus watches **all** namespaces (`ruleSelector: {}`,
  `ruleNamespaceSelector: {}`).
- **One kminion** — scrapes the whole cluster (every consumer group, both envs).

Because the monitoring plane is a **singleton**, the alerting definition is a
singleton too: a **single `PrometheusRule` in the `monitoring` namespace**
covering every `(group, topic)` pair. `prod` vs `staging` is an `env`/`topic`
**label**, not a deployment boundary. This is why the rules do **not** live in
the per-env `devops/vlab` app umbrella — that would be arbitrary duplication of
a global thing and would couple alert changes to app deploys.

### The shared-group-id gotcha

Prod and staging **reuse the same consumer-group names** (`replybot`,
`scribble-*`, `dinersclub`) while consuming **different topics**. So every rule
is keyed on **BOTH `group_id` AND `topic_name`**. The old alerts used
`sum(kafka_consumergroup_lag_sum{consumergroup="replybot"})`, which summed prod
**and** staging lag together — a latent bug that topic-scoping fixes.

### Group-naming convention (for new groups)

`message-worker` is the exception and the **model to follow**: its groups are
**env-scoped** — `vlab-prod-message-worker` / `vlab-staging-message-worker` —
mirroring the `vlab-<env>-*` topic convention. New consumer groups must use the
env-scoped form, not the older bare name.

`message-worker` enforces this in code: `KAFKA_GROUP_ID` is **required with no
default** (`message-worker/config.go`). A bare fallback would let a deploy that
forgot the variable come up looking healthy while joining a group no rule in
`values.yaml` matches — silently unmonitored, on the sole outbound send path. It
fails at startup instead.

**Adding a group is two edits, always together:** set the env-scoped
`KAFKA_GROUP_ID` in `devops/values/<env>.yaml`, *and* add the matching row to
`devops/kafka-consumer-health/values.yaml`. A group without a row has no
alerting at all.

---

## 2. Components

| Piece | Where | What |
|---|---|---|
| **kminion** | `devops/kminion/` → Helm release `kminion` in `default` ns | Redpanda's actively-maintained Kafka exporter. Emits `kminion_kafka_consumer_group_topic_lag`, `..._topic_offset_sum`, `..._members`. ServiceMonitor in `monitoring`. |
| **kafka-exporter** | `devops/kafka-exporter/` (release `kafka-exporter`, `default` ns) | Legacy `danielqsj/kafka-exporter` (now pinned `v1.9.0`). Still feeds existing dashboards; **not** used by these alerts. |
| **kafka-consumer-health** | `devops/kafka-consumer-health/` → Helm release in `monitoring` ns | The single `PrometheusRule` with the recording rule + 3 alerts per group/topic. |
| **AlertManager** | `monitoring` ns, config in generated secret | Routes all alerts to Slack `#vlab-alerts` (`send_resolved: true`). Severity-based routing is **future work** — today everything hits the one channel. |

### Why kminion (not kafka-lag-exporter)

`kafka-lag-exporter` (seglo) has native lag-in-seconds but its repo has been
**archived / read-only since 2024-03-17**. kminion is maintained by Redpanda and
uniquely gives consumer-group **member/state** metrics. It has no native
lag-seconds, so we compute time-to-drain in PromQL (below).

---

## 3. The alerts

All three are **symptom-based** and topic-scoped. Defaults and per-group SLOs
live in `devops/kafka-consumer-health/values.yaml`.

### Recording rule — `kafka:consumergroup_drain_seconds`

```promql
kminion_kafka_consumer_group_topic_lag
/
clamp_min(rate(kminion_kafka_consumer_group_topic_offset_sum[5m]), 1)
```

Estimated seconds to clear the current backlog at the current consume rate. One
series per `(group_id, topic_name)`. `clamp_min(..., 1)` avoids divide-by-zero
when a group is fully stopped.

### KafkaConsumerStuck

**Means:** the committed offset has not advanced for `stuckWindow` (10m) **while
a backlog remains** — the consumer is *wedged* (poison message, deadlock,
rebalance loop). This is **not** the same as high-but-moving lag, and a plain
count-threshold can miss it entirely at low throughput.

```promql
(rate(kminion_kafka_consumer_group_topic_offset_sum{group_id="X", topic_name="T"}[10m]) == 0)
and
(kminion_kafka_consumer_group_topic_lag{group_id="X", topic_name="T"} > 0)
```

**Runbook:**
1. Find the consumer pods: `kubectl -n <vprod|vstag> get pods -l app.kubernetes.io/name=<group>` (for scribble, the sink deployment; for `replybot`/`dinersclub`/`message-worker`, the named deployment).
2. Check logs for a stuck loop / repeated error / crash: `kubectl -n <ns> logs <pod> --tail=200`.
3. Check for a rebalance storm or a poison message (same offset retried). For scribble, `SCRIBBLE_STRICT_MODE=true` sinks (e.g. `scribble-messages`) will halt on a bad record.
4. Remediate: fix/skip the bad record, or `kubectl -n <ns> rollout restart deploy/<consumer>` to force a clean rejoin.
5. Confirm the offset advances: watch `kafka:consumergroup_drain_seconds` fall.

> **Check the restart count in step 1.** A consumer restarting on a near-exact
> 5-minute cycle is a *specific* failure with a specific cause, and a rollout
> restart will not fix it — it just starts the loop over.
>
> Every Go consumer here builds on `spine`, which hardcodes
> `max.poll.interval.ms = 300000` with `enable.auto.commit = false`. If one
> batch takes longer than 300s, Kafka evicts the consumer, the in-flight batch
> is **never committed**, the process dies, and the restarted pod re-reads the
> identical messages and hangs again — zero progress, forever. The tell in the
> logs is `MAXPOLL ... leaving group` followed by
> `Local: Group partition assignment lost`.
>
> The cause is almost always an **unbounded outbound call** — a provider or API
> with no HTTP timeout. Note that a retry/backoff budget does *not* bound this:
> `backoff.Retry` checks `MaxElapsedTime` only between attempts, so one hung
> attempt runs as long as it likes. Fix the timeout, not the alert.
>
> This is what took `dinersclub` down on 2026-08-17 (Reloadly stopped answering
> mid-payout-burst; `go-reloadly` ships `http.DefaultClient`, no timeout). See
> `dinersclub/README.md` → "Provider call hangs / crash loop" for the diagnosis
> commands, and "These are a budget, not independent knobs" for how the retry
> and timeout values have to add up to less than 300s.

### KafkaConsumerDrainSLOBreach

**Means:** estimated time-to-drain exceeds the group's `drainSeconds` SLO —
messages/users are waiting too long, even if the consumer is moving.

```promql
kafka:consumergroup_drain_seconds{group_id="X", topic_name="T"} > <drainSeconds>
```

**Runbook:**
1. Is it a **traffic spike** (healthy, will drain) or a **slowdown**? Compare `rate(kminion_kafka_consumer_group_topic_offset_sum[5m])` (consume rate) against inbound rate.
2. If consume rate dropped: check consumer CPU/mem throttling, downstream latency (CockroachDB, Facebook Graph API, formcentral), and pod count.
3. Scale out replicas if the group is partition-parallelizable (replybot, message-worker) and CPU-bound.
4. If it's a legitimate burst, consider whether the SLO is right for this group (`values.yaml`).

### KafkaConsumerGroupAbsent

**Means:** the lag series for this `(group, topic)` has vanished — the group has
no committed offsets (never started, offsets expired, or the consumer has been
gone long enough to be dropped).

```promql
absent(kminion_kafka_consumer_group_topic_lag{group_id="X", topic_name="T"})
```

**Runbook:**
1. Is the consumer deployment scaled to 0 or crash-looping? `kubectl -n <ns> get deploy <consumer>`.
2. Did someone delete the consumer group, or did `offsets.retention` expire it after a long downtime?
3. If the group is *intentionally* gone, remove its row from `values.yaml` and redeploy the chart (otherwise this alert is correct-but-unwanted).

> **Note on scope:** `absent()` is topic-scoped, so it separates prod from
> staging correctly. `kminion_kafka_consumer_group_members` is **only** keyed on
> `group_id` (shared across envs), so it is deliberately **not** used for the
> absent alert — it would count prod+staging members together and mask a
> single-env outage.

---

## 4. What is / isn't covered

- **Covered:** replybot, dinersclub, the four scribble sinks, and
  `message-worker` on **both** prod and staging. 14 `(group, topic)` pairs.
- **`message-worker` is covered on prod** as `vlab-prod-message-worker` /
  `vlab-prod-commands`, severity `critical`, 300s drain SLO. It is the sole
  outbound send path — a wedged worker means zero messages delivered.
  (Historically this row was excluded because prod ran `replicaCount: 0`; prod
  has run 1 replica since the staging→production promotion, so the row is
  active. If it is ever scaled back to 0, drop the row in the same change or it
  fires a permanent `KafkaConsumerGroupAbsent`.)
- **`loki` (consuming `vlab-prod-payment`) is excluded** — that's the Promtail
  log pipeline, not an app consumer.
- **SLOs:** prod `replybot` 120s / `critical`; prod `vlab-prod-message-worker`
  300s / `critical`; prod `dinersclub` 1800s / `critical`; prod scribble 600s /
  `warning`. All staging `warning`.

---

## 5. Deploy / operate

```bash
# kminion (metrics source) — one instance, default namespace
helm upgrade --install kminion devops/kminion --namespace default

# consumer-health alerts — one rule set, monitoring namespace
helm upgrade --install kafka-consumer-health devops/kafka-consumer-health --namespace monitoring
```

**Add / change a monitored group:** edit `devops/kafka-consumer-health/values.yaml`
(`groups:` list — set `env`, `group`, `topic`, `drainSeconds`, `severity`) and
re-run the `kafka-consumer-health` upgrade. Nothing in the app umbrella changes.

> **Editing `values.yaml` is only half the change — the chart must be
> re-applied.** This chart has no CI/CD trigger; it deploys only when someone
> runs the `helm upgrade` above. A rename that lands in the repo but is never
> applied leaves the cluster silently on the old group names. That exact drift
> happened once: the env-scoping of the message-worker groups was committed and
> the chart was not re-applied, so prod message-worker ran with **no alerting at
> all** while staging fired a permanent false `KafkaConsumerGroupAbsent` for the
> group name that no longer existed. **Always finish a group change by
> re-running the upgrade and confirming the live rule** (below).

**Verify it loaded (Prometheus watches all namespaces):**
```bash
kubectl -n monitoring port-forward svc/prometheus-kube-prometheus-prometheus 9090:9090
# then:
#   count(kafka:consumergroup_drain_seconds)                 → one series per pair
#   ALERTS{alertname=~"KafkaConsumer.*"}                     → currently firing
#   http://localhost:9090/api/v1/rules                       → rule groups loaded
```

**Enumerate live group/topic pairs** (ground-truth for the values list):
```promql
kminion_kafka_consumer_group_topic_lag        # label pairs (group_id, topic_name)
```

---

## 6. Known adjacent issues

- **Two broker alerts fire continuously and are being ignored** —
  `BrokerOverLoaded` and `PartitionCountHigh` (from `kafka-alerts` in
  `monitoring`). Ignored alerts train responders to ignore the channel; triage
  or silence them so consumer-health alerts land in a quiet channel.
- **No severity routing yet.** New alerts carry `severity: critical|warning` but
  AlertManager has a single flat Slack receiver → `#vlab-alerts`. Wiring
  `severity` → separate channels (and bringing the AlertManager config into Git)
  is the next "foundations" step.
- **Grafana has no ingress** — dashboards are port-forward only and not
  auto-provisioned (see `MONITORING_STACK.md`).
