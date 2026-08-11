# Synthetic echoes on every platform

Replace Facebook's `message_echoes` webhook with an echo that message-worker emits itself,
so the state machine's forward progress no longer depends on a platform round-trip.

## Status

Steps 1–5 implemented on branch `feature/synthetic-echo` (worktree `../fly-synthetic-echo`).
Not committed, not deployed. Steps 6 and 7 are unstarted by design — 6 needs the deploy,
and 7 is sequenced after it.

Deviations from the plan as written, all noted in place below:

- **Step 3's alert is not built.** Retry (5 attempts, `AlwaysRetriable` because
  `IsRetriable` rejects every Kafka produce error) and an `Error` log landed; the alert
  itself is deferred. See "Alerting" under step 3.
- **`event_type: 'platform_echo'`** was needed for step 4. Simply unmapping `is_echo`
  would have made it `UNKNOWN`, which no-ops correctly but logs every event it sees —
  at echo volume that is a lot of noise. `PLATFORM_ECHO` is an explicit quiet no-op.
- Two touchpoints the plan did not name: `machine.js` (the category above) and the
  handoff pipeline test in `machine.test.js`, which drove the machine off a raw Facebook
  echo and had to switch to the synthetic one.

Verification: message-worker `go test ./...` green; replybot 423 passing / 0 failing
(from 412 passing / 2 failing at the start); exporter 87 passed / 12 skipped.

## Why

`RESPONDING` is exited by exactly one transition — `WAIT_RESPONSE`, emitted only from the
`ECHO` handler (`replybot/lib/typewheels/machine.js:445`, return at `:490`). On Messenger that
echo is Facebook's `is_echo` webhook. If it never arrives, the user is pinned in `RESPONDING`,
and dean's respondings sweep re-sends to them every 30–60 minutes until a send fails and they
are marked `BLOCKED`. See "The RESPONDING/Echo Trap" in `documentation/states-debugging.md`.

WhatsApp has no native echo and already solves this: message-worker publishes a synthetic
`bot_echo` after a successful send (`message-worker/worker.go:164`, `emitWhatsAppEcho` at
`:179`). That path is strictly more reliable, because the signal is produced locally by the
component that knows whether the send succeeded.

Echo unreliability is not hypothetical. `planning/responding-state-fb-changelog-investigation.md`
(May 2026) documents Facebook apparently not echoing `user_phone_number` quick replies, with no
authoritative documentation available on when echoes fire at all.

**The swap is safe by construction.** The `ECHO` handler is a pure function of `md`
(the outbound message's own metadata) and `state`. Every branch keys on `md.repeat`,
`md.type`, `md.stitch`, `md.wait`, `md.keepMoving`, `md.ref` — nothing Facebook-specific is
ever read off the echo. A synthetic echo carrying the same metadata is behaviourally identical,
and WhatsApp already exercises all of these branches in production.

## Decision

Emit the echo ourselves on every platform. Stop consuming Facebook's.

Do **not** run both as the steady state: `md.stitch` routes the user into another form via
`_stitch`, and firing that twice is not idempotent. (`WAIT_RESPONSE` is idempotent, and
`HANDOFF`/`WAIT_EXTERNAL_EVENT` preserve `waitStart || nxt.timestamp`, so those two are safe —
but stitch alone is enough to rule out a permanent double-echo world.) A bounded parallel run
during verification is fine and is covered below.

### On the name

`echo` is inherited from Facebook's term and is now slightly wrong — the event is no longer a
reflection of something the platform saw, it is our own send confirmation. It is not wrong
enough to be worth a rename inside this change. Revisit once the migration has settled.

## Change set

Ordered so that every step before the last is reversible with a deploy.

### 1. Carry content on the synthetic echo

`message-worker/worker.go:179` — `emitWhatsAppEcho` currently publishes only
`{source, phone_number_id, from, type, metadata, timestamp}`. **No message text.** That is
sufficient to advance the state machine and insufficient to reconstruct a transcript.

Add the rendered outbound content. Rename to drop the WhatsApp specificity.

### 2. Emit for all platforms

`message-worker/worker.go:164` — remove the `if cmd.Platform == types.PlatformWhatsApp` guard so
the echo is emitted after any successful send.

Note `emitMessageSent` (`:272`) is not a substitute and should not be revived for this: it omits
`Message.Metadata`, which is the only thing the `ECHO` handler reads.

### 3. Make a failed echo publish loud

Also `worker.go:164`. Today a failed publish is a swallowed `Warn`, justified in-comment as
"it stalls the state machine, not the delivery." That trade is defensible while it is one
platform's fallback. It is not defensible once it is the sole path to `QOUT` for the whole
system — a dropped publish becomes a permanently stalled user, with the redundant signal now
removed.

The publish must be retried and must alert on persistent failure. It should not fail the send
command itself (the message really was delivered; replaying would double-send).

**Done:** `EchoRetryConfig` (5 attempts, ~3s bounded so it doesn't stall the consumer) under a
new `AlwaysRetriable` predicate — `IsRetriable` would have rejected *every* Kafka produce error,
since none are `*PlatformError` or a recognised syscall error, so reusing `RetryWithBackoff`
as-is would have retried nothing. Persistent failure logs at `Error`.

**Alerting — still open, and it gates step 7.** message-worker has no Prometheus
instrumentation at all (bare `/healthz` mux, no Service, no ServiceMonitor), so a counter on
this code path is a real infra change. The better instrument is a sql-exporter gauge on the
`RESPONDING` population plus a rule in `devops/alerts/`:

- `RESPONDING` means the bot is waiting on **itself**, never on the participant (that is
  `QOUT`), so the age of that population *is* echo latency — not a proxy for it.
- A publish-failure counter covers one failure mode. Once the synthetic echo is the sole path
  to `QOUT`, a participant also stalls if replybot's consumer lags, the normalizer regresses,
  the metadata hits a no-op branch, or the worker dies between the 200 and the publish. None
  of those increment the counter; all of them show up as `RESPONDING` growth.
- It is the same measurement step 6 is written in terms of, so it is needed either way.

### 4. Reclassify in the normalizer

`replybot/lib/event-normalizer.js:49` — Facebook's `is_echo` stops mapping to
`bot_message_sent`. Only `bot_echo` (`:300`) does.

Keeping `is_echo` ingested but inert during the parallel run is what makes step 7 safe to defer.

### 5. Exporter branch

`exporter/exporter/exporter.py` — `classify_event` has branches for `source == "messenger"` and
`source == "synthetic"` and **none for `whatsapp`**; those fall through to `"unknown"`.
`get_direction` returns `"bot"` for exactly one type, `"echo"`.

**This means WhatsApp conversation exports today contain the participant's side and nothing the
bot said.** That is a pre-existing bug, independent of this migration, and this change fixes it
as a side effect — but only if step 1 lands, since there is no content to export otherwise.

Add a branch that classifies the synthetic echo as bot-direction content.

### 6. Verify in parallel

With steps 1–5 deployed, Facebook echoes are still arriving and still being logged, but no
longer drive the machine. Confirm over several days:

- states advance `RESPONDING → QOUT` at the same rate and latency as before
- the `RESPONDING` population does not grow
- no rise in dean redo volume
- exported transcripts contain the bot side on both platforms

### 7. Unsubscribe `message_echoes`

`dashboard-server/api/facebook/facebook.controller.js:24-32` — remove `message_echoes` from
`subscribed_fields`.

**This is not sufficient on its own.** That array is POSTed to `/{pageid}/subscribed_apps` when a
page is connected, so editing it only affects newly connected pages. Existing pages remain
subscribed until re-POSTed individually with a page token.

Per the IaC rule, the re-subscription pass needs a committed script in `devops/` that reads page
tokens from credentials and re-POSTs `subscribed_apps` for each page, rather than ad-hoc calls.

Do this last and separately. Everything before it is reversible in a deploy; this makes the
synthetic path load-bearing with no fallback.

## Rollback

Steps 1–5: revert the normalizer change (step 4) and Facebook's echo resumes driving the
machine, since it is still being ingested.

After step 7: rollback requires re-subscribing the pages, which is the same script in reverse.
This is why it is sequenced last.

## Open questions

- ~~**Third-party page messages.**~~ **Resolved.** `is_echo` fires for anything sent on the
  page, including human agents in Business Suite and other apps, and our synthetic echo only
  fires for our own sends — but nothing depended on the difference. A third-party message
  carries no `metadata`, so it reached the `ECHO` handler as `md === undefined` and hit
  `if (!md || ...) return _noop()` on the first branch. It was already a no-op before this
  change. (Handover runs off `messaging_handovers`, a separate subscription, as expected.)
- **Semantics.** `is_echo` means "the message exists on the platform"; ours means "the API
  accepted it." Delivery and read watermarks still come from the platform independently, so the
  stronger claim remains available where it matters.
- **Backfill.** Users currently pinned in `RESPONDING` (815 platform-wide) will not be rescued by
  this change. They need a separate one-off reconcile.

## Found while implementing, out of scope

**`chat_log` capture has been dead since Jul 2026.** `replybot/lib/chat-log/publisher.js` was
deleted in the platform-abstraction refactor (`675c31bd`) and nothing replaced it — no code
reads `VLAB_CHAT_LOG_TOPIC`, though the env var and the scribble `chat-log` sink are both
still deployed, and `documentation/chat-message-logging.md` still described the pipeline as
live. The table and its CSV export hold nothing written after that commit.

Unrelated to this migration except that both concern the bot side of a transcript: with step 1
landed, the Full Messages export now covers that ground on both platforms. The doc has a
status warning on it; no decision made about restoring or retiring the feature.

## Not in scope

The dean retry-policy work (per-condition timing, an explicit action verb distinguishing
`resend` from `reconcile`, and a real terminal state) is a separate piece. This change
deliberately lands first because it makes absence rare, which is what determines how much of
that policy language actually needs to exist.
