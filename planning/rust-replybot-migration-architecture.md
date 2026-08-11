# Rust Replybot Migration - Architecture Deep Dive

## System Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    EXTERNAL PLATFORMS                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐                        │
│  │  Messenger  │  │  WhatsApp    │  │  Instagram  │                        │
│  └─────────────┘  └──────────────┘  └─────────────┘                        │
└────────────┬────────────────┬────────────────┬──────────────────────────────┘
             │ Webhook POST   │ Webhook POST   │ Webhook POST
             │ /webhooks      │ /webhooks      │ /webhooks
             │                │                │
             └────────────────┼────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  BOTSERVER-CORE   │ Port 8080
                    │  (Rust HTTP)      │ Axum async server
                    │                   │
                    │ ✅ Platform Detection
                    │ ✅ Signature Verification (HMAC)
                    │ ✅ Event Normalization
                    │ ✅ Kafka Producer
                    │ ✅ Health Checks (port 8081)
                    │ ✅ Prometheus Metrics
                    │
                    │ Adapters:
                    │ ├─ Messenger (X-Hub-Signature SHA1)
                    │ ├─ WhatsApp (X-Hub-Signature-256 SHA256)
                    │ └─ Instagram (X-Hub-Signature SHA1)
                    │
                    └────────────┬──────────────┘
                                 │ Kafka events topic
                                 │ Key: platform
                                 │ Value: {platform, timestamp, data}
                                 │
                    ┌────────────▼──────────────┐
                    │   KAFKA (Message Queue)   │
                    └────────────┬──────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        │ Topic: events          │ Topic: commands        │ Topic: responses
        │                        │                        │
   ┌────▼───────┐          ┌─────▼─────┐          ┌──────▼──────┐
   │   MACHINE   │          │MESSAGE-   │          │PIPELINE/    │
   │  (Rust)     │          │WORKER     │          │ANALYTICS    │
   │             │          │(Go)       │          │(Go)         │
   │ ✅ Consumes │          │           │          │             │
   │    events   │          │ Translate │          │ QA data     │
   │ ✅ Loads    │          │ Send msgs │          │ (responses) │
   │    state    │          │           │          │             │
   │    (Redis)  │          └───────────┘          └─────────────┘
   │ ✅ Loads    │                                      │
   │    forms    │                                      │
   │    (Redis)  │          ┌──────────────┐           │
   │ ✅ Exec/    │          │EXTERNAL-     │           │
   │    Apply/   │          │WORKER (Go)   │           │
   │    Act      │          │              │           │
   │ ✅ Publishes│          │ Payment      │           │
   │    commands │    ◄─────┤ Handoff      │           │
   │ ✅ Publishing│          │ External API │           │
   │    responses│          │              │           │
   │ ✅ Publishing│          └──────────────┘           │
   │    states   │                                     │
   │ ✅ Redis    │          ┌──────────────────────────┼───────┐
   │    caching  │          │                          │       │
   │ ✅ Postgres │          │   PERSISTENCE LAYER      │       │
   │    snapshot │          │   (PostgreSQL)           │       │
   │ ✅ Health   │          │                          │       │
   │    checks   │          │ ├─ users table           │       │
   │            │          │ ├─ states table (cache)  │       │
   │ Port 8081: │          │ ├─ events table (log)    │       │
   │ ├─ /healthz│          │ ├─ forms table (cache)   │       │
   │ ├─ /readyz │          │ ├─ responses table       │       │
   │ ├─ /metrics│          │ └─ commands table        │       │
   │            │          │                          │       │
   └────────────┘          └──────────────────────────┼───────┘
                                                       │
                   ┌───────────────────────────────────┘
                   │
            ┌──────▼───────┐
            │    REDIS     │
            │  (Cache)     │
            │              │
            │ ├─ state:U   │ TTL 1h
            │ │  user_id   │
            │ │  state_data│
            │ ├─ form:F    │ TTL 24h
            │ │  form_id   │
            │ │  form_data │
            │ └─ ...       │
            │              │
            └──────────────┘
```

---

## State Machine Execution Flow

### Event Processing Pipeline (Per User, Per Event)

```
1. KAFKA CONSUMER receives event message
   ├─ Key: "user_123" (user_id)
   └─ Value: {platform: "messenger", timestamp: ..., data: {...}}

2. EVENT PARSER (machine/src/processor.rs)
   ├─ Deserialize JSON → UniversalEvent
   ├─ Extract user_id, platform, event_type
   └─ Enrich with timestamp, event_id

3. STATE LOADER (caching/)
   ├─ Try Redis get("state:user_123")
   ├─ If miss: Try Postgres SELECT from states WHERE user_id
   ├─ If miss: Replay events from event log
   └─ Load MachineState struct

4. FORM LOADER (caching/)
   ├─ Try Redis get("form:shortcode")
   ├─ If miss: Fetch from formcentral API
   └─ Load TypeformForm struct

5. EXEC DECISION (machine-core/src/exec.rs)
   ├─ Input: state, event, form
   ├─ Process: decision logic based on state + event
   ├─ Output: MachineAction enum
   └─ Examples:
      ├─ Action::Respond {question, response_value, ...}
      ├─ Action::WaitResponse {question, ...}
      ├─ Action::SwitchForm {form_entry, ...}
      ├─ Action::MakePayment {question, provider, ...}
      ├─ Action::Handoff {target_app_id, ...}
      ├─ Action::WaitExternalEvent {reason, ...}
      ├─ Action::End {question}
      └─ Action::Error {reason}

6. APPLY STATE UPDATE (machine-core/src/apply.rs)
   ├─ Input: current_state, action
   ├─ Process: state transition logic
   ├─ Output: new MachineState
   └─ Updates:
      ├─ state.current_state (StateType::*)
      ├─ state.forms (append FormEntry if switching forms)
      ├─ state.qa (append QA pair if responded)
      ├─ state.md (metadata updates)
      ├─ state.wait (if waiting)
      ├─ state.error (if error)
      └─ state.updated_at (timestamp)

7. ACT SIDE EFFECTS (machine-core/src/act.rs)
   ├─ Input: context, state, action
   ├─ Generate: Commands for workers
   ├─ Output: Vec<Command>
   └─ Command types:
      ├─ SendMessageCommand → message-worker
      ├─ ExternalServiceCommand → external-worker
      ├─ HandoffCommand → message-worker
      └─ MarkResponseCommand → pipeline

8. COMMAND PUBLISHING (machine/src/commands.rs)
   ├─ For each command:
   │  ├─ Serialize to JSON
   │  ├─ Publish to appropriate Kafka topic
   │  └─ Record command_id (for deduplication)
   │
   ├─ Response publishing (Kafka responses topic)
   │  ├─ {parent_shortcode, surveyid, response, ...}
   │  └─ → analytics pipeline
   │
   └─ State event publishing (Kafka states topic)
      ├─ {user_id, state, forms, ...}
      └─ → state store / audit log

9. CACHE UPDATE (Redis)
   ├─ SET redis "state:user_123" new_state (expire 1h)
   └─ New state now cached for next event

10. PERSISTENCE (PostgreSQL - async/eventual)
    ├─ Major state change? (e.g., form switch)
    ├─ Yes → INSERT into states (snapshot)
    └─ Always → Append to events table (event log)

11. METRICS & LOGGING
    ├─ metrics::EVENTS_PROCESSED_TOTAL.inc()
    ├─ metrics::EVENT_PROCESSING_DURATION.observe(duration)
    ├─ health::record_success()
    ├─ Trace log: "Event processed successfully"
    └─ Include: user_id, event_id, forms, state
```

---

## Machine-Core Business Logic

### State Transition Diagram

```
                    ┌────────┐
                    │  START │ (initial state)
                    └────────┘
                        │
                        │ user_first_input
                        ▼
    ┌──────────────────────────────────────┐
    │          RESPONDING                  │
    │  (answering form questions)          │
    │                                      │
    │ Tracks:                              │
    │ ├─ current_field_ref (question)      │
    │ ├─ response_value (answer)           │
    │ └─ qa pairs (for analytics)          │
    └──────────────────────────────────────┘
              │           │          │
          ┌───┴────┐  ┌──┴───┐  ┌───┴────┐
          │         │  │      │  │        │
          ▼         ▼  ▼      ▼  ▼        ▼
     ┌────────┐  ┌──────────┐ ┌──────────┐
     │ QOUT   │  │  WAIT    │ │ BLOCKED  │
     │ (end   │  │ (off-hrs/│ │(validation
     │ of     │  │ external)│ │ failure)
     │ form)  │  │          │ │          │
     │        │  │ Tracks:  │ │ Tracks:  │
     │ Tracks:│  │ ├─ wait  │ │ ├─ error │
     │ ├─ at  │  │ │ (cond) │ │ │ details│
     │ │ end  │  │ └─ wait_ │ │ └─ cause │
     │ └─      │  │   start │ │          │
     │        │  │(time)   │ │          │
     └────────┘  └──────────┘ └──────────┘
         │            │             │
         │            │ condition   │
         │            │ met         │ resolved
         └────┬───────┴─────────────┘
              │
              ▼
     ┌──────────────────┐
     │ RESPONDING again │
     │ (next field)     │
     └──────────────────┘
             │
             │ repeat until...
             │
         ┌───┴────────────────────────────┐
         │                                │
         ▼                                ▼
    ┌─────────┐                    ┌────────────┐
    │   END   │                    │ WAIT_EXTERNAL
    │         │◄───┐        ┌─────►│ _EVENT     │
    │ (form   │    │        │      │ (payment/  │
    │ ended)  │    │        │      │ handoff)   │
    │         │    │  completion  │            │
    └─────────┘    │    event     │ Tracks:    │
         │         │        │      │ ├─ await_  │
         │         │        │      │ │ ing_     │
         │    REDO │        │      │ │ completion
         │         │        │      │ └─ reason  │
         │    (retry)       │      │            │
         │         │        │      └────────────┘
         │         │        │            │
         │         │        │ success    │
         │         │        └────────────┘
         │         │
         └─────────┘
             │
         (end of)
         (convo)
             ▼
       [TERMINATE]
```

### Event Type Classification (exec.rs)

```
Events are categorized into 19+ types based on:
├─ Payload type (message, postback, referral, etc.)
├─ Message type (text, quick_reply, button, etc.)
├─ Platform specifics (Messenger has postback, WhatsApp has buttons)
├─ Validation state
└─ Special events (payment_result, handoff_complete, etc.)

CATEGORIZATION LOGIC:
  1. Extract event_type from payload
  2. If missing, fallback platform detection:
     ├─ Messenger: "text" or "quick_reply" → MessageReceived
     ├─ WhatsApp: "buttons" with list.reply → MessageReceived
     └─ Instagram: "message" text → MessageReceived
  3. Handle special events:
     ├─ "external_event" → ExternalEvent
     ├─ "payment_result" → PaymentResult
     ├─ "handoff_complete" → HandoffComplete
     └─ "error" → ErrorEvent

EVENT TYPES HANDLED:
  ✅ MessageReceived          - User sent text/choice
  ✅ QuickReply              - Quick reply button selected
  ✅ PostBack                - Messenger postback (menu)
  ✅ ButtonReply             - WhatsApp/Instagram button
  ✅ PhoneNumberReceived     - Contact sharing
  ✅ LocationReceived        - Location sharing
  ✅ ImageReceived           - Image/media upload
  ✅ FileReceived            - File upload
  ✅ ExternalEvent           - From handoff app
  ✅ PaymentResult           - Payment completion
  ✅ HandoffComplete         - Handoff completed
  ✅ OffHoursWaitStart       - Enter off-hours
  ✅ OffHoursWaitEnd         - Exit off-hours
  ✅ ConversationStart       - New conversation (referral)
  ✅ ErrorEvent              - Error occurred
  ✅ ReferralEvent           - Form referral
  ✅ ... plus platform-specific events
```

### Conditional Navigation Logic (navigation.rs)

```
For each question in the form:

GET_NEXT_FIELD(state, form, current_field):
├─ Get field from form.fields
├─ Check field.properties.conditions (if any)
│  ├─ Condition format:
│  │  {
│  │    "ref": "previous_field_ref",
│  │    "condition": {
│  │      "type": "is" | "is_not" | "gt" | "lt" | ...,
│  │      "value": expected_answer
│  │    }
│  │  }
│  │
│  └─ Evaluate against state.qa
│     ├─ Find previous answer from qa
│     ├─ Apply condition logic
│     ├─ If true → show this field
│     └─ If false → skip to next field
│
├─ Handle field types:
│  ├─ "multiple_choice" → options with conditions
│  ├─ "short_text" → text input
│  ├─ "long_text" → textarea
│  ├─ "email" → email input
│  ├─ "phone_number" → phone input
│  ├─ "number" → numeric input
│  ├─ "rating" → rating scale
│  ├─ "legal" → checkbox agreement
│  ├─ "ranking" → drag-to-order
│  ├─ "payment" → payment widget
│  ├─ "date" → date picker
│  └─ ... (16+ types)
│
└─ Return: {field_ref, field_object, is_last_field}

CONDITION OPERATORS:
  ✅ "is"           → answer == value
  ✅ "is_not"       → answer != value
  ✅ "gt"           → answer > value
  ✅ "lt"           → answer < value
  ✅ "gte"          → answer >= value
  ✅ "lte"          → answer <= value
  ✅ "contains"     → answer contains value
  ✅ "not_contains" → answer doesn't contain value
  ✅ "starts_with"  → answer starts with value
  ✅ "ends_with"    → answer ends with value
```

---

## Wait Condition Evaluation (waiting.rs)

```
WAIT CONDITIONS:
  Types can be time-based or event-based

TIME-BASED WAITS:
  ├─ OffHours
  │  ├─ Check: current_hour NOT in business_hours
  │  ├─ Business hours: typically 8am-8pm local time
  │  └─ Wait until: next business hour
  │
  ├─ Delay
  │  ├─ Check: now < wait_start + delay_ms
  │  ├─ Duration: e.g., 24 hours between questions
  │  └─ Wait until: delay expires
  │
  └─ Scheduled
     ├─ Check: now < scheduled_time
     └─ Wait until: specific datetime

EVENT-BASED WAITS:
  ├─ ExternalEvent
  │  ├─ Waiting for: payment_result, handoff_complete, etc.
  │  ├─ Tracked in: state.external_events
  │  └─ Triggered by: ExternalEvent received
  │
  └─ UserResponse
     ├─ Waiting for: next user message
     └─ No special handling (state tracks RESPONDING)

EVALUATION LOGIC:
  if state.state == StateType::Wait {
      let condition = state.wait?;
      match evaluate_condition(condition, current_time) {
          ConditionMet => {
              // Resume conversation
              action = exec(state, event, form)?
          },
          ConditionNotMet => {
              // Send "waiting" message or silence
              action = Action::Wait { ... }
          }
      }
  }
```

---

## Data Structures

### MachineState (machine-core/src/types.rs)

```rust
pub struct MachineState {
    // Core identification
    pub user_id: String,
    pub platform: PlatformType,
    pub platform_account_id: String,

    // State tracking
    pub current_state: StateType,     // START, QOUT, RESPONDING, WAIT, etc.
    pub current_field_ref: Option<String>,  // Current question reference
    pub current_form: Option<String>,       // Current form shortcode
    pub current_field_index: Option<usize>, // Index in form.fields

    // History
    pub forms: Vec<FormEntry>,        // Each: {shortcode, start_time}
    pub qa: Vec<QAPair>,              // (question_ref, answer) pairs
    pub md: HashMap<String, Value>,   // Metadata: seed, utm_params, etc.
    pub parent_form: Option<String>,  // Original form (for analytics)

    // Wait/external tracking
    pub wait: Option<Value>,          // Wait condition object
    pub wait_start: Option<i64>,      // When wait started (ms)
    pub external_events: Vec<Value>,  // Events waiting for
    pub awaiting_completion: Option<HashMap<String, AwaitingCommand>>,

    // Error tracking
    pub error: Option<Value>,         // Error details if blocked
    pub retries: Option<Vec<i64>>,    // Retry timestamps
    pub previous_output: Option<Value>, // For REDO

    // Versioning
    pub event_version: u64,
    pub last_event_id: String,
    pub created_at: i64,              // ms since epoch
    pub updated_at: i64,
}
```

### MachineAction (machine-core/src/action.rs)

```rust
pub enum MachineAction {
    // Question answered, move to next
    Respond {
        question: String,
        response: Option<String>,     // Message to send (optional)
        response_value: Option<Value>, // Structured answer
        validation: Option<ValidationResult>,
    },

    // Waiting for user response
    WaitResponse {
        question: String,
        timeout_ms: Option<u64>,
    },

    // Switch to different form
    SwitchForm {
        form_entry: FormEntry,
        message: Option<String>,
    },

    // Initiate payment
    MakePayment {
        question: String,
        provider: String,
        amount: i32,
        currency: String,
    },

    // Handoff to external app
    Handoff {
        target_app_id: String,
        metadata: Option<serde_json::Value>,
    },

    // Waiting for external event (payment/handoff result)
    WaitExternalEvent {
        question: String,
        reason: String,
        timeout_ms: Option<u64>,
    },

    // End conversation
    End {
        question: Option<String>,
        reason: Option<String>,
    },

    // Blocked due to error
    Blocked {
        reason: String,
        details: Option<serde_json::Value>,
    },

    // Retry/resume
    Redo {
        from_state: StateType,
    },

    // No action needed
    NoOp,
}
```

### UniversalEvent (machine-core/src/events.rs)

```rust
pub struct UniversalEvent {
    // Event identification
    pub event_id: String,
    pub event_type: String,  // "message_received", "payment_result", etc.
    pub created_at: i64,     // ms since epoch

    // Platform context
    pub platform: PlatformType,
    pub user_id: String,
    pub user_phone: Option<String>,
    pub user_name: Option<String>,

    // Conversation context
    pub conversation_id: String,
    pub message_id: Option<String>,

    // Payload
    pub payload: serde_json::Value, // Platform-specific data
    pub text: Option<String>,       // User text message
    pub selected_option: Option<String>, // User choice
    pub media_type: Option<String>, // image, file, location, etc.
    pub media_url: Option<String>,

    // Metadata
    pub metadata: Option<serde_json::Value>,
}
```

---

## Kafka Topics & Message Formats

### Topic: events (Webhook → Machine)

```
Key: platform (string)
Value: {
  "platform": "messenger" | "whatsapp" | "instagram",
  "timestamp": 1234567890000,
  "data": {
    // Platform-specific raw webhook
    "entry": [...],
    "messaging": [...]  // or "changes" for WhatsApp
  }
}
```

### Topic: commands (Machine → Workers)

```
Key: command_id (UUID)
Value: {
  "command_id": "cmd_123...",
  "conversation_id": "conv_456...",
  "user_id": "user_789...",
  "command_type": "send_message" | "payment" | "handoff",

  // For send_message:
  "platform": "messenger",
  "recipient_id": "user_789...",
  "message": {
    "type": "text" | "question" | "quick_reply",
    "text": "Hello!",
    "quick_replies": [
      {"title": "Yes", "value": "yes"},
      {"title": "No", "value": "no"}
    ]
  }

  // For payment:
  "provider": "reloadly",
  "amount": 1000,
  "currency": "UGX"

  // For handoff:
  "app_id": "app_456",
  "metadata": {...}
}
```

### Topic: responses (Machine → Analytics)

```
Key: user_id (string)
Value: {
  "parent_shortcode": "B6cIAn",
  "parent_surveyid": "survey_123",
  "surveyid": "survey_123",
  "shortcode": "B6cIAn",
  "flowid": 1,
  "userid": "user_789",
  "pageid": "1234567890",
  "question_ref": "q1",
  "question_idx": 0,
  "question_text": "What is your name?",
  "response": "John Doe",
  "seed": 12345,
  "timestamp": 1234567890000,
  "metadata": {...}
}
```

### Topic: states (Machine → State Store)

```
Key: user_id (string)
Value: {
  "user_id": "user_789",
  "state": "responding" | "wait" | "qout",
  "forms": [
    {"shortcode": "B6cIAn", "start_time": 1234567890000}
  ],
  "qa": [
    ["q1", "John Doe"]
  ],
  "current_field_ref": "q2",
  "platform": "messenger",
  "timestamp": 1234567890000
}
```

---

## Error Handling Strategy

### Error Tags (machine-core/src/error.rs)

```
ErrorTag::Validation      - Form field validation failed
ErrorTag::Navigation      - Can't find next question
ErrorTag::InvalidPayload  - Event data malformed
ErrorTag::NotFound        - Form/field/state not found
ErrorTag::Corrupted       - Data integrity issue
ErrorTag::Timeout         - Operation timed out
ErrorTag::External        - External service failed
ErrorTag::Payment         - Payment processing error
ErrorTag::Handoff         - Handoff failed
ErrorTag::Conflict        - State conflict (race condition)
ErrorTag::RateLimit       - Rate limited
ErrorTag::Unauthorized    - Auth failed
ErrorTag::Unknown         - Unknown/unclassified error
```

### Error Handling Pattern

```
1. ERROR DETECTION (exec/apply)
   └─ Detect invalid state/event combo
   └─ Return Err(MachineError { tag, message, details })

2. ERROR RECOVERY (processor)
   ├─ Match on error tag
   ├─ Validation error?
   │  ├─ Send error message to user
   │  └─ Transition to Blocked state
   ├─ Navigation error?
   │  ├─ Log error
   │  ├─ Send fallback message
   │  └─ Transition to Error state
   └─ Other?
      ├─ Retry with exponential backoff
      └─ Alert operator if persistent

3. ERROR LOGGING
   └─ Structured log with tags
   └─ Include: user_id, event_id, error_tag, message, details
   └─ Alert on severe errors (corruption, timeout)

4. ERROR METRICS
   └─ prometheus::EVENTS_FAILED_TOTAL{tag="validation"}.inc()
   └─ prometheus::ERROR_RATE by tag
```

---

## Performance Characteristics

### Expected Throughput

```
Per instance:
├─ Event processing: 1000+ events/sec
├─ P50 latency: <50ms (Redis cache hit)
├─ P95 latency: <200ms (Postgres cache miss)
├─ P99 latency: <500ms (event replay)

Scaling:
├─ 1 machine instance: 1000 events/sec
├─ 3 machine instances: 3000 events/sec (linear)
├─ Botserver: 1000+ webhooks/sec per instance

Memory:
├─ botserver-core: ~100MB per pod
├─ machine: ~150MB per pod
├─ Redis: ~500MB (10k users, ~100KB per user)
└─ Postgres: Depends on event log size

CPU:
├─ botserver-core: ~50m per pod at 100 req/s
├─ machine: ~100m per pod at 100 events/s
└─ Scales roughly linearly with throughput
```

### Caching Strategy Effectiveness

```
Typical request (with Redis):
1. Parse event:         1ms
2. Redis state lookup:  2ms (cache hit)
3. Redis form lookup:   2ms (cache hit)
4. Exec (logic):        10ms
5. Apply (transition):  5ms
6. Act (generate cmds): 5ms
7. Publish commands:    15ms
────────────────────────────
Total:                 ~40ms

Cache miss (worst case):
1-3. Same as above:     5ms
4. Postgres lookups:   10ms (snapshot + form)
5-7. Same:             20ms
────────────────────────────
Total:                 ~35ms (surprisingly similar!)

Event replay (rare):
1-3. Same:              5ms
4. Replay events:      50-200ms (depends on history)
5-7. Same:             20ms
────────────────────────────
Total:                 75-225ms
```

---

## Deployment Architecture

### Kubernetes Pods

```
NAMESPACE: prod

POD: botserver-core-{replica}
├─ Container: botserver-core:0.1.0
├─ Port 8080: Webhook receiver
├─ Port 8081: Health/metrics
├─ Resources:
│  ├─ CPU request: 100m
│  ├─ CPU limit: 500m
│  ├─ Memory request: 128Mi
│  └─ Memory limit: 256Mi
├─ Health checks:
│  ├─ Liveness: GET /healthz → 200
│  ├─ Readiness: GET /readyz → 200
│  └─ Interval: 10s, timeout: 5s
├─ Autoscaling:
│  ├─ Min replicas: 2
│  ├─ Max replicas: 10
│  └─ Target CPU: 80%
└─ ServiceMonitor:
   └─ Prometheus scrapes /metrics

POD: machine-{replica}
├─ Container: machine:0.1.0
├─ Port 8081: Health/metrics
├─ Resources:
│  ├─ CPU request: 200m
│  ├─ CPU limit: 1000m
│  ├─ Memory request: 256Mi
│  └─ Memory limit: 512Mi
├─ Environment:
│  ├─ KAFKA_BROKERS: kafka-broker:9092
│  ├─ REDIS_URL: redis://redis:6379
│  ├─ DATABASE_URL: postgres://user:pwd@postgres:5432/db
│  └─ RUST_LOG: info
├─ Health checks:
│  ├─ Readiness: GET /readyz → 200
│  └─ Check Kafka connectivity
└─ Autoscaling:
   ├─ Min replicas: 2
   ├─ Max replicas: 10
   └─ Target CPU: 80%

SERVICE: botserver (LoadBalancer)
├─ Port 80 → Pod 8080
└─ External IP: botserver.example.com

SERVICE: prometheus (for /metrics)
├─ Port 9090
└─ Scrapes botserver and machine
```

---

## Summary

The Rust replybot migration creates a modern, type-safe, high-performance replacement for the Node.js replybot while maintaining the same business logic and event flows. The architecture emphasizes:

1. **Pure Functions** - exec/apply/act separation
2. **Event Sourcing** - immutable event log as source of truth
3. **Caching** - Redis hot cache, Postgres cold cache
4. **Observability** - structured logging, metrics, health checks
5. **Reliability** - at-least-once delivery, idempotent consumers
6. **Performance** - sub-100ms latency, 1000+ events/sec per instance
