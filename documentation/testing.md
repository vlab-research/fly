# Integration Testing Strategy

This document describes the two-tier testing strategy for the Fly chatbot system: **Testcontainers** for functional validation and **k8s smoke tests** for deployment verification.

## What We Test

The integration test suite validates the complete message pipeline:

```
User (test) → Hermes → Redpanda → Replybot → Redpanda → Scribble → CockroachDB
                                          ↓
                                    Form logic
                                          ↓
                                   Question-to-send
                                          ↓
                                    Facebot (mock)
```

Tests also validate **dean** (the scheduler for timeouts, followups, and retries):

```
Dean (on-demand trigger) → Query CockroachDB → Identify overdue messages → Publish new questions
```

## Two-Tier Strategy

### Tier 1: Testcontainers (Primary)

**Purpose**: Functional coverage and fast iteration  
**When to run**: Every development session, in CI before merge  
**Command**: `npm run test:tc` from `facebot/testrunner/`

Testcontainers boots a complete, isolated Docker network with every component (database, Kafka, hermes, replybot, facebot, scribble, dean). The webhook entry point is **Hermes** — the Rust drop-in replacement for the deprecated Node botserver — running under the `botserver` network alias. Each test run is independent—no shared state across developers, no cluster flakiness, no need to wait for external resources.

**Speed**: Cold start ~60s (rebuilds all images), warm ~30s (containers only)  
**Dean behavior**: Triggered imperatively per test via `triggerDean()`—no cron waits needed. Timeout tests run in ~2s instead of ~180s.

### Tier 2: k8s Smoke Tests (Secondary)

**Purpose**: Validate helm chart, service DNS, deployment correctness  
**When to run**: After helm/cluster config changes, before merge to main  
**Command**: `./dev.sh` from `facebot/testrunner/`

Smoke tests run a minimal suite against the real dev cluster. They verify:
- Images pull and deploy correctly
- Services are accessible via DNS
- dean CronJob is scheduled and works
- Basic message flow completes

**Speed**: Slower; depends on cluster state and real cron scheduling  
**Dean behavior**: Waits for real CronJob execution (~180s)

The k8s suite (`test.ts`) is a genuinely minimal ~4-test deployment smoke subset, not a functional clone of the testcontainers suite. It covers only what testcontainers structurally cannot:
1. Referral → first-question, proving real service DNS/secrets/ConfigMaps wire up (botserver → replybot → worker → facebot) in the dev cluster.
2. A real dean **CronJob** timeout — this test uses no `triggerDean()`; it relies entirely on the deployed cron firing on schedule and blocks (up to the mocha timeout) until it does.
3. Delivery-error → `BLOCKED` state.
4. A stitched-forms flow.

(Historical note: `test.ts` used to be a ~24-of-26-test clone of `test.tc.ts`, duplicating almost all functional coverage against the live cluster. It has since been trimmed down to the minimal deployment-smoke role described above and in its own file header.)

## Why This Works

### Testcontainers Advantages

1. **Determinism**: No shared cluster state, no race conditions with other tests or users
2. **Speed**: Container startup is milliseconds; dean triggers are imperative (2s vs. 180s cron wait)
3. **Isolation**: Failed tests don't corrupt the dev cluster; test containers are destroyed on completion
4. **Offline**: Run locally, in CI, anywhere Docker works—no cluster dependency
5. **Debugging**: Inspect database/logs via `docker exec`, not `kubectl`; set `KEEP_STACK=1` to leave the stack running after the run instead of tearing it down (see "Debugging Failed Tests" below — do not comment out `afterAll()`, it now also closes the DB pool)

### k8s Smoke Tests Purpose

1. **Config validation**: Helm chart/values are correct
2. **DNS/service mesh**: Services resolve and communicate in the cluster
3. **Secrets/ConfigMaps**: Mounted correctly, readable by pods
4. **CronJob scheduling**: dean actually runs on the intended schedule
5. **Image registry**: Images pull successfully in the cluster

Smoke tests are **not** a substitute for functional coverage—they're a checkpoint before production deployment.

## Dean: The Key Insight

Dean handles critical async work: timeouts, followups, retries. In production, dean runs on a CronJob schedule (every 5 minutes, for example). That schedule is essential in production but breaks test iteration:

**Problem with cron-driven testing**: Test queues a followup, then waits 180s for the next cron run to trigger dean. Tests become slow, flaky, and CPU-wasteful.

**Solution**: testcontainers trigger dean imperatively.

```typescript
// Without dean trigger (cron-driven):
await sendMessage(...);
await wait(180000);  // Wait for cron to run
await flowMaster(...);

// With triggerDean (imperative):
await sendMessage(...);
await triggerDean(stack.network, stack.deanImage, stack.deanEnv, 'followups');
await flowMaster(...);  // Completes in ~2s
```

Each `triggerDean()` call starts a fresh dean container, waits for it to finish processing, then stops it. This makes tests fast and deterministic.

## When to Run Each

| Scenario | Testcontainers | k8s Smoke |
|----------|-----------------|-----------|
| **Local development** | ✓ (always) | Once per helm change |
| **Adding a test case** | ✓ | ✗ |
| **Changing form logic** | ✓ | ✗ |
| **Updating helm values** | ✓ then ✓ | ✓ required |
| **Helm chart refactor** | ✓ then ✓ | ✓ required |
| **Before PR merge** | ✓ required | ✓ if helm touched |
| **CI pipeline** | ✓ (every build) | ✓ (before deploy) |

## How to Write Tests

See `facebot/testrunner/README.md` for detailed test writing patterns. Key points:

- **`flowMaster(userId, expectedInteractions)`**: Assert message exchanges without waiting for real time. On every non-error interaction it also sends a synthetic echo of the message back into the pipeline (`makeEcho`), which is what arms replybot's `WAIT_EXTERNAL_EVENT` state for tests that need it (e.g. handoff/handover flows) — you don't need to send that echo yourself.
- **`triggerDean(...)`**: Run dean on-demand for timeout/followup tests
- **`sendMessage(...)`**: Inject a message into the pipeline
- **`fieldsFromForm(formObject)`** (in `mox.ts`): Object-based variant of `getFields(path)` for forms built or interpolated in memory (e.g. `{{hidden:...}}` substitution via `mustache`) rather than read from a fixture file. Tests use this instead of writing a `temp*.json` scratch file to disk and re-reading it.
- **`makeHandover(userId, newOwnerAppId, previousOwnerAppId, metadata)`** (in `mox.ts`): Builds a `pass_thread_control` webhook payload — the return leg of the Handoff Protocol, simulating an external app (e.g. a human-handoff or bot-to-bot echo service) returning thread control with metadata. See `replybot/HANDOFF_PROTOCOL.md` for the protocol this drives.
- **Test forms** in `forms/*.json`: Define question sequences as JSON

### Cross-cutting harness gotchas

- **`KEEP_STACK=1`** is the supported way to keep the testcontainers stack alive for manual inspection after a run — set it as an env var when invoking `npm run test:tc`. It is checked in the suite's `after()` hook, which then awaits a promise that never resolves (Ctrl-C to tear down). This replaces any older advice to comment out `afterAll()`/`after()` in the test file.
- **Only the `Basic Functionality` block runs in parallel** (via `mocha.parallel`). The `Timeouts` and `Phone normalization` blocks in `test.tc.ts`, and `Timeouts` in `test.ts`, run serially — don't assume parallel execution semantics apply suite-wide.
- **Dean/`QOUT` race**: dean's followups query matches only rows with `current_state = 'QOUT'`. A test that triggers a followup must `waitFor` that exact state before calling `triggerDean(...)`; waiting for "any state row" races the scribble upsert and dean will find zero overdue users. See the inline comment above the followups test in `test.tc.ts`.
- **`mox.ts` builds expected messages via `@vlab-research/translate-typeform`** (the older Facebook-native message translator) specifically so tests can cross-check message-worker's `TranslateToMessenger` output against an independent implementation of the same typeform-to-Messenger shape. This is an intentional equivalence check between two translators, not legacy code left over to clean up.

Example timeout test:

```typescript
it('sends followup after timeout', async () => {
  const userId = 'test-user-1';
  
  // User starts form, gets first question
  await sendMessage(makeReferral(userId, 'timeoutForm'));
  await flowMaster(userId, [[ok, firstQuestion, []]]);
  
  // No user response; trigger dean to check for overdue messages
  await triggerDean(stack.network, stack.deanImage, stack.deanEnv, 'followups');
  
  // Followup is now queued
  await flowMaster(userId, [[ok, followupMessage, []]]);
});
```

## Coverage Highlights

Beyond the basic question/answer flow, the testcontainers suite (`test.tc.ts`) specifically covers:

- **Runtime `{{hidden:...}}` interpolation**: a test (`forms/hiddenInterp.json`) delivers a hidden value through the referral's extra ref segments (e.g. `hiddenInterp.greeting_name.Nandan`) rather than pre-substituting the placeholder in the form JSON, forcing replybot's real `interpolateField`/`getFromMetadata` engine to render the text at send time. It also asserts a *missing* hidden field renders as an empty string, never an error.
- **Full handoff/handover round trip**, with no real Facebook involved: a user answers a question, the bot sends a handoff statement (`forms/handoffTest.json`), the test's own echo (via `flowMaster`'s auto-echo) arms `WAIT_EXTERNAL_EVENT`, `makeHandover(...)` simulates the external app returning thread control with metadata, and the survey resumes with the metadata interpolated into the next message via the flattened `e_handover_metadata_*` keys. The facebot mock (`facebot/receiver/index.js`) implements a `POST /me/pass_thread_control` route so the message-worker's handoff command succeeds during this flow. See `replybot/HANDOFF_PROTOCOL.md` for the full protocol.
- **`replybot/lib/typewheels/machine.test.js`** carries unit-level micro-tests locking the `makeEventMetadata` handover-flattening contract: camelCase→snake_case key conversion, dropping a literal `type` key at any nesting level, array indexing (`_0`, `_1`, ...), and an explicit regression pin asserting metadata keys land at `e_handover_metadata_*` and never the shallower, buggy `e_handover_*` shape from production bug commit `826f37fb`. This is unit coverage of the pure flattening function; the integration test above exercises the same contract end-to-end.

## Debugging Failed Tests

### Testcontainers Failures

Containers persist after test failure. Set `KEEP_STACK=1` when running the suite to keep them running deliberately (see "Cross-cutting harness gotchas" above) rather than commenting out lifecycle hooks in the test file:

```bash
# View test logs
docker logs testrunner-1  # or whatever the container is named

# Query database directly
docker exec <cockroach-id> cockroach sql --insecure -e "SELECT * FROM forms LIMIT 5;"

# Check Redpanda topics
docker exec <redpanda-id> rpk topic list
docker exec <redpanda-id> rpk topic consume <topic> --num 5
```

### k8s Smoke Test Failures

```bash
# Testrunner pod logs
kubectl logs -l app=testrunner

# Dean logs (if running)
kubectl logs -l app=dean

# Database state
kubectl exec pod/cockroach-0 -- cockroach sql --insecure -e "SELECT * FROM forms LIMIT 5;"
```

## Files and References

- **`facebot/testrunner/README.md`**: How-to guide for writing and running tests
- **`facebot/testrunner/test.tc.ts`**: Primary test suite (testcontainers)
- **`facebot/testrunner/test.ts`**: k8s smoke tests (minimal — ~4 deployment-focused tests, see "Tier 2" above)
- **`facebot/testrunner/mox.ts`**: Fixture/message builders — `getFields`/`fieldsFromForm`, `makeReferral`, `makeHandover`, `makeEcho`, etc.
- **`facebot/testrunner/responses.ts`**: Reads response/state rows back from CockroachDB for assertions
- **`facebot/testrunner/utils.ts`**: `snooze` and `waitFor` polling helpers
- **`facebot/testrunner/stack.ts`**: Boots the testcontainers Docker network
- **`facebot/testrunner/dean-trigger.ts`**: One-shot dean container orchestration
- **`facebot/receiver/index.js`**: Facebot mock — queues outbound messages for `flowMaster` to poll and answer `POST /me/pass_thread_control` for handoff tests
- **`replybot/HANDOFF_PROTOCOL.md`**: The handoff/handover protocol exercised by the handoff integration test and by `machine.test.js`'s `makeEventMetadata` unit tests
- **`replybot/lib/typewheels/machine.test.js`**: Unit tests for the pure state-machine/event-metadata functions, including the handover-flattening contract
- **`dean/kube-dev/dev.yaml`**: dean environment config (loaded into testcontainers)
- **`devops/testing/.test-env`**: Test secrets (DB credentials, API keys)
