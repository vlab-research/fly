# `fb_error_code IS NULL` on BLOCKED states — what they are (2026-07-26)

## The answer, plainly

**They are not Facebook errors at all.** All 131 rows are a *single* phenomenon: our own
`message-worker` failed to find a page access token in its `credentials` table, never made an
HTTP call to Meta, and reported the failure to replybot mis-tagged as `FB` with a status code of
`0` — which Go's `json:"code,omitempty"` then dropped from the JSON entirely, leaving
`state_json->'error'` with no `code` key and the computed `fb_error_code` column NULL.

They are the **residue of the staging/production Kafka traffic leak of 2026-07-10 → 07-13**
(`planning/staging-production-traffic-leak.md`, Helm rev 607 → 608). Roughly half of production
webhook events were consumed by the **staging** message-worker, which queries the **staging**
database, where no production page credentials exist. Every affected user got
`token not found for platform account: <prod page id> (db error: no rows in result set)` and was
driven to `BLOCKED`.

Verdict on the four framing questions:

- **Not a Facebook error.** Nothing reached Meta. `status 0` literally means "no HTTP response".
- **Not benign, but also not ongoing.** It is a fully-bounded, already-diagnosed incident with a
  known remaining tail of 131 real prod participants who are still stuck.
- **One phenomenon, not several.** 21 forms is just "who happened to be mid-survey during a
  3-day platform-wide outage", not 21 causes.
- **Not new, not long-standing — a one-off.** Zero occurrences ever, before or after, in the
  whole 1.07M-row table.

---

## Evidence

### 1. Every row has an error object; none has a `code`

Cheap (`fb_error_code_idx (current_state, fb_error_code) STORING (state_json)`):

```sql
SELECT (state_json->'error' IS NULL) AS no_error_obj,
       jsonb_pretty(state_json->'error') AS err, count(*)
FROM states
WHERE current_state='BLOCKED' AND fb_error_code IS NULL
  AND updated > NOW() - INTERVAL '30 days'
GROUP BY 1,2 ORDER BY 3 DESC;
```

| no_error_obj | error | count |
|---|---|---|
| f | `{"message": "platform API error (status 0): failed to get token: token not found for platform account: 101435865704727 (db error: no rows in result set)", "tag": "FB"}` | 126 |
| f | same, page `758018254333043` | 3 |
| f | same, page `110749071412124` | 2 |

There is **no** "BLOCKED with no error object" class. Every one of the 131 rows has
`tag: "FB"`, a message, and no `code` key.

### 2. Aggregate shape

```sql
SELECT count(*) rows, count(DISTINCT userid) users, count(DISTINCT pageid) pages,
       count(DISTINCT current_form) forms, min(updated), max(updated)
FROM states WHERE current_state='BLOCKED' AND fb_error_code IS NULL;
```

| rows | users | pages | forms | first | last |
|---|---|---|---|---|---|
| 131 | 131 | 3 | 21 | 2026-07-11 02:00:25Z | 2026-07-14 08:07:38Z |

`error_tag='FB'` on all 131 (so here the tag is *not* a stale sticky value — it was written at
block time by `worker.go:331`; it is simply wrong, see below).

### 3. It has never happened at any other time

```sql
SELECT date_trunc('month', updated) mon, count(*),
       count(*) FILTER (WHERE state_json->'error'->>'message' LIKE '%token not found%') AS token_not_found,
       count(*) FILTER (WHERE state_json->'error' IS NULL) AS no_error_obj
FROM states WHERE current_state='BLOCKED' AND fb_error_code IS NULL
GROUP BY 1 ORDER BY 1;
```

| mon | count | token_not_found | no_error_obj |
|---|---|---|---|
| 2026-07 | 131 | 131 | 0 |

**One row in the output.** All-time, across the never-garbage-collected `states` table, this
bucket exists only in July 2026 and is 100% token-not-found. Not background noise, not a
migration artifact, not a WhatsApp/Messenger difference.

### 4. Time distribution matches the Helm incident exactly

Hourly counts run 2026-07-11 02:00Z → 2026-07-14 08:00Z, continuously, with no gaps longer than
a few hours. Against the incident timeline in `planning/staging-production-traffic-leak.md`:

| event | time |
|---|---|
| Helm rev 607 deploys staging values to `vprod` | 2026-07-10 19:54 |
| first NULL-code BLOCKED | 2026-07-11 02:00 |
| Helm rev 608 restores prod topics | 2026-07-13 21:10 (pods rolled ~22:01) |
| last NULL-code BLOCKED | 2026-07-14 08:07 |

The ~10h tail past the fix is consistent with the incident doc's note that later `updated` bumps
are stale Kafka replays draining the `vlab-staging-*` topics.

### 5. The credentials existed in prod — which is the proof it was staging that failed

```sql
SELECT facebook_page_id, entity, created, (details->>'access_token' IS NOT NULL)
FROM credentials WHERE facebook_page_id IN ('101435865704727','758018254333043','110749071412124');
```

All three rows exist, `entity='facebook_page'`, with a non-null `access_token`, created
2026-06-24 and 2026-07-01 — i.e. **weeks before** the incident. The production database could
always have answered the lookup. The `no rows in result set` came from a worker pointed at a
different database. That worker is staging's.

Corollary: all three pages are `facebook_page` entities served by `MessengerClient`. **No
WhatsApp involvement** — the WhatsApp hypothesis is ruled out. (Though the same NULL-code path
exists on the WhatsApp client too; see the latent risk below.)

### 6. They are still stuck, and dean structurally cannot rescue them

```sql
SELECT current_state, count(*) FROM states
WHERE userid IN (SELECT userid FROM states WHERE current_state='BLOCKED' AND fb_error_code IS NULL)
GROUP BY 1;
```

→ `BLOCKED | 131`. None have moved. Last touched 12+ days ago.

`dean/queries.go:130-143`:

```go
current_state = 'BLOCKED' AND
fb_error_code = ANY($1) AND
updated + ($2)::INTERVAL > $4 AND ...
```

`DEAN_FB_CODES=2022,613,-1,190,80006,551` (`devops/values/production.yaml:156`). SQL `= ANY(...)`
never matches NULL, so dean's `Blocked` retry sweep skips this cohort by construction — and even
if the code matched, `DEAN_BLOCKED_INTERVAL=120 hours` has long since elapsed.

### 7. Attrition on the cohort confirms the "self-corrects on activity" theory

The incident doc recorded **193** of these on 2026-07-15 (Part 3, line 91). Today the all-time
count is **131**. So ~62 users transitioned out on their own next interaction, exactly as Part 7
predicted; the remaining 131 are people who have not been back since.

---

## The code path, end to end

1. `message-worker/tokenstore.go:65-83` — `PostgresTokenStore.GetToken` runs
   `SELECT COALESCE(details->>'access_token', details->>'token') FROM credentials WHERE facebook_page_id=$1`.
   `pgx` returns `ErrNoRows`, wrapped as
   `token not found for platform account: %s (db error: %v)`.
2. `message-worker/messenger_client.go:63-71` — wraps it in
   **`&PlatformError{StatusCode: 0, Message: "failed to get token: …", Retriable: false}`**.
   (`whatsapp_client.go:51-57` is byte-for-byte the same shape.)
3. `message-worker/client.go:26-28` — `PlatformError.Error()` renders
   `"platform API error (status 0): …"` — the string seen in `state_json`.
4. `message-worker/worker.go:111-118` — `RetryWithBackoff` gives up immediately
   (`Retriable:false`, `retry.go:45`) and calls `reportError`.
5. **`message-worker/worker.go:327-336` — the mis-attribution.**
   ```go
   tag := "STATE_ACTIONS"
   code := 0
   if IsPlatformError(err) {
       tag = "FB"                       // <-- ANY *PlatformError is called "FB"
       code = platformErr.StatusCode    // <-- 0 for a pre-flight failure
   }
   ```
   A token-lookup failure never touched Meta, but is labelled `FB` because it is typed as a
   `*PlatformError`.
6. **`message-worker/worker.go:314-318` — the NULL.**
   ```go
   type MachineReportError struct {
       Tag     string `json:"tag"`
       Message string `json:"message"`
       Code    int    `json:"code,omitempty"`   // <-- 0 is the zero value → key omitted
   }
   ```
   `omitempty` drops `code: 0`. The published `machine_report` has `{"tag","message"}` only.
7. `worker.go:338-360` — posted to botserver as a `synthetic_machine_report` external event.
8. `replybot/lib/typewheels/machine.js:288-290` —
   ```js
   if (report && report.error && report.error.tag === 'FB') {
     return { action: 'BLOCKED', error: report.error }
   }
   ```
   Tag `FB` ⇒ `BLOCKED` (anything else ⇒ `ERROR`). This is the fork that decides the user's fate,
   and it trusts a tag that step 5 assigns wrongly.
9. `replybot/lib/typewheels/machine.js:669-676` — `apply` writes `error: output.error` verbatim
   into the state.
10. `states.fb_error_code` is `STORED AS ((state_json->'error')->>'code')` → **NULL**.

### The two-line defect

`StatusCode: 0` + `json:"code,omitempty"` is the bug. Any `PlatformError` with status 0 becomes a
codeless `FB` block. Today that is two error sites:

| site | Retriable | consequence |
|---|---|---|
| `messenger_client.go:66` / `whatsapp_client.go:53` — token lookup failed | false | what happened here |
| `messenger_client.go:110` — **`HTTP request failed` (network/DNS/timeout to Meta)** | true | retried, then **also** blocks with a NULL code |

The second one is the latent trap: a sustained network problem between message-worker and Meta
would silently produce this same bucket, permanently `BLOCKED`, invisible to dean, filed under
`other`. That is a platform outage that would look like miscellaneous noise.

---

## Is it one thing or several?

**One thing.** All 131 rows share one error message shape, one 3-day window, one root cause,
and one code path. The 21 `current_form` values and 3 `pageid`s are the *blast radius* of a
platform-wide event, not distinct phenomena: the leak took ~50% of all prod webhook traffic, so
every study active that week is represented in proportion to its volume.

| pageid | rows | forms | note |
|---|---|---|---|
| 101435865704727 | 126 | 18 | the high-volume prod page |
| 758018254333043 | 3 | 2 | mnch* |
| 110749071412124 | 2 | 2 | followup7ar, language |

Top forms: `girleffectincentive` 83, `endlinebail` 12, `wazzii` 4, `305` 4, `hpvincentive` 4 —
the rest are 1–3 each.

---

## Recommendation for the taxonomy (feeds `core-visibility-alerting-plan.md` W1)

**Do not add a taxonomy entry for "NULL". Fix the code, and give the bucket a name that
describes the real class.**

`devops/sql-exporter/templates/configmap.yaml:82-88` currently sends NULL to `ELSE 'other'`.
That is not wrong, but it hides the most actionable class behind the least informative label.

Concretely, in priority order:

1. **Fix `worker.go:317` — drop `omitempty` from `Code`.** *(code fix, not a taxonomy entry)*
   Then `code: 0` is emitted and `fb_error_code = '0'` — a real, groupable value meaning
   "we never reached the platform". This alone converts an unexplainable NULL into a
   self-describing signal, and makes it eligible for `DEAN_FB_CODES` if we ever want retries.
2. **Fix `worker.go:328-335` — stop tagging pre-flight failures `FB`.** A token lookup that
   failed against *our* database is not the channel refusing us; it is our config or our DB.
   It should be tagged `INTERNAL` (or `NETWORK` for `HTTP request failed`), which routes it to
   `ERROR` at `machine.js:292` instead of `BLOCKED`, and puts it inside `DEAN_ERROR_TAGS` so
   dean actually retries it. **This is the substantive fix** — it is why 131 real participants
   were parked permanently instead of retried and recovered.
3. **Until (1)/(2) ship, bucket it explicitly as `provider_unreachable`** (not `other`, not
   `attrition`):
   ```sql
   WHEN fb_error_code IS NULL OR fb_error_code = '0' THEN 'provider_unreachable'
   ```
   **Actionable, page-worthy — treat like `provider_error`, never like `attrition`.** Rationale:
   every member of this class is a user we *failed to reach for our own reasons* and who is now
   permanently stuck with no automatic recovery. Zero of them are user churn. It should have
   fired on 2026-07-11 and did not.
4. **Keep the noise gate meaningful:** peak hourly rate during the incident was 9/h, and the
   3-day total was 131. A threshold in the 5–10/1h range would have caught it inside the first
   two hours. Note this is the same order as the existing (already-stale) absolute thresholds —
   see the volume-gating warning in `documentation/study-error-alerting.md` §1.
5. **Do not fold this into `attrition`.** The temptation exists because the counts are small and
   the tag says `FB`. Both are misleading.

### Separately: the 119 rows at `fb_error_code = '-1'`

Checked for contrast, since it is the other opaque bucket. `(#-1) Unexpected internal error`,
`tag: FB`, 2026-07-06 → 2026-07-26, i.e. genuinely ongoing background. That one **is** a real
Meta-side error code and **is** in `DEAN_FB_CODES`, so dean retries it. Different animal; not
part of this finding.

---

## Operational follow-up (out of scope for the taxonomy, but the reason it matters)

131 real production participants have been sitting in a false `BLOCKED` since 2026-07-11–14 and
nothing will move them. `planning/staging-production-traffic-leak.md` Part 7 left this open with
"recommend: confirm empirically that one such user self-corrects on activity before doing
anything". The 193 → 131 attrition confirms self-correction *does* work — but only for users who
came back on their own. The 131 remaining are, by definition, the ones who did not.

If they should be re-driven, the `restore_state` mechanism built in Part 6 of that doc applies
(these are non-terminal, so a Redis flush + nudge may be enough). That is a decision for the
study owners, not a platform default.

---

## What I could not determine, and what would settle it

1. **Whether the failing lookups were literally the staging message-worker, or the prod
   message-worker transiently pointed at the wrong DB.** The evidence is strong but
   circumstantial: prod `credentials` demonstrably had all three tokens for the whole window, so
   *some* worker was querying a database that did not. The incident doc independently documents
   staging services consuming prod topics. **Settled by:** `kubectl -n vstag logs` for
   `message-worker` in that window (almost certainly rotated away by now), or the
   `[MESSENGER-CLIENT] Failed to get token` line in whichever namespace's logs survive.
2. **The exact ~10h tail past the rev-608 rollout (Jul 13 22:01 → Jul 14 08:07).** Attributed to
   stale Kafka replay per the incident doc's own note, but not independently verified here.
   **Settled by:** consumer-group offset history for `message-worker` on `vlab-staging-commands`
   across Jul 13–14.
3. **Whether the 62 users who left this cohort actually completed their surveys or just moved to
   another failure state.** Their `error` was cleared on transition (commit 57bc567e), so it is
   no longer queryable from `states`. **Settled by:** joining those userids against `responses`
   for post-Jul-14 activity.

None of these change the answer or the recommendation.

---

## Queries used (all index-safe — every one pins `current_state`)

```sql
-- shape of the error object
SELECT (state_json->'error' IS NULL), jsonb_pretty(state_json->'error'), count(*)
FROM states WHERE current_state='BLOCKED' AND fb_error_code IS NULL
  AND updated > NOW() - INTERVAL '30 days' GROUP BY 1,2 ORDER BY 3 DESC;

-- blast radius
SELECT pageid, current_form, error_tag, count(*), min(updated)::date, max(updated)::date
FROM states WHERE current_state='BLOCKED' AND fb_error_code IS NULL
  AND updated > NOW() - INTERVAL '30 days' GROUP BY 1,2,3 ORDER BY 4 DESC;

-- time distribution
SELECT date_trunc('hour', updated), count(*) FROM states
WHERE current_state='BLOCKED' AND fb_error_code IS NULL
  AND updated > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1;

-- all-time: is this new?
SELECT date_trunc('month', updated), count(*),
       count(*) FILTER (WHERE state_json->'error'->>'message' LIKE '%token not found%')
FROM states WHERE current_state='BLOCKED' AND fb_error_code IS NULL GROUP BY 1 ORDER BY 1;

-- did prod actually have the tokens?
SELECT facebook_page_id, entity, created, (details->>'access_token' IS NOT NULL)
FROM credentials WHERE facebook_page_id IN ('101435865704727','758018254333043','110749071412124');

-- are they still stuck?
SELECT current_state, count(*) FROM states
WHERE userid IN (SELECT userid FROM states WHERE current_state='BLOCKED' AND fb_error_code IS NULL)
GROUP BY 1;
```

## Files referenced

- `message-worker/tokenstore.go:65-87` — the failing lookup
- `message-worker/messenger_client.go:63-71`, `:110-114` — `StatusCode: 0` construction
- `message-worker/whatsapp_client.go:51-57` — same shape on WhatsApp
- `message-worker/client.go:20-28` — `PlatformError` + message format
- `message-worker/worker.go:314-318` — `json:"code,omitempty"` (the NULL)
- `message-worker/worker.go:327-336` — `tag = "FB"` mis-attribution
- `message-worker/retry.go:26-45` — `Retriable` gate
- `replybot/lib/typewheels/machine.js:281-297` — `MACHINE_REPORT` → BLOCKED vs ERROR fork
- `replybot/lib/typewheels/machine.js:669-676` — BLOCKED writes `error` verbatim
- `dean/queries.go:130-143` — `Blocked` sweep, `fb_error_code = ANY($1)`
- `devops/values/production.yaml:156` — `DEAN_FB_CODES`
- `devops/sql-exporter/templates/configmap.yaml:78-94` — `survey_blocked_states` category CASE
- `planning/staging-production-traffic-leak.md` — the incident (Part 1 root cause, Part 3 line 91,
  Part 7 open item)
- `documentation/study-error-alerting.md` — current taxonomy
