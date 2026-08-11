# Investigation: why does Dean's `timeouts` cron retry the same user?

## Status

Investigation brief — not a fix plan. Hand to an agent for extensive exploration before designing a fix.

## Context

Dean's `timeouts` cron (`dean/queries.go:159-208`) fires every 10 minutes. Filter: users in `current_state='WAIT_EXTERNAL_EVENT'` whose computed timeout date is in the past but within the last 72 hours. Production has `DEAN_TIMEOUT_BLACKLIST` set, which bypasses the `LIMIT 1` per-run safety in the no-blacklist branch — so all eligible users get fired every 10 minutes.

Real-world evidence of unbounded retry:
- User `25318135341171312`: 3,693 externalEvents, top one is type `timeout`. State_json size 604 KB.
- User `28450029531308165`: 2,686 externalEvents.
- The system as a whole: 13 users with >1000 externalEvents, 30 with >500.

The `payments` cron has a clearly understood retry mechanism (each `repeat_payment` triggers a new `MAKE_PAYMENT`, resets `waitStart`, restarts the 14d window). Timeouts don't have an obvious analogous re-entry mechanism — yet users accumulate thousands of timeout events. Something keeps them eligible.

## What we already know

### The query (verbatim)

```sql
with unrolled_settings as (
  SELECT surveyid,
         json_array_elements(timeouts)->>'name' AS name,
         json_array_elements(timeouts)->>'type' AS type,
         json_array_elements(timeouts)->>'value' AS value
  FROM survey_settings
  WHERE timeouts IS NOT NULL
    AND json_typeof(timeouts) = 'array'
),
timeout_dates as (
  SELECT s.userid, s.pageid, s.current_form,
    (state_json->>'waitStart')::int as waitStart,
    CASE
      WHEN s.timeout_date IS NOT NULL THEN s.timeout_date
      WHEN settings.type = 'relative' THEN waitStart + interval
      WHEN settings.type = 'absolute' THEN parse_timestamp(value)
    END as calculated_timeout_date
  FROM states s
  LEFT JOIN surveys surv ON surv.shortcode = s.current_form
  LEFT JOIN unrolled_settings settings
    ON settings.surveyid = surv.id
    AND settings.name = s.state_json->'wait'->'value'->>'variable'
  WHERE
    surv.created <= s.form_start_time AND
    current_state = 'WAIT_EXTERNAL_EVENT'
)
SELECT waitStart, userid, pageid
FROM timeout_dates
WHERE
  calculated_timeout_date < $1 AND
  calculated_timeout_date > $1 - ($2)::INTERVAL  -- TimeoutMaxPast (72h in prod)
```

### State machine handling (partial)

`_handleExternalEvent` (`replybot/lib/typewheels/machine.js:121-160`):
- If `state.state !== 'WAIT_EXTERNAL_EVENT'`: append externalEvent and return UPDATE_STATE (user stays put).
- Else compute `fulfilled = waitConditionFulfilled(state.wait, externalEvents, state.waitStart)`.
- If not fulfilled: stay in WAIT_EXTERNAL_EVENT, append.
- If fulfilled: clear `wait` and `waitStart`, transition to RESPOND.

`waitConditionFulfilled` lives in `replybot/lib/typewheels/waiting.js:76`. From earlier exploration: for `payment:reloadly` events it requires `success: true` in the event matching the wait condition.

### Two hypotheses we have not confirmed

**H1: Wait-type mismatch.** The user's current `state.wait` is type `payment` (waiting for Reloadly), but the survey ALSO has a survey-level `timeouts` config. Dean's query joins on `settings.name = state_json->'wait'->'value'->>'variable'` — does a payment wait have a `value.variable` field? If yes, and if it matches a timeouts setting name, the query computes a `calculated_timeout_date` for that user. Dean fires a `timeout` event into a payment-waiting state. `waitConditionFulfilled` doesn't match. User stays. Loop.

**H2: State-machine bug or chained waits.** The wait IS type `timeout`, the timeout matches the wait, but processing doesn't actually transition out — either due to a bug in `waitConditionFulfilled`, or the user's state machine immediately re-enters another `WAIT_EXTERNAL_EVENT` for the next survey step which is also past timeout.

## What needs to be answered

1. **Read `replybot/lib/typewheels/waiting.js` end-to-end.** What event types does `waitConditionFulfilled` handle? For each wait type (payment, timeout, others?) what conditions match and what don't? Specifically: can a `timeout` external event ever fulfill a `payment` wait, or vice versa? Quote line numbers.

2. **Read the survey_settings.timeouts schema.** What does a `timeouts` array entry look like? It has `name`, `type` (relative/absolute), `value`. How does `name` map to a user's `state.wait.value.variable`? Find example data — query a small number of survey_settings rows via the postgres MCP (single targeted query, NOT a full scan).

3. **For one of the affected users (e.g., `25318135341171312`)**: read their `state_json->'wait'` to see the actual wait shape. What's the wait type? What's `value.variable`? Does that variable name appear in any timeouts setting for their `current_form`? Use the postgres MCP, single targeted query per user.

4. **Sample a few of their externalEvents**: are they ALL `timeout` type, or mixed with `payment:reloadly`? `state_json->'externalEvents'->0`, `->100`, `->1000`, `->-1`. Do not pull the full array.

5. **Trace the state machine path for a `timeout` event arriving at a user in `WAIT_EXTERNAL_EVENT` of various wait types.** Use `replybot/lib/typewheels/machine.test.js` to find existing tests; if there's a test for "timeout event arrives during payment wait" or similar, that's gold. If not, manually trace `categorizeEvent → exec → _handleExternalEvent → waitConditionFulfilled` for a hypothetical timeout event arriving at each wait type.

6. **Look for any code path that re-enters `WAIT_EXTERNAL_EVENT` after a timeout fulfills.** When a timeout DOES match its wait, what's the next state? Could the next state be another `WAIT_EXTERNAL_EVENT` whose `waitStart` is also already past timeout (e.g., a chained survey of waits)?

7. **Check `s.timeout_date` column behavior.** When is it set? When is it cleared? If a user transitions out of `WAIT_EXTERNAL_EVENT` and back in, does `timeout_date` get updated, stale, or null? The query prefers `s.timeout_date` over the computed date when set, so stale values would matter.

8. **Look at the `DEAN_TIMEOUT_BLACKLIST` value in production**. Which survey shortcodes are blacklisted, and why? Are the affected users in those surveys or different ones? `devops/values/production.yaml:193-194` — `bebborsbaseserb,bebbobg2basebul,nciaim2followup2pay,nciaim2followup1pay,nciaim2baselinepay`. Note "pay" suffixes — these are payment-related surveys. Suggests blacklist was added because timeouts were misbehaving in those specific cases.

## Hard rules for the agent

- **Read-only** for source code and DB. No code changes, no DB writes.
- Postgres MCP queries must be **single-user point lookups** or small targeted reads. Prior aggregate scans across `chatroach.public.messages` took 45+ minutes. The `states` table is per-user-row and small enough to query directly. **Do not** scan all rows or aggregate across the population — that's not needed for this investigation.
- Prefer `SELECT state_json->'wait'` and `state_json->'externalEvents'->N` over fetching whole `state_json` (already known to be 600+ KB for affected users).
- Read project docs first: `documentation/` (any wait/timeout/payment-related), `replybot/README.md`, `dean/README.md` if it exists. Note doc gaps but do NOT update docs in this pass.

## Deliverable

Write findings to `planning/dean-timeouts-retry-findings.md`:

1. **Confirmed root cause** for the timeout retry loop. Be specific: "X event arrives at Y wait type, `waitConditionFulfilled` returns Z because [code reference], so user stays in `WAIT_EXTERNAL_EVENT` and Dean re-fires."
2. **Whether H1, H2, or some third hypothesis is correct.** Evidence from code AND from at least one real affected user's state.
3. **Recommended fix** (specific to root cause, not just a generic cap):
   - If H1: filter Dean's `timeouts` query by `state_json->'wait'->>'type' = 'timeout'`, mirroring how `Payments()` excludes timeouts.
   - If H2: fix the state machine.
   - If something else: describe.
4. **Whether the cap-at-5 in `dean-payments-timeouts-retry-caps.md` is still needed** as a backstop after the root-cause fix.
5. **What the `DEAN_TIMEOUT_BLACKLIST` was likely added to work around**, based on the survey shortcodes in it vs the affected users.

Length: under 800 words. File paths and line numbers required for every claim.

## Followup if findings reveal more

If the investigation surfaces unrelated bugs (e.g., `s.timeout_date` not getting cleared, survey_settings schema issues, etc.), add them as new entries to `planning/replybot-oom-bug-catalog.md` (B-series IDs continuing from B18).
