# Platform Abstraction v2 Integration Test Results

**Date**: 2026-07-17
**Worktree**: `/home/nandan/Documents/vlab-research/fly-platform-abstraction-v2` (branch: feature/platform-abstraction-v2, HEAD: fe340db)
**Test Suite**: facebot Testcontainers Integration Tests
**Status**: FAILED - Critical serialization bugs detected

## Executive Summary

The platform-abstraction v2 rebuild has been integrated into the facebot testrunner stack. The initial sanity test subset (3 representative tests) **failed**, revealing **systematic serialization issues** in the message pipeline. The pipeline successfully boots and routes messages end-to-end, but message payloads are being constructed with incorrect formats and missing required fields.

**Recommendation**: DO NOT proceed to full test suite until serialization bugs are fixed.

## Test Execution

### Build Phase
- **Status**: PASSED
- **Command**: `npm run build` (TypeScript compilation)
- **Duration**: <5s
- **Output**: Clean compilation, zero warnings

### Stack Initialization
- **Status**: PASSED
- **Duration**: 357.8s (5m 57s)
- **Components**: Network, images, cockroach, redpanda, formcentral, replybot, botserver, facebot
- **Notes**: Stack boots successfully with all services healthy

### Sanity Test Subset Execution
- **Status**: FAILED
- **Duration**: 6m total
- **Tests Run**: 3
- **Tests Passed**: 0
- **Tests Failed**: 3

## Failure Details

### Test 1: "Follows logic jumps based on external events: payment success"

**What it does**: Sends referral → user inputs phone number → receives next field

**Expected Behavior**:
- Phone number field serialized as: 
  ```json
  {
    "text": "Hey what's your number?",
    "metadata": "{\"ref\":\"ref_num\",\"type\":\"phone_number\"}"
  }
  ```

**Actual Behavior**:
- Phone number field serialized as:
  ```json
  {
    "text": "Hey what's your number?",
    "quick_replies": [{ "content_type": "user_phone_number" }],
    "metadata": "{\"type\":\"phone_number\",\"ref\":\"ref_num\"}"
  }
  ```

**Bugs Identified**:
1. Metadata field order reversed: `type` before `ref` instead of `ref` before `type`
2. Phone input now includes `quick_replies` element (UI input type specification) when it should not
3. Phone input handling logic appears to have changed

### Test 2: "Test chat flow with logic jump 'Yes'"

**What it does**: Sends referral → shows legal (checkbox) field → user clicks "I Accept"

**Expected Behavior**:
- Legal field options with string label values:
  ```json
  {
    "payload": "{\"value\":\"I Accept\",\"ref\":\"f37a882b-...\"}"
  }
  ```

**Actual Behavior**:
- Legal field options with boolean values:
  ```json
  {
    "payload": "{\"value\":true,\"ref\":\"f37a882b-...\"}"
  }
  ```

**Bugs Identified**:
1. Payload value transformation changed from string labels to booleans
2. Option value mapping logic has been modified (UUID/label → boolean conversion)
3. This suggests changes in field option serialization layer

### Test 3: "Multi-part attachment question sends both the image and the multiple-choice" ⚠️ CRITICAL

**What it does**: Sends referral → form with image attachment + multiple choice options → verifies BOTH are received

**Expected Behavior**:
- Image attachment with `is_reusable` flag:
  ```json
  {
    "attachment": {
      "type": "image",
      "payload": {
        "url": "https://via.placeholder.com/300x200?text=Test+Image",
        "is_reusable": true
      }
    }
  }
  ```

**Actual Behavior**:
- Image attachment WITHOUT `is_reusable` flag:
  ```json
  {
    "attachment": {
      "type": "image",
      "payload": {
        "url": "https://via.placeholder.com/300x200?text=Test+Image"
      }
    }
  }
  ```

**Bugs Identified**:
1. **CRITICAL**: Missing `is_reusable: true` flag in image attachment payload
2. Image serialization function not setting the reusable flag
3. Multi-part message delivery incomplete (both parts sent but image incomplete)

## Additional Issues Observed

From expanded test output patterns (non-sanity tests that ran):

### Metadata Field Ordering (Systematic)
- Across ALL field types (multiple_choice, phone_number, number, short_text, legal)
- Pattern: `type` field comes before `ref` field in actual output
- Expected: `ref` field first
- Affected: 20+ test assertions

### Option Value Transformation
- Multiple choice options: changed to text label values instead of UUID references
- Example: `{"value":"foo",...}` instead of `{"value":"<uuid>,...}`

### Webview Field Handling
- Webview fields expected as template attachment
- Actual sends as plain text message

## Root Cause Analysis

The bugs appear to be in the message serialization pipeline, likely in:

1. **message-worker** - Image attachment builder
   - Location: Image attachment payload construction
   - Issue: Not setting `is_reusable: true` flag
   - Impact: Images not marked as reusable in Facebook Send API

2. **message-worker or replybot** - Metadata field factory
   - Issue: Field order changed in JSON serialization
   - Impact: All field metadata now ordered differently
   - Cause: Possible change in object key ordering (Object.keys() vs defined order)

3. **replybot** - Field option value mapping
   - Issue: Option values transformed differently
   - Impact: Legal and multiple choice fields send wrong value types
   - Cause: Changes in field option transformation logic

## Impact Assessment

- **Severity**: HIGH
- **Scope**: Multi-part messages, all field types, attachment handling
- **User Impact**: Multi-part messages fail to deliver correctly; form field options have wrong values
- **Detection**: Integration test catches this immediately (not caught by unit tests)

## Recommendations

1. **Immediate**: Fix image attachment serialization to include `is_reusable: true`
2. **Review**: Audit all message serialization functions in message-worker
3. **Fix**: Restore field option value mapping to use correct value types
4. **Fix**: Restore metadata field ordering (or update test expectations if new order is intentional)
5. **Retest**: Run sanity subset again to confirm fixes before full suite
6. **Document**: If any message format changes were intentional, document the rationale

## Test Locations

- **Test suite**: `/home/nandan/Documents/vlab-research/fly-platform-abstraction-v2/facebot/testrunner/test.tc.ts`
- **Specific tests**:
  - Line 120-133: "Follows logic jumps based on external events: payment success"
  - Line 157-170: "Test chat flow with logic jump 'Yes'"
  - Line 412-424: "Multi-part attachment question sends both the image and the multiple-choice"

## Next Steps

Once bugs are fixed:
1. Run sanity subset again: `npm run test:tc -- --grep "Multi-part attachment|payment success|logic jump.*Yes"`
2. If all 3 pass, run full suite: `npm run test:tc`
3. Report full test results (count of passing/failing tests)

**Do NOT push to production until all integration tests pass.**
