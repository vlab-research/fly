# Exporter Integration Test Plan

## Executive Summary

This plan outlines the strategy for adding comprehensive integration-test coverage of the **exporter** service (the "download your survey" feature) to the testcontainers integration suite. The exporter is a multi-threaded DB poller that reads jobs from the `export_status` table and produces CSV files in MinIO, with a presigned download link. Today it has heavy unit-test coverage of business logic but zero integration tests—no real database schema validation, no MinIO upload/lifecycle verification, and no CSV content correctness assertions.

**Recommendation**: Adopt a **two-tier split**:
- **Tier 1 (Primary)**: Extend `facebot/testrunner/test.tc.ts` (TypeScript/mocha) with a minimal set of **end-to-end** tests that verify the exporter's seam into the testcontainers stack: job insertion → processing → link generation. This tier validates the contract between dashboard-server (or test fixtures) and the exporter, and proves MinIO integration works.
- **Tier 2 (Full coverage)**: Grow `exporter/exporter/tests/test_db_integration.py` into a standalone Python testcontainers suite (cockroach + minio) that exercises the entire exporter business logic exhaustively—CSV column correctness, event filtering, cross-user scoping, failure→retry→Failed paths, stale-job reclaim, and lifecycle policies. This tier is owned and maintained by the exporter team.

**Rationale**:
- The TS suite (`test.tc.ts`) already owns the full message pipeline and should own the *seam* tests that validate the exporter fits into that pipeline.
- The Python suite is where exporter tests naturally belong—same language, same test framework (pytest), closer to the code, owned by the exporter team's iteration.
- The TS suite runs in CI on every change to `replybot/**`, `scribble/**`, etc.; the Python suite can run independently when exporter code changes, reducing CI noise and wall-clock time in the common case.
- A split avoids duplicating seed logic and database setup across two test harnesses while ensuring both tiers of coverage are achievable.

**Milestone breakdown**:
1. **M1** (Week 1): Add exporter + MinIO to stack.ts; write TS Tier 1 (happy path per export type, CSV content spot-check) — ~2–3h.
2. **M2** (Week 2): Build Python Tier 2 suite with full exporter-specific coverage — ~4–6h.
3. **M3** (Week 3): Wire CI path filters; document; land.

**Wall-clock impact**: TS suite adds ~3–5s per run (one exporter job poll cycle). Python suite runs independently on exporter changes only, off the critical path in most PRs.

**Production-code impact**: none. The two levers this plan needs — fast polling and presigned-URL verification — are handled by env vars the exporter already reads (`POLL_INTERVAL_SECONDS`, `WORKER_THREADS`) and by fetching the URL from inside the Docker network. See Section 5 for why the obvious host-side URL-rewriting shortcut cannot work.

---

## 1. Which Test Tier Owns This

### Option A (Chosen): Two-Tier Split with TS Seam Tests + Python Full Coverage

**Tier 1: TypeScript Seam Tests (facebot/testrunner/test.tc.ts)**

Purpose: Validate the exporter's integration into the message pipeline. Test the contract where the exporter reads from the DB that the pipeline writes to and produces a presigned download link.

- **Entry point**: Direct SQL INSERT into `export_status` (the real DB contract) or short-lived dashboard-server mock if minimal; TS harness controls the fixture.
- **What it asserts**: Job is claimed, processed, and marked `Finished` with a populated `export_link`. Presigned URL works. MinIO object lifecycle is applied.
- **What it does NOT assert**: CSV column names, event group filtering, time-window edge cases, retry exhaustion — those are exporter internals.
- **Rationale**: 
  - Seam tests live where the consumer lives. The dashboard-server and message pipeline are TS/Node.js; the exporter sits downstream of that pipeline as a standalone worker.
  - The TS suite already has infrastructure to seed DB state, wire services together, and read back results. Reusing it is faster than building a parallel Python harness just for TS↔exporter integration.
  - When the TS suite runs (every message-pipeline PR), it validates that any pipeline changes didn't break the exporter seam.

**Tier 2: Python Full-Coverage Suite (exporter/exporter/tests/test_db_integration.py → testcontainers)**

Purpose: Exhaustive exporter behavior coverage owned by the exporter team. Tests internal correctness: CSV format, event filtering, cross-user scoping, failure paths, retry logic, stale-job reclaim, MinIO lifecycle, etc.

- **Entry point**: Direct SQL INSERT of `export_status` rows (same as TS Tier 1, but in Python).
- **What it asserts**: Everything internal to the exporter: CSV correctness, option parsing, event groups, time windows, error handling, retries, metadata merging, lifecycle policies.
- **Rationale**:
  - Exporter tests belong in the exporter repo, written in the exporter's language (Python).
  - The Python suite is the natural place for exporter-team developers to add regression tests as they modify the exporter.
  - Reduces maintenance burden on the TS harness—TS devs don't have to understand all exporter business logic to add tests.
  - Runs independently when exporter code changes; doesn't block unrelated PRs.

### Why Not Option B (All in TS)

A TS-only approach would require:
- Rewriting exporter business logic in TypeScript or calling a Python subprocess, both infeasible.
- Embedding all exporter asserts (CSV column names, event group filtering, etc.) in TS tests, far from the code.
- Exporter team has to context-switch to TS/mocha when adding regression tests.

### Why Not Option C (All in Python)

A Python-only approach would:
- Miss the seam test (TS pipeline → exporter) unless we also added dashboard-server to the testcontainers stack, which is out of scope (adds ~30s to every build).
- Force the Python suite to mock the entire job-insertion path instead of testing the real DB schema the pipeline writes to.

---

## 2. Where to Drive Tests From

### Tier 1 (TS): Direct Database Insertion

**Approach**: Insert `export_status` rows directly into the testcontainers cockroach database using the existing `chatbase.pool` connection in `test.tc.ts`.

```typescript
// In test.tc.ts, after stack boots:
it('exporter processes a responses export and generates a presigned MinIO link', async () => {
  const exportId = uuid();
  const userId = 'test-user@example.com';
  const surveyId = 'test-survey';

  // Insert an export_status row directly (mimics dashboard-server POST /exports)
  await chatbase.pool.query(
    `INSERT INTO export_status
       (id, user_id, survey_id, status, export_link, source, options)
     VALUES ($1, $2, $3, 'Requested', 'Not Found', 'responses', $4)`,
    [exportId, userId, surveyId, JSON.stringify({})]
  );

  // Exporter container (already running) will poll and claim this job
  // Poll until status is Finished or timeout
  await waitFor(async () => {
    const rows = await chatbase.pool.query(
      `SELECT status, export_link FROM export_status WHERE id = $1`,
      [exportId]
    );
    return rows.rows[0]?.status === 'Finished' && rows.rows[0]?.export_link;
  }, 15000);

  const finalRow = await chatbase.pool.query(
    `SELECT export_link FROM export_status WHERE id = $1`,
    [exportId]
  );
  const link = finalRow.rows[0].export_link;
  
  // Fetch the presigned URL and verify the CSV is downloadable
  const csv = await fetch(link).then(r => r.text());
  expect(csv).to.include('question_id');  // Spot-check for expected column
});
```

**Why NOT dashboard-server**: Adding dashboard-server to the stack would add a Node.js service, Auth0 JWT mocking, and ~30s to cold-start time, for a single test fixture. Direct DB insertion proves the exporter's actual contract (reads from `export_status` table) and is simpler.

**Risk**: Presigned URL fetch from within a mocha test running on the host must rewrite the URL to use the docker network hostname. See **Section 5: MinIO Container Risk** below.

---

### Tier 2 (Python): Direct Database Insertion + Async Exporter Runner

**Approach**: Insert `export_status` rows and invoke the exporter as a one-shot container or run `process_job()` directly in a test helper.

**Option A (Preferred)**: Use a one-shot exporter container (similar to `dean-trigger.ts` pattern).

```python
# exporter/exporter/tests/test_integration_tc.py
import subprocess
import asyncio
import json
from testcontainers.core.container import DockerContainer
from testcontainers.core.network import Network
from testcontainers.cockroachdb import CockroachDbContainer
from testcontainers.minio import MinioContainer

@pytest.fixture
async def tc_network():
    network = Network()
    network.start()
    yield network
    network.stop()

@pytest.fixture
async def cockroach_container(tc_network):
    container = CockroachDbContainer(image="cockroachdb/cockroach:v24.1.0")
    container = container.with_network(tc_network).with_network_aliases("cockroach")
    container.start()
    # Run migrations (all devops/migrations/*.sql)
    yield container
    container.stop()

@pytest.fixture
async def minio_container(tc_network):
    container = MinioContainer().with_network(tc_network).with_network_aliases("minio")
    container.start()
    yield container
    container.stop()

@pytest.fixture
async def exporter_image(tc_network, cockroach_container, minio_container):
    """Build exporter image and return name."""
    subprocess.run(
        ['docker', 'build', '-t', 'exporter:test', 'exporter/'],
        cwd='/repo/root',
        check=True
    )
    return 'exporter:test'

@pytest.mark.asyncio
async def test_responses_export_end_to_end(
    tc_network, cockroach_container, minio_container, exporter_image
):
    export_id = str(uuid.uuid4())
    user_id = 'test@example.com'
    survey_id = 'test-survey'

    # Insert export_status row
    conn = psycopg2.connect(cockroach_container.get_connection_url())
    cursor = conn.cursor()
    cursor.execute(
        """INSERT INTO export_status
             (id, user_id, survey_id, status, export_link, source, options)
           VALUES (%s, %s, %s, 'Requested', 'Not Found', 'responses', %s)""",
        (export_id, user_id, survey_id, json.dumps({}))
    )
    conn.commit()
    conn.close()

    # Trigger exporter as a one-shot container
    container = DockerContainer(exporter_image)
    container = container.with_network(tc_network)
    container = container.with_environment({
        'DATABASE_URL': cockroach_container.get_connection_url(),
        'STORAGE_BACKEND': 's3',
        'S3_HOST': 'minio:9000',
        'S3_BUCKET_NAME': 'exports',
        'S3_ACCESS_KEY': minio_container.access_key,
        'S3_SECRET_KEY': minio_container.secret_key,
        'S3_SSL_ENABLED': 'false',
        'POLL_INTERVAL_SECONDS': '1',
        'WORKER_THREADS': '1',  # Single worker for determinism
    })
    container.start()
    
    # Wait for container to exit or timeout
    timeout = 30
    elapsed = 0
    while elapsed < timeout:
        try:
            result = container.exec(['echo', 'alive'])
            if result.exit_code != 0:
                break
        except:
            break
        await asyncio.sleep(0.5)
        elapsed += 0.5

    container.stop()

    # Verify the export is marked Finished
    conn = psycopg2.connect(cockroach_container.get_connection_url())
    cursor = conn.cursor()
    cursor.execute(
        'SELECT status, export_link FROM export_status WHERE id = %s',
        (export_id,)
    )
    status, link = cursor.fetchone()
    conn.close()

    assert status == 'Finished'
    assert link and link != 'Not Found'

    # Fetch the CSV from MinIO
    minio_client = Minio('minio:9000', ...)
    csv_bytes = minio_client.get_object('exports', f'exports/{export_id}.csv')
    csv_text = csv_bytes.read().decode('utf-8')
    
    # Spot-check for expected column
    assert 'question_id' in csv_text
```

**Option B (Alternative)**: Call `process_job()` directly in Python, no container. Simpler but doesn't test the full Docker entrypoint.

```python
# Direct function call (simpler but less thorough)
@pytest.mark.asyncio
async def test_responses_export_function_direct(db_url, minio_client):
    export_id = str(uuid.uuid4())
    insert_export(db_url, export_id, source='responses')
    
    job = claim_job(db_url, max_retries=3, stuck_timeout_minutes=120)
    assert job['id'] == export_id
    
    # Call exporter directly
    process_job(db_url, job)
    
    # Verify status updated
    rows = list(query(db_url, 'SELECT status, export_link FROM export_status WHERE id = %s', (export_id,)))
    assert rows[0][0] == 'Finished'
    assert rows[0][1]  # Link populated
```

**Recommendation**: Use **Option A** (one-shot container) for Tier 2. It tests the full Docker entrypoint and is closer to production reality. The stack is already built by `facebot/testrunner/stack.ts`, so the Python suite can re-use the same Dockerfile and environment vars.

---

## 3. Making Tests Fast and Deterministic

### The 5-Second Poll Problem

The exporter's `POLL_INTERVAL_SECONDS` (default 5) and multi-threaded worker pool (default 4 threads) are hostile to tests. A test that inserts a job must wait ~5s for the next poll cycle, and up to ~10s if there's worker contention.

### Solution: Environment Variable Overrides

The exporter's `main.py` already reads `POLL_INTERVAL_SECONDS` and `WORKER_THREADS` from env (lines 16–19). For tests:

**Tier 1 (TS)**: Pass env vars when starting the exporter container.

In `stack.ts`, when adding the exporter container:

```typescript
const exporterImageName = 'exporter:test';
// ... in the image build loop:
GenericContainer.fromDockerfile(path.join(repoRoot, 'exporter')).build(exporterImageName),

// ... when starting containers:
const exporter = await new GenericContainer(exporterImageName)
  .withNetwork(network)
  .withNetworkAliases('exporter')
  .withEnvironment({
    'DATABASE_URL': `postgresql://chatroach@cockroach:26257/chatroach?sslmode=disable`,
    'STORAGE_BACKEND': 's3',
    'S3_HOST': 'minio:9000',
    'S3_BUCKET_NAME': 'exports',
    'S3_ACCESS_KEY': 'minioadmin',
    'S3_SECRET_KEY': 'minioadmin',
    'S3_SSL_ENABLED': 'false',
    // TEST OVERRIDES for speed:
    'POLL_INTERVAL_SECONDS': '1',    // Poll every 1s instead of 5s
    'WORKER_THREADS': '1',            // Single worker for determinism
    'STUCK_TIMEOUT_MINUTES': '1',     // Fast stale-job reclaim
  })
  .withWaitStrategy(Wait.forLogMessage('export worker.*started'))
  .start();
```

**Tier 2 (Python)**: Set the same env vars in the one-shot container (see code snippet in Section 2).

**Result**: Tests complete in 2–3s per job instead of waiting for the default 5s+ poll cycle. The 4-thread pool is reduced to 1 worker for determinism.

### Alternative: `--once` Mode (Not Recommended for Now)

The exporter could accept a `--once` flag to process one pending job and exit immediately. This would eliminate the poll loop and make tests even faster (~200ms). However:
- Requires production-code changes (minimal, but not zero).
- The env-var override is sufficient for now; revisit if test execution becomes a bottleneck.

**Decision**: Use env-var overrides in M1 and M2. If tests still feel slow, add `--once` mode in a follow-up.

---

## 4. Seeding Realistic Data

### Survey & User Setup

Existing seed logic in `facebot/testrunner/seed-db.ts` creates surveys and users. Tier 1 tests reuse these.

### Responses, Chat Log, and Messages Fixtures

For Tier 1 (TS) seam tests, seed just enough data to prove the SQL queries work:

```typescript
// In seed-db.ts, add an export function
export async function seedExportData(chatbase: { pool: Pool }) {
  const surveyId = 'test-survey';
  const userId = 'test-user@example.com';

  // Insert sample responses (for responses export)
  await chatbase.pool.query(`
    INSERT INTO responses (userid, question_id, response, timestamp, survey_id, form_id)
    VALUES
      ($1, 'q1', 'yes', NOW(), $2, 'form1'),
      ($1, 'q2', 'no', NOW(), $2, 'form1')
  `, [userId, surveyId]);

  // Insert sample chat_log rows
  await chatbase.pool.query(`
    INSERT INTO chat_log (userid, message, timestamp, survey_id, platform)
    VALUES
      ($1, 'Hello', NOW(), $2, 'whatsapp'),
      ($1, 'Goodbye', NOW(), $2, 'whatsapp')
  `, [userId, surveyId]);

  // Insert sample messages (for full_messages export)
  // These need valid JSON `content` that classify_event will process
  const eventContent = {
    type: 'message',
    message: { text: 'test message' },
    sender: { id: userId }
  };
  await chatbase.pool.query(`
    INSERT INTO messages (userid, survey_id, content, timestamp, event_source)
    VALUES
      ($1, $2, $3::jsonb, NOW(), 'facebook'),
      ($1, $2, $4::jsonb, NOW(), 'facebook')
  `, [
    userId,
    surveyId,
    JSON.stringify({ ...eventContent, type: 'conversation' }),
    JSON.stringify({ ...eventContent, type: 'referrals' })
  ]);
}
```

For Tier 2 (Python) full-coverage tests, fixtures are defined inline in pytest parametrize or in a dedicated `conftest.py`:

```python
# exporter/exporter/tests/test_integration_tc.py

RESPONSE_FIXTURES = [
    {
        'userid': 'user1@example.com',
        'question_id': 'q1',
        'response': 'yes',
        'survey_id': 'survey1',
    },
    {
        'userid': 'user1@example.com',
        'question_id': 'q2',
        'response': 'detailed answer',
        'survey_id': 'survey1',
    },
]

MESSAGES_FIXTURES = [
    # Event group: conversation
    {
        'userid': 'user1@example.com',
        'survey_id': 'survey1',
        'content': json.dumps({
            'type': 'message',
            'message': { 'text': 'User said this' },
            'sender': { 'id': 'user1' }
        }),
        'timestamp': '2025-01-15T12:00:00Z',
        'event_source': 'facebook',
    },
    # Event group: bails
    {
        'userid': 'user1@example.com',
        'survey_id': 'survey1',
        'content': json.dumps({
            'type': 'event:bail',
            'bailed_at': '2025-01-15T12:05:00Z'
        }),
        'timestamp': '2025-01-15T12:05:00Z',
        'event_source': 'facebook',
    },
]

def insert_responses(db_url, fixtures):
    conn = psycopg2.connect(db_url)
    cursor = conn.cursor()
    for row in fixtures:
        cursor.execute(
            'INSERT INTO responses (userid, question_id, response, survey_id) VALUES (%s, %s, %s, %s)',
            (row['userid'], row['question_id'], row['response'], row['survey_id'])
        )
    conn.commit()
    conn.close()
```

### Location & Structure

- **Tier 1 (TS) fixtures**: In `facebot/testrunner/seed-db.ts`, extended with `seedExportData()` function. Reused by tests in `test.tc.ts`.
- **Tier 2 (Python) fixtures**: In `exporter/exporter/tests/test_integration_tc.py` (new file) or `conftest.py` (extended), defined as module-level constants or factory functions.

---

## 5. MinIO Container: Risks and Technical Details

### The Presigned URL Fetch Problem

When the exporter generates a presigned URL, it signs it against the `S3_HOST` it was configured with (e.g., `minio:9000` inside the Docker network). If the test running on the host tries to fetch that URL directly, the hostname `minio:9000` is not resolvable on the host.

### Why host-side URL rewriting does NOT work

The tempting fix — map MinIO's 9000 to a host port and rewrite `minio:9000` → `localhost:<mappedPort>` in the returned URL — is **wrong and will fail at runtime**.

MinIO presigns with AWS SigV4, and `generate_link` (`exporter/exporter/storage.py:159-167`) produces a URL carrying `X-Amz-SignedHeaders=host`. The server recomputes the signature from the `Host` header of the incoming request. Change the host in the URL and the recomputed signature no longer matches the one in `X-Amz-Signature`, so MinIO returns `403 SignatureDoesNotMatch`. String-replacing the host cannot work, in a test or anywhere else.

That also rules out adding a `MINIO_PRESIGN_HOST` env override to `storage.py`: it would be production surface area added purely for tests, and it would not even produce a fetchable URL.

### Solution: fetch the presigned URL from inside the Docker network

Verify the URL the way a real client does — with a real HTTP GET whose `Host` header matches what was signed — by running a one-shot `curl` container **on the test network**, following the existing `dean-trigger.ts:8-44` one-shot-container pattern. Zero production-code change, and it validates the signature end-to-end rather than just the URL's shape.

```typescript
// facebot/testrunner/fetch-url.ts — one-shot curl on the stack network
import { GenericContainer, StartedNetwork } from 'testcontainers';

export async function fetchInNetwork(
  network: StartedNetwork,
  url: string,
): Promise<{ status: number; body: string }> {
  const container = await new GenericContainer('curlimages/curl:8.8.0')
    .withNetwork(network)
    // -sS: quiet but show errors; -w appends the status code as a final line
    .withCommand(['-sS', '-w', '\\n%{http_code}', url])
    .withWaitStrategy(Wait.forOneShotStartup())
    .start();

  const out = await streamToString(await container.logs());
  await container.stop();

  const lines = out.trimEnd().split('\n');
  return { status: Number(lines.pop()), body: lines.join('\n') };
}
```

```typescript
// In the test:
const { status, body } = await fetchInNetwork(stack.network, exportRow.export_link);
expect(status).to.equal(200);
expect(body.split('\n')[0]).to.contain('userid');   // CSV header row
```

This is the recommended approach for **Tier 1**. It costs ~1s per assertion (pulling `curlimages/curl` once) and needs no changes to `storage.py`.

### Reading the object directly (Tier 2, and for content assertions)

For content-heavy assertions, skip the presigned URL and read the object with a MinIO client. In **Tier 2** the pytest process runs on the host, so point the client at the mapped host port — object reads are authenticated with the access/secret key at request time, so there is no signature-vs-host problem here (unlike presigning):

```python
# exporter/exporter/tests/test_integration_tc.py
from minio import Minio

client = Minio(
    f"localhost:{minio_container.get_exposed_port(9000)}",
    access_key="minioadmin",
    secret_key="minioadmin",
    secure=False,
)
obj = client.get_object(BUCKET, f"exports/{survey_name}.csv")
csv_text = obj.read().decode()
assert csv_text.splitlines()[0].split(",")[:3] == ["parent_surveyid", "parent_shortcode", "surveyid"]
```

Note the bucket/prefix distinction: the **bucket** is whatever `S3_BUCKET_NAME` is set to, and `exports/` is an **object-name prefix** inside it (`file_path` is built as `exports/{survey}.csv`). The lifecycle rule filters on that prefix.

### Lifecycle policy verification

`_ensure_lifecycle` (`storage.py:106-135`) is best-effort — it swallows API errors with a `log.warning` — so a silent regression here is exactly the kind of thing only an integration test catches:

```python
config = client.get_bucket_lifecycle(BUCKET)   # BUCKET == S3_BUCKET_NAME
assert config is not None
rule = next(r for r in config.rules if r.rule_id == "expire-exports-3d")
assert rule.expiration.days == 3
assert rule.abort_incomplete_multipart_upload.days_after_initiation == 1
```

---

## 6. Prioritized Test List

### Tier 1 (TS Seam Tests) — in `facebot/testrunner/test.tc.ts`

**Total effort**: ~2–3h. Run time: +3–5s per run (the exporter's single poll cycle + I/O).

| Test | Asserts | Fixtures | Est. Time |
|------|---------|----------|-----------|
| **[M1.1] Happy path: responses export** | Job is claimed → Processing → Finished. export_link populated. CSV has expected columns. | `seedExportData()`: 1 survey, 1 user, 2 responses. | 2s |
| **[M1.2] Happy path: chat_log export** | Same lifecycle. CSV has message timestamps and text. | `seedExportData()`: 1 survey, 1 user, 2 chat_log rows. | 2s |
| **[M1.3] Happy path: full_messages export** | Same lifecycle. CSV includes event_group filtering. | `seedExportData()`: 1 survey, 1 user, messages with 'conversation' and 'bails' event_group values. | 2s |
| **[M1.4] Presigned URL is fetchable** | fetch(export_link) returns 200 + CSV content. | Reuse M1.1 export. | 1s |
| **[M1.5] Empty survey export** | Survey exists, user exists, no responses/messages. Export completes and returns empty CSV. | `seedExportData()` but skip response/message rows. | 1s |
| **[M1.6] Cross-user scoping** | User A requests export of user B's survey. Exporter's SQL filters by user_id; result is empty CSV, not a leak. | Two users, one survey, responses only for user A. Export requested by user B. | 1s |

**Rationale for scope**: 
- Full happy-path coverage (one test per export type).
- URL fetch proves MinIO integration works end-to-end.
- Empty survey edge case (common in real usage).
- Cross-user scoping (security-critical; unit tests don't cover DB-level filtering).
- NOT included: event-group filtering edge cases, time-window filtering, retry/failure paths (those belong in Tier 2).

---

### Tier 2 (Python Full-Coverage Tests) — in `exporter/exporter/tests/test_integration_tc.py` (new file)

**Total effort**: ~4–6h. Run time: +10–15s per test (one-shot exporter container + I/O). Runs independently when exporter code changes, not on every PR.

| Test | Asserts | Fixtures | Est. Time |
|------|---------|----------|-----------|
| **[M2.1] Responses export: column correctness** | CSV has all expected columns: userid, survey_id, question_id, response, timestamp. Order and type are correct. | 5 responses with varied question IDs. | 2s |
| **[M2.2] Responses export: data accuracy** | CSV rows match inserted data exactly (no data loss, correct escaping). | 10 responses including special chars: `"quoted"`, `newline\n`, `comma,`. | 2s |
| **[M2.3] Chat_log export: column correctness** | CSV has all expected columns: userid, survey_id, timestamp, message, platform. | 5 chat_log rows. | 2s |
| **[M2.4] Full_messages export: event_group filtering** | When ExportOptions.event_groups=['conversation', 'bails'], only those event groups appear in CSV. Other groups (referrals, payments) are excluded. | 10 messages across 4 event groups. Request only 2. | 2s |
| **[M2.5] Full_messages export: time-window filtering** | When ExportOptions.start_time and end_time are set, CSV includes only messages within the window. | 20 messages spanning 2 days. Request 1-day window. | 2s |
| **[M2.6] Full_messages export: event-group filtering interaction** | Combine event_group filter + time window. Only messages matching BOTH filters appear. | 15 messages across 3 groups and 3 days. Request 1 group + 1 day. | 2s |
| **[M2.7] Responses export: user scoping** | User A and User B both have responses for the same survey. Export for User A returns only User A's responses. | 2 users, shared survey, 5 responses each. | 2s |
| **[M2.8] Stale-job reclaim** | A Processing row with locked_at > STUCK_TIMEOUT_MINUTES is reset to Requested and reclaimed. | Insert Processing row, set locked_at to 2 hours ago, claim. | 2s |
| **[M2.9] Failure → retry → retry exhaustion** | Job fails (exception during process_job). claim_job resets it to Requested. After MAX_EXPORT_RETRIES (3), job is marked Failed permanently. | Insert job, mock export_data to raise, trigger exporter 3x. | 3s |
| **[M2.10] Metadata merging** | After export, set_metadata merges `{rows: 10, users: 1, errors: null}` into the `metadata` JSONB column. | 1 export. Assert metadata is correctly merged. | 2s |
| **[M2.11] MinIO lifecycle policy is applied** | After first export, bucket has lifecycle rule 'expire-exports-3d' set. | 1 export. Fetch bucket lifecycle via SDK. | 2s |
| **[M2.12] CSV generation edge case: NULL values** | NULL columns in DB appear as empty cells in CSV, not 'None' or errors. | Insert response with NULL timestamp. | 2s |
| **[M2.13] Large export (performance)** | Export 1000 rows completes within 10s (streaming, not OOM). | 1000 responses. | 3s |

**Rationale for scope**:
- **Column/data correctness**: Proves CSV format is stable and correct for each export type.
- **Filtering logic** (event groups, time windows, user scoping): These are exporter business logic; Tier 1 doesn't test them.
- **Failure & retry paths**: Essential for reliability; Tier 1 can't test without mocking exporter internals.
- **Metadata & lifecycle**: Infrastructure concerns that need verification but aren't worth integration-level tests in Tier 1.
- **NOT included**: Auth/authorization (dashboard-server's job, tested at API tier), UI polling behavior (dashboard-client's job, no backend change).

---

## 7. Implementation Milestone Breakdown

### M1: Tier 1 (TS Seam Tests) — Week 1

**Goal**: Extend the testcontainers stack with exporter + MinIO; write 6 TS seam tests.

**Tasks**:
1. **M1a** (1h): Extend `stack.ts`:
   - Add exporter image build (parallel with others in line 118–127).
   - Add MinIO container startup (similar pattern to redis/redpanda, line 208+).
   - Set env vars: `DATABASE_URL`, `STORAGE_BACKEND='s3'`, `S3_*` creds, `POLL_INTERVAL_SECONDS=1`, `WORKER_THREADS=1`.
   - Add exporter container startup with health check (Wait.forLogMessage).
   - Export exporter and minioPort from Stack interface (for tests to use).

2. **M1b** (0.5h): Extend `seed-db.ts`:
   - Add `seedExportData()` function to insert sample responses, chat_log, and messages.

3. **M1c** (0.5h): Add `facebot/testrunner/fetch-url.ts` — the one-shot `curl`-on-the-network helper from Section 5, modelled on `dean-trigger.ts`. **No production-code change** (see Section 5 for why `MINIO_PRESIGN_HOST` is not viable).

4. **M1d** (1h): Write 6 tests in `test.tc.ts`:
   - Tests M1.1–M1.6 from Section 6.
   - Use `seedExportData()`, insert export_status rows, poll for completion, verify CSV content and URL.

**CI changes**: No path-filter changes needed yet (exporter/** is not in CI, but the PR that lands M1 will add it).

**Output**: PR #N extending `stack.ts`, `seed-db.ts`, `fetch-url.ts`, and `test.tc.ts`. All 6 tests passing locally. **No changes to `exporter/` production code.**

---

### M2: Tier 2 (Python Full-Coverage Tests) — Week 2

**Goal**: Build a standalone Python testcontainers suite for the exporter with 13 full-coverage tests.

**Tasks**:
1. **M2a** (1h): Set up Python testcontainers infrastructure:
   - Create `exporter/exporter/tests/test_integration_tc.py`.
   - Add fixtures for cockroach, minio, exporter containers (async fixtures, similar to structure in `conftest.py`).
   - Add helper functions to insert export_status rows, run exporter, poll for completion.

2. **M2b** (2h): Write 13 tests (M2.1–M2.13 from Section 6):
   - Tests for CSV correctness, filtering, edge cases, failure paths.
   - Use assertions on CSV content, database state, MinIO objects.

3. **M2c** (0.5h): Update `exporter/README.md`:
   - Document the undocumented env vars the service actually reads: `POLL_INTERVAL_SECONDS`, `WORKER_THREADS`, `STUCK_TIMEOUT_MINUTES`, `MAX_EXPORT_RETRIES`.
   - Clarify that service is not Kafka-driven (remove obsolete KAFKA_* docs).
   - Document how to run: `pytest exporter/tests/test_integration_tc.py`.

**Output**: PR #N+1 with new test file, updated README.

---

### M3: CI Integration & Documentation — Week 3

**Goal**: Wire up CI path filters, document testing strategy, land everything.

**Tasks**:
1. **M3a** (0.5h): Update `.github/workflows/testcontainers-integration.yml`:
   - Add `exporter/**` to path filters (lines 5–28).
   - Note: CI will now run TS Tier 1 tests on every exporter PR (adds ~3–5s to suite).
   - Python Tier 2 tests are NOT in CI; they run locally by devs or in a separate workflow if needed.

2. **M3b** (0.5h): Update `documentation/testing.md`:
   - Append a new section: "Exporter Integration Testing".
   - Explain two-tier split: Tier 1 (seam tests in TS), Tier 2 (full coverage in Python).
   - Point to `exporter/exporter/tests/test_integration_tc.py` for how to run.
   - Note that exporter tests are NOT in the critical CI path (no path filter for exporter/** → workflow trigger) unless explicitly opted in.

3. **M3c** (0.5h): Create or update `exporter/README.md` (if not done in M2c):
   - Clarify the multi-threaded DB-polling model.
   - Document all env vars correctly (remove KAFKA_*).

4. **M3d** (Final): Merge all PRs; announce in team docs.

**Output**: Final merged PRs with full CI integration and documentation.

---

## 8. Risks and Open Questions

### Risk 1: Presigned URL Fetch from Host

**Problem**: MinIO signs URLs against the container network hostname `minio:9000`, which the mocha process on the host cannot resolve. Rewriting the host into the URL breaks the SigV4 signature (`X-Amz-SignedHeaders=host`) and yields `403 SignatureDoesNotMatch` — see Section 5.

**Mitigation**: Fetch the URL from a one-shot `curl` container on the stack network (`fetch-url.ts`, M1c). No production-code change; validates the real signature.

**Fallback**: If that proves flaky, Tier 1 can assert only that `export_link` is populated, is not `'Not Found'`, and parses with `X-Amz-Expires=25200` (7h), while Tier 2 reads the object bytes via the MinIO SDK on the mapped host port. Weaker, but the object-content coverage is preserved.

---

### Risk 2: Exporter Process Crash or Hang

**Problem**: If the exporter container crashes or hangs, TS seam tests will timeout waiting for job completion.

**Mitigation**:
- Health check in container startup: `Wait.forLogMessage('export worker.*started')` ensures the exporter is running before tests proceed.
- Set a 15s timeout on the poll-for-completion loop (see code snippet in Section 2). If the job doesn't finish within 15s, fail the test with a clear message.
- Use `KEEP_STACK=1` to inspect logs if tests fail.

---

### Risk 3: MinIO Cleanup Between Tests

**Problem**: Objects uploaded in one test might interfere with another (name collision, bucket not cleaned up).

**Mitigation**:
- Use UUIDs for export IDs and CSV paths (already done in code).
- Each test creates a fresh export with a unique ID; no collision.
- MinIO's lifecycle policy cleans up old exports; not a test concern.

---

### Risk 4: Tier 2 Tests Depend on Tier 1 Stack

**Problem**: If `facebot/testrunner/stack.ts` is broken, TS Tier 1 tests fail. But Tier 2 Python tests should still pass independently.

**Mitigation**:
- Tier 2 builds its own cockroach + minIO + exporter containers (testcontainers Python SDK).
- No dependency on `facebot/testrunner` repo code; fully self-contained.
- Tier 1 and Tier 2 are completely independent test suites.

---

### Risk 5: CSV Column Regressions in Production

**Problem**: If the exporter changes CSV column names or order, existing consumers' parsers might break. Integration tests catch this but only on the exporter repo.

**Mitigation**:
- Tier 2 tests explicitly assert all expected column names and order. Any production code change that modifies columns will fail tests immediately.
- If column order needs to change, it's a **breaking change** that requires version bump and consumer migration. Tests make this explicit.

---

### Open Question 1: Should Tier 1 Tests Run in CI on Every PR?

**Current plan**: Yes, `exporter/**` path filter in `.github/workflows/testcontainers-integration.yml`. This means every exporter PR triggers a full TS test suite run (+60s cold start or +30s warm).

**Alternative**: Run Tier 1 only for dashboard-server or message-pipeline PRs that might affect the exporter seam. Exporter-only PRs run Tier 2 locally.

**Recommendation**: Land Tier 1 with the path filter (current plan). It's the most conservative and catches regressions early. If CI time becomes an issue, we can optimize later (e.g., cache images, use warm starts).

---

### Open Question 2: Are Tier 2 Tests Worth the Engineering Effort?

**Context**: Tier 1 already validates the end-to-end contract (job insertion → link generation). Do we need Tier 2?

**Answer**: Yes. Tier 1 validates the **seam**, not the **internals**. Tier 2 tests:
- CSV column correctness (Tier 1 only spot-checks `'question_id' in csv_text`).
- Event-group filtering (Tier 1 doesn't test).
- Time-window filtering (Tier 1 doesn't test).
- Failure → retry → Failed states (Tier 1 doesn't test).
- User scoping at the SQL level (Tier 1 tests from outside; Tier 2 verifies the query itself).

These are critical for the exporter's reliability and are best tested in a Python environment closer to the code. Worth 4–6h of effort upfront.

---

### Open Question 3: Should Dashboard-Server Be Added to the Stack?

**Current decision**: No. Tier 1 tests insert export_status rows directly. Dashboard-server would add:
- Node.js service (small, but still a service).
- Auth0 JWT mocking.
- ~30s cold-start time.

**Trade-off**: We lose end-to-end testing of `POST /api/v1/exports`. But that's an API-tier test, not an exporter test. Dashboard-server can be tested with its own suite (API/integration tests). For exporter validation, testing the DB contract (export_status table) is sufficient.

**If this becomes a blocker**: Add dashboard-server in a follow-up. The groundwork in Tier 1 makes it straightforward.

---

## 9. Summary of Changes

### Files to Create
- `exporter/exporter/tests/test_integration_tc.py` (new Python testcontainers suite)
- `facebot/testrunner/fetch-url.ts` (one-shot `curl`-on-network HTTP helper)

### Files to Modify
- `facebot/testrunner/stack.ts`: Add exporter + MinIO containers; update Stack interface; update buildImages and startContainers logic.
- `facebot/testrunner/seed-db.ts`: Add `seedExportData()` function.
- `exporter/exporter/tests/conftest.py`: (optional) Add helpers for new tests.
- `facebot/testrunner/test.tc.ts`: Add 6 Tier 1 seam tests.
- `exporter/README.md`: Update to document correct env vars and remove obsolete KAFKA_* refs.
- `.github/workflows/testcontainers-integration.yml`: Add `exporter/**` to path filters.
- `documentation/testing.md`: Append "Exporter Integration Testing" section.

### Production Code Changes
**None.** Test speed is achieved purely with env overrides the service already reads (`POLL_INTERVAL_SECONDS=1`, `WORKER_THREADS=1`), and presigned-URL verification is done from inside the Docker network. If a `--once` single-job mode is later wanted for determinism (Section 3), that is a separate, explicitly-scoped change — not a prerequisite for this plan.

---

## Appendix: Code Sketches

### stack.ts Changes (outline)

```typescript
// Add to Stack interface
export interface Stack {
  // ... existing fields ...
  exporter: StartedTestContainer;
  minio: StartedTestContainer;
  minioPort: number;
}

// In buildImages loop (parallel):
const exporterImageName = 'exporter:test';
await GenericContainer.fromDockerfile(path.join(repoRoot, 'exporter')).build(exporterImageName);

// In startContainers:
const minio = await new GenericContainer('minio/minio:latest')
  .withNetwork(network)
  .withNetworkAliases('minio')
  .withExposedPorts(9000)
  .withEnvironment({
    'MINIO_ROOT_USER': 'minioadmin',
    'MINIO_ROOT_PASSWORD': 'minioadmin',
  })
  .withWaitStrategy(Wait.forLogMessage('API'))
  .start();

const exporter = await new GenericContainer(exporterImageName)
  .withNetwork(network)
  .withNetworkAliases('exporter')
  .withEnvironment({
    'DATABASE_URL': `postgresql://chatroach@cockroach:26257/chatroach?sslmode=disable`,
    'STORAGE_BACKEND': 's3',
    'S3_HOST': 'minio:9000',
    'S3_BUCKET_NAME': 'exports',
    'S3_ACCESS_KEY': 'minioadmin',
    'S3_SECRET_KEY': 'minioadmin',
    'S3_SSL_ENABLED': 'false',
    'POLL_INTERVAL_SECONDS': '1',
    'WORKER_THREADS': '1',
  })
  .withWaitStrategy(Wait.forLogMessage('worker.*started'))
  .start();

return {
  // ... existing ...
  exporter,
  minio,
  minioPort: minio.getMappedPort(9000),
};
```

### test.tc.ts Tier 1 Test (outline)

```typescript
describe('Exporter Integration', () => {
  
  before(async function() {
    // ... existing stack boot ...
    await seedExportData(chatbase);
  });

  it('exports responses and generates presigned MinIO link', async () => {
    const exportId = uuid();
    await chatbase.pool.query(`
      INSERT INTO export_status
        (id, user_id, survey_id, status, export_link, source, options)
      VALUES ($1, 'test-user@example.com', 'test-survey', 'Requested', 'Not Found', 'responses', '{}')
    `, [exportId]);

    // Wait for exporter to process
    await waitFor(async () => {
      const rows = await chatbase.pool.query(
        'SELECT status FROM export_status WHERE id = $1',
        [exportId]
      );
      return rows.rows[0]?.status === 'Finished';
    }, 15000);

    // Verify link is populated
    const row = await chatbase.pool.query(
      'SELECT export_link FROM export_status WHERE id = $1',
      [exportId]
    );
    expect(row.rows[0].export_link).to.be.a('string').and.not.equal('Not Found');

    // Fetch and verify CSV content
    const link = row.rows[0].export_link;
    const minioHost = `localhost:${stack.minioPort}`;
    const fetchLink = link.replace('minio:9000', minioHost);
    const csv = await fetch(fetchLink).then(r => r.text());
    expect(csv).to.include('question_id');
    expect(csv).to.include('response');
  });
});
```

### test_integration_tc.py Tier 2 Test (outline)

```python
@pytest.mark.asyncio
async def test_responses_export_column_correctness(
    db_url, minio_client, exporter_image
):
    export_id = str(uuid.uuid4())
    user_id = 'test@example.com'
    survey_id = 'test-survey'

    # Insert responses
    conn = psycopg2.connect(db_url)
    cursor = conn.cursor()
    cursor.execute("""
      INSERT INTO responses (userid, question_id, response, survey_id, timestamp)
      VALUES (%s, %s, %s, %s, NOW()),
             (%s, %s, %s, %s, NOW())
    """, (user_id, 'q1', 'yes', survey_id, user_id, 'q2', 'no', survey_id))

    # Insert export_status
    cursor.execute("""
      INSERT INTO export_status
        (id, user_id, survey_id, status, export_link, source, options)
      VALUES (%s, %s, %s, 'Requested', 'Not Found', 'responses', '{}')
    """, (export_id, user_id, survey_id))
    conn.commit()
    conn.close()

    # Trigger exporter
    # ... (container startup code) ...

    # Wait for completion
    # ... (polling code) ...

    # Fetch CSV from MinIO
    obj = minio_client.get_object('exports', f'exports/{export_id}.csv')
    csv_text = obj.read().decode('utf-8')

    # Verify columns
    lines = csv_text.strip().split('\n')
    header = lines[0]
    assert 'userid' in header
    assert 'question_id' in header
    assert 'response' in header
    assert 'survey_id' in header
    assert 'timestamp' in header

    # Verify data (2 rows + header = 3 lines)
    assert len(lines) == 3
    assert 'q1' in lines[1]
    assert 'yes' in lines[1]
```

---

**End of Plan**
