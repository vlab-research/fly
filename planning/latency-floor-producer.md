# Producer-side (replybot → Kafka) latency floor investigation

**Scope:** replybot's contribution to the constant ~1.7s p50 / ~3s p99 floor observed
in `ts - issued_at` at complete idle (0.08 cmd/sec, zero consumer lag). Consumer side
(`message-worker`) is a separate agent's territory. This doc covers everything between
the `issued_at` stamp and the bytes leaving replybot's Kafka producer queue for the
broker.

**Docs read first** (per repo's documentation-first rule):
`documentation/kafka-consumer-lag-alerting.md`, `documentation/message-worker-deployment.md`,
`documentation/event-envelope.md`, `replybot/README.md`, `planning/message-worker-command-lag.md`.
None of the four documents the producer's Kafka client config or per-command latency —
`message-worker-command-lag.md` explicitly says "No per-command timing was measured. The
lag figure is queue depth, not latency." This investigation is new ground, not a
contradiction of anything documented. See [Documentation gaps](#documentation-gaps) below.

---

## 1. Where `issued_at` is stamped

`replybot/lib/typewheels/transition.js:79` (send_message commands) and `:92` (handoff
commands), inside `Machine.buildCommands`:

```js
buildCommands(messages, handoff, user, page, platform) {
    const commands = messages.map(({ message, token }) => ({
      type: 'send_message',
      command_id: crypto.randomBytes(8).toString('hex'),
      issued_at: Date.now(),                    // transition.js:79
      ...
```

`buildCommands` is called at `transition.js:186`, inside `Machine.run`, **after**
`await this.actionsResponses(...)` (line 182) has already resolved. `actionsResponses`
is where `getForm` (cached DB/formcentral lookup), `act()`, and `responseVals()` run —
so the state-machine's own computation (including any form lookup) happens **before**
the stamp and is *not* part of the measured `ts - issued_at` window. That's good news:
none of replybot's decision-making work is hiding inside the 1.7s.

**Everything after the stamp and before `Machine.run` returns is synchronous, in-process,
pure work** (return-object construction only) — negligible.

## 2. Everything between the stamp and the produce call

`Machine.run`'s report comes back to `replybot/lib/index.js`'s `processor()`
(`_processor`, lines 81–121). The report for a normal send always has `publish: true`
(see `transition.js:188-198`), so **every single command-producing event runs this
entire sequence, in order, fully awaited, before the command's `produce()` call is
reached**:

```js
// lib/index.js
if (report.publish) {
  await publishReport(report, conv)          // 98  — HTTP POST to hermes /synthetic
}
if (report.newState) {
  await publishState(report.user, report.page, report.timestamp, report.newState)  // 101 — Kafka produce (state topic)
  await stateStore.updateState(conv, userId, report.newState)                       // 102 — Redis SETEX
}
if (report.responses) {
  await publishResponses(report.responses)   // 105 — Kafka produce (responses topic)
}
if (report.payment) {
  await publishPayment(report.payment)       // 108 — Kafka produce (payment topic), conditional
}
if (report.commands && report.commands.length > 0) {
  await publishCommands(report.commands)     // 111 — Kafka produce (commands topic) — the one we're measuring
}
```

So the command produce call is **last** in a chain of four-to-five awaited I/O
operations, not first:

1. **`publishReport`** (`index.js:13-49`) — an HTTP POST to `${BOTSERVER_URL}/synthetic`
   (hermes), awaited to completion. This fires on every report (line 97), i.e. on every
   message send, not just errors. I confirmed hermes' own handler
   (`hermes/src/handlers.rs:339-412`, `handle_synthetic`) does **not** block its HTTP
   response on its own Kafka produce — `producer.produce()` at line 409 is fire-and-forget
   (spawns internally; see `hermes/src/producer.rs:51-59`, `Timeout::After(Duration::ZERO)`).
   So this is "just" a network round trip plus hermes' own request handling — but it is a
   real network hop inside replybot's critical path, and I could not determine its actual
   duration from code alone (see [Not established](#not-established)).
2. **`publishState`** (`index.js:57-60`) — a Kafka produce call via the same `produce()`
   helper used for commands (below). The `await` here only waits for the JS-level enqueue,
   not for broker delivery (see §3) — cheap in wall-clock JS terms, but relevant because it
   happens serially before the command's own produce call, not concurrently with it.
3. **`stateStore.updateState`** (`lib/typewheels/statestore.js:136-143`) — a single Redis
   `SETEX`, awaited. One round trip.
4. **`publishResponses`** — another Kafka produce, same shape as #2, conditional on
   `report.responses` being truthy (it usually is, for any message-sending transition).
5. **`publishPayment`** — another Kafka produce, conditional on `report.payment`.
6. **Only then**: **`publishCommands`** (`index.js:71-76`) loops over `report.commands`
   and calls `produce(KAFKA_COMMANDS_TOPIC, cmd, cmd.user_id)` for each.

**Net finding on this sub-question:** there is real, awaited, sequential work between the
stamp and the produce call — one HTTP round trip to hermes, one Redis write, and two
other Kafka produce calls that must resolve (at the JS level) first. None of these
individually look expensive from the code, but I have no measurements to bound them, and
they are strictly serial (not parallelized), so their costs sum rather than overlap.

## 3. The producer configuration — and the standout finding

`replybot/lib/producer.js` (the entire file, reproduced because it is short and every line
matters):

```js
const Kafka = require('node-rdkafka')

const producer = new Kafka.Producer({
  'metadata.broker.list': process.env.KAFKA_BROKERS,
  'retry.backoff.ms': 200,
  'message.send.max.retries': 10,
  'request.required.acks': 1,
  'socket.keepalive.enable': true,
  'queue.buffering.max.messages': 100000,
  'queue.buffering.max.ms': 1000,
  'batch.num.messages': 1000000
}, {}, {});

producer.connect()
producer.setPollInterval(1000)
```

**Client library:** `node-rdkafka` (bindings around librdkafka, not kafkajs). It is not a
direct dependency of `replybot/package.json` — it comes in transitively via
`@vlab-research/botspine@0.0.13`, whose own `package.json` pins `"node-rdkafka": "^2.10.0"`.
The installed/lockfile version is `2.18.0`, bundling **librdkafka 2.3.0**
(`node_modules/node-rdkafka/package.json` → `"librdkafka": "2.3.0"`). Because it's
librdkafka-backed, config keys are librdkafka's native names (`queue.buffering.max.ms`,
`request.required.acks`, etc.), not kafkajs's.

**`queue.buffering.max.ms` is librdkafka's canonical name for `linger.ms`** (they are
documented aliases in librdkafka's `CONFIGURATION.md`; librdkafka's own default is **5ms**).
This repo does **not** inherit that default — it explicitly overrides it to **1000ms**, a
200× increase over the library default. This is set identically in `hermes/src/producer.rs`
(`.set("queue.buffering.max.ms", "1000")`), so it's a deliberate repo-wide convention, not
an accident isolated to replybot.

**Effect at the measured traffic level (0.08 cmd/sec):** librdkafka batches per
topic-partition. A message entering an otherwise-empty partition queue starts that
batch's linger timer; the batch is flushed to the broker when *either* linger.ms elapses
*or* the batch fills by count/size. At 0.08 cmd/sec there is essentially never a second
message arriving within the same window to fill the batch early (`batch.num.messages` is
set absurdly high — 1,000,000 — specifically so count never triggers early), and nothing
in this codebase calls `.flush()` or otherwise forces an early send (see below). So under
idle conditions, **each command's local queueing delay should be close to the full
1000ms**, not an average of half that — there's nothing to trigger an earlier flush.

This is the single largest concretely-identified contributor to the 1.7s floor: **up to
~1000ms, from one explicit config line**, on top of the sequential I/O chain in §2.

**Other producer settings, and which are set vs. inherited:**

| Setting | Value | Set here or inherited default? |
|---|---|---|
| `metadata.broker.list` | `KAFKA_BROKERS` env var | set |
| `queue.buffering.max.ms` (linger.ms) | **1000** | **set** — librdkafka default is 5ms |
| `queue.buffering.max.messages` | 100000 | set |
| `batch.num.messages` | 1,000,000 | set (effectively disables count-based early flush) |
| `request.required.acks` | 1 (leader only) | set |
| `message.send.max.retries` | 10 | set |
| `retry.backoff.ms` | 200 | set (only matters on retry, not the happy path) |
| `socket.keepalive.enable` | true | set |
| `queue.buffering.max.kbytes` | not set | **inherited default** (librdkafka default 1,048,576 KB / 1GB) — irrelevant at this message size |
| `compression.codec` | not set | **inherited default** (`none`) — irrelevant to latency at these message sizes |
| `linger.ms` (the modern alias) | not set directly, but `queue.buffering.max.ms` is its synonym and governs the same value | n/a — same knob, two names |
| `message.timeout.ms` | not set | **inherited default** (300000ms) — only bounds retries/failures, not the happy-path latency |

`producer.setPollInterval(1000)` (`producer.js:15`) drives `producer.poll()` on a 1s
timer. In node-rdkafka this services the JS-visible event queue (delivery reports,
`event.error`, etc.) — it does **not** gate the actual network transmission, which is
handled by librdkafka's internal C thread independent of the Node event loop / poll calls.
I flag it because it's easy to conflate with the linger setting, but it is a distinct knob
and not (by my reading of the code) a contributor to the measured floor.

## 4. Is the produce call awaited/flushed synchronously, or batched? Are delivery reports awaited?

- **Not flushed synchronously.** I grepped the whole `lib/` tree for `.flush(` and found
  no calls anywhere in application code. Nothing forces librdkafka to send early.
- **No delivery-report callback is wired up anywhere** — `producer.produce(topic, null,
  data, userid)` (`index.js:54`) is called with no delivery-callback argument, and there's
  no `producer.on('delivery-report', ...)` listener in `producer.js` or `index.js`. So
  replybot never learns whether/when a given command actually reached the broker; it only
  knows the message was accepted into librdkafka's local queue.
- **Batching is implicit and library-managed**, governed entirely by the config in §3
  (`queue.buffering.max.ms` / `batch.num.messages` / `queue.buffering.max.messages`), not
  by anything explicit in the JS.
- **The `produce()` helper itself is effectively synchronous** once `producerReady` has
  resolved (it resolves once, at process startup — `producer.js:22-33`), because
  `producer.produce()` in node-rdkafka is a synchronous C-binding call that enqueues the
  message and returns; the `async function produce()` wrapper (`index.js:51-55`) has
  nothing left to await after that call. So the *JS-observable* cost of the produce call
  itself is near-zero; all of the delay is either (a) the sequential I/O chain in §2 that
  runs *before* this call, or (b) librdkafka's internal linger/network/broker-ack time that
  runs *after* this call and is invisible to the JS process.

## 5. Best estimate: how much of the 1.7s is producer-side

I can defend a **lower bound of roughly 1 second** as producer-side, with moderate-to-high
confidence, from code alone:

- **~1000ms (high confidence, from config):** `queue.buffering.max.ms: 1000` on an
  essentially idle commands-topic partition. Nothing in the code forces an earlier flush.
  This is a deliberate, explicit override (200× the library default), present identically
  on both replybot's and hermes' producers, so it reads as an intentional throughput/batching
  choice under load that was not re-evaluated for its floor cost at low volume.
- **An unquantified but nonzero amount (low confidence, no measurement) from the
  sequential I/O chain in §2:** one HTTP round trip to hermes (`publishReport`), one Redis
  `SETEX` (`stateStore.updateState`), and two prior Kafka `produce()` JS calls
  (`publishState`, `publishResponses`), all awaited in series before the command's own
  `produce()` call is even reached. In a healthy in-cluster environment this is plausibly
  tens of milliseconds, but I have no logs, traces, or benchmarks to support a specific
  number — see §6.
- **An unquantified amount from actual network transmission + broker leader append**
  (with `acks=1`, this should be fast — no wait for follower replication — but "fast" is
  an inference from the config, not a measurement).

So: **producer-side is very likely majority-responsible for the 1.7s p50 floor**, with the
1000ms linger as the dominant single line item, and the pre-produce I/O chain as a
secondary, currently-unmeasured contributor. The remainder of the 1.7s (and essentially
all of the p99-minus-p50 spread) most plausibly sits on the consumer side (broker fetch
latency, message-worker's own processing, the outbound Graph API call) — that's the other
agent's territory, but it's worth flagging here that a ~1000ms producer-side floor plus a
consumer-side floor of similar order would already roughly account for 1.7s without
requiring queueing.

## 6. Not established — what code alone cannot answer, and what would settle it

- **The actual wall-clock cost of `publishReport`'s HTTP POST to hermes.** Code shows it's
  not blocked on hermes' own Kafka produce, but I don't know real network/DNS/TLS/handler
  latency in-cluster. **Would settle it:** a histogram of this fetch's duration (wrap it
  with `console.time`/a metric, or check for existing tracing/APM on outbound HTTP calls
  from replybot), or a service-mesh/Envoy access log if one exists between replybot and
  hermes.
- **The actual wall-clock cost of the Redis `SETEX`** in `stateStore.updateState`. Likely
  small, but not measured. **Would settle it:** Redis `SLOWLOG`, or client-side timing.
- **Whether librdkafka's internal flush, once triggered by the 1000ms linger timer, adds
  further delay before the broker actually has the message** (network RTT to the broker,
  broker-side fsync/replication behavior under `acks=1`). Not visible from the JS/app code
  at all — this is librdkafka-internal and broker-side behavior. **Would settle it:** a
  librdkafka debug log (`debug: 'broker,msg'` in the producer config) correlating enqueue
  time vs. actual `Produce` request send time vs. ack time, or a packet capture / broker-side
  request-latency metric.
- **Whether the 1000ms linger figure is actually being hit in production**, as opposed to
  being cut short by some other message arriving on the same partition within the window
  (which would only happen under real traffic, not at the measured 0.08 cmd/sec — but I
  have not independently confirmed librdkafka's per-partition batching behavior matches my
  description of "starts on first enqueue, no early trigger without a second message or a
  size/count threshold" against this exact librdkafka version's implementation notes, only
  against its documented config semantics). **Would settle it:** the librdkafka debug log
  above, or directly correlating `issued_at` against a producer-side "message added to
  local queue" timestamp if one were added.
- **End-to-end apportionment between producer-side linger/network and consumer-side
  fetch/process time.** Only a coordinated trace (span from `issued_at` stamp through
  produce-enqueue, through broker receipt, through consumer fetch, through message-worker's
  processing) would fully split the 1.7s. That's the natural next step once both halves of
  this investigation land.

## Documentation gaps found

- **None of the four required docs mention the producer's Kafka client config, the
  `queue.buffering.max.ms: 1000` setting, or any per-command latency budget.**
  `planning/message-worker-command-lag.md` explicitly disclaims having measured per-command
  timing ("No per-command timing was measured... 'minutes' is the observed user-facing
  delay, not an instrumented p99") — consistent with this being new ground.
- **`replybot/README.md` documents `lib/index.js`'s pipeline in detail (event normalization,
  entry points, state cache, envelope handling) but has no section on `lib/producer.js` or
  the outbound command-publishing path (`publishCommands`/`buildCommands`/`issued_at`) at
  all.** Given how much README already exists on the inbound/state side, this is a real gap
  — worth a follow-up doc section once the full latency picture (with the consumer-side
  agent's findings) is in.
- **`node-rdkafka` is an indirect dependency** (via `@vlab-research/botspine`), not listed
  in `replybot/package.json` directly. Nothing in the README flags this, so a reader
  grepping `package.json` for the Kafka client would not find it.
- **`documentation/message-worker-deployment.md`** covers the commands topic's partition
  count and consumer-side scaling in detail but has nothing on the producer's batching
  config — reasonable, since it's a message-worker-focused doc, but worth linking once a
  latency doc exists.

## Files referenced

- `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/transition.js` (lines 75-102 `buildCommands`, 79/92 `issued_at`, 180-198 `Machine.run` success path)
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/index.js` (lines 51-76 produce/publish helpers, 80-122 `processor`)
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/producer.js` (entire file — Kafka producer config)
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/statestore.js` (lines 136-143 `updateState`)
- `/home/nandan/Documents/vlab-research/fly/replybot/package.json` (dependencies — no direct `node-rdkafka`)
- `/home/nandan/Documents/vlab-research/fly/replybot/node_modules/@vlab-research/botspine/package.json` (transitive `node-rdkafka: ^2.10.0`)
- `/home/nandan/Documents/vlab-research/fly/replybot/node_modules/node-rdkafka/package.json` (resolved `2.18.0`, bundled `librdkafka 2.3.0`)
- `/home/nandan/Documents/vlab-research/fly/hermes/src/handlers.rs` (lines 339-412 `handle_synthetic`)
- `/home/nandan/Documents/vlab-research/fly/hermes/src/producer.rs` (lines 15-59, same `queue.buffering.max.ms: 1000` pattern, fire-and-forget produce)
