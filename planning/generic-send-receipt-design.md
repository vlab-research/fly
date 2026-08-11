# Generic Send Receipts — replacing metadata echoes with id correlation

**Status:** Design proposal, not yet agreed. Written 2026-08-06.

**Motivation:** the current design advances the conversation off an *echo carrying
our own metadata*. That works on Messenger because Messenger happens to round-trip
a custom `metadata` string. It does not generalise: WhatsApp has no echo of our own
API sends, so `message-worker` synthesises a fake one (`worker.go:164`,
`emitWhatsAppEcho`). Every future platform will need its own bespoke answer to
"how do we get our metadata back".

The proposal: stop relying on metadata round-tripping. Correlate on the **platform
message id**, which every platform returns on send and quotes back in its receipt.
Our metadata stays on our side of the boundary.

---

## 1. Platform capability matrix

Researched 2026-08-06. Confidence noted per row — this table is the load-bearing
input to the design and two cells are unverified.

| Platform | Receipt for our outbound messages | Returns our `metadata`? | Correlatable message id | Confidence |
|---|---|---|---|---|
| **Messenger** | `message_echoes` webhook field | **Yes** — `metadata`, the custom string passed to Send API, present only if set | `mid` (always present on echoes) | High — documented |
| **WhatsApp** | `statuses[]` on the `messages` field: `sent` / `delivered` / `read` / `failed` | **No** | `id` (wamid) — always present | High — documented, and already normalized at `event-normalizer.js:310-317` |
| **Instagram** | No separate `message_echoes` field; echoes of the business's own sends arrive folded into the `messages` subscription | Unverified | Yes (message id) | Medium — the "no separate field" part is documented; the metadata behaviour is not |
| **TikTok** | Business Messaging webhooks cover sending and receiving DMs; aggregators surface read receipts and status events | Unverified | Unverified | **Low** — TikTok's event-type list sits behind a portal that isn't publicly readable. Must be confirmed against the real console before TikTok is designed for |

Two secondary findings worth carrying forward:

- **Messenger `message_deliveries` is not a reliable correlation source.** `watermark`
  is always present but `mids` is only *sometimes* present, for backwards
  compatibility with older clients. Correlation on Messenger must use **echoes**
  (where `mid` is guaranteed), not deliveries.
- **WhatsApp's `message_echoes` / `smb_message_echoes` field is not what its name
  suggests.** It reports messages the business sends *from the WhatsApp Business app
  or a linked device* — a human typing on the phone — not echoes of our Cloud API
  sends. It also requires `whatsapp_business_management` with Advanced Access via
  App Review. It is not a substitute for anything here.

**The shape of the gap:** Messenger is the outlier, not the template. It is the only
platform that hands our own metadata back to us. Designing around that was reasonable
when Messenger was the only platform; it does not survive contact with a second one.

---

## 2. Proposed design

Replace "receipt carries metadata" with "receipt carries an id we can look up".

### Two events

**Event 1 — `message_sent` (ours, emitted by message-worker).**
Emitted immediately after a successful send, carrying the platform message id
returned by the send call *and* the metadata that currently rides on the echo:

```
{ command_id, conversation_id, user_id, platform, platform_account_id,
  platform_message_id, metadata }
```

This is the record that binds `platform_message_id → metadata`.

**Event 2 — the platform receipt (theirs, ingested by hermes).**
`message_echoes` on Messenger, `statuses[].status == "sent"` on WhatsApp, the
folded echo on Instagram. Carries the platform message id and nothing of ours.

The consumer joins event 2 to event 1 on `platform_message_id`, recovers the
metadata, and emits the `bot_message_sent` the state machine already understands.
The ECHO handler does not change.

### What this buys

- New platforms need only "returns an id on send" + "quotes the id in a receipt" —
  a much weaker requirement than "round-trips an arbitrary string".
- `emitWhatsAppEcho` and its synthetic-event special case can eventually be deleted.
- We start advancing on **real delivery evidence** rather than on our own assertion
  that we sent something, which is a prerequisite for the ordering work in
  `whatsapp-media-send-path-findings.md` (option C).

### Prerequisite: we currently discard the id

`worker.go:144` throws away the send response (`_, sendErr :=`), and `emitMessageSent`
is commented out at `worker.go:170-171`. The WhatsApp client does parse
`messages[0].id` (`whatsapp_client.go:118`) and the Messenger client returns a
message id, so the value exists — it is discarded one layer up. **Nothing in the
system currently persists a platform message id.** That is step zero.

---

## 3. Race conditions

These are the substance of the work. The happy path is trivial; these are not.

**3.1 — Receipt arrives before our `message_sent` is committed.**
The likeliest and most damaging. Meta knows the message id at the moment it responds
to our POST; its `sent` webhook can fire before message-worker has finished producing
event 1. The two events are produced by *different services* (message-worker and
hermes) — Kafka orders within a partition by broker arrival, so co-keying by user id
gives no causal guarantee here. A naive join drops the receipt.

Mitigations, in rough order of preference:

- **Pending buffer with TTL** in the consumer: an unmatched receipt parks keyed by
  `platform_message_id` and is retried when event 1 lands. Needs an eviction policy.
- **Synchronous mapping write** before the send is acknowledged: message-worker
  writes `platform_message_id → metadata` to Postgres before returning. Narrows the
  window to the DB write but does not close it, and adds a write to the send path.
- **Idempotent join in either direction** — whichever arrives second triggers the
  emit. Symmetric, no buffer eviction problem, but requires the join state to be
  durable.

**3.2 — Duplicate and multi-stage receipts.**
WhatsApp emits `sent`, then `delivered`, then `read` for the same id. Only `sent`
should advance the conversation; the rest are watermarks. Meta also retries webhooks,
so exact-duplicate `sent` receipts are expected. The join must be idempotent per
`(platform_message_id, status)`.

**3.3 — The existing double-`bot_message_sent` collision.**
`event-normalizer.js:302` maps the synthetic `bot_echo` to `bot_message_sent`, and
line 315 maps a real WhatsApp `sent` status to `bot_message_sent` as well. During any
migration where both are live, the state machine receives **two** advance signals per
outbound message. This must be resolved before real `sent` statuses are wired up —
either by removing the synthetic echo in the same change, or by gating one of them.

**3.4 — Send retries produce multiple ids for one command.**
`RetryWithBackoff` (`worker.go:144`) retries on ambiguous failures. A send that
timed out client-side but succeeded server-side, then retried, yields two real
messages and two receipts for one logical command. Today this double-delivers to the
user; under the new design it would also double-advance the state machine. Needs a
per-`command_id` guard on the emit.

**3.5 — Receipt never arrives.**
The failure mode that argues *against* deleting the synthetic echo. A webhook can be
lost: subscription not configured, delivery failure, Meta drops it. If the state
machine only advances on a real receipt, one lost webhook stalls that conversation
permanently. Note `whatsapp-onboarding.md:170` — nothing in this repo subscribes a
WABA to the `messages` field; it is a manual console step, so a new number is one
missed checkbox away from every conversation on it hanging.

Any design that removes the synthetic echo **must** ship a timeout fallback.

---

## 4. Open questions

1. **Where does the join state live?** Postgres (durable, adds a send-path write),
   a Kafka compacted topic (natural fit, adds a stateful consumer), or Redis (fast,
   another dependency, and loses the mapping on eviction).
2. **What is the timeout for 3.5, and what happens when it fires?** Advance anyway
   (risking advancing on a message that never sent), or error the conversation?
3. **Does Instagram's folded echo carry `metadata`?** If yes, Instagram could stay on
   the current mechanism and this becomes a WhatsApp-and-beyond change rather than a
   platform-wide one. Cheap to check in the console.
4. **Does TikTok expose a per-message send receipt with a stable id at all?** If not,
   TikTok needs the synthetic-echo approach permanently, and the "delete
   `emitWhatsAppEcho`" goal becomes "keep it as the documented fallback path".
5. **Do we migrate Messenger?** It works today and carries all production traffic.
   Leaving it on native metadata echoes is lower risk; migrating it is what makes the
   design actually generic. This is a scope decision, not a technical one.
6. **Does the ECHO handler tolerate a delayed advance?** The synthetic echo is
   immediate; a real receipt is a round trip later. Whether that changes observable
   pacing between questions is untested.

---

## 5. Related

- `planning/whatsapp-media-send-path-findings.md` — the ordering bug that surfaced
  this. Note that doc's §7 open question 2 assumes no `sent` webhook exists; it does.
- `documentation/platform-abstraction.md:367-369` — the existing WhatsApp status
  mapping table.
- `message-worker/worker.go:144-171` — where the message id is discarded and
  `emitMessageSent` is disabled.
- `replybot/lib/event-normalizer.js:296-326` — the synthetic echo branch and the
  status branch that currently collide.
