# Testcontainers Networking Debug Plan

## Goal
Isolate and fix inter-container networking issues in the testcontainers setup, then bring fixes back to the facebot test suite.

## Context
- CockroachDB v24.1 `start-single-node` binds IPv6-only on Docker networks; containers can't reach it
- `cockroach start` with `--listen-addr=0.0.0.0:26258 --sql-addr=0.0.0.0:26257` works via psql but node `pg` Pool hangs from the replybot container
- A manual `node:22-bookworm` container on the same network CAN connect with the same pg Pool config

---

## Phase 1: Cockroach + Node (bare minimum)

### Setup
Use testcontainers to:
1. Create a Docker network
2. Start cockroach with `start --listen-addr=0.0.0.0:26258 --sql-addr=0.0.0.0:26257 --join=localhost:26258`, run `cockroach init`, create `chatroach` DB/user
3. Start a bare `node:22-bookworm` container with `pg` installed on the same network
4. Exec a pg Pool query from the node container

### Files to create
- `facebot/testrunner/debug/phase1.ts` — single-file test that starts cockroach + node, verifies pg connectivity

### Tests
```
[ ] Can node pg Pool connect with ssl:false?
[ ] Can node pg Pool connect with default ssl (undefined)?
[ ] Can node pg Pool connect with password:''?
[ ] Can node pg Pool connect without password field?
[ ] Does PGSSLMODE=disable env var help?
[ ] Compare pg version in replybot node_modules vs fresh npm install
```

### Goal
Find the exact cockroach + pg config that reliably works from a node container on the testcontainers network.

---

## Phase 2: Cockroach + Kafka + Node + Go

### Setup
Extend Phase 1 with testcontainers to:
1. Start Redpanda (Kafka) container on the same network
2. Start a Node container that:
   - Connects to Kafka and Cockroach
   - Publishes a message to a test topic
   - Consumes from a test topic
3. Start a Go container (like dinersclub) that:
   - Connects to Kafka and Cockroach
   - Consumes from a test topic
   - Writes a result to the DB

### Files to create
- `facebot/testrunner/debug/phase2.ts` — extends Phase 1 with Kafka and Go container

### Tests
```
[ ] Can node container produce/consume Kafka messages?
[ ] Can Go container (alpine:3.22 based, with librdkafka) produce/consume?
[ ] Can Go container write to Cockroach?
[ ] Can node container read what Go wrote to Cockroach?
```

### Goal
Verify all inter-container communication patterns: PG, Kafka, HTTP — all working.

---

## Phase 3: Bring fixes into the test suite

### Setup
1. Apply the working cockroach flags to `facebot/testrunner/stack.ts`
2. Apply any pg connection fixes (env vars, ssl settings, etc.)
3. Apply dinersclub fixes (Dockerfile alpine:3.22, BOTSERVER_URL)

### Files to modify
- `facebot/testrunner/stack.ts`
- `dinersclub/Dockerfile`

### Tests
```
[ ] `npx mocha dist/test.tc.js --grep "bailout"` passes
[ ] `npx mocha dist/test.tc.js --grep "Basic Functionality"` all pass
```

### Goal
All existing non-payment tests pass.

---

## Phase 4: Enable dinersclub for payments

### Setup
1. Verify dinersclub starts successfully (no librdkafka crash)
2. Verify dinersclub can consume from `vlab-payment` Kafka topic
3. Verify dinersclub can send results to botserver `/synthetic`

### Tests
```
[ ] `npx mocha dist/test.tc.js --grep "payment success"` passes
[ ] `npx mocha dist/test.tc.js --grep "payment failure"` passes
```

### Goal
Payment tests pass.

---

## Notes
- All container orchestration uses the `testcontainers` npm package (`^10.0.0`)
- All debug files go in `facebot/testrunner/debug/`
- Each phase is self-contained and can be run independently
- Run with `npx ts-node debug/phase1.ts` (or compile with `tsc` first)
