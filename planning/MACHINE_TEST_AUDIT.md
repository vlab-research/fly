# Machine Test Suite Audit

## Executive Summary

This audit analyzes the Rust machine-core test suite against four key dimensions:
1. **Behavioral Parity** with Replybot JS tests
2. **DRY Principles** in test helper usage
3. **Redundancy** analysis across test files
4. **Test Hierarchy** (unit vs integration patterns)

**Key Findings:**
- **170+ tests** across 21 test files (~14,400 lines)
- **Good behavioral coverage** but gaps in: off-time handling, form retake prevention, notify permissions
- **Moderate DRY adherence** - helpers exist but are duplicated across files
- **Some redundancy** in form builders and event creators
- **Clear layer separation** but inconsistent unit/integration boundaries

---

## Part 1: Behavioral Parity Analysis

### Replybot JS Test Coverage (Reference)

| Test File | Lines | Key Behaviors |
|-----------|-------|---------------|
| `machine.test.js` | 2,464 | Error handling, state transitions, handoff, payment |
| `form.test.js` | 649 | Field interpolation, logic conditions, Unicode numerals |
| `waiting.test.js` | 449 | External events, timeouts, OR/AND operators |
| `transition.test.js` | 418 | exec/apply pipeline, state output |
| `handoff.test.js` | 247 | Handoff YAML parsing, metadata extraction |
| `events.test.js` | 245 | Event parsing, platform normalization |
| `statestore.test.js` | 141 | Redis caching, TTL management |
| `utils.test.js` | 113 | Metadata extraction, hashing, form extraction |
| **Total** | **4,726** | |

### Machine Rust Test Coverage (Current)

| Test File | Est. Tests | Lines | Status |
|-----------|-----------|-------|--------|
| `event_sourcing_tests.rs` | 44 | 1,100+ | ✅ |
| `command_generation_tests.rs` | 31 | 1,656 | ✅ |
| `exec_apply_tests.rs` | 30+ | 510 | ✅ |
| `navigation_logic_tests.rs` | 20+ | 687 | ✅ |
| `wait_conditions_comprehensive_tests.rs` | 15+ | 300+ | ✅ |
| `error_recovery_comprehensive_tests.rs` | 13 | 880 | ✅ |
| `translation_tests.rs` | 12 | 510 | ✅ |
| `redo_comprehensive_tests.rs` | 10+ | 400+ | ✅ |
| `payment_handling_tests.rs` | 8+ | 400+ | ✅ |
| `handoff_protocol_tests.rs` | 8+ | 300+ | ✅ |
| `business_flows_tests.rs` | 5 | 300+ | ✅ |
| `statement_gathering_tests.rs` | 5 | 300+ | ✅ |
| `off_time_handling_tests.rs` | 5 | 300+ | ❌ Expected to fail |
| `webview_interpolation_tests.rs` | 5+ | 200+ | ✅ |
| `integration_logic_tests.rs` | 6-8 | 200+ | ✅ |
| `integration_form_lifecycle_tests.rs` | 5-7 | 200+ | ✅ |
| `integration_wait_tests.rs` | 6-8 | 200+ | ✅ |
| `integration_validation_tests.rs` | 2-3 | 100+ | ✅ |
| `payment_result_logic_tests.rs` | 5+ | 200+ | ✅ |
| `condition_debug_test.rs` | 1+ | Small | ⚙️ Debug |
| `integration_test_form_bug.rs` | 1 | Small | 🔴 Ignored |
| **Total** | **~170+** | **~14,400** | |

### Behavioral Mapping: Replybot → Machine

| Replybot Behavior | JS Test Location | Rust Test Location | Coverage |
|-------------------|------------------|-------------------|----------|
| **State Transitions** | | | |
| START → RESPONDING on referral | `machine.test.js:getState` | `exec_apply_tests.rs` | ✅ Full |
| RESPONDING → QOUT on echo | `machine.test.js:getState` | `exec_apply_tests.rs` | ✅ Full |
| QOUT → RESPONDING on user input | `machine.test.js:getState` | `exec_apply_tests.rs` | ✅ Full |
| Any → BLOCKED on error | `machine.test.js:getState` | `error_recovery_comprehensive_tests.rs` | ✅ Full |
| Any → ERROR on bad form | `machine.test.js:getState` | `error_recovery_comprehensive_tests.rs` | ✅ Full |
| WAIT_EXTERNAL_EVENT transitions | `machine.test.js:getState` | `wait_conditions_comprehensive_tests.rs` | ✅ Full |
| | | | |
| **Logic & Navigation** | | | |
| Yes/No branching | `form.test.js:jump` | `navigation_logic_tests.rs`, `integration_logic_tests.rs` | ✅ Full |
| Hidden field (seed) logic | `form.test.js:getCondition` | `integration_logic_tests.rs` | ⚠️ Partial |
| Multiple OR clauses | `form.test.js:getCondition` | `wait_conditions_comprehensive_tests.rs` | ✅ Full |
| Nested AND/OR conditions | `form.test.js:getCondition` | `navigation_logic_tests.rs` | ✅ Full |
| Unicode numeral support | `form.test.js:getCondition` | Not found | ❌ Missing |
| | | | |
| **Interpolation** | | | |
| {{hidden:name}} substitution | `form.test.js:interpolateField` | `command_generation_tests.rs`, `webview_interpolation_tests.rs` | ✅ Full |
| {{field:ref}} substitution | `form.test.js:interpolateField` | `command_generation_tests.rs` | ✅ Full |
| URL encoding in URLs | `form.test.js:interpolateField` | `webview_interpolation_tests.rs` | ⚠️ Partial |
| | | | |
| **Validation** | | | |
| Phone validation | `form.test.js` (implicit) | `validate.rs` unit tests | ✅ Full |
| Email validation | `form.test.js` (implicit) | `validate.rs` unit tests | ✅ Full |
| Custom error messages | `form.test.js` | `translation_tests.rs` | ✅ Full |
| | | | |
| **Wait Conditions** | | | |
| External event fulfillment | `waiting.test.js` | `wait_conditions_comprehensive_tests.rs` | ✅ Full |
| Timeout (duration) | `waiting.test.js` | `wait_conditions_comprehensive_tests.rs` | ✅ Full |
| Timeout (RFC3339 absolute) | `waiting.test.js` | `wait_conditions_comprehensive_tests.rs` | ✅ Full |
| OR operator | `waiting.test.js` | `wait_conditions_comprehensive_tests.rs` | ✅ Full |
| AND operator | `waiting.test.js` | `wait_conditions_comprehensive_tests.rs` | ✅ Full |
| Event normalization | `waiting.test.js:_normalizeEvent` | `events.rs` | ✅ Full |
| | | | |
| **Error Handling** | | | |
| FB error → BLOCKED | `machine.test.js` | `error_recovery_comprehensive_tests.rs` | ✅ Full |
| MachineIOError tags | `machine.test.js` | `error_recovery_comprehensive_tests.rs` | ✅ Full |
| Unblock recovery | `machine.test.js` | `error_recovery_comprehensive_tests.rs` | ✅ Full |
| | | | |
| **Form Features** | | | |
| Form stitching | `machine.test.js:getState` | `command_generation_tests.rs`, `exec_apply_tests.rs` | ✅ Full |
| Form reset | `machine.test.js:getState` | `exec_apply_tests.rs` | ✅ Full |
| Statement gathering | `machine.test.js` | `statement_gathering_tests.rs` | ✅ Full |
| keepMoving auto-advance | `form.test.js` | `statement_gathering_tests.rs` | ⚠️ Partial |
| Off-time handling | `machine.test.js` | `off_time_handling_tests.rs` | ❌ Not implemented |
| | | | |
| **Handoff** | | | |
| Handoff YAML parsing | `handoff.test.js` | `handoff_protocol_tests.rs` | ✅ Full |
| Handoff with target_app_id | `handoff.test.js` | `handoff_protocol_tests.rs` | ✅ Full |
| Handoff wait conditions | `handoff.test.js` | `handoff_protocol_tests.rs` | ✅ Full |
| Handover event handling | `waiting.test.js` | `handoff_protocol_tests.rs` | ✅ Full |
| | | | |
| **Payment** | | | |
| Payment field handling | `machine.test.js` | `payment_handling_tests.rs` | ✅ Full |
| Payment result logic jumps | `machine.test.js` | `payment_result_logic_tests.rs` | ✅ Full |
| | | | |
| **Redo/Retry** | | | |
| Retry tracking | `machine.test.js` | `redo_comprehensive_tests.rs` | ✅ Full |
| Redo message resending | `machine.test.js` | `redo_comprehensive_tests.rs` | ✅ Full |
| | | | |
| **Platform Support** | | | |
| Multi-platform events | `events.test.js` | `exec_apply_tests.rs` | ✅ Full |
| Platform-agnostic processing | implicit | `exec_apply_tests.rs` | ✅ Full |

### Critical Gaps (Not in Machine Tests)

| Gap | Replybot Coverage | Impact | Priority |
|-----|-------------------|--------|----------|
| **Off-time handling** | `machine.test.js:1887-1979` | Forms won't close at scheduled time | HIGH |
| **Form retake prevention** | Facebot E2E tests | Users can retake completed forms | HIGH |
| **Unicode numeral parsing** | `form.test.js:getCondition` | Arabic/Devanagari numerals fail | MEDIUM |
| **Notify permission field** | Facebot E2E tests | Notification tokens not handled | MEDIUM |
| **Follow-up messages** | Facebot E2E tests | No follow-ups on user inactivity | MEDIUM |
| **Absolute timeout_date** | Facebot E2E tests | Date-based timeouts may fail | MEDIUM |

---

## Part 2: DRY Analysis (Test Helper Usage)

### Available Testing Helpers (`machine_core::testing`)

| Category | Helper | Purpose | Usage |
|----------|--------|---------|-------|
| **Constants** | `USER_ID`, `ACCOUNT_ID` | Standard test identifiers | Consistent |
| **Fields** | `field(ref, title, type)` | Basic field creation | Good |
| **Fields** | `choice_field(ref, title, choices)` | Multiple choice fields | Good |
| **Forms** | `form(id, fields)` | Form creation | Good |
| **Forms** | `forms::contact()`, `forms::simple_survey()` | Pre-built forms | Underused |
| **State** | `state()` | Initial state | Good |
| **State** | `state_with_form(id)` | State with form loaded | Good |
| **State** | `state_at_field(form, field)` | State at QOUT | Good |
| **Events** | `event(type, payload)` | Generic event | Good |
| **Events** | `events::conversation_started(form)` | Referral event | Good |
| **Events** | `events::user_text(text)` | User text input | Good |
| **Context** | `nav_context(form)` | Navigation context | Good |
| **Context** | `interp_context(user, md, responses)` | Interpolation context | Good |
| **Assertions** | `assert::validation_ok(result)` | Validation passed | Underused |
| **Assertions** | `assert::validation_err(result)` | Validation failed | Underused |
| **Assertions** | `assert::field_answer(state, ref, expected)` | Q&A verification | Underused |

### DRY Violations Found

#### 1. **Duplicated Event Creators** (HIGH)

The same event helper functions are duplicated across multiple test files:

```rust
// Found in: business_flows_tests.rs, error_recovery_comprehensive_tests.rs,
//           redo_comprehensive_tests.rs, wait_conditions_comprehensive_tests.rs,
//           statement_gathering_tests.rs, off_time_handling_tests.rs,
//           handoff_protocol_tests.rs, payment_handling_tests.rs

fn event(event_type: &str, user_id: &str, ts: u64, payload: Value) -> UniversalEvent { ... }
fn referral(form_id: &str, ts: u64) -> UniversalEvent { ... }
fn user_text(text: &str, ts: u64) -> UniversalEvent { ... }
fn echo(field_ref: &str, ts: u64) -> UniversalEvent { ... }
fn external_event(event_type: &str, ts: u64, payload: Value) -> UniversalEvent { ... }
```

**Impact:** 8+ files with ~50 lines of duplicated code each = ~400 lines

**Recommendation:** Move to `testing/mod.rs` as `events::referral_with_ts()`, `events::user_text_with_ts()`, etc.

#### 2. **Duplicated Form Builders** (MEDIUM)

Each test file creates its own form helper:

```rust
// command_generation_tests.rs
fn make_simple_form() -> TypeformForm { ... }
fn make_form_with_statements() -> TypeformForm { ... }

// translation_tests.rs
fn make_basic_form() -> TypeformForm { ... }
fn make_form_with_custom_messages() -> TypeformForm { ... }

// exec_apply_tests.rs
fn create_test_form() -> TypeformForm { ... }
```

**Impact:** 10+ variations of simple form creation

**Recommendation:** Expand `forms::` module with `forms::two_questions()`, `forms::with_statements()`, `forms::with_logic()`.

#### 3. **Duplicated State Builders** (LOW)

```rust
// Found across multiple files:
fn create_test_state() -> MachineState { ... }
fn make_initial_state() -> MachineState { ... }
```

**Impact:** Minor - `state()` helper exists but some tests don't use it

#### 4. **Missing ActContext Builder** (MEDIUM)

Every test that uses `act()` manually constructs `ActContext`:

```rust
// Repeated in: command_generation_tests.rs, translation_tests.rs, statement_gathering_tests.rs
let ctx = ActContext {
    form: form.clone(),
    user_id: "test_user".to_string(),
    platform: PlatformType::Messenger,
    timestamp: 1000,
    metadata: json!({}),
    conversation_id: "conv_123".to_string(),
    page_id: "page_123".to_string(),
};
```

**Recommendation:** Add `testing::act_context(form)` helper.

### DRY Score: **6/10**

- Core helpers exist and are well-designed
- Significant duplication in event sourcing test patterns
- Pre-built forms underutilized
- Assertion helpers underutilized

---

## Part 3: Redundancy Analysis

### Redundant Test Coverage

| Behavior | Files Testing It | Redundancy Level |
|----------|------------------|------------------|
| Basic referral → first question | `command_generation_tests.rs`, `event_sourcing_tests.rs`, `business_flows_tests.rs` | LOW (different angles) |
| User text response flow | `command_generation_tests.rs`, `exec_apply_tests.rs`, `event_sourcing_tests.rs` | MEDIUM |
| Logic jumps (simple) | `command_generation_tests.rs`, `navigation_logic_tests.rs`, `event_sourcing_tests.rs` | MEDIUM |
| Form switching | `command_generation_tests.rs`, `exec_apply_tests.rs`, `business_flows_tests.rs` | MEDIUM |
| State type transitions | `exec_apply_tests.rs`, `event_sourcing_tests.rs`, `error_recovery_comprehensive_tests.rs` | LOW (complementary) |
| Validation errors | `command_generation_tests.rs`, `integration_validation_tests.rs`, `translation_tests.rs` | MEDIUM |
| Wait condition fulfillment | `wait_conditions_comprehensive_tests.rs`, `integration_wait_tests.rs` | LOW |

### Test Files by Purpose

```
┌─────────────────────────────────────────────────────────────────────┐
│                        UNIT TESTS                                    │
├─────────────────────────────────────────────────────────────────────┤
│ navigation_logic_tests.rs     - Condition parsing & evaluation       │
│ translation_tests.rs          - act() layer message generation       │
│ webview_interpolation_tests.rs - URL variable substitution           │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│                      LAYER TESTS                                     │
├─────────────────────────────────────────────────────────────────────┤
│ exec_apply_tests.rs           - exec() + apply() independently       │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│                   INTEGRATION TESTS                                  │
├─────────────────────────────────────────────────────────────────────┤
│ command_generation_tests.rs   - Full pipeline: event → commands      │
│ event_sourcing_tests.rs       - State reconstruction from events     │
│ business_flows_tests.rs       - End-to-end user journeys             │
├─────────────────────────────────────────────────────────────────────┤
│ error_recovery_comprehensive_tests.rs - Error state scenarios        │
│ redo_comprehensive_tests.rs   - Retry/redo behavior                  │
│ wait_conditions_comprehensive_tests.rs - Wait logic                  │
│ statement_gathering_tests.rs  - Multi-message batching               │
│ payment_handling_tests.rs     - Payment field processing             │
│ payment_result_logic_tests.rs - Payment result flows                 │
│ handoff_protocol_tests.rs     - Handoff/thread control               │
│ off_time_handling_tests.rs    - Survey closing (NOT IMPLEMENTED)     │
├─────────────────────────────────────────────────────────────────────┤
│ integration_logic_tests.rs    - Real form logic testing              │
│ integration_form_lifecycle_tests.rs - Form switching flows           │
│ integration_wait_tests.rs     - Timeout scenarios                    │
│ integration_validation_tests.rs - Custom error messages              │
└─────────────────────────────────────────────────────────────────────┘
```

### Redundancy Assessment

**Necessary Overlap (Keep):**
- Testing same behavior at different layers catches different bugs
- `exec_apply_tests.rs` testing layers independently is valuable
- `command_generation_tests.rs` testing full pipeline catches integration issues

**Unnecessary Overlap (Consider Consolidating):**
- `event_sourcing_tests.rs` overlaps significantly with `business_flows_tests.rs`
- Multiple files test simple form switching
- Validation error message tests spread across 3 files

**Redundancy Score: 3/10** (Low redundancy - mostly justified)

---

## Part 4: Test Hierarchy Analysis

### Current Test Organization

```
machine-core/tests/
├── Unit-ish Tests
│   ├── navigation_logic_tests.rs      (parsing, evaluation)
│   ├── translation_tests.rs           (act layer)
│   └── webview_interpolation_tests.rs (URL substitution)
│
├── Layer Tests
│   └── exec_apply_tests.rs            (exec + apply)
│
├── Integration Tests (Programmatic Forms)
│   ├── command_generation_tests.rs    (full pipeline)
│   ├── event_sourcing_tests.rs        (state reconstruction)
│   ├── business_flows_tests.rs        (user journeys)
│   ├── *_comprehensive_tests.rs       (feature-specific)
│   └── *_handling_tests.rs            (feature-specific)
│
└── Integration Tests (JSON Forms)
    ├── integration_*_tests.rs         (real form fixtures)
    └── integration_test_form_bug.rs   (regression)
```

### Testing Patterns Observed

#### Pattern 1: Event Sourcing (Most Common)
```rust
// Create events
let events = vec![
    referral("form", 1000),
    echo("field1", 1001),
    user_text("Alice", 1002),
    ...
];

// Rebuild state
let state = rebuild_state_from_events(&events, &form)?;

// Assert final state
assert_eq!(state.current_field_ref, Some("expected".into()));
```

**Used in:** 8 test files (business_flows, error_recovery, redo, wait_conditions, etc.)

#### Pattern 2: Full Pipeline
```rust
let (new_state, commands) = run_full_pipeline(&state, &event, &form, &ctx)?;
assert_eq!(commands.len(), 1);
```

**Used in:** command_generation_tests.rs

#### Pattern 3: Layer Testing
```rust
// Test exec independently
let action = exec(&state, &event, Some(&form))?;
assert_matches!(action, MachineAction::Respond { .. });

// Test apply independently
let new_state = apply(&state, &action);
assert_eq!(new_state.current_state, StateType::Responding);
```

**Used in:** exec_apply_tests.rs

#### Pattern 4: Action Assertion
```rust
match &action {
    MachineAction::Respond { question, response_value, .. } => {
        assert_eq!(question, "expected_field");
        assert_eq!(response_value, Some(json!("expected_value")));
    }
    _ => panic!("Expected Respond action"),
}
```

**Used in:** Most test files

### Hierarchy Assessment

**Strengths:**
1. Clear separation between unit (parsing) and integration (flows) tests
2. Layer tests (`exec_apply_tests.rs`) verify components in isolation
3. Feature-specific test files make it easy to find relevant tests
4. Event sourcing pattern enables testing complex multi-step scenarios

**Weaknesses:**
1. No clear naming convention to distinguish unit from integration tests
2. `integration_*` prefix used inconsistently
3. Some files mix unit and integration test styles
4. No test categories or tags for selective running

**Recommendations:**

1. **Adopt naming convention:**
   - `*_unit_tests.rs` - Single function/component tests
   - `*_integration_tests.rs` - Multi-component flows
   - `*_e2e_tests.rs` - Full pipeline with real forms

2. **Use Rust test categories:**
   ```rust
   #[test]
   #[cfg(feature = "integration")]
   fn test_full_flow() { ... }
   ```

3. **Consider test organization:**
   ```
   tests/
   ├── unit/
   │   ├── navigation_tests.rs
   │   ├── interpolation_tests.rs
   │   └── validation_tests.rs
   ├── integration/
   │   ├── pipeline_tests.rs
   │   ├── event_sourcing_tests.rs
   │   └── feature_tests.rs
   └── e2e/
       └── form_fixture_tests.rs
   ```

### Hierarchy Score: **7/10**

- Good separation exists but could be formalized
- Naming conventions would improve discoverability
- Feature flags would enable faster test runs

---

## Part 5: Comparison with Facebot E2E Tests

### Facebot Integration Test Coverage

| Test Scenario | Form | Machine Coverage |
|---------------|------|------------------|
| Logic jump "Yes" path | LDfNCy | ✅ `navigation_logic_tests.rs` |
| Logic jump "No" path | LDfNCy | ✅ `navigation_logic_tests.rs` |
| Logic from previous question | jISElk | ✅ `integration_logic_tests.rs` |
| Hidden seed_2 field logic | nFgfNE | ⚠️ Partial |
| Multiple OR clauses (16 seeds) | UGqDwc | ⚠️ Simpler cases only |
| Phone/email validation | ciX4qo | ✅ `validate.rs` unit tests |
| Custom validation messages | KAvzEUWn | ✅ `translation_tests.rs` |
| Payment success flow | SNomCIYT | ✅ `payment_result_logic_tests.rs` |
| Payment failure flow | gk3gt9ag | ✅ `payment_result_logic_tests.rs` |
| External event wait | Ep5wnS | ✅ `wait_conditions_comprehensive_tests.rs` |
| Bailout event | v7R942 → BhaV5G | ⚠️ Event categorization only |
| Form stitching | Llu24B → tKG55U | ✅ `command_generation_tests.rs` |
| **Form retake prevention** | Same forms | ❌ **NOT TESTED** |
| Translation flow | hc2slBXH, mzs7qmvZ | ⚠️ Partial |
| Multiple links + keepMoving | B6cIAn | ⚠️ Basic only |
| Timeout interruption | vHXzrh | ⚠️ Basic timeout only |
| **Absolute timeout_date** | j1sp7ffL | ❌ **NOT TESTED** |
| **Notify permission + timeout** | dbFwhd | ❌ **NOT TESTED** |
| **Follow-up messages** | ulrtpfSQ | ❌ **NOT TESTED** |
| FB error → BLOCKED | N/A | ✅ `error_recovery_comprehensive_tests.rs` |
| Bad form → ERROR | N/A | ✅ `error_recovery_comprehensive_tests.rs` |

### Critical Gaps Summary

1. **Form Retake Prevention** - No tests verify users can't restart completed forms
2. **Absolute timeout_date** - No tests for date-based (vs duration) timeouts
3. **Notify Permission** - No tests for one-time notification token handling
4. **Follow-up Messages** - No tests for inactivity follow-ups
5. **Bailout Flow** - Only event categorization tested, not full flow

---

## Recommendations

### Immediate Actions

1. **Add missing critical tests:**
   - Form retake prevention
   - Absolute timeout_date handling
   - Notify permission field processing

2. **Implement off-time logic:**
   - Currently 5 tests expected to fail
   - Blocks survey closing functionality

3. **Centralize event helpers:**
   - Move duplicated `referral()`, `user_text()`, `echo()` to `testing/mod.rs`
   - Saves ~400 lines of duplication

### Medium-term Improvements

1. **Add ActContext builder:**
   ```rust
   // In testing/mod.rs
   pub fn act_context(form: TypeformForm) -> ActContext {
       ActContext {
           form,
           user_id: USER_ID.to_string(),
           platform: PlatformType::Messenger,
           timestamp: 1000,
           ..Default::default()
       }
   }
   ```

2. **Expand pre-built forms:**
   - `forms::with_logic()` - Simple yes/no branching
   - `forms::with_statements()` - Statement gathering
   - `forms::with_validation()` - Phone/email fields

3. **Formalize test hierarchy:**
   - Rename files with `_unit_` or `_integration_` prefix
   - Add feature flags for test categories

### Long-term Considerations

1. **Property-based testing:**
   - Use `proptest` for validation edge cases
   - Generate random form structures

2. **Snapshot testing:**
   - Compare command outputs against golden files
   - Catch regressions in message formatting

3. **Real form test fixtures:**
   - Copy facebot forms to `machine/tests/fixtures/forms/`
   - Test against production form configurations

---

## Appendix: Test Count by Category

| Category | Test Count | % of Total |
|----------|-----------|------------|
| State Transitions | ~30 | 18% |
| Navigation & Logic | ~25 | 15% |
| Event Processing | ~20 | 12% |
| Command Generation | ~20 | 12% |
| Error Handling | ~15 | 9% |
| Wait Conditions | ~15 | 9% |
| Payment | ~12 | 7% |
| Redo/Retry | ~10 | 6% |
| Handoff | ~8 | 5% |
| Interpolation | ~8 | 5% |
| Form Lifecycle | ~5 | 3% |
| **Total** | **~170** | **100%** |

---

## Summary Scores

| Dimension | Score | Notes |
|-----------|-------|-------|
| **Behavioral Parity** | 7/10 | Good coverage but key gaps (off-time, retake, notify) |
| **DRY Adherence** | 6/10 | Helpers exist but underused; duplication in event creators |
| **Redundancy** | 8/10 | Low redundancy - most overlap is justified |
| **Test Hierarchy** | 7/10 | Clear patterns but naming could be formalized |
| **Overall** | **7/10** | Solid foundation with specific improvement opportunities |
