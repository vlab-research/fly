# Facebot Integration Tests

The testrunner provides a primary integration test suite using **Testcontainers** (local Docker-based) and a secondary smoke test path against the dev **Kubernetes cluster**.

## Quick Start

```bash
npm install
npm run test:tc
```

This boots the full stack locally (database, Kafka, botserver, replybot, facebot, dean) and runs all functional tests. Warm runs take ~30 seconds.

## Architecture Overview

### Testcontainers Stack

The primary test mode (`test.tc.ts`) spins up a isolated Docker network with these containers:

- **CockroachDB** (`cockroachdb/cockroach:v24.1.0`) — persists form state, user responses, and dean job history
- **Redpanda** (`redpandadata/redpanda:v23.3.18`) — Kafka broker; routes messages and responses between services
- **Botserver** — webhook entry point; receives Facebook messages, publishes to Redpanda
- **Replybot** — subscribes to user messages, applies form logic, publishes state updates and question-to-send
- **Scribble (states sink)** — subscribes to state-update topic, writes to CockroachDB
- **Scribble (responses sink)** — subscribes to responses topic, writes to CockroachDB
- **Facebot receiver** — mocks Facebook Graph API; receives question-to-send, stores it; tests poll this endpoint
- **Dean** — triggered on-demand per test; processes overdue followups, updates CockroachDB, publishes new questions

All containers share a Docker network. Environment variables come from k8s YAML files (parsed by `loadKubeEnv()`), with Docker hostnames substituted for k8s service names (e.g., `cockroach:5432` instead of `cockroach.default.svc.cluster.local`).

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

### Parallel vs. serial test blocks

Only the `Basic Functionality` `describe`/`it` block uses `mocha.parallel`. The `Timeouts` and `Phone normalization via e164 transform` blocks in `test.tc.ts` (and the `Timeouts` block in `test.ts`) run serially. Don't assume tests elsewhere in the suite run concurrently with each other.

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

If you need to keep the stack running for manual inspection after a test, set `KEEP_STACK=1` when invoking the test run (e.g. `KEEP_STACK=1 npm run test:tc`). The suite's `after()` hook checks this env var and, if set, logs a message and awaits a promise that never resolves — press Ctrl-C to tear the stack down when you're done. Don't comment out lifecycle hooks in the test file to achieve this; `after()` also closes the database pool.

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
| `stack.ts` | Boots/stops Docker container network |
| `dean-trigger.ts` | One-shot dean container invocation |
| `socket.ts` | `flowMaster()` and facebot HTTP polling; canonicalizes JSON-string fields before comparison |
| `mox.ts` | Message/fixture builders: `getFields`/`fieldsFromForm`, `makeReferral`, `makeHandover`, `makeEcho`, `makePostback`, `makeQR`, `makeTextResponse`, `makeSynthetic`, `makeNotify` |
| `responses.ts` | Reads response/state rows back from CockroachDB for assertions |
| `utils.ts` | `snooze()` and `waitFor()` polling helpers |
| `sender.ts` | Sends messages to botserver |
| `seed-db.ts` | Seeds test forms and clears state between tests |
| `schema.sql` | CockroachDB test schema |
| `forms/*.json` | Test form definitions |

## Environment

- Node 18+
- Docker and Docker Compose (for Testcontainers)
- `devops/testing/.test-env` — secrets for test environment

Test environment variables are loaded from k8s YAML files (e.g., `dean/kube-dev/dev.yaml`) and overridden with Docker hostnames by `stack.ts`.
