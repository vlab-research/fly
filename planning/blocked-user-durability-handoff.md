# Blocked users: md loss and block durability — handoff (2026-07-25)

Split out of the `PlatformInternalErrors` investigation
(`planning/platform-internal-errors-2026-07-24.md`). That investigation found three
defects; two are **fixed and merged separately**, and the third — everything touching
`block_user` — is deferred here because it is a design change to what blocking means,
not a crash fix.

**Nothing here is causing the alert.** Do not treat this as urgent. It is correctness
and intent alignment.

---

## Stated intent (from the product owner, 2026-07-25)

> Blocking is **forever**. The pointer ensures we no longer care about any of their past
> events. We should no-op any message they send. The only way to unblock is a manual
> `restore_state` call, which we do by hand when something is wrong.

Current behavior violates this in three ways, below.

---

## What already shipped (context — do not redo)

`_noConversation(state)` in `replybot/lib/typewheels/machine.js`: a user with no `forms`
gets a blank start (FALLBACK_FORM) regardless of which event arrived — `TEXT`, `MEDIA`,
`QUICK_REPLY`, `POSTBACK`, and external events all share the rule now. That fixed the
**277** states that never had an `md`.

It deliberately keys on `forms` being empty, **not** on `md`, so a user who is mid-survey
with a damaged `md` is left alone — blank-starting them would append the fallback form and
silently reassign a real participant. Those are the states this handoff covers.

Specs: `replybot/lib/typewheels/machine.test.js` → `describe('md must always carry startTime')`.

---

## Gap 1 — `block_user` drops `md`

`BLOCK_USER` (`machine.js:389`) returns a RESET whose `stateUpdate` is
`{state, pointer, forms}`. `apply()`'s RESET rebuilds from `_initialState()`
(`machine.js:818`), so `forms` survives and **`md` does not**.

Consequence: `getForm(pageId, shortcode, startTime)` gets a shortcode from `forms` but
`undefined` for `startTime` → raw `TypeError` → tagged `INTERNAL` → dean retries forever.
This is the **~50** remaining stuck states. Verified reproduction:

```
after referral   : forms=["FOO"] md={"form":"FOO","startTime":1000,...}
after block_user : forms=["FOO"] md=undefined
after handover   : forms=["FOO"] md={"e_handover_metadata":"new message"}   <- truthy husk
                   INTERNAL: Trying to get a form without a pageid or shortcode
                   or timestamp! 101435865704727, FOO, undefined
```

**Fix:** add `md: state.md` to `BLOCK_USER`'s `stateUpdate`. `md` is bounded in size
(`_eventMetadata` overwrites by key name, so `e_*` keys don't grow with event count), so
keeping it does not reintroduce the bloat the reset exists to shed.

**Target state after a block** (agreed):

```js
{
  state: 'USER_BLOCKED',
  forms:   state.forms,      // keep — which form they were in
  md:      state.md,         // keep — startTime, form, pageid, seed
  pointer: nxt.timestamp,    // keep — lets the refold forget everything prior
  qa: [],                    // drop — this IS the bloat
  // also dropped: question, previousOutput, wait, waitStart,
  //               externalEvents, retries, error, tokens
}
```

Why the reset exists at all: dean's `Spammers` query (`dean/queries.go:261`) fires on
either 25 identical `qa` answers or >100 `externalEvents` — the latter added by `f2281cf3`,
*"quarantine users with bloated externalEvents to prevent replybot OOM"*. It is garbage
collection. The pointer advance is what makes the shedding stick, because a Redis miss
re-folds from `message_pointer` and would otherwise replay the whole spam log and rebuild
the bloat.

---

## Gap 2 — `HANDOVER_EVENT` ignores `USER_BLOCKED`

`HANDOVER_EVENT` (`machine.js:353`) is the **only** path with no `USER_BLOCKED` guard,
unlike `EXTERNAL_EVENT` (`:365`). Measured:

| event | action on a `USER_BLOCKED` state |
|---|---|
| text / quick_reply / postback / referral / synthetic_external | `NONE` |
| **handover** | **`UPDATE_STATE`** |

So a thread passback still wakes a blocked user. Against "we should no-op any message
they send."

**Fix:** same guard as `EXTERNAL_EVENT`.

**Ordering note:** this interacts with the shipped blank-start rule. `_handleExternalEvent`
already refuses to blank-start a `USER_BLOCKED` user for exactly this reason — otherwise a
handover would restart a blocked user and silently undo the block. Keep that guard.

---

## Gap 3 — blocks evaporate after 24h of inactivity

**This is the big one, and it is a design change rather than a patch.**

Redis holds the state with `REPLYBOT_STATESTORE_TTL || '24h'` (`spine-supervisor.js:17`,
not overridden in any values file). The TTL refreshes on every event including no-op'd ones
(`index.js:74` writes `newState` even when `publish` is false), so it is 24h of
**inactivity**.

When the key expires, `getState` rebuilds from the log starting at `message_pointer` — and
`BLOCK_USER` returns `_noop()` on a `START` state (`machine.js:385`), so it cannot reproduce
itself. Reproduced locally:

```
block only                  state=START       forms=[]           md=undefined
block + 1 later message     state=RESPONDING  forms=["fallback"] md={"form":"fallback",...}
```

Worse than plain unblocking: during the refold the state is `START`, so messages they sent
*after* the block — correctly no-op'd live — now take effect and blank-start them.

**Confirmed in prod.** All 5 users blocked on 2026-06-20 are no longer `USER_BLOCKED`:

| userid | now | forms |
|---|---|---|
| 25877534695248989 | END | 10 |
| 37632384996360474 | QOUT | 8 |
| 28001041806149394 | BLOCKED (FB) | 4 |
| 27531602553112734 | QOUT | 5 |
| 24866166979724218 | ERROR (FORM_NOT_FOUND) | 1 |

Not a deliberate unblock: `UNBLOCK` only applies to `state === 'BLOCKED'`, not
`USER_BLOCKED` (`machine.js:374`), so it cannot have moved them. Corroborating: only
**1,993** `USER_BLOCKED` states exist despite dean blocking continuously.

### Why this is not a one-liner

`BLOCK_USER` **derives** its result from live state (`forms: state.forms`). During a refold
that starts *after* the history it derived from, there is nothing to derive from. Removing
the `state === 'START'` guard would make the block itself replay, but `forms` and `md` would
come back empty, because at that point in the fold the state is `_initialState()`.

And the pointer cannot simply stay put: replaying 30k spam events in order to then trim them
is precisely the OOM the pointer exists to prevent.

So the event has to **carry** the state rather than derive it.

### Recommended approach: snapshot-in-log

Use the mechanism that already exists and that you already use for manual unblocks.
`RESTORE_STATE` (`machine.js:290`) takes a full state in `nxt.payload.state`, applies it
unconditionally, and sets `pointer: nxt.timestamp`. Its own comment says it re-hydrates
*"without re-folding the events before it (notably the block_user that this recovers from)"* —
someone already hit this exact problem and built the manual tool for it.

Proposed flow:

1. dean emits `block_user` as today.
2. replybot processes it, computes the trimmed blocked state (Gap 1's target shape), and
   emits a `restore_state` synthetic event carrying that state.
3. `RESTORE_STATE` sets the state and moves the pointer to its own timestamp.
4. A later refold starts *at* the snapshot and rehydrates `USER_BLOCKED` with `forms` and
   `md` intact. Every subsequent event no-ops (given Gap 2 is fixed).

Plumbing already exists end to end: `publishReport` (`index.js:14`) POSTs synthetic events
to `${BOTSERVER_URL}/synthetic`, and those land in `messages` — that is how `machine_report`
events get into the log today. `categorizeEvent` maps `synthetic_restore_state` →
`RESTORE_STATE`.

Nice property: blocking and manual unblocking become the same mechanism with different
payloads.

### Alternative considered — read `state_json` on Redis miss

The full state is already persisted. `gbv-scribble-states` (`scribble/state.go`) is a pure
sink: it UPSERTs the exact state replybot published, no re-derivation. But
`chatbase.get()` (`@vlab-research/chatbase-postgres/lib/index.js:21-27`) joins `states`
**only** to read `message_pointer` — a STORED computed column off `state_json->>'pointer'`
(`devops/migrations/04-pointers.sql`).

So today we persist the complete answer, discard it, and recompute it from a log we
deliberately truncated. Reading `state_json` back on a Redis miss would be lossless and O(1)
instead of replaying up to 30k events (`STATE_STORE_LIMIT=30000`).

Rejected for now as a much larger change with an inverted staleness risk: the fold is
self-correcting (given a complete message log it always yields the true current state),
whereas `state_json` lags scribble's Kafka batch. Doing it properly means snapshot + delta,
not snapshot alone. Worth revisiting if the refold causes further trouble.

### Alternative rejected — park them in an ERROR state

Considered giving external-events-with-no-conversation a dedicated `ERROR` state with a
non-retryable tag (`FORM_NOT_FOUND` is the precedent: an `ERROR` state whose tag sits
outside `DEAN_ERROR_TAGS = NETWORK,INTERNAL,STATE_ACTIONS`, so dean never retries it).

Rejected because it creates a new trap. Blank-start keys off having no `forms`; moving a
user into `ERROR` does not restore their `forms`, but more importantly the earlier
`state === 'START'` variant of the predicate would have trapped them — a later text or
quick_reply would rebuild the `{}` husk. Only a referral recovered. Blank-starting is
simpler and self-healing.

---

## Suggested order of work

1. **Gap 1** (`md: state.md`) — one line, unblocks the ~50 stuck states from recurring.
2. **Gap 2** (handover guard) — one line.
3. **Gap 3** (snapshot-in-log) — the real work. Do it after 1, because making blocks
   permanent **closes the escape hatch that currently heals `md` loss**: today an
   `md`-less blocked user who goes quiet 24h evaporates and returns clean. Make blocks
   durable without Gap 1 and they stay broken forever instead.
4. **Backfill** the existing stuck states — see below.

---

## Backfill

327 states have a non-null `md` with no `startTime`; 296 are `ERROR`/`INTERNAL`.

- **277** never started a survey (`forms` empty). Nothing to preserve — reset them to
  `START`. The shipped blank-start rule means they self-heal on their next event anyway,
  so this is optional cleanup.
- **50** are mid-survey with `md` destroyed by `block_user`. `md` is unrecoverable from the
  log (the pointer moved past the referral), so either reconstruct `startTime` from
  `form_start_time` / the `responses` table, or reset the states and re-recruit.

Find them:

```sql
SELECT userid, pageid, current_form, current_state, error_tag, updated,
       state_json->>'md' AS md,
       jsonb_array_length(COALESCE(state_json->'forms','[]'::jsonb)) AS n_forms
FROM chatroach.public.states
WHERE state_json->'md' IS NOT NULL
  AND state_json->'md'->>'startTime' IS NULL
ORDER BY updated DESC;
```

---

## Tests removed from this branch

Three specs were written against this intent and then pulled out of
`machine.test.js` when the scope was split. Re-add them when picking this up:

```js
describe('blocking a user', () => {
  const blockUser = synthetic({ type: 'block_user' }, { timestamp: 2000 })
  const linksniffer = synthetic({ type: 'external', value: { type: 'linksniffer:click', url: 'x' } })
  const step = (state, event) => apply(state, exec(state, event))

  // A mid-survey user carrying exactly the two things dean blocks for.
  const spammer = () => {
    let s = step(_initialState(), referral)
    s = step(s, _echo('foo'))
    s = step(s, text)
    return step(s, linksniffer)
  }

  it('keeps who they are and drops what made them heavy', () => {
    const before = spammer()
    before.qa.should.have.length(1)
    before.externalEvents.should.have.length(1)
    before.md.should.have.property('startTime', referral.timestamp)

    const next = step(before, blockUser)

    next.state.should.equal('USER_BLOCKED')
    next.forms.should.eql(['FOO'])
    next.pointer.should.equal(blockUser.timestamp)
    should.exist(next.md)
    next.md.should.have.property('startTime', referral.timestamp)
    next.md.should.have.property('form', 'FOO')

    next.qa.should.eql([])
    should.not.exist(next.externalEvents)
    should.not.exist(next.question)
    should.not.exist(next.previousOutput)
  })

  it('ignores everything a blocked user sends', () => {
    const blocked = step(spammer(), blockUser)

    exec(blocked, text).action.should.equal('NONE')
    exec(blocked, qr).action.should.equal('NONE')
    exec(blocked, multipleChoice).action.should.equal('NONE')
    exec(blocked, referral).action.should.equal('NONE')
    exec(blocked, linksniffer).action.should.equal('NONE')
    exec(blocked, handover({ metadata: 'new message' })).action.should.equal('NONE')
  })

  it('stays blocked when the state is rebuilt from the log', () => {
    getState([blockUser]).state.should.equal('USER_BLOCKED')
  })
})
```

Failures at time of writing: `expected undefined to exist` (Gap 1),
`expected 'UPDATE_STATE' to equal 'NONE'` (Gap 2),
`expected 'START' to equal 'USER_BLOCKED'` (Gap 3).

Note the third only pins that the *block* survives a rebuild. Restoring `forms`/`md`
through a refold additionally needs the snapshot emission, which lives in the imperative
shell (`index.js`), not the pure machine — so it belongs in `transition.test.js` or an
integration test, not here.

Fixtures are in `events.test.js`: `handover(payload, more)` is exported, and `block_user`
is generated by the existing helper as `synthetic({ type: 'block_user' })`.
