# Error Events B3 Scope: Consumer Mechanism Decision

**Decision question:** Should the `errors` projection be built as (1) a scribble sink, or (2) a standalone service?

> **STATUS — scoping only; Piece B is DEFERRED.** See `planning/error-events.md`
> for why (the `form`/`platform` attribution problem is not solved by any choice
> made here). Restart from the decisions in that doc, not from this one.
>
> **Verification status of what follows:**
> - ✅ Verified first-hand: the `Scribbler` interface and the
>   `ON CONFLICT(hsh, userid) DO NOTHING` precedent in `scribble/message.go:32-39`;
>   `hsh` as a CRDB-computed column (`devops/migrations/01-init.sql:22-23`).
> - ⚠️ **Not** verified first-hand: the topic/consumer-group table in §2–§3, the
>   staging/production `values.yaml` line references, and the Kafka retention
>   figure. Re-check these against the repo before relying on them.
>
> **One correction to apply if this is ever built:** §6 says the sink should
> "filter to `type='machine_report'`". That is necessary but *not sufficient* —
> the success and RESET paths also publish error-free `machine_report`s, so the
> filter must also require an `error` key. The on-disk path is
> `content->'event'->'value'->'error'`, **not** `->'payload'->`. See
> `planning/error-events-b2-payload.md` §1–§2.
>
> **Note on identity:** the sink would compute its own `fnv64a` over the Kafka
> value bytes. Those are the same bytes scribble stores as `messages.content`,
> so a live-sink row and a `messages`-replay backfill row land on the same
> identity — which is what makes the two paths agree. Preserve that property.

---

## 1. Scribble: Architecture & Sink Model

### What is Scribble?

Scribble is a **Kafka-to-CockroachDB sink service** — a lightweight plugin framework for building event projections. Located at `/scribble/` in the repo. It runs as Kubernetes Deployments, **one per destination table**, each consuming from its own Kafka topic and writing to a single table.

**Design principle:** multiple independent instances, one destination each. Config via environment variables; Helm chart at `/scribble/chart/` deploys each destination as its own pod.

Reference: `/scribble/README.md` §Architecture, §Configuration.

### Sink Programming Model: The `Scribbler` Interface

Every destination implements two functions. From `/scribble/write.go:75-78`:

```go
type Scribbler interface {
	SendBatch([]Writeable) error
	Marshal(*kafka.Message) (Writeable, error)
}
```

And the `Writeable` contract (line 10-11):

```go
type Writeable interface {
	GetRow() []interface{}
}
```

**Workflow:** 
1. **`Marshal(*kafka.Message) (Writeable, error)`** — deserialize one Kafka message into a Go struct; return the struct (or error if invalid)
2. **`Writeable.GetRow()`** — return a flat slice of column values in order
3. **`SendBatch([]Writeable)`** — execute a bulk INSERT/UPSERT with all rows

### What Can a Sink Do? (Filter, Transform, Dedup, Upsert)

**Filter by type/content:** Not built-in. The sink receives **every message from the topic**. If filtering is needed, it must happen in `Marshal` — read the message, return `nil` for non-matching events (will fail validation). Alternatively, use `SCRIBBLE_STRICT_MODE=false` to skip validation errors and silently ignore.

**Reshape/flatten JSON into typed columns:** Yes — `Marshal` deserializes JSON into a Go struct with named fields. From `/scribble/response.go:18-33` (real sink, excerpt):

```go
type Response struct {
	ParentShortcode    *CastString     `json:"parent_shortcode"`
	Surveyid           string          `json:"surveyid" validate:"required"`
	Shortcode          *CastString     `json:"shortcode" validate:"required"`
	Flowid             int32           `json:"flowid" validate:"required"`
	Userid             string          `json:"userid" validate:"required"`
	// … 9 more fields
	Timestamp          *JSTimestamp    `json:"timestamp" validate:"required"`
	Metadata           json.RawMessage `json:"metadata" validate:"required"`
}
```

Fields are unmarshalled by field tag (`json:"fieldname"`); struct validation via `go-playground/validator` catches required fields, types. This validates **before** write.

**Dedup on event identity (hash):** Not built-in. But `SendBatch` generates the SQL upsert — you control the conflict clause. From `/scribble/message.go:32-39` (the messages table, which already dedupes on `hsh`):

```go
func (s *MessageScribbler) SendBatch(data []Writeable) error {
	values := BatchValues(data)
	fields := []string{"userid", "timestamp", "content"}
	query := SertQuery("INSERT", "messages", fields, len(data))
	query += ` ON CONFLICT(hsh, userid) DO NOTHING`
	_, err := s.pool.Exec(context.Background(), query, values...)
	return err
}
```

The query builder `/scribble/utils.go:10-15` generates parameterized `INSERT INTO table(cols) VALUES (…), (…)` statements; you append the conflict clause. E.g. for idempotent replay with event identity dedup:

```sql
INSERT INTO errors(userid, account_id, platform, form, timestamp, tag, code, message, stack, state_json, event, hsh)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12), ...
ON CONFLICT(hsh, userid) DO NOTHING
```

**Compute hash for dedup:** Sink can do it in `Marshal`. Call `fnv64a(event_json)` (or compute `hsh` before marshalling). No built-in hash library, but trivial to add.

**Idempotent upsert:** Yes. `ON CONFLICT DO NOTHING` (for append-only) or `ON CONFLICT DO UPDATE` (for state overwrite). From `/scribble/state.go:65` (states table, UPSERT):

```go
query := SertQuery("UPSERT", "states", fields, len(data))
// generates: UPSERT INTO states(cols) VALUES (…)
// (CockroachDB UPSERT is a full replace on conflict)
```

**Summary:** The sink model allows **filtering (by returning nil/validation error), JSON reshape (struct tags), hashing (in Marshal), and any conflict clause (in SendBatch)**. It is **sufficient for the `errors` projection** — filter by event type, extract fields, hash for idempotent replay.

---

## 2. Existing Projections: House Pattern

Four existing destinations, all deployed as scribble sinks. Staging config at `/devops/values/staging.yaml` §scribble → sinks:

| Destination | Topic | Consumer Group | Conflict Clause | Sink File |
|-------------|-------|-----------------|---|---|
| `states` | `vlab-staging-state` | `scribble-states` | `UPSERT` (replace on userid) | `/scribble/state.go` |
| `responses` | `vlab-staging-response` | `scribble-responses` | `ON CONFLICT(userid, timestamp, question_ref) DO NOTHING` | `/scribble/response.go` |
| `messages` | `vlab-staging-chat-events` | `scribble-messages` | `ON CONFLICT(hsh, userid) DO NOTHING` | `/scribble/message.go` |
| `chat-log` | `vlab-staging-chat-log` | `scribble-chat-log` | `ON CONFLICT(userid, timestamp, direction) DO NOTHING` | `/scribble/chatlog.go` |

Each is a separate Kubernetes Deployment (one pod per destination). All use the same Docker image, different `SCRIBBLE_DESTINATION` env var. Deployment: one line per sink in `/scribble/chart/` — Helm template iterates `sinks` array.

**CQRS precedent:** `messages` and `states` both consume from `vlab-staging-chat-events` topic (same events, different consumer groups: `scribble-messages` and `replybot`). This is the **house pattern for multi-consumer projection** — one topic, many independent readers, each projecting to its own table. No coordination needed.

**Backfill pattern:** `messages`, `states`, `responses` are all _projections of the durable event log_. To rebuild: drop the table, replay the topic from offset 0. Kafka topic retention in `/devops/values/staging.yaml` §kafkaTopics: 31 days (2,678,400,000 ms). For older data, replay from CockroachDB `messages` table (durable past topic retention) — write a small backfill tool (query `messages`, produce to Kafka topic as if new events, let scribble consume).

No existing backfill runbook in the repo; typical pattern is a one-off script or CronJob.

---

## 3. Kafka Topology & Machine-Report Events

**Where `machine_report` events live:**

1. **Source:** Both replybot (`/replybot/lib/typewheels/transition.js`) and message-worker (`/message-worker/worker.go`) emit `machine_report` events (type field = `"machine_report"`).
2. **Topic:** They publish to the **same event topic as all other events**: `/devops/values/staging.yaml` line `chatTopic: &topic "vlab-staging-chat-events"`. This is `BOTSERVER_EVENT_TOPIC` / `VLAB_EVENT_TOPIC` environment variable.
3. **Landing:** In `messages` table (all events, durable log) via the `scribble-messages` sink.
4. **Current consumers of `vlab-staging-chat-events`:**
   - `replybot` (consumer group `replybot`, from `/devops/kafka-consumer-health/values.yaml`)
   - `scribble-messages` (consumer group `scribble-messages`)

**Adding `errors` projection:** Add a **new consumer group `scribble-errors`** consuming the same topic, writing to `errors` table. Precedent: `scribble-messages` already does this, reading all events.

---

## 4. Comparison: Scribble Sink vs. Standalone Service

### Scribble Sink Option

**Capability:**
- Filter by event type in `Marshal` ✓
- Extract & reshape fields ✓
- Hash for dedup ✓
- Idempotent upsert on `ON CONFLICT(hsh, userid) DO NOTHING` ✓

**Files to create:**
- `/scribble/errors.go` — ~100 lines. `ErrorEvent` struct, `ErrorScribbler.Marshal`, `ErrorScribbler.SendBatch`
- `/devops/values/staging.yaml` — add one `sinks` entry (4 lines of YAML)
- `/devops/values/production.yaml` — add one `sinks` entry (4 lines of YAML)

**Deployment cost:**
- Zero new Dockerfile, Helm chart, image build, registry push. Reuse existing scribble image.
- One pod per environment (already running in staging/prod; add to integrations).
- CI: no new Docker build step. Version bumps are at the scribble image level (shared across all sinks).

**Ops cost:**
- Alerts: add to `/devops/kafka-consumer-health/values.yaml` — one line per environment.
- Logs: already in scribble pod logs.
- Scaling: adjust `SCRIBBLE_BATCH_SIZE` / `SCRIBBLE_CHUNK_SIZE` in YAML (batch sizing applies per sink).

**Backfill:**
- Replay `vlab-staging-chat-events` from offset 0 (31-day retention).
- For older data: write a small `ereplaybackfill.go` (100 lines) that queries `messages` table for `type='machine_report'`, produces to Kafka, scribble consumes. Tested: run once, spot-check counts.

### Standalone Service Option

**New service structure (precedent: exodus, hermes):**
- `/errors-consumer/` directory with Go binary
- Dockerfile (multi-stage: build, runtime alpine)
- `/errors-consumer/chart/` Helm chart (Deployment manifest)
- CI pipeline: build Docker image, push to registry (vlabresearch/errors-consumer), bump version in values.yaml

**Capability:**
- Same as scribble sink (Marshal, filter, hash, upsert).

**Files to create:**
- `/errors-consumer/main.go`, `/errors-consumer/consumer.go`, `/errors-consumer/errors.go` — ~300 lines total
- `/errors-consumer/go.mod`, `/errors-consumer/go.sum` (dependencies: pgx, confluent-kafka-go, caarlos0/env, go-playground/validator)
- `/errors-consumer/Dockerfile` (same pattern as exodus)
- `/errors-consumer/chart/values.yaml`, `templates/deployment.yaml` (same pattern as exodus)
- `/devops/values/{staging,production,integrations}.yaml` — add service config section (~20 lines per env)
- CI: `.github/workflows/build-errors-consumer.yml` or similar (if not using monorepo build)

**Deployment cost:**
- New image, new registry entry, new version management.
- If using centralized CI: add build step (mirrors existing steps for other Go services).
- If using per-service CI: new workflow file.

**Ops cost:**
- Separate pod, separate logs, separate alerts (Kafka lag monitoring).
- Scaling: adjust pod resources, consumer batch sizes independently (no shared config with other sinks).
- Lifecycle: independent versioning, deployment cadence. Can deploy errors-consumer without redeploying scribble.

**Backfill:**
- Same as scribble (Kafka replay or custom backfill script).

### Decision Matrix

| Factor | Scribble Sink | Standalone Service |
|--------|---------------|-------------------|
| **Capability** | Sufficient (filter, hash, upsert) | Sufficient |
| **Lines of code** | ~100 (single file) | ~300 (3 files + chart + CI) |
| **Docker image** | Reuse existing | New image, new registry entry |
| **Helm chart** | Reuse existing (add to `sinks` array) | New chart |
| **CI/CD** | None (no new build) | New build step or workflow |
| **Pod overhead** | Shared with other sinks (~6 pods for all 5 destinations) | +1 pod per env |
| **Scaling** | Shared batch config (all sinks batch size 64-128) | Independent scaling |
| **Alerts** | One line in kafka-consumer-health | New alert rule + latency monitoring |
| **Deployment friction** | Change YAML, scribble pod auto-picks up new sink destination | Requires new image build, registry push, Helm update |
| **Testing** | Existing scribble test suite; add test for errors sink | New test suite + integration tests |
| **Maintenance burden** | Low (no new code to monitor) | Moderate (new service to on-call) |

---

## 5. Recommendation

**Use a scribble sink.**

**Reasoning:**

1. **Capability is sufficient.** The sink model allows filtering (by event type), reshaping JSON (struct tags), hashing for dedup, and idempotent upsert (ON CONFLICT). No features of a standalone service are needed.

2. **Dramatically lower deployment cost.** One 100-line Go file vs. a full service (3 files + chart + CI). No new Docker image, no registry push, no version management. Reuse proven, stable scribble framework.

3. **House pattern precedent.** `scribble-messages` and `replybot` both consume `vlab-staging-chat-events` today — this is CQRS as practiced in the repo. Adding `scribble-errors` is identical.

4. **Backfill is identical either way.** Both options replay the same Kafka topic.

5. **Future flexibility.** If the errors consumer ever needs complex orchestration (cross-topic joins, multi-stage filtering, workflow logic), promotion to a standalone service is a clean migration: extract the sink logic, add the orchestration.

6. **Operational simplicity.** Shared infrastructure (scribble deployment, logging, alerts), lower on-call burden.

---

## 6. Implementation (Scribble Sink Path)

### Files to create/modify:

1. **`/scribble/errors.go`** (new, ~100 lines)
   - `ErrorEvent` struct: unmarshal Kafka JSON into `{ userid, account_id, platform, form, timestamp, tag, code, message, stack, state_json, event, hsh }`
   - `ErrorScribbler.Marshal(*kafka.Message)` — deserialize, filter to `type='machine_report'`, compute hash on event JSON, return `ErrorEvent` or nil
   - `ErrorScribbler.SendBatch([]Writeable)` — generate upsert SQL with `ON CONFLICT(hsh, userid) DO NOTHING`

2. **`/scribble/scribble.go`** (modify, line 64-75)
   - Add `"errors": NewErrorScribbler` to the `marshallers` map

3. **`/devops/values/staging.yaml`** (modify, after line ~340 in scribble.sinks)
   - Add sink entry:
     ```yaml
     - destination: "errors"
       replicaCount: 1
       env:
       - name: KAFKA_TOPIC
         value: *topic  # vlab-staging-chat-events
       - name: KAFKA_GROUP
         value: "scribble-errors"
       - name: SCRIBBLE_CHUNK_SIZE
         value: "32"
       - name: SCRIBBLE_BATCH_SIZE
         value: "64"
       - name: SCRIBBLE_STRICT_MODE
         value: "false"
     ```

4. **`/devops/values/production.yaml`** (modify, same addition)

5. **`/devops/values/integrations/fly.yaml`** (modify, if errors sink should run in integrations)

6. **`/devops/kafka-consumer-health/values.yaml`** (modify, ~line 30-ish)
   - Add alert rule per environment:
     ```yaml
     - { env: staging, group: scribble-errors, topic: vlab-staging-chat-events, drainSeconds: 600, severity: warning }
     - { env: production, group: scribble-errors, topic: vlab-production-chat-events, drainSeconds: 600, severity: warning }
     ```

7. **`/scribble/errors_test.go`** (new, ~50 lines)
   - Test `Marshal` filters non-error events, extracts fields, computes hash
   - Test `SendBatch` executes upsert (mock DB or integration test)

8. **Backfill script** (new optional, `/tools/backfill-errors.go` or similar, ~100 lines)
   - Query `messages` table for `type='machine_report'`, produce to Kafka, scribble consumes
   - Run post-deployment, verify counts match

### Verification (B3 step):
- Run scribble-errors pod, produce synthetic machine_report events to Kafka, verify rows appear in `errors` table
- Run again with same events, verify no duplicates (idempotent on hsh)

---

## References

- Scribble README: `/scribble/README.md`
- Scribble interfaces: `/scribble/write.go:10-11, 75-78`
- Message sink (hash dedup precedent): `/scribble/message.go:32-39`
- State sink (UPSERT precedent): `/scribble/state.go:55-68`
- Kafka topology: `/devops/kafka-consumer-health/values.yaml` (consumer groups), `/devops/values/staging.yaml` §kafkaTopics (topic definitions)
- House pattern: scribble-messages and replybot both consuming `vlab-staging-chat-events` (same topic, different consumer groups)
- Error events design: `/documentation/error-events.md` §3, §4
- Implementation plan context: `/planning/error-events.md` §Piece B, §B3
