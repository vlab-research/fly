# Waits and timeouts

> How a conversation parks on a `wait`, how a timeout gets scheduled, and how the
> timeout comes back and ends the wait.
>
> **Components:** `replybot` (parks the conversation and decides when a wait is
> satisfied), `scribble` (writes the state row), CockroachDB (`states.timeout_date`,
> a stored computed column), `dean` (sweeps for matured timeouts and emits
> `timeout` events), `hermes` (`/synthetic`, carries them back into Kafka).
>
> **Related:** `documentation/questions.md` ("Wait - Timeout", tracked links,
> videos) for the researcher-facing syntax; `dean/README.md` for the sweep;
> `replybot/lib/typewheels/waiting.js` for the matcher;
> `devops/migrations/34-states-timeout-date-compound-wait.sql` for the column;
> `planning/vir-28-compound-wait-timeout.md` for the fix that added compound support.

---

## 1. The loop

1. replybot sends a field whose metadata carries `wait`. The conversation enters
   `WAIT_EXTERNAL_EVENT` with `state.wait` (the condition) and `state.waitStart`
   (the echo timestamp, epoch ms).
2. scribble writes the state row. CockroachDB computes `timeout_date` from
   `state_json->'wait'` and `waitStart` on every write.
3. dean's `Timeouts` query selects rows in `WAIT_EXTERNAL_EVENT` whose timeout
   has matured (`calculated_timeout_date < now` and within
   `DEAN_TIMEOUT_MAX_PAST`), and POSTs `{"type": "timeout", "value": <waitStart>}`
   to hermes for each.
4. replybot folds the event into `externalEvents` and calls
   `waitConditionFulfilled(state.wait, externalEvents, state.waitStart)`. A
   `timeout` leaf is satisfied by any timeout event whose value equals
   `waitStart`. That is how a stale timeout from an earlier wait is ignored.
5. Satisfied: replybot clears the wait and moves to the next question. Not yet
   satisfied (an `and` still missing an arm): it records the event and keeps
   waiting, sending nothing.

**Dean is the only producer of `timeout` events.** If step 2 computes NULL, and no
survey setting supplies a date (§4), nothing ever ends the wait except the
other arms of a compound.

## 2. What `timeout_date` schedules

| `wait` shape | `timeout_date` |
|---|---|
| `{"type": "timeout", "value": "<interval>"}` | `waitStart` (rounded up to the second) + interval |
| `{"type": "timeout", "value": {"type": "relative", "timeout": "<interval>"}}` | same |
| `{"type": "timeout", "value": {"type": "absolute", "timeout": "<timestamp>"}}` | the timestamp, via `parse_timestamp` |
| `{"op": "or", "vars": [...]}` | the **earliest** schedulable timeout arm |
| `{"op": "and", "vars": [...]}` | the **latest** schedulable timeout arm |
| anything else (`external`, `handover`, a `variable` timeout, no timeout arm) | NULL |

**Why `or` takes the earliest and `and` the latest.** `or` ends at whichever
arm is satisfied first, so the first timeout to mature is the one that matters.
In `and` every arm must be satisfied. One dean event satisfies **every** timeout
arm at once, because each leaf only checks `value == waitStart`, so firing at an
earlier arm would satisfy a longer one early. If the non-timeout arm has not
arrived when the timeout fires, the recorded event keeps the timeout arm
satisfied until the rest arrives.

**Limits of the compound form.** A computed column cannot loop over a JSON
array or call a user-defined function (CockroachDB v24.1), so:

- only the first four arms (`vars[0]` to `vars[3]`) are read;
- a compound nested inside a compound is not scheduled;
- an **absolute** timeout arm inside a compound is not scheduled. `parse_timestamp`
  raises an error on a bad string, and an error in a computed column fails the whole
  write. The states sink treats a failed write as fatal, so one malformed survey
  would take the sink down. A top-level absolute timeout is scheduled.

## 3. Interval syntax

An interval is one to three `<number> <unit>` parts. Case is ignored, spaces
are optional, and the number may have a decimal point:

- `20 minutes`, `2 days`, `1 week`
- `90 mins`, `1.5 hours`, `1h30m`, `1 day 2 hours`

Units: `s`/`sec(s)`/`second(s)`, `m`/`min(s)`/`minute(s)`, `h`/`hr(s)`/`hour(s)`,
`d`/`day(s)`, `w`/`week(s)`, `mon(s)`/`month(s)`, `y`/`yr(s)`/`year(s)`. Note that
`m` means minutes. For months, write `mon` or `month`.

Anything else computes NULL and **never times out**: a missing unit (`90`),
an unknown unit (`2 fortnights`), four or more parts, words like `and` or
commas between parts. The number is capped at 6 digits, or 4 for years.
Larger values would overflow a timestamp, which errors instead of computing
NULL.

## 4. Named timeouts from survey settings

A timeout can name a survey setting instead of carrying a value:
`{"type": "timeout", "value": {"type": "relative", "variable": "reminder"}}`.
`timeout_date` is NULL for these. dean computes the date itself by joining
`survey_settings.timeouts` on `name = state_json->'wait'->'value'->>'variable'`
(see `documentation/agent-api.md` § `timeouts`). That join reads only the top
level of the wait, so **a named timeout inside a compound is never scheduled**.

## 5. Operational notes

- **Without a blacklist, one timeout per run.** With `DEAN_TIMEOUT_BLACKLIST`
  empty, `Timeouts` appends `ORDER BY calculated_timeout_date DESC LIMIT 1` and
  fires only the most recently matured timeout per run. Production sets a
  blacklist, which takes the unlimited branch. Test fixtures set a dummy
  blacklist to get every row.
- **Retries are capped per wait.** dean counts the `timeout` events already in
  `externalEvents` whose value is this `waitStart`, and stops at
  `DEAN_TIMEOUT_MAX_ATTEMPTS`. An `and` wait still missing its event arm is
  re-fired on each run until the cap, and replybot sends nothing each time.
- **`timeout_date` IS NULL on a waiting row** means one of: no timeout arm, a
  named timeout (§4), or a value outside the syntax in §3. Check
  `state_json->'wait'`.
