# Integration Testing Strategy

This document describes the two-tier testing strategy for the Fly chatbot system: **Testcontainers** for functional validation and **k8s smoke tests** for deployment verification.

## What We Test

The integration test suite validates the complete message pipeline:

```
User (test) → Botserver → Redpanda → Replybot → Redpanda → Scribble → CockroachDB
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

Testcontainers boots a complete, isolated Docker network with every component (database, Kafka, botserver, replybot, facebot, scribble, dean). Each test run is independent—no shared state across developers, no cluster flakiness, no need to wait for external resources.

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

The k8s suite is intentionally kept minimal. Full functional coverage lives in Testcontainers.

## Why This Works

### Testcontainers Advantages

1. **Determinism**: No shared cluster state, no race conditions with other tests or users
2. **Speed**: Container startup is milliseconds; dean triggers are imperative (2s vs. 180s cron wait)
3. **Isolation**: Failed tests don't corrupt the dev cluster; test containers are destroyed on completion
4. **Offline**: Run locally, in CI, anywhere Docker works—no cluster dependency
5. **Debugging**: Inspect database/logs via `docker exec`, not `kubectl`; stack persists if test fails (comment out `afterAll()`)

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

- **`flowMaster(userId, expectedInteractions)`**: Assert message exchanges without waiting for real time
- **`triggerDean(...)`**: Run dean on-demand for timeout/followup tests
- **`sendMessage(...)`**: Inject a message into the pipeline
- **Test forms** in `forms/*.json`: Define question sequences as JSON

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

## Debugging Failed Tests

### Testcontainers Failures

Containers persist after test failure (comment out `afterAll()` to keep them longer):

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
- **`facebot/testrunner/test.ts`**: k8s smoke tests (minimal)
- **`facebot/testrunner/stack.ts`**: Boots the testcontainers Docker network
- **`facebot/testrunner/dean-trigger.ts`**: One-shot dean container orchestration
- **`dean/kube-dev/dev.yaml`**: dean environment config (loaded into testcontainers)
- **`devops/testing/.test-env`**: Test secrets (DB credentials, API keys)
