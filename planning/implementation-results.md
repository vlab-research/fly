# Implementation Results: Owner-Confirmed Desired-Behavior Fixes

## Summary
Successfully implemented all owner-confirmed desired-behavior fixes across three subsystems (message-worker Go, replybot JS, facebot testrunner TS) to align with the behavior defined by translate-typeform output.

## A) message-worker (Go) - COMPLETED ✓

### Changes Made

**A1. Image attachments: Add `is_reusable: true`**
- File: `message-worker/types/messenger.go`
  - Added `IsReusable *bool` field to `AttachmentPayload` struct with `json:"is_reusable,omitempty"` tag
- File: `message-worker/translator.go`
  - Added helper function `ptrBool(b bool) *bool`
  - Modified `translateMessengerMedia()` to set `IsReusable: ptrBool(true)` on all attachments
- Result: Media attachments now serialize as `{"url": "...", "is_reusable": true}`

**A2. Phone fields: Remove native quick-reply**
- File: `message-worker/translator.go`
  - Modified `translateMessengerText()` to remove the `case "phone_number"` that added `QuickReply{ContentType: "user_phone_number"}`
  - Email fields still have their `user_email` quick-reply (unchanged)
  - Phone fields now translate as plain text input (matching old behavior)

**A3. Tests Updated**
- File: `message-worker/translator_test.go`
  - Added helper function `boolPtr(b bool) *bool`
  - Updated "image message" test to expect `IsReusable: boolPtr(true)`
  - Updated "video message" test to expect `IsReusable: boolPtr(true)`
  - Added new test "phone field (no quick reply)" verifying phones have no quick-replies
  - Added new test "email field (with quick reply)" verifying emails still work correctly
  - All tests pass (go test ./... succeeds)

### Test Results
```
ok  	github.com/vlab-research/fly/message-worker	(cached)
?   	github.com/vlab-research/fly/message-worker/cmd/message-worker	[no test files]
?   	github.com/vlab-research/fly/message-worker/types	[no test files]
```

### Commit
```
cf9c086 fix(message-worker): add is_reusable to attachments and remove phone quick-reply
```

---

## B) replybot (JS) - COMPLETED ✓

### Changes Made

**B1. Choice field values = human-readable labels**
- File: `replybot/lib/generic-translator.js`
  - `translateQuestionWithChoices()`: Changed from `value: choice.ref || choice.label` to `value: choice.label`
  - `translateYesNo()`: Changed from `value: true/false` to `value: 'Yes'/'No'` (string labels)
  - `translateLegal()`: Changed from `value: true/false` to `value: 'I Accept'/"I don't Accept"` (string labels)
  - Opinion scale & Rating: Already using string numbers (no change needed)

**B2. Round-trip verification completed**
- Validator (`generic-validator.js`):
  - `validateQuestion()` uses `c.ref || c.label` - accepts both refs and labels ✓
  - `validateYesNo()` accepts `['Yes', 'No', true, false]` - backward compatible ✓
  - `validateLegal()` accepts `['I Accept', "I don't Accept", true, false]` - backward compatible ✓
- Response recording:
  - Flow: option.value → quick-reply payload → nxt.payload.value → recorded in qa
  - With label values, labels are recorded directly
- Logic-jump evaluation:
  - Uses `getFieldValue(qa, ref)` to get stored answer
  - Comparison uses `===` with `castValue()` - works with string labels ✓
  - No change needed - already compatible with labels

**B3. Tests Updated**
- File: `replybot/lib/generic-translator.test.js`
  - Added test "uses choice label as value (not ref)" verifying multiple_choice uses labels
  - Added test "translateYesNo: uses string labels as values (not booleans)"
  - Added test "translateLegal: uses string labels as values (not booleans)"
  - All 3 new tests pass; existing tests still pass

**B4. Test Results**
```
298 passing (278ms)
1 pending
```

### Commit
```
6601b05 fix(replybot): choice field values = human-readable labels (desired behavior)
```

---

## C) facebot testrunner (TS) - COMPLETED ✓

### Changes Made

**C1. Metadata comparison robust to JSON key order**
- File: `facebot/testrunner/socket.ts`
  - Added helper function `normalizeMetadataForComparison(obj: any): any` that:
    - Parses metadata JSON strings into objects
    - Recursively normalizes nested structures
    - Leaves other fields unchanged
  - Modified `flowMaster()` to:
    - Normalize both actual and expected messages before comparison
    - Call `normalizeMetadataForComparison()` on both `msg` and `get`
    - Use normalized values for `.should.eql()` comparison
  - Result: `{"type":"x","ref":"y"}` and `{"ref":"y","type":"x"}` now compare as equal

**C2. TypeScript build**
- Ran `npm run build` (tsc) - compiles successfully without errors ✓
- No production code changes; test-only modification

### Test Build Results
```
Build successful (tsc completed with no errors)
```

### Commit
```
b6d84c0 test(facebot/testrunner): make metadata comparison robust to JSON key order
```

---

## Overall Summary

| Subsystem | Files Modified | Tests | Status |
|-----------|---|---|---|
| **message-worker (Go)** | types/messenger.go, translator.go, translator_test.go | PASS | ✓ Complete |
| **replybot (JS)** | generic-translator.js, generic-translator.test.js | 298 pass | ✓ Complete |
| **facebot/testrunner (TS)** | socket.ts | Compile OK | ✓ Complete |

All three subsystems verified:
- **A1-A3**: Image attachments with is_reusable:true, phone fields without quick-replies, all tests pass
- **B1-B4**: Choice values use human-readable labels, round-trip verified, 298 tests pass (+ 3 new label verification tests)
- **C1-C2**: Metadata JSON key-order robustness implemented, TypeScript compiles

No production code was broken. No destructive commands were run. All changes align with desired behavior as defined by translate-typeform output.
