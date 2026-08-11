# Fix `_normalizeEvent` target_app_id inconsistency

## Problem

`_normalizeEvent` in `replybot/lib/typewheels/waiting.js` uses `new_owner_app_id` to set `target_app_id` on the normalized handover event:

```js
value.target_app_id = event.pass_thread_control.new_owner_app_id
```

But `makeEventMetadata` in `machine.js` uses `previous_owner_app_id` for the same concept:

```js
return _eventMetadata('e_handover', { target_app_id: previous_owner_app_id, ...parsed })
```

When smoke-echo returns control to Fly, the incoming event has:
- `new_owner_app_id` = FLY_APP_ID
- `previous_owner_app_id` = SMOKE_ECHO_APP_ID

So `_normalizeEvent` produces `target_app_id = FLY_APP_ID` — which makes a wait condition like `{ type: "handover", value: { target_app_id: SMOKE_ECHO_APP_ID } }` unmatchable.

## Fix

Change `waiting.js` line 60:
```js
// before
value.target_app_id = event.pass_thread_control.new_owner_app_id

// after
value.target_app_id = event.pass_thread_control.previous_owner_app_id
```

Update `waiting.test.js` tests around line 335 — they currently assert `target_app_id = new_owner_app_id`, which is the wrong field.

## Why we deferred

For now, `form-a.json` uses `{"wait": {"type": "handover"}}` (no `value` filter) which sidesteps the issue — any handover fulfills the wait, and the machine security check already ensures only handovers TO Fly are processed. So it's safe.

The fix should land before anyone writes a wait condition that filters by specific `target_app_id`, as documented at `docs.vlab.digital/fly/reference/questions/#passing-thread-control`.
