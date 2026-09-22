# Two bugs on one account: `md` erased, then the platform fabricated

<!-- Search aliases: assume-messenger, assume messenger, platform guess,
     COALESCE(platform, 'messenger'), token not found for platform account,
     User without metadata, husk state, md erased, message_pointer truncation,
     block_user pointer, STATE_ACTIONS spike, PlatformInternalErrors firing,
     W1 W2 W3, WhatsApp launch checklist, states.platform NULL, dean posts wrong
     platform, phantom messenger conversation, vlpulseng errors, vlpulsHng,
     corrupted shortcode, snapshot-in-log, restore_state. -->

**Status: NOT STARTED (except Task A, which is DONE, and Task B, which is
committed unpushed). Written 2026-09-04, rewritten 2026-09-04/05 after the
second bug was found.**

**Parent plan:** `planning/multi-platform-plan.md` is authoritative for the
migration's phase order. This file is the spec for one item that plan already
names but never scheduled — the **WhatsApp launch checklist (W1–W3)** — plus one
it does not know about at all: the erasure bug in §2.

---

## One-line summary

**There are TWO bugs, and the first manufactures the input to the second.**

1. **Erasure.** A blocked WhatsApp conversation's `md` is destroyed by a
   pointer-truncated event replay. `states.platform` goes NULL because `md` is
   gone. This is ~6 years old and was latent until WhatsApp's traffic pattern
   armed 11,492 conversations on one account.
2. **Fabrication.** Dean reads that NULL and asserts `messenger` on a WhatsApp
   conversation, so the send looks for a `facebook_page` credential that cannot
   exist.

The platform did not "drift" between two recorded values. **It was destroyed,
then fabricated.** Both faces page, both are in `DEAN_ERROR_TAGS`, and Dean
re-sweeps its own damage every 30 minutes.

---

## 0. For the agent picking this up

Read these, in this order, before touching code:

1. This file, end to end.
2. `planning/block-without-pointer-plan.md` — **the spec for the erasure fix**
   (Task E), which replaced snapshot-in-log on 2026-09-05. Read
   `planning/blocked-user-durability-handoff.md` for the history and the gaps,
   but note its § "Recommended approach: snapshot-in-log" is marked abandoned:
   the "obvious alternative" it rejected — do not advance the pointer — is the
   fix, because blocked users' logs turned out to be short (max 6,209 events).
3. `planning/md-platform-asymmetry-findings.md` — the investigation that found
   bug 1. Its §1 (every writer of `md`) and §3 (the chain, traced per
   participant) are the evidence base and are not repeated here in full.
4. `documentation/states-debugging.md` § "Blocking a participant destroys `md`" —
   the 2026-07-30 Messenger-side write-up of the same bug.
5. `documentation/platform-resolution.md` — the feature doc for the resolution
   question. §5 is bug 2, §6 is why it cannot self-heal.
6. `planning/multi-platform-plan.md` § "WhatsApp launch checklist" (W1/W2/W3)
   and § "Out of scope".
7. `documentation/study-error-alerting.md` § "Error Taxonomy" — why
   `STATE_ACTIONS` pages, and why being in `DEAN_ERROR_TAGS` makes it recur.

**Working rule inherited from the parent plan, and it keeps earning its keep:**
verify against the source or the live cluster, cite `file:line`, and write
UNVERIFIED rather than reasoning from plausibility. Every number here was
measured on `vprod`; each is dated, because several have moved twice already.

**Do not start by fixing the affected participants.** The user has explicitly
deprioritised them. They are a symptom, and — unlike the 2026-09-04-morning
version of this plan assumed — **clearing their Redis cache does not recover
them** (§7 Task D). Cause first.

**Do not confuse the two bugs.** The single most expensive mistake available
here is to ship Task B, watch `token not found` drain to zero, and declare
victory while the other half of the same participants stays broken. §10's gates
are written to make that impossible.

---

## 1. What happened

Alerts have been firing continuously on `vprod` since 2026-09-02:

| alert | severity | since (UTC) | firing 2026-09-05 00:26 |
|---|---|---|---|
| `PlatformInternalErrors` | critical, **pages** | 09-02 ~09:00 | **yes** |
| `PlatformInternalErrorsSevere` | info, researcher-visible banner | 09-02 ~19:00 | no (it flaps on a ratio gate) |
| `SurveyErrorSpike{form="vlpulseng"}` | warning | 09-02 ~12:00 | **yes** |

Source: `devops/alerts/templates/study-health.yaml`; firing state read via
Prometheus `ALERTS{alertstate="firing", component="study-health"}`, 2026-09-05
00:26 UTC.

Everything is on account `1203867182815254`, the **WhatsApp** number for study
*VL Pulse Nigeria* (`vlpulseng`). Its credential exists and is correct — one row,
`whatsapp_business`, created 2026-08-05 (`SELECT entity, key, created FROM
credentials WHERE key = '1203867182815254'`, vprod). Only the *lookup entity* is
wrong, and only on the fabrication half.

Aggregated across all 8 replybot pods, 3h window ending 2026-09-05 00:25 UTC
(`kubectl logs -n vprod -l app.kubernetes.io/name=replybot --since=3h
--max-log-requests=12 --tail=-1`):

```
User without metadata                          561    <- bug 1, erasure
token not found for platform account: 1203…    310    <- bug 2, fabrication
```

⚠️ **Measure this the aggregated way.** `kubectl logs deploy/gbv-replybot` reads
**one** pod of eight and returned 43/83 for the same window. An eighth of the
truth reads like the incident is subsiding.

---

## 2. Bug 1 — erasure. The `md` is destroyed before Dean ever sees the row

This is the generator. It was unknown when this plan was first written; the
investigation is `planning/md-platform-asymmetry-findings.md`.

**(1) `BLOCK_USER` advances the pointer.** `replybot/lib/typewheels/machine.js:507-520`
returns a `RESET` whose `stateUpdate` is
`{ state: 'USER_BLOCKED', pointer: nxt.timestamp, forms: state.forms, md: state.md }`.

It carries `md` **deliberately** — a prior half-fix, whose comment at
`machine.js:513-518` cites `documentation/states-debugging.md` by name. So the
state that gets *written* is fine. That is exactly why this looked fixed.

**(2) The replay is truncated at the pointer, and that is where `md` dies.**
`replybot/lib/chatbase/chatbase.js:86`:

```sql
AND (s.message_pointer IS NULL OR s.message_pointer <= m.timestamp)
```

`message_pointer` is a STORED computed column off `state_json->>'pointer'`
(`devops/migrations/04-pointers.sql`). After the Redis entry's 24h TTL expires
(`REPLYBOT_STATESTORE_TTL`, defaulted at
`replybot/lib/spine-supervisor/spine-supervisor.js:23`, not overridden in any
values file), a later event is a cache
**miss**, and the re-fold window starts *at the block*. The
`conversation_started` referral that created `md` is outside it.

`md` is created in exactly one place — `getMetadata()` at
`replybot/lib/typewheels/utils.js:399`, reached only through `_blankStart()` —
and every other write is a **merge**. `{ ...undefined, ...undefined }` is `{}`.
So nothing downstream can regenerate it. The fold restarts from `_initialState()`
(`machine.js:1022`), the in-window `block_user` hits its own
`if (state.state === 'START') return _noop()` guard (`machine.js:508`), and what
comes out is a **husk**.

**(3) The husk overwrites the `states` row.** `md` is gone, so `states.platform`
— a STORED computed column, `(state_json->'md')->>'platform'`
(`devops/migrations/21-states-platform.sql`) — becomes NULL. The pointer is gone
too, which matters in §4.

**(4) The husk throws untagged, and therefore pages.**
`replybot/lib/typewheels/transition.js:47-49`:

```js
if (!newState.md) {
  throw new Error(`User without metadata: ${userId}. State: ${util.inspect(newState, null, 8)}`)
}
```

A plain `Error` with no `tag`. `transition.js:205` — `const tag = e.tag || 'STATE_ACTIONS'`
— files it as `STATE_ACTIONS`, which `documentation/study-error-alerting.md`
classifies as *platform fault → page*. And `STATE_ACTIONS` is in
`DEAN_ERROR_TAGS` (`devops/values/production.yaml:378-379`,
`"NETWORK,INTERNAL,STATE_ACTIONS"`), so `Errored` re-sweeps it every 30 minutes,
for `DEAN_ERROR_INTERVAL` (48h), forever.

**(5) A truthy husk fails differently, one hop later.** When a real user *text*
lands on the husk instead of a Dean redo, `apply` `RESPOND` (`machine.js:694`)
computes `{ ...undefined, ...undefined }` = `{}` — **truthy**, so it passes the
guard at `transition.js:47`. Then `const { startTime } = newState.md` is
`undefined`, `getForm(pageId, shortcode, undefined)` throws, and
`iowrap('getForm', 'INTERNAL', …)` relabels it **`INTERNAL`** — also in
`DEAN_ERROR_TAGS`. Same bug, second face.

### The reservoir: 11,492 armed conversations on one account

```sql
-- vprod, 2026-09-05
SELECT c.entity, count(*) AS user_blocked_with_pointer, count(DISTINCT s.pageid) AS accounts
FROM states s JOIN credentials c ON c.key = s.pageid
  AND c.entity IN ('facebook_page','whatsapp_business')
WHERE s.current_state='USER_BLOCKED' AND s.message_pointer IS NOT NULL
GROUP BY 1;
--  facebook_page     |  2012 | 34 accounts
--  whatsapp_business | 11492 |  1 account
```

Every one of those 11,492 detonates the moment (a) its Redis entry ages out and
(b) any event arrives. Dean's `Spammers` sweep blocked them en masse around
2026-09-01.

**Why this is a fire on WhatsApp and was a trickle on Messenger.** All-time husk
rows (`platform IS NULL AND (md IS NULL OR md = '{}')`, `current_state='ERROR'`),
vprod 2026-09-05:

| entity | error | rows | oldest | newest |
|---|---|---|---|---|
| `facebook_page` | `INTERNAL` / `getForm` | 210 | 2020-12-19 | 2026-07-24 |
| `facebook_page` | `STATE_ACTIONS` / `User without metadata` | 13 | 2020-09-17 | 2026-07-18 |
| `whatsapp_business` | `STATE_ACTIONS` / `User without metadata` | 54 | **2026-09-04 14:00** | 2026-09-05 00:11 |
| `whatsapp_business` | `INTERNAL` / `getForm` | 14 | 2026-08-31 22:44 | 2026-09-05 00:01 |
| `whatsapp_business` | `REF_DECODE` | 7 | 2026-08-31 22:51 | 2026-09-02 13:33 |

⚠️ *oldest/newest are `min`/`max` of `updated`, which is sticky-latest. For the
Messenger rows nothing has touched them since, so the span is real. For the live
WhatsApp rows it is a churn window, not a creation window — Dean rewrites them
every sweep. Read the `facebook_page` span as a span and the `whatsapp_business`
one as "still happening".*

**223 Messenger husks in six years. 75 WhatsApp husks in five days.** The bug is
old and was latent; WhatsApp changed the arrival rate of the waking event —
`sent`/`delivered`/`read` status webhooks keep arriving for old messages long
after a participant has gone quiet, where Messenger needed a thread passback.

**What has fired so far is ~1.4% of the armed population** (165 participants of
11,492 — §4). The other 98.6% are loaded and waiting.

---

## 3. Bug 2 — fabrication. Dean asserts `messenger` on a NULL

This section is unchanged in substance from the original plan and is still
correct and well-evidenced. Each step was confirmed on the live cluster.

**(1) `states.platform` is NULL for almost everything.** Not just for husks:
`md.platform` postdates most of the table, and `states` keeps one sticky row per
`(userid, pageid)` forever.

```
total states rows           1,113,987     -- vprod 2026-09-03
platform IS NULL            1,066,596     -- 95.7%
```

**(2) Dean coalesces that NULL to the wrong platform.** `dean/queries.go`, seven
sites, one per sweep:

| line | function | CronJob | schedule |
|---|---|---|---|
| 107 | `Respondings` | `gbv-dean-respondings` | `*/30 * * * *` |
| 121 | `Errored` | `gbv-dean-respondings` | `*/30 * * * *` |
| 136 | `Blocked` | `gbv-dean-respondings` | `*/30 * * * *` |
| 151 | `Payments` | `gbv-dean-payments` | `0 */6 * * *` |
| 228 | `Timeouts` | `gbv-dean-timeouts` | `*/10 * * * *` |
| 287 | `FollowUps` | `gbv-dean-followups` | `0 5-19 * * *` |
| 319 | `Spammers` | `gbv-dean-spammers` | `30 3 * * *` |

(Line numbers are `main`. On `feature/dean-platform-resolution` all seven are
gone — see Task B.)

The mapping is **not** one CronJob per query: `devops/values/production.yaml`
groups three into one (`queries: "respondings,blocked,errored"`). There is no
`gbv-dean-errored` or `gbv-dean-blocked` in the cluster; not finding one does not
mean those sweeps are off.

The comment at `dean/queries.go:19-23` states the assumption plainly:
*"legacy rows report 'messenger'"*. Confirmed on the wire — a real event
replybot received, 2026-09-03 16:30:32 UTC:

```json
{"user":"2348060009347","account_id":"1203867182815254",
 "platform":"messenger","event":{"type":"redo"},"source":"synthetic"}
```

**This is not the `eventPlatform()` fallback.** `replybot/lib/typewheels/utils.js:176`
has a separate assume-messenger guess that logs `EVENT_PLATFORM_GUESSED`. That
counter reads **zero** over 3h. Dean asserts `messenger` affirmatively, so
replybot accepts it silently. **Do not "fix" the replybot fallback expecting it
to help.**

**(3) message-worker launders the claim into a constant, then looks in the wrong
entity.** `worker.go:163` selects the client by `cmd.Platform`; the selected
client calls `GetToken` with its **own hardcoded constant**
(`messenger_client.go:80`, `whatsapp_client.go:73`). `GetToken`
(`tokenstore.go:84`) maps that through `platformToEntity` (`tokenstore.go:29-32`)
and queries `WHERE entity='facebook_page' AND key='1203867182815254'`. No rows.
The key-only fallback at `tokenstore.go:103` is structurally unreachable from a
real send — client selection already guaranteed the platform is one of the two
mapped values. **Making it reachable is the wrong fix; see Task C (DROPPED).**

**(4) The error is tagged `STATE_ACTIONS` — by message-worker, not by replybot.**
`message-worker/worker.go:460-469`, `reportError`, **hardcodes**
`tag := "STATE_ACTIONS"` and only overrides it to `"FB"` for a
`PlatformError`. There is no plumbing for any other tag today. *(The original
plan said "nothing tags it, so `transition.js` files it as `STATE_ACTIONS`" —
that is the mechanism for **bug 1**, not this one. Two different code paths land
on the same tag.)*

**(5) Dean then retries its own damage.** `STATE_ACTIONS` ∈ `DEAN_ERROR_TAGS`, so
`Errored` (line 121) re-sweeps exactly the states this creates, with the same
NULL platform, every 30 minutes.

**(6) And it cannot self-heal, because the cache is keyed by the wrong
identity.** Redis keys are `state:<platform>:<account_id>:<userid>`; the `states`
PK is `(userid, pageid)` — **no platform**. So the phantom messenger identity and
the real WhatsApp identity write the same Postgres row. A
`DRY_RUN=1 devops/clear-state-cache.sh vprod <ids>` on 2026-09-03 found **98 keys
for 49 participants** — exactly two each:

```
state:whatsapp:1203867182815254:2349137757865
state:messenger:1203867182815254:2349137757865   <- phantom
```

Full write-up: `documentation/platform-resolution.md` §5–§6.

---

## 4. The two populations, measured

Everything below: vprod, **2026-09-05 ~00:10–00:30 UTC**. These move hourly.

### Active NULL-platform rows have exactly two generators, cleanly separable

```sql
SELECT c.entity AS true_platform,
       CASE WHEN s.state_json->'md' IS NULL THEN 'md_absent'
            WHEN s.state_json->'md' = '{}'::jsonb THEN 'md_empty'
            ELSE 'md_present_no_platform' END AS md_shape,
       s.current_state, s.error_tag, count(*)
FROM states s JOIN credentials c ON c.key = s.pageid
  AND c.entity IN ('facebook_page','whatsapp_business')
WHERE s.platform IS NULL AND s.updated > now() - INTERVAL '7 days'
GROUP BY 1,2,3,4 ORDER BY 5 DESC;
```

| true platform | `md` shape | state / tag | rows |
|---|---|---|---|
| `whatsapp_business` | **absent** | ERROR / `STATE_ACTIONS` | 54 |
| `whatsapp_business` | **`{}`** | ERROR / `INTERNAL` | 14 |
| `whatsapp_business` | **absent** | ERROR / `REF_DECODE` | 7 |
| `facebook_page` | present, no `platform` key | END | 4 |
| `facebook_page` | present, no `platform` key | QOUT | 2 |
| `facebook_page` | present, no `platform` key | WAIT_EXTERNAL_EVENT | 1 |
| `facebook_page` | present, no `platform` key | ERROR / `INTERNAL` | 1 |

- **Erasure / husk — 75 rows, all `whatsapp_business`, 100% in ERROR.** There is
  no *healthy* NULL-platform row on that account. That alone rules out "a cohort
  that predates the `md.platform` deploy": such a cohort would spread across
  END/QOUT/USER_BLOCKED like everything else.
- **Legacy — 8 rows, all `facebook_page`, `md` intact but never had a `platform`
  key**, mostly *not* in ERROR. Not growing. **Harmless**, and Task B resolves
  them correctly from `credentials`.

These are the only two shapes. A fix aimed at one does nothing for the other.

### The error faces are disjoint at any instant, and sum to one population

```sql
SELECT ... count(DISTINCT userid) FROM states
WHERE pageid='1203867182815254' AND current_state='ERROR' GROUP BY signature;
```

| signature | `error_tag` | `states.platform` | participants | newest |
|---|---|---|---|---|
| `token not found …` | `STATE_ACTIONS` | **`whatsapp`** (not NULL) | **97** | 2026-09-05 00:00:59 |
| `User without metadata …` | `STATE_ACTIONS` | **NULL** | **54** | 2026-09-05 00:11:45 |
| `getForm` (truthy `{}` husk) | `INTERNAL` | **NULL** | **14** | 2026-09-05 00:01:01 |

97 + 54 + 14 = **165**, and a `count(DISTINCT userid)` over the union of all
three predicates also returns **165** — so at any instant they are exactly
disjoint. A row holds one error at a time; participants move between faces as
Dean sweeps them. `planning/md-platform-asymmetry-findings.md` §4 traces one
participant flipping every 30 minutes and explains the mechanism (the husk write
removed the pointer, so the *next* re-fold is untruncated, rebuilds `md`
correctly with `platform: 'whatsapp'`, and then fails on Dean's
`messenger`-stamped event instead).

⚠️ **Note the `token not found` rows carry `states.platform = 'whatsapp'`, NOT
NULL.** Any gate that filters on `platform IS NULL` misses them entirely, and any
gate that filters on the `token not found` string misses the other 68. §10.

### Rate

Cumulative: **165 participants since 2026-08-31 22:44** (the oldest husk row on
this account) ≈ **~40 participants/day**. Still growing — the newest rows in every
face are minutes old.

Per-hour *row updates* on that account run 1–9/hr in the 12h to 2026-09-05 00:00.
⚠️ **Do not read that as new participants.** `updated` is sticky and Dean rewrites
the same rows every sweep, so hourly row counts measure churn. The 10–30/hour
figure in `planning/md-platform-asymmetry-findings.md` §7 is that churn measure;
the participant-arrival rate is roughly an order of magnitude lower.

### Also present, NOT part of this page — record, do not explain

Same account, different error tags, uninvestigated:

- **~66 participants in `FORM_NOT_FOUND` with visibly corrupted shortcodes** —
  `vlpulsHng<garbage>`, `vlpulseng<garbage>`, `slpHlseng`, `vlpelsung`,
  `v?pHlseng<garbage>`, `6l`, `?l`, `6o`. Newest 2026-09-04 11:33.
- **14 in `REF_DECODE`** — *"encoded ref is not canonical base64url"* (7 with
  `platform='whatsapp'`, 7 with NULL).

Branch `fix/vir-35-encoded-ref-guard` (single commit `0da91f9c`, *"encoded refs
no longer silently dropped on a live conversation"*) **may** be related.
WhatsApp entry refs come off **user-editable message text**
(`replybot/lib/event-normalizer.js`, `_refFromText`), which is a plausible source
of mangling. **This is an observation, not a diagnosis. UNVERIFIED.** It is out
of scope for this plan; give it its own investigation. See also §7 Task D, which
notes one *other* way a corrupted-looking form resolution can be manufactured.

---

## 5. Why the precondition expired

`planning/multi-platform-plan.md` § "WhatsApp launch checklist" is explicit:

> Assume-messenger is correct **only while Messenger is the only live
> transport**. It buys backwards compatibility by borrowing against a future
> WhatsApp launch, and the debt comes due at a knowable moment.

**That stopped being true without any code changing.** Measured on `vprod`,
conversations updated in the last 7 days:

| `states.platform` | 2026-09-03 | 2026-09-05 |
|---|---|---|
| `whatsapp` | 14,374 (90%) | **14,412 (90%)** |
| `messenger` | 1,515 | 1,584 |
| NULL | 70 | 83 |

WhatsApp became the dominant transport and W1–W3 were never done. The moment was
knowable; nobody was watching for it.

**This is the second incident from bug 2, not the first.**
`devops/values/production.yaml:113-127` records the first, 2026-08-25:
`dinersclub` v0.0.46 emitted payment events in the legacy shape with no platform,
assume-messenger kicked in, and the *identical* error string put a WhatsApp
participant into BLOCKED. That note even names the diagnosis — *"This is exactly
the W1 hazard in planning/multi-platform-plan.md"* — and the fix was to bump
dinersclub so it threads the real platform through (`dinersclub/main.go:103`,
`dinersclub/provider.go:94`).

**One producer was fixed. The general case was not.** Dean is the same bug via a
different producer. Fixing producers one at a time does not converge — there are
eight hops and seven synthetic posters
(`documentation/platform-resolution.md` §2).

### The gap this exposes in the parent plan

Phase 2.2 (`SYNTHETIC_REQUIRE_CONVERSATION → true`) is described as: *"After this
an unstamped event cannot enter the system at all."* **It will not catch this.**
Dean's events are fully stamped — with a wrong value. Presence gates do not catch
mis-stamping. *(Already recorded in `multi-platform-plan.md` § 2.2 by Task A.)*

---

## 6. Two tempting fixes that are wrong — now empirically confirmed

**"Finish the backfill."** There is no unfinished backfill. Phase 1.5 completed
**2026-08-29 00:20:53 UTC**, four days before this incident (5,351 batches,
106,931,189 rows, `done=t`). That backfill fills `messages.account_id`; this is
about `states.platform`, a different table and a *computed* column with nothing
to write to.

**"Backfill `states.platform` instead."** §4's table is the empirical refutation,
and it now says something stronger than the first draft of this plan could:

- For the **75 husk rows**, a `platform` backfill is not even well-defined —
  there is no `md` to write it into. Writing `md.platform` alone would produce a
  `md` of `{"platform":"whatsapp"}`, which is *truthy*, passes
  `transition.js:47`, and then fails in `getForm` on a missing `startTime`. **It
  converts a `STATE_ACTIONS` husk into an `INTERNAL` husk and nothing else.**
- For the **8 legacy rows**, it would work — and they are harmless already, and
  Task B resolves them for free.

So the backfill fixes neither population. **Fix the generators.**

---

## 7. The work

Five tasks. **E is the root fix**; B and C are containment; D is cleanup.

### Task A — Documentation pass — **DONE 2026-09-04**

Recorded here so nobody redoes it.

| | status |
|---|---|
| **A1** new feature doc `documentation/platform-resolution.md` | **done** (two errors corrected 2026-09-04, see below) |
| **A2** correct stale status in `multi-platform-plan.md` + `CLAUDE.md` | **done** — both now say 1.5 finished 2026-08-29; the 90/10 split is recorded; the Phase 2.2 gap is written into § 2.2 |
| **A3** real unattributable count in `messages-account-not-null-todo.md` | **done** — that file now leads with *"THE ~3,000 FIGURE IS WRONG. THE NUMBER IS ~55,000"* |
| **A4** close out Phase 1.5's runbook | **DONE.** Logs captured to `devops/backfill-logs/` — ⚠️ one pod's log had already been GC'd, losing per-batch detail for batches 1–5090 (~95%); totals still reconcile exactly. `messagesBackfill.enabled: false` applied 2026-09-04 21:07 (helm release `gbv` **revision 660**); Job `gbv-messages-backfill` is now `NotFound`, so those captured logs are the only surviving record. Migration 26's §4 gate remains **deliberately unrun** — a ~399 GiB scan, and `statement_timeout` is 0 on this cluster; slice it over the `hsh` keyspace when someone runs it on purpose. |

### Task B — Remove the guess from Dean (this is W2) — **committed, unpushed**

Replace all seven `COALESCE(platform, 'messenger')` sites in `dean/queries.go`
with a resolution against `credentials.entity`.

**Implementation status:** commit `02f72478` on branch
`feature/dean-platform-resolution`, *"fix(dean): resolve platform from
credentials.entity, not assume-messenger"*. All seven sites converted (a
`grep -c` for the old expression on that branch returns **0**); 30 tests pass;
mutation-checked — reverting the resolution expression fails all seven subtests.

The join is safe and single-valued; the schema guarantees it
(`SHOW CREATE TABLE credentials`, vprod 2026-09-05):

```
UNIQUE INDEX unique_messaging_account (key ASC) STORING (details, userid)
  WHERE entity IN ('facebook_page', 'whatsapp_business')
```

Unique on `key` across both messaging entities → **at most one row per
`pageid`**. Mapping is `facebook_page → messenger`, `whatsapp_business →
whatsapp`.

Design points, each load-bearing:

- **`LEFT JOIN`, never `INNER JOIN`.** `credentials` has
  `FOREIGN KEY (userid) REFERENCES users(id) ON DELETE CASCADE`, so an inner join
  would make a sweep *silently stop* for any conversation whose owning user was
  deleted.
- **`FollowUps`' CASCADE hazard is NOT what the original plan (and
  `documentation/platform-resolution.md` §2) said.** `FollowUps` *was* an
  `INNER JOIN credentials`, but the very next line is
  `INNER JOIN surveys ON states.current_form = surveys.shortcode AND c.userid = surveys.userid`
  (`dean/queries.go:287-295`). A credential-less row has a NULL `c.userid` and
  therefore drops at the **surveys** join regardless of the credentials join
  type — so changing INNER→LEFT there provably changes zero rows. The exclusion
  is also correct on its own terms: `surveys.userid` cascades identically, and
  `has_followup` lives on `surveys`. **Corrected in both places 2026-09-04.**
- **Keep a final `'messenger'` default** so a `pageid` with no credential behaves
  exactly as today. Changing that is a separate decision (§11 Q2).
- **Replace the comment at `dean/queries.go:19-23`.** It currently *documents the
  bug as intended behaviour*. Leaving it will get the guess reintroduced.

**The lookup is NOT index-only** — corrected. `unique_messaging_account` STOREs
`details` and `userid` but **not `entity`**, which is the column the resolution
reads. `EXPLAIN` on vprod 2026-09-05 shows two lookup joins: one into
`credentials@unique_messaging_account`, then a second into `credentials@primary`
to fetch `entity`. Free at 64 messaging rows (62 `facebook_page` + 2
`whatsapp_business`, vprod 2026-09-05). If it ever matters, the optimizer's own
recommendation is `CREATE INDEX ON credentials (key) STORING (entity)`. **This
claim was wrong in this plan and in `documentation/platform-resolution.md` §3;
both corrected 2026-09-04.**

**A tension worth recording, and not resolving by pretending it is absent.**
`multi-platform-plan.md` W2 says: *"`credentials` CASCADES on user delete, so
resolve and store, never derive at read time."* **Task B derives at read time,
every sweep.** It should ship — it stops the incident — but it is **a mitigation
with a known lifetime, not the end state.** The durable answer is that the row
carries its own correct platform, which is exactly what Task E restores.

**Tests.** `dean/README.md` §Testing:

```bash
cd devops && make test-db PORT=5433
cd dean && go test -v
```

`dean/test_helpers.go:35` points `testPool()` at
`postgres://root@localhost:5433/chatroach`. The harness already seeds
`credentials` (`pageInsertSql` in `queries_test.go` inserts a `facebook_page`
row), so a `whatsapp_business` variant is a small addition. `before()`
(`test_helpers.go:56`) resets `states, survey_settings, surveys, users` and
relies on the FK CASCADE to clear `credentials`.

⚠️ **`Timeouts` has an undocumented `ORDER BY … LIMIT 1`.**
`dean/queries.go:275`: when `cfg.TimeoutBlacklist` is empty the query gains
`ORDER BY calculated_timeout_date DESC LIMIT 1`; when it is non-empty it does
not. A naively-written multi-fixture test on the empty-blacklist path therefore
sees one row and **silently tests almost nothing**. It looks like a debug
leftover. Record it as its own follow-up — do not fix it inside Task B.

Required coverage, **for all seven queries** (the part most likely to be done for
only one or two):

1. `states.platform` NULL + `whatsapp_business` credential → emits `whatsapp`.
2. `states.platform` NULL + `facebook_page` credential → emits `messenger`.
3. `states.platform` NULL + **no** credential row → emits `messenger`, **and the
   row is still returned** (the CASCADE regression guard).
4. `states.platform = 'whatsapp'` + credential present → emits `whatsapp`.

> **Exodus (bail) platform resolution — DONE 2026-09-21**, exodus v0.2.8 / dashboard
> v0.0.78 (VIR-60, VIR-64, VIR-58; PR #178). Bails no longer guess: both bail types
> resolve from the owner's `credentials.entity` and an un-named bailout cannot be
> sent. dean's seven COALESCE sites are unchanged.

### Task C — DROPPED. message-worker needs no change.

**Decided 2026-09-05. Do not reopen without new evidence.**

The existing lookup is already right: `GetToken` queries
`WHERE entity = $1 AND key = $2` — the asserted identity — and refuses when it
finds nothing. That *is* the fail-loud behaviour the design wants. Task B removes
the only producer currently asserting a wrong platform; if this error fires
again it means a **new** producer is lying, which is precisely when a page is
warranted. Nothing in message-worker is at fault and nothing there needs
defending.

⚠️ **The original spec for this task is REJECTED AS HARMFUL — this is the one
idea to keep out of this file.** It proposed making `GetToken` fall through to a
key-only query on `pgx.ErrNoRows`, on the reasoning that "the credential is right
there". But by the time the token lookup runs, a wrong platform has already
branched message **translation** (`worker.go:130-157`) and selected the API
**client** (`worker.go:163`). Making the lookup *succeed* would hand a WhatsApp
access token to the Messenger client, which would POST a Messenger-shaped payload
to the Graph API — trading a clean failure for a confusing one and destroying the
only signal that a producer is lying. **Do not add the fallback.**

A more elaborate variant (resolve by `key`, read `entity` back, compare, refuse
on mismatch) was built and discarded: it looks the credential up by *less* than
its identity and validates after the fact, which inverts the rule that identity
is asserted and checked, never inferred. The plain `(entity, key)` lookup already
refuses on exactly the same input.

**Two findings from that discarded work are pre-existing, real, and independent
of it. Neither is fixed:**

1. `whatsapp_client.go` `PassThreadControl` is a **no-op returning `nil`**, and
   `processHandoff` routes by `cmd.Platform` exactly as sends do. A mis-routed
   handoff therefore **reports success while handing off nothing.** Own bug, own
   ticket.
2. `dinersclub/provider.go` `GenericGetUser` carries the identical
   mapped-entity-then-key-only shape — but it resolves *the researcher who owns
   the account*, which does not depend on platform at all. The entity narrowing
   excludes nothing and can only cause a miss, so the fix there is simply to drop
   the branch. dinersclub was the first occurrence of this bug class (2026-08-25)
   and was fixed as a **producer**; it remains a vulnerable **consumer**.

### Task E — Fix the erasure. ~~Snapshot-in-log.~~ **This is the root fix.**

> **RESOLVED 2026-09-05 — by a different design.** Task E ships on
> `fix/block-without-pointer` (`planning/block-without-pointer-plan.md`):
> `BLOCK_USER` sets **no pointer** and has **no `START` guard**, so a Redis-miss
> refold rebuilds the block from the full log with `md` and `forms` intact; an
> unbounded log is guarded by an explicit cap in `StateStore` (`HISTORY_LIMIT`,
> `STATE_STORE_LIMIT=10000`) instead of by the pointer. Snapshot-in-log
> (`fca55375`, PR #166) was implemented and abandoned: it needed a second HTTP round
> trip per block, ordering against botserver outages, a loop guard, a new error tag
> and a backfill, and every refold still read the post-block spam. The measurement
> that changed the decision: blocked users have short logs (max 6,209 events across
> 13,469 blocked conversations, vprod 2026-09-05), so the pointer bought nothing.
> Verified against a real blocked user: the new full refold reproduces the stored
> state exactly where the old pointer refold landed on `RESPONDING`/`fallback`.
>
> **E0 shipped separately** as `fix/restore-state-short-circuit` (`48e12233`
> cherry-picked); it is a regression fix in its own right and is not a
> prerequisite of the no-pointer design. **Task D is withdrawn** — no recovery
> pass is needed (see Task D below). The text that follows is the superseded
> spec, kept for the record.

**`planning/blocked-user-durability-handoff.md` § "Recommended approach:
snapshot-in-log" ~~is~~ was the ACTIVE SPEC for this work.** It was written 2026-07-25
against the Messenger-side symptom and its design is exactly right for the
WhatsApp fire. Read it; do not re-derive it.

The flow it specifies:

1. dean emits `block_user` as today.
2. replybot processes it, computes the trimmed blocked state, and emits a
   **`restore_state` synthetic event carrying that state**.
3. `RESTORE_STATE` (`machine.js:406-423` exec, `:717-721` apply) applies the
   snapshot and sets `pointer: nxt.timestamp`.
4. A later re-fold starts **at** the snapshot and rehydrates `USER_BLOCKED` with
   `forms` and `md` intact.

Plumbing exists end to end: `publishReport` (`replybot/lib/index.js:13`) POSTs
synthetic events to `${BOTSERVER_URL}/synthetic`, those land in `messages`, and
`categorizeEvent` maps `synthetic_restore_state → RESTORE_STATE`
(`machine.js:209`). Blocking and manual unblocking become the same mechanism with
different payloads.

**That doc already rejects the obvious alternative, for the right reason.** "Just
do not advance the pointer in `BLOCK_USER`" is wrong: *"replaying 30k spam events
in order to then trim them is precisely the OOM the pointer exists to prevent."*
The pointer advance is the garbage collection. So **the event must carry the
state, not derive it.**

*(`planning/md-platform-asymmetry-findings.md` §7 floats the no-pointer fix as a
"narrow fix". Prefer the handoff doc: it considered and rejected exactly that.)*

#### E0 — a PREREQUISITE the handoff doc does not know about

`planning/replybot-restore-state-transition-regression.md` documents that the
`RESTORE_STATE` short-circuit in `transition.js` `run()` was deleted by refactor
`675c31bd`, along with its tests. **That doc was written 2026-07-26 and says the
regression is staging-only and that production `v0.0.204` still has the correct
behaviour. That is now STALE — it has shipped.** Verified at the tags:

```
replybot-v0.0.204 :106   if (output.action === 'RESET' || output.action === 'RESTORE_STATE') {
replybot-v0.0.224 :139   if (output.action === 'RESET') {
```

Production runs **v0.0.224** (`kubectl get deploy -n vprod`, image
`ghcr.io/vlab-research/replybot:v0.0.224`, 2026-09-05). The working tree matches
v0.0.224 (`transition.js:139`), and
`grep -ci restore replybot/lib/typewheels/{machine,transition}.test.js` returns
**0 / 0** — there is no test that would catch it.

**So the recovery tool Task E depends on is currently degraded in production.** A
`RESTORE_STATE` output falls past the short-circuit into `actionsResponses()` and
performs the `getPageToken`/`getForm`/`getUser` IO the snapshot exists to skip.
Nothing is *sent* to the participant (`act()` has no `RESTORE_STATE` case), so
the failure mode is not a spurious message — but that IO **can throw**, and
`getForm(pageId, shortcode, startTime)` is precisely where a wrong or missing
`md.startTime` fails.

**E0 is:** restore the two-line short-circuit plus the explanatory comment from
`c30f755a`, and restore the tests `675c31bd` deleted (they are quoted in
`planning/replybot-restore-state-transition-regression.md` § "Proposed fix" and
`planning/restore-state-handover.md` §5). At minimum: the `run()` short-circuit,
restore from `USER_BLOCKED`, restore from `START`, and an assertion that
**`getForm` is not called** on a `RESTORE_STATE` transition — that last is the
specific property the refactor lost and the only one that would have caught it.

Doing Task E on top of the degraded short-circuit means every block does the IO
the design exists to avoid, at 11,492-conversation scale.

#### E's other constraints, from the handoff doc

- **Gap 2 (`HANDOVER_EVENT` has no `USER_BLOCKED` guard)** is part of the same
  work: making blocks durable while a handover can still wake a blocked user
  gives you a durable block that keeps getting poked.
- **Do not special-case the waking event.** `documentation/states-debugging.md`
  found 25% of Messenger cases were not handover-driven; the WhatsApp cases here
  are watermark- and text-driven.
- **Consider tagging `transition.js:48`'s throw** (e.g. `LOST_METADATA`) so a
  husk stops paging as a platform fault and leaves `DEAN_ERROR_TAGS`. Read
  `documentation/states-debugging.md` § "An `ERROR` state with a retryable tag
  was considered and is worse" first — that discussion is about a *different*
  refusal, and its conclusion (a new tag means nothing sweeps it) is the desired
  outcome here, not a hazard.

### Task D — WITHDRAWN 2026-09-05. ~~Recover the affected participants~~

> Under the no-pointer fix (Task E, `planning/block-without-pointer-plan.md` §7)
> nothing needs a `restore_state`. The ~13.5k `USER_BLOCKED` rows with a pointer
> land on a pointer-less `USER_BLOCKED` (no `forms`/`md`, harmless) on their first
> Redis miss after deploy and recover `forms` and `md` on the second, because the
> second refold is no longer truncated. The ~165 already-husked `ERROR` rows have
> no pointer today, so their first refold is already a full one; their cache entry
> only refreshes on a successful publish, so it expires within 24h of the deploy.
> What to watch: `states.platform IS NULL` for `USER_BLOCKED` rows falling, and
> `INTERNAL`/`getForm` errors on blocked users stopping. The `startTime` trap below
> is still true and still worth knowing for any *other* manual restore.
>
> Original text kept for the record:

~~REWRITTEN. Recover the affected participants (last, not urgent)~~

⚠️ **The original Task D does not work.** It cleared Redis to force a replay. But
**the truncation is `message_pointer` in Postgres, not the cache**: a cache miss
replays from the same pointer and rebuilds the same husk.
`devops/clear-state-cache.sh` is the right tool for the *phantom-key* half of bug
2 and is inert against bug 1.

**The good news: the same snapshot mechanism recovers them.** Two populations,
two difficulties:

**The 11,492 armed rows — easy.** They are still `USER_BLOCKED` and `md` is still
present in `state_json`. A `restore_state` can be built **directly from the
stored state**, with no reconstruction. This is a bulk emit through botserver's
`POST /synthetic`; `planning/restore-state-handover.md` §4 and §6.3 have the
mechanics from the last time this was done (127 participants, 2026-07), including
the byte-exact `content` extraction and the invalid-JSON tolerance that any
reconstruction script needs.

**The ~75 already-husked rows — hard.** `md` is gone, so the snapshot has to
*supply* one. And here is the trap:

> ⚠️ **`md.startTime` selects the survey version.** `getForm(pageId, shortcode,
> startTime)` resolves through formcentral's *most recent survey with that
> shortcode created at or before `startTime`*
> (`documentation/states-debugging.md` § "Formcentral and Time-Based
> Versioning"). **"Cheap seed state" and "picks the wrong form version" are the
> same knob.** A synthesized `startTime` silently moves a participant onto a
> different version of their own survey.

Recover `startTime` from real evidence — `form_start_time`, the `responses`
table, or a pre-block `machine_report` in `messages` — not from `now()` or from
the block timestamp.

**Speculative, and flagged as such:** it is *possible* that some of the ~66
corrupted-shortcode `FORM_NOT_FOUND` rows in §4 were manufactured this way
rather than by a mangled user-typed ref. **UNVERIFIED.** Do not act on it; do not
repeat it as fact. It is recorded only so that whoever investigates those rows
knows there are two candidate generators, not one.

**Sequence:** after B **and** E are deployed. Recovering before E just re-husks
them on the next TTL expiry.

---

## 8. Sequencing

| | why |
|---|---|
| **A → everything** | done. Its corrections are what stop the next person re-deriving all of this. |
| ~~**E0 → E**~~ | no longer an ordering constraint: E no longer emits snapshots. E0 ships on its own branch as a regression fix (2026-09-05) |
| ~~**E → D**~~ | D withdrawn 2026-09-05: under the no-pointer E the affected rows heal on their own Redis misses |
| **B → D** | clearing caches before the guess is fixed re-errors on the next sweep |
| **B, E independent** | different services; any order, or parallel |
| **A4 log capture → A4 disarm** | done in that order; the disarm prunes the Job and its logs |

**E is the root fix and B is the containment.** If only one thing ships this
week, ship B — it stops the paging half of the loop immediately and is already
written. But B alone leaves 11,492 armed conversations and converts a two-faced
loop into a one-faced one: after B, the husk rows stop alternating and sit
permanently on `User without metadata` / `STATE_ACTIONS`, still NULL, still
swept, still paging. **Say that out loud in the PR** so nobody reads a drained
`token not found` count as resolution.

B is a behavioural change to **every** Dean sweep in production. It warrants its
own PR and its own review.

---

## 9. Traps

- **The two bugs look like one.** They alternate on the same participants every
  30 minutes and present as disjoint populations at any instant. §4.
- **`token not found` rows have `states.platform = 'whatsapp'`, not NULL.** A
  `platform IS NULL` filter finds only the husk face.
- **`kubectl logs deploy/gbv-replybot` reads one pod of eight.** Use
  `-l app.kubernetes.io/name=replybot --max-log-requests=12 --tail=-1`, or you
  will under-count by ~8x and think the incident is subsiding. §1.
- **Hourly `states` row counts measure Dean churn, not new participants.**
  `updated` is sticky and every sweep rewrites the row. §4.
- **The replybot fallback is a decoy.** `utils.js:164-177` also assumes
  messenger, and it is *not* firing (`EVENT_PLATFORM_GUESSED` = 0 over 3h).
- **`md.startTime` picks the survey version.** Synthesizing one silently moves a
  participant onto a different form version. Task D.
- **A Messenger-only test cannot catch either bug** — `devops/values/production.yaml:126`
  already says so for bug 2, and §2's table says so for bug 1 (223 husks in six
  years on Messenger vs 75 in five days on WhatsApp). Any test must exercise a
  `whatsapp_business` account **and** a pointer-truncated replay.
- **`INNER JOIN` on `credentials` silently disables sweeps** for users deleted
  from `users` — except in `FollowUps`, where the downstream `surveys` join
  already does it. Task B.
- **Do not assert `states.platform = 'messenger'` in any test over historical
  rows.** `facebot/testrunner/test.tc.ts:1380-1394` documents exactly this trap:
  such a check *"matches 6 rows in production, not 3,826."*
- **`states` PK is `(userid, pageid)`, with no platform**, while Redis keys
  include it. Two cache identities collapse onto one DB row.
- **Migration 26's REMOVAL GATE is a deliberate ~384 GiB scan**
  (`devops/migrations/26-messages-account.sql:154-165`). Do not run it casually.
- **`kubectl` reads are fine; mutations are not.** `CLAUDE.md`: everything is
  infrastructure as code. The outstanding `messagesBackfill.enabled: false` is an
  applied `helm upgrade` from the values file, never a `kubectl edit`.

---

## 10. Verification — the gates, rewritten

⚠️ **The gates in the first version of this plan were wrong and would have
misled.** Gate 1 counted `s.platform IS NULL`, but Task B changes what Dean
**emits**, not what is **stored** — so it can never reach zero. Gate 2 counted
only `token not found`, which Task B *does* eliminate — so it drains to zero and
reads as success while the `User without metadata` half of the same 165
participants stays broken. Both are replaced.

Capture a baseline before each task ships. All queries: vprod, read-only.

### G1 — Dean's emitted platform (gates Task B)

Task B changes an emission, so verify the emission, not the table.

```bash
# A Dean sweep must never stamp 'messenger' on an account whose credential
# is whatsapp_business. Target: zero.
kubectl logs -n vprod -l app.kubernetes.io/name=replybot --since=1h \
  --max-log-requests=12 --tail=-1 \
  | grep '"source":"synthetic"' \
  | grep '"account_id":"1203867182815254"' \
  | grep -c '"platform":"messenger"'
# baseline 2026-09-05: non-zero (every 30 min sweep)
```

Unit-level, and cheaper: `dean`'s own tests, coverage items 1–4 in Task B, run
for **all seven** queries.

### G2 — the whole error population, not one face of it (gates B AND E)

```sql
SELECT
  CASE WHEN state_json->'error'->>'message' LIKE '%token not found%'      THEN 'token_not_found'
       WHEN state_json->'error'->>'message' LIKE 'User without metadata%' THEN 'user_without_md'
       WHEN error_tag='INTERNAL' AND state_json->'error'->>'message' LIKE '%getForm%' THEN 'getForm_husk'
  END AS face,
  count(DISTINCT userid)
FROM states
WHERE pageid='1203867182815254' AND current_state='ERROR'
  AND (state_json->'error'->>'message' LIKE '%token not found%'
    OR state_json->'error'->>'message' LIKE 'User without metadata%'
    OR (error_tag='INTERNAL' AND state_json->'error'->>'message' LIKE '%getForm%'))
GROUP BY 1
UNION ALL
SELECT 'UNION', count(DISTINCT userid) FROM states
WHERE pageid='1203867182815254' AND current_state='ERROR'
  AND (state_json->'error'->>'message' LIKE '%token not found%'
    OR state_json->'error'->>'message' LIKE 'User without metadata%'
    OR (error_tag='INTERNAL' AND state_json->'error'->>'message' LIKE '%getForm%'));
-- baseline 2026-09-05 00:20 UTC:
--   token_not_found  97 | user_without_md 54 | getForm_husk 14 | UNION 165
```

**Read the UNION row, not the faces.** After **B**: `token_not_found → 0`, and
the other two go **up** by roughly that amount as participants stop alternating.
The UNION must be flat, not falling — if it falls after B alone, something else
changed and you should find out what. After **E**: the UNION stops growing. After
**D**: it drains.

### G3 — the husk population, armed and fired (gates E)

```sql
-- ARMED: conversations one TTL expiry away from becoming husks.
SELECT c.entity, count(*) FROM states s
JOIN credentials c ON c.key=s.pageid AND c.entity IN ('facebook_page','whatsapp_business')
WHERE s.current_state='USER_BLOCKED' AND s.message_pointer IS NOT NULL GROUP BY 1;
-- baseline 2026-09-05: whatsapp_business 11,492 (1 account); facebook_page 2,012 (34)

-- FIRED: rows whose md is actually gone.
SELECT c.entity,
       CASE WHEN s.state_json->'md' IS NULL THEN 'md_absent' ELSE 'md_empty' END,
       count(*), max(s.updated)
FROM states s
JOIN credentials c ON c.key=s.pageid AND c.entity IN ('facebook_page','whatsapp_business')
WHERE s.platform IS NULL AND (s.state_json->'md' IS NULL OR s.state_json->'md'='{}'::jsonb)
  AND s.current_state='ERROR'
GROUP BY 1,2;
-- baseline 2026-09-05: whatsapp_business md_absent 61, md_empty 14 (75 total)
--                      facebook_page     223 total, newest 2026-07-24 (six years' accumulation)
```

**After E, ARMED may stay high** — E is a forward fix; it stops new husks, it does
not disarm existing blocked rows until D runs or they are re-blocked. **FIRED's
`max(updated)` is the real gate: it must stop advancing.**

### G4 — no new mislabelled sends appear (Task C was dropped)

There is no mismatch tag: message-worker is unchanged, so a wrong platform still
surfaces as `token not found for platform account`. That string IS the gate --
after Task B it must go to zero and stay there. If it returns, a **new** producer
is asserting a platform it guessed; find that producer, do not soften the error.

```bash
kubectl logs -n vprod -l app.kubernetes.io/name=replybot --since=1h \
  --max-log-requests=12 --tail=-1 | grep -c "token not found for platform account"
```

### G5 — the raw log volume (both bugs)

```bash
kubectl logs -n vprod -l app.kubernetes.io/name=replybot --since=3h \
  --max-log-requests=12 --tail=-1 > rb.log
grep -c "User without metadata"                   rb.log   # baseline 09-05 00:25: 561
grep -c "token not found for platform account"    rb.log   # baseline 09-05 00:25: 310
```

Moving baseline, and it has escalated: `token not found` was **110 per 3h** on
09-03 and **298–310 per 3h** on 09-04/05. Re-measure before comparing.

### G6 — alerts

```promql
ALERTS{alertstate="firing", component="study-health"}
sum by (error_tag, form) (survey_error_states{error_tag=~"INTERNAL|STATE_ACTIONS|NETWORK"})
```

2026-09-05 00:26 UTC: `PlatformInternalErrors` (critical) and
`SurveyErrorSpike{form="vlpulseng"}` firing;
`STATE_ACTIONS{form="vlpulseng"} = 13`, `STATE_ACTIONS{form="(none)"} = 13`,
`INTERNAL{form="(none)"} = 4`.

The metric is a 1h window fed by `sql_exporter` and scraped every 1m
(`documentation/study-error-alerting.md`), so allow ~1h after any change before
reading an alert as resolved.

### G7 — no phantom cache keys for new conversations

```bash
DRY_RUN=1 devops/clear-state-cache.sh vprod ids.txt   # expect 1 key/participant, not 2
```

---

## 11. Open questions — decide, do not silently pick

1. **Should `credentials` win over `states.platform`, or the reverse?** Task B
   recommends credential-first: the credential is a direct observation of the
   fact, the computed column is derived from `md` written at conversation start.
   They should agree; when they do not, the credential is the stronger evidence.
   Write the reasoning into the code comment either way.
2. **Should a missing credential still default to `messenger`?** Keeping it
   preserves today's behaviour for un-credentialed pages. Removing it makes Dean
   skip those conversations entirely. Recommendation: keep, and log.
3. **RESOLVED 2026-09-05 — Task C is dropped; message-worker is not changed.**
   The existing `(entity, key)` lookup already refuses a wrong platform, which is
   the fail-loud behaviour wanted. There is therefore no new tag and no counter
   to scope. If a tripwire is ever wanted, note that
   `dinersclub/chart/templates/servicemonitor.yaml` is currently the **only**
   application service Prometheus scrapes (`documentation/alerting.md` §12), so
   it is real work, not a one-line metric.
4. **Should `transition.js:48`'s throw get its own tag (`LOST_METADATA`)?** It
   would stop the husk paging as a platform fault and remove it from
   `DEAN_ERROR_TAGS`. It also means *nothing* sweeps it — which is the desired
   outcome here, but read `documentation/states-debugging.md`'s counter-argument
   first. Decide as part of Task E.
5. **Why were 11,492 conversations on one account blocked around 2026-09-01?**
   Dean's `Spammers()` selects on either 25 identical QA answers or
   `externalEvents > DEAN_SPAMMER_EXTERNAL_EVENTS_MAX`. Which branch fired, and
   whether 79% of an account's conversations *should* be blocked, is
   **UNVERIFIED** and looks like its own investigation. It is the reason the
   reservoir exists.
6. **What generates the ~66 corrupted shortcodes and 14 `REF_DECODE` rows?**
   §4. `fix/vir-35-encoded-ref-guard` may be related. Its own investigation; do
   not fold it into this one.
7. ~~**W1 is unassessed.**~~ **ANSWERED 2026-09-04 —
   `planning/w1-legacy-webview-audit.md`.** The verdict: **W1 is NOT closeable.**
   802 legacy hand-authored `webview` fields across 131 current surveys, of which
   110 fields / 53 surveys are on a live host, 92 carry a literal hardcoded
   account id, and 49 `wait` on the tracked event (so they hang rather than
   degrade). **Zero of the 802 carry any platform parameter.** Read that file;
   it also records two further firings of the 2026-08-13 hazard. Still out of
   scope for *this* plan — it is a separate producer class from Dean — but it is
   no longer an open question.

---

## 12. Out of scope

- Backfilling `states.platform` / `state_json.md.platform` (§6).
- The corrupted-shortcode `FORM_NOT_FOUND` and `REF_DECODE` populations (§4, Q6).
- Why the 11,492 were blocked (Q5).
- `messages.platform` NOT NULL — the parent plan explicitly retires this goal.
- The `pageid → account_id` rename (parent plan 3.4).
- Phases 2.1/2.2 themselves, beyond the gap already recorded in the parent plan.
