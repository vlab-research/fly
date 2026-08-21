# Facebot Integration Tests

The testrunner provides a primary integration test suite using **Testcontainers** (local Docker-based) and a secondary smoke test path against the dev **Kubernetes cluster**.

## Quick Start

```bash
npm install
npm run test:tc
```

This boots the full stack locally (database, Kafka, hermes, replybot, facebot, dean) and runs all functional tests. Warm runs take ~30 seconds.

## Architecture Overview

### Testcontainers Stack

The primary test mode (`test.tc.ts`) spins up a isolated Docker network with these containers:

- **CockroachDB** (`cockroachdb/cockroach:v24.1.0`) — persists form state, user responses, and dean job history
- **Redpanda** (`redpandadata/redpanda:v23.3.18`) — Kafka broker; routes messages and responses between services
- **Redis** (`redis:7-alpine`) — replybot's conversation-state cache. **Easy to overlook and load-bearing**: replybot treats Redis as the runtime source of truth for state (`replybot/lib/typewheels/statestore.js`) and only replays the event log on a cache *miss*. Its mapped port is on `stack.redisUrl` so a test can assert on key shape directly.
- **Hermes** — webhook entry point (Rust; drop-in replacement for the deprecated Node botserver); receives Facebook messages and publishes raw `source`-tagged events to Redpanda. Runs under the `botserver` network alias, so downstream `http://botserver/*` URLs are unchanged.
- **Replybot** — subscribes to user messages, applies form logic, publishes state updates and question-to-send
- **Scribble (states sink)** — subscribes to state-update topic, writes to CockroachDB
- **Scribble (responses sink)** — subscribes to responses topic, writes to CockroachDB
- **Scribble (messages sink)** — archives the raw `chat-events` bodies into `chatroach.messages`. This is the **durable event log replybot replays from on a cache miss**, so without it every replay reconstructs from an empty history and any replay-scoped assertion passes vacuously. Config: `scribble/kube-dev/messages.yaml`.
- **Scribble (chat-log sink)** — consumes `vlab-chat-log` into `chatroach.chat_log`. Replybot has always produced to this topic in the harness; until this sink existed nothing consumed it.
- **Formcentral** — resolves `(account_id, shortcode)` → survey; replybot calls it for every form lookup
- **Dinersclub** — payment processor; consumes `vlab-payment`, posts results back through hermes `/synthetic`
- **Message-worker** — consumes `commands`, translates per platform, and sends to the facebot mock. Pinned to `NUM_WORKERS: 1` (see the un-acked-send warning below).
- **Facebot receiver** — mocks the Facebook Graph API *and* the WhatsApp Cloud API; captures outbound sends and lets tests poll and reply
- **Dean** — triggered on-demand per test; processes overdue followups, updates CockroachDB, publishes new questions

All containers share a Docker network. Environment variables come from k8s YAML files (parsed by `loadKubeEnv()`), with Docker hostnames substituted for k8s service names (e.g., `cockroach:5432` instead of `cockroach.default.svc.cluster.local`).

**Kafka is deliberately not exposed to the host.** Redpanda advertises `PLAINTEXT://redpanda:9092`, which only resolves inside the Docker network — a host client connects, is redirected to a name it cannot resolve, and fails. Rather than juggle two listeners and a not-yet-known mapped port, tests that need to read a topic use `consumeTopic(stack, topic, opts)` from `stack.ts`, which shells out to `rpk` *inside* the container.

**Bookmark the topic before you act on it.** `consumeTopic` takes either
`{ from: <offsets> }` — a snapshot from `topicEndOffsets(stack, topic)` taken *before*
the activity under test — or `{ newest: N }`. Prefer the bookmark:

```typescript
const since = await topicEndOffsets(stack, 'chat-events');
// ... drive the flows ...
const records = await consumeTopic(stack, 'chat-events', { from: since });
```

It reads exactly what your test produced, so its cost does not grow with the suite.
This is not a style preference: the helper used to read the *oldest* 500 records
unconditionally, and once `chat-events` passed a high watermark of 556 the one test
that used it (B1-4, which runs near the end of the suite) stopped seeing its own
events and failed as a bare 120s mocha timeout. Any "first N records" read of a topic
this suite keeps appending to has the same expiry date.

### Test Modes

#### Primary: Testcontainers (`npm run test:tc`)

- **When**: Local development, CI, any functional test
- **Speed**: Cold start ~60s (image builds), warm ~30s (containers only)
- **Isolation**: Full—each test run is independent; no shared state with other developers or cluster
- **Dean behavior**: Triggered on-demand via `triggerDean()` per test; no waiting for cron jobs
- **Timeout tests**: ~2 seconds (vs. ~180 seconds on real cron schedule)

#### Secondary: k8s Smoke Tests (`./dev.sh`)

- **When**: Verifying helm chart updates, service DNS, or cluster-specific deployment
- **Speed**: Slower; depends on dev cluster availability and state
- **Coverage**: Genuinely minimal by design — 4 tests, not a clone of `test.tc.ts`:
  1. Referral → first question (DNS/wiring smoke test — proves the deployed services actually talk to each other)
  2. A real dean **CronJob** timeout — deliberately does NOT call `triggerDean()`; it waits for the cluster's actual scheduled cron to fire, which is the one thing testcontainers structurally can't verify
  3. Delivery error → `BLOCKED` state
  4. A stitched-forms flow
- **Dean behavior**: Real CronJob; the timeout test waits (up to its 180s mocha timeout) for scheduled execution
- **Target**: Kept for validation only; primary logic coverage is in testcontainers. (`test.ts` previously duplicated almost all of `test.tc.ts`'s tests against the live cluster; it has since been trimmed to this minimal deployment-smoke set — see the header comment at the top of `test.ts`.)

## Writing Tests

### Basic Pattern: flowMaster

Use `flowMaster(userId, expectedInteractions)` to simulate a user conversation:

```typescript
const userId = 'user-123';
const ok = { code: 200 };

// Send a referral and check the first question
await sendMessage(makeReferral(userId, 'formId'));
await flowMaster(userId, [
  [ok, 'What is your name?', []]  // expected: 200 OK, receive question, no media
]);

// User responds
await sendMessage(makeMessage(userId, 'My name'));
await flowMaster(userId, [
  [ok, 'What is your age?', []]   // expected: receive next question
]);
```

`flowMaster` does:
1. Poll the facebot receiver's HTTP endpoint for queued messages
2. Match received messages against expected structure (status, text, media list)
3. Assert field order and content
4. On every non-error (`ok`) interaction, send a synthetic echo of the message back into the pipeline (`makeEcho`) — this is what arms replybot's `WAIT_EXTERNAL_EVENT` state for flows that wait on an external event (e.g. handoff/handover); you don't send that echo yourself
5. Fail loudly if actual ≠ expected

Note: `flowMaster` also canonicalizes any JSON-string-valued fields (e.g. `metadata`) before comparing, so key ordering inside a stringified JSON blob doesn't cause spurious assertion failures.

### Building form fields: `getFields` vs `fieldsFromForm`

- **`getFields(path)`**: Reads a form fixture from `forms/*.json` on disk and runs it through the translator to produce the `Field[]` array tests assert against.
- **`fieldsFromForm(formObject)`**: Same translation, but takes an already-parsed form object instead of a file path. Use this for forms built or interpolated in memory — e.g. substituting a `{{hidden:...}}` placeholder into a form's JSON text via `mustache` and then parsing it — instead of writing a `temp*.json` scratch file to `forms/` and calling `getFields` on it. (`forms/temp*.json` is gitignored for any test that still needs a real file on disk.)

### Simulating a handover return: `makeHandover`

`makeHandover(userId, newOwnerAppId, previousOwnerAppId, metadata)` builds a `pass_thread_control` webhook payload — the return leg of the Handoff Protocol (see `replybot/HANDOFF_PROTOCOL.md`). Use it to simulate an external app (e.g. a human-handoff queue or a bot-to-bot echo service) handing thread control back with metadata, so the survey can resume with `{{hidden:e_handover_metadata_*}}` fields interpolated from that metadata. The facebot mock (`facebot/receiver/index.js`) implements `POST /me/pass_thread_control` so the message-worker's outbound handoff command itself succeeds during these tests.

### Timeout & Followup Tests: Dean Triggers

For tests that depend on dean (e.g., time-based followups), split the flowMaster calls around `triggerDean()`:

```typescript
const fields = [/* form fields */];
const userId = 'user-timeout';

// Send initial message and get first question
await sendMessage(makeReferral(userId, 'formId'));
await flowMaster(userId, [[ok, fields[0].question, []]]);

// User doesn't respond; trigger dean to process overdue followups
await triggerDean(stack.network, stack.deanImage, stack.deanEnv, 'followups');

// Now the followup message is queued
await flowMaster(userId, [[ok, fields[1].question, []]]);
```

**Key**: Each `triggerDean()` starts a fresh dean container, waits for completion, then stops it. This converts the ~180s cron wait into a ~2s imperative call.

**Watch out for the `QOUT` race**: dean's followups query only matches rows where `current_state = 'QOUT'`. If your test waits for "any state row" before calling `triggerDean(...)`, it can race the scribble upsert and dean will find zero overdue users. Always `waitFor` the specific `'QOUT'` state before triggering followups (see the inline comment above the followups test in `test.tc.ts`).

### Asserting the full outbound payload: `receiveSent` and `receiveAndEcho`

`flowMaster` only ever compares `data.message`, and `getFields` only returns
`translator(f).message` — so neither can see top-level fields like
`messaging_type`/`tag`, nor assert which *keys* a payload does and does not carry.
For those, use `receiveSent(userId)` (in `socket.ts`), which returns the full POST
body the worker sent and acks it.

`receiveAndEcho(userId)` (local to `test.tc.ts`) is `receiveSent` plus the echo
`flowMaster` would have sent, built from the metadata facebot actually received —
so a test can assert an arbitrary payload shape and still drive the conversation
forward without depending on the JS translator agreeing with the Go one.

**Consume every message your form produces.** The stack runs message-worker with
`NUM_WORKERS: '1'`, so one un-acked send blocks the only worker goroutine for
facebot's 10s timeout. Inside `mocha.parallel` that starves every other test in
the block, and it surfaces as a wave of unrelated 45s timeouts rather than a
failure in the test that left the message behind.

This is easy to violate without noticing, because it does not go red on its own.
Measured instance: the WhatsApp `cta_url` webview test consumed two of
`webviewTest.json`'s three sends and walked away from the thankyou screen. The
worker log showed a **12.1-second stall with six WhatsApp commands queued behind
it**, inside a block whose tests time out at 45s — so it never failed, it just made
every timing measurement in `WhatsApp E2E` noisier and moved the block closer to
the cliff with each test added. Count the fields your fixture emits; the `keepMoving`
and thankyou-screen sends are the ones people forget.

### Media resolution tests

`forms/media*.json` drive the media handle layer (`planning/media-abstraction.md`).
They follow the `multi-part-attachment.json` shape — the attachment config is a
JSON blob in a `statement` field's `properties.description` — and each ends in an
unanswered `multiple_choice`, which is where the conversation stops.

The fixture rows live in `seed-db.ts` (`media_asset` + `media_handle`, created by
`devops/migrations/24-media-assets.sql`, which `stack.ts` applies on boot):

| Asset UUID | Handle |
|---|---|
| `1111…1111` | Messenger, `account_id` = page `935593143497601`, `platform_media_id` `900000000000001`, no expiry |
| `2222…2222` | WhatsApp, `account_id` = phone_number_id `106540352242922`, `platform_media_id` `900000000000002`, expires +30d |
| `3333…3333` | none — the miss case, on both platforms |

The handle key is `(asset_id, account_id)` with **no platform component**, so the
seeded `account_id` must be exactly the platform account id the rest of `seed-db.ts`
creates credentials for. If they drift apart every lookup misses, and a miss is
not an error — it is the designed URL fallback, so the suite stays green while the
handle layer does nothing.

`stack.ts` sets `MEDIA_HANDLE_USE: 'true'` for message-worker. It defaults to
**off** (the feature ships dark), and with it off the three by-id tests fail while
the by-URL and legacy-`attachment_id` tests still pass — those are insensitive to
the flag by construction, since sending by URL is exactly what a disabled resolver
does.

### Parallel vs. serial test blocks

**Two blocks use `mocha.parallel`: `Basic Functionality` and `WhatsApp E2E`.** (The
README previously claimed only the first, which is why nobody expected the WhatsApp
block's failures to move around.)

| Block | Mode |
|---|---|
| `Basic Functionality` | **parallel** |
| `Timeouts` | serial |
| `Phone normalization via e164 transform` | serial |
| `WhatsApp E2E` | **parallel** |
| `Conversation identity: (platform, account_id, user_id)` | serial |

`mocha.parallel` blocks run their `it`s concurrently, so **failures inside them are
partly nondeterministic** — two consecutive runs of this suite gave 50 passing / 11
failing and 49 / 13, on identical code. That is expected variance from the two
parallel blocks, not flakiness to chase. When you are bisecting a failure, check
first whether it lives in a parallel block; if it does, an un-drained send in a
*neighbouring* test is a live hypothesis (see "Consume every message your form
produces" above).

The `Conversation identity` block is **serial by necessity**: every test in it drives
two conversations for one user id and asserts on shared Redis and DB state, so under
`mocha.parallel` (with message-worker pinned to `NUM_WORKERS: 1`) interleaved flows
would make failures unattributable. Blocks themselves always run in file order —
`describe`/`parallel` blocks never overlap each other, only the tests inside one
`parallel` block overlap. Don't assume tests elsewhere in the suite run concurrently
with each other.

### Adding Test Forms

Test form definitions live in `forms/*.json`. Each form is a JSON array of field objects:

```json
[
  {
    "question": "What is your name?",
    "type": "text",
    "required": true
  },
  {
    "question": "What is your age?",
    "type": "text",
    "required": false
  }
]
```

Add your form JSON to `forms/`, then reference it in tests:

```typescript
import * as myFormDef from './forms/my-form.json';

const formId = 'my-form';
// Seed the form into the test database
await seedDb.upsertForm(formId, myFormDef);

// Now tests can use it
await sendMessage(makeReferral(userId, formId));
```

The `seed-db.ts` module handles seeding; it upserts forms at test startup.

Notable existing fixtures: `forms/hiddenInterp.json` (a two-statement form used to prove runtime `{{hidden:...}}` interpolation, including a missing-field case) and `forms/handoffTest.json` (drives a full handoff/handover round trip — question, handoff statement, then a statement rendering `{{hidden:e_handover_metadata_*}}` fields after the survey resumes). `forms/temp*.json` is gitignored — prefer `fieldsFromForm(...)` over writing a scratch file for in-memory-interpolated forms (see above); only write a real temp file if a test genuinely needs the form to exist as a file on disk.

Two more fixtures close out the top production-coverage gaps identified in `planning/production-form-coverage-analysis.md`:
- `forms/choiceJump.json` — a `multiple_choice` question (`color`, choices `red`/`blue`) whose `logic` condition pairs a `field` var with a `choice` var (`{op:"is", vars:[{type:"field",...},{type:"choice",value:<choiceRef>}]}`), the dominant real branching idiom (69% of forms / 99% of users hit some form of logic jump). `getVar`/`getChoiceValue` (`replybot/lib/typewheels/form.js`) resolve the `choice` var to the picked choice's `label` and compare it against the answered `field`'s stored value (also a label — see `replybot/lib/generic-validator.js`). Answering **Red** jumps to `redTarget`, **Blue** to `blueTarget`; `redTarget` has an explicit `always` jump to a shared `thanksStatement` so the two branches are observably distinct at the very next field. See `Test chat flow with choice-condition logic jump` in `test.tc.ts`.
- `forms/webviewTest.json` — a `statement`-typed field carrying a `properties.description` blob of `{"type":"webview","url":...,"buttonText":...,"keepMoving":true}`. `addCustomType` (in `@vlab-research/translate-typeform`) swaps the field's effective `type` to `webview` based on that description, and `translateWebview` renders a Messenger button template opening the URL. Without `keepMoving: true`, a webview field behaves like a real question and blocks on `WAIT_RESPONSE` (see the `ECHO` case in `replybot/lib/typewheels/machine.js`) — there's no button-postback path for a `web_url` button, so a bare webview field would stall the flow forever. Pairing it with `keepMoving: true` makes it auto-advance like a `statement`, which matches how the flow needs to work in practice. See `Test chat flow with webview field` in `test.tc.ts`.

### Design note: why `mox.ts` uses `@vlab-research/translate-typeform`

`mox.ts` builds its *expected* messages using `@vlab-research/translate-typeform` — the older Facebook-native message translator — while the actual pipeline under test uses message-worker's `TranslateToMessenger`. This is intentional: it's an equivalence check between two independent implementations of the same typeform-to-Messenger translation, not legacy code that needs to be migrated or "fixed" to use the newer translator.

### Conversations, accounts, and researchers

A conversation is **`(platform, account_id, user_id)`** — not a user id. Replybot historically
keyed it by user id alone, which meant one participant messaging two of a researcher's
accounts shared a single state blob. See `planning/conversation-identity.md` for the bug and
`planning/conversation-identity-test-plan.md` for what the suite proves about it.

**The fixture seeds two researchers and four messaging accounts** (`seed-db.ts`):

| Constant | Value | Platform | Owner |
|---|---|---|---|
| `PAGE_A` | `935593143497601` | messenger | researcher A (`test@test.com`) |
| `WA_A` | `106540352242922` | whatsapp | researcher A |
| `PAGE_B` | `811223344556677` | messenger | researcher B (`test2@test.com`) |
| `WA_B` | `107650463353033` | whatsapp | researcher B |

Researcher A's two ids are **unchanged** from the original single-account fixture, because the
media fixture (`media_handle` rows) and ~40 existing tests hardcode them. `ACCOUNT_TOKENS`,
`ACCOUNT_OWNER` and `ACCOUNT_PLATFORM` map an account id to its token, owner and platform.

**Each account has a distinct credential token**, and that is not cosmetic. On Messenger the
account appears **nowhere** on the outbound wire: `message-worker/messenger_client.go:96`
POSTs to a fixed `/me/messages` and identifies the page only through
`Authorization: Bearer <token>`. The token is therefore the only way to assert *which page a
message went out on*. (WhatsApp is easier — `whatsapp_client.go:78` puts the
`phone_number_id` in the URL path.)

**Form ownership is deliberately asymmetric.** `forms/isoFormA.json` is seeded under
researcher A only; `forms/isoFormB.json` under researcher B only, and it is **excluded** from
the bulk researcher-A seed. This is load-bearing: formcentral resolves a survey by
account → owning researcher → `(shortcode, userid)`, so if form B were also owned by
researcher A, a leaked state naming form B would still resolve on A's account and the
containment test would pass while the leak was live. The two forms also use **disjoint field
refs** (`isoa_*` vs `isob_*`) — that is what turns a leak into a loud `FIELD_NOT_FOUND`
instead of a silently-accepted wrong answer.

#### Driving two conversations for one participant

```typescript
import { onPageA, onPageB, stateKey, stateKeyGlob } from './conversation';
import { makeReferralFor, makeTextResponseFor, makeQRFor } from './mox';

const userId = uuid();
const convA = onPageA(userId);   // { userId, accountId: PAGE_A, platform: 'messenger' }
const convB = onPageB(userId);   // same participant, researcher B's page

await sendMessage(makeReferralFor(convA, 'isoFormA'));
await flowMaster(convA, [[ok, fieldsA[0], []]]);   // account-scoped

await sendMessage(makeReferralFor(convB, 'isoFormB'));
await flowMaster(convB, [[ok, fieldsB[0], []]]);   // independent conversation
```

- **`conversation.ts`** — the `Conversation` handle, the `onPageA`/`onPageB`/`onWaA`/`onWaB`
  constructors, and `stateKey()` / `stateKeyGlob()`. The Redis key shape lives behind that
  single builder on purpose: `devops/clear-state-cache.sh` must match the same pattern
  (`SCAN MATCH state:*:*:<userid>`), and one builder is how that agreement stays honest.
- **`mox.ts`** — every builder already took a trailing account argument; the
  `*For(conv, …)` helpers dispatch to the Messenger or WhatsApp builder based on
  `conv.platform`, so a two-account test does not need an if/else per step.
  `makeSyntheticRaw(body)` posts an arbitrary body for testing hermes' rejection of an
  incomplete `/synthetic` triple.
- **`socket.ts`** — `flowMaster`, `flowMasterWhatsApp`, `receiveSent` and the new
  `receiveSentEnvelope` all accept **either** a bare `userId` (legacy, unscoped) or a
  `Conversation`. `receiveSentEnvelope` additionally returns `{ accountId, platform }`, which
  is how a test asserts a reply went out on the right account.
- **`responses.ts`** — account-scoped readers. Prefer `getState(chatbase, userId, accountId)`
  and `getAllStates(chatbase, userId)`. **The two-argument `getState(chatbase, userId)` is
  legacy and nondeterministic** once a participant holds state on more than one account: it
  returns `rows[0]` of an unscoped query, so a test can pass by reading the wrong
  conversation. `getMessages(..., accountId)` deliberately *throws* until the `account_id`
  column exists rather than returning `[]`, because an empty result would let an isolation
  assertion pass vacuously.

#### The facebot mock is conversation-aware

The mock keeps **one FIFO per user id** — deliberately, because `chat-events` is keyed by user
id, so a participant's events really are strictly ordered — but each queued send now records
the account it went out on.

- `POST /accounts` registers `{token, accountId, platform}` triples. `socket.ts`'s
  `registerAccounts()` is called once in `before()`; without it, Messenger sends resolve to
  `accountId: null`.
- `GET /sent/:accountId/:userId` pops the first queued send **matching that account**,
  preserving the order of the rest.
- `GET /sent/:userId` is unchanged — it pops the head regardless of account, which is what
  every pre-existing test uses.

#### Echoes must carry the conversation's account

`flowMaster` synthesizes an echo of each message it receives, which is what arms replybot's
`WAIT_EXTERNAL_EVENT` and advances the flow. `makeEcho` stamps the account as `sender.id` —
the Messenger echo inversion, where the account is the *sender* and the participant is the
*recipient*. Passing the wrong account here does not fail loudly; it injects one
conversation's echo into the other and silently reproduces the bug under test. Prefer
`makeEchoFor(message, conv)`, and note `flowMaster` already threads this for you when given a
`Conversation`.

#### Seeding the archived event log by hand

The `B8` replay tests seed `chatroach.messages` directly. **A hand-seeded row must match
what `scribble/message.go` writes *today*** — `(userid, timestamp, content, account_id,
platform)`, since migration 26. A seeder that predates a schema change does not fail; it
silently changes what the tests around it mean. It happened: the seeder still wrote three
columns, so every fabricated row had a NULL account, and B8-1b — which demands two seeded
rows be *scoped apart* — sat directly against B8-5a, which asserts NULL-account rows **are**
replayed (the deliberate migration-tolerance clause). Both cannot hold.

Two helpers, and the choice is always explicit:

| Helper | Writes | Use for |
|---|---|---|
| `seedArchivedEvent` | `account_id` + `platform` populated | anything that should look like a row scribble wrote |
| `seedHistoricalArchivedEvent` | account columns **NULL** | only where an un-backfilled row is the subject (B8-5a, B8-5b's first row) |

The control that told us which side was wrong: **B8-1 passes.** It is the end-to-end twin
whose log is built by the real pipeline, so replay scoping genuinely works — only the
fabricated rows leaked.

#### A tuple-less event is served by replay — so wait for the archive

An event carrying no `platform`/`account_id` deliberately does **not** touch the state
cache (plan §7.1). It is served by replaying `chatroach.messages` instead. That makes any
such test dependent on the scribble messages sink having caught up: with an empty log the
state reconstructs as `START`, `machine.js`'s `_handleExternalEvent` takes its
`if (state.state === 'START') return _blankStart(nxt)` branch, and `getMetadata()` — finding
no referral ref — falls through to `FALLBACK_FORM`. The conversation is silently switched
onto survey `305`.

So **wait on `countMessages()` before sending a tuple-less event**, the same non-vacuity
discipline §B8 already applies. B10-8 did not, and failed as
`expected '305' to equal 'isoFormA'`.

> **This window is not only a test artifact.** The same sequence in production re-enters a
> participant on the fallback survey rather than raising an error, for as long as the
> archive lags behind live traffic. "Refuse the cache, degrade to a replay" is only as safe
> as the archive is current. Raised for the §7.1 owner; not fixable from the harness.

#### Resetting a conversation (`REPLYBOT_RESET_SHORTCODE`)

A referral naming `reset` puts the conversation through replybot's `RESET` branch, which is
**the only referral path that writes `state_json.pointer`** and therefore the only way to
make `states.message_pointer` (a computed column, `devops/migrations/04-pointers.sql`)
non-NULL. `message_pointer` is the history-truncation checkpoint the replay query reads.

Two things about it are easy to get wrong, and both did:

- **A repeat referral is not a reset.** A referral naming a form already in the
  participant's history returns `_repeat(state)` — an *invalid-answer repeat* of the
  outstanding question — not a fresh start. Expecting the first question back gets you a
  validation repeat instead.
- **A reset sends no message.** `transition.js`'s `run()` short-circuits on
  `output.action === 'RESET'` before `actionsResponses`, so there is nothing for
  `flowMaster` to receive. Wait for `message_pointer` to land instead.

`replybot/kube-dev/dev.yaml` does **not** set `REPLYBOT_RESET_SHORTCODE`, while
`devops/values/{staging,production}.yaml` both set it to `reset` — so this production branch
was unreachable in the harness. `stack.ts` now supplies it (defaulting to `reset`, matching
those values); `test.tc.ts` exports the same string as `RESET_SHORTCODE`. If you ever see the
`kube-dev` file gain the variable, drop the override rather than keeping two sources.

## Debugging

### Testcontainers Tests

If a test fails, the stack is still running. Check logs:

```bash
# List running containers (same Docker network)
docker ps

# Tail logs from a specific container
docker logs -f <container-id>

# Inspect database state
docker exec <cockroach-container> cockroach sql --insecure \
  -e "SELECT * FROM forms LIMIT 10;"

# Check Redpanda topic content (if needed)
docker exec <redpanda-container> rpk topic consume <topic-name> --num 10
```

If you need to keep the stack running for manual inspection after a test, set
`KEEP_STACK=1` when invoking the test run (e.g. `KEEP_STACK=1 npm run test:tc`). The
suite's `after()` hook then **prints every container's docker name plus the
host-mapped CockroachDB / Redis / facebot / botserver endpoints**, and holds the
process open. Press Ctrl-C (or send SIGTERM) to release it — that falls through to a
normal teardown rather than orphaning containers.

Don't comment out lifecycle hooks in the test file to achieve this; `after()` also
closes the database pool.

The summary line (`N passing / N failing`) and the failure stack traces are **not** printed
while the stack is held — mocha runs root `after` hooks before emitting the run-end event
its reporter prints the epilogue on. The per-test ✓/✗ lines above the banner are complete;
the rest appears once you Ctrl-C.

Three details worth knowing, because they are why this used to silently *not* work:

- **Mocha applies its timeout to hooks, not just tests.** The hook used to await a
  never-resolving promise under a 60s hook timeout, so mocha killed it, reported an
  extra failure on top of whatever you were debugging, and `--exit` tore the stack
  down anyway. The hook now sets `this.timeout(0)` in `KEEP_STACK` mode.
- **Holding the process is what holds the containers.** Testcontainers runs a Ryuk
  reaper that removes the session's containers as soon as the owning process dies, so
  there is no way to "leave them up and exit" — the hook must not return.
- **An awaited promise does not keep node alive, and neither do signal listeners.** Node
  unrefs its signal handles, so a process whose only remaining work is a pending promise
  plus `process.once('SIGINT', …)` exits immediately, code 0, silently. This is the half
  that survives fixing the hook timeout: with the timeout fixed but no keep-alive, the
  stack held for about two minutes — exactly as long as testcontainers' own residual
  sockets and timers kept the event loop referenced — and then vanished with no message.
  The hook holds a ref'd `setInterval` and clears it on release.

### k8s Smoke Tests

For smoke test failures, use kubectl:

```bash
# Check testrunner pod logs
kubectl logs -l app=testrunner --tail=200

# Check dean pod logs
kubectl logs -n default -l app=dean --tail=50

# Inspect database (from cluster)
kubectl exec -it pod/cockroach-0 -- cockroach sql --insecure
```

This is only relevant when testing deployment to the dev cluster.

## Key Files

| File | Purpose |
|------|---------|
| `test.tc.ts` | Primary test suite (testcontainers) |
| `test.ts` | k8s smoke tests (minimal — 4 deployment-focused tests) |
| `stack.ts` | Boots/stops the Docker container network; also `topicEndOffsets()` / `consumeTopic()` for reading Kafka via in-container `rpk` |
| `dean-trigger.ts` | One-shot dean container invocation |
| `socket.ts` | `flowMaster()` and facebot HTTP polling; canonicalizes JSON-string fields before comparison |
| `mox.ts` | Message/fixture builders: `getFields`/`fieldsFromForm`, `makeReferral`, `makeHandover`, `makeEcho`, `makePostback`, `makeQR`, `makeTextResponse`, `makeSynthetic`, `makeNotify` |
| `responses.ts` | Account-scoped reads of `responses` / `states` / `chat_log` / `messages` for assertions |
| `conversation.ts` | The `Conversation` handle `(platform, account_id, user_id)`, per-account constructors, and the `stateKey()` Redis-key builder |
| `utils.ts` | `snooze()` and `waitFor()` polling helpers |
| `sender.ts` | Sends messages to botserver |
| `seed-db.ts` | Seeds test forms, credentials, and the `media_asset`/`media_handle` fixture |
| `schema.sql` | CockroachDB test schema |
| `forms/*.json` | Test form definitions |

## How the suite talks to the database

Both suites hold the database as a bare **`pg.Pool`**, wrapped as `{ pool }`. Every helper
in `responses.ts` and `seed-db.ts` takes that shape (each declares its own local
`interface Chatbase { pool: Pool }`), and nothing in either suite ever calls a client
method beyond `pool.query`.

- `test.tc.ts` builds it from the testcontainers connection string (`stack.chatbaseConnString`).
- `test.ts` builds it from the `CHATBASE_*` environment variables the k8s job supplies.

**The version skew is gone, and it was inert while it lasted.** `test.ts` used to do
`new (require(process.env.CHATBASE_BACKEND || '@vlab-research/chatbase-postgres'))()`
against a `0.0.3` pin, while replybot ran `^0.2.0` — four versions of drift between the
client the tests read with and the client production wrote with. That was a genuine hazard
on paper and it never bit, for a reason worth recording: the suite only ever used the
client's `pool`. It never called `get()` or `put()`, so none of the behaviour that differed
between those versions was ever on a test's path.

That client is now vendored into replybot (`replybot/lib/chatbase`, see
`replybot/README.md`), and the testrunner does **not** reach across to it. It constructs its
own `Pool` instead, because:

- Requiring `../../replybot/lib/chatbase` would not survive the container. `test.ts` runs
  inside the testrunner image, whose Docker build context is `facebot/testrunner` alone
  (`.github/workflows/release.yml`, `dev.sh`), so nothing under `replybot/` exists there at
  runtime.
- There is nothing to gain. A `Pool` is all the suite ever wanted; coupling two apps to
  share a constructor for it would be cost with no coverage behind it.

The consequence to keep in mind: **the replay client is exercised through replybot, not
directly.** `test.tc.ts`'s §B8 replay assertions prove `get()`'s account scoping by driving
real conversations through the replybot container, which is the only place that code runs in
this suite — and since the absorption that container is built from the same source tree the
assertions live in, rather than from whatever version happens to be on the npm registry.

## Environment

- Node 18+
- Docker and Docker Compose (for Testcontainers)
- `devops/testing/.test-env` — secrets for test environment

Test environment variables are loaded from k8s YAML files (e.g., `dean/kube-dev/dev.yaml`) and overridden with Docker hostnames by `stack.ts`.
