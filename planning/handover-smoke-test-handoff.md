# Handover: FB Thread Control Smoke Test

## What was built

- `smoke-echo` service deployed at `https://fly-smoke-echo.vlab.digital` — a secondary FB app that echoes the user's message back and returns thread control to Fly
- `smoke-test/form-a.json` — updated with handoff field and payment optional logic
- `smoke-test/form-b.json` — timeout test moved to end

## Smoke-echo service

- App: FB App ID `976665718578167` (the secondary receiver)
- Primary app (Fly): FB App ID `699455733740842` (env var `FLY_APP_ID` in smoke-echo)
- Page access token: stored in `smoke-echo` k8s secret as `PAGE_ACCESS_TOKEN`
- Webhook: subscribed to `messages`, `messaging_handovers` on the page
- `onHandover`: fires when smoke-echo receives thread control; sends intro message; adds user to `awaitingReply`
- `onMessage`: echoes user reply; calls `passThreadControl(userId, FLY_APP_ID, { smoke_echo: 'ok', echo_text: text })`

## form-a.json changes

- `handoff_statement` description format (documented format):
  ```json
  {"handoff":{"target_app_id":"976665718578167","metadata":{"check":"smoke_test"}},"wait":{"type":"handover"}}
  ```
- `test_payment` multiple-choice field added before `operator`; logic: Yes → `operator`, No → `handoff_statement`
- Timeout test removed from form-a (moved to form-b)

## form-b.json changes

- `timeout_wait` and `welcome_back` fields added at end (before `feedback` would be the last question)

## The bug that is NOT yet fixed

The handoff is not working. Here is the full picture.

### What works
- `handoff_statement` message IS sent to the user correctly
- The message metadata contains `handoff` and `wait` fields (confirmed via `chat_log` DB)
- The `baseAddCustomType` in `translate-typeform` spreads the JSON description into `field.md`, so `md.handoff` and `md.wait` are set

### What is broken
`passThreadControl` is never called. The replybot logs show `handoff: undefined` on every RESPOND action, including the one that processes the jump to `handoff_statement`.

**Root cause (needs confirmation):** `form.js`'s `addCustomType` only handles the OLD YAML format (`type: handoff`). The documented JSON format (`{"handoff":{...},"wait":{...}}`) is parsed by `baseAddCustomType` into `md`, but `addCustomType` does not detect it and does not return the `handoff` field on the question object. Since `field.type` stays `'statement'`, the machine.js ECHO handler at line 417 ignores the echo (`md.type === 'statement'` → `_noop()`), and the machine never enters `WAIT_EXTERNAL_EVENT`.

The `handoff: undefined` in the RESPOND action output means `getHandoffFromMessage` found nothing — either because:
1. The translator for `statement` type does not include `field.handoff` in the message metadata (only `field.md` is spread), OR
2. `getSideEffectFromMessage` is looking for `metadata.handoff` but the key is stored differently

This needs to be traced carefully before any fix is written. The conversation ended before this was resolved.

### What was reverted
I made changes to `form.js`, `handoff.test.js`, `machine.js`, `machine.test.js`, `waiting.js` during debugging. All were reverted to HEAD before this handoff.

### State of the stuck test user
User `1989430067808669` on page `1855355231229529` is stuck in `RESPONDING` state in the `chatroach` database (`states` table). Needs to be reset before testing again.

## What needs to happen next

1. **Understand `handoff: undefined`** — trace exactly what `getHandoffFromMessage` sees for the `handoff_statement` message. Is `metadata.handoff` present or not? Check what the translator puts in the message metadata for a statement field with `md.handoff` set.
2. **Understand the intended architecture** — was the documented JSON format (`{"handoff":{...}}`) ever supposed to work end-to-end? Or is the `form.js` YAML-based code the live implementation? The documentation says JSON; the code says YAML.
3. **Agree on a fix** with the user before writing any code.
4. **Reset the stuck user state** in production DB.
5. **Re-run the smoke test** end-to-end.

## Relevant files

| File | Purpose |
|------|---------|
| `smoke-echo/server/handlers.js` | Secondary receiver logic |
| `replybot/lib/typewheels/form.js` | `addCustomType` — processes field descriptions |
| `replybot/lib/typewheels/machine.js` | `getHandoffFromMessage`, ECHO handler (line 417), RESPOND action (line 658) |
| `replybot/lib/typewheels/waiting.js` | `_normalizeEvent` — normalizes handover webhook to internal event |
| `smoke-test/form-a.json` | Form with handoff_statement |
| `documentation/` | Check for any handoff/handover docs |
| `planning/fix-normalizeEvent-target-app-id.md` | Separate bug: `_normalizeEvent` uses wrong field |

## Reference

- Documented format: https://docs.vlab.digital/fly/reference/questions/#passing-thread-control
- FB Handover Protocol: Primary/Secondary Receiver model
- CockroachDB: `chatbase`/`chatroach` DB, `states` and `chat_log` tables
