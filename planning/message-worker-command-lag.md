# Message-worker command lag: one consumer, six partitions, and retried dead sends

**Date:** 2026-08-17
**Status:** Fix 1 applied to production 2026-08-17 (1 → 6 replicas). Fixes 2 and 3 outstanding.
**Symptom:** Multi-minute delays delivering interactive survey messages, across studies

> **Correction to the diagnosis below.** Cause 1 understated the problem. The
> worker is not serial merely because it runs one pod — `devops/values/production.yaml`
> also set `NUM_WORKERS: "1"`, pinning the already-deployed burrow pool
> (`main.go:145-153`, code default 100) to a single goroutine. One pod × one
> worker drained a six-partition topic.
>
> `NUM_WORKERS` stays at 1 deliberately: burrow dispatches to a shared job
> channel with no key affinity, so raising it would let two commands for the
> same `user_id` send concurrently and arrive out of order. Replicas do not
> have that problem. See `documentation/message-worker-deployment.md` §Scaling.
>
> **Result:** six replicas ready in ~10s, no restarts. Lag drained 133 → 89
> within a minute, spread across all six partitions. The `mnch_end` campaign
> localised to one pod while the other five served interactive traffic —
> which also confirms cause 3 was the real structural issue.

---

## What was observed

While running an unrelated click-to-WhatsApp probe, both a Messenger and a WhatsApp
survey entry took **minutes** to receive their first message. The conversations were
otherwise correct — `replybot` had already computed the right state and issued the
`send_message` commands within ~1s of the inbound event. The delay was entirely in
delivery.

## Measurements

All from production on 2026-08-17. Prometheus via
`kubectl -n monitoring port-forward svc/prometheus-kube-prometheus-prometheus 9090:9090`.

**Consumer lag, `vlab-prod-message-worker` on `vlab-prod-commands`:**

```
16:00–19:20   0–4      healthy
19:20         146
19:30         319
19:40         524      peak
19:50         444      easing
```

**Every other consumer group was effectively clean at the same moment** — `replybot` on
`vlab-prod-chat-events` had a lag of **1**, the scribble sinks 70–74. Inbound processing
and state were keeping up entirely; only outbound delivery was behind.

**Partitions vs. consumers:**

| Topic | Partitions | Consumers |
|---|---|---|
| `vlab-prod-chat-events` | 48 | 8 (`gbv-replybot`) |
| `vlab-prod-commands` | **6** | **1** (`gbv-message-worker`) |

**What the worker was doing** (`kubectl -n vprod logs gbv-message-worker-…`): a bulk
`mnch_end` utility-message send for page `758018254333043` — a different study from any
affected by the delay — with a large share of recipients returning
`(#551) This person isn't available right now`, plus some `(#100) No matching user found`.
Each failing send appeared as three identical API responses before the
`command send failed but handled/reported` warning.

## Diagnosis

**Head-of-line blocking on a shared queue, with only one consumer draining it.**

Three compounding causes, in order of how much each contributes:

**1. One consumer on a six-partition topic.** `vlab-prod-commands` already has 6
partitions, so five sixths of the available parallelism is unused. The comparison with
`chat-events` (48 partitions / 8 pods, lag 1) is the same system showing what adequate
provisioning looks like.

**2. Non-transient failures are retried.** `isRetriableFacebookError`
(`message-worker/messenger_client.go:190-199`) returns `true` for code `551`
unconditionally. `RetryWithBackoff` then makes 3 attempts with 100ms→1s exponential
backoff (`message-worker/retry.go:18-24`, `:66+`). So each unreachable recipient costs
three API round-trips plus ~300ms of sleeping, on the single consumer.

Meta supplies the answer in the payload and it is not consulted: at least one observed
551 carried `"is_transient": false` (subcode `1893047`, "Send Message Recipient Not
Available"). Note 551 spans a family — subcode `1545041` also appeared — so this is a
question of reading `is_transient` rather than blanket-demoting 551.

**3. Bulk and interactive share one topic.** A campaign blast for one study and live
survey replies for every other study compete in `vlab-prod-commands`. This is the
structural issue: even at 6 replicas a large enough campaign still delays interactive
traffic, because nothing distinguishes the two.

## Suggested fixes, by value per effort

**1. Scale `gbv-message-worker` to 6 replicas.** Immediate ~6× outbound throughput, no
topic or schema change, partitions already exist. Beyond 6 requires a partition increase.

Per `CLAUDE.md` this must go through `devops/values/production.yaml` followed by
`helm upgrade` — **not** `kubectl scale`. An imperative scale is invisible in a diff and
is silently reverted by the next apply.

**2. Consult `is_transient` before retrying.** Parse it off the Facebook error body and
let it override `isRetriableFacebookError`. Cheap, contained, and it stops the worker
spending its capacity on sends that cannot succeed. Worth checking the WhatsApp client
(`whatsapp_client.go`) for the same pattern.

**3. Separate bulk from interactive delivery.** A distinct topic or priority lane so one
study's utility-message campaign cannot delay another study's live survey. This fixes the
class of problem rather than this instance, and is the only one of the three that
survives a campaign an order of magnitude larger.

## What this does *not* establish

- **The `mnch_end` campaign is correlated, not proven causal.** The timing matches (lag
  begins ~19:20, the log is dominated by that page) but no counterfactual was run.
- **No per-command timing was measured.** The lag figure is queue depth, not latency;
  "minutes" is the observed user-facing delay, not an instrumented p99.
- **Retry cost is calculated, not profiled.** Three attempts × backoff is read from the
  code, not measured against wall-clock worker throughput.
- **Whether 6 replicas is sufficient** depends on steady-state command rate, which was
  not measured. It is a floor, not a sizing exercise.

## Reproducing the measurement

```bash
kubectl -n monitoring port-forward svc/prometheus-kube-prometheus-prometheus 9090:9090 &
# lag now
sum by (topic, consumergroup) (kafka_consumergroup_lag)
# lag over time
sum(kafka_consumergroup_lag{consumergroup="vlab-prod-message-worker",topic="vlab-prod-commands"})
# partitions per topic
count by (topic) (kafka_topic_partition_current_offset{topic=~"vlab-prod-commands|vlab-prod-chat-events"})
```

Related: `documentation/kafka-consumer-lag-alerting.md`,
`documentation/message-worker-deployment.md`.
