# Machine Integration Test Migration Plan

## Overview

This document outlines the plan to migrate the facebot integration test scenarios into the machine-core Rust test suite. The goal is to achieve parity between the end-to-end integration tests and the unit/integration tests within the machine crate, using the same form definitions.

## Current State

### Facebot Integration Tests
- **Location**: `/facebot/testrunner/test.ts`
- **Forms**: 39 JSON files in `/facebot/testrunner/forms/`
- **Pattern**: FlowMaster orchestration - sends messages, validates responses, checks state
- **Coverage**: Form flows, validation, logic jumps, external events, timeouts, stitching

### Machine Tests
- **Location**: `/machine/machine-core/tests/`
- **Count**: 18 test files covering various features
- **Pattern**: Programmatic form creation via testing module + exec→apply→act pipeline
- **Fixtures**: `/machine/tests/fixtures/forms/` (currently empty)

## Existing Helpers to Reuse

Since we're loading pre-built JSON forms, we do NOT need form builders. Focus on reusing:

### From `machine_core::testing` (`/machine/machine-core/src/testing/mod.rs`)
- `state()`, `state_with_form()`, `state_at_field()` - State creation
- `events::conversation_started()`, `events::user_text()` - Event creation
- `assert::field_answer()` - QA pair verification

### From `business_flows_tests.rs`
- `referral(form_id, ts)`, `user_text(text, ts)`, `echo(field_ref, ts)`, `external_event()` - Events with timestamps for event sourcing

### Standard Patterns (no helper needed)
- Command assertions: Use inline `assert_eq!(commands.len(), N)` and pattern matching (existing convention)
- State type checks: Use `assert_eq!(state.current_state, StateType::End)` directly

## Forms to Migrate

### Priority 1: Core Logic Tests (Critical Path)

| Form ID | File | Purpose | Integration Test |
|---------|------|---------|------------------|
| `LDfNCy` | `LDfNCy.json` | Logic jumps (Yes/No branching) | "Test chat flow with logic jump 'Yes'" |
| `jISElk` | `jISElk.json` | Multiple-choice + opinion scale + logic | "Integration Test 2" |
| `nFgfNE` | `nFgfNE.json` | Hidden field logic (seed_2) | "Test chat flow logic jump from hidden seed_2 field" |
| `UGqDwc` | `UGqDwc.json` | Multiple OR clauses (complex branching) | "Works with multiple OR clauses" |

### Priority 2: Validation Tests

| Form ID | File | Purpose | Integration Test |
|---------|------|---------|------------------|
| `ciX4qo` | `ciX4qo.json` | Phone + email validation | "Test chat flow with validation failures" |
| `KAvzEUWn` | `KAvzEUWn.json` | Custom error messages | "Test chat flow with custom validation error messages" |

### Priority 3: Payment & External Events

| Form ID | File | Purpose | Integration Test |
|---------|------|---------|------------------|
| `SNomCIYT` | `SNomCIYT.json` | Payment success flow | "Jump after payment: success" |
| `gk3gt9ag` | `gk3gt9ag.json` | Payment failure flow | "Jump after payment: failure" |
| `Ep5wnS` | `Ep5wnS.json` | External event wait (video) | "Waits for external event and continues" |

### Priority 4: Form Stitching & Bailout

| Form ID | File | Purpose | Integration Test |
|---------|------|---------|------------------|
| `v7R942` | `v7R942.json` | Bailout source form | "Receives bailout event and switches forms" |
| `BhaV5G` | `BhaV5G.json` | Bailout destination form | (same test) |
| `Llu24B` | `Llu24B.json` | Stitch part A | "Test chat flow with stitched forms" |
| `tKG55U` | `tKG55U.json` | Stitch part B | (same test) |

### Priority 5: Timeout & Wait Tests

| Form ID | File | Purpose | Integration Test |
|---------|------|---------|------------------|
| `vHXzrh` | `vHXzrh.json` | Timeout with interruption | "Sends timeout message response when interrupted" |
| `j1sp7ffL` | `j1sp7ffL.json` | Absolute timeout_date | "Sends message after timeout absolute timeout" |
| `dbFwhd` | `dbFwhd.json` | Notify permission + timeout | "Sends messages with notify token after timeout" |
| `ulrtpfSQ` | `ulrtpfSQ.json` | Follow-up messages | "Sends follow ups when user does not respond" |

### Priority 6: Translation & Special Features

| Form ID | File | Purpose | Integration Test |
|---------|------|---------|------------------|
| `hc2slBXH` | `hc2slBXH.json` | Translation destination | "Test chat flow on forms with translated responses" |
| `mzs7qmvZ` | `mzs7qmvZ.json` | Translation source | (same test) |
| `B6cIAn` | `B6cIAn.json` | Multiple links + keepMoving | "Test chat flow with multiple links and keepMoving tag" |

## Implementation Plan

### Phase 1: Form Migration

**Task 1.1: Copy Forms to Machine Test Fixtures**

```
Source: /facebot/testrunner/forms/
Destination: /machine/tests/fixtures/forms/
```

Forms to copy (20 total):
- `LDfNCy.json`, `jISElk.json`, `nFgfNE.json`, `UGqDwc.json`
- `ciX4qo.json`, `KAvzEUWn.json`
- `SNomCIYT.json`, `gk3gt9ag.json`, `Ep5wnS.json`
- `v7R942.json`, `BhaV5G.json`, `Llu24B.json`, `tKG55U.json`
- `vHXzrh.json`, `j1sp7ffL.json`, `dbFwhd.json`, `ulrtpfSQ.json`
- `hc2slBXH.json`, `mzs7qmvZ.json`, `B6cIAn.json`

**Task 1.2: Load Forms in Tests**

Use `include_str!` to load forms directly in test files. No central loader needed unless forms are shared across many files.

```rust
// In each test file:
const FORM_LDFNCY: &str = include_str!("../../../tests/fixtures/forms/LDfNCy.json");

fn load_form(json: &str) -> TypeformForm {
    serde_json::from_str(json).expect("Failed to parse form")
}

#[test]
fn test_example() {
    let form = load_form(FORM_LDFNCY);
    // ...
}
```

### Phase 2: Core Logic Tests

**Task 2.1: Create `integration_logic_tests.rs`**

Test file: `/machine/machine-core/tests/integration_logic_tests.rs`

Test scenarios to implement:

```rust
// 1. Logic jump "Yes" path
#[test]
fn test_logic_jump_yes_path() {
    // Form: LDfNCy
    // Flow: field[0] → "Yes" → field[1] → field[2] → field[4] → field[5]
    // Verify: Correct fields are shown, field[3] is skipped
}

// 2. Logic jump "No" path
#[test]
fn test_logic_jump_no_path() {
    // Form: LDfNCy
    // Flow: field[0] → "No" → field[3] → field[5]
    // Verify: field[1], field[2], field[4] are skipped
}

// 3. Hidden field seed_2 logic
#[test]
fn test_hidden_field_seed_logic() {
    // Form: nFgfNE
    // Verify: seed_2 value determines branching path
}

// 4. Multiple OR clauses
#[test]
fn test_multiple_or_clauses() {
    // Form: UGqDwc
    // Verify: Complex OR conditions evaluated correctly
}
```

### Phase 3: Validation Tests

**Task 3.1: Create `integration_validation_tests.rs`**

Test file: `/machine/machine-core/tests/integration_validation_tests.rs`

```rust
// 1. Phone validation failure and retry
#[test]
fn test_phone_validation_failure_retries_field() {
    // Form: ciX4qo
    // Input: "23345" (invalid)
    // Verify: Same field repeated, validation error in commands
}

// 2. Phone validation success
#[test]
fn test_phone_validation_success_continues() {
    // Form: ciX4qo
    // Input: "+918888000000" (valid India number)
    // Verify: Moves to next field
}

// 3. Email validation failure
#[test]
fn test_email_validation_failure() {
    // Form: ciX4qo
    // Input: "foo" (invalid)
    // Verify: Same field repeated
}

// 4. Custom error messages
#[test]
fn test_custom_validation_error_messages() {
    // Form: KAvzEUWn
    // Verify: Custom messages like "foo number bar" are used
}
```

### Phase 4: Payment & External Event Tests

**Task 4.1: Create `integration_payment_tests.rs`**

Test file: `/machine/machine-core/tests/integration_payment_tests.rs`

```rust
// 1. Payment success triggers logic jump
#[test]
fn test_payment_success_logic_jump() {
    // Form: SNomCIYT
    // Flow: Phone → Operator → Wait → [Payment Success Event] → Success field
    // Verify: Fields [0,1,2,5] shown, [3,4] skipped
}

// 2. Payment failure shows error message
#[test]
fn test_payment_failure_logic_jump() {
    // Form: gk3gt9ag
    // Flow: Phone → Operator → Wait → [Payment Failure Event] → Error message
    // Verify: Error message field shown with e_payment_fake_error_message
}

// 3. External event wait (video)
#[test]
fn test_external_event_wait_and_continue() {
    // Form: Ep5wnS
    // Flow: Answer → Wait (external) → [moviehouse:play event] → Continue
    // Verify: State transitions correctly, flow continues after event
}
```

### Phase 5: Form Stitching & Bailout Tests

**Task 5.1: Create `integration_stitching_tests.rs`**

Test file: `/machine/machine-core/tests/integration_stitching_tests.rs`

```rust
// 1. Bailout event switches forms
#[test]
fn test_bailout_event_switches_forms() {
    // Forms: v7R942 → BhaV5G
    // Flow: Start form A → [Bailout event] → Form B loaded
    // Verify: Form entry updated, correct form shown
}

// 2. Form stitching preserves context
#[test]
fn test_stitch_maintains_seed_and_responses() {
    // Forms: Llu24B → tKG55U
    // Flow: Complete form A → Auto-stitch to form B
    // Verify: seed_5 preserved, parent shortcode set
}

// 3. Stitched form prevents retake
#[test]
fn test_stitch_prevents_form_a_retake() {
    // Forms: Llu24B → tKG55U
    // Flow: Complete both → Try to restart form A
    // Verify: User blocked from retaking
}
```

### Phase 6: Timeout & Wait Tests

**Task 6.1: Create `integration_timeout_tests.rs`**

Test file: `/machine/machine-core/tests/integration_timeout_tests.rs`

```rust
// 1. Timeout interruption shows response message
#[test]
fn test_timeout_interruption_shows_wait_message() {
    // Form: vHXzrh
    // Flow: User answers during wait → "Please wait!" shown → Original field repeated
    // Verify: Wait response message generated, state maintained
}

// 2. Absolute timeout_date triggers
#[test]
fn test_absolute_timeout_date_triggers() {
    // Form: j1sp7ffL
    // Flow: Wait with absolute date → Date passes → Message sent
    // Verify: Timeout condition evaluates correctly
}

// 3. Notify permission with timeout
#[test]
fn test_notify_permission_timeout_flow() {
    // Form: dbFwhd
    // Flow: Permission request → Timeout → Notify sent
    // Verify: notifyPermission field handled correctly
}

// 4. Follow-up on no response
#[test]
fn test_followup_on_no_response() {
    // Form: ulrtpfSQ
    // Flow: Question → No response → Follow-up sent
    // Verify: Follow-up message configuration parsed and used
}
```

### Phase 7: Translation & Special Features Tests

**Task 7.1: Create `integration_translation_tests.rs`**

Test file: `/machine/machine-core/tests/integration_translation_tests.rs`

```rust
// 1. Response translation
#[test]
fn test_translated_response_flow() {
    // Forms: hc2slBXH (dest) + mzs7qmvZ (source)
    // Verify: Translation context applied, responses translated
}

// 2. Multiple links with keepMoving
#[test]
fn test_multiple_links_keep_moving() {
    // Form: B6cIAn
    // Verify: keepMoving fields auto-advance without user input
}
```

## File Structure After Migration (Revised)

```
machine/
├── machine-core/
│   └── tests/
│       ├── integration_logic_tests.rs          # New: seed logic, OR clauses
│       ├── integration_form_lifecycle_tests.rs # New: bailout, retake, stitch
│       ├── integration_wait_tests.rs           # New: timeout_date, notify, follow-up
│       ├── integration_validation_tests.rs     # New: custom error messages
│       └── ... (existing tests)
└── tests/
    └── fixtures/
        └── forms/
            ├── LDfNCy.json         # Logic
            ├── jISElk.json
            ├── nFgfNE.json
            ├── UGqDwc.json
            ├── v7R942.json         # Lifecycle
            ├── BhaV5G.json
            ├── Llu24B.json
            ├── tKG55U.json
            ├── vHXzrh.json         # Wait
            ├── j1sp7ffL.json
            ├── dbFwhd.json
            ├── ulrtpfSQ.json
            ├── B6cIAn.json
            └── KAvzEUWn.json       # Validation
```

## Success Criteria (Revised)

1. **14 forms copied** to `/machine/tests/fixtures/forms/`
2. **4 new test files** created covering unique scenarios not in existing tests
3. **All tests pass** when run with `cargo test`
4. **Critical gaps filled**: Bailout, retake prevention, seed logic, timeout_date, notify
5. **No regressions**: Existing machine tests continue to pass

## Estimated Test Count (Revised)

| Test File | Estimated Tests | Focus |
|-----------|-----------------|-------|
| `integration_logic_tests.rs` | 6-8 | Seed logic, OR clauses, real form logic |
| `integration_form_lifecycle_tests.rs` | 5-7 | Bailout, retake prevention, stitch |
| `integration_wait_tests.rs` | 6-8 | timeout_date, notify, follow-up, keepMoving |
| `integration_validation_tests.rs` | 2-3 | Custom error messages only |
| **Total** | **19-26 new tests** |

*Reduced from 32-43 by eliminating redundant payment/translation tests.*

## Overlap Analysis: Existing Machine Tests vs Proposed Integration Tests

### Key Finding: All Existing Tests Use Programmatic Forms

Every existing machine-core test creates forms programmatically using Rust constructors. **None use real JSON forms**. This means the proposed integration tests with real JSON forms provide unique value by testing complex, production-like form configurations.

### Coverage Matrix

| Scenario | Machine Tests | Facebot Tests | Overlap? | Recommendation |
|----------|---------------|---------------|----------|----------------|
| **Logic jumps (Yes/No)** | `navigation_logic_tests.rs` - programmatic forms | `LDfNCy.json` | PARTIAL | Add with real form - tests complex real-world logic |
| **Hidden field logic (seed)** | None | `nFgfNE.json`, `UGqDwc.json` | NO | **ADD** - unique coverage |
| **Multiple OR clauses** | `wait_conditions_comprehensive_tests.rs` - simple cases | `UGqDwc.json` - 16 seed values | PARTIAL | Add with real form - tests extreme nesting |
| **Phone validation** | `validate.rs` unit tests (India only) | `ciX4qo.json` | PARTIAL | Add for full flow testing |
| **Email validation** | `validate.rs` unit tests | `ciX4qo.json` | PARTIAL | Add for full flow testing |
| **Custom error messages** | `translation_tests.rs` - basic | `KAvzEUWn.json` | PARTIAL | Add with real form's custom_messages |
| **Payment success flow** | `payment_result_logic_tests.rs` - programmatic | `SNomCIYT.json` | YES | **SKIP or use as bug isolation** |
| **Payment failure flow** | `payment_result_logic_tests.rs` - programmatic | `gk3gt9ag.json` | YES | **SKIP or use as bug isolation** |
| **External event wait** | `wait_conditions_comprehensive_tests.rs` | `Ep5wnS.json` | PARTIAL | Add for video/webview specific testing |
| **Form stitching** | `command_generation_tests.rs`, `exec_apply_tests.rs` | `Llu24B.json` → `tKG55U.json` | YES | Review - may be redundant |
| **Bailout events** | Minimal (categorization only) | `v7R942.json` → `BhaV5G.json` | NO | **ADD** - no dedicated test |
| **Form retake prevention** | **NONE** | Covered in stitch tests | NO | **ADD** - critical gap |
| **Timeout interruption** | `wait_conditions_comprehensive_tests.rs` | `vHXzrh.json` | PARTIAL | Add for responseMessage testing |
| **Absolute timeout_date** | None | `j1sp7ffL.json` | NO | **ADD** - unique coverage |
| **Notify permission** | None | `dbFwhd.json` | NO | **ADD** - unique coverage |
| **Follow-up messages** | None | `ulrtpfSQ.json` | NO | **ADD** - unique coverage |
| **Translation** | `translation_tests.rs` - basic interpolation | `hc2slBXH.json` + `mzs7qmvZ.json` | PARTIAL | Review - may need form pair |
| **keepMoving/auto-advance** | None | `B6cIAn.json` | NO | **ADD** - unique coverage |

### Existing Test Files Summary

| Test File | What It Tests | Form Type | Overlaps With |
|-----------|---------------|-----------|---------------|
| `navigation_logic_tests.rs` | Condition deserialization, nested logic evaluation | Programmatic (simple) | P1: Logic tests |
| `exec_apply_tests.rs` | State transitions, action application | Programmatic (2-3 fields) | P4: Stitching |
| `command_generation_tests.rs` | Full pipeline, field types, interpolation | Programmatic (medium) | P1, P4 |
| `payment_handling_tests.rs` | Payment command generation | Programmatic | P3: Payment |
| `payment_result_logic_tests.rs` | Payment flow with logic jumps | Programmatic (realistic) | P3: Payment |
| `wait_conditions_comprehensive_tests.rs` | OR/AND operators, timeouts | Programmatic | P5: Timeouts |
| `translation_tests.rs` | Custom messages, interpolation in act layer | Programmatic | P6: Translation |
| `business_flows_tests.rs` | End-to-end user journeys | Programmatic | Multiple |
| `event_sourcing_tests.rs` | Event replay, state rebuilding | Programmatic (builder) | Multiple |

### Tests That Are Likely Redundant

These proposed tests overlap significantly with existing machine tests:

1. **Payment success/failure logic jumps** (`integration_payment_tests.rs`)
   - `payment_result_logic_tests.rs` already covers this well with programmatic forms
   - **Recommendation**: Only add if debugging specific bugs, or skip entirely

2. **Basic form stitching** (`integration_stitching_tests.rs`)
   - `command_generation_tests.rs:test_form_switch_sends_new_form_first_question` covers this
   - `exec_apply_tests.rs:test_apply_switch_form_resets_qa_but_keeps_pointer` covers state
   - **Recommendation**: Focus on bailout and retake prevention (not covered)

3. **Basic validation flow**
   - `validate.rs` has extensive unit tests
   - **Recommendation**: Only add integration test for custom_messages lookup, not basic validation

### Tests That Add Unique Value

These have NO or minimal coverage in existing machine tests:

| Priority | Test | Why It's Unique |
|----------|------|-----------------|
| HIGH | Hidden field seed logic | No existing tests for seed-based branching |
| HIGH | Form retake prevention | **Zero machine tests** for this critical feature |
| HIGH | Bailout events | Only event categorization tested, no flow test |
| HIGH | Absolute timeout_date | No tests for date-based timeouts |
| HIGH | Notify permission | No tests for notifyPermission field handling |
| MEDIUM | Follow-up messages | No tests for follow-up configuration |
| MEDIUM | keepMoving auto-advance | No tests for this feature |
| MEDIUM | Multiple OR clauses (16 seeds) | Existing tests are simpler |
| LOW | Custom validation messages | Partially covered, add for form.custom_messages lookup |

### Revised Test File Plan

Based on overlap analysis, consolidate to **4 focused test files** instead of 6:

| New File | Focus | Forms | Unique Value |
|----------|-------|-------|--------------|
| `integration_logic_tests.rs` | Hidden fields, seed logic, complex OR | `nFgfNE.json`, `UGqDwc.json`, `LDfNCy.json` | Real form complexity |
| `integration_form_lifecycle_tests.rs` | Bailout, retake prevention, stitching | `v7R942.json`, `BhaV5G.json`, `Llu24B.json`, `tKG55U.json` | Critical gaps |
| `integration_wait_tests.rs` | timeout_date, notify, follow-up, keepMoving | `j1sp7ffL.json`, `dbFwhd.json`, `ulrtpfSQ.json`, `B6cIAn.json` | Unique features |
| `integration_validation_tests.rs` | Custom error messages only | `KAvzEUWn.json` | form.custom_messages lookup |

**Removed/Deprioritized:**
- `integration_payment_tests.rs` - Already well covered by `payment_result_logic_tests.rs`
- `integration_translation_tests.rs` - Partially covered, low priority
- Basic validation tests - Covered by `validate.rs` unit tests

### Forms to Copy (Revised: 14 instead of 20)

Remove payment and translation forms that are redundant:
- ~~`SNomCIYT.json`~~ - Payment covered
- ~~`gk3gt9ag.json`~~ - Payment covered
- ~~`Ep5wnS.json`~~ - External event partially covered
- ~~`ciX4qo.json`~~ - Basic validation covered
- ~~`hc2slBXH.json`~~ - Translation low priority
- ~~`mzs7qmvZ.json`~~ - Translation low priority

**Keep (14 forms):**
- Logic: `LDfNCy.json`, `jISElk.json`, `nFgfNE.json`, `UGqDwc.json`
- Lifecycle: `v7R942.json`, `BhaV5G.json`, `Llu24B.json`, `tKG55U.json`
- Wait: `vHXzrh.json`, `j1sp7ffL.json`, `dbFwhd.json`, `ulrtpfSQ.json`, `B6cIAn.json`
- Validation: `KAvzEUWn.json`

## Notes

### Form Compatibility

The facebot forms use Typeform JSON schema which the machine-core already supports via `TypeformForm` struct. Key structures:
- `fields[]` - Question definitions
- `logic[]` - Conditional jump rules
- `hidden[]` - Hidden field names
- `thankyou_screens[]` - End screens
- `custom_messages{}` - Validation message overrides

### Known Issues to Address

1. **Payment result logic jumps** - Currently failing in integration tests. Machine tests should help isolate the bug.
2. **Branching logic** - 4 tests ignored in TypeformForm migration. Some forms may expose these gaps.
3. **Off-time handling** - Not implemented in machine yet. Related tests may need to be marked `#[ignore]`.

### Test Data Isolation

Each test should:
- Create fresh state via `state()` or `state_with_form()`
- Use unique user IDs to prevent cross-test interference
- Not depend on global state or database
