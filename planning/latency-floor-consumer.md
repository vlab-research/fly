# The 1.7s idle latency floor — consumer-side half

**Date:** 2026-08-31
**Scope:** Kafka broker → burrow poll loop → send → completion log, inside
`message-worker`. The producer half (replybot `issued_at` → produce ack) is a
separate investigation.
**Status:** Findings only. No code or config changed.

**Headline:** the poll/fetch-wait hypothesis is **refuted**. There is no fixed
wait anywhere between the broker and the worker goroutine — the largest
provable consumer-side hop is single-digit milliseconds. The consumer-side
explanation for a p50 well above the ~600ms per-send cost is **strict per-user
serialization of multi-command turns**, which key affinity guarantees by
design. The completion log is an honest timestamp, but `ts − issued_at` is not
a per-message pipeline cost.

---

## 1. What the measurement actually is

`processFunc` (`message-worker/cmd/message-worker/main.go:209-211`) logs

```go
logger.Info("command processed successfully", zap.ByteString("value", msg.Value))
```

- `ts` is zap's own timestamp, stamped inside `Logger.check()` at the moment
  `logger.Info` is called — i.e. immediately after `ProcessCommand` returns.
- `issued_at` is read back out of the logged `value`, because the whole command
  JSON is logged. It is stamped by replybot in `buildCommands`
  (`replybot/lib/typewheels/transition.js:79` and `:92`) as `Date.now()`, at the
  moment the command struct is *built* — before it is handed to `produce()`
  (`replybot/lib/index.js:74`).

So `ts − issued_at` spans: replybot state-machine tail + produce + broker
append + replication to HW + fetch + burrow dispatch + full send + (WhatsApp)
echo produce. Two different pods' clocks, no skew correction.

---

## 2. Component-by-component consumer-side budget (one command, idle)

| # | Stage | Cost | Evidence |
|---|---|---|---|
| 1 | Broker append → data visible to an in-flight fetch | ~0 | **READ-FROM-CODE.** `fetch.min.bytes` is unset ⇒ librdkafka 2.12.0 default **1**. The broker's delayed fetch completes on the first byte past the high watermark; `fetch.wait.max.ms` only bounds an *empty* fetch. |
| 2 | Fetch response → librdkafka local queue | ~1 in-cluster RTT, low single-digit ms | **INFERRED.** Same-cluster (`kafka-headless.default.svc`), no TLS. |
| 3 | Local queue → `pollLoop` wakes | ~0 | **READ-FROM-CODE.** `burrow/pool.go:175` → `Consumer.ReadMessage(100ms)` → `Poll` → `handle.eventPoll` → `_rk_queue_poll(rkq, 100)` (`confluent-kafka-go v2.12.0 consumer.go:485-527`, `event.go:153-170`). That is a **condvar wait on the local queue**, woken by the fetcher thread's enqueue. It is not a sleep and not a broker call. |
| 4 | `AssignSequence` + `RecordInflight` + channel send | µs | **READ-FROM-CODE.** Two mutex ops (`burrow/tracker.go:44-71`) and a buffered channel send (`pool.go:203-216`). |
| 5 | Worker goroutine picks the job up | ~0 at idle | **READ-FROM-CODE.** `pool.go:145-158` — the worker is parked on `case job := <-jobs`. |
| 6 | `resolveMedia` | 0 for text/question. One **uncached** CRDB point lookup for media on an `/a/<uuid>` asset URL (`MEDIA_HANDLE_USE=true` in prod) | **READ-FROM-CODE.** `worker.go:195-251`; `mediastore.go` is explicitly uncached. |
| 7 | `TokenStore.GetToken` | 0 on cache hit; one CRDB point lookup on miss | **READ-FROM-CODE.** `tokenstore.go:84-126`. TTL is `TOKEN_CACHE_TTL`, **unset in `production.yaml` ⇒ 300s default** (`config.go:84`). Cache is per-process and keyed `platform:accountID`. |
| 8 | Translation | µs, pure | **READ-FROM-CODE.** `translator*.go`. |
| 9 | **HTTP POST to Graph API** | **the dominant term.** Bounded only by `http.Client{Timeout: 30s}` | **READ-FROM-CODE** (`messenger_client.go:25`, `whatsapp_client.go:28`) + **MEASURED** bound below. |
| 10 | WhatsApp only: `emitWhatsAppEcho` | one **synchronous** produce, `acks=all` across RF=3, `linger.ms` unset ⇒ default 5ms, snappy | **READ-FROM-CODE.** `worker.go:180-184` → `kafka.go:98-128` blocks on `deliveryChan`. Producer config `kafka.go:39-45`. |
| 11 | Completion log | immediate | **READ-FROM-CODE.** `main.go:209`. |
| 12 | Offset commit | **not on this path** | **READ-FROM-CODE.** `commitLoop` is its own goroutine on a 5s ticker (`pool.go:104-109`, `282-300`). The worker never touches it. |

**Everything except line 9 is single-digit to low-tens of milliseconds.** There
is no code path between the broker and the send that can produce ~1s at idle.

### The one measured bound on line 9

During the 2026-08-31 spike the pool sustained **26.4 sends/sec on 2 pods ×
NUM_WORKERS=8 = 16 slots**. 16 / 26.4 = **~606 ms mean worker occupancy per
command** (MEASURED, throughput-derived). That occupancy is lines 6–11 in full,
so under load the Graph API call plus the WhatsApp echo averaged **≤ ~600 ms**.
CPU sat at 85m of a 500m limit with zero CFS throttling, so this was not
compute.

### Head-of-line term (the consumer-side finding)

`KeyAffinity` routes by `hash(msg.Key)` to a **fixed** worker
(`pool.go:342-355`), and each worker drains its channel **one job at a time**
(`pool.go:145-158`). Replybot keys every command by `user_id`
(`replybot/lib/index.js:74`). Therefore **all commands for one user are strictly
serial inside one goroutine.**

`buildCommands` stamps `issued_at = Date.now()` on *every* command of a turn at
essentially the same instant, then `publishCommands` produces them back to back.
So for the k-th command of a turn:

```
ts − issued_at  ≈  (producer + broker + fetch)  +  k × (in-worker cost)
```

`devops/values/production.yaml:1111` records the spike traffic as **~1,800 users
at a median of 2 commands each**. If that ratio is typical, roughly half of all
logged commands are second-or-later in their turn and carry a full preceding
send (~600ms) before their own. A 50/50 mix of ~0.6s and ~1.2s+ commands, plus
the producer-side term, lands a p50 right around 1.7s. This is arithmetic
consistent with the observation, not a measurement — see §6.2 for the query that
settles it from existing logs.

---

## 3. Verdict: the fixed poll/fetch WAIT hypothesis

**REFUTED, on four independent grounds.**

1. **The poll timeout is not a wait a message sits through.** `burrow/pool.go:175`
   hardcodes `ReadMessage(100 * time.Millisecond)`. This is a *local queue* poll
   with a condvar wake-up (`_rk_queue_poll`), not a broker round-trip. A message
   that lands in the queue returns immediately; the 100ms is only how long an
   *empty* poll waits before returning `ErrTimedOut` and looping. It is also
   100ms, not ~1s, so it could not produce this floor even under the wrong model.

2. **`fetch.wait.max.ms` cannot delay an available message here.** It is unset
   ⇒ 500ms, but so is `fetch.min.bytes` ⇒ **1**. The broker's purgatory completes
   the delayed fetch on the first available byte. `fetch.wait.max.ms` bounds an
   idle long-poll, and an idle long-poll costs nothing.

3. **`fetch.queue.backoff.ms` (default 1000ms) is not triggered.** It fires only
   when `queued.min.messages` (100,000) or `queued.max.messages.kbytes` (65,536
   KB = 64 MB) is exceeded. Both are unset at those defaults, and commands are
   small JSON. Not at 0.08/s, and not plausibly at 26/s either. (This is the
   classic librdkafka "~1s delays between messages" property, so it deserved the
   check — but the thresholds that arm it are two to three orders of magnitude
   above this workload.) `fetch.error.backoff.ms` (500ms) applies only after a
   *fetch error*, which would be visible as `kafka read error` warnings in
   `pool.go:182`.

4. **The 606ms-vs-1.7s "discrepancy" is not evidence of amortisation — the two
   numbers measure different things.** 606ms is *worker occupancy* derived from
   throughput; it structurally cannot include anything upstream of the worker,
   nor any queueing. 1.7s is *end-to-end from a producer-side timestamp*. There is
   no arithmetic in which one is the amortised version of the other, so their
   difference is not a "fixed wait that batching hides."

**Nothing on the consumer side is amortised away by batching.** The one thing
that genuinely changes with load is the token cache hit rate (§5.4) and TCP
connection reuse (§5.2) — both worth fixing, both worth tens of ms, neither
worth 1.1s.

### Where the missing ~1.1s most likely is, ranked

| Candidate | Side | Status |
|---|---|---|
| Multi-command turns serialized per user | consumer | Mechanism **proven in code**; magnitude **not established** (§6.2 settles it from existing logs, no code change) |
| `issued_at` → produce ack inside replybot | producer | Out of scope here; note that `issued_at` is stamped *before* `produce()`, so replybot's own tail and its producer's linger/ack are inside the measurement |
| Clock skew between the replybot pod and the message-worker pod | neither | Unmeasured; §6.4 removes it |

---

## 4. Verdict: is the completion log an honest proxy?

**The timestamp is honest. The interpretation "fixed per-message pipeline cost"
is not.**

Honest:

- `ts` is stamped at the `logger.Info` call, which is reached only after
  `ProcessCommand` returns, which is only after the Graph API responded 2xx and
  the response body was parsed. **No commit, batch or flush stands between the
  HTTP response and the log line.** `CommitInterval = 5s` runs on a separate
  goroutine (`pool.go:104-109`) that the worker never waits on. The
  `CommitBatchSize = 1000` check is inside that same loop. There is no
  measurement artifact from the commit path — this was the specific worry and it
  is cleanly disproved.
- zap production writes unbuffered to stderr; there is no logger-side batching
  that could backdate or delay the entry.

Two real caveats, both small and both directional (they **overstate**):

- **WhatsApp overstates by the echo produce.** `emitWhatsAppEcho`
  (`worker.go:180-184`) runs *after* the message is delivered and *before* the
  log line, and `kafka.go:98-128` blocks on the delivery ack with `acks=all`
  across RF=3. So for WhatsApp, `ts` includes work the participant does not wait
  for. Order of tens of ms; verifiable, and `platform` is in the logged `value`
  so the two platforms can be split apart in the existing data.
- **`messenger_client.go` prints up to 9 unbuffered `fmt.Printf` lines per
  send**, two of them *after* the HTTP response and before the return
  (`:117`, `:123`, `:140`). Each is a separate write to a container stdout pipe.
  At idle this is noise; under kubelet log-pipe backpressure it is inside the
  measured window. (Separately: those lines print the request body prefix and the
  recipient PSID to stdout, which sits oddly against the care taken over
  participant content in `kafka.go:148-165`.)

The thing that makes `ts − issued_at` a misleading *pipeline* number is not the
logging — it is that for a k-th message in a turn, it legitimately includes the
sends of messages 1..k−1. For that message, it is still an honest user-facing
delay. It is just not a per-message cost you can subtract a floor from.

---

## 5. Config / code changes that would move the floor

Ordered by expected value. Note that **three of the five are code, not config** —
the HTTP clients are constructed in Go with no env knobs.

### 5.1 Do NOT tune the Kafka consumer for this

Explicitly listing the non-fixes so nobody spends a deploy on them:

- Lowering burrow's 100ms poll timeout: no effect (§3.1), and it is hardcoded in
  the library anyway — it would need a burrow release.
- Setting `fetch.wait.max.ms` lower: **no effect** while `fetch.min.bytes=1`
  (§3.2). This is the intuitive fix and it is a no-op.
- Lowering `fetch.queue.backoff.ms`: no effect at these queue depths (§3.3).
- Note `KAFKA_POLL_TIMEOUT` **does not exist for message-worker**. The
  `production.yaml` occurrences (`:193` = dinersclub 10s, `:400` = scribble 2s)
  belong to `spine`-based services. `message-worker/config.go` never reads it.

### 5.2 Raise `MaxIdleConnsPerHost` on both platform clients — *code*

`NewMessengerClient` / `NewWhatsAppClient` use the default `http.Transport`,
where `MaxIdleConnsPerHost = 2` and `IdleConnTimeout = 90s`. With
`NUM_WORKERS=24`, at most 2 connections to `graph.facebook.com` are retained, so
most concurrent sends pay a fresh TCP + TLS handshake. Set an explicit
`Transport` with `MaxIdleConnsPerHost` ≥ `NUM_WORKERS`.
**Risk:** more open sockets per pod against Meta; higher idle FD count. No
semantic change. This helps under load, not at idle — at 0.08/s the two idle
conns survive the 90s timeout.

### 5.3 Give `HTTPSyntheticPoster` a timeout — *code, and this is a latent outage*

`synthetic.go:38` is `&http.Client{}` — **no timeout at all**. It runs inside
the worker goroutine on every send failure (`worker.go:492`). This is precisely
the pattern `documentation/kafka-consumer-lag-alerting.md` records as the cause
of the dinersclub 2026-08-17 MAXPOLL crash loop ("The cause is almost always an
unbounded outbound call — a provider or API with no HTTP timeout"), now sitting
on the sole outbound send path. A hung hermes wedges workers indefinitely and
can outrun `max.poll.interval.ms` (unset ⇒ librdkafka default 300000ms).
**Risk of fixing:** a slow hermes drops the `machine_report`. Bounded — `reportError`
is already best-effort, returns `HandledError` either way, and dean's sweep
re-drives the ERROR state.

### 5.4 Set `TOKEN_CACHE_TTL` explicitly and higher

Unset ⇒ 300s, per-process, keyed `platform:accountID`. At 0.08 commands/sec
spread over 3 pods and many accounts, a given (pod, account) pair very plausibly
goes >300s between commands, so the idle p50 includes a CRDB round-trip that the
loaded p50 does not. This *is* a genuinely amortised-away cost — just a small one.
**Risk:** a rotated page token stays stale for the whole TTL, meaning failing
sends until expiry. Bounded and loud (they surface as `machine_report`s).

### 5.5 Attack the head-of-line term

The only change that touches the dominant consumer-side contributor. Options:
have replybot emit fewer commands per turn (concatenate where the survey allows),
or accept it. **Do not** try to parallelise a user's commands inside the worker —
that is exactly the reordering bug key affinity was added to fix
(`documentation/message-worker-deployment.md` §Scaling).

### 5.6 Housekeeping that removes a trap

`MAX_RETRY_ATTEMPTS`, `INITIAL_BACKOFF_MS` and `MAX_BACKOFF_MS` are set in
`production.yaml:1117-1122`, parsed into `Config` (`config.go:100-102`) and
**never read**. `NewWorker` hardcodes `DefaultRetryConfig()` (`worker.go:74`,
`retry.go:18-24`). The values happen to match the hardcoded defaults, so there is
no behavioural bug today — but an operator tuning retries during an incident
would change nothing and believe otherwise. Wire them or delete them.

---

## 6. Not established — and the experiment that settles each

### 6.1 The Graph API RTT distribution
Only a mean under saturation (~≤600ms, and that includes the echo) is known. No
p50/p99, no idle-vs-loaded comparison, no Messenger-vs-WhatsApp split.

- **Zero-code experiment (Messenger only):** `kubectl -n vprod logs <pod>
  --timestamps` and diff the containerd timestamps on the existing
  `[MESSENGER-CLIENT] Executing HTTP POST request...` and
  `[MESSENGER-CLIENT] Got HTTP response, status code:` lines. Works today.
  `whatsapp_client.go` has no equivalent prints, so WhatsApp cannot be bounded
  this way.
- **Proper fix:** wrap the `RetryWithBackoff` call in `processSendMessage`
  (`worker.go:160-163`) and emit `zap.Duration("send_ms", ...)` on the completion
  log. One field, and it turns the existing log line into a real latency series.

### 6.2 The size of the head-of-line term — *highest value, no code change*
Whether multi-command turns explain the gap is decidable from **logs already in
production**. The completion log carries the entire command, including
`command_id`, `user_id` and `issued_at`.

Group completion lines by `(user_id, issued_at)` bucketed to a few ms, then
compare the `ts − issued_at` distribution for the **first** command in each turn
against **second-and-later**. If first-in-turn p50 is materially below 1.7s and
the later ones sit ~600ms above it, this is confirmed and the true per-message
floor is the first-in-turn p50. Do this before changing anything.

### 6.3 The producer-vs-consumer split — one line of code
`*kafka.Message` already carries `msg.Timestamp`. Adding
`zap.Time("kafka_ts", msg.Timestamp)` to the completion log in `main.go`
decomposes the measurement into `msg.Timestamp − issued_at` (producer-side) and
`ts − msg.Timestamp` (broker + fetch + burrow + send). This is the definitive
test of the poll/fetch hypothesis and costs one field.

Caveat: `vlab-prod-commands` sets no `message.timestamp.type`
(`production.yaml:150-154`), so the broker default `CreateTime` applies and the
timestamp comes from replybot's clock — carrying the same skew as `issued_at`.

### 6.4 Clock skew between replybot and message-worker pods
Currently uncorrected and entirely inside the 1.7s. Either compare `date` across
one pod of each, or set `"message.timestamp.type": "LogAppendTime"` on
`vlab-prod-commands` in `production.yaml` — then §6.3's split is stamped by the
broker's single clock and is skew-free. **Risk:** overwrites producer timestamps
on that topic. Nothing reads them today (the topic has exactly one consumer), but
it is a topic-config change and belongs in the values file, per the IaC rule.

### 6.5 Token cache hit rate at idle
No counter exists. A `zap.Bool("token_cache_hit", ...)` in `GetToken`, or a real
counter, would settle whether §5.4 is on the idle p50 path or noise.

### 6.6 What the idle sample was made of
Messenger and WhatsApp have different endpoints and WhatsApp has the extra echo
produce. `platform` is in the logged `value`, so this is re-derivable from the
same data — do it before treating 1.7s as one number.

---

## 7. Documentation gaps found (for the follow-up doc pass)

Per `CLAUDE.md`, these belong in a separate documentation step, not mixed in
here. Listed so that pass has a worklist.

1. **`documentation/kafka-consumer-lag-alerting.md` §KafkaConsumerStuck** asserts
   "Every Go consumer here builds on `spine`, which hardcodes
   `max.poll.interval.ms = 300000`". `message-worker` builds on **burrow**, not
   spine, and sets **no** `max.poll.interval.ms` at all (`main.go:75-80` sets only
   4 properties). It inherits librdkafka's default, which happens to also be
   300000 — so the runbook's conclusion is right by coincidence, not by the
   mechanism it states. Worth correcting, because the doc also says the
   `dinersclub` fix removed that failure signature — and `message-worker` still
   has the unbounded-client version of the same bug (§5.3).
2. **`documentation/message-worker-deployment.md` env table is stale**:
   `NUM_WORKERS` is listed as `1` (actual: 24), `FACEBOOK_GRAPH_URL` as needing to
   match replybot without naming v25.0, and `replicaCount` (3) is absent. The
   `MAX_RETRY_ATTEMPTS` row describes behaviour the code does not implement
   (§5.6). The Monitoring section still describes the retired `laggingAlerts` /
   `LaggingConsumerMessageWorker` scheme, superseded by
   `devops/kafka-consumer-health`.
3. **No consumer-tuning section exists anywhere.** The fact that
   `message-worker` sets exactly four librdkafka properties and inherits
   everything else at defaults is load-bearing for every question in this
   document and is written down nowhere. Neither is burrow's hardcoded 100ms
   poll timeout, nor that `KAFKA_POLL_TIMEOUT` is a `spine` variable that this
   service does not read.
4. **`message-worker/README.md` describes a different artefact.** It documents
   `message-worker-core` as a "pure Go library", references a "Bottleneck
   client" that no longer exists, gives an illustrative `ProcessCommand` that
   does not match `worker.go`, and states the production `NUM_WORKERS` default
   as 100. It has no section on the burrow pool, the poll loop, dispatch, or
   commit behaviour — the entire consumer runtime is undocumented.
5. **`documentation/message-worker-deployment.md` §"Rebalance replays duplicate
   sends" is still accurate** — `main.go:87` still passes `nil` to
   `SubscribeTopics`, so `pool.setupRebalanceCallback`'s work
   (`pool.go:358-405`) is dead code and the "partitions assigned/revoked" log
   lines never appear. Verified, not a gap; noting it so the doc pass does not
   re-litigate it.
