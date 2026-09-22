# Replybot: the RESTORE_STATE short-circuit was dropped in a refactor

**Found:** 2026-07-26, while preparing the staging → production promotion.

> ## ⚠️ STATUS UPDATED 2026-09-04 — IT HAS SHIPPED, AND IT IS A PREREQUISITE
>
> **The status below is STALE.** It said the regression was staging-only and that
> the production line (`v0.0.204`) still had the correct behaviour. **The
> promotion happened. Production has the regression.** Verified at the tags:
>
> ```
> replybot-v0.0.204 :106   if (output.action === 'RESET' || output.action === 'RESTORE_STATE') {
> replybot-v0.0.224 :139   if (output.action === 'RESET') {
> ```
>
> **Production runs `v0.0.224`** — `ghcr.io/vlab-research/replybot:v0.0.224`,
> `kubectl get deploy -n vprod`, 2026-09-04. The working tree matches v0.0.224 at
> `replybot/lib/typewheels/transition.js:139`, and
> `grep -ci restore replybot/lib/typewheels/{machine,transition}.test.js` returns
> **0 / 0** — still no test that would catch it.
>
> **So the recovery tool is degraded in production right now.** A `RESTORE_STATE`
> output falls past the short-circuit into `actionsResponses()` and performs the
> `getPageToken`/`getForm`/`getUser` IO the snapshot exists to skip. Nothing is
> *sent* to the participant — `act()` has no `RESTORE_STATE` case — so the failure
> mode is not a spurious message. But that IO **can throw**, and
> `getForm(pageId, shortcode, startTime)` is precisely where a wrong or missing
> `md.startTime` fails.
>
> **This is now E0, a PREREQUISITE**, not a fast-follow. It blocks Task E
> (snapshot-in-log) in `planning/platform-guess-expiry.md` §7: Task E emits a
> `restore_state` on **every block**, against an armed population of 11,492
> conversations on one account. Doing that on top of the degraded short-circuit
> means every one of those blocks performs the IO the design exists to avoid.
>
> **FIXED on branch `fix/husk-restore-state`, commit `48e12233`** — *"fix(replybot):
> restore the RESTORE_STATE short-circuit in transition.js"*: the two-line clause
> plus its explanatory comment, and the tests recovered from `5986b3e4`
> (`transition.js` +15, `transition.test.js` +53, `machine.test.js` +77).
> **Unpushed and undeployed** as of 2026-09-04.

**Status (as written 2026-07-26, now superseded — see above):** not fixed.
Present on `staging` (replybot `v0.0.210-wa`). Absent from the production line
(`v0.0.204`), which still has the correct behaviour.
**Blocker?** No. Explicitly agreed as a fast-follow, not a promotion blocker.

## Summary

`restore_state` is the hand-injected recovery event used to put a user's state
back when something has gone wrong in production. Production replybot
`v0.0.204` short-circuits it in `transition.js`, deliberately skipping all IO.
The staging line does not — the clause was removed by a refactor whose commit
message claims it was preserved, and the tests that covered it were deleted in
the same commit.

Net effect: **promoting staging replaces production's recovery tool with a
weaker version of itself.**

## The regression

Production (`c30f755a`, tagged `replybot-v0.0.204`),
`replybot/lib/typewheels/transition.js:106`:

```js
      if (output.action === 'RESET' || output.action === 'RESTORE_STATE') {

        // publish a report, but don't do anything else, state is reset/restored,
        // no messages or responses. For RESTORE_STATE this also deliberately skips
        // the getPageToken/getForm/getUser IO in actionsResponses -- the snapshot
        // is self-contained, so no form lookup is needed and nothing is sent to
        // the user.
```

Staging, `replybot/lib/typewheels/transition.js:140`:

```js
      if (output.action === 'RESET') {
```

The `RESTORE_STATE` arm is gone.

## Provenance

The work *was* correctly reimplemented on the staging line. This is not a
lineage gap — see `documentation/release-lineages.md`.

1. `5986b3e4` added restore_state to the staging line. Its diff of
   `transition.js` is exactly the two-line change above, and it shipped 74 lines
   of `machine.test.js` plus 19 lines of `transition.test.js` covering: restore
   from `USER_BLOCKED`, restore from `START` (durability), no FB message sent,
   clean initial state, and the `run()` short-circuit itself.

2. `675c31bd` — *"Phase 2: Refactor machine.js, transition.js… **preserve**
   handoff-wait guard and restore_state recovery"* — removed it:

   ```
   -      if (output.action === 'RESET' || output.action === 'RESTORE_STATE') {
   +      if (output.action === 'RESET') {
   ```

   The commit message asserts preservation; the diff contradicts it. The
   `machine.js` half survived, which is why the feature looks present.

3. The same commit rewrote both test files and none of the restore_state
   coverage came back. On `staging` today:

   ```
   grep -ci restore replybot/lib/typewheels/machine.test.js     -> 0
   grep -ci restore replybot/lib/typewheels/transition.test.js  -> 0
   ```

   There is no test that would catch this.

## Behavioural consequence

With the clause gone, a `RESTORE_STATE` output falls past the short-circuit into
`actionsResponses()` (`transition.js:44`), which unconditionally:

1. `transition.js:49` — throws `User without metadata: <uid>` if the restored
   snapshot has no `md`. The throw is untagged, so it surfaces as
   `tag: 'STATE_ACTIONS'` — which the codebase's own comment
   (`transition.js:176-178`) says is *"read downstream as 'platform fault'"*.
   **It pages the platform.**
2. `transition.js:53` — `iowrap('getForm', ...)`, a live formcentral lookup
   keyed on `newState.md.startTime`. On 404 or timeout this throws a tagged
   `MachineIOError` with `publish: true`; the error report is fed back through
   the machine, which moves the user to **ERROR state** — immediately after the
   restore that was supposed to rescue them.

Nothing is *sent* to the user: `machine.js` `act()` has no `RESTORE_STATE` case,
so it hits `default: return { messages: [] }`, and `update()` returns
`undefined`, so no responses are emitted. The failure mode is not a spurious
message to a participant.

For the canonical case — a falsely-blocked user whose `md.startTime` and form
still resolve — the restore still works correctly, at the cost of two pointless
IO calls. It degrades only when the form lookup fails.

## What is NOT wrong

Worth recording, because it was suspected and cleared:

- **The event shapes are equivalent.** `documentation/release-lineages.md:66-69`
  warns that `v0.0.204` reads `nxt.event.value.state` while the staging line
  reads `nxt.payload.state`, and calls them "not interchangeable". They resolve
  to the same bytes: `replybot/lib/event-normalizer.js:238` sets
  `payload: event.value !== undefined ? event.value : null` inside
  `parseSyntheticEvent`. Both lineages require the identical wire shape:

  ```json
  {"source":"synthetic","user":"<uid>",
   "event":{"type":"restore_state","value":{"state":{...}}}}
  ```

  That doc paragraph should be corrected.

- **There is no in-repo emitter to break.** `grep -rn -i restore_state` across
  the whole tree hits only `machine.js` and markdown. The event is injected by
  hand via botserver's `POST /synthetic`
  (`botserver/server/handlers.js:70`), which stamps `source: 'synthetic'`.
  `planning/blocked-user-durability-handoff.md:18` confirms: *"`restore_state`
  call, which we do by hand when something is wrong."*

- **`machine.js` is fine.** `RESTORE_STATE` is still mapped
  (`machine.js:166`) and handled (`machine.js:340`, `:354`, `:639`).

## Proposed fix

**Steps 1–3 are IMPLEMENTED on `fix/husk-restore-state`, commit `48e12233`
(2026-09-04, unpushed).** Step 4 was not done. The text is kept as written
because it is the spec that commit was built from.

1. Restore the clause in `replybot/lib/typewheels/transition.js`:

   ```js
   if (output.action === 'RESET' || output.action === 'RESTORE_STATE') {
   ```

   Keep the explanatory comment from `c30f755a` — it documents *why* the IO is
   skipped, which is the part that got lost.

2. Restore the tests `675c31bd` deleted, adapted to the post-refactor test
   structure. At minimum: the `run()` short-circuit, restore from
   `USER_BLOCKED`, restore from `START`, and an assertion that no form lookup
   occurs.

3. Add a regression test asserting `getForm` is **not** called on a
   `RESTORE_STATE` transition. That is the specific property the refactor lost,
   and the only one that would have caught it.

4. Correct `documentation/release-lineages.md:66-69` — the two event shapes are
   equivalent once normalization is accounted for.

## Sequencing note

⚠️ **Overtaken by events.** This said the fix belongs on `staging` first because
"fixing it post-promotion means production temporarily loses a recovery
capability it currently has". **The promotion already happened and production
already lost it** (see the status box at the top). There is no pre-promotion
window left to protect; the remaining sequencing constraint is simply
**E0 → E**: ship `48e12233` before Task E starts emitting `restore_state` on
every block. `planning/platform-guess-expiry.md` §8.

## Explicitly not done

- No code was changed.
- Whether any other behaviour was silently dropped by `675c31bd` was not
  audited. Given this one was mis-described in its own commit message, and the
  same commit deleted 625 lines of `machine.test.js`, a broader review of that
  refactor is warranted and has not been performed.
