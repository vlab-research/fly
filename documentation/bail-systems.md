# Bail Systems

## Table of Contents

1. [Overview](#overview)
2. [User-Facing Behavior](#user-facing-behavior)
3. [Bail Types](#bail-types)
4. [Bail Definition Model](#bail-definition-model)
5. [Access Control](#access-control)
6. [Component Responsibilities](#component-responsibilities)
7. [Execution Model](#execution-model)
8. [Event Audit Trail](#event-audit-trail)
9. [API Endpoints Reference](#api-endpoints-reference)
10. [Data Transformation](#data-transformation)
11. [Frontend-Backend Mapping](#frontend-backend-mapping)
12. [Configuration](#configuration)

---

## Overview

Bail systems are automated rules that redirect survey respondents from one form to another based on configurable conditions. They replace the previous approach of hand-written Kubernetes CronJob manifests (`bailer-job/kube/`) with a database-driven, UI-manageable system.

Common use cases:

- **Timeout recovery**: Move users stuck in `WAIT_EXTERNAL_EVENT` for more than N weeks to an intermediate form
- **Error recovery**: Redirect users in `BLOCKED` state with specific error codes back to retry
- **End of study**: Move all users on a form to an exit survey at a specific date/time
- **Stuck question recovery**: Bail users stuck at a particular question
- **Direct targeting**: Send a specific list of users to specific destination forms (user list bails)

A bail is owned by a user (not a survey) and can query across any forms that user owns. Conditions such as `question_response` and `elapsed_time` scope their queries to specific form shortcodes, enabling cross-survey bail rules — for example, bailing users from any of several survey forms into a single exit survey.

## User-Facing Behavior

### Bail List

The dashboard shows a table of all bail systems for the authenticated user at `/bails`. Each row displays:

- Name (links to edit form)
- Enabled toggle (can enable/disable inline)
- Timing mode (color-coded tag: green=immediate, blue=scheduled, orange=absolute)
- Destination form shortcode
- Last execution timestamp and user counts
- Action buttons: edit, view event history, delete (with confirmation)

### Creating a Bail

The create form (`/bails/create`) has four sections:

1. **Basic Information** -- name, description, enabled toggle
2. **Definition** -- either a visual condition builder (for conditions-type bails) or a user list (for user_list-type bails). Conditions support AND/OR/NOT logic trees with condition types: form, state, error_code, current_question, elapsed_time, question_response (with a mode toggle for "is answered" vs "equals specific response"), surveyid
3. **Execution Timing** -- choose immediate, scheduled (daily at a time + timezone), or absolute (one-time at a datetime)
4. **Action** -- destination form shortcode and optional JSON metadata (conditions-type bails only)

A **Preview** button performs a dry-run query showing how many users currently match the conditions and a sample of their IDs. For conditions-based bails, the generated SQL and parameters are also returned. For user list bails it is also the account check: a preview of a list naming an account this user has not connected comes back as an error naming each bad `pageid`, which is the cheapest way to check a CSV before saving anything.

### Event History

Each bail has an event history view (`/bails/:bailId/events`) showing a table of past executions with timestamp, event type (execution or error), users matched, users bailed, and error details if any.

---

## Bail Types

A `BailDefinition` has a `type` field that determines how target users are identified:

| Type | Description |
|------|-------------|
| `"conditions"` | (default) Builds a SQL query from a condition tree. All bails created before `type` was introduced are implicitly `"conditions"`. |
| `"user_list"` | Targets a fixed, explicitly enumerated list of users. No condition query is built, but the listed accounts are still resolved against the owner's credentials. |

### Conditions Type

The default type. Uses a recursive condition tree to build a SQL query against the `states` and `responses` tables. The `action.destination_form` field is required and specifies where all matched users are sent.

#### The query only matches the owner's own accounts

The generated query joins `credentials` on `c.key = s.pageid`, restricted to the messaging
entities and to `c.userid = <the bail's owner>`, and reads the platform out of `c.entity` in
the same pass (`facebook_page` → `messenger`, `whatsapp_business` → `whatsapp`). The join is
INNER, which does two things at once:

- **It resolves the platform.** Every matched row arrives with a real transport, from the
  same account→transport map the token lookup uses. `states.platform` is not consulted; it is
  NULL for the great majority of rows, and NULL again for a blocked conversation whose `md`
  was erased, which is exactly the population a recovery bail targets.
- **It scopes the bail to its owner.** Conditions match on *shortcodes*, and a shortcode is
  not unique across researchers. Without the join, a bail naming `survey_common` matched
  every `states` row on that shortcode, including another researcher's participants on
  another researcher's accounts — a mis-target and a cross-tenant leak in one. With it, an
  account the owner has not connected cannot appear in the result at all.

There is no skip list for conditions bails. An unresolvable platform on a row the INNER JOIN
returned would mean the query and the executor disagree, which is a defect in the binary
rather than a property of one participant, so the executor fails the **whole** bail loudly
instead of quietly reaching fewer people. Skips exist only for user lists, where the owner
named the accounts explicitly and deserves to be told which ones did not work.

The same consequence applies as for user lists, from the other direction: **disconnecting an
account stops its participants matching.** They are not bailed onto an account that can no
longer send.

Before deploying a change to this join, `planning/vir-60-predeploy-check.sql` (read-only)
reports, per enabled bail, which `(bail, pageid)` populations the owner-scoped join excludes
and whether each excluded account is owned by someone else or by nobody.

### User List Type

Targets a fixed list of up to 1000 users. Each entry specifies the user, their account
(`pageid`), and their **individual destination form** (`shortcode`). This allows sending
different users to different forms in a single bail.

`action.destination_form` is not used for `user_list` bails — the destination is per-user in the list.

```json
{
  "type": "user_list",
  "user_list": {
    "users": [
      { "userid": "user1", "pageid": "page1", "shortcode": "survey_a" },
      { "userid": "user2", "pageid": "page2", "shortcode": "survey_b" }
    ]
  },
  "execution": { "timing": "absolute", "datetime": "2026-09-20T14:00:00", "timezone": "UTC" },
  "action": {}
}
```

**Validation rules:**
- `users` array must have 1–1000 entries
- Each entry must have non-empty `userid`, `pageid`, and `shortcode`
- Every `pageid` must name a messaging account the bail's owner has connected — see below
- `action` is present in the JSON but `destination_form` is not validated (ignored)

#### The platform comes from the account, not from the entry

A conversation is `(platform, account_id, user_id)` and an entry names only the last two.
The first is read from the account. `chatroach.credentials` holds one row per connected
account: `key` is the account id (`pageid` here), `userid` is the researcher who connected
it, and `entity` is what it sends on — `facebook_page` → `messenger`, `whatsapp_business` →
`whatsapp`. Migration 20 (`devops/migrations/20-messaging-account-unique.sql`) puts a UNIQUE
index on `key` restricted to those two entities, so an account id matches at most one
credential in the whole database: one owner, one entity, one platform. There is nothing to
reconcile, because there is only ever one answer.

`credentials.userid` and `bails.user_id` are both `chatroach.users(id)`, so "owned by this
bail's owner" is a single equality.

**An account the caller has not connected is rejected when the bail is written.** Create,
update and preview each resolve every `pageid` in the list, and answer `400 invalid_pageids`
if any of them has no messaging credential owned by the caller. The message names every
offender, not only the first:

```json
{
  "error": "invalid_pageids",
  "message": "no messaging account owned by this user for pageids: p_gone, p_theirs (each pageid must be a connected facebook_page or whatsapp_business account)"
}
```

Rejecting at write time is the difference between an error a researcher can act on and a
batch that quietly reaches fewer people than it lists.

**Targets that no longer resolve are skipped when the bail runs.** The same resolution runs
again at execution, because a credential can be deleted or transferred between saving a bail
and firing it. An unresolvable target is not sent; it is recorded in the execution event's
`execution_results` under `skipped`, with a reason:

| Reason | Meaning |
|--------|---------|
| `credential_not_found` | no messaging credential exists for that `pageid` at all |
| `credential_not_owned` | the account exists, but belongs to another researcher |
| `credential_not_messaging` | the credential's entity maps to no transport. The lookup already filters on the two messaging entities, so this one should be unreachable; it exists so that a filter and a mapping that drift apart produce a recorded skip instead of an empty platform on the wire |

```json
{
  "user_ids": ["u1", "u2"],
  "skipped": [{ "userid": "u3", "pageid": "p_gone", "reason": "credential_not_found" }]
}
```

`users_matched` counts resolved targets only: a bail listing 100 users of which 97 resolve
records `users_matched: 97` and three `skipped` entries. A run in which *every* target was
skipped still records an execution event, with `"user_ids": []` — without one, a bail that
reached nobody would show nothing at all in its history, which is indistinguishable from a
bail that never ran.

The consequence worth planning around: **disconnecting an account takes its participants out
of the bail.** They are skipped, and visible as skipped in the event, rather than bailed on
an account that can no longer send them anything.

**A `platform` inside a stored definition is ignored, not rejected.** `UserListEntry`
declares `userid`, `pageid` and `shortcode`, and Go's JSON decoder drops fields a struct does
not declare. A definition that carries a `platform` — written before the field went away, or
sent today by a hand-rolled client — still loads, the value is read as nothing at all, and
the credential decides. There is no migration and no schema change: stored definitions keep
whatever they contain, and what they contain has no effect.

Nothing in the product offers the field. dashboard-client's CSV upload takes exactly three
columns (`userid,pageid,shortcode`) and its error message says the platform is resolved from
the account; the MCP `create_bail` schema is `additionalProperties: false` over the same
three. The REST proxy forwards `definition` untouched, so a hand-written POST can still carry
one, to no effect.

#### Why an un-named bailout is never sent

`SendBailout` refuses a target whose platform is neither `messenger` nor `whatsapp`
(`exodus/sender/sender.go`), and both bail types resolve one before the sender is reached —
conditions bails in the query, user lists from the credential map. Exodus cannot emit a
bailout carrying an empty platform. What such an event costs is still worth recording,
because the failure is a property of the receiving path and any *other* un-named event still
triggers it.

On WhatsApp it fails outright. Replybot's `eventPlatform` finds no platform on the event and
falls back to `messenger` (`replybot/lib/typewheels/utils.js`, logged as
`EVENT_PLATFORM_GUESSED`); the outbound command goes to the Messenger client, which looks up
a `facebook_page` token for an account that has only a `whatsapp_business` one and fails with
`token not found for platform account` (`message-worker/tokenstore.go`). The conversation
lands in `ERROR` / `STATE_ACTIONS` and the participant receives nothing.
`documentation/platform-resolution.md` describes this failure shape in full.

**An empty platform is not safe on Messenger either**, which is the half that is easy to
miss. The `messenger` fallback picks the right client, so the first message of the
destination form is sent — but the event itself still carries `"platform": ""`, which puts it
on replybot's degraded path
(`documentation/states-debugging.md`, "The degraded path"): the state cache is neither read
nor **written**. The post-bail state therefore exists only in the machine report. The next
event is the echo of the message just sent, ~1–2 s later; it *is* fully named, misses the
cache, and replays from `chatroach.messages`. Scribble flushes that archive on a ~2 s poll,
so if the echo is processed before the bailout row lands, the replay reconstructs the
**pre-bail** state, the echo is applied to it, and that state is cached and written to
`states`. The participant has received the destination form's first question, but the
platform believes they are still on the previous form:

- `states.current_form` and `state_json.forms` never show the destination form (the
  monitoring tab shows the previous form);
- their reply is handled by the **previous** form. If that form has a field with the same
  `ref`, its logic jumps and stitches run (the participant is routed somewhere the bail never
  intended); if not, the conversation goes to `ERROR` / `FIELD_NOT_FOUND`.

It is a race on send latency, so it is not systematic: on 2026-08-27 the echo took >4 s and
672 of 672 participants kept the bail; on 2026-09-18 it took ~1.7 s and 463 of 587 lost it.
Detector — participants of a user list bail whose state never recorded the destination:

```sql
WITH l AS (
  SELECT u->>'userid' userid, u->>'pageid' pageid, u->>'shortcode' sc
  FROM chatroach.bails, jsonb_array_elements(definition->'user_list'->'users') u
  WHERE id = '<bail_id>')
SELECT (s.state_json->'forms') ? l.sc AS bail_form_in_state, count(*)
FROM l LEFT JOIN chatroach.states s ON s.userid = l.userid AND s.pageid = l.pageid
GROUP BY 1;
```

The detector reads only `userid`, `pageid` and `shortcode` out of the definition, so it works
against any user list bail whatever its entries carry. The race itself belongs to the
degraded path rather than to bails: it applies to any event that reaches replybot without a
platform, from any producer.

**Preview behavior:** Returns the user list directly without executing a query, after the
same `invalid_pageids` check create and update apply — a preview is the cheapest way to find
out that a pageid in a CSV is not one of yours. `sql` and `params` are empty in the preview
response.

---

## Bail Definition Model

A bail definition is a JSON object with the following top-level structure:

```json
{
  "type": "conditions",
  "conditions": { ... },
  "execution": { ... },
  "action": { ... }
}
```

Or for user list bails:

```json
{
  "type": "user_list",
  "user_list": { "users": [...] },
  "execution": { ... },
  "action": {}
}
```

The `type` field defaults to `"conditions"` when omitted.

### Conditions

Conditions define **who** gets bailed. They form a recursive tree supporting AND/OR/NOT logic.

**Simple condition types:**

| Type | Matches on | Example |
|------|-----------|---------|
| `form` | `states.current_form` | `{"type": "form", "value": "mysurvey"}` |
| `state` | `states.current_state` | `{"type": "state", "value": "WAIT_EXTERNAL_EVENT"}` |
| `error_code` | `states.state_json->'error'->>'code'` | `{"type": "error_code", "value": "10"}` |
| `current_question` | `states.state_json->>'question'` | `{"type": "current_question", "value": "hello_again"}` |
| `elapsed_time` | Time since a response event (scoped to a shortcode) | See below |
| `question_response` | `responses` table (shortcode + question_ref + optional response) | See below |
| `surveyid` | `states.current_form` (via subquery into `surveys.id`) | `{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}` |

**Elapsed time** is the most complex condition. It references a specific response event (identified by form shortcode and question ref) and checks if enough time has passed since that response:

```json
{
  "type": "elapsed_time",
  "since": {
    "event": "response",
    "details": { "question_ref": "thankyou", "form": "myform" }
  },
  "duration": "4 weeks"
}
```

The `form` in `since.details` is a form shortcode. Only the `"response"` event type is supported.

Duration uses the format `<number> <unit>` where unit is one of: `microseconds`, `milliseconds`, `seconds`, `minutes`, `hours`, `days`, `weeks`, `months`, `years` (singular or plural). This is passed directly to PostgreSQL as an interval: `$N::INTERVAL`. Examples: `"4 weeks"`, `"2 days"`, `"1 hour"`, `"30 minutes"`. Formats like `"4w"` or `"4 weeks ago"` are rejected.

**Question response** conditions select users based on their survey answers. `form` (shortcode) and `question_ref` are required; `response` is optional.

Mode 1 — Equals specific response (user answered question X with exactly response Y):

```json
{
  "type": "question_response",
  "form": "intake-survey",
  "question_ref": "consent_question",
  "response": "Yes"
}
```

Mode 2 — Is answered (user answered question X at all, any response):

```json
{
  "type": "question_response",
  "form": "intake-survey",
  "question_ref": "consent_question"
}
```

If `response` is provided, only users who answered that question with exactly that value are matched. If `response` is omitted (not just empty string — the key must be absent), all users who answered the question with any value are matched.

Implementation uses a CTE with an INNER JOIN against the `responses` table, similar to `elapsed_time`. Wrapping `question_response` inside a NOT operator is not supported for the same reason as `elapsed_time`: the INNER JOIN cannot express "users who did NOT answer this question".

**Survey ID** conditions select users whose current form belongs to the survey with the given UUID. This is useful when you want to target all users currently on any form within a specific survey, without having to enumerate the individual form shortcodes.

```json
{"type": "surveyid", "value": "550e8400-e29b-41d4-a716-446655440000"}
```

The `value` field must be the UUID of the survey (as stored in `surveys.id`). The condition matches users where `states.current_form` is any form belonging to that survey (resolved via a subquery: `s.current_form IN (SELECT shortcode FROM surveys WHERE id = $N)`).

Unlike `elapsed_time` and `question_response`, `surveyid` is safe to wrap in a NOT operator. It does not use an INNER JOIN CTE against a separate table; the subquery operates on the states row itself, so negation works correctly.

**Logical operators** combine conditions:

- **`and`** -- all child conditions must match. Takes 1 or more children.
- **`or`** -- any child condition must match. Takes 1 or more children.
- **`not`** -- negates a single child condition. Takes exactly 1 child.

```json
{
  "op": "and",
  "vars": [
    { "type": "form", "value": "myform" },
    { "type": "state", "value": "BLOCKED" },
    {
      "op": "or",
      "vars": [
        { "type": "error_code", "value": "10" },
        { "type": "error_code", "value": "11" }
      ]
    }
  ]
}
```

**NOT operator examples:**

Negate a single condition (match users whose state is NOT "END"):

```json
{"op": "not", "vars": [{"type": "state", "value": "END"}]}
```

NOT inside an AND group (match users on a form whose state is NOT "END"):

```json
{
  "op": "and",
  "vars": [
    {"type": "form", "value": "myform"},
    {"op": "not", "vars": [{"type": "state", "value": "END"}]}
  ]
}
```

**NOT operator constraints:**
- Must have exactly 1 child (validation rejects 0 or 2+ children).
- Cannot negate `elapsed_time` or `question_response` conditions, directly or transitively. Both conditions use INNER JOIN CTEs against the responses table; negating them would require LEFT JOIN + IS NULL semantics to correctly include users who never responded, which is not yet supported.
- `surveyid` IS safe to wrap in NOT.

**SQL generation for NOT:**

| Condition | Generated SQL |
|-----------|--------------|
| `{"op": "not", "vars": [{"type": "state", "value": "END"}]}` | `NOT (s.current_state = $1)` |
| `{"op": "not", "vars": [{"op": "and", "vars": [...]}]}` | `NOT ((child1 AND child2))` |

### SQL Generation Examples

Every generated query carries the same head — the three columns of the conversation, and the
owner-scoped credentials join that resolves the platform. The bail owner is bound last, so
its parameter number is always one past the conditions'.

**Simple conditions-based query** (form + state):

```sql
SELECT DISTINCT s.userid, s.pageid,
  CASE WHEN c.entity = 'facebook_page' THEN 'messenger'
       WHEN c.entity = 'whatsapp_business' THEN 'whatsapp'
  END AS platform
FROM states s
INNER JOIN credentials c ON c.key = s.pageid
  AND c.entity IN ('facebook_page','whatsapp_business')
  AND c.userid = $3
WHERE (s.current_form = $1 AND s.current_state = $2)
LIMIT 100000
```

Parameters: `[$form, $state, $owner_id]`

**Elapsed time** — uses a named CTE joined to `states`:

```sql
WITH response_times_0 AS (
    SELECT userid, pageid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2
    GROUP BY userid, pageid
)
SELECT DISTINCT s.userid, s.pageid,
  CASE WHEN c.entity = 'facebook_page' THEN 'messenger'
       WHEN c.entity = 'whatsapp_business' THEN 'whatsapp'
  END AS platform
FROM states s
INNER JOIN credentials c ON c.key = s.pageid
  AND c.entity IN ('facebook_page','whatsapp_business')
  AND c.userid = $4
LEFT JOIN response_times_0 rt0 ON s.userid = rt0.userid AND s.pageid = rt0.pageid
WHERE rt0.response_time + $3::INTERVAL < NOW()
LIMIT 100000
```

Parameters: `[$form, $question_ref, $duration, $owner_id]`

**Question response (exact match):**

```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid, pageid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2 AND response = $3
)
SELECT DISTINCT s.userid, s.pageid,
  CASE WHEN c.entity = 'facebook_page' THEN 'messenger'
       WHEN c.entity = 'whatsapp_business' THEN 'whatsapp'
  END AS platform
FROM states s
INNER JOIN credentials c ON c.key = s.pageid
  AND c.entity IN ('facebook_page','whatsapp_business')
  AND c.userid = $4
LEFT JOIN question_responses_0 qr0 ON s.userid = qr0.userid AND s.pageid = qr0.pageid
WHERE qr0.userid IS NOT NULL
LIMIT 100000
```

Parameters: `[$form, $question_ref, $response, $owner_id]`

**Question response (any answer):**

```sql
WITH question_responses_0 AS (
    SELECT DISTINCT userid, pageid
    FROM responses
    WHERE shortcode = $1 AND question_ref = $2
)
SELECT DISTINCT s.userid, s.pageid,
  CASE WHEN c.entity = 'facebook_page' THEN 'messenger'
       WHEN c.entity = 'whatsapp_business' THEN 'whatsapp'
  END AS platform
FROM states s
INNER JOIN credentials c ON c.key = s.pageid
  AND c.entity IN ('facebook_page','whatsapp_business')
  AND c.userid = $3
LEFT JOIN question_responses_0 qr0 ON s.userid = qr0.userid AND s.pageid = qr0.pageid
WHERE qr0.userid IS NOT NULL
LIMIT 100000
```

Parameters: `[$form, $question_ref, $owner_id]`

#### Targeting is scoped to the messaging account

A conversation is the tuple `(platform, account_id, user_id)`, where `account_id` is the
legacy column name `pageid`. `chatroach.states` is keyed `PRIMARY KEY (userid, pageid)`
because the same participant id can hold two entirely independent conversations on two
different messaging accounts — and those accounts may belong to two different researchers.

Every response-derived CTE therefore projects `pageid` and is joined to `states` on
`(userid, pageid)`, never on `userid` alone; `response_times_N` also aggregates per account
(`GROUP BY userid, pageid`). This keeps an answer bound to the account it was given on.

Joining on `userid` alone aggregates `responses` across *all* accounts and attaches them to
account-scoped `states` rows, so a participant's answers on account A qualify them for a bail
targeted at account B. That is both a mis-targeting bug and a cross-researcher data leak. The
CTE joins are `LEFT JOIN` (an inner join would force AND semantics on every CTE-backed
condition); the `IS NOT NULL` test enforces the actual match. The credentials join is the one
INNER join in the query, and is inner on purpose: it decides which accounts exist for this
bail at all, rather than contributing a condition.

Adding the platform column to a `SELECT DISTINCT` would normally risk splitting a group and
bailing someone twice. It cannot here: `states` is `PRIMARY KEY (userid, pageid)` and
`credentials` has a unique `key` for messaging entities, so at most one credential row joins
per conversation and the added column is functionally dependent on the `DISTINCT` key.

`responses.pageid` used to be nullable, and the join's strict equality meant a `NULL` pageid
matched no conversation — intended, since an unattributable response must not qualify anyone.
As of `devops/migrations/28a-responses-account-scoped-key.sql` the column is `NOT NULL`, because
it is part of the primary key, and the 1.82M historical NULLs were backfilled to the
empty-string "account unknown" sentinel. The behaviour is unchanged: `''` matches no real
account, so those rows remain inert for bail targeting. Not a live concern either way — every
response written since September 2020 carries a real pageid.

### Execution Timing

Defines **when** the bail fires.

| Timing | Behavior | Required fields |
|--------|----------|-----------------|
| `immediate` | Executes on every CronJob tick (every minute) | None |
| `scheduled` | Executes daily at a specific time in a specific timezone | `time_of_day` (HH:MM), `timezone` (IANA); optional `tolerance_minutes` |
| `absolute` | Executes once at a specific datetime, then never again | `datetime` (`YYYY-MM-DDTHH:MM:SS`, no zone suffix), `timezone` (IANA) |

Deduplication:
- **Immediate**: No deduplication; it re-fires every minute, for as long as the bail is enabled. Idempotent because botserver handles duplicate bailouts — but a one-off `user_list` batch should use `absolute`, which fires exactly once, rather than `immediate` plus a race to disable it.
- **Scheduled**: Fires inside a forward-only window that opens at `time_of_day` in `timezone` and stays open for `tolerance_minutes` (default 30), so a delayed executor can still catch up; it will not fire before the target time. It will not fire twice on the same calendar day in that timezone (`executor/timing.go:49-101`).
- **Absolute**: Fires on the first tick at or after the target instant, and never again once any prior successful execution exists.

**How `datetime` is interpreted**: `time.ParseInLocation("2006-01-02T15:04:05", ...)` — the
value is read as **wall-clock time in the bail's `timezone`**, not as UTC
(`executor/timing.go:119`). `"2026-09-20T14:00:00"` with `timezone: "Africa/Lagos"` means
14:00 Lagos time. This is why `timezone` is required alongside `datetime`; the API rejects
its absence with `invalid execution: timezone is required for absolute timing`
(`types/types.go:82-84`).

**Important**: At creation time, Exodus validates that required timing fields are present
but does not validate their format. Format validation happens at execution time, and the
resulting error is **not visible in the bail's event history** (see "Failed executions
leave no event" below) — only in the executor job logs:
- `time_of_day` must be `HH:MM` format.
- `timezone` must be a valid IANA timezone name (e.g., `"America/New_York"`).
- `datetime` must be exactly `YYYY-MM-DDTHH:MM:SS` with **no zone suffix and no offset**.
  A trailing `Z` is rejected: `"2026-06-01T09:00:00Z"` stores fine at creation and then
  fails every tick with `timing check failed: invalid datetime "2026-06-01T09:00:00Z":
  must be in YYYY-MM-DDTHH:MM:SS format`, so the bail never fires.

### Action

Defines **what** happens to matched users (conditions-type bails only):

```json
{
  "destination_form": "exit_survey_v2",
  "metadata": { "reason": "timeout", "version": 1 }
}
```

`destination_form` is required for conditions-type bails. `metadata` is optional and passed through to botserver. For `user_list` bails, the destination is per-user in the `user_list.users[].shortcode` field; `action` is present but `destination_form` is ignored.

---

## Access Control

- Bails are scoped to users, not surveys. A bail's `user_id` references the user who created it.
- The bail name must be unique per user (`UNIQUE (user_id, name)`).
- The dashboard-server proxy enforces that `req.params.userId` matches the authenticated user.
- Exodus itself has no auth layer for *who is calling* -- it trusts the caller's identity. All authentication happens at the dashboard-server boundary.
- What a bail can *reach* is Exodus's own rule, and it is enforced against `credentials`: a conditions query matches only accounts the bail's owner connected, and every `pageid` in a user list must resolve to one. See "The query only matches the owner's own accounts" and "The platform comes from the account, not from the entry".

---

## Component Responsibilities

### exodus (Go)

The core service, deployed in two modes from the same binary:

- **API mode** (`--mode=api`): REST API for bail CRUD, preview, and event history. Routes under `/users/:userId/bails`. Uses Echo framework. Validates bail definition schema, builds preview queries, manages database records.
- **Executor mode** (`--mode=executor`): Runs as a Kubernetes CronJob. Loads enabled bails, checks timing, builds and executes queries, sends bailouts, records events.

Key packages:
- `types/` -- Bail, BailEvent, BailDefinition, UserList, Condition types with validation and custom JSON marshaling
- `platform/` -- pure account→transport resolution: the entity mapping, the partition of targets into resolved and skipped, and the skip reasons. No IO
- `query/` -- Translates condition trees into parameterized SQL with CTEs for elapsed_time and question_response conditions, over the owner-scoped credentials join
- `executor/` -- Execution loop with timing logic, error isolation per bail, panic recovery
- `sender/` -- HTTP POST to botserver's `/synthetic` endpoint with rate limiting and dry-run support; refuses a target with no usable platform
- `api/` -- REST handlers, request/response types, db-to-types conversion
- `db/` -- Database operations (CRUD for bails and events, messaging-credential lookup)
- `config/` -- Environment variable configuration loading

### dashboard-server (Node.js)

Auth proxy layer between the dashboard client and exodus:

- Authenticates requests via JWT
- Validates user identity (`userId` matches authenticated user)
- Proxies all requests to exodus API via `BailsUtil`

The proxying itself is `api/bails/bails.service.js`, which the REST controller
and the MCP tools both call. Exodus answers 4xx with a message worth relaying,
so those become a `BailFailure` marked `expected` — safe to show verbatim —
while anything else stays ours.

**Agents reach bails too**, as the seven `*_bail*` MCP tools in
`documentation/agent-api.md` §9. Two things differ from the REST path. An agent
never sees a user id: `resolveVlabUser` does from the caller's email what the
dashboard does by calling `POST /users` on mount, and every tool takes the
resolved user. And `time_of_day`, `timezone` and `datetime` are format-checked
before the write (`mcp.core.js#validateBailDefinition`), because Exodus
validates their presence but not their shape and the bail then silently never
runs — see "Common Issues" below.

That `datetime` check is weaker than the executor's rule: it accepts anything
`Date.parse` accepts, so a `Z`-suffixed value passes the agent path and is then
rejected on every tick by `executor/timing.go:119`. Its error message offers
`"2026-06-01T09:00:00Z"` as the good example, which is the one shape that cannot
work. The timezone check also runs only for `scheduled`, though `absolute`
requires a timezone too.

The REST controller forwards `definition` untouched and applies none of these
checks, so a hand-written POST can carry fields no client offers — a user list
entry's `platform`, for one, which Exodus's decoder then drops. It forwards
`enabled` on create as well as update; an omitted `enabled` is left omitted
rather than sent as `false`, so the default stays Exodus's to choose.

Neither path re-checks which accounts a user list names. That rule lives in
Exodus, against the `credentials` table it already reads, and both paths relay
its `400 invalid_pageids` verbatim — see `dashboard-server/README.md`,
"Bail systems", for why it is deliberately not duplicated.

### dashboard-client (React)

UI components for bail management:

- `BailSystems.js` -- List view with table, inline enable/disable, delete
- `BailForm.js` -- Create/edit form with condition builder, timing config, preview
- `BailEvents.js` -- Event history table for a specific bail
- `ConditionBuilder` -- Reusable component for building condition trees visually

Uses Ant Design components. Routes are top-level under `/bails`.

---

## Execution Model

### Deployment

Exodus executor runs as a Kubernetes CronJob with:

- **Schedule**: `* * * * *` (every minute)
- **Concurrency policy**: `Forbid` (prevents parallel runs; if a run takes longer than 1 minute, the next scheduled run is skipped)
- **Active deadline**: 3600 seconds (1 hour max per run)
- **Restart policy**: `OnFailure` (Kubernetes retries on system-level crashes)

### Execution Loop

Each run:

1. Load all enabled bails from the database
2. For each bail:
   a. Parse and validate the definition JSON
   b. Fetch the last successful execution timestamp from `bail_events`
   c. Call `shouldExecute()` with the timing config, current time, and last execution
   d. If timing matches:
      - For `conditions` bails: build SQL query, execute it against the database; every row arrives with its platform already resolved by the credentials join
      - For `user_list` bails: look up one messaging credential per distinct `pageid` and partition the entries into resolved targets and skipped ones
      - Apply `EXODUS_MAX_BAIL_USERS` limit if matched count exceeds it
      - Send bailouts via botserver, record event — including a run where everything was skipped
3. Exit

### Error Handling

Three levels of error isolation:

| Level | Examples | Behavior |
|-------|----------|----------|
| **System** | Database unreachable, invalid config | Exit with non-zero code; Kubernetes retries |
| **Bail-level** | Invalid definition JSON, SQL error, timing-check failure | Log error, attempt an error event in `bail_events`, continue to next bail |
| **User-level** | Botserver returns non-200 for one user | Log warning, continue with remaining users; record partial success |

Each bail is wrapped in panic recovery (`defer/recover`) so one bad bail cannot crash the entire executor run. Panics are caught, logged, and recorded as error events.

The error event is only *attempted*: `recordError` composes its JSON by interpolating the error string unescaped, so any message containing a double quote — which every timing error does — produces invalid JSON, fails on insert, and leaves nothing but a log line. See "Failed executions leave no event" under Common Issues.

**Partial success**: If some user sends fail, `users_bailed` will be less than `users_matched` in the recorded event. This still counts as an execution event (not an error event).

### Rate Limiting

The sender applies a configurable delay between HTTP POSTs to botserver (configurable via `EXODUS_RATE_LIMIT`, default: 1 second). This prevents overwhelming botserver when a bail matches thousands of users.

### Query Safety

- All queries use parameterized values (no SQL injection)
- Queries have a safety `LIMIT 100000` at the SQL level
- An additional `EXODUS_MAX_BAIL_USERS` limit is applied in the executor before sending (default: 100000)
- Duration strings are validated against a strict regex before being used as PostgreSQL intervals

### Dry Run Mode

When `DRY_RUN=true`, the sender logs what it would do instead of actually POSTing to botserver. All other execution logic (query building, timing checks, event recording) runs normally.

---

## Event Audit Trail

Every bail execution (successful or failed) is recorded in the `bail_events` table:

| Column | Description |
|--------|-------------|
| `id` | UUID primary key |
| `bail_id` | Reference to the bail (SET NULL on bail deletion) |
| `user_id` | User who owns the bail |
| `bail_name` | Snapshot of bail name at event time |
| `event_type` | `"execution"` for success, `"error"` for failures |
| `timestamp` | When the event occurred |
| `users_matched` | Number of conversations the bail resolved to a reachable account — the query's rows, or the user list minus its skipped entries |
| `users_bailed` | Number of users successfully bailed (may differ from matched if sends fail) |
| `definition_snapshot` | Full JSON copy of the bail definition at execution time |
| `error` | JSON error details (null for successful executions) |
| `execution_results` | JSON object `{"user_ids": [...]}` listing user IDs successfully bailed, plus `"skipped": [{"userid", "pageid", "reason"}]` when a user list named accounts that did not resolve (null for error events) |

The `definition_snapshot` is critical: it captures exactly what definition was active when the bail ran, providing a full audit trail even if the bail is later edited or deleted.

Events are immutable -- they are only ever inserted, never updated or deleted.

---

## API Endpoints Reference

All bail endpoints are scoped under `/users/:userId/bails`. The `/api/v1` prefix is added by the dashboard-server Express app layer, so the full path from the client is `/api/v1/users/:userId/bails`. Authentication is via Bearer token in the Authorization header. The dashboard-server proxies these to exodus.

### Endpoints Summary

| Operation | Method | Path | Frontend | Backend Handler |
|-----------|--------|------|----------|-----------------|
| List | GET | `/users/:userId/bails` | BailSystems.js | handlers.go:ListBails |
| Get | GET | `/users/:userId/bails/:id` | BailForm.js | handlers.go:GetBail |
| Create | POST | `/users/:userId/bails` | BailForm.js | handlers.go:CreateBail |
| Update | PUT | `/users/:userId/bails/:id` | BailForm.js | handlers.go:UpdateBail |
| Delete | DELETE | `/users/:userId/bails/:id` | BailSystems.js | handlers.go:DeleteBail |
| Bail Events | GET | `/users/:userId/bails/:id/events` | BailEvents.js | handlers.go:GetBailEvents |
| User Events | GET | `/users/:userId/bail-events` | - | handlers.go:GetUserEvents |
| Preview | POST | `/users/:userId/bails/preview` | BailForm.js | handlers.go:PreviewBail |

### List Bails

```
GET /users/:userId/bails
Authorization: Bearer {token}
```

> **Performance note.** Each row in this response is enriched with a lightweight
> `last_event` summary for the "Last Execution" column. The list endpoint resolves
> all latest events in **one** batched query that selects only the small fields the
> UI needs:
>
> ```sql
> SELECT DISTINCT ON (bail_id)
>        id, bail_id, event_type, timestamp, users_matched, users_bailed
> FROM chatroach.bail_events
> WHERE bail_id = ANY($1::uuid[])
> ORDER BY bail_id, timestamp DESC
> ```
>
> This projection is fully covered by the existing `idx_bail_events_bail` index,
> avoiding the heavy JSON audit columns (`definition_snapshot`, `error`,
> `execution_results`) and primary-table lookups. The first batched fix (commit
> `8276e15`) reduced the number of rows touched; this second layer reduces the
> amount of data read per row, which is what caused the timeout to return for
> users with very large accumulated event history.

**Response** (200 OK):
```json
{
  "bails": [
    {
      "bail": {
        "id": "uuid",
        "user_id": "uuid",
        "name": "string",
        "description": "string",
        "enabled": true,
        "definition": { "conditions": {}, "execution": {}, "action": {} },
        "destination_form": "string",
        "created_at": "ISO-8601",
        "updated_at": "ISO-8601"
      },
      "last_event": {
        "id": "uuid",
        "bail_id": "uuid",
        "event_type": "execution|error",
        "timestamp": "ISO-8601",
        "users_matched": 0,
        "users_bailed": 0
      }
    }
  ]
}
```

> Note: `GET /users/:userId/bails/:id`, `POST /users/:userId/bails`, and
> `PUT /users/:userId/bails/:id` still return the full `BailResponse` shape with a
> complete `last_event` (including `definition_snapshot`, `error`, and
> `execution_results`). Only the list endpoint uses the lean summary.

### Get Single Bail

```
GET /users/:userId/bails/:id
Authorization: Bearer {token}
```

**Response** (200 OK):
```json
{
  "bail": { "..." },
  "last_event": { "..." }
}
```

**Errors**: 400 (invalid UUID), 404 (not found), 500 (database error)

### Create Bail

```
POST /users/:userId/bails
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "string (required)",
  "description": "string (optional)",
  "enabled": true,
  "definition": {
    "type": "conditions",
    "conditions": {},
    "execution": { "timing": "immediate|scheduled|absolute", "..." },
    "action": { "destination_form": "string", "..." }
  }
}
```

**Response** (201 Created):
```json
{
  "bail": { "..." },
  "last_event": null
}
```

**A bail is created disabled unless the request says otherwise.** `enabled` is forwarded on
create by every path — the dashboard REST controller, the MCP `create_bail` tool, and a
direct POST to Exodus. An *omitted* `enabled` stays omitted rather than being sent as
`false`, so the default is Exodus's alone: `CreateBailRequest.Enabled` is a plain Go `bool`
and an absent field leaves it at the zero value, `false`. Pass `"enabled": true` to have a
new bail start firing on the next tick that its timing allows.

`PUT` forwards `enabled` too, as an optional field (`UpdateBailRequest.Enabled` is a
`*bool`, applied only when present), so enabling or disabling an existing bail does not
require resending its definition.

**Errors**: 400 (`missing_field` for a missing name, `invalid_definition` for a definition
that fails validation, `invalid_pageids` for a user list naming an account the caller has not
connected), 500 (database error).

### Update Bail

```
PUT /users/:userId/bails/:id
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "string (optional)",
  "description": "string (optional)",
  "definition": { "..." },
  "enabled": true
}
```

Partial update -- only provided fields are changed.

**Response** (200 OK): Updated bail object with last_event.

**Errors**: as for create, plus 404 `bail_not_found`. A replacement `user_list` definition is
checked the same way a new one is, so an update can be refused with `400 invalid_pageids`
even though the bail already exists.

### Delete Bail

```
DELETE /users/:userId/bails/:id
Authorization: Bearer {token}
```

**Response** (204 No Content): Empty body.

### Get Bail Events

```
GET /users/:userId/bails/:id/events
Authorization: Bearer {token}
```

Returns full event history for a specific bail, most recent first.

**Response** (200 OK):
```json
{
  "events": [
    {
      "id": "uuid",
      "bail_id": "uuid",
      "user_id": "uuid",
      "bail_name": "string",
      "event_type": "execution|error",
      "timestamp": "ISO-8601",
      "users_matched": 0,
      "users_bailed": 0,
      "definition_snapshot": {},
      "error": null,
      "execution_results": {
        "user_ids": ["uid1", "uid2"],
        "skipped": [{"userid": "uid3", "pageid": "page_gone", "reason": "credential_not_found"}]
      }
    }
  ]
}
```

`skipped` is present only when a `user_list` bail named accounts that did not resolve at
execution time; the entries that did are in `user_ids`.

### Get User Events

```
GET /users/:userId/bail-events?limit=100
Authorization: Bearer {token}
```

Returns recent events across **all** bails owned by the user (not scoped to a specific bail). Useful for an activity feed or cross-bail audit view.

Query parameters:
- `limit`: integer 1–1000, default 100

**Response** (200 OK): Same `EventsListResponse` shape as Get Bail Events.

### Preview Bail (Dry Run)

```
POST /users/:userId/bails/preview
Authorization: Bearer {token}
Content-Type: application/json

{
  "definition": {
    "type": "conditions",
    "conditions": {},
    "execution": { "timing": "immediate" },
    "action": { "destination_form": "string" }
  }
}
```

**Response** (200 OK) for conditions-based bails:
```json
{
  "count": 127,
  "users": [
    { "userid": "user1", "pageid": "page1" }
  ],
  "sql": "SELECT DISTINCT s.userid, s.pageid, CASE ... END AS platform FROM states s INNER JOIN credentials c ... WHERE ...",
  "params": ["value1", "value2", "<owner uuid>"]
}
```

The preview runs the same query the executor would, owner-scoped the same way, so its count
is the count the bail would match — not a superset. The bound owner is the last parameter.

**Response** (200 OK) for user_list bails:
```json
{
  "count": 3,
  "users": [
    { "userid": "user1", "pageid": "page1" },
    { "userid": "user2", "pageid": "page2" }
  ],
  "sql": "",
  "params": null
}
```

Shows which users match the conditions without creating or executing the bail. For conditions-based bails, the generated SQL and parameters are included in the response, which is useful for debugging complex condition trees. For user_list bails, the user list is returned directly and no SQL is generated — but the accounts it names are checked, so a preview answers `400 invalid_pageids` for a list that create would also refuse.

The dashboard-server proxy is a pure pass-through for preview.

### Data Structures

**Condition** -- Union type discriminated by presence of `op` field:

- If `op` is present: compound condition (`LogicalOperator`)
- If `op` is absent: simple condition (`SimpleCondition`)

Simple conditions:

```json
{ "type": "form", "value": "string" }
{ "type": "state", "value": "START|RESPONDING|QOUT|WAIT_EXTERNAL_EVENT|END|BLOCKED|ERROR" }
{ "type": "error_code", "value": "string" }
{ "type": "current_question", "value": "string" }
{
  "type": "elapsed_time",
  "since": { "event": "response", "details": { "form": "string", "question_ref": "string" } },
  "duration": "string (e.g. '4 weeks', '2 days')"
}
{
  "type": "question_response",
  "form": "string (required, form shortcode)",
  "question_ref": "string (required)",
  "response": "string (optional, exact match against responses.response column)"
}
{ "type": "surveyid", "value": "string (required, UUID of the survey)" }
```

Compound conditions:

```json
{ "op": "and|or", "vars": [ /* 1+ Condition objects */ ] }
{ "op": "not", "vars": [ /* exactly 1 Condition object */ ] }
```

**Execution**:

```json
{
  "timing": "immediate|scheduled|absolute",
  "time_of_day": "HH:MM (required if scheduled)",
  "timezone": "IANA timezone (required if scheduled AND if absolute)",
  "datetime": "YYYY-MM-DDTHH:MM:SS, no zone suffix (required if absolute); read as wall-clock time in `timezone`",
  "tolerance_minutes": "integer (scheduled only, optional, default 30)"
}
```

**Action**:

```json
{
  "destination_form": "string (required for conditions-type, ignored for user_list)",
  "metadata": { "optional": "JSON object" }
}
```

**UserList**:

```json
{
  "users": [
    {
      "userid": "string",
      "pageid": "string (a messaging account connected by the bail's owner)",
      "shortcode": "string (destination form)"
    }
  ]
}
```

There is no `platform` field: it is resolved from the account's credential. Any other key in
an entry is dropped when the definition is decoded.

**BailEventSummary** (returned as `last_event` by the list endpoint):

```json
{
  "id": "uuid",
  "bail_id": "uuid",
  "event_type": "execution|error",
  "timestamp": "ISO-8601",
  "users_matched": 0,
  "users_bailed": 0
}
```

The full `BailEvent` (including `definition_snapshot`, `error`, and `execution_results`) is still returned by `GET /users/:userId/bails/:id`, `POST /users/:userId/bails`, and `PUT /users/:userId/bails/:id`.

### Error Handling

Error response format:

```json
{
  "error": "error_code",
  "message": "human readable message"
}
```

Common errors:

| Status | Error Code | Scenario |
|--------|-----------|----------|
| 400 | `invalid_user_id` | User ID is not a valid UUID |
| 400 | `invalid_bail_id` | Bail ID is not a valid UUID |
| 400 | `invalid_request` | Request body is not valid JSON |
| 400 | `missing_field` | Required field is missing (e.g., name) |
| 400 | `invalid_definition` | Definition fails validation (with details) |
| 400 | `invalid_pageids` | A `user_list` names one or more accounts the caller has no messaging credential for. The message lists every offending pageid. Returned by create, update and preview |
| 404 | `bail_not_found` | Bail does not exist or does not belong to user |
| 500 | `database_error` | Database operation failed |

### Example: Create a Scheduled Bail

**Request**:
```json
POST /users/550e8400-e29b-41d4-a716-446655440001/bails

{
  "name": "4-Week Dropout Recovery",
  "description": "Recover users who haven't responded in 4 weeks",
  "enabled": true,
  "definition": {
    "conditions": {
      "op": "and",
      "vars": [
        {
          "type": "elapsed_time",
          "since": {
            "event": "response",
            "details": { "form": "intake_survey", "question_ref": "age_q" }
          },
          "duration": "4 weeks"
        },
        { "type": "state", "value": "RESPONDING" }
      ]
    },
    "execution": {
      "timing": "scheduled",
      "time_of_day": "09:00",
      "timezone": "America/New_York"
    },
    "action": {
      "destination_form": "recovery_survey",
      "metadata": { "reason": "dropout_recovery" }
    }
  }
}
```

**Response** (201):
```json
{
  "bail": {
    "id": "550e8400-e29b-41d4-a716-446655440002",
    "user_id": "550e8400-e29b-41d4-a716-446655440001",
    "name": "4-Week Dropout Recovery",
    "enabled": true,
    "definition": { "..." },
    "destination_form": "recovery_survey",
    "created_at": "2024-02-15T18:48:00Z",
    "updated_at": "2024-02-15T18:48:00Z"
  },
  "last_event": null
}
```

### Example: Create a User List Bail

**Request**:
```json
POST /users/550e8400-e29b-41d4-a716-446655440001/bails

{
  "name": "Direct Outreach Batch",
  "description": "Send specific users to specific surveys",
  "definition": {
    "type": "user_list",
    "user_list": {
      "users": [
        { "userid": "abc123", "pageid": "page_abc", "shortcode": "survey_a" },
        { "userid": "def456", "pageid": "page_def", "shortcode": "survey_b" }
      ]
    },
    "execution": {
      "timing": "absolute",
      "datetime": "2026-09-20T14:00:00",
      "timezone": "Africa/Lagos"
    },
    "action": {}
  }
}
```

Three things in this example are load-bearing. Each `pageid` is one of this user's own
messaging accounts — `page_abc` may be WhatsApp and `page_def` Messenger, and neither entry
says so, because the account's credential does; a pageid the caller has not connected makes
the whole POST fail with `invalid_pageids`. Timing is `absolute` rather than `immediate`, so
the batch goes out once instead of every minute until someone disables it. And there is no
`"enabled": true`, so the bail is created dormant — add the field, or `PUT` it afterwards, to
start the clock running against that `datetime`.

---

## Data Transformation

### Key Transformation Points

Data flows through several layers, with transformations at each boundary:

| Field | Frontend Type | Transformation | Backend Type | Storage |
|-------|---|---|---|---|
| `name` | string | unchanged | string | TEXT |
| `type` | string | unchanged | string | JSONB |
| `conditions` | JS object | JSON serialization | Condition (union) | JSONB |
| `user_list` | JS object | JSON serialization | UserList | JSONB |
| `timing` | string | unchanged | string | JSONB |
| `time_of_day` | moment object | `format('HH:mm')` | string | JSONB |
| `datetime` | moment object | `format('YYYY-MM-DDTHH:mm:ss')` | string | JSONB |
| `timezone` | string | unchanged | string | JSONB |
| `destination_form` | string | unchanged | string | TEXT |
| `metadata` | JSON string (textarea) | `JSON.parse()` | map[string]interface{} | JSONB |
| `enabled` | boolean | unchanged | boolean | BOOLEAN |

### Validation Flow

All comprehensive validation happens on the backend in `types.go`:

```
BailDefinition.Validate()
+-- (if type="conditions") Conditions.Validate()
|   +-- (if operator) LogicalOperator.Validate()
|   |   +-- Check op is "and", "or", or "not"
|   |   +-- "not" must have exactly 1 child
|   |   +-- "not" cannot contain elapsed_time or question_response (directly or transitively)
|   |   +-- Validate each child condition recursively
|   +-- (if simple) SimpleCondition.Validate()
|       +-- Check type is valid (form, state, error_code, current_question, elapsed_time, question_response, surveyid)
|       +-- Check required fields for each type
|       +-- If elapsed_time: validate TimeReference structure (event="response", details with form and question_ref)
|       +-- If question_response: require form and question_ref (response is optional)
|       +-- If surveyid: require value (must be a non-empty string)
|
+-- (if type="user_list") UserList.Validate()
|   +-- Array must have 1–1000 entries
|   +-- Each entry must have userid, pageid, shortcode
|   (whether each pageid is an account the caller owns is NOT decided here: that
|    needs the database, so the API layer checks it — see "invalid_pageids")
|
+-- Execution.Validate()
|   +-- Check timing is valid (immediate, scheduled, absolute)
|   +-- If scheduled: require time_of_day and timezone (presence only, not format)
|   +-- If absolute: require datetime AND timezone (presence only, not format)
|
+-- (if type="conditions") Action.Validate()
    +-- Check destination_form is non-empty
```

Frontend validation is minimal (required field checks via AntD Form rules). The backend is the source of truth for all validation.

`Validate()` is pure: it judges the definition on its own terms. Everything that needs the
database — which accounts the caller has connected, and what platform each of them sends on —
is checked in the API layer, after `Validate()` passes and before anything is written.

### Common Issues

**Time format mismatches**: `time_of_day` must be `HH:MM` (e.g., `"09:00"`, not `"09:00:00"`). `datetime` must be `YYYY-MM-DDTHH:MM:SS` with **no** zone suffix — `"2026-06-01T09:00:00"`, never `"2026-06-01T09:00:00Z"` and never an `+01:00` offset. The zone comes from the separate `timezone` field, which `absolute` also requires. Format errors are not caught at creation: the bail stores successfully, then fails the timing check on every tick and never fires.

**Invalid timezone**: An unrecognized IANA timezone name (e.g., `"US/Eastern"` instead of `"America/New_York"`) makes the bail fail its timing check on every tick, so it never executes. Always use canonical IANA zone names. As with every timing failure, no event is recorded — see "Failed executions leave no event".

**Metadata validation**: The frontend silently falls back to an empty object on invalid JSON input. Users receive no feedback that their JSON was malformed.

**Missing timing fields**: The frontend does not strictly enforce conditional required fields (e.g., `time_of_day` when timing is "scheduled"). The backend will reject with a clear error message.

**Condition type errors**: Using an unsupported condition type name will be rejected by the backend with: `invalid condition type: <type>`. Valid types are: `form`, `state`, `error_code`, `current_question`, `elapsed_time`, `question_response`, `surveyid`.

**State values**: The backend accepts any string for `state` conditions. The meaningful values are: `START`, `RESPONDING`, `QOUT`, `WAIT_EXTERNAL_EVENT`, `END`, `BLOCKED`, `ERROR`, `USER_BLOCKED`. `QOUT` means a question has been delivered and the bot is waiting for the user's reply — it is the normal in-flight state for active participants.

**Duration format**: Must be `<number> <unit>` exactly. Accepted units: `microseconds`, `milliseconds`, `seconds`, `minutes`, `hours`, `days`, `weeks`, `months`, `years` (singular or plural). Formats like `"4w"`, `"4 weeks ago"`, or `"1.5 hours"` are rejected.

**Enabled on create**: a bail whose request says nothing about `enabled` is created disabled. Every path forwards the field, so `"enabled": true` on the POST is honoured; the default belongs to Exodus, and it is `false` (see "Create Bail").

**`invalid_pageids` on a user list**: every `pageid` in the list must be a `facebook_page` or `whatsapp_business` account connected by the bail's owner, because that credential is what decides which platform the bailout is sent on. Create, update and preview all refuse a list that names one the caller does not own, and the message lists each offending pageid. The usual causes are a CSV assembled from someone else's export, a typo in an account id, and an account that has since been disconnected. `list_messaging_accounts` (MCP) or the dashboard's messaging accounts page shows the ids that will pass.

**Skipped targets**: a pageid can be valid when the bail is saved and gone by the time it fires. Those targets are skipped rather than sent, and listed in the event's `execution_results.skipped` with a reason. Check there first when `users_matched` is lower than the list length.

**Failed executions leave no event**: when an execution fails, the executor builds the error event's JSON by string interpolation — `json.RawMessage(fmt.Sprintf(`{"message": "%s"}`, execErr.Error()))` at `exodus/executor/executor.go:313` — with no escaping. Every timing error formats the offending value with `%q`, so the message contains double quotes, the resulting bytes are not valid JSON, and the insert fails while marshalling: `json: error calling MarshalJSON for type json.RawMessage: invalid character '2' after object key:value pair`. `recordError` only logs a warning on that failure (`executor.go:332`), so nothing is written.

The operational consequence: **an empty event history does not mean the bail has not been tried.** A bail with a bad `datetime`, a bad `time_of_day` or an unknown timezone is attempted on every tick and fails every time, showing zero events in the UI and in `chatroach.bail_events`. The reason exists only in the `gbv-exodus-executor` job logs:

```
kubectl logs -n <ns> --since=1h --prefix \
  -l app.kubernetes.io/name=exodus,app.kubernetes.io/component=executor \
  | grep -i "bail\|timing check failed"
```

The CronJob is `<release>-exodus-executor`; its pods carry the `component: executor` label above. Because it runs every minute, completed pods are pruned quickly — read the logs soon after the tick you care about.

Errors raised after the timing check — a SQL failure, a bad definition — usually carry no quotes and do record normally.

**User list size**: User list bails are limited to 1–1000 users per bail. For larger batches, split across multiple bails.

---

## Frontend-Backend Mapping

### Condition Union Pattern

Frontend and backend represent the same condition tree using different patterns:

- **Frontend**: Plain JavaScript objects. Presence of `op` field distinguishes compound from simple conditions.
- **Backend**: Go discriminated union (`Condition` struct) with custom JSON marshal/unmarshal. Presence of `op` triggers `LogicalOperator` path; absence triggers `SimpleCondition` path.

Both patterns produce identical JSON over the wire.

### Key Compatibility Notes

| Aspect | Frontend | Backend | Notes |
|--------|----------|---------|-------|
| Bail type | string field `type` | `BailDefinition.Type` | Omitting defaults to `"conditions"` |
| Condition union | Plain JS object with `op` or `type` | Custom unmarshal, discriminated union struct | Identical JSON wire format |
| Time fields | moment.js objects in form state | `YYYY-MM-DDTHH:mm:ss` or `HH:mm` strings in JSON | Transformation in `buildDefinition()`; no zone suffix on `datetime` |
| Metadata | JSON string in textarea | `map[string]interface{}` | Frontend parses on send, stringifies on load |
| Enabled on create | Part of form values | Forwarded by the proxy, honoured by Exodus | Omitted entirely when absent; Exodus's default for an absent field is `false` |
| User list platform | Not collected — CSV is 3 columns | Not a field on `UserListEntry` | Resolved from the account's credential; an extra key in an entry is dropped on decode |
| Validation depth | Minimal (required fields) | Comprehensive (type enums, format, structure) | Backend is source of truth |
| Partial update | Full form always submitted | `UpdateBailRequest` supports optional fields | Only provided fields updated on PUT |

### Special Behaviors

**`destination_form` duplication**: The `Bail` object has `destination_form` both at the top level and inside `definition.action.destination_form`. The backend populates the top-level field from the definition on create/update. For `user_list` bails, the top-level `destination_form` is stored as an empty string.

**Metadata round-trip**: On load, metadata object is stringified to JSON for display in a textarea. On save, the textarea string is parsed back to an object. Invalid JSON silently becomes `{}`.

**User list bails and action**: The `action` field must be present in the JSON but `destination_form` inside it is not validated or used. Send `"action": {}` for user list bails.

---

## Configuration

All configuration is via environment variables.

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `CHATBASE_DATABASE` | `chatroach` | Database name |
| `CHATBASE_HOST` | `localhost` | Database host |
| `CHATBASE_PORT` | `5433` | Database port |
| `CHATBASE_USER` | `root` | Database user |
| `CHATBASE_PASSWORD` | *(empty)* | Database password |

Tables are stored in the `chatroach` schema (e.g., `chatroach.bails`, `chatroach.bail_events`). Exodus also reads `chatroach.states`, `chatroach.responses`, `chatroach.surveys` and `chatroach.credentials`; it writes only `bails` and `bail_events`.

### Botserver

| Variable | Default | Description |
|----------|---------|-------------|
| `BOTSERVER_URL` | `http://localhost:8080/synthetic` | Full URL of botserver's synthetic endpoint |

### Executor

| Variable | Default | Description |
|----------|---------|-------------|
| `EXODUS_RATE_LIMIT` | `1s` | Delay between HTTP POSTs to botserver (Go duration string, e.g. `"500ms"`, `"2s"`) |
| `EXODUS_MAX_BAIL_USERS` | `100000` | Maximum users to bail per bail per execution run. Applied after the SQL LIMIT. |
| `DRY_RUN` | `false` | When `true`, log bailout events instead of POSTing to botserver |

### API Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Port for the exodus API HTTP server |

### Botserver Event Format

Exodus posts the following JSON to `BOTSERVER_URL` for each user:

```json
{
  "user": "userid",
  "account_id": "pageid",
  "page": "pageid",
  "platform": "messenger|whatsapp",
  "event": {
    "type": "bailout",
    "value": {
      "form": "destination_form_shortcode",
      "metadata": { "optional": "object" }
    }
  }
}
```

The event names the whole conversation, as `documentation/event-envelope.md` requires.
`page` is a deprecated alias for `account_id` and carries the same value. `platform` is
always one of the two transports — the sender refuses to post a target without one, so no
bailout leaves exodus for a receiver to guess about.

---

## Debugging Guide

This section covers common bail problems and how to diagnose them using the database.

### Useful queries

Look up a bail by name:

```sql
SELECT id, name, enabled, definition, created_at, updated_at
FROM chatroach.bails
WHERE name ILIKE '%<bail name>%';
```

Check recent execution history for a bail (includes the definition snapshot that was active at execution time). **Zero rows does not mean the bail was never attempted** — a bail whose timing check fails is retried every minute and records nothing; read the executor job logs instead (see "Failed executions leave no event"):

```sql
SELECT id, event_type, timestamp, users_matched, users_bailed,
       definition_snapshot->'execution' AS execution_def, error
FROM chatroach.bail_events
WHERE bail_id = '<bail_id>'
ORDER BY timestamp DESC
LIMIT 10;
```

Check a specific user's responses for a given form/question:

```sql
SELECT userid, shortcode, question_ref, response, timestamp
FROM chatroach.responses
WHERE userid = '<userid>'
  AND shortcode = '<form_shortcode>'
  AND question_ref = '<question_ref>'
ORDER BY timestamp;
```

See which targets a run could not reach, and why:

```sql
SELECT timestamp, users_matched, users_bailed,
       execution_results->'skipped' AS skipped
FROM chatroach.bail_events
WHERE bail_id = '<bail_id>'
  AND execution_results ? 'skipped'
ORDER BY timestamp DESC;
```

Check which platform an account sends on — the same lookup a bail makes:

```sql
SELECT key AS pageid, entity, userid AS owner
FROM chatroach.credentials
WHERE key = '<pageid>'
  AND entity IN ('facebook_page', 'whatsapp_business');
```

No row means no bail can reach that account: a conditions bail stops matching it, and a user
list target on it is skipped as `credential_not_found`. A row whose `userid` is not the bail's
owner is `credential_not_owned`.

### Before changing how accounts are resolved

`planning/vir-60-predeploy-check.sql` is a read-only report to run against production before
deploying a change to the credentials join or the user-list resolution. Per enabled bail it
shows which `(bail, pageid)` populations the owner-scoped join excludes, whether each excluded
account belongs to another researcher or to nobody, and which user-list pageids would be
skipped. An empty result means no bail's population changes. It contains only SELECTs and is
**not** a migration — do not run it through `devops/run-prod-migration.sh`.

