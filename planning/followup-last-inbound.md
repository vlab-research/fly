# Follow-ups: measure from the respondent's last message

Decided 2026-09-22 (Nandan). Status: plan, not started.

## The defect

dean's `FollowUps` (`dean/queries.go:284`) nudges every `QOUT` participant whose
`states.updated` is 12–24 h old. `updated` is the timestamp of the last event
replybot folded for that conversation, of any kind: delivery and read receipts
(`machine.js:447-456`, `WATERMARK`), machine reports, dean's own sweeps, and
events the machine ignores — `transition.js:128-136` republishes the state on
`action: 'NONE'` too. So the 12–24 h band is measured from nothing in
particular, and in particular not from the respondent's last message, which is
what WhatsApp's and Messenger's 24-hour windows count from. Nothing in
`state_json` records that time (`documentation/states-debugging.md` §"State
Object Structure").

Consequences, measured on the LAC Healthy Diets WhatsApp number
(`projects/lac-healthy-diets/whatsapp-spam-2026-09-21.md` §2): 844 follow-ups
to 674 of 1,272 respondents; 118 of them had never answered the consent
question; 127 sends refused by Meta with 131047 "Re-engagement message" and
three respondents `BLOCKED` on it; the same person nudged more than once
because a refused follow-up re-arms the clock without setting
`previous_is_followup`. Meta's spam warnings of 09-11 and 09-19 each followed a
follow-up wave.

## The design

One new fact, and the follow-up rule reads only that fact.

**`lastInbound`.** The timestamp of the respondent's most recent act:
`REFERRAL`, `OPTIN`, `TEXT`, `MEDIA`, `POSTBACK`, `QUICK_REPLY`, `REACTION`
(`categorizeEvent`, `machine.js:196`). Not `WATERMARK` (a receipt for something
we sent), not `ECHO`, not any synthetic event. A referral counts: tapping the ad
is the respondent's act and is what opens the conversation.

**The follow-up rule.** A participant is followed up when all of:

- `current_state = 'QOUT'` and the survey has `label.buttonHint.default`
  (unchanged);
- `last_inbound` is between `DEAN_FOLLOWUP_MIN` and `DEAN_FOLLOWUP_MAX` ago,
  with `MAX` set to **23 hours** so the hourly cron can never land on the
  window's edge;
- `qa` is non-empty: they have answered at least one question, so they opted
  in. A bare ad tap is never nudged;
- `previous_is_followup = FALSE` and `previous_with_token = FALSE`
  (unchanged).

No platform branch. The rule is true on both platforms, and it makes a
follow-up deliverable by construction: 12–23 h after the respondent's last
message is inside every messaging window we use. `states.updated` no longer
appears in the query.

**Missing means never.** A row with no `last_inbound` is not followed up. That
is the retroactive effect: on deploy, every participant currently parked on
every study stops being nudged until they write again. They have all been
nudged already or are stale, and that includes the ~120 unpaid LAC respondents
parked on payment forms.

## What it deliberately leaves alone

- The `NONE` republish. Once follow-ups read `last_inbound`, an ignored event
  moving `updated` is harmless to them, and `updated` has other readers
  (`Respondings`, the dashboard health window).
- One person on two business numbers is two rows and can get two nudges. On
  WhatsApp the id scheme makes that inherent.
- A respondent who answers a nudge and stalls on the next question gets a nudge
  for that question too. `previous_is_followup` clears on `RESPOND`, which is
  the existing per-question semantics, and it is right.
- The nudge copy and the two-message shape (nudge + repeated question,
  `machine.js:1015`, `_gatherResponses`). Out of scope.

## Implementation

### replybot

`exec` and `apply` stay pure and untouched. The fact is stamped where they
meet, so it is also rebuilt correctly on a replay:

- `machine.js`: `isInbound(event)` over `categorizeEvent`, and
  `step(state, event) = stamp(apply(state, exec(state, event)), event)` that
  sets `lastInbound: event.timestamp` when the event is inbound. `getState`'s
  reduce (`machine.js:1050`) and `transition.js:38-39` call `step`.
- `SWITCH_FORM`, `RESET`, `RESPOND_AND_RESET` and `RESTORE_STATE` rebuild the
  state from `_initialState()` (`machine.js:726-761`). `lastInbound` must
  survive all four: a stitch into the payment form must not make the
  respondent look like they never wrote. Carry it the way `pointer` is carried
  (`machine.js:760`).
- `documentation/states-debugging.md`: add the field to the table.
- Tests: `replybot/lib/typewheels/machine.test.js` (or wherever `apply`/
  `getState` are tested): each inbound category stamps it, receipts and
  synthetics do not, it survives a form switch and a reset, and a replayed log
  reproduces it.

### schema

New `devops/migrations/33-states-last-inbound.sql`, same shape as
`04-pointers.sql`:

    ALTER TABLE chatroach.states ADD COLUMN IF NOT EXISTS last_inbound TIMESTAMPTZ
      AS (CEILING((state_json->>'lastInbound')::INT/1000)::INT::TIMESTAMPTZ) STORED;
    CREATE INDEX IF NOT EXISTS states_followup_idx
      ON chatroach.states (current_state, previous_is_followup, previous_with_token, last_inbound)
      STORING (state_json);

The existing index on `(previous_with_token, previous_is_followup,
form_start_time, current_state, updated)` (`01-init.sql:154`) serves the old
query; leave it until nothing reads it. Mirror both statements in
`devops/all.sql`. Adding a stored column rewrites the table: check the
migration runbook for how the last one of these was applied to vprod and how
long it took.

### dean

- `FollowUps`: `(NOW() - last_inbound) > $1 AND (NOW() - last_inbound) < $2`
  in place of the two `updated` predicates, plus
  `jsonb_array_length(state_json->'qa') > 0` (check the column's JSON type;
  `state_json` is `JSON`, so it may need `::JSONB`).
- `devops/values/production.yaml:457` and `staging.yaml:251`:
  `DEAN_FOLLOWUP_MAX: "23 hours"`.
- `dean/queries_test.go`: extend
  `TestFollowUpsGetsOnlyThoseBetweenMinAndMaxAndIgnoresAllSortsOfThings`
  (`:660`) — `makeStateJson` (`:41`) hardcodes the shape, so write the rows
  inline: in-band `last_inbound` with answers → selected; in-band with empty
  `qa` → not; `updated` in band but `last_inbound` absent → not; `last_inbound`
  absent entirely → not; a `whatsapp_business` credential row so the platform
  path is covered.
- `facebot/testrunner/test.tc.ts:973` ("Sends follow ups when the user does not
  respond") keeps passing: the respondent there has answered, so `qa` is
  non-empty; check the fixture's `DEAN_FOLLOWUP_*` values against the new band.
- `dean/README.md` and `planning/qout-and-state-machine-findings.md` §"Dean
  (Follow-Up Service)" describe the query; rewrite the follow-up paragraph to
  the new rule. Delete the annotation there that reads
  `(NOW() - updated) > $1` as "min elapsed since question was sent".

### rollout

replybot first (it only adds a field), then the migration, then dean with the
new query and `MAX`. Between the migration and the dean deploy nothing changes.
After the dean deploy, the first `followups` run should select only
participants whose last message was 12–23 h ago and who have answered
something; verify with the query against vprod before enabling and count the
131047 refusals over the following day (they should be zero).

## Not in this change

- An account-level breaker on new conversations per hour, for viral links
  (`planning/whatsapp-spam-flag-2026-09-11.md` action 6).
- Whether follow-ups should be sent as templates outside the window. Outside
  the window the answer is silence.
