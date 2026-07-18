# Platform Abstraction Rebuild — Checkpoint & Resume Plan

## Purpose
Resume point for rebuilding the platform-abstraction work onto fresh main and hardening it to pass the facebot integration suite. Paused deliberately at owner request.

## Staging reality (known facts)

**Staging usage to date**: Exactly ONE two-message attempt was made on staging (branch v0.0.205-wa/v0.1.11-wa deployed to vstag). In that attempt, the bot sent the image (picture) but did NOT send the multiple-choice question that should have followed. That single two-message attempt is the **entire real-world usage** of the abstraction on staging. Staging is NOT a validated or "working" baseline — no full conversation has ever completed there. Behavior beyond that one attempt is unverified on staging.

## Context (verified facts)

**Main branch state**: Phase-1 only. message-worker exists but replybot emits Facebook-NATIVE payloads (type:'native'); message-worker forwards without translating (its translator functions are dead code). Messenger-only inbound. No event-normalizer on main.

**The platform abstraction**: replybot event-normalizer + generic-translator emitting platform-agnostic MessageContent; message-worker translating per-platform. This is the WhatsApp-enabling work. It originally lived on branch `feature/platform-abstraction` (deployed to staging as replybot v0.0.205-wa / message-worker v0.1.11-wa) but had **NEVER been integration-tested** (its facebot testrunner didn't boot message-worker).

**Rebuild strategy**: Clean rebuild onto a new branch off main: `feature/platform-abstraction-v2`.

## What's done on feature/platform-abstraction-v2

**Branch**: `/home/nandan/Documents/vlab-research/fly-platform-abstraction-v2` (HEAD: eecbd72)

**10 commits** (main..HEAD):
```
eecbd72 test(replybot): add comprehensive event-normalizer tests for quick_reply/postback payload parsing
21efc5f test(facebot/testrunner): canonicalize JSON-string key order in message comparison
b6d84c0 test(facebot/testrunner): make metadata comparison robust to JSON key order
6601b05 fix(replybot): choice field values = human-readable labels (desired behavior)
cf9c086 fix(message-worker): add is_reusable to attachments and remove phone quick-reply
fe340db test(facebot): re-apply multi-part attachment integration test on v2
8490c8a feat(message-worker): use platform-abstraction message-worker + port main production fixes
54a990f fix(replybot): correct handover normalization and port test event shapes
675c31b Phase 2: Refactor machine.js, transition.js, and core typewheels for UniversalEvent; preserve handoff-wait guard and restore_state recovery
078814b feat(replybot): add platform-abstraction modules (event-normalizer, generic-translator, generic-validator)
```

**Architectural breakdown**:
- **078814b** — Phase 1 foundations: event-normalizer (Messenger/WhatsApp payload parsing), generic-translator (translates UniversalEvent to platform-agnostic MessageContent), generic-validator (enforces form/flow constraints on MessageContent)
- **675c31b** — Phase 2 core refactor: machine.js/transition.js accept UniversalEvent (instead of raw Messenger event); handoff-wait guard (main's commit 96f27e3) + restore_state recovery (main's 5986b3e) preserved; typewheels updated for abstracted events
- **54a990f** — Test event shape port: replybot tests use correct Messenger JSON structures
- **8490c8a** — message-worker extraction: Go service uses platform-abstraction's MessageContent schema; ports main's production fixes (a325533, 448275b, dbaf0ec, 7f2e0b0)
- **cf9c086** — Output refinements: is_reusable:true on image attachments, phone fields as plain text (no user_phone_number quick-reply)
- **6601b05** — Choice field values: human-readable labels (data-continuous with prod), NOT UUIDs/refs
- **b6d84c0, 21efc5f** — Test robustness: facebot test comparison is JSON-key-order-agnostic (solve metadata key ordering variance)
- **fe340db** — Multi-part retest: attachment + choice integration test re-applied
- **eecbd72** — Event-normalizer full test coverage: 19 new tests for quick_reply/postback JSON-string payload parsing, round-trip validation

## Green (unit level)
- **replybot**: `cd replybot && npm test` → **298 passing**
- **message-worker**: `cd message-worker && go build ./... && go test ./...` → **pass**
- **facebot testrunner**: `cd facebot/testrunner && npm run build` (tsc) → **clean compilation**

## Owner-confirmed DESIRED BEHAVIOR decisions (tests must assert these)

1. **Choice-type fields** (multiple-choice, legal, yes/no) record **HUMAN-READABLE LABELS** as the value (data-continuous with prod), NOT booleans/refs. ✓ Implemented in generic-translator.js.
2. **Phone fields** = PLAIN TEXT input; NO native user_phone_number quick-reply. ✓ Implemented in message-worker translator.go.
3. **Image attachments** include is_reusable:true. ✓ Implemented (commit cf9c086).
4. **JSON key order** is non-behavioral; facebot comparison canonicalizes JSON-string key order (metadata + quick_replies payload). ✓ Implemented in facebot/testrunner/socket.ts (commits b6d84c0, 21efc5f).
5. **Webview/link fields** SHOULD render as Messenger button templates; **notify/OTN** SHOULD render as one_time_notif_req templates. Owner approved implementing webview; see **bug #2** below.

## THE BLOCKER: facebot integration suite = **0 passing / 26 failing**

The facebot integration test suite runs the full pipeline on v2 (v2 inherits main's testrunner, which boots message-worker). Current result: 0 passing / 26 failing. This is the first end-to-end exercise of the abstraction. Not 26 independent issues — **~3 root causes** gate all others. Full failure inventory: see `planning/v2-integration-test-results.md`.

### Root cause #1 (LINCHPIN, NOT yet root-caused) — quick-reply/choice ANSWERS rejected

**Symptom**: User taps a quick-reply → bot replies "Sorry, please use the buttons provided to answer the question." (a repeat) instead of accepting the answer and advancing. This gates logic-jumps, multi-part, validation, translated-response, AND payment; causes the cascade of ~11 "timeout" failures (flows never advance).

**Diagnosis attempt 1** (planning/quick-reply-fix-diagnosis.md): The unit-level event-normalizer.js DOES parse the JSON-string payload `{"value":..,"ref":..}` and extract .value correctly (19 new tests pass). Yet the integration test still rejects answers.

**Diagnosis attempt 2** (planning/v2-verification-status.md): Contradicted attempt 1; unclear if the issue is parsing, matching logic, or something else.

**Status**: UNRESOLVED — two diagnosis passes gave conflicting unit-level signals. To determine whether this is a real bug in the matching logic or a test-harness simulation of an incorrect round-trip, hands-on observation of the running stack is required.

**NEXT STEP (hands-on, REQUIRED)**:
1. Instrument the answer-validation path in v2: add logging at the point where replybot evaluates whether an incoming answer matches one of the current question's valid options.
2. Capture BOTH:
   - The exact incoming answer value (`nxt.payload.value` after event-normalizer parsing)
   - The current question's valid options at the moment the "please use the buttons" error fires
3. Run ONE integration test (e.g., the opinion_scale logic-jump test, or the payment test).
4. Read the **container logs** (replybot and message-worker) to see the real value-vs-options mismatch.
5. **DO NOT guess from unit code alone.** Resolve this by observing the running stack, not unit code analysis.

### Root cause #2 — all Messenger TEMPLATE types dropped (feature-add, ~135-185 LOC, owner approved)

**Impact**: ~2 failures (webview/link fields, notify/OTN flows).

**Symptom**: webview/link fields (#16, #18) and notify/OTN one_time_notif_req (#22) render as TEXT-only; the abstraction's MessageContent can't represent templates/buttons.

**Fix scope**: Add a template/button message type to message-worker/types/command.go MessageContent + a translator path in message-worker/translator.go + update replybot generic-translator.js translateWebview (and the notify path).

**Sizing**: types ~20-30 LOC, translator ~40-50, generic-translator ~15-20, tests ~30-40. **Do NOT implement until root cause #1 is fixed** — it may gate other flows.

### Root cause #3 — payment flow (#2, #3)

**Impact**: ~2 failures (payment success, payment failure).

**Symptom**: Payment success/failure returns the "please use the buttons" repeat instead of the thank-you/error message.

**Assessment**: Very likely the SAME bug as root cause #1 (answer rejection in payment context). **Re-verify after #1 is fixed.**

## IMPORTANT CAVEAT

**Staging usage to date = one two-message attempt** (see Staging reality above). Behavior beyond that single attempt is unverified anywhere, including on staging. These bugs may or may not exist on the old branch; the abstraction has never been full-flow validated anywhere.

## Resume order

1. **Root-cause + fix #1** (answer rejection) via hands-on stack debugging.
   - Instrument replybot answer-validation logic.
   - Run ONE integration test; read container logs.
   - Identify the real value-vs-options mismatch.
   - Implement fix.
   - Verify with facebot sanity subset (3 representative tests: logic-jump, payment, multi-part).

2. **Implement template support** (#2: webview + notify/OTN).
   - Add types/translator/generic-translator changes.
   - Unit test + integration test.
   - Verify.

3. **Re-verify payment** (#3).
   - Confirm it's fixed by #1, or implement if independent.

4. **Drive the FULL facebot suite to green** (it is the primary feedback loop for this work).
   - See `planning/facebot-test-plan.md` for hardening plan.
   - Coverage gaps noted: handoff-guard, restore_state, per-type delivery-format asserts; diagnostics improvements.

5. **THEN deploy v2 with -wa staging tags** (see documentation/staging-tagging-and-deploy.md) and re-test on staging.

6. **THEN remaining WhatsApp P0** (see documentation/platform-abstraction.md):
   - Real WhatsApp API client (replace stub).
   - WhatsApp token store by phone_number_id.
   - botserver WhatsApp webhook.
   - WhatsApp event normalization.

## Related artifacts

- `planning/v2-integration-test-results.md` — full facebot failure inventory from first sanity run (3 tests, 0 passing, ~6 root-cause patterns identified)
- `planning/quick-reply-fix-diagnosis.md` — event-normalizer payload parsing analysis (concluded fix is already in code, but integration still fails)
- `planning/v2-verification-status.md` — second diagnostic pass (contradicted first; unclear findings)
- `documentation/platform-abstraction.md` — feature spec and data flows (in main worktree; scope the abstraction as branch-only vs main's native passthrough)
- `replybot/README.md`, `message-worker/README.md` (in branch and main worktree) — architecture docs to be reconciled post-merge
- `documentation/staging-tagging-and-deploy.md` — the -wa staging-only tagging convention + deploy runbook (will be created as part of v2 deploy readiness)

## Environment caution

**facebot testcontainers runs are resource-heavy** (~10-17 min; boots CockroachDB, Redpanda, replybot, message-worker, botserver, facebot, etc.). Disk/CPU limits have stalled runs.

**NEVER run**:
- `docker system prune` / `docker system prune -af --volumes`
- `pkill -9 docker` / `pkill -9 <service>`
- Any destructive cleanup to force a run

**If resource-limited**, stop and ask the owner to free space. A subagent once ran `docker system prune -af --volumes` + `pkill -9` unauthorized — do not repeat.

---

**Checkpoint created**: 2026-07-18  
**Branch**: `feature/platform-abstraction-v2` (HEAD: eecbd72)  
**Status**: Paused at owner request; ready to resume once root cause #1 is diagnosed and fixed.
