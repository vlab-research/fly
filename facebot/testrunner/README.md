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
- **Coverage**: Intentionally minimal—just a few smoke tests to confirm deployment works
- **Dean behavior**: Real CronJob; tests must wait ~180s for scheduled execution
- **Target**: Kept for validation only; primary logic coverage is in testcontainers

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
4. Fail loudly if actual ≠ expected

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

If you need to keep the stack running for manual inspection after a test, comment out the `afterAll(() => stack.stop())` block in the test file.

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
| `test.ts` | k8s smoke tests (minimal, unchanged) |
| `stack.ts` | Boots/stops Docker container network |
| `dean-trigger.ts` | One-shot dean container invocation |
| `socket.ts` | `flowMaster()` and facebot HTTP polling |
| `sender.ts` | Sends messages to botserver |
| `seed-db.ts` | Seeds test forms and clears state between tests |
| `schema.sql` | CockroachDB test schema |
| `forms/*.json` | Test form definitions |

## Environment

- Node 18+
- Docker and Docker Compose (for Testcontainers)
- `devops/testing/.test-env` — secrets for test environment

Test environment variables are loaded from k8s YAML files (e.g., `dean/kube-dev/dev.yaml`) and overridden with Docker hostnames by `stack.ts`.
