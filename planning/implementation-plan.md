# Implementation Plan: Owner-Confirmed Desired-Behavior Fixes

## Overview
Fix message-worker, replybot, and facebot testrunner to align with desired behavior defined by getFields()→translate-typeform output (old translator as oracle).

## A) message-worker (Go) - Image attachments & Phone fields

### A1. Image attachments: Add `is_reusable: true`
- **File**: message-worker/types/messenger.go
- **Change**: Add `IsReusable *bool` field to `AttachmentPayload` struct
- **File**: message-worker/translator.go
- **Change**: In `translateMessengerMedia()`, set `IsReusable: ptrBool(true)` in payload
- **Expected result**: `{"url":..., "is_reusable":true}`

### A2. Phone fields: Remove native quick-reply
- **File**: message-worker/translator.go
- **Change**: In `translateMessengerText()`, remove the `case "phone_number"` that adds `QuickReply{ContentType: "user_phone_number"}`
- **Verify**: Email quick-reply remains, no other field type affected

### A3. Test & build
- Run: `cd message-worker && go build ./... && go test ./...`
- Update tests in translator_test.go that verify the new is_reusable field
- All tests must pass

## B) replybot (JS) - Choice field values = human-readable labels

### B1. Fix option values in generic-translator.js
- **Legal field** (translateLegal): `value: 'I Accept' / "I don't Accept"` (was boolean true/false)
- **Multiple choice** (translateQuestionWithChoices): `value: choice.label` (was choice.ref)
- **Yes/No** (translateYesNo): `value: 'Yes' / 'No'` (was boolean true/false)
- Opinion scale & Rating: values are already string numbers ✓

### B2. Verify round-trip: label → validator → recording
- Read generic-validator.js to confirm it accepts the labels
- Verify validateQuestion() uses `choices.map(c => c.ref || c.label)` — this already supports labels
- Check response recording flow to ensure the label value is stored, not transformed
- Logic-jump evaluation historically works on labels (no change needed)

### B3. Update tests
- File: replybot/lib/generic-translator.test.js
- Update tests to assert NEW label-based values
- File: replybot/lib/typewheels/machine.test.js (or similar) — check any tests asserting choice values
- Do NOT weaken tests; only align to desired behavior

### B4. Test
- Run: `cd replybot && npm test`
- All tests must pass

## C) facebot testrunner - Metadata JSON key-order robustness

### C1. Make metadata comparison key-order agnostic
- **File**: facebot/testrunner/socket.ts
- **Change**: In `flowMaster()`, when comparing messages with `msg.should.eql(get)`:
  - If both msg and get have a `metadata` string field containing JSON, parse both and compare as objects
  - This makes `{"type":..,"ref":..}` and `{"ref":..,"type":..}` compare equal
  - Keep all other assertions exact (no change to production code)

### C2. Build TypeScript
- Run: `cd facebot/testrunner && npm run build`
- tsc must compile without errors

## Implementation Order
1. A1-A3 (message-worker): Simple, isolated, clear tests
2. B1-B4 (replybot): Needs careful round-trip verification to avoid breaking recording/logic-jumps
3. C1-C2 (facebot testrunner): Test-only change, lowest risk

## Key Principle
Fix production code to match DESIRED behavior (as defined by translate-typeform output).
Relax tests only for non-behavioral details (JSON key order). Strengthen tests to catch real regressions.
