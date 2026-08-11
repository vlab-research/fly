# First-class `handoff` field type (wait mode) + fix the stuck-handoff bug

> Status: planned, not yet implemented. Authored 2026-06-09. Scope: replybot (Node) +
> a one-line addition to the `@vlab-research/translate-typeform` package.

## Context

Test users who reach the AI-chatbot handoff get permanently stuck in `WAIT_EXTERNAL_EVENT`
and are never returned to the survey (confirmed on user `24311852335166032`, page
`101435865704727`).

### Root cause (verified from the ordered `messages` log + `machine_report`s)

Events are **strictly Kafka-ordered** — there is no out-of-order delivery. The real sequence:

1. User answers the question before the handoff. `exec` returns `RESPOND`; `act()` sends the
   handoff message **and** returns a `handoff`, so `transition.js` fires `passThreadControl`
   **immediately**. State stays `RESPONDING`; the wait is *not* armed — that only happens when
   the echo of the handoff message arrives.
2. **The echo never arrives** — once we hand thread control to the external app, Facebook
   stops delivering our message echoes to us.
3. The external app hands control back (handover event) while state is still `RESPONDING`, so
   `_handleExternalEvent` files it into `externalEvents` and does nothing else.
4. Much later, Dean's `redo` re-sends the handoff message; now that we are primary again the
   echo finally arrives and arms the wait — but the handback it needed is already in the past.

The defect: **handoff dispatch is tied to *sending* the message, but handing off suppresses
the echo that arms the wait.** Control is relinquished during a window where the wait is not
yet armed, and the handback that arrives in that window is missed.

Two compounding facts found while investigating:

- The `type: handoff` shorthand is **unwired** — there is no `'handoff'` translator in
  `@vlab-research/translate-typeform`, so authors hand-wire handoffs as `type: wait` + a manual
  `handoff` block. (The `addCustomType` "handoff support" block in `replybot/lib/typewheels/form.js`
  sets `type:'handoff'`, which would crash the translator — it is effectively dead.)
- There is **no timeout backstop and no `take_thread_control`** anywhere in `replybot/lib/`.
  The stuck user's wait was `{type: handover}` with no timeout, so a missed handback is
  unrecoverable. `HANDOFF_PROTOCOL.md`'s "times out after 60m and reclaims control" is
  aspirational, not implemented.

## Decision

Make `handoff` a **first-class field type** with `mode` as a sub-feature. Only `mode: wait`
is implemented now; `nowait` (hand off → END) and `reclaim` (hand off → wait-or-timeout →
`take_thread_control` → resume) are **deferred** but the schema is shaped for them.

The author declares a handoff, never a wait — the hand-back wait is **synthesized at runtime**,
reusing the existing wait machinery. A handoff is **both a type and a parameterized block**:
metadata is `{ type:'handoff', handoff:{…} }`, exactly parallel to a wait's
`{ type:'wait', wait:{…} }`. The type says what the message is; the block carries its params.

The handoff is dispatched **only when the echo of the handoff message arms the wait** — never
on send. This is the one correct order (**send → echo → wait armed → hand off**) because the
echo's job is to arm the wait and handing off destroys the echo channel. Since replybot
processes a user's events sequentially, the handback (a strictly-later Kafka event) is always
processed after the wait exists.

Payment stays **fire-on-send** (unchanged). Moving payment to the echo would require
un-`_noop`-ing payment-statement echoes and adding "already paid" state to prevent
double-paying on `redo`/repeat — not worth it and out of scope.

## Layer A — runtime (`replybot/lib/typewheels/machine.js`)

### 1. `exec()` ECHO handler — add a `handoff` type branch

Insert alongside the existing `thankyou_screen` / `stitch` / `wait` branches (~line 427). No
noop-guard change is needed: `type:'handoff'` is not `'statement'`, so it passes the existing
`md.type === 'statement'` guard. **This also reverts the drafted "reconcile-on-echo" block**
that was added to the `md.wait` branch in the working tree — restore the plain `md.wait`
branch.

```js
if (md.type === 'thankyou_screen') {
  return { action: 'END', question: nxt.message.metadata.ref }
}

if (md.stitch) {
  return _stitch(state, md.stitch, nxt)
}

// First-class handoff: a type ('handoff') carrying a parameterized block (md.handoff).
// The echo confirms the message was delivered while we are still the primary receiver,
// so we now (a) synthesize the hand-back wait and (b) dispatch the handoff. Passing
// control any earlier would suppress this very echo, and the wait would never arm.
if (md.type === 'handoff') {
  const { mode = 'wait' } = md.handoff
  if (mode !== 'wait') {
    throw new Error(`handoff mode '${mode}' is not supported yet (only 'wait')`)
  }
  return {
    action: 'WAIT_EXTERNAL_EVENT',
    question: md.ref,
    wait: { type: 'handover' },          // synthesized; author declares no wait
    waitStart: state.waitStart || nxt.timestamp,
    handoff: md.handoff                  // parameterized block, dispatched after the echo
  }
}

if (md.wait) {
  return {
    action: 'WAIT_EXTERNAL_EVENT',
    question: md.ref,
    wait: md.wait,
    waitStart: state.waitStart || nxt.timestamp
  } // propogate if repeat
}
```

- The echo is processed once (repeats are noop'd) → fires exactly once.
- `_handleExternalEvent`'s still-waiting `WAIT_EXTERNAL_EVENT` output does **not** set
  `handoff`, so a later non-fulfilling external event can't re-fire it.
- Bare `{type:'handover'}` is the correct synthesized wait: the normalized hand-back event
  carries `target_app_id = new_owner_app_id` (us), so a `value:{target_app_id:<external>}`
  wait would never match. (See `waiting.js` `_normalizeEvent`.)
- `apply()`'s `WAIT_EXTERNAL_EVENT` case picks fields explicitly and ignores `output.handoff`,
  so the handoff stays purely an `act()` side-effect — no state pollution.

### 2. `act()` — add a `WAIT_EXTERNAL_EVENT` case

Immediately before `default:` (currently the action falls through to `default:{messages:[]}`):

```js
case 'WAIT_EXTERNAL_EVENT': {
  // Only the echo-arming handoff output sets output.handoff; the still-waiting output
  // from _handleExternalEvent does not, so this never re-fires.
  return { messages: [], handoff: _wrapSideEffect(ctx, output.handoff) }
}
```

`_wrapSideEffect(ctx, undefined)` → `undefined`, so ordinary (non-handoff) waits emit no
handoff. `output.handoff` is the `md.handoff` block, so `transition.js`'s existing
`passThreadControl(handoff.userid, handoff.target_app_id, handoff.metadata, …)` works unchanged
(the extra `mode` key is ignored).

### 3. `act()` `RESPOND` case — stop firing the handoff on send (~line 701-702)

```js
const payment = messages.map(m => getPaymentFromMessage(ctx, m)).find(p => p) // Get first payment
// DELETE: const handoff = messages.map(m => getHandoffFromMessage(ctx, m)).find(h => h)
return { messages, payment }   // was: { messages, payment, handoff }
```

### 4. Remove the now-unused `getHandoffFromMessage` (~line 774)

Nothing calls it anymore. `getSideEffectFromMessage` / `getPaymentFromMessage` stay (payment
still uses them).

`transition.js` is **unchanged**: it already does `if (handoff) this.handoff(handoff, pageToken)`
after `act()`. The handoff now arrives from the echo→`WAIT_EXTERNAL_EVENT` transition instead
of the `RESPOND` transition.

## Layer B — authoring + rendering

### Authoring shape

A handoff field's Typeform description is YAML:

```yaml
type: handoff
handoff:
  target_app_id: 619383124328766
  mode: wait
  metadata: { return_app_id: 699455733740842, ... }
```

`baseAddCustomType` (in the package) parses that into `md = { type:'handoff', handoff:{…} }`
and sets `field.type = 'handoff'`.

### 5. Add a proper `handoff` translator — `@vlab-research/translate-typeform`

In `translate-fields.js`, add the alias next to the existing `wait`/`stitch` ones (~line 198)
and register it in `lookup` (~line 375):

```js
const translateWait = translateShortText
const translateStitch = translateShortText
const translateHandoff = translateShortText      // NEW — renders the title as text
...
const lookup = {
  ...
  'wait': translateWait,
  'stitch': translateStitch,
  'handoff': translateHandoff,                    // NEW
  ...
}
```

(Optionally export `translateHandoff` for parity; the lookup is internal.) Publish a new
version and bump `replybot/package.json` + `package-lock.json` (like prior `translate-typeform`
bumps; `^0.2.16` already permits `0.2.17`, but bump explicitly). `translator` then renders
`type: handoff` natively, producing metadata `{ type:'handoff', handoff:{target_app_id, mode,
metadata}, ref }`.

### 6. `replybot/lib/typewheels/form.js`

- **`translateField` is unchanged** — the package now knows `handoff`, so no shim:
  ```js
  function translateField(ctx, qa, field) {
    return translator(addCustomType(interpolateField(ctx, qa, field)))
  }
  ```
- **Simplify `addCustomType` to a passthrough** — remove the broken handoff block (lines
  ~291-328) that synthesized a wait at authoring time:
  ```js
  function addCustomType(field) {
    return baseAddCustomType(field)
  }
  ```
  (`yaml` import stays — `castValue` still uses it.)

> Parity note: the Rust machine (`machine/`) has its own field translation "to match Rust
> machine behavior" (per the package comment). Adding `handoff` there is a separate follow-up;
> replybot (Node) is the implementation in use and the scope of this change.

## Migrate legacy handoff forms

Existing forms are authored as `{ type:'wait', handoff:{…}, wait:{…} }` (the `aichatbot`
survey, `smoke-test/form-a.json`) and will no longer dispatch a handoff once the runtime keys
on `type:'handoff'`. Migration is minimal: **flip `type: wait` → `type: handoff` and drop the
manual `wait` block — keep the `handoff` block as-is.** Enumerate any other handoff-bearing
surveys via the survey `form` JSON and migrate them. These are test surveys, so migration is
low-risk and keeps the runtime free of a legacy fallback path.

## Tests — `replybot/lib/typewheels/`

- **Remove** the drafted reconcile/"race condition" test in `machine.test.js`
  (`it('should fulfill wait immediately when handover arrived before the echo …')`).
- **`machine.test.js`** — rework the handoff tests (~2156-2238, ~2518) around the real type:
  - answering the question before a `type: handoff` field sends the handoff message with
    `actions.handoff` **absent** (no fire-on-send);
  - the **echo** of the handoff message enters `WAIT_EXTERNAL_EVENT` with a synthesized
    `{type:'handover'}` wait and fires `actions.handoff` (`target_app_id`/`metadata` from the
    field's `handoff` block);
  - a subsequent handover event resumes the survey to the next question;
  - a non-`wait` mode throws.
- **`form.test.js`** — `translateField` renders a `type: handoff` field as a text message whose
  metadata is `{type:'handoff', handoff:{target_app_id, mode, metadata}, ref}`.

## Docs — `replybot/HANDOFF_PROTOCOL.md`

Rewrite to match reality: `type: handoff` with a `handoff:` block, `mode: wait` (only
supported mode), runtime-synthesized hand-back wait, control passed **after** the echo arms
the wait. Mark `nowait`, `reclaim`/`take_thread_control`, and timeout backstops as **not yet
implemented**.

## Operational unstick (existing stuck test users)

```sql
SELECT userid, pageid
FROM states
WHERE current_state = 'WAIT_EXTERNAL_EVENT'
  AND state_json->'wait'->>'type' = 'handover'
  AND jsonb_array_length(COALESCE(state_json->'externalEvents','[]')) > 0;
```

Unstick by publishing a fresh `handover` event for each into the chat-events topic; in
`WAIT_EXTERNAL_EVENT` it fulfills the wait and resumes the survey. Confirm the exact injection
mechanism with devops before running.

## Verification

1. `cd replybot && nvm use && npm test` — full suite green incl. updated/added tests.
2. Migrate `smoke-test/form-a.json` to author the handoff via `type: handoff` (+ `handoff:`
   block with `mode: wait`) and run the `smoke-echo` end-to-end harness against a
   baseline→handoff (stitched) shape: confirm the participant is returned to the survey after
   the echo bot hands control back.
3. Re-query the unstuck user(s) to confirm `current_state` advances past
   `WAIT_EXTERNAL_EVENT`.

## Key files

| File | Change |
|------|--------|
| `replybot/lib/typewheels/machine.js` | ECHO `handoff` branch; `act()` `WAIT_EXTERNAL_EVENT` case; drop handoff scrape from `RESPOND`; remove `getHandoffFromMessage`; revert reconcile draft |
| `replybot/lib/typewheels/form.js` | simplify `addCustomType` to passthrough (`translateField` unchanged) |
| `@vlab-research/translate-typeform` `translate-fields.js` | add `translateHandoff` + `lookup` entry; publish + bump dep |
| `replybot/lib/typewheels/machine.test.js`, `form.test.js` | rework handoff tests; remove draft test |
| `replybot/HANDOFF_PROTOCOL.md` | rewrite to match reality |
| `smoke-test/form-a.json` + `aichatbot` survey (+ any other handoff forms) | migrate `type: wait` → `type: handoff` |
