# WhatsApp watermarks: a stale read reverts `QOUT` to `RESPONDING`

**Status: UNPROVEN — mechanism unknown, not reproduced. Do not implement from this.**

This is a findings log, not a plan. Two candidate mechanisms were proposed and **both
were falsified by direct measurement** (§5). What remains is a contradiction between
things that are individually verified, which means one of them is false and artifacts
cannot say which. A plan should be written once §6 reproduces it.

A deliberate reproduction attempt on 2026-08-16 did **not** trigger this — the
conversation died first on the conversation-identity bug (see
`planning/conversation-identity.md`), which must be fixed before this can be reproduced
cleanly.

**Verified against:** `chatroach.messages` (production), replybot `v0.0.218`,
dean `v0.0.44-wa`.

---

## 1. Symptom

User `15419799714` on `misinfogame`, 2026-08-14. The same five messages
(`track_performance`, `q1_feedback_1`, `conspiracy_badge`, `conspiracy_image`,
`next_round`) were delivered **three times: 11:57:53, 12:30:05, 13:00:10**. The two later
deliveries are dean `redo` synthetics — the `respondings` job runs `*/30 * * * *` with
`DEAN_RESPONDING_GRACE=20m`, so a participant pinned in `RESPONDING` gets their last
batch re-sent every half hour.

From the `machine_report` events in `messages`:

| report at | event ts | resulting state |
|---|---|---|
| 11:57:56.139 | 1786708676123 — echo `next_round` | `QOUT`, question `next_round` |
| 11:57:56.179 | 1786708673000 — `delivered` | `RESPONDING`, question `false_connections` |
| 11:57:56.763 | 1786708674000 — `delivered` | `RESPONDING`, question `false_connections` |
| 11:57:57.395 | 1786708675000 — `delivered` | `RESPONDING`, question `false_connections` |
| 11:57:58.336 | 1786708676000 — `delivered` | `RESPONDING`, question `false_connections` |

The echo had already advanced the conversation to `QOUT`. Four delivery receipts each
carried the **pre-echo** base state, and the last one won.

The loop broke at 13:00 by luck: that round's receipts were applied after the echo, so
they carried `QOUT` and dean stopped selecting the user. **The intermittency is the
tell** — a deterministic bug would not self-heal.

---

## 2. Receipt ordering is NOT the bug

An earlier revision claimed the machine depends on the question-bearing echo being the
last event of the burst to touch state, and that WhatsApp's trailing receipts violate
that. **That is wrong.** Recorded because it is the natural wrong answer and it cost a
pass.

`WATERMARK` is a monotonic-mark handler and is explicitly order-insensitive:

```js
case 'WATERMARK': {
  const { type, mark } = getWatermark(nxt)
  if (state[type] >= mark) return _noop()          // late or duplicate receipt: no-op
  return { action: 'WATERMARK', update: { [type]: mark } }
}
```

Applied to a `QOUT` base it bumps `delivery` and returns `QOUT` — `state` and `question`
untouched. A receipt arriving after the echo is harmless *by design*, and that design
works: in the 13:00 burst every receipt landed after the echo, each report shows `QOUT`,
and dean correctly stopped selecting the user.

The defect is the narrow one: **the receipts in the 11:57 and 12:30 bursts did not read
the post-echo state.** They read a base from before the echo and wrote it back. That is a
stale read, not an ordering problem — which matters, because a stale read is a general
hazard for every handler, not a quirk of watermarks.

Read the burst as two chains that never saw each other:

| chain | base it saw |
|---|---|
| echo `next_round` → `QOUT` | `delivery` still `1786705216000` (the 11:00 value) — **no receipt applied** |
| receipts `delivered` 673 → 674 → 675 → 676 | each sees the previous receipt's `delivery`; **none sees `QOUT`** |

Each chain is internally consistent and mutually invisible to the other, from a common
ancestor: the state written by the `RESPOND` at 11:57:51.

---

## 3. Why a stale read is destructive here

```js
// apply():
case 'WATERMARK':
  return { ...state, ...output.update }
```

The handler's only intent is to bump one scalar. `index.js` persists the whole returned
object to Redis and to the state topic, so a receipt computed against a stale snapshot
does not merely fail to advance the conversation — it rewrites `state` and `question`
backwards. **A read-modify-write of the entire conversation, to set one integer, is what
turns a stale read into corruption.**

## 4. Context: why this surfaced on WhatsApp

WhatsApp emits far more per sent message than Messenger:

- 1 synthetic `bot_echo` from message-worker (`bot_message_sent` → `ECHO`)
- 3 Cloud API status webhooks: `sent`, `delivered`, `read` (→ `WATERMARK`)

A five-message batch is ~20 events for one user inside three seconds, ~15 of them
receipts. The `WATERMARK` path is effectively untested code now under ~4× load.

**And nothing reads what it writes.** `state.delivery` and `state.read` are write-only —
grepped across replybot, dean, scribble, dashboard-server, exodus and the migrations, the
only references are the producer (`machine.js:86`, `event-normalizer.js:136`) and the
setter. No query, no dean predicate, no dashboard field, no export column consumes
either value.

### `RESPONDING` may itself be a Messenger artifact

On Messenger, `RESPONDING` waits for Facebook's native `is_echo` webhook — an external
round-trip that carries real information. On WhatsApp there is no native echo:
`message-worker/worker.go:182` **mints it**, immediately after a successful send,
precisely so the machine will advance. So we hold the conversation in a wait state
pending our own local acknowledgement of an operation whose outcome we already have — a
failed send is already a `HandledError` on the same code path.

Worth settling before building on the current design, but not the cause of this incident.

---

## 5. Both candidate mechanisms falsified

**Ruled out — concurrent double-processing (rebalance overlap).** If two consumers had
briefly owned the same partition, the overlapping events would have been processed twice.
They were not: joining every `machine_report` to the `bot_echo` it reports on (echo
timestamps are ms-precision from `time.Now().UnixMilli()`, so unique) returns **zero**
echoes with more than one report, across both users since 2026-08-12. Confirmed live: of
the 8 replybot pods, exactly one has any log line for a given user id.

**Ruled out — cache miss falling through to the log replay.** Measured on
`gbv-redis-master` in `vprod`:

```
evicted_keys:0        maxmemory_policy:noeviction    used_memory_human:4.86M
keyspace_hits:13305   keyspace_misses:309            (97.7% hit rate)
```

No eviction, no memory pressure — a miss requires the 24 h TTL to expire or the key never
to have been written, and neither can select for four consecutive receipts interleaved
with echoes that *did* hit. The ~1 s watermark latency that suggested a replay has a
mundane explanation instead: `run()` sends any non-`NONE`, non-`RESET` output through
`actionsResponses()`, so **a delivery receipt performs a full `getForm` fetch**.

**What remains is a contradiction.** Under the established facts — 48 partitions and
exactly 48 consumers, one key per conversation, verified byte-identical Kafka keys from
both producers, `PromiseThroughStream` sequential per spine, `run()` a pure function of
`(state, event)`, one shared Redis with no eviction — the two chains in §2 are
*impossible*. One of those premises is false.

---

## 6. How to reproduce and close it

Replybot already logs `EVENT:`, `STATE:` and `REPORT:` for every event
(`index.js:62-68`). The `STATE:` line is literally the base the handler was handed, so
one captured burst distinguishes "read the wrong value" from "read the right value and
something else overwrote it".

1. Fix or work around the conversation-identity bug first — the 2026-08-16 attempt died
   on it before any batch went out.
2. Start log capture on all 8 replybot pods (they hold ~4 h, and a busy pod writes ~15k
   lines per 45 min, so capture beats grepping after the fact).
3. Drive **two or three** question-to-batch exchanges on the 202 number. One burst is not
   enough — the bug hit 2 of 3 bursts on 2026-08-14.
4. For every `delivered`/`read` event in the burst, read its `STATE:` line.

Secondary evidence if it still will not reproduce: scribble consumer lag around the
incident window (prometheus was unreachable at the time of writing).

---

## 7. Worth doing regardless: the state store has no concurrency control

```js
const state = await stateStore.getState(userId, event)   // GET
...                                                       // compute
await stateStore.updateState(userId, report.newState)     // SET, unconditional
```

A read-modify-write of an entire conversation against a shared key, with no version, no
CAS, no conditional write. Any interleaving from any source — the mechanism we have not
identified, a future rebalance, a consumer added later, a retry — is silently lost, and
surfaces days later as a participant re-sent the same five messages every 30 minutes.

Carrying a monotonically increasing `version` in the state and making the write
conditional on it (a small Lua script, or `WATCH`/`MULTI`) converts this class of bug from
silent corruption into a **conflict counter** — and would answer §5 empirically: if
conflicts are non-zero, something is interleaving, and the metric says how often.

This is the one item here that does not depend on knowing the mechanism.

---

## 8. Options once the mechanism is known

Recorded so they are not re-derived, **not chosen**:

1. **Drop the events.** Categorize `bot_message_delivered` / `bot_message_read` as ignored
   at the normalizer. Zero consumers today, ~60% fewer events through replybot. Cheapest;
   loses the option value of receipts.
2. **Keep them, make them non-authoritative.** Route watermarks to a side channel (their
   own table, or a `delivery` column on `states`) written by a small consumer, never
   through `exec`/`apply`. Preserves genuinely useful delivery telemetry without giving
   receipts write authority over the conversation.
3. **Keep them in the machine, make the write partial.** `WATERMARK` returns a field-level
   update applied as a merge rather than a whole-object write. Correct, but makes the
   state-write path conditional in a way nothing else is, and leaves the underlying
   stale-read problem live for every other handler.

Leaning (2), falling back to (1). The invariant to establish either way: *only events that
can change the conversation may write the conversation.* Receipts, by definition, cannot.
