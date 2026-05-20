# Facebot Testrunner: Migration from k8s to Testcontainers

## Problem

The current facebot integration tests run as a Kubernetes Job (`facebot/testrunner/`) against a long-lived dev cluster. This causes:

1. **Slow iteration loop**: ~8-10 minutes per run (build image → push to local registry → apply job → tail logs).
2. **State pollution between runs**, from four distinct singletons:
   - **Surveys table**: `seed-db.ts` does `if (exists) return` (`facebot/testrunner/seed-db.ts:52`) — form JSON changes are silently ignored after the first seed.
   - **States / dean work tables**: every old test leaves `WAIT_*` rows that dean's cronjobs keep processing forever, slowing each cycle and producing noise.
   - **Facebot receiver pod**: in-memory `messages` and `callbacks` maps (`facebot/receiver/index.js:10-11`) accumulate across runs.
   - **Kafka offsets**: consumer groups drift; `devops/kafka-reset-offsets.sh` exists as evidence.
3. **Tests wait on wall-clock cron**: timeout/followup tests are 180s because dean runs on a 1-minute cron. There is no way to make them faster without changing the test architecture.

## Why testcontainers (and not compose, not k8s)

The testrunner is testing **bot logic**, not k8s. None of the k8s machinery (Service DNS, RBAC, helm config rendering, CronJob scheduling) is exercised by `test.ts` — those properly belong in a separate smoke suite.

Of the alternatives:

- **k8s (status quo)**: shared singleton cluster, image push step, cron-driven dean. Doesn't isolate; doesn't compose.
- **docker-compose**: simpler yaml, but externalizes lifecycle from the test process. Image rebuild becomes a discipline problem ("did I run `docker compose build`?"). Reintroduces the shared-singleton problem at smaller scale.
- **Testcontainers (npm `testcontainers`)**: test process owns the stack. `GenericContainer.fromDockerfile()` makes rebuild a structural property, not a discipline. Ryuk reaper kills orphans on crash. Dean is invoked per-test as a first-class container object instead of shelling out.

### The dean insight

Dean's `main()` is a one-shot Go program (`dean/dean.go:136-146`): read config, drain queues, exit. In production, k8s wraps it in a CronJob. **In tests, we invoke it imperatively per-assertion:**

```ts
await new GenericContainer('dean:latest')
  .withNetwork(network)
  .withEnvironment({ CHATBASE_HOST: 'cockroach', QUERIES: 'timeouts' })
  .start();
```

This converts timeout/followup tests from "wait 60s for cron" to "trigger now, assert." It is the single biggest correctness and speed win in this migration and is not achievable with compose without ugly shell-outs.

### CockroachDB stays

The user has chosen cockroach (not Postgres) for tests. Cold start is ~10s. Acceptable as a once-per-test-file cost.

## Proposed Architecture

```
facebot/testrunner/
  stack.ts              # boots cockroach + redpanda + the services, returns handles
  dean-trigger.ts       # invokes dean as a one-shot per assertion
  reset.ts              # truncate state + restart facebot between describes
  test.ts               # existing test logic, unchanged except for setup
  package.json          # adds `testcontainers` dep
  forms/*.json          # unchanged
  seed-db.ts            # CHANGE: ON CONFLICT DO UPDATE (independent fix)
```

### Containers in the stack

| Container | Image | Purpose | Lifecycle |
|-----------|-------|---------|-----------|
| `cockroach` | `cockroachdb/cockroach:<pinned>` | Database | Once per test file |
| `redpanda` | `redpandadata/redpanda:<pinned>` | Kafka-wire broker | Once per test file |
| `botserver` | built from `botserver/Dockerfile` | Webhook entry | Once per test file |
| `replybot` | built from `replybot/Dockerfile` | Message routing | Once per test file |
| `scribble` | built from `scribble/Dockerfile` | State persistence | Once per test file |
| `facebot` | built from `facebot/receiver/Dockerfile` | Mock FB API | Once per test file (restart between describes) |
| `dean` | built from `dean/Dockerfile` | Timeout/followup worker | **One-shot per test invocation** |

### Lifecycle strategy

- **Stack boot**: once per `test.ts` file in `before()`. Cold ~30-60s, warm reuses BuildKit cache.
- **Between describes**: `reset.ts` truncates `states`, `responses`, dean tracking tables, and restarts the facebot container to clear its in-memory queue.
- **Per test**: fresh `userId = uuid()` (unchanged from today).
- **Dean**: invoked explicitly when a test needs it to fire.

### Image freshness

`GenericContainer.fromDockerfile(path).build()` is called in `stack.ts`. BuildKit's layer cache means no-op rebuilds are sub-second. Stale-image bugs become impossible because building the image is part of the test code path.

## Migration Plan

### Phase 0: De-risk (30 min)

Confirm the four service images can boot without k8s-specific dependencies (configmaps, secrets, init containers). Read each Dockerfile and entrypoint. Identify required env vars.

### Phase 1: Fix `seed-db.ts` (independent, ship today)

Change `insertSurvey` (`facebot/testrunner/seed-db.ts:40-57`) from skip-on-conflict to upsert:

```sql
INSERT INTO surveys(...) VALUES(...)
ON CONFLICT (userid, shortcode) DO UPDATE SET
  form = EXCLUDED.form,
  messages = EXCLUDED.messages,
  translation_conf = EXCLUDED.translation_conf,
  formid = EXCLUDED.formid;
```

This is a correctness fix that should land regardless of the migration. It eliminates the silent "I changed the form and nothing happened" bug.

### Phase 2: Build `stack.ts`

Write the testcontainers boot code. Cockroach + redpanda first (vendor images, easy). Then services in dependency order: cockroach → scribble → replybot → botserver → facebot. Validate each with a smoke check (HTTP ping or log wait strategy).

Use testcontainers `Wait.forLogMessage()` / `Wait.forHttp()` to gate startup; do not use sleep.

### Phase 3: Wire dean as one-shot

Write `dean-trigger.ts`:

```ts
export async function triggerDean(network: StartedNetwork, queries: string) {
  const c = await new GenericContainer('dean:latest')
    .withNetwork(network)
    .withEnvironment({ /* DB conn, QUERIES: queries */ })
    .start();
  await c.waitForExit();  // or equivalent
}
```

Replace each test's implicit wait-for-cron with an explicit `await triggerDean(...)`.

### Phase 4: Port tests

Existing `test.ts` should work nearly unchanged — only the `before()` setup changes. Replace any tests that depended on cron wall-clock timing with explicit dean invocations.

Remove `DEAN_FOLLOWUP_MIN=1 minute` workarounds; they're no longer relevant.

### Phase 5: Update CI

- Replace `make integration-tests` (currently builds + applies job) with `npm test` in the testrunner directory.
- CI runner needs docker access (it almost certainly already does).
- Keep a small k8s smoke suite (~5 tests) that verifies the helm chart deploys and one basic flow works end-to-end. This catches helm/config drift that testcontainers cannot.

### Phase 6: Delete the old path

- Remove `facebot/kube/job.yaml` and `facebot/testrunner/dev.sh`.
- Update `facebot/testrunner/README.md` to describe `npm test`.
- Remove `devops/kafka-reset-offsets.sh` if no longer needed elsewhere.

## Estimated Effort

| Phase | Effort | Notes |
|-------|--------|-------|
| 0 | 30 min | Read Dockerfiles, list env vars |
| 1 | 30 min | Single SQL change + test |
| 2 | 4-6 hours | The bulk of new code |
| 3 | 1 hour | Small wrapper |
| 4 | 2-3 hours | Mostly mechanical |
| 5 | 1-2 hours | CI changes |
| 6 | 30 min | Cleanup |

**Total: ~1.5-2 days of focused work.**

## What We Lose

Explicit list, so we don't pretend the tradeoff is free:

- **k8s networking / Service DNS / DNSPolicy** — not exercised by current tests.
- **Helm-rendered config validation** — covered by the smoke suite in Phase 5.
- **CronJob scheduling semantics** — actively harmful in tests; replaced by explicit invocation.
- **Resource-limit / OOM behavior** — not exercised by current tests.
- **"kubectl logs / kubectl exec to poke at a failed test" workflow** — replaced by testcontainers' streaming logs and `getContainer().exec()`. Different ergonomics; equivalent capability.

## What We Gain

- Iteration loop: ~30s warm, ~60s cold. Currently 8-10 min.
- Timeout tests: ~1-2s. Currently 180s.
- Determinism: no shared cluster state between runs.
- Image freshness: structurally guaranteed.
- Lifecycle ownership: stack dies with the test process (Ryuk).
- Per-`describe` isolation available as a one-line change if needed.
- Parallelism: each test worker can boot its own stack (future capability).

## Open Questions

1. Where does `stack.ts` live? `facebot/testrunner/` (current home, scoped to this test suite) or repo-level (`testing/stack.ts` reusable by other suites)? **Recommendation:** start in `facebot/testrunner/`, extract later if a second consumer appears.
2. Cockroach version pinning — match prod (`cockroachdb-upgrade-v23-v24.md` suggests recent migration activity).
3. Do replybot/scribble/botserver have any hidden runtime config files outside env vars? Phase 0 answers this.
4. Does dean's exit code reliably distinguish "drained successfully" from "error"? If not, we need a different completion signal.

## Risks

- **Cockroach + redpanda + 4 services cold boot ≥ 60s.** Mitigation: reuse the stack across the whole test file; only one cold boot per `npm test`.
- **BuildKit cache invalidation in CI.** Mitigation: configure persistent buildkit cache in CI, same way the dev loop benefits locally.
- **Service Dockerfiles assume k8s env vars or secrets.** Phase 0 catches this; fix is per-service.
