# Plan — the `INTERNAL`/`getForm` self-sustaining retry loop

> **Status:** not started. Written 2026-07-27 from a production investigation
> (read-only) of prod CockroachDB + Prometheus, one day after the
> platform-abstraction cutover.
>
> **This is pre-existing, not a v2 regression.** 2,196 lifetime states carry
> this error, the oldest `updated` in **2020-09-12**. `INTERNAL` counts were
> flat across the cutover (2–6/hr, no step change). Do not chase it as
> abstraction fallout.
>
> **Read first:** `documentation/error-events.md` (thin `states.error` vs. the
> deferred `errors` projection), `documentation/study-error-alerting.md` §
> "Error Taxonomy" (why the `INTERNAL` tag matters), `documentation/states-debugging.md`,
> `replybot/README.md` (state machine).

---

## 0. Start here — reproduce it before you change anything

**Do not start by writing a fix.** The first deliverable is a *failing test*
that reproduces the bug, and it should live as close to the functional core as
possible.

Preference order for where the reproduction lives:

1. **`replybot/lib/typewheels/machine.test.js`** — best. `exec`/`apply` are
   pure functions; if the bug is reachable here it can be pinned with no IO at
   all, and the fix belongs here too (see §3).
2. **`replybot/lib/typewheels/transition.test.js`** — acceptable fallback. This
   is where `actionsResponses` lives (the function that actually throws), but it
   needs `getForm` stubbed, so the test is about wiring rather than logic.
3. `facebot/testrunner/test.tc.ts` — only as an end-to-end confirmation *after*
   a unit-level reproduction exists. Never as the primary test.

Two distinct shapes must both be reproduced — they are different bugs wearing
the same error message. Confirm both against the field evidence in §2 before
writing assertions.

**Reproduction A — no conversation at all (`forms: []`)**

Feed a `handover` (`pass_thread_control`) or bare `user_text` event into a
fresh/absent state, on a page where the user has no active form. Assert what
`exec` returns. Observed in prod: the machine produces a `RESPOND` output and
`apply` moves the state to `RESPONDING`, with `forms: []` and
`md: {"e_handover_metadata": "new message"}`.

**Reproduction B — conversation exists, metadata lost (`md: {}`)**

State has `forms: ["305", "banglahpv"]` and a pointer, but `md` is `{}` — no
`startTime`. Any event (real inbound *or* a synthetic `redo`) then fails.
Observed in prod on user `6891544804295134`, page `758018254333043`.

A good reproduction answers a question this investigation could not: **how does
a state reach shape B in the first place?** `getMetadata()`
(`replybot/lib/typewheels/utils.js:75-99`) unconditionally sets `md.form`,
`md.startTime`, `md.pageid` and `md.platform`, so a conversation that passed
through the `conversation_started` path cannot have an empty `md`. Something
either bypasses that path or overwrites `md` later. Find it — a fix that only
patches the symptom will leave shape B regenerating.

---

## 1. What actually happens

`replybot/lib/typewheels/transition.js` `actionsResponses`:

```js
const shortcode = newState.forms.slice(-1)[0]      // undefined when forms: []

if (!newState.md) {                                 // guard passes on md: {}
  throw new Error(`User without metadata: ...`)
}
const { startTime } = newState.md                   // undefined when md has no startTime

const [form, surveyId] = await iowrap('getForm', 'INTERNAL', this.getForm,
  pageId, shortcode, startTime)
```

`getForm` (`lib/typewheels/ourform.js:28-31`) then throws:

```js
if (!pageid || !shortcode || !timestamp) {
  throw new TypeError(`Trying to get a form without a pageid or shortcode or timestamp! ...`)
}
```

`iowrap` (`lib/errors.js:12-26`) re-wraps any non-`MachineIOError` as
`MachineIOError('INTERNAL', 'getForm')`. The state goes to `ERROR` with
`error_tag = 'INTERNAL'`.

Three defects compound here:

1. **The `md` guard is wrong.** `if (!newState.md)` catches an *absent* `md`
   but not an *empty* one — `{}` is truthy, so it sails through and yields
   `startTime: undefined`. The guard was written for the case that doesn't
   occur in the field; the case that does occur is unguarded.
2. **A logic error is reported as an IO error.** "This conversation has no
   form" is knowable synchronously from the state, with no network call. Wrapping
   it in `iowrap(..., 'INTERNAL', ...)` launders a deterministic precondition
   failure into a transient-looking platform fault.
3. **`INTERNAL` is the wrong tag** — see §4.

---

## 2. Field evidence (prod, 2026-07-27, read-only)

Scale: **2,196** lifetime states with `error_tag='INTERNAL'` and
`state_json->'error'->>'message' = 'getForm'`; **13** with `updated` in the
trailing 24h. Low volume, unbounded duration.

Distinct `getForm` argument triples seen in the trailing 24h (recovered from
`state_json->'error'->>'stack'`, which only pre-thin-format rows still carry):

| `pageid, shortcode, timestamp` | n | shape |
|---|---|---|
| `101435865704727, undefined, undefined` | 4 | A |
| `101435865704727, incentiveswahili, undefined` | 2 | B |
| `758018254333043, vaxsocial400, undefined` | 1 | B |
| `758018254333043, banglahpv, undefined` | (traced) | B |

Shape A, traced end to end (user `5949070365165277`, page `106964348279583`,
2026-07-27 06:48 UTC) — the user sent an image to a page with no active
conversation:

```
06:48:52  inbound: message.attachments[0].type = "image"
06:48:54  machine_report → newState.state = "RESPONDING", forms: [], md: {"e_handover_metadata":"new message"}
06:48:56  machine_report → newState.state = "ERROR"       (getForm threw)
07:00:11  synthetic redo (dean)
07:00:12  machine_report → "RESPONDING"
07:00:13  machine_report → "ERROR"      … and so on, indefinitely
```

Note `md` here is **non-empty but startTime-less** — a `pass_thread_control`
handover wrote `e_handover_metadata` into `md` without going through
`getMetadata()`. Any fix must handle "md present but incomplete", not just
"md empty".

---

## 3. Why the loop never ends

Dean's `Errored` query (`dean/queries.go:121-133`) re-emits a synthetic `redo`
for any state matching:

```sql
current_state = 'ERROR' AND
error_tag = ANY($1) AND                                   -- DEAN_ERROR_TAGS
updated + ($2)::INTERVAL > $4 AND                         -- DEAN_ERROR_INTERVAL
($4 > next_retry OR next_retry IS NULL) AND
(state_json->'retries' IS NULL OR JSON_ARRAY_LENGTH(state_json->'retries') < $3)
```

Production config (`devops/values/production.yaml:159-172`):

- `DEAN_ERROR_TAGS = "NETWORK,INTERNAL,STATE_ACTIONS"` → **`INTERNAL` is retryable.**
- `DEAN_ERROR_INTERVAL = "48 hours"`
- `DEAN_RETRY_MAX_ATTEMPTS = "60"`

Both nominal bounds fail to bind:

- **The 48h window slides.** Each redo rewrites `updated`, so
  `updated + '48 hours' > now()` stays true forever. The window can never expire
  on a state Dean is actively re-warming — it only bounds states Dean has
  *stopped* touching.
- **60 attempts is effectively unreachable.** The `next_retry` computed column
  is `power(2, LEAST(array_length(retries), 16)) * 60000 + last_retry`, so the
  backoff caps at 2^16 min ≈ **45.5 days** per attempt. Reaching 60 retries takes
  roughly 45 days for the first 16, then ~44 × 45.5 days ≈ **5.5 years**.

So the state retries roughly forever, and because `INTERNAL` is a *paging* tag
(§4) it keeps a permanent floor under the platform alert.

> Note: `documentation/platform-abstraction-hardening.md` §7 says
> `DEAN_RETRY_MAX_ATTEMPTS` is 30. Production is **60**. Correct the doc.

---

## 4. The tag is the operationally expensive part

Per `documentation/study-error-alerting.md`, `error_tag ∈ {INTERNAL,
STATE_ACTIONS, NETWORK}` maps to `error.platform` — "platform bugs … Rare,
always actionable → **page**". The `platforminternalerrors` alert fires at
`sum(survey_error_states{error_tag=~"INTERNAL|STATE_ACTIONS|NETWORK"}) >= 5`
for 10m.

At the time of investigation that sum sat at **3** — a standing floor made
almost entirely of these stuck states, two thirds of the way to paging someone
about a user who sent a sticker to the wrong page in 2022. It is exactly the
failure mode the taxonomy section warns about: *"a study-authoring mistake must
be given a tag, or it pages the platform on-call with a runbook that leads
nowhere."*

Whatever the fix, **this must stop being `INTERNAL`.**

---

## 5. Design question to settle before coding

The WhatsApp path already has the intended semantics.
`documentation/platform-abstraction.md` § "Non-Entry: Plain Text Not Matching
Pattern":

> Inbound text without a referral object that does NOT match the form-ref
> pattern … normalizes as `event_type: 'user_text'`. Machine's TEXT handler
> finds no active conversation and **ignores (no-op)**. User receives no reply.

Messenger, for the same situation, produces a `RESPOND` output and then dies in
`getForm`. **The two platforms disagree about what "message with no
conversation" means.** Settle that first; the fix follows from the answer.

Options, roughly in order of preference:

- **(a) No-op at `exec`.** If there is no active form, categorize as a no-op and
  never reach `actionsResponses`. Matches WhatsApp, kills shape A at the root,
  and needs no new error tag. Check what this does to the `FALLBACK_FORM` / 305
  path first (`getMetadata()` line 92 defaults `md.form` to
  `process.env.FALLBACK_FORM`) — 305 is a deliberate catch-all and must keep
  working. See `planning/305-default-form-findings.md`.
- **(b) Fail fast with a non-paging tag.** Keep erroring, but classify it as a
  study/user-level condition so it never pages and Dean never retries it. Cheaper
  but leaves users in a dead `ERROR` state.
- **(c) Repair the state.** If `md.startTime` is recoverable (e.g. from
  `form_start_time`, the `pointer`, or the first `qa` entry), backfill it and
  continue. Most complex; only worth it if shape B turns out to be common and
  the conversations are genuinely resumable.

Whichever is chosen, also decide whether `INTERNAL` should stay in
`DEAN_ERROR_TAGS`, and fix the `if (!newState.md)` guard to test for the fields
it actually needs rather than for the object's existence.

---

## 6. Suggested sequence

1. **Reproduce** both shapes in `machine.test.js` (§0). Failing tests first.
2. **Trace shape B's origin** — how does `md` end up empty/incomplete on a
   conversation that has `forms` entries? This is the open question; the answer
   may change the design.
3. **Settle §5** with the user before implementing.
4. **Implement**, keeping the fix in the pure core (`exec`/`apply`) if at all
   possible rather than in the IO shell.
5. **Fix the guard and the tag** — `if (!newState.md)` → check `startTime`/
   `shortcode` explicitly; stop laundering a precondition failure through
   `iowrap(..., 'INTERNAL', ...)`.
6. **Decide the Dean policy** — should the new tag be retryable at all?
7. **Backfill/decide on the 2,196 existing states.** They will keep retrying
   until something clears them. A migration or a one-off sweep is likely needed;
   confirm with the user before writing to prod.
8. **Verify** the `platforminternalerrors` floor drops, and update
   `documentation/study-error-alerting.md` (taxonomy),
   `documentation/error-events.md`, and
   `documentation/platform-abstraction-hardening.md` (the stale
   `DEAN_RETRY_MAX_ATTEMPTS = 30`).

---

## 7. Observability caveat for whoever picks this up

Diagnosing this from the database is harder than it should be, and will stay
that way until the `errors` projection lands:

- **Migration `23-states-errored-at.sql` is NOT applied in prod** — there is no
  `errored_at` column. Age errors by `state_json->'error'->>'ts'` instead, and
  note that `updated` is useless for onset because Dean re-warms it.
- **The thin-error change dropped `stack` from `states.error`.** Post-cutover
  rows carry only `{tag, code, message, ts}`, so the `getForm` argument triple —
  the single most diagnostic field, the thing that distinguishes shape A from
  shape B — is no longer in `states` at all. It survives only in `messages`,
  which has no timestamp-only index; recovering it means hand-tracing individual
  users by `userid`. This is `documentation/error-events.md` § "Piece B —
  deferred, not built" biting in practice, and it is a real argument for
  un-deferring it.
