# Rust Replybot Migration - Quick Reference Guide

**For**: Team members needing to understand the Rust codebase quickly
**Status**: Branch `feat/rust-replybot-migration`
**Date**: 2026-03-22

---

## One-Liner Summary

Complete Rust rewrite of Node.js replybot with botserver (webhook receiver) 100% done and machine (event processor) 90% done. Uses functional state machine pattern (exec/apply/act) with event sourcing. Ready for code review and deployment testing.

---

## The Three Main Components

### 1. BOTSERVER-CORE (100% Complete)
- **What**: HTTP server that receives webhooks from Messenger, WhatsApp, Instagram
- **Where**: `/botserver-core/src/main.rs` (570 lines)
- **Key Logic**:
  - Platform detection from webhook body
  - HMAC signature verification
  - Event envelope creation
  - Kafka publishing
- **Tests**: 51/51 passing
- **Deployment**: Separate pod, port 8080 (webhooks), 8081 (health/metrics)

### 2. MACHINE-CORE (85% Complete)
- **What**: Pure business logic library for state machine transitions
- **Where**: `/machine/machine-core/` (3500+ LOC)
- **Key Modules**:
  - `exec.rs` - Event → Action decision logic
  - `apply.rs` - Action → State transitions
  - `navigation.rs` - Form traversal with conditionals
  - `waiting.rs` - Wait condition evaluation
  - `act.rs` - Command generation
- **Tests**: 21 integration tests (all passing)
- **Key Pattern**: `exec(state, event) → action; apply(state, action) → new_state`

### 3. MACHINE (90% Complete)
- **What**: Kafka consumer that orchestrates state machine and caches
- **Where**: `/machine/src/` (1000+ LOC)
- **Key Logic**:
  - Consume Kafka events
  - Load state (Redis → Postgres → replay)
  - Load form (Redis → API)
  - Call exec → apply → act pipeline
  - Publish commands to workers
- **Caching**: Redis (hot, 1h TTL), Postgres (cold, snapshots)
- **Tests**: Inherits machine-core tests + processor integration tests

---

## The Flow (Simplified)

```
User Message → Platform → Botserver → Kafka events
                                          ↓
                                      Machine ↓
                    ┌───────────────────────┴────────────────────────┐
                    ↓                       ↓                         ↓
            Redis (state cache)    Exec → Apply → Act    Postgres (snapshots)
                    ↑                       ↓                         ↑
                    └───────────────────────┴────────────────────────┘
                                            ↓
                        Publish Commands → Kafka commands
                                            ↓
                        Message-Worker (send messages)
                        External-Worker (payments)
```

---

## Critical File Paths

### To Understand the State Machine
- `/machine/machine-core/src/types.rs` - MachineState struct definition
- `/machine/machine-core/src/exec.rs` - Event categorization (19+ types)
- `/machine/machine-core/src/apply.rs` - State transitions
- `/machine/machine-core/src/navigation.rs` - Conditional form navigation

### To Understand Event Processing
- `/machine/src/processor.rs` - Main processing loop
- `/machine/src/caching/` - Redis/Postgres cache layer
- `/machine/src/commands.rs` - Command generation

### To Understand Webhooks
- `/botserver-core/src/main.rs` - HTTP handlers
- `/botserver-core/src/adapters/` - Messenger, WhatsApp, Instagram verification

### To Understand Testing
- `/machine/machine-core/tests/` - 21 integration tests
- `/machine/machine-core/tests/fixtures/forms/` - Real Typeform examples

---

## State Machine Overview

### 8 States
```
START → RESPONDING ← WAIT/ERROR/BLOCKED
          ↓
        QOUT (end of form)
          ↓
     WAIT_EXTERNAL_EVENT (payment/handoff)
          ↓
        END or REDO
```

### 9+ State Transitions
| Event | Action | Result |
|-------|--------|--------|
| user_message | Respond | Move to next field |
| validation_fails | ValidationError | BLOCKED state |
| at_qout | WaitResponse | WAIT or SwitchForm |
| off_hours | WaitCondition | WAIT state |
| payment_needed | MakePayment | WAIT_EXTERNAL_EVENT |
| payment_complete | Continue | Back to RESPONDING |
| handoff_needed | Handoff | WAIT_EXTERNAL_EVENT |
| handoff_complete | Resume | Back to RESPONDING |
| conversation_ends | End | END state |

---

## Event Categories (exec.rs)

Machine-core handles 19+ event types:
- MessageReceived (text, choice)
- QuickReply (Messenger)
- PostBack (Messenger menu)
- ButtonReply (WhatsApp/Instagram)
- PhoneNumberReceived (contact sharing)
- LocationReceived (map share)
- ImageReceived (media)
- FileReceived (document)
- PaymentResult (payment completion)
- HandoffComplete (handoff ended)
- ExternalEvent (from third-party app)
- OffHoursWaitStart/End (schedule-based)
- ConversationStart (referral)
- ... (plus platform-specific events)

---

## Key Patterns Used

### 1. Exec/Apply/Act
```rust
// Pure decision logic (testable, no side effects)
let action = exec(&state, &event, form)?;

// Pure state update (immutable, no side effects)
let new_state = apply(&state, &action)?;

// Side effect generation (all I/O isolated here)
let commands = act(&context, &state, &action)?;
```

### 2. Event Sourcing
- Events are immutable, append-only log
- State rebuilt by replaying: `reduce(events, initial_state, exec+apply)`
- Database snapshots are just cache, not truth
- No schema migrations needed (rebuild from events)

### 3. At-Least-Once Delivery
```rust
// Consume event from Kafka
// Process it (may fail and retry)
// ONLY commit offset AFTER success
// If process crashes, message redelivered
// Workers check command_id for deduplication
```

### 4. Cache-Aside Pattern
```rust
// Try Redis first (fast, hot)
// If miss: Postgres (slow, cold)
// If miss: Expensive operation (replay events)
// On success: Update both levels
// TTL: State 1h, Form 24h
```

---

## Configuration

### Botserver-Core
```
Required:
  KAFKA_BROKERS=kafka:9092
  MESSENGER_APP_SECRET=... (if using Messenger)
  WHATSAPP_APP_SECRET=... (if using WhatsApp)
  INSTAGRAM_APP_SECRET=... (if using Instagram)

Optional (with defaults):
  SERVER_PORT=8080
  HEALTH_PORT=8081
  KAFKA_EVENTS_TOPIC=events
  LOG_FORMAT=json (or "pretty" for dev)
```

### Machine
```
Required:
  KAFKA_BROKERS=kafka:9092
  REDIS_URL=redis://redis:6379
  DATABASE_URL=postgres://user:pass@db:5432/replybot

Optional:
  STATE_CACHE_TTL=3600
  FORM_CACHE_TTL=86400
  HEALTH_PORT=8081
  LOG_FORMAT=json
  RUST_LOG=info
```

---

## Testing Commands

```bash
# Run all machine-core tests
cd machine/machine-core
cargo test --lib    # Unit tests
cargo test --test   # Integration tests

# Run specific test
cargo test navigation_logic_tests::

# With output
cargo test -- --nocapture

# Watch for changes
cargo watch -x test

# Check compilation
cargo check

# Format code
cargo fmt

# Lint
cargo clippy
```

---

## Known TODOs (Not Blocking)

| File | Line | Issue | Priority |
|------|------|-------|----------|
| act.rs | 249 | Token support | Low |
| event_category.rs | 137 | Remove fallback detection | Low |
| navigation.rs | 281 | Optimize cloning | Low |
| statestore.rs | 1100 | Add Telegram support | Low |
| form_test.rs | 142 | Real Redis/Postgres tests | Medium |
| integration_test_form_bug.rs | 130 | Fix button payload format | Medium |

---

## Deployment Overview

### Development/Staging
```bash
# Build image
docker build -f botserver-core/Dockerfile -t botserver:dev .
docker build -f machine/Dockerfile -t machine:dev .

# Run locally with docker-compose
docker-compose -f docker-compose.yml up

# Port forward to Kubernetes service
kubectl port-forward svc/botserver 8080:8080
kubectl port-forward svc/machine 8081:8081
```

### Production
```bash
# Using Helm
helm install botserver ./botserver-core/chart \
  --namespace prod \
  --values prod-values.yaml

helm install machine ./machine/chart \
  --namespace prod \
  --values prod-values.yaml

# Verify
kubectl get pods -n prod
kubectl logs deployment/botserver -n prod
kubectl logs deployment/machine -n prod
```

---

## Health Checks

**Botserver** (port 8081):
- `/healthz` - Liveness (always 200 if process alive)
- `/readyz` - Readiness (200 only if Kafka connected and ready)
- `/metrics` - Prometheus metrics

**Machine** (port 8081):
- `/healthz` - Liveness
- `/readyz` - Readiness (checks Kafka, caches)
- `/metrics` - Prometheus metrics

---

## Common Questions

**Q: How is state stored?**
A: Not in database. State is rebuilt from event log by replaying events through exec/apply. Database snapshots are just cache for performance.

**Q: What if state service crashes?**
A: Event log is in Kafka. On restart, machine replays events from log to reconstruct state. No data loss.

**Q: How are messages sent?**
A: Machine generates SendMessageCommand (in machine-core/src/act.rs) and publishes to Kafka. message-worker (Go service) consumes and calls platform APIs.

**Q: How does conditional navigation work?**
A: Each form field has optional "conditions" object. Machine checks if user's previous answer matches condition before showing field (navigation.rs:navigate_to_next_field).

**Q: What's the difference between botserver and machine?**
A: Botserver = HTTP webhook receiver (simple, stateless). Machine = Kafka consumer, state machine executor (complex, stateful).

**Q: Why two separate services?**
A: Separation of concerns. Botserver handles spike in webhooks. Machine can process at its own pace. Kafka decouples them.

**Q: Can I test without real Kafka?**
A: Yes! machine-core tests use in-memory state, no Kafka needed. For integration tests, use testcontainers.

---

## Getting Started (New Team Member)

1. **Understand the flow**: Read this quick reference + architecture diagram in `rust-replybot-migration-architecture.md`

2. **Find code you care about**:
   - Business logic? → `/machine/machine-core/src/`
   - Webhook handling? → `/botserver-core/src/adapters/`
   - State machine? → `/machine/machine-core/src/exec.rs` and `apply.rs`
   - Caching? → `/machine/src/caching/`

3. **Run tests**:
   ```bash
   cd machine/machine-core
   cargo test
   ```

4. **Read tests**: Look at `/machine/machine-core/tests/` to see real examples

5. **Ask questions**: Check TODOs and comments in code

---

## Useful Links

- **Full findings**: `/planning/rust-replybot-migration-findings.md` (14K words)
- **Architecture details**: `/planning/rust-replybot-migration-architecture.md`
- **Next steps**: `/planning/rust-replybot-migration-next-steps.md`
- **Implementation plans**: `/botserver-core/IMPLEMENTATION_PLAN.md`
- **Test docs**: `/machine/machine-core/TESTING.md`

---

## At a Glance: Component Maturity

| Component | Status | Tests | Review Ready | Deploy Ready |
|-----------|--------|-------|--------------|--------------|
| botserver-core | 100% | 51/51 | ✅ Yes | ✅ Yes |
| machine-core | 85% | 21/21 | ✅ Yes | ⚠️ Minor TODOs |
| machine | 90% | Inherit | ✅ Yes | ⚠️ Via machine-core |
| message-worker | - | - | ℹ️ Go | ℹ️ Go |
| external-worker | - | - | ℹ️ Go | ℹ️ Go |
| vlab-types | Missing | - | ❌ No | ❌ No |

**Next Action**: Code review → Staging deployment → Load testing → Canary production rollout
