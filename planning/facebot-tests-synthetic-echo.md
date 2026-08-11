# Facebot integration tests after the synthetic-echo migration

Companion to `planning/synthetic-echo-migration.md`. That change is implemented on
`feature/synthetic-echo`; this is the test-harness work it forces.

Read `facebot/testrunner/README.md` first — it is accurate and detailed, and this plan assumes it.

## Status — items 1 and 2 are DONE, the rest is open

Measured across three full `npm run test:tc` runs on `feature/synthetic-echo`:

| Run | `flowMaster` behaviour | Result |
|---|---|---|
| 1 | untouched (fake echo, now inert; no wait) | **35 passing, 1 failing, 9m** — `stitched forms: stitches and maintains seed` blew its 45s timeout |
| 2 | fake echo removed, poll `states` until not `RESPONDING` | **34 passing, 5 failing, 8m** — a regression |
| 3 | fake echo removed, fixed 1s wait on answer steps | **39 passing, 0 failing, 6m** ✅ |

Run 3 is the current state of the branch: all 36 pre-existing tests green, plus the 3 new ones,
and faster than run 1 despite adding work. The stitch test that failed in run 1 now passes in
23.7s.

**Every failure in every run was a mocha timeout, never an assertion.** Nothing broke logically at
any point: message-worker's real echo was already flowing through this stack, so `flowMaster`'s
fake one had simply become redundant, and the Messenger tests kept passing without it.

Two things I got wrong on the way, both worth knowing before touching this again:

- **The slowness is not caused by the migration.** Individual tests run 13-20s in *both* run 1 and
  run 2, i.e. with and without the echo race. The README's "warm ~30s" refers to container start,
  not to the suite. Do not treat 15s tests as evidence of a timing bug you introduced.
- **Polling `states` to detect settling is a trap.** It is the obviously "correct" version of the
  wait and it made things measurably worse: `does not allow retaking of forms even after switching`
  went 18.1s → 41.1s, `Normalizes messy phone input` 11.5s → 18.8s, and four more tests crossed
  their mocha timeout. The reason is that scribble writes `states` in batches
  (`SCRIBBLE_BATCH_SIZE: 32`, `KAFKA_POLL_TIMEOUT: 2s`), so the row lags the real state by seconds
  and the poll pays that lag on every single answer step. `flowMasterWhatsApp` has always used a
  fixed `snooze(1000)` on the platform that never had a native echo — that is the empirically
  validated pattern here, and it is what `settle()` now does.

The margin on these tests is thin: even in the green run, `Test chat flow with validation failures`
took 41.9s and `Waits for external event and continues after event` 41.8s, against a 45s limit.
Those two are three seconds from flaking. That is the real constraint on this harness, and it is
worth fixing on its own — see "Open question" below.

**Done in this branch:**
- Item 1 — `flowMaster` no longer synthesizes an echo; it waits for the conversation to leave
  `RESPONDING` before sending an answer. `flowMasterWhatsApp`'s `snooze(1000)` replaced by the same
  helper. `useChatbase()` added to `socket.ts`, called from both suites' setup.
- Item 2 — `makeEcho` kept and repurposed; `expectNothingSent()` added to `socket.ts`.
- A `scribble` **messages sink** added to the stack (`stack.ts`), so tests can assert on the
  `messages` table the Full Messages export actually reads. ~15 lines; no new image.
- Three tests added under `Synthetic echo E2E` in `test.tc.ts` (see bottom of this doc).

**Still open: items 3-6 below.**

## The whole problem, in one line

`flowMaster` fabricates Facebook's echo:

```ts
// facebot/testrunner/socket.ts:182-184
if (!('error' in res)) {
  await sendMessage(makeEcho(get, userId));
}
```

`makeEcho` builds a `message.is_echo` webhook. After the migration the normalizer maps that to
`platform_echo`, which the machine treats as a deliberate no-op. So this line no longer advances
anything, and **every Messenger test that has more than one step depends on it** to leave
`RESPONDING`.

## Why this is much smaller than "redo facebot"

The harness already contains a correct post-migration driver. `flowMasterWhatsApp`
(`socket.ts:122`) was written for the platform that never had a native echo, and its comment
states the new contract exactly:

> does NOT synthesize an echo: the WhatsApp send carries no metadata to echo, so the
> message-worker emits the bot_echo itself.

The stack is already wired for it, too — message-worker publishes `KAFKA_EVENT_TOPIC:
'chat-events'` (`stack.ts:377`), which is the same topic replybot consumes as
`BOTSPINE_MESSAGE_TOPIC` (`replybot/kube-dev/dev.yaml:52`). **No new container, no new topic, no
facebot receiver change.** The real echo has been flowing through this stack all along; it was
simply redundant on Messenger, where `flowMaster` also injected a fake one.

So the work is: **make `flowMaster` behave like `flowMasterWhatsApp`, and let the two converge.**
Nothing about the facebot mock itself (`facebot/receiver/index.js`) needs to change — it mocks the
Graph API send endpoint, and sends are unaffected by this migration.

## Work items

### 1. `flowMaster`: stop faking the echo, wait for the real one — **DONE**

The `makeEcho` call is gone. Something had to replace it, because of a genuine ordering hazard:
the next user answer (`gives`) and the worker's echo are published by **different producers**
(hermes vs message-worker) to the same topic. Kafka only orders within a producer, so if the
answer wins the race the machine sees it while still in `RESPONDING`. That race is what made the
pre-fix run take 9 minutes.

`settle()` in `socket.ts` is that wait: a fixed `snooze(1000)`, the same thing
`flowMasterWhatsApp` has always used. See the status section for why the state-polling version was
tried and reverted.

**One subtlety, load-bearing — do not "simplify" it away:** the wait runs **only when there is an
answer to send** (`gives.length`). A statement's echo deliberately no-ops in the ECHO handler
(`md.type === 'statement'` returns `_noop()`), so the conversation *stays* in `RESPONDING` across a
statement step — there is nothing to wait for, and with no answer following, nothing racing either.
Waiting unconditionally just adds a second per message for no reason, and this suite has no
seconds to spare.

**Remaining here (not done):** `flowMaster` and `flowMasterWhatsApp` now differ *only* in how they
pull visible text out of the send envelope (`data.message` vs `waSentText(data)`). Collapsing them
into one driver parameterized by that extractor is the natural end state.

### 2. Keep `makeEcho` — its job changes from fixture to adversary — **DONE**

It was not deleted. Post-migration it is the only way to express "a platform echo arrives and must
do nothing", the safety property that makes a permanent both-echoes world impossible (`md.stitch`
is not idempotent). The second new test uses it exactly that way.

**Remaining here:** update `makeEcho`'s doc comment in `mox.ts` to say so — right now nothing at
the definition site tells you it is no longer part of the normal flow. Note also that
`test.tc.ts`'s payment-failure test passes `makeEcho(get, userId)` as a `gives` element; that is
now a no-op event injected into the stream. The test still passes, but the line no longer means
what it did — decide whether it should stay.

If a test ever needs to inject a worker-shaped echo directly rather than let message-worker
produce one, add a `makeSendEcho(field, userId, platform)` alongside it — flat
`{source, account_id, from, type: 'bot_echo', metadata, text, timestamp}`, per
`message-worker/echo.go`. None of the current tests need it; the point of an integration test here
is to let the real worker emit it.

### 3. `test.ts` (k8s smoke) gets the same fix

Four tests, three of which use `flowMaster`. Same change, no additional thinking — but it cannot
be verified without a dev cluster, so land it with the `test.tc.ts` work and confirm on the next
cluster run.

### 4. Re-check the `Timeouts` block specifically

These call `triggerDean()` between `flowMaster` calls, and dean's followups query only matches
`current_state = 'QOUT'`. The README already warns about this race. The migration changes *when*
QOUT is reached (now gated on a real Kafka round-trip through message-worker rather than an
immediate HTTP post from the test process), so these are the likeliest tests to become flaky.
Once item 1 is in, the `waitFor` on non-`RESPONDING` largely subsumes the hazard, but verify each
of the five timeout tests individually rather than trusting a green run once.

### 5. `mox.ts` metadata subtlety

`makeEcho(get, ...)` echoes the metadata of the **expected** field the test declared. The worker's
echo carries the metadata of the **actual** command replybot emitted. These should be identical —
and if they ever weren't, the old harness silently papered over it while the new one will not.
That is an improvement, but it means a failure here is a real finding, not a harness bug. Read
carefully before "fixing" one.

### 6. README

`facebot/testrunner/README.md` documents the old behaviour in two places: the numbered
`flowMaster` list ("On every non-error (`ok`) interaction, send a synthetic echo…") and the
`mox.ts` row in the Key Files table. Both need rewriting. The `flowMasterWhatsApp` design note
about "WhatsApp has no native echo" should become "no platform echo drives the machine any more".

## The three tests added

Under `parallel('Synthetic echo E2E')` at the bottom of `test.tc.ts`. They are deliberately driven
with raw primitives rather than `flowMaster`, so they keep proving the property even if the driver
changes again.

1. **`Advances a Messenger conversation on the send echo alone`** — referral, take the question off
   facebot, ack it, assert `QOUT`. Nothing in the test ever sends a Facebook `is_echo`. `QOUT` is
   reachable only via `WAIT_RESPONSE`, which only the `ECHO` handler emits, so reaching it *is* the
   proof the worker's echo was produced, delivered and understood.
2. **`Ignores Facebook's is_echo: it cannot fire a stitch`** — the safety property. Once settled in
   `QOUT`, inject a Facebook echo carrying `md.stitch`, the one branch that is not idempotent.
   Assert the state and form are unchanged and that nothing was sent (`expectNothingSent`).
3. **`Publishes an echo carrying the rendered text, so exports have a bot side`** — asserts the
   `bot_echo` row in the `messages` table has `source`, `text` and `metadata.ref`. This is the
   table the Full Messages export reads, so it covers the real transcript path rather than a proxy.
   Needed the new messages sink.

## Order of remaining work

1. Item 3 (`test.ts`), item 5 (metadata subtlety), item 6 (README) — none can break `test.tc.ts`.
2. Item 4 (`Timeouts` re-verification) — needs repeated runs, not a code change.
3. The driver collapse noted under item 1, last, since it touches every test.

## Open question worth its own piece of work

**This suite has almost no timing headroom, and that is not the migration's fault.** Passing tests
routinely take 13-22s against 45s limits; one took 41s. Any per-step cost anyone adds, for any
reason, will push the slowest few over and produce a scatter of unrelated-looking timeouts — which
is exactly what run 2 did, and exactly what makes triage here expensive.

Worth investigating separately: where the 13-20s per test actually goes. A conversation round trip
in this stack should be well under a second, and the WhatsApp tests (6-11s) are meaningfully faster
than the Messenger ones for no obvious structural reason. Suspects: scribble's batch/poll settings
(`SCRIBBLE_BATCH_SIZE: 32` with a 2s `KAFKA_POLL_TIMEOUT` means a low-volume test always waits out
the poll), `mocha.parallel` contention on a single-broker redpanda with `--smp 1 --memory 200M`,
and facebot's 10s send timeout masking dropped acks. Fixing that would buy back far more
reliability than any further tuning of the echo wait.

## Verification

`npm run test:tc` from `facebot/testrunner`. Budget ~5-6 minutes of image builds on a cold cache
before any test runs — the README's "warm ~30s" refers to container start, not the whole command.
`KEEP_STACK=1` leaves the stack up for inspection.

Do not accept a single green run for the `Timeouts` block — run it several times. The failure mode
there is a race, not a logic error, and the pre-fix run demonstrated that this suite expresses
races as timeouts in whichever test happens to be nearest its limit. That is worth remembering
when triaging: **a timeout here is far more likely to be a timing regression somewhere upstream
than a bug in the test that reported it.**
