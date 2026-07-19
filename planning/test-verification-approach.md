# Multi-Part Attachment Test — Verification Approach

**Purpose**: Validate that platform-abstraction v2 correctly handles multi-part message delivery where a single form field sends both an attachment (image) and a multiple-choice question in sequence.

**Related**: See `/documentation/platform-abstraction.md` for architecture overview.

---

## Test Case Overview

**Form**: `multi-part-attachment.json`
- Field 0: Attachment (keepMoving=true)
- Field 1: Multiple-choice
- Field 2: Thankyou screen

**Test**: "Multi-part attachment question sends both the image and the multiple-choice"

---

## What the Test Validates

### Inbound: Message Receipt
1. User is sent referral to form `multi-part-attachment`
2. Replybot receives referral event → UniversalEvent normalization
3. Machine executes field 0 (attachment with keepMoving=true)
4. Because keepMoving=true, machine auto-advances to field 1
5. Test simulates user interaction on field 1 (QR selection)

### Outbound: Pipeline Delivery
1. Machine produces MessageContent objects (not Facebook-native)
2. buildCommands() creates SendMessageCommand entries
3. Message-worker receives commands and translates to platform format
4. **Critical**: Both the attachment AND multiple-choice must be delivered as separate messages/interactions
5. User can respond to the multiple-choice (proving both were sent)

---

## Why This Matters

**Problem Being Solved**: In the old Facebook-native pipeline, fields with attachments and quick_replies were bundled together. Platform-abstraction separates concerns:
- Attachment is a content delivery problem (media transport)
- Multiple-choice is an interaction problem (user input validation)

The test validates that v2's message-worker correctly:
1. Receives both messages from replybot
2. Translates attachments to messenger format (media upload)
3. Translates questions to quick_reply buttons
4. Delivers them in the right order to the platform

---

## Expected Outcome

When the test executes (once infrastructure allows):
- ✓ Field 0 (attachment): Image is delivered, auto-skip honored
- ✓ Field 1 (multiple-choice): User sees Yes/No options
- ✓ Test responds with QR (index 0 = "Yes")
- ✓ Flow advances to thankyou screen
- ✓ Both messages visible in facebot /sent records

If the pipeline is broken:
- ❌ Attachment not delivered → Flow stalls
- ❌ Multiple-choice not delivered → User can't respond
- ❌ Wrong message format → Facebot receives non-MessageContent payload

---

## Test Execution Flow

```
1. Setup: Start Testcontainers stack
   - Docker images: botserver, replybot, message-worker, facebot, kafka, cockroach, redis
   - Topics: vlab-state, vlab-response, vlab-payment, chat-events, commands
   - Database: Seed forms (including multi-part-attachment)

2. Test Start: Send referral
   await sendMessage(makeReferral(userId, 'multi-part-attachment'))

3. Phase 1: Attachment field (keepMoving=true)
   - Expect: [ok, fields[0], []]  // No user input
   - Test receives: Attachment message from facebot
   - Machine auto-advances

4. Phase 2: Multiple-choice field
   - Expect: [ok, fields[1], [makeQR(fields[1], userId, 0)]]  // User selects index 0
   - Test sends: QR to replybot
   - Test receives: Thankyou screen

5. Assertion: Both field 0 (attachment) and field 1 (multiple-choice) were sent
   - Query facebot /sent records
   - Verify message count, content types, ref links
```

---

## Files & References

**Test**: `facebot/testrunner/test.tc.ts` (line ~413)  
**Form**: `facebot/testrunner/forms/multi-part-attachment.json`  
**Stack**: `facebot/testrunner/stack.ts` (Docker + Testcontainers setup)  
**Helpers**: `facebot/testrunner/mox.ts` (getFields, makeQR, makeReferral, flowMaster)

**Platform-Abstraction Docs**: 
- `/documentation/platform-abstraction.md` — Architecture, MessageContent schema, commands
- `/documentation/message-worker-deployment.md` — Message-worker Go service

---

## Debugging (if test fails)

1. Check facebot /sent records: `SELECT * FROM messages WHERE user_id = ? ORDER BY created_at`
2. Check message format: Is it MessageContent or legacy Facebook format?
3. Check logs:
   - Replybot: `docker logs <replybot-container> | grep -i attachment`
   - Message-worker: `docker logs <message-worker-container> | grep -i translate`
4. Check Kafka topics: Do all commands reach the `commands` topic?

---

## Historical Context

**Old Branch** (feature/platform-abstraction): 
- Commit 66281de added this test
- Passed 298 unit tests in replybot, full message-worker Go test suite
- Form file: `facebot/testrunner/forms/multi-part-attachment.json`
- Test: "Multi-part attachment question sends both the image and the multiple-choice"

**v2 Branch** (feature/platform-abstraction-v2):
- Fresh rebase on main + ported platform-abstraction
- Replybot unit tests: 298 passing
- Message-worker: Builds and tests pass
- Facebot integration tests: Being re-applied now

**This Test**: Part of re-applying the full integration test suite to v2 to confirm end-to-end pipeline works.
