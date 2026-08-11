# Machine Implementation Analysis

## Purpose

This document analyzes the Rust Machine implementation to clarify the relationships between **metadata**, **FormContext**, **state**, **events**, and **logic**. The goal is to ensure we have the correct mental model before proceeding with implementation.

---

## Part 1: Core Concepts Overview

### 1.1 The Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        EVENT LAYER                                   │
│  UniversalEvent: Platform-agnostic representation of all events     │
│  - user_text, user_interaction, bot_message_sent, external_event    │
└───────────────────────────────┬─────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│                        STATE MACHINE LAYER                           │
│  exec(state, event, form) → MachineAction                           │
│  apply(state, action) → MachineState                                │
│  act(state, action, form) → Commands                                │
└───────────────────────────────┬─────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│                        OUTPUT LAYER                                  │
│  Commands: SendMessage, ExternalService, etc.                       │
│  State Events: StateChanged (for analytics/audit)                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Key Data Structures

| Concept            | Rust Type        | JS Equivalent   | Purpose                             |
|--------------------|------------------|-----------------|-------------------------------------|
| User State         | `MachineState`   | `state` object  | Tracks user's conversation progress |
| Form Definition    | `TypeformForm`   | `form` object   | The survey/questionnaire structure  |
| Evaluation Context | `FormContext`    | `ctx` object    | Context for interpolation & logic   |
| Incoming Data      | `UniversalEvent` | `event` object  | Platform-agnostic event             |
| Output Decision    | `MachineAction`  | `output` object | What the machine decided to do      |

---

## Part 2: Data Structure Deep Dive

### 2.1 MachineState

**Purpose**: Tracks a user's progress through forms and their conversation history.

```rust
MachineState {
    // Identity
    user_id: String,
    platform: PlatformType,
    platform_account_id: String,

    // Current Position
    current_state: StateType,        // START, QOUT, RESPONDING, WAIT_EXTERNAL_EVENT, END, ERROR, BLOCKED
    current_form: Option<String>,    // Which form shortcode
    current_field_ref: Option<String>, // Which field reference
    current_field_index: Option<usize>, // Index in fields array

    // History
    forms: Vec<FormEntry>,           // [{shortcode, start_time}, ...]
    qa: Vec<(Value, Value)>,         // [(question_ref, answer), ...]
    parent_form: Option<String>,     // Original form from initial referral (for analytics)

    // Metadata (navigation context only - see section 2.4)
    md: HashMap<String, Value>,      // seed, id, referral params, e_* fields

    // Wait State
    wait: Option<Value>,             // Wait condition when WAIT_EXTERNAL_EVENT
    wait_start: Option<i64>,         // When wait began
    external_events: Vec<Value>,     // Collected events while waiting

    // Tracking
    tokens: Option<Vec<String>>,     // One-time notification tokens
    pointer: Option<i64>,            // Event pointer for deduplication
    retries: Option<Vec<i64>>,       // Retry timestamps
    error: Option<Value>,            // Error details if ERROR/BLOCKED
    previous_output: Option<Value>,  // For REDO functionality
    awaiting_completion: Option<HashMap<String, AwaitingCommand>>,

    // Versioning
    event_version: u64,
    last_event_id: String,
    created_at: i64,
    updated_at: i64,
}
```

### 2.2 TypeformForm (Form Definition)

**Purpose**: Defines the structure of a survey/questionnaire.

```rust
TypeformForm {
    id: Option<String>,
    title: String,
    fields: Vec<TypeformField>,      // The questions
    thankyou_screens: Vec<TypeformField>,
    logic: Vec<TypeformLogic>,       // Branching rules
    hidden: Vec<String>,             // Hidden field names
    custom_messages: Value,          // Error messages, etc.
    off_time: Option<i64>,           // When survey closes
    // ... other typeform metadata
}
```

### 2.3 FormContext (Evaluation Context)

**Purpose**: Provides context for evaluating logic conditions and interpolating variables.

```rust
FormContext {
    form: TypeformForm,   // The form definition
    md: Value,            // Metadata (same as state.md, contains id for user)
}
```

**Note**: The `user` field was removed as part of the Rust simplification. User ID is now stored directly in `state.md` as `id`, so `FormContext.md = state.md` with no transformation needed.

**Critical Insight**: FormContext is constructed at evaluation time from:
- The form definition (loaded from FormCentral)
- Metadata (from state.md, which includes user `id`)

### 2.4 Metadata (md) - NAVIGATION CONTEXT ONLY

**Purpose**: `state.md` is exclusively for form navigation (logic conditions and interpolation).

**What's IN state.md** (navigation context):
- `id` - User ID for `{{hidden:id}}` interpolation
- `seed` - Computed from `hash(form + user_id)` for deterministic `seed_N` patterns
- Referral params - Arbitrary key-values from URL `?ref=form.SURVEY.key1.value1`
- `e_*` fields - External event data (payment results, handover data, etc.)

**What's NOT in state.md** (moved to dedicated fields):
| Data        | JS Replybot Location | Rust Machine Location                     |
|-------------|----------------------|-------------------------------------------|
| Parent form | `state.md.form`      | `state.parent_form`                       |
| Page ID     | `state.md.pageid`    | `state.platform_account_id`               |
| Start time  | `state.md.startTime` | `state.forms[].start_time` (in FormEntry) |

**Metadata Flow**:
```
Referral Event → Extract referral params + id → state.md
External Event → make_event_metadata() → Merge into state.md
Logic Evaluation → FormContext.md (= state.md) → Condition vars
Interpolation → {{hidden:key}} looks up from ctx.md
```

---

## Part 3: Event Processing Flow

### 3.1 The exec/apply/act Pipeline

```
                    ┌──────────────────┐
                    │  UniversalEvent  │
                    └────────┬─────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   ↓                   │
         │     ┌─────────────────────────┐       │
         │     │   categorize_event()    │       │
         │     │  → EventCategory        │       │
         │     └───────────┬─────────────┘       │
         │                 │                     │
         │                 ↓                     │
┌────────┴─────────────────────────────────────────────────────────┐
│                         exec()                                    │
│                                                                   │
│  Input: (state, event, Option<form>)                              │
│  Output: MachineAction                                            │
│                                                                   │
│  Responsibilities:                                                │
│  1. Categorize event                                              │
│  2. Check if event is relevant to current state                   │
│  3. Validate response (if user input)                             │
│  4. Determine next action (RESPOND, WAIT, END, etc.)              │
│  5. Extract metadata from event                                   │
└────────┬─────────────────────────────────────────────────────────┘
         │
         ↓
┌──────────────────────────────────────────────────────────────────┐
│                         apply()                                   │
│                                                                   │
│  Input: (state, action)                                           │
│  Output: MachineState                                             │
│                                                                   │
│  Responsibilities:                                                │
│  1. Update state.current_state based on action type               │
│  2. Merge state_update fields into state                          │
│  3. Record QA pairs                                               │
│  4. Update metadata                                               │
│  5. Track wait conditions                                         │
└────────┬─────────────────────────────────────────────────────────┘
         │
         ↓
┌──────────────────────────────────────────────────────────────────┐
│                          act()                                    │
│                                                                   │
│  Input: (state, action, form)                                     │
│  Output: Vec<Command>                                             │
│                                                                   │
│  Responsibilities:                                                │
│  1. Get next field (navigation + logic)                           │
│  2. Interpolate variables in question text                        │
│  3. Gather statements (multiple messages)                         │
│  4. Extract payment/handoff metadata                              │
│  5. Generate SendMessage commands                                 │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Navigation & Logic Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    get_next_field()                              │
│                                                                  │
│  1. Get current field index                                      │
│  2. Check if field has logic rules (form.logic)                  │
│  3. For each logic action:                                       │
│     a. Evaluate condition against FormContext                    │
│     b. If true, jump to target field                             │
│  4. If no logic matches, go to next field index                  │
│  5. If at end, go to thankyou_screen                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│               evaluate_condition()                               │
│                                                                  │
│  Operators: equal, is, greater_than, contains, and, or, always  │
│                                                                  │
│  Variable Sources:                                               │
│  - field:ref → Look up in qa pairs                               │
│  - hidden:key → Look up in ctx.md                                │
│  - choice:ref → Check if choice was selected                     │
│  - constant:value → Literal value                                │
│  - seed:N → Deterministic random 1-N based on ctx.md.seed        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 4: State Transitions

### 4.1 State Machine Diagram

```
                    ┌───────┐
                    │ START │
                    └───┬───┘
                        │ REFERRAL/conversation_started
                        ↓
                    ┌───────────┐
              ┌────→│ RESPONDING│←────────────────────┐
              │     └─────┬─────┘                     │
              │           │ Send question             │
              │           ↓                           │
              │     ┌───────────┐                     │
              │     │   QOUT    │ (Question sent,     │
              │     │           │  waiting for answer)│
              │     └─────┬─────┘                     │
              │           │                           │
              │     ┌─────┴─────┐                     │
              │     │           │                     │
              │     ↓           ↓                     │
              │  User       Wait needed?              │
              │  responds       │                     │
              │     │           ↓                     │
              │     │   ┌───────────────────┐         │
              │     │   │ WAIT_EXTERNAL_EVENT│        │
              │     │   └─────────┬─────────┘         │
              │     │             │                   │
              │     │       ┌─────┴─────┐             │
              │     │       │           │             │
              │     │   Timeout    External           │
              │     │       │      Event              │
              │     │       │           │             │
              │     └───────┴───────────┴─────────────┘
              │
              │ (continues until thankyou_screen)
              │
              ↓
          ┌───────┐
          │  END  │
          └───────┘

  Error States: ERROR, BLOCKED, USER_BLOCKED
```

### 4.2 Action → State Mapping

| Action | From State | To State | What Happens |
|--------|------------|----------|--------------|
| `RESPOND` | QOUT/RESPONDING | RESPONDING | Answer recorded, move to next |
| `WAIT_RESPONSE` | RESPONDING | QOUT | Question sent, wait for answer |
| `WAIT_EXTERNAL_EVENT` | RESPONDING | WAIT_EXTERNAL_EVENT | Wait for payment/timeout |
| `SWITCH_FORM` | Any | RESPONDING | Reset to new form |
| `END` | RESPONDING | END | Conversation complete |
| `BLOCKED` | Any | BLOCKED | User blocked by platform |
| `ERROR` | Any | ERROR | System error |

---

## Part 5: Critical Interactions

### 5.1 Metadata ↔ Logic Interaction

**How metadata influences logic evaluation**:

```
User answers question with ref="income"
  → qa.push(("income", "50000"))
  → Logic rule: if income > 40000, jump to "premium_offer"
  → evaluate_condition({op: "greater_than", vars: [{field: "income"}, {constant: 40000}]})
  → Looks up "income" in qa → finds 50000
  → 50000 > 40000 → true
  → Jump to "premium_offer"
```

**How external events influence logic**:

```
Payment event arrives
  → make_event_metadata(event) → {e_payment_success: true, e_payment_amount: 100}
  → Merge into state.md
  → Next field has logic: if e_payment_success == true, jump to "thank_you"
  → evaluate_condition looks up "e_payment_success" in ctx.md (from state.md)
  → true == true → jump to "thank_you"
```

### 5.2 FormContext Construction

**When FormContext is created**:
```rust
// In act() or navigation functions
let ctx = FormContext {
    form: form.clone(),
    md: serde_json::to_value(&state.md).unwrap(),  // Contains id, seed, referral params, e_* fields
};
```

**Note**: User ID is stored as `id` in state.md, so no separate user object is needed.

**Critical**: FormContext.md is a SNAPSHOT of state.md at evaluation time. Changes to state.md after FormContext creation won't affect that evaluation.

### 5.3 QA ↔ Navigation Interaction

**How QA pairs enable field lookups**:
```rust
// qa = [("name", "Alice"), ("age", "30"), ("city", "NYC")]

// In logic condition: {type: "field", value: "age"}
fn get_field_value(qa: &[(Value, Value)], ref_: &str) -> Option<Value> {
    qa.iter()
        .find(|(q, _)| q.as_str() == Some(ref_))
        .map(|(_, a)| a.clone())
}
// Returns: Some("30")
```

### 5.4 Event → Metadata Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    make_event_metadata()                         │
│                                                                  │
│  Input: UniversalEvent with type="external" or "handover"        │
│                                                                  │
│  Processing:                                                     │
│  1. Extract event.payload.value                                  │
│  2. Get event type prefix (e.g., "payment:reloadly" → "e_payment_reloadly")  │
│  3. Flatten nested objects with underscore prefixes              │
│  4. Convert camelCase to snake_case                              │
│                                                                  │
│  Output: HashMap<String, Value>                                  │
│    {                                                             │
│      "e_payment_reloadly_success": true,                         │
│      "e_payment_reloadly_error_code": "INVALID_NUMBER"           │
│    }                                                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 6: Differences from Replybot (JS)

### 6.1 Structural Improvements in Rust

The Rust implementation has a cleaner architecture than the JS replybot:

| Aspect      | Replybot (JS)            | Machine (Rust)                                  | Improvement                      |
|-------------|--------------------------|-------------------------------------------------|----------------------------------|
| Forms array | `["SURVEY1", "SURVEY2"]` | `Vec<FormEntry>` with `{shortcode, start_time}` | Timestamp embedded, not in md    |
| Parent form | `state.md.form`          | `state.parent_form`                             | Dedicated field, clear semantics |
| Page ID     | `state.md.pageid`        | `state.platform_account_id`                     | Top-level field                  |
| FormContext | `{form, user, md}`       | `{form, md}`                                    | Simplified, user id in md        |
| QA pairs    | `[[ref, answer], ...]`   | `Vec<(Value, Value)>`                           | Type-safe                        |
| Metadata    | Mixed-purpose bag        | Navigation-only                                 | Cleaner separation of concerns   |
| State type  | String literals          | `StateType` enum                                | Type-safe                        |
| Events      | Platform-specific        | `UniversalEvent`                                | Platform-agnostic                |

### 6.2 Key Design Decisions

1. **state.md is navigation-only**: Contains only data needed for logic conditions and interpolation (seed, id, referral params, e_* fields)

2. **Dedicated fields for non-navigation data**: `parent_form`, `platform_account_id`, and `FormEntry.start_time` are explicit fields rather than being buried in metadata

3. **FormContext simplified**: No separate `user` object - user ID stored as `id` in state.md, so `FormContext.md = state.md` directly

### 6.3 Behavioral Parity Checklist

| Feature                | JS Location     | Rust Location          | Status             |
|------------------------|-----------------|------------------------|--------------------|
| Event categorization   | `transition.js` | `event_category.rs`    | ✅                 |
| State transitions      | `machine.js`    | `exec.rs` + `apply.rs` | ✅                 |
| Logic evaluation       | `form.js`       | `navigation.rs`        | ✅                 |
| Variable interpolation | `form.js`       | `interpolate.rs`       | ✅                 |
| Metadata extraction    | `utils.js`      | `metadata.rs`          | ✅                 |
| Statement gathering    | `form.js`       | `act.rs`               | ⚠️ Partial          |
| Off-time handling      | `form.js`       | `act.rs`               | ❌ Not implemented |
| Wait conditions        | `waiting.js`    | `waiting.rs`           | ✅                 |
| Validation             | `validator.js`  | `validate.rs`          | ✅                 |

---

## Part 7: Known Issues & Test Status

### 7.1 Failing/Skipped Tests

1. **Off-time handling** (7 tests) - `off_time_handling_tests.rs`
   - Status: Expected to fail
   - Issue: Off-time logic not implemented in act layer
   - Impact: Forms won't reject responses after closing time

2. **Form bug integration** (1 test) - `integration_test_form_bug.rs`
   - Status: Ignored
   - Issue: Button payload format mismatch for legal/yes_no fields

### 7.2 Potential Issues to Investigate

1. **Metadata propagation**: Is metadata correctly passed from exec → apply → act?
2. **FormContext timing**: Is FormContext constructed with current state.md?
3. **QA recording**: Are QA pairs recorded before or after navigation?
4. **Event deduplication**: Is event_version/last_event_id correctly updated?

---

## Part 8: Questions to Answer

### Critical Questions:

1. **When should metadata be updated?**
   - In exec() when processing external events?
   - In apply() when applying state_update?
   - Both?

2. **What's the correct order of operations in RESPOND?**
   - Record QA → Navigate → Interpolate → Send?
   - Navigate → Record QA → Interpolate → Send?

3. **How should FormContext.md be constructed?**
   - Fresh copy of state.md at each evaluation?
   - Cached copy from start of processing?

4. **What happens to accumulated external_events after wait fulfilled?**
   - Clear them?
   - Keep them for debugging?
   - Move relevant data to metadata?

---

## Part 9: Recommended Next Steps

1. **Run the full test suite** and categorize failures
2. **Trace a complete flow** through exec/apply/act with logging
3. **Compare JS and Rust outputs** for identical inputs
4. **Document the correct metadata propagation** path
5. **Fix the off-time implementation** in act.rs

---

## Appendix: File Locations

### Machine Core (Pure Logic)
- `machine-core/src/types.rs` - MachineState, StateType, FormEntry
- `machine-core/src/action.rs` - MachineAction enum
- `machine-core/src/events.rs` - UniversalEvent, EventCategory
- `machine-core/src/exec.rs` - Event → Action logic
- `machine-core/src/apply.rs` - Action → State transitions
- `machine-core/src/act.rs` - Action → Commands generation
- `machine-core/src/navigation.rs` - FormContext, get_next_field, conditions
- `machine-core/src/metadata.rs` - make_event_metadata
- `machine-core/src/waiting.rs` - Wait condition evaluation
- `machine-core/src/interpolate.rs` - Variable interpolation
- `machine-core/src/validate.rs` - Field validation

### Machine Binary (Integration)
- `machine/src/main.rs` - Kafka consumer entry point
- `machine/src/processor.rs` - Full pipeline orchestration
- `machine/src/caching/` - Redis + FormCentral caching

### Replybot (JS Reference)
- `replybot/lib/typewheels/machine.js` - Main orchestrator
- `replybot/lib/typewheels/transition.js` - exec/apply
- `replybot/lib/typewheels/form.js` - Navigation, interpolation
- `replybot/lib/typewheels/waiting.js` - Wait conditions
- `replybot/lib/typewheels/utils.js` - Metadata extraction
