# Conversation identity: a conversation is (platform, account_id, user_id)

**Status:** **implemented.** Written as a proposal 2026-08-16; consolidated against the
shipped work 2026-08-17. §7.1, §7.2, §7.3, §7.4, §7.5, Appendix A and **Appendix B** are built
and verified on branch `feature/conversation-identity`; §7.6 (the messaging account registry)
was designed, built and then **deliberately reverted** in `5c4cab3e` — the conversation triple
never needed it, and the create endpoint that would have populated it correctly does not exist
yet — see §7.6. The full implementation is archived on
`origin/archive/messaging-accounts-registry`. §7.7 is untouched by design. **Nothing is deployed
to production.** The remaining work — including two items that are regressions rather than
enhancements — is enumerated in **§8**.
**Severity:** kills live conversations permanently; leaks data across researchers.
**Verified against:** live `chatroach` production, replybot `v0.0.218`, hermes, scribble,
message-worker, dinersclub, exodus, linksniffer, dashboard-server, live pod logs 2026-08-16,
production sizing and counts re-measured 2026-08-17.

Replybot keys a participant's conversation by **user id alone**. A conversation is actually
identified by the tuple `(platform, account_id, user_id)`. The consequence is not subtle:
it kills conversations permanently and writes one researcher's participant data into
another researcher's account scope.

> ### How to read this document
>
> It is no longer a proposal. It is the record of a completed piece of work plus the open
> items that remain. Several of its original claims turned out to be **false**, and in each
> case the original reasoning is **preserved verbatim** with a `CORRECTED` amendment beside
> it rather than deleted. That is deliberate: a reader needs to see that a claim was made,
> tested and revised, because that is what stops the same wrong conclusion being re-derived
> from first principles six months from now. (§5's own registry section does not follow this
> convention — it describes a table that was built and then removed outright, so it is
> deleted-and-pointed-at-the-archive rather than preserved-with-a-correction; see §5 and §7.6
> for why.)
>
> The corrections register that drove this pass is
> `planning/conversation-identity-test-plan.md` §0.9. Where a number here came from a
> production query, it says so.

**Companion documents.** `planning/conversation-identity-test-plan.md` (the test contract and
the corrections register), `planning/whatsapp-webview-exposure.md` (production measurement of
the linksniffer/webview exposure), `documentation/event-envelope.md`, and
`documentation/chat-message-logging.md`. (`documentation/messaging-accounts.md` and the
reversal amendment it drove in `documentation/platform-abstraction.md` were removed along with
the registry in `5c4cab3e`; see §7.6.)

---

## 1. Evidence

### 1.1 Reproduced live, 2026-08-16 — deterministic

Captured from `gbv-replybot-74d4dbb88-k8kz8` logs during a deliberate reproduction.

**18:21:03** — a Click-to-WhatsApp ad entry lands on the **541** number
(`1203867182815254`) for user `15419799714`. It resolves to `FALLBACK_FORM=305`
(a separate defect — Appendix A), runs to `END`, and writes that state to the Redis key
`state:15419799714`.

**18:34:40** — the same person taps a button in their live `misinfogame` conversation on
the **202** number (`1265380589988964`). Replybot reads `state:15419799714` and is handed
the *541* conversation:

```
STATE:  { state: 'END',
  forms: [ 'misinfogame', '305' ],
  md: { form: '305', pageid: '1203867182815254', ... },    <- the OTHER account
  question: 'b485a02d-92ab-48a4-8f75-3a99ac7bf339' }       <- a form-305 field
```

The button press is recorded as an answer to that form-305 field, and the field is then
looked up in the form the 202 conversation is actually on:

```
FIELD_NOT_FOUND: Could not find the requested field, b485a02d-…, in our form: xleHnFWa
  at getField (form.js:185) -> _response (machine.js:935) -> act (machine.js:764)
```

The conversation goes to `ERROR` and **stays there**. `FIELD_NOT_FOUND` is not in
`DEAN_ERROR_TAGS` (`NETWORK,INTERNAL,STATE_ACTIONS`), so no sweep retries it, and the
corrupt state is served from cache indefinitely because every touch refreshes the 24h TTL.
Only `devops/clear-state-cache.sh` recovers the participant.

> #### CORRECTED 2026-08-17 — the mechanism is form STITCHING, and `FIELD_NOT_FOUND` is one of at least two signatures
>
> Reproduced in the integration harness (test-plan finding (10)) against the real stack:
> one participant, researcher A's page `935593143497601` with `isoFormA`, researcher B's
> page `811223344556677` with `isoFormB`. Verbatim from replybot:
>
> ```
> newState: {
>   state:    "RESPONDING"  ->  "ERROR",
>   forms:    ["isoFormB", "isoFormA"],          <- BOTH researchers' forms, one conversation
>   qa:       [["isoa_q1", "Excellent"]],        <- form A's field ref holding form B's choice label
>   md:       { form: "isoFormA", pageid: "935593143497601", platform: "messenger" },
>   question: "isoa_q1"
> }
> error: FORM_NOT_FOUND — "Survey with shortcode isoFormA at timestamp 1786977773569
>         for page 811223344556677 could not be found."   (ourform.js:42)
> ```
>
> Three things this shows that the text above states only abstractly:
>
> 1. **The two conversations do not overwrite each other — they MERGE.** `forms:
>    ["isoFormB","isoFormA"]` is both researchers' forms stitched into one form stack,
>    because the shared cache key makes them look like one conversation. The merged stack
>    then drives form resolution, which is worse than an overwrite.
> 2. **Answer misattribution is literal, not theoretical.** `qa` holds
>    `["isoa_q1","Excellent"]` — `isoa_q1` is researcher A's field ref, `"Excellent"` is
>    researcher B's choice label. One researcher's field is holding another researcher's
>    answer. §2.2 item 2 argued this reaches response attribution; here it is shown.
> 3. **`md.pageid` and the arriving account disagree**, which is what 404s the `getForm`
>    call: A's shortcode looked up against B's page.
>
> **`FORM_NOT_FOUND` is the second terminal signature.** Same mechanism, one step earlier
> than the live incident: because the harness fixture puts the two forms under *different
> researchers*, form resolution fails before the machine reaches `getField`. In the live
> incident both forms resolved, so the failure surfaced one layer down at `form.js:185`.
> **Neither tag is in `DEAN_ERROR_TAGS`**, so both are equally terminal and equally
> un-healed by a deploy. Any regression test must assert on both.

### 1.2 The same shape, three days earlier

User `15126808320` sent `form.hpvbl` to the **541** number at 18:58:59 on 2026-08-13.
`hpvbl` belongs to `worldbank@vlab.digital`, who owns the **202** number, so formcentral
correctly 404s — that part is not a bug:

```
Survey with shortcode hpvbl at timestamp 1786647539000 for page 1203867182815254 could not be found.
```

At 22:23:34 the same person messaged the **202** number, and the row
`(15126808320, 1265380589988964)` was overwritten with the 541 conversation's error
**verbatim** — same `error.ts` (1786647541652), same `pointer` (1786647529000), and an
`error.message` naming the *other* account's id.

### 1.3 Production exposure

```sql
SELECT userid, count(DISTINCT pageid) FROM chatroach.states
GROUP BY userid HAVING count(DISTINCT pageid) > 1;
-- 1,911 users; 3,831 state rows
```

**3,826 of those rows are `platform = 'messenger'`**; 5 are WhatsApp. The dominant pattern
is one historical overlap — 1,892 users hold state on *both* `108799718170394`
("دراسة التلقيح - العراق") and `1855355231229529` ("Virtual Lab").

> #### CORRECTED 2026-08-17 — the platform split above presents an INFERENCE as a MEASUREMENT
>
> Re-run against production, scoped to the same multi-account cohort:
>
> | `platform` | rows | users |
> |---|---|---|
> | **`NULL`** | **3,820** | 1,907 |
> | `messenger` | 6 | 4 |
> | `whatsapp` | 5 | 2 |
>
> So it is **not** the case that 3,826 rows *are* `platform = 'messenger'`. **3,820 have a
> NULL platform**; only **6** are literally `messenger`. The rows reconcile exactly
> (3,820 + 6 + 5 = 3,831). The user column sums to 1,913 against the cohort's 1,911 distinct
> users because a participant holding both a NULL-platform row and a non-NULL one is counted
> in two buckets — expected, given the cohort is *defined* by spanning accounts.
>
> **§1.4's conclusion is unaffected, and this correction must not be read as undermining
> it.** `states.platform` is a computed column over `state_json->'md'->>'platform'`, and the
> §7.2 stream verified independently that **every** `states` row on a `whatsapp_business`
> account carries a non-NULL platform. So NULL means "predates the `md.platform`
> persistence," and everything predating that persistence is Messenger. Messenger really has
> been colliding all along.
>
> What changes is the **provenance of the number**: it is NULL-and-inferred-Messenger, not
> measured-Messenger. The original text asserted the inference as a reading of the data,
> which is the same category of error this whole pass exists to remove — and the same one
> that produced §2.3's `platform IS NULL` warning against treating NULL as `messenger` in a
> canary. The distinction is that §1.4 has an independent argument for the inference and a
> canary would not. The 1,892-user Iraq/Virtual-Lab overlap in the sentence above is a direct
> `pageid` measurement and needs no such caveat.

**Only 14 of the 3,831 rows were updated in the last 30 days.** With a 24h Redis TTL,
almost none has a cached key at all — so the cost of abandoning old cache keys in §7.1 is
about one replay for anyone active in the last day.

Repairing the 1,892 dormant Iraq/Virtual-Lab rows is out of scope: that study's last
activity was 2026-06-18.

For scale in the other direction: 1,911 of 1,090,149 users — **0.175%** — have ever spanned
two accounts (production, 2026-08-17). That ratio is why §7.4's cross-account collision fear
turned out not to justify its cost; see §7.4's amendment.

### 1.4 Messenger has been colliding all along

A Messenger PSID is documented as page-scoped, which would make a user-keyed cache
conversation-keyed by accident. §1.3 shows that is not what production looks like: 3,826
Messenger state rows span multiple accounts.

> **CORRECTED 2026-08-17 — the conclusion stands; the number is inferred, not measured.**
> 3,820 of those rows carry a **NULL** `platform` and 6 carry `'messenger'` literally. NULL
> means the row predates `md.platform` persistence, and everything predating it is Messenger —
> independently corroborated by every `whatsapp_business` row carrying a non-NULL platform. So
> "3,826 Messenger state rows span multiple accounts" is correct as a conclusion and wrong as
> a citation. See §1.3's amendment.

WhatsApp did not introduce this. It made it *reproducible on demand*, because `wa_id` is
the participant's phone number and is identical across every business number they message.

This sets the scope: the fix must be general, not a WhatsApp special case. SMS
(`sms-sender/`), Telegram, RCS and email all identify the user by a global address, so
every platform we add next behaves like WhatsApp, not like Messenger.

---

## 2. Root cause

### 2.1 Where identity is and is not carried

Full-system inventory, verified against live schema and code.

**Already correct — no work needed:**

| Thing | Evidence |
|---|---|
| `SendMessageCommand` | `message-worker/types/command.go:23` — `Platform`, `PlatformAccountID`, `UserID` |
| `PaymentEvent` | `dinersclub/provider.go:28-35` — `Userid`, `Pageid`, `Platform` |
| `states` | `PRIMARY KEY (userid, pageid)` + `platform` computed column (migration 21) |
| `media_handle` | `(asset_id, account_id, platform)` — built as the tuple from the start |
| dean's `ExternalEvent` | `dean/queries.go:19` — user, page, platform |
| dashboard `states` scoping | `states.queries.js:53` — scopes by `pageid IN (owner's accounts)` |

The outbound half of the system is already tuple-native. The inbound, log and state half is
not.

**Broken:**

| Layer | Key today | Fixed in |
|---|---|---|
| Redis state cache | `state:${user}` — `statestore.js:64-66` | §7.1 |
| `scribble` state dedup | `dataMap[state.UserID]` — `state.go:37` | §7.2 |
| `responses` conflict key | `ON CONFLICT(userid, timestamp, question_ref)` | §7.2 |
| `chat_log` conflict key | `ON CONFLICT(userid, timestamp, direction)` | §7.2 |
| exodus bail targeting | `SELECT DISTINCT userid FROM responses`, joined `ON s.userid` | §7.2 |
| event envelope | account implicit on Messenger; no `platform` field | §7.3 |
| `messages` table | `userid` only; no account column at all | §7.4 |
| `messages` conflict key | `ON CONFLICT(hsh, userid)` — `message.go:35` | §7.4 |
| `chatbase.get()` replay | `WHERE userid = $1`, LEFT JOIN `states` on `userid` | §7.5 |

Three of these are silent-data-loss bugs, not just mis-scoping:

- **`scribble/state.go:37`** — `DedupStates` keys its map by `state.UserID` alone. A batch
  containing state for one user on two accounts keeps **one**. Same bug as the Redis cache,
  reimplemented in Go.
- **The three `ON CONFLICT` clauses** exclude the account **even where `pageid` already
  exists on the table**. Colliding rows are not errors — they are discarded. `chat_log`'s
  `(userid, timestamp, direction)` at second granularity is the most exposed.
- **`exodus/query/builder.go:184,226,232`** — bail targeting builds CTEs over `responses`
  aggregated across *all* accounts and joins them to account-scoped `states` rows
  `ON s.userid = rt.userid`. A participant's answers on number A can qualify them for a
  bail on number B.

> #### CORRECTED 2026-08-17 — the `md`-fallback inventory was incomplete. There were THREE, not one.
>
> §7.1 forbids recovering any component of the conversation from `state.md`, and the text
> below cites only the platform recovery. Two more existed, both in
> `replybot/lib/typewheels/transition.js` (line numbers as of `798976ea`, the commit this
> document was written against):
>
> | # | Site | Recovered from `md` | Why it mattered |
> |---|---|---|---|
> | 1 | `transition.js:36-37` | `state.md.platform` | the one already documented below |
> | 2 | **`transition.js:27`** | **`state.md.pageid` — the ACCOUNT** | **worse than #1** |
> | 3 | **`transition.js:61`**, in `actionsResponses` | `newState.md.platform` for the payment event | `(newState.md && newState.md.platform) \|\| 'messenger'` |
>
> **#2 is the serious one, and it is the one the original inventory missed.**
>
> ```js
> // transition.js:27
> const page = parsedEvent.source.account_id || (state && state.md && state.md.pageid)
> ```
>
> That `page` is what `getForm(pageid, shortcode, timestamp)` **and the outbound command**
> are built from. So a bled state does not merely mis-scope a read — it routes the
> participant's *outbound* messages through another researcher's page. It is the same class
> of bug as #1, on the account rather than the platform, on the write path rather than the
> read path.
>
> All three are removed on this branch: `transition.js` now reads
> `parsedEvent.source.account_id` and `eventPlatform(parsedEvent)` with **no** `md`
> fallback, and the payment platform is threaded as a parameter rather than recovered.
> Removing #2 was only possible because §7.3 made synthetic events carry the account — which
> is the circularity §3.1 describes, in its concrete form.

### 2.2 Consequences, ranked

1. **Conversation death** (§1.1). Deterministic, immediate, terminal for that participant,
   and un-healed by any deploy because the cached state outlives it.
2. **Cross-researcher data leakage.** The `qa` transcript, `md` (including payment fields)
   and `error` payload of researcher A's participant land in a row scoped to researcher
   B's account — which is exactly what the dashboard `states` queries use to scope
   visibility by owner. Answers are recorded against the *other* survey's field ids, so
   this reaches response attribution, not just observability.
3. **Replay mixes accounts.** On a cache miss, `_getEvents` replays *every* event for the
   user id — both conversations interleaved — because `messages` cannot distinguish them.
4. **Multi-row join.** `chatbase.get()`'s
   `LEFT JOIN (SELECT userid, message_pointer FROM states WHERE userid = $1) USING (userid)`
   returns one row per account the user has state on. Message rows are duplicated N times
   in the replay, and the `message_pointer` checkpoint passes if **any** account's pointer
   allows it — so `form.reset` on one number silently stops truncating history on another.
5. **Silent row loss** in scribble, and mis-targeted bails in exodus (§2.1).

> #### CORRECTED 2026-08-17 — items 1 and 2 understate the mechanism
>
> Item 1's "conversation death" and item 2's "land in a row scoped to researcher B's
> account" both describe **overwriting**. The observed mechanism is **stitching**: the two
> conversations merge into one form stack (`forms: ["isoFormB","isoFormA"]`), and that merged
> stack is what drives subsequent form resolution. Item 2's "answers are recorded against
> the other survey's field ids" is exactly right and is now demonstrated rather than argued —
> `qa: [["isoa_q1","Excellent"]]`, one researcher's field ref holding another's choice
> label. See §1.1's amendment for the verbatim capture.

### 2.3 Incidental data-quality findings

Not part of this work; recorded so they are not lost.

- `states.pageid` contains malformed values: `'107718334922830` (leading apostrophe) and
  `111108121363615%26device_id%3D5b9385ab-...` (URL-encoded query fragment).
- `userid = 101435865704727` is the *page id* of "Our World In Surveys" appearing as a user
  id, with state on 10 distinct pageids. Likely the echo-parse path
  (`parseMessengerEvent` swaps user/page for echoes) writing a page as a participant.

> #### EXTENDED 2026-08-17 — the list above is a small fraction of it, and one entry is 74 participants
>
> Full census from production 2026-08-17 (`planning/whatsapp-webview-exposure.md` § Dirt —
> `states.pageid` values that are not a `facebook_page`/`whatsapp_business` credential key,
> grouped, `LIMIT 25`):
>
> | pageid | participants | last activity | note |
> |---|---|---|---|
> | `1.07718E+14` | **74** | 2024-11-23 | **Excel scientific notation** of the documented `'107718334922830` — same page, entered twice, wrong both times |
> | `156222641066477` | **55** | 2026-06-22 | plausible page id shape; no credential — deleted? |
> | `253917574462129` | 4 | 2024-03-02 | |
> | `324090` | 3 | 2024-09-19 | far too short to be a page id |
> | `1134338372` | 2 | 2026-08-05 | 10 digits; also hardcoded into `kenya_tvet_bl`'s webview URLs. **Real, current, and wrong.** |
> | `456` | 1 | 2026-08-09 | far too short |
> | `105246245358509)` | 1 | 2022-10-26 | trailing paren |
> | `'107718334922830` | 1 | 2024-10-08 | already documented above |
> | `111108121363615%26device_id%3D…` | 1 | 2023-08-04 | already documented above |
> | 10 × `5xxxxxxxxxxxxxxx` | 1 each | 2022-11-08 | **16-digit, all on one day** — the shape of a Messenger **PSID**, not a page id |
>
> Two things worth extracting:
>
> - **The two entries the original list named are the two *smallest*.** `'107718334922830`
>   affects one participant; its Excel-mangled twin affects 74, and
>   `156222641066477` affects 55. Anything that repairs this data must be sized against the
>   census, not against the two examples.
> - **The ten 16-digit `5…` values corroborate the echo-parse hypothesis.** Sixteen digits
>   starting `5` is PSID-shaped, and PSIDs appearing in the *page* column is the mirror image
>   of the second bullet above (a page id appearing in the *user* column). Both are what
>   `parseMessengerEvent`'s echo inversion produces if it runs on the wrong branch, and they
>   cluster on a single day — one bad deploy window rather than a steady leak.
>
> Also from the same measurement, relevant to §7.1's canary: **the overwhelming majority of
> `states` rows have `platform IS NULL`** — only rows touched since ~2026-08-05 carry a
> value. Any canary reading `states.platform` must treat NULL as *unknown*, not as
> `messenger`. (`exodus` does exactly the opposite, deliberately — see §8.)

---

## 3. The identity to adopt

```
conversation = (platform, account_id, user_id)
```

### 3.1 The triple is carried as a triple, everywhere

Every layer that identifies a conversation carries all three components. No layer carries a
subset and re-derives the rest.

| Layer | Carries the triple as | Phase |
|---|---|---|
| event envelope | `platform`, `account_id`, user (per-shape) | §4.2 / §7.3 |
| Redis state cache | `state:{platform}:{account_id}:{user}` | §7.1 |
| `messages`, `responses`, `chat_log` | `platform`, `account_id` columns | §7.4 |
| replay (`chatbase.get`) | `(platform, account_id, userid)` | §7.5 |
| `states` | `(userid, pageid)` + `platform` | already correct |
| commands, payments | `Platform`, `PlatformAccountID`, `UserID` | already correct |

**The one thing that makes this possible is §7.3.** Today, synthetic and external events
(dean timeouts, dinersclub payment results, replybot's own `machine_report`) carry
`source: "synthetic"`, and only dean also sends the conversation's real `platform`. That is
why `transition.js:36` has to recover the platform from `state.md.platform` — from the state
being fetched. Any layer keyed on the triple before §7.3 would be circular: it needs the
platform to find the state, and the platform is in the state.

§7.3 removes that by making `platform` mandatory on every event. **§7.3 is therefore a hard
prerequisite for §7.1**, and the order of work reflects it.

`platform` is *also* a property of the account the researcher connected, but there is no
registry to check it against: the messaging account registry that would have been that
enforcement point (§5) was built and then deliberately reverted — see §7.6. Today the
envelope's `platform` is trusted as sent, not derived: each of §7.3.1's posters already knows
which platform it runs on and sends it as a plain field, the same way it sends `account_id`.
`platform` is also stored on the log tables (§7.4) because those are archival —
`credentials` cascades on user delete, so a deleted researcher would otherwise strip the
platform binding from history.

`source` and `platform` are different fields and both stay. `source` says where the event
came in from (`messenger` | `whatsapp` | `synthetic`); `platform` says what transport the
conversation runs on (`messenger` | `whatsapp`). They differ exactly on synthetic events —
which is the whole reason `platform` has to be sent explicitly rather than inferred from
`source`.

> **Note on the table above:** the "already correct" row for `states` is why §7.5's join had
> to be written against `states.pageid` rather than `states.account_id`. §7.7's rename is
> load-bearing for more than cosmetics — see §7.5's amendment.

### 3.2 Naming: `account_id` and `platform`, never `pageid`

Migration 22 set the direction — `facebook_page_id` → `account_id` on `media` and
`message_templates` — and `media_handle` was built as `(account_id, platform)`. All new
columns and fields follow that. `states.pageid`, `responses.pageid` and `chat_log.pageid`
are the legacy holdouts; renaming them is §7.7.

---

## 4. The event envelope

`chat-events` is produced only by hermes, which is the single ingester: `botserver.enabled:
false` in both `devops/values/production.yaml:627` and `staging.yaml:576`, hermes serves
`/webhooks`, `/whatsapp`, `/synthetic` and `/health` (`handlers.rs:77-82`), and all six
`BOTSERVER_URL` values point at `http://gbv-hermes/synthetic`.

> #### CORRECTED 2026-08-17 — "`chat-events` is produced only by hermes" is FALSE. There are THREE producers, two of them live, and the second live one was writing unstamped events.
>
> **What survives the correction:** hermes *is* the single **ingester**, and that is true of
> **every live environment**, without qualification. The two live namespaces are `vprod` and
> `vstag`; both disable botserver and both point every `BOTSERVER_URL` at hermes. There is no
> live environment with a hole in it.
>
> **What is false** is the inference from that to "hermes is the only producer". A service can
> publish to the topic without ingesting anything, and one does.
>
> This is the load-bearing claim of the whole section, and everything downstream of §4.2 —
> "both fields are required on every event", "no consumer falls back", "a missing field is a
> loud failure" — rests on it. It is wrong. It was checked by reading *ingress config*
> (`botserver.enabled: false`, where `BOTSERVER_URL` points) rather than by grepping for
> *producers*, and a service that publishes to the topic without being an ingester is
> invisible to that check.
>
> Found by the first end-to-end integration run, not by review.
>
> | Producer | Produce site | Topic resolution | Stamps the envelope? | Deployed |
> |---|---|---|---|---|
> | `hermes` | `hermes/src/handlers.rs:187`, `:268`, `:409` via `producer.rs:51` | `BOTSERVER_EVENT_TOPIC` ← `*topic` (`production.yaml:697`) | yes, all three shapes | **live** — `vprod` + `vstag` |
> | **`message-worker`** | **`worker.go:181` → `kafka.go` `PublishRawEvent`** | **`KAFKA_EVENT_TOPIC` (`config.go:60`, default `chat-events`) ← `*topic` (`production.yaml:853`)** | **NO — fixed 2026-08-17** | **live** — `vprod` + `vstag` |
> | `botserver` | `botserver/server/handlers.js:41`, `:80` | `BOTSERVER_EVENT_TOPIC` ← `*topic` | **no, and never did** — closing that gap is why hermes exists | **nowhere.** Disabled in both live environments; enabled only in undeployed config |
>
> **message-worker.** `emitWhatsAppEcho` publishes the WhatsApp send echo — the event that
> advances `RESPONDING → QOUT` on a platform with no native echo webhook — **straight to
> `chat-events`, bypassing hermes entirely**. It marshalled exactly six fields (`source`,
> `phone_number_id`, `from`, `type`, `metadata`, `timestamp`) and neither `account_id` nor
> `platform`. Three consequences, all of them this plan's own failure modes:
>
> 1. Every WhatsApp outbound minted a `messages` row with a permanently NULL `account_id` —
>    one per send, forever, *growing* the backfill's drain target rather than draining it.
> 2. §7.5's replay carries a deliberately temporary `AND (account_id = $2 OR account_id IS
>    NULL)` clause so un-backfilled **historical** rows keep replaying. A NULL row matches
>    **every** account, so these *new* rows leaked across all of a participant's
>    conversations — reproducing the exact bug this effort exists to fix, on the one platform
>    where it is deterministic. Observed signature (user `1541347160`): form B's stack with
>    account B's `md.pageid`, form A's field ref, resolved against account A → `FORM_NOT_FOUND`.
> 3. `conversationFromRawEvent` returned null for it, so the echo could never key the state
>    cache and always fell back to a replay.
>
> Production exposure was **zero** — `emitWhatsAppEcho` is not deployed and migration 26 is
> not applied — which is the entire value of catching it here.
>
> **botserver — a real producer that really does not stamp, running nowhere.** It is
> `enabled: false` in both live environments, so the section's evidence holds everywhere it
> matters. The reason it is in the table at all is
> `devops/values/integrations/fly.yaml`, which deploys **no hermes block at all** and sets no
> `botserver.enabled`, against a chart default of `true` (`devops/vlab/values.yaml:11-12`).
> A cluster built from that file therefore stamps nothing.
>
> **That file is dead config, not a live environment.** Verified rather than assumed: no CI
> workflow references it; its only consumer is `devops/scripts/bootstrap-fly.sh`, the sole
> kind-related script in the repo; last touched 2026-06-28; and the cluster has exactly two
> namespaces, `vprod` and `vstag`, with no `fly` namespace and one kube context.
>
> **It is therefore not migrated — it is labelled.** Migrating undeployed config to hermes is
> effort spent on something nobody runs. Leaving it silent is worse than either, because it
> is exactly the trap this effort exists to remove: someone bootstraps a local cluster to
> test conversation identity, lands in an environment where nothing stamps the envelope, sees
> unscoped replays and cross-account bleed, and concludes the fix does not work. Both
> `fly.yaml` and `bootstrap-fly.sh` now carry a header saying so, and saying that the revival
> path is swapping the `botserver:` block for a `hermes:` one — a drop-in replacement on the
> same service alias and the same paths, so the `http://fly-botserver/*` URLs need no change.
>
> So: "hermes is the single **ingester**" is true of every live environment and needs no
> qualification. "hermes is the single **producer**" is false, and the producer that breaks it
> is message-worker, not botserver.
>
> **The systemic fix matters more than the one-line one.** A second producer writing
> unstamped events went unnoticed until an integration test caught it, and the next direct
> producer would repeat it silently. `message-worker/kafka.go` now funnels **both**
> `PublishEvent` and `PublishRawEvent` through one `publish()` chokepoint carrying an
> envelope guard: it inspects the serialized bytes (so it holds for every shape, including
> ones not yet written), logs the greppable `CHAT_EVENTS_ENVELOPE_MISSING` at `Error`, and —
> under `STRICT_EVENT_ENVELOPE`, **off by default** — refuses. Reporting rather than refusing
> is the default deliberately: dropping the echo *stalls* every WhatsApp conversation, while
> publishing it unstamped merely degrades replybot to an unscoped replay, which still
> advances (test plan B10-8). Decision logic is pure (`message-worker/envelope.go`
> `MissingEnvelopeFields`); the guard is the shell.
>
> **A latent third violation inside the same service.** `types.UniversalEvent`
> (`message-worker/types/events.go:11`) marshals `platform` as the **object**
> `{"type":…,"account_id":…}` and carries no top-level `account_id`. Its emitters are dead
> today — `emitMessageSent`'s call sites are commented out (`worker.go:187`, `:301`) and
> `emitMessageFailed` has no caller at all — but they are one uncomment away, and a
> *present-but-object* `platform` is worse than an absent one: it passes any presence check
> while `conversationFromRawEvent` rejects it, so the conversation goes unnamed while looking
> stamped. `TestUniversalEvent_DoesNotSatisfyTheEnvelope` pins this so whoever revives them is
> told.
>
> Everything else in §4 stands: the derivation table, the shapes, and the requirement itself
> are unchanged. What changes is **who has to satisfy it** — two live producers, not one, and
> a third that runs nowhere but is one committed values file away from running.

The Kafka **key** stays the user id. Only the **body** changes. The body is what
`scribble/message.go:42` archives into `messages.content`, so it is the only place a field
survives into replay.

> **The key staying the user id is load-bearing, not incidental.** `replybot/lib/index.js`
> produces with `userid` as the key and hermes keys on the user
> (`event.rs get_user_from_event`), so **both** of a participant's conversations land on the
> same partition and are processed in strict order by one replybot spine. That is *why* this
> bug is a deterministic last-writer-wins rather than a race, and why a two-account test
> reproduces rather than flaking. Changing the key would reshuffle partitions and break
> ordering guarantees the rest of the system leans on. Recorded because "make the key the
> conversation" is the obvious-looking next step and it is wrong.

**As shipped, the envelope work went further than this section specifies**, in one way worth
recording: the 400 is gated behind `SYNTHETIC_REQUIRE_CONVERSATION`
(`hermes/src/config.rs:20-26`, default `false`, declared explicitly `"false"` in both
`production.yaml` and `staging.yaml`). §7.3.1's rollout step 1 ("accept but do not require")
therefore became a **config flip** rather than a property of deploy ordering — a genuine
improvement, because the rollout step stops being a race. See `documentation/event-envelope.md`.

### 4.1 Today — three shapes, account implicit on one of them

**Messenger** (`event.rs` `stamp_event(event, "messenger")`, produced at `handlers.rs:179`)
— the raw Meta `messaging[]` / `messaging_handovers[]` item, with `source` injected and
`timestamp` normalized to ms in place:

```jsonc
{
  "sender":    { "id": "<user>" },
  "recipient": { "id": "<account>" },     // inverted when message.is_echo
  "timestamp": 1786647529000,             // normalized: <2020 treated as seconds
  "message":   { ... },
  "source":    "messenger"                // injected by hermes
}
```

The account is **implicit and echo-dependent**: `recipient.id` normally, `sender.id` when
`message.is_echo` is true. Every consumer must reimplement that rule.

> **This is 28.8% of the archive, not a normalization detail.** The echo branch accounts for
> 115,134 of a uniform 400k sample of `messages` — roughly **30M rows**. The rule is now
> implemented **four** times, not the two §7.3.2 anticipated: Rust
> (`hermes/src/event.rs`, forward path), JS (`replybot/lib/event-normalizer.js`), Go
> (`scribble/account.go`, backward derivation from historical `content`) and SQL
> (`devops/sql/messages-account-id-expr.sql`, the backfill's extraction). All four are bound
> to the single shared fixture `testdata/event-envelope/messenger-account-derivation.json`.
> **Treat that fixture as production interface, not test scaffolding**: adding a vector is
> cheap, changing or reorganising one is a four-implementation change, and it is the only
> thing keeping a third of the archive's account attribution consistent across two languages
> and a SQL expression.

**WhatsApp** (`stamp_whatsapp_event(item, phone_number_id)`, produced at `handlers.rs:235`)
— the raw Cloud API `messages[]` / `statuses[]` item:

```jsonc
{
  "from":            "<user>",            // or "recipient_id" on statuses[]
  "timestamp":       1786647529000,       // normalized from a seconds string
  "type":            "text",
  "text":            { ... },
  "source":          "whatsapp",          // injected by hermes
  "phone_number_id": "<account>"          // injected by hermes — already explicit
}
```

**Synthetic** (`handle_synthetic`, produced at `handlers.rs:319`) — the POSTed body, with
`source` and a fresh `timestamp` stamped on:

```jsonc
{
  "user":      "<user>",
  "page":      "<account>",
  "platform":  "messenger",               // OPTIONAL — only dean sends it today
  "event":     { "type": "...", "value": ... },
  "source":    "synthetic",               // injected by hermes
  "timestamp": 1786647529000              // injected by hermes: now_ms
}
```

So the account is explicit on WhatsApp (`phone_number_id`) and synthetic (`page`), implicit
and echo-dependent on Messenger, and the account field has a different name in each shape.
`platform` is present only on dean's synthetic events.

### 4.2 Target — two normalized fields on every shape

Add exactly two top-level fields to all three shapes. Remove nothing; every existing field
keeps its name and meaning, so no consumer breaks.

```jsonc
{
  ...unchanged...,
  "account_id": "<account>",              // the messaging account this event belongs to
  "platform":   "messenger" | "whatsapp"  // the conversation's transport, never "synthetic"
}
```

Derivation, per shape, in hermes:

| Shape | `account_id` | `platform` |
|---|---|---|
| Messenger | `sender.id` if `message.is_echo` else `recipient.id` | `"messenger"` |
| WhatsApp | `phone_number_id` | `"whatsapp"` |
| Synthetic | the POSTed `account_id` (or `page`, deprecated) | the POSTed `platform` |

`phone_number_id` and `page` stay in place alongside `account_id` — they are what the
backfill in §7.4 reads out of historical `messages.content`, and dropping them would make
old and new rows need different extraction paths.

Both fields are **required on every event**. On Messenger and WhatsApp hermes derives them
with certainty. On synthetic events it cannot — `source: "synthetic"` says where the event
came from, not what conversation it belongs to — so the poster must supply them, and §7.3.1
makes that a required part of the `/synthetic` contract rather than an optional extra.

### 4.3 Consumers of the new fields

| Consumer | Uses |
|---|---|
| `replybot` `conversationFromRawEvent` (§7.1) | both, as the Redis key `state:{platform}:{account_id}:{user}` |
| `scribble/message.go` (§7.4) | both → `messages.account_id`, `messages.platform` |
| `messages` backfill (§7.4) | both, extracted from historical `content` |

No consumer falls back to `md`, to `source`, or to per-shape extraction. The envelope is the
single source, which is what makes a missing field a loud failure instead of a silent
mis-keying.

> **One qualification on "a missing field is a loud failure."** It is loud in replybot, which
> refuses to key the cache. It is deliberately **not** loud in `scribble/message.go`: both
> columns are nullable and unvalidated, because scribble treats any write error as fatal
> (`scribble.go` → `log.Fatalf`), so a required identity would let a producer that stopped
> stamping the fields crash-loop the archival sink and archive nothing at all. The row is
> stored with a NULL identity, which is *countable* — and it is the gate the backfill drains
> against. Loud where something can act on it; not fatal where nothing can.

---

## 5. The messaging account registry — designed, built, reverted

A registry table (§5.2 as originally proposed) was designed, migrated, dual-written and then
**deliberately reverted** in `5c4cab3e`, before any consumer read from it. See §7.6 for the
full status and the reasoning; in short, the conversation triple `(platform, account_id,
user_id)` this document is about never needed the registry — replybot reads all three off the
event envelope hermes stamps at ingest, and there is no lookup on that path. The registry was
solving a different, narrower problem (`entity → platform` is not a function, so a credential's
platform cannot always be inferred from its `entity`) by inference, when the actual fix is to
have the user tell us the platform when they connect an account. The full implementation —
migration 25, the dual-write, the pure decision layer, 42 tests, the sql-exporter collectors and
`documentation/messaging-accounts.md` — is preserved on
`origin/archive/messaging-accounts-registry` and returns when Instagram (whose webhooks carry
the Instagram account id rather than the Page id — a mapping problem the registry's row shape
solves) or a connect-accounts UI needs it.

What remains below (§5.1) is a consumer inventory that is still true of live code today — it
motivated the registry but does not depend on it, and is kept as background for anyone revisiting
this.

### 5.1 What enforces account identity today

`devops/migrations/20-messaging-account-unique.sql`, live in production:

```sql
UNIQUE INDEX unique_messaging_account (key ASC)
  STORING (details, userid)
  WHERE entity IN ('facebook_page', 'whatsapp_business')
```

A global unique index on the bare account id across both messaging platforms, enforced at
registration time by a bare `INSERT` (`credentials.queries.js:87`, no `ON CONFLICT`), so a
collision raises rather than corrupting. The base table's own uniqueness is per-user
(`unique_entity_key_per_user (userid, entity, key)`), so global uniqueness rests entirely on
that one partial index.

Consequence: **the account id alone already resolves the credential everywhere.** All ten
consumers use `WHERE key = $1 AND entity IN ('facebook_page','whatsapp_business')` and none
passes a platform.

Two problems with where that lives:

1. **The invariant's scope is an allowlist**, duplicated across ten call sites
   (`message-worker/tokenstore.go:108`, `dinersclub/provider.go:93`, `formcentral/db.go:82`,
   `dean/queries.go:244`, `credentials.queries.js:42`, `states.queries.js:57`, and the
   dashboard-client account screens). Add SMS or Telegram and the new entity falls outside
   the predicate — account ids become unconstrained, and the failure is a silent collision,
   not a rejected INSERT.
2. **`entity` is not the platform.** `message-worker/types/command.go:11` defines four
   platforms (`messenger`, `whatsapp`, `instagram`, `telegram`) against two messaging
   entities. Instagram is the proof: `translator_instagram.go:10` — *"Instagram uses the
   same API structure as Messenger"* — Instagram DMs send through the **Page's** token, so
   `platform='instagram'` maps to `entity='facebook_page'`. One credential, two platforms;
   `entity → platform` is not a function. `tokenstore.go:29` and `provider.go:76` each carry
   a hand-written two-entry `platformToEntity` map whose documented "absent or unmapped"
   fallback is already load-bearing.

`credentials` is a generic store (`api_token`, `secrets`, `reloadly`, `typeform_token`,
`facebook_ad_user`); how a subsystem uses a credential is that subsystem's business. The
messaging invariant belongs in a messaging-owned table that *points at* a credential.

> #### CORRECTED 2026-08-17 — there are SIX consumers, not ten
>
> Verified with `file:line` (this table was the authoritative list; the fuller writeup lived in
> `documentation/messaging-accounts.md`, removed with the registry — see §7.6).
>
> | # | Site |
> |---|---|
> | 1 | `message-worker/tokenstore.go:105-111` (the **fallback** path; the primary is `WHERE entity = $1 AND key = $2`, :95-101) |
> | 2 | `dinersclub/provider.go:93` (same split — primary at :90-91) |
> | 3 | `formcentral/db.go:82` |
> | 4 | `dean/queries.go:245` — **not :244** as written above |
> | 5 | `dashboard-server/queries/states/states.queries.js:57` |
> | 6 | `dashboard-server/queries/credentials/credentials.queries.js:42` |
>
> Two of the four extra entries were miscounted rather than merely stale:
>
> - **The "dashboard-client account screens" are not consumers.** They do a client-side
>   `.filter()` over data already fetched by one of the six above. They never issue the
>   lookup, so migrating the tuple does not touch them.
> - **`media` and `message_templates` were already migrated by migration 22.** They are
>   done, not pending.
>
> **Item 2 above — `entity → platform` is not a function — is unaffected and is what carried
> the design.** Item 1's "ten call sites" was the weaker of the two arguments and it is the
> one that shrank. An additional non-query dependant exists, relevant background if this
> constraint is ever revisited: `chatroach.media_handle` is keyed on `account_id` **alone**,
> and `24-media-assets.sql` documents that dropping `unique_messaging_account` lets handles
> collide across platforms.

---

## 6. Phases

### 6.0 Operational: unsticking a participant before §7.1 ships

```sql
SELECT userid FROM chatroach.states
GROUP BY userid HAVING count(DISTINCT pageid) > 1;
```

then `devops/clear-state-cache.sh <ns> <file>`. Non-destructive — state is derived, the
event log is durable, a miss recomputes, nothing is sent to anyone.

### 7.1 Key the state cache by the conversation

Stops all new cross-account bleeding. **Requires §7.3** — the key contains `platform`, which
is only reliably present on every event once the posters and hermes normalize it.

**`replybot/lib/typewheels/statestore.js`**

```js
_makeKey(platform, account, user) {
  return `state:${platform}:${account}:${user}`
}
```

`getState(platform, account, user, event)` and `updateState(platform, account, user, state)`
take the tuple explicitly. **All three components come from the event, never from
`state.md`** — `md.pageid` and `md.platform` are precisely the fields that bleed.

Both components are read from the normalized envelope (§4.2), so there is exactly one
extraction path and no per-shape logic in replybot.

**Getting the tuple into the processor.** Add a total, pure helper to
`replybot/lib/event-normalizer.js`:

```js
// The conversation an event belongs to: { platform, account } or null if either
// is absent. Total: never throws, for any input. Used only for conversation
// keying, so it must not adopt parseEvent's error contract. Reads the
// normalized top-level `platform` / `account_id` fields (§4.2) and nothing else
// -- no per-shape extraction, no md fallback.
function conversationFromRawEvent(raw) { ... }
```

`replybot/lib/index.js`:

```js
const conv = conversationFromRawEvent(event)
const state = await stateStore.getState(conv, userId, event)
...
await stateStore.updateState(conv, userId, report.newState)
```

This double-parses the event (`machine.run` parses again). Deliberate: it keeps
`machine.run`'s `CORRUPTED_MESSAGE` contract intact, and a `JSON.parse` is cheap next to the
Redis round trip it guards. Do not restructure `machine.run` for this.

**When either component is missing:** do not read and do not write the cache. Compute state
from the event log and log once with a distinct, greppable tag. Never key a conversation
under a name we cannot verify, and never poison the cache with a partially-scoped write.
Cost is a replay — the same thing a cache miss already does.

> #### CORRECTED 2026-08-17 — *"cost is a replay — the same thing a cache miss already does"* is FALSE, and it is the sentence that licensed a silent re-entry onto survey `305`
>
> **The refusal itself is right and stays.** What is wrong is the sizing, and the sizing is
> what made the refusal look free. A cache miss and a tuple-less event replay the same query,
> so the two look identical. They are not, in three ways:
>
> **1. A cache miss replays a COMPLETE log. A tuple-less event may replay a log that does not
> exist yet.** A miss happens to an *established* conversation — the key expired, so the
> archive has had 24 hours to catch up. The degraded path happens to *whatever event arrives*,
> including the second event of a brand-new conversation. Replybot and scribble consume
> `chat-events` **in parallel**, so for a new conversation scribble is systematically *behind*:
> the messages sink runs `SCRIBBLE_CHUNK_SIZE=32` / `SCRIBBLE_BATCH_SIZE=128` with
> `KAFKA_POLL_TIMEOUT=2s` (`devops/values/production.yaml`), and a low-volume conversation
> flushes on the timeout rather than on the count. **§7.1 removes the cache exactly where the
> archive is most likely to be behind.**
>
> What that produces is not imprecision. An empty replay reconstructs as `START`;
> `machine.js`'s `_handleExternalEvent` took `if (state.state === 'START') return
> _blankStart(nxt)`; `getMetadata()` found no referral ref and fell through to
> `FALLBACK_FORM`. **The participant was silently switched onto survey `305`** — a real, live
> survey, still scoped to the account this conversation already lives on (`formcentral/db.go`
> resolves a shortcode within the owner of the arriving `pageid`; it cannot cross researchers —
> see the correction at Appendix B). So the misroute here lands the participant on a *different*
> survey owned by the *same* researcher, not another one's, and their answers are misattributed
> to it. Misrouted participants still look like *completions*, which is the exact failure
> signature of VIR-19 and of Appendix A. `state.forms` also keeps
> the `305` entry permanently, so the participant looks like they touched that survey even
> after the referral repairs the form.
>
> Found by the integration harness (B10-8, `expected '305' to equal 'isoFormA'`) and written
> up in `facebot/testrunner/README.md` as *"a tuple-less event is served by replay — so wait
> for the archive"*, with the explicit note that the window is not a test artifact. It is not
> fixable from the harness.
>
> **2. Archive lag is not the only way to reach an empty replay — and the other way needs no
> lag at all.** §7.5 scopes the replay by `account_id`. An event that names an account the
> conversation does **not** live on therefore replays empty *immediately and repeatably*, with
> a perfectly current archive. Two live producers do exactly that: `linksniffer` and
> `moviehouse` read their `pageid` out of a **researcher-authored webview query string**, and
> §8.4 measures the damage — **265 of 346 linksniffer fields author no `pageid` at all**, and
> every one of the 49 WhatsApp-capable ones hardcodes a Messenger page. §8.4 concludes the cost
> is *"lost click analytics, not a hung conversation."* **That conclusion was reached before
> this hazard was understood and is too optimistic:** on the §7.1 + §7.5 read path a misrouted
> click does not merely fail to record, it blank-starts a spurious `305` conversation on
> another researcher's account and sends that survey's first message to the participant. Here
> "another researcher's account" is not the shortcode lookup crossing a boundary — it is the
> stale, researcher-authored webview query string naming a `pageid` that genuinely can belong
> to a different account than the one the participant is actually on. `305` itself never
> resolves cross-account; it is always scoped to whichever account that (possibly wrong)
> `pageid` names.
>
> **3. A cache miss costs one replay per 24 hours. The degraded path costs one replay per
> event, forever.** There is no memoization on it by construction — the write is refused too.
> `STATE_STORE_LIMIT=30000`, so a participant on the degraded path scans up to 30k rows on
> *every* event. See the seventh poster below for why that is not hypothetical.
>
> **The pre-step's "Expected: zero" cannot hold today: §7.3.1's amendment counts SIX synthetic
> posters and there are SEVEN.** The seventh is **`moviehouse`** — a **browser**, not a
> service, which is why grepping `BOTSERVER_URL` in `devops/values/production.yaml` (the method
> that amendment recommends) cannot see it. `moviehouse/src/script.js:39` and `:60-71` POST
>
> ```js
> { user: psid, page: pageId, data, event: { type: 'external', value: { type: `moviehouse:${eventType}`, id: videoId } } }
> ```
>
> — the deprecated `page` alias, **no `account_id`, and no `platform` at all**. It reaches
> hermes over the public ingress (`moviehouse/netlify.toml` → `https://fly-botserver.vlab.digital/synthetic`,
> which hermes serves on botserver's reused host; `CorsLayer::permissive()` at
> `hermes/src/main.rs:45` admits the cross-origin XHR). Hermes stamps `account_id` from `page`,
> logs `[INCOMPLETE_CONVERSATION]`, and produces it. Replybot's
> `conversationFromRawEvent` therefore returns `{ platform: null, account }` — the middle row —
> so **every moviehouse video event takes the degraded path**, and the webview heartbeats every
> `HEARTBEAT_INTERVAL_MS` (30s) for the whole length of the video.
>
> Three consequences: `CONVERSATION_TUPLE_MISSING` is guaranteed non-zero, so the canary can
> never read zero as written; point 3 above is a 30k-row scan every 30 seconds per participant
> watching a video; and **step 5 of the order of work — flipping
> `SYNTHETIC_REQUIRE_CONVERSATION` on — would 400 every moviehouse event and kill video
> tracking outright.** `moviehouse` must send `account_id` and `platform` before that flip, and
> because it is served from Netlify rather than the cluster, it cannot be rolled out in the
> same apply.
>
> **What was fixed, and what was deliberately not.** The blank start is now refused: a
> synthetic event on a conversation that replays as `START` returns a new `DEFER` output
> instead. It folds as a pure no-op (`apply`), and `transition.js`'s `run` returns **without
> `newState`**, so `lib/index.js` publishes no state and writes no cache key. **The absence of
> `newState` is the mechanism, not a detail:** `scribble/state.go` writes with a bare `UPSERT`,
> so any state published here would overwrite the conversation's real `states` row — and that
> row is what every recovery sweep selects on.
>
> **An ERROR state with a new retryable tag was considered and rejected**, and this is the part
> worth recording, because it is the obvious-looking design:
>
> - It clobbers the row above. Dean's `Timeouts()` re-fires only while
>   `current_state = 'WAIT_EXTERNAL_EVENT'`, and `Payments()` likewise. Writing `ERROR` (or
>   `START`, which is what a plain `_noop()` would have published) in place of that row does
>   not merely lose the event — **it destroys the retry that would have re-delivered it.**
> - A new tag is not in `DEAN_ERROR_TAGS` (`NETWORK,INTERNAL,STATE_ACTIONS`), so nothing sweeps
>   it. That is the `FIELD_NOT_FOUND` lesson, already recorded at
>   `devops/values/production.yaml:170-183`.
> - **And adding it to the set would not have been sufficient either.** The same comment records
>   the trap in full: replybot serves state from the cache and `updateState()` refreshes the TTL
>   on every touch, so a redo re-reads the same corrupt state and re-fails — *"a sweep of 40
>   participants recovered exactly zero."*
>
> **So the retry path is dean's own sweeps, not `DEAN_ERROR_TAGS`, and it works precisely
> because the deferral writes nothing.** Verified against the live config rather than assumed:
>
> | Producer | Event | Recovery after a `DEFER` | Verified at |
> |---|---|---|---|
> | `dean` | `timeout` | `Timeouts()` re-fires; cron `*/10 * * * *`, window `DEAN_TIMEOUT_MAX_PAST=72 hours`, and the 5-attempt cap counts only `externalEvents` entries **actually recorded** — a deferral records none | `dean/queries.go:167-233`; `production.yaml:217,238` |
> | `dinersclub` | `external` (payment result) | dean `Payments()` re-issues `repeat_payment` after `DEAN_PAYMENT_GRACE=2 hours`; cron `0 */6 * * *`, cap 30 | `dean/queries.go:152-165`; `production.yaml:245` |
> | `moviehouse` | `external` (video) | the webview heartbeats again within 30s | `moviehouse/src/script.js:5,75-79` |
> | `linksniffer` | `external` (click) | **none.** The click analytic is lost | §8.4 |
>
> Losing a linksniffer click is a real cost and is named rather than hidden. It is still
> strictly better than the alternative it replaces, which was: send the participant onto survey
> `305` in place of the survey they were actually on — the same researcher's account in the
> archive-lag case (point 1 above), possibly a different researcher's account in the
> webview-pageid case (point 2 above) — overwrite their `states` row with it, and attribute
> their answers to it.
>
> **`_blankStart` on a HANDOVER is legitimate and must not be swept up in this.** This is the
> one place the "external events cannot mean first contact" argument breaks. `_handleExternalEvent`
> has two callers, and only one is synthetic: a Messenger thread-control passback
> (`HANDOVER_EVENT`) lands **~1.5 s before** the quick_reply carrying the referral on an ad
> click, so blank-starting `FALLBACK_FORM` there and letting the referral switch forms is the
> **designed** behaviour (`documentation/referral-form-resolution.md` §6b, plus the
> handover-race test in `machine.test.js`). The discriminator is therefore
> `source.type === 'synthetic'`, **not** "arrived through `_handleExternalEvent`". A guard
> written the second way would have broken every ad click.
>
> **`BAILOUT` at `START` is deliberately NOT deferred.** An exodus bail **names** the form it
> wants the participant switched onto, so it never resolves through `FALLBACK_FORM`; honouring
> it on a short replay still does what it was asked to do, degraded (no seed, no `md.pageid`)
> but not wrong. Dropping it would silently un-bail a participant exodus decided to bail, and
> exodus has no re-sweep. Recorded so the scope of the guard reads as a decision.
>
> **MEASURED IN PRODUCTION 2026-08-17 — this hazard has NOT fired, and a differently-caused
> defect with the IDENTICAL signature has fired 3,722 times.** Both halves matter.
>
> **It has not fired, and the reason is sequencing rather than luck.** Production runs
> `v0.0.218`, where the cache is still `state:<userid>` and the replay is still unscoped by
> account: there is no cache-bypass rule, so §7.1's degraded path **does not exist in production
> yet**, and §7.5's account-scoping — the thing that makes an *empty* replay reachable without
> any archive lag — is not deployed either. So the only pre-§7.1 route to an empty replay is
> archive lag on a cache miss on a brand-new conversation, and when it fires it produces
> `forms: ["305"]` (length 1), which is **indistinguishable from the 161,876 legitimate
> fallback-entry rows.** It is not separately measurable, not "absent". This is a fix for a
> hazard that the harness found in the branch before the branch reached production — which is
> the outcome to want, not a reason to discount it.
>
> **What IS measurable is the same shape from a different cause, and it is live.** The
> discriminating query — 305 **appended** to an existing form stack rather than being the first
> form — is clean, because causes (a) VIR-19 and (b) the CTWA order-dependence both produce
> `forms = ["305"]` of length 1:
>
> ```sql
> SELECT count(*) FROM chatroach.states
>  WHERE current_form = '305' AND jsonb_array_length(state_json->'forms') > 1;   -- 3,722
> ```
>
> | Measure | Count |
> |---|---|
> | `states` rows total | 1,092,300 |
> | `md.form = '305'` | 168,041 |
> | ...`forms = ["305"]` only — cause (a)/(b), or a page that legitimately enters on 305 | 161,876 |
> | ...**305 appended and last — the (c) shape** | **3,722** |
> | ...of those, the 305 start provably POST-DATES the participant's earliest non-305 response | **2,725** |
> | ...of those, outside BOTH known windows (VIR-19; CTWA ≥2026-08-13) | **2,722** |
> | ...of those, carrying `externalEvents` at all | **27 (1%)** |
> | Outcome split of the 3,722 | `END` 2,474 · `FORM_NOT_FOUND`/`ERROR` 809 · `FB`/`BLOCKED` 350 |
>
> Chronic, not windowed: 10–90 rows/month continuously from 2024 through 2026-08. And the 1%
> `externalEvents` rate is the measurement that **kills the synthetic-event hypothesis as the
> production explanation** — those 27 are handover/reloadly/moviehouse entries belonging to a
> separate confound (page `101435865704727`, which legitimately enters 23,302 participants on
> `forms[0] = '305'`).
>
> **The real trigger, traced in `chatroach.messages` on two independent pages and months:
> Messenger's bare `get_started` postback landing 1–4 s after a successful ad referral.**
>
> ```
> 13:16:00.474  referral  ref="creative.Static Hausa -parents.Age.Age.State.Bauchi State.form.mnchweeklanguage"
> 13:16:01.653  {"postback":{"title":"Get Started","payload":"get_started"}}
> 13:16:03.524  forms:["mnchweeklanguage","305"]  md:{form:"305",startTime,pageid,platform,seed}
> 13:16:04.53   ERROR
> ```
>
> Mechanism, and it needs **no** empty replay, no archive lag and no cache miss:
> `event-normalizer.js:37` maps a bare `get_started` to `event_type: 'conversation_started'` with
> `referral: undefined`. `categorizeEvent` therefore routes it to **`REFERRAL`**, `getForm(nxt)`
> finds no ref and resolves `FALLBACK_FORM`, `_hasForm(state, '305')` is false for a participant
> whose real form is not 305, and `_blankStart` pushes `305` onto the live stack **at any state**
> — replacing `md` wholesale, so `creative`/`gender`/`geography` are wiped. On the ecd page the
> participant's answer to the language question was then written as
> `shortcode: '305', question_ref: 'end'` and they were told *"Sorry, I can't accept any
> responses now."* Misattributed, not merely lost.
>
> **This is a third instance of the VIR-19 / Appendix A family and it is NOT fixed here.** The
> defect is that the `REFERRAL` handler cannot distinguish *"a referral that names
> FALLBACK_FORM"* from *"an entry event that names no form at all"*, and the second must not
> blank-start a participant who already has a conversation. It is deliberately left alone rather
> than folded into this change: 161,876 rows depend on `get_started` entering a genuinely new
> participant, so gating it is a behavioural change on the platform's main entry path and wants
> its own decision, its own tests and its own measurement. **Proposed shape:** in the `REFERRAL`
> case, when the resolved form came from `FALLBACK_FORM` rather than from a ref, blank-start only
> when `state.state === 'START'` — i.e. the same discriminator `TEXT`/`MEDIA`/`QUICK_REPLY`/
> `POSTBACK` already apply — and `_noop()` otherwise. **Detector, cheap and clean:**
>
> ```sql
> -- 305 pushed onto a live stack in the last day
> SELECT * FROM chatroach.states
>  WHERE current_form = '305' AND jsonb_array_length(state_json->'forms') > 1
>    AND form_start_time > now() - INTERVAL '1 day';
> ```
>
> > **RESOLVED 2026-08-17 — this is now in scope and fixed; see Appendix B.** Three claims above
> > were revised by the measurement the fix required, and are left standing here because the
> > wrong version is the one a reader would otherwise re-derive:
> >
> > - **"Chronic from 2024"** — it is chronic from **2020-06**. Six years, not two.
> > - **"The real trigger is a `get_started` landing 1–4 s after a successful ad referral"** — that
> >   is only ~11% of it. Replaying 561 of the affected logs shows the prior state was `END` 50% /
> >   `QOUT` 22% / `RESPONDING` 14% / `WAIT_EXTERNAL_EVENT` 7% / `BLOCKED` 6%, and 129 of the 499
> >   `get_started` appends arrived **more than a day** after the participant's last message. The
> >   ad-click race is the `RESPONDING` slice; the dominant mechanism is a later Get Started tap on
> >   a conversation that already exists. Naming the race as "the real trigger" would have led to a
> >   fix scoped to a few seconds after a referral, which would have missed 89% of the population.
> > - **"Blank-start only when `state.state === 'START'`, `_noop()` otherwise"** — the shipped
> >   discriminator is `state.forms.length` (safer where the two diverge) and the output is
> >   **`DEFER`**, not `_noop()`, for exactly the reason §7.1 chose `DEFER`: `_noop` returns
> >   `newState` and `scribble`'s bare `UPSERT` clobbers the live row.
> >
> > What stood up unchanged: the mechanism, the traced webhook sequence, the `forms`-length
> > discriminator for identifying rows, and the warning that 161,876 (now 162,148) rows depend on
> > `get_started` entering a genuinely new participant — 35% of those entries are a bare
> > `get_started` and would have broken if it had been gated in the normalizer.
>
> **Two smaller production facts from the same pass**, both worth keeping:
>
> - **`md.pageid <> pageid` is a sharp, low-noise detector for a cross-account state read: 23
>   rows in the whole table**, one of them on 305. The freshest is the 2026-08-16 WhatsApp
>   incident of §1.1 (`pageid = 1265380589988964`, `md.pageid = 1203867182815254`,
>   `forms = ["misinfogame","305"]`, dead on `FIELD_NOT_FOUND`). Worth alerting on directly —
>   it is a better instrument than the multi-account cohort count in §1.3.
> - **The "empty replayed log ⇒ START" artifact is real and observable, just not as a 305
>   producer: 2,855 states have `forms = []`, 1,167 of them at `START`, 13 touched in the last
>   30 days.** One was written today by a `machine_report` carrying
>   `newState: {state:"START",qa:[],forms:[]}` after a literal `form.reset`. That is the residual
>   clobber described below, caught in the wild.
> - **The "`md` has no targeting keys" fingerprint does not discriminate anything.**
>   `creative`/`gender`/`geography`/`ctwaprobe` appear **zero** times across all 168,041
>   `md.form='305'` rows, because a fallback start by definition has no ref to read them from.
>   Do not use it to separate causes; use the `forms` length.
>
> **Residual, not fixed here.** `DEFER` closes the `FALLBACK_FORM` door. It does not close the
> general one: **on the degraded path, *any* event whose replay comes back short publishes a
> truncated state, and `scribble/state.go`'s bare `UPSERT` makes that a clobber.** A
> `machine_report` with no error at `START` no-ops and publishes a `START` row over a live
> conversation; a `REDO` at `START` fails `User without metadata` into `STATE_ACTIONS`, which
> *is* retryable but writes `ERROR` over the row that produced it. Both are transient rather
> than terminal, and both want the same eventual answer — replybot should not publish a state it
> folded from a log it cannot vouch for. That is a larger change than this hazard needed.

Deliberately **no fallback to per-shape extraction or to `md`**. A fallback here would
silently paper over a producer that stopped sending the fields, which is exactly the failure
this key exists to make impossible. The canary below is what proves the fields are present;
after that, absence is a bug that should be loud.

> **Clarified as implemented:** the *cache* cannot be keyed without a platform, but the
> *replay* can still be scoped by account, and is. The live gate is
> `(conv && conv.account) || null`, so a platform-less-but-account-bearing event still reads
> only that account's log. An "only scope when the whole tuple is known" gate — which reads
> as the natural simplification — resolves that case to `account: null` and **throws away an
> account the event actually carried**, replaying every conversation the participant has.
> That alternative was considered and rejected; a test pins it.

> #### CORRECTED 2026-08-17 — the gate above was correct and **unreachable**. It was dead code from the day it shipped.
>
> The note is right about what `statestore.js` does. It is wrong about the system: the middle
> row could not occur, because the *extractor* refused to produce it. `conversationFromRawEvent`
> ended with
>
> ```js
> if (!platform || !account) return null   // utils.js:98, before the fix
> ```
>
> so a platform-less-but-account-bearing event arrived at the store as `null`, `isNamed`
> failed, and `(conv && conv.account) || null` resolved to `null` — the exact "natural
> simplification" this note records as considered and rejected, reintroduced one layer
> upstream. The rejected alternative was therefore the shipped behaviour, and §7.1's own
> guard against it was decoration.
>
> **Both unit tests passed throughout**, which is the instructive part. B10-9b hands the store
> `{ platform: null, account }` directly, so it pinned the store's half of a contract whose
> other half was broken; nothing asserted the extractor could *emit* that shape. A gate is
> only tested if something tests the thing that feeds it.
>
> Caught by B10-8 (`expected '305' to equal 'isoFormA'` — 305 is `FALLBACK_FORM`): a
> platform-less synthetic event against a two-account participant replayed **unscoped**,
> which reads `ORDER BY timestamp ASC LIMIT 30000` — the *oldest* events — so the other
> conversation's history consumed the window and the state silently truncated to the fallback
> form. Not imprecision: truncation.
>
> Fixed by making the extractor **total in the information it preserves**, not just total in
> the "never throws" sense. It now returns each component independently (a non-empty string or
> `null`), and returns `null` only when the event named neither. The strictness stays where it
> belongs — `isNamed` still requires the full triple for the cache key. `utils.test.js`
> `describe('conversationFromRawEvent')` pins all three rows at the extractor, so B10-9's three
> rows at the store are now reachable end to end.

**Pre-step — confirm the missing-tuple rate is zero.** After §7.3 is deployed and before the
key changes, ship a log-only replybot build: compute `conv`, log a counter when either
component is null, change nothing else. Watch 24h. Expected: zero.

This is the acceptance test for §7.3. If it is not zero, a poster or a hermes path is still
not stamping the fields — find out here, not after the key depends on them.

> **The canary must count two tags, not one.** `[INCOMPLETE_CONVERSATION]` catches a *missing*
> platform. It cannot see a platform that is **present but assumed** — which is what
> `linksniffer` sends on a legacy hand-authored link (`[LINKSNIFFER_PLATFORM_ASSUMED]`) and
> what `exodus` sends via `COALESCE(s.platform, 'messenger')`. Both pass the gate while
> possibly carrying the wrong identity. Counting only the first would declare the rollout safe
> while WhatsApp webview clicks were still mis-attributed. See §8.

**Dead code in the blast radius.** Only `lib/index.js` is live (`package.json` `start`).

- `lib/responses/stateman.js:31` and the `Responser` class in `lib/responses/responser.js:43`
  both call `machine.transition(state, userId, e)` with **three** arguments against a
  **two**-arg method (`transition.js:22`). They cannot have worked since that signature
  changed. **Delete both.** Keep `responseVals` — `transition.js:4` imports it and it is
  live.
- `lib/responses/debugger.js` is a local CLI tool. Update it; it is useful for reproducing
  this class of bug.

> **`debugger.js` is done and is insulated from §7.5 by construction.** It never calls
> `db.get` — it builds `emptyBase = { get: () => [], pool: chatbase.pool }` and runs its own
> `query(chatbase.pool, userid, lim)` — so the `get({ userid, account })` signature change
> cannot reach it, and it already calls `stateStore.getState(conv, userId, event)` in the tuple
> form. Its comment about `messages` not being account-scoped stays accurate *about itself*,
> because its own query is deliberately unscoped.

**`devops/clear-state-cache.sh`** hardcodes `state:<userid>`. Keys become
`state:<platform>:<account>:<userid>`, so it must match on the userid *suffix*. Use `SCAN`
with `MATCH state:*:*:<userid>`, **not** `KEYS` — this runs against production Redis. Keep
`DRY_RUN`. Keep supporting the old flat shape for 24h after cutover, then drop it.

**Tests.** `statestore.test.js:62-106` asserts `state:user123` and must change. Add:

- Two accounts, same user, same platform → two distinct keys; a write under one is invisible
  to the other. **This is the regression test for the whole bug** and does not exist today.
- Same account id, two platforms → two distinct keys. Guards the case the registry's
  `PRIMARY KEY (platform, account_id)` admits but `unique_messaging_account` does not.
- Either component null → neither `redis.get` nor `redis.setex` is called, and state is
  computed from the log.

> **Note on the second bullet:** as written it reads as defensive. It was previously argued to
> be **load-bearing** on the grounds that the registry's `PRIMARY KEY (platform, account_id)`
> reversed the ratified `(allocator, id)` account-identity decision and made platform part of
> account identity — with Instagram (one account id, two platforms) as the concrete case.
>
> **OPEN — needs decision:** that reversal is itself reverted (`5c4cab3e`; see §7.6), and
> `documentation/platform-abstraction.md`'s ratified 2026-07-22 decision — account identity is
> `(allocator, id)`, first-class `(platform, account_id)` pairs explicitly rejected — now
> stands unreversed. So the premise that made this test load-bearing is gone. Is "same account
> id, two platforms → two distinct keys" still load-bearing, merely defensive, or should it be
> dropped/reframed? This needs a human call, not a re-derivation of the old justification.
>
> **Note on the third:** the shipped tests assert the *arguments* `db.get` receives, not
> merely that it was called. Asserting `.called` alone would pass against a completely
> unscoped replay, which is how the one thing this phase must guarantee could have gone
> untested.

**Verification in staging** — reproduces on demand in two messages:

1. Send a CTWA-style entry to the 541 number (`1203867182815254`).
2. Continue an existing conversation on the 202 number (`1265380589988964`) as the same
   participant.
3. Assert the `STATE:` line's `md.pageid` matches the account the event arrived on, and that
   no `FIELD_NOT_FOUND` is raised.

> Assert on `FORM_NOT_FOUND` too — see §1.1's amendment. Either tag can fire depending on
> whether both forms resolve, and neither is retried.

**Docs:** update `documentation/states-debugging.md` (key shape) and `replybot/README.md`
(`StateStore` signature; "the account comes from the event, never from `md.pageid`").

### 7.2 Standalone correctness fixes — no schema, no dependencies

All are silent-data-loss bugs today. None needs a migration. Ships in parallel with §7.1.

- **`scribble/state.go:37`** — key `DedupStates` on `(UserID, Pageid)`.
- **`scribble/response.go:86`** — `ON CONFLICT(userid, pageid, timestamp, question_ref)`.
- **`scribble/chatlog.go:65`** — `ON CONFLICT(userid, pageid, timestamp, direction)`.
  Both tables already have `pageid`; only the conflict target is wrong. Confirm the
  supporting unique indexes exist before changing the target.
- **`exodus/query/builder.go:184,226,232`** — scope the response CTEs by account and join on
  `(userid, pageid)`.

`scribble/message.go:35`'s `ON CONFLICT(hsh, userid)` needs §7.4 first.

> #### CORRECTED 2026-08-17 — "None needs a migration" is FALSE. Two of the four needed `ALTER PRIMARY KEY`, and shipping them without one would have CRASH-LOOPED scribble.
>
> This section's own hedge — *"Confirm the supporting unique indexes exist before changing
> the target"* — resolves to **they do not, and cannot, while the primary key is what it
> is.** The `ON CONFLICT` targets named above **were the primary keys**:
>
> - `responses` is `PRIMARY KEY (userid, timestamp, question_ref)` (`01-init.sql:87`) — the
>   exact tuple `response.go:86` names.
> - `chat_log` is `PRIMARY KEY (userid, timestamp, direction)` (`08-chat-log.sql:31`) — the
>   exact tuple `chatlog.go:65` names.
>
> Both failure modes of the naive change were reproduced against CockroachDB v24.1.0:
>
> 1. Adding `pageid` to the target **with no unique index covering it** fails at runtime, not
>    compile time: `ERROR: there is no unique or exclusion constraint matching the ON CONFLICT
>    specification (SQLSTATE 42P10)`.
> 2. Adding a bare `UNIQUE INDEX` while leaving the old primary key in place is **worse than
>    the bug**: the second account's row now passes the arbiter, reaches the primary index,
>    and raises `duplicate key value violates unique constraint (SQLSTATE 23505)`.
>
> **And scribble treats any write error as fatal** (`scribble.go:36-39` → `log.Fatalf`), so
> either mode turns silent per-row data loss into a **crash-looping consumer on a poison
> batch** — an outage, in exchange for a fix. That is a completely different risk class from
> "ships immediately, no dependencies."
>
> **What actually shipped: two `ALTER PRIMARY KEY` migrations, each with a backfill and a
> `SET NOT NULL`, because both `pageid` columns were nullable** (`01-init.sql:79`,
> `08-chat-log.sql:20`) and a nullable column cannot enter a primary key (SQLSTATE 42P15).
>
> | Migration | Table | Size (prod, 2026-08-17) | NULL `pageid` | Backfill |
> |---|---|---|---|---|
> | `27-chat-log-account-scoped-key.sql` | `chat_log` | 2.91 GiB / 65 ranges / 1,479,724 rows | 14,834 | in-migration, to the `''` "account unknown" sentinel |
> | `28-responses-account-scoped-key.sql` | `responses` | 39.24 GiB / 982 ranges / 17,774,273 rows | **1,818,162** | **separate batched script**, `devops/backfill-responses-pageid.sh`, run first |
>
> Three further facts a future reader needs:
>
> - **`ALTER PRIMARY KEY` retains the old primary key as a unique secondary index.** If that
>   index is not dropped it re-imposes the exact constraint the migration exists to remove —
>   the fix silently does nothing and inserts fail 23505 on
>   `chat_log_userid_timestamp_direction_key` instead. The drop is load-bearing and both
>   migrations carry a guard so a rename or a skipped drop fails loudly rather than shipping a
>   no-op.
> - **Schema before code, always, and one deploy for both.** One scribble build changes both
>   `chatlog.go` and `response.go`, so it needs both migrations applied. Sequencing decided
>   2026-08-17: migration 27 → `backfill-responses-pageid.sh` → migration 28 → deploy scribble
>   **once**. Full runbook in the migration headers.
> - **`responses`' NULL rows are frozen legacy, `chat_log`'s are a live producer bug.**
>   `max(timestamp) where pageid IS NULL` on `responses` is **2020-09-06** with zero in every
>   month for the last ten, so its backfill is a one-time historical cleanup. `chat_log`'s
>   14,834 came from replybot omitting the account on ~0.9% of entries (395 of the last 43,824
>   rows), which is why scribble coerces nil to `''` on the write path — a backstop, not a
>   licence, and whoever restores that producer must fix it.
>
> **Only two of the four items really were migration-free**: `DedupStates`
> (`scribble/state.go`) and the exodus bail-targeting fix. Those shipped on day one exactly as
> this section promised.
>
> **And the extension of this reasoning to `messages` was wrong** — see §7.4's amendment. The
> difference is that `messages`' conflict target includes a content hash while these two
> enumerate business columns.

### 7.3 Every event carries the triple

Implements §4.2. **Hard prerequisite for §7.1 and §7.4** — nothing downstream can key on the
triple until every event has one.

#### 7.3.1 All synthetic events must post the triple

This is the substance of the phase. The `/synthetic` contract today is
`{ user, page, platform?, event }` — a double plus an optional platform that only dean
sends. It becomes a required triple.

**Contract:**

```jsonc
POST /synthetic
{
  "user":       "<user_id>",              // required, unchanged
  "account_id": "<account_id>",           // required; `page` accepted as a deprecated alias
  "platform":   "messenger" | "whatsapp", // required -- NEW
  "event":      { "type": "...", "value": ... }
}
```

Hermes rejects a synthetic POST missing any of the three with a 400, and logs the rejection
with the poster's identity. Fail fast and loud: a synthetic event without a platform is an
event that cannot be attributed to a conversation, and accepting it would silently recreate
the bug.

**Rollout order matters** — hermes must accept-but-not-require before it rejects, or
in-flight posters 400 during the deploy:

1. Hermes accepts `account_id` (preferring it) or `page`, and passes `platform` through.
   Stamps normalized fields when present. No rejection yet.
2. All four posters ship the triple.
3. Confirm zero events lacking a component (the §7.1 canary is exactly this check).
4. Hermes turns on the 400.

**The four posters.** All have the platform at the call site:

| Poster | Today | Change |
|---|---|---|
| `dean/queries.go:19` | `User`, `Page`, `Platform` | rename `page` → `account_id` only |
| `dinersclub/main.go:86` | `pe.Platform` exists, not sent | send it |
| `message-worker/worker.go:486` | `cmd.Platform` in scope, not sent | send it |
| `replybot/lib/index.js:14` | `transition()` computes it, dropped | send it |

`botparty.ExternalEvent` has no `Platform` field and lives in a separate repo. Rather than
publish and bump it in two services, `dinersclub` and `message-worker` each declare a local
struct — `dean/queries.go:17` already does exactly this, and hermes passes unknown fields
through untouched.

Note `message-worker/worker.go:486` posts a `machine_report` on send failure and
`replybot/lib/index.js:14` posts one on every report — so these two are the highest-volume
synthetic producers, not edge cases.

> #### CORRECTED 2026-08-17 — there are SIX synthetic posters, not four. The two missing ones are the two that cannot know the platform.
>
> An unlisted poster is precisely the thing that keeps a canary non-zero, so this omission
> would have been found the expensive way. Enumerate them at any time by grepping
> `BOTSERVER_URL` in `devops/values/production.yaml`.
>
> | Poster | POST site | Event types |
> |---|---|---|
> | `dean` | `dean/dean.go:78` | `redo`, `timeout`, `repeat_payment`, `follow_up`, `block_user` |
> | `dinersclub` | `dinersclub/synthetic.go:50` | `external` (payment results) |
> | `message-worker` | `message-worker/synthetic.go:50` | `machine_report` (every send failure) |
> | `replybot` | `replybot/lib/index.js:43` | `machine_report` (every report) |
> | **`linksniffer`** | **`linksniffer/eventer.go:44`** | **`external` (`linksniffer:click`)** |
> | **`exodus`** | **`exodus/sender/sender.go:95`** | **`bailout`** |
>
> All six now send `user`, `account_id` and `platform`. But the two new ones are qualitatively
> different from the four above, and the table's premise — *"All have the platform at the call
> site"* — is **false for both**:
>
> **`linksniffer` structurally cannot determine the platform.** It reads its parameters from
> **researcher-authored query strings** — the survey's webview `url` object, hand-written into
> `form_json` — and it is a stateless forwarder with no database. It cannot ask what
> conversation a click belongs to; it can only read what a researcher typed months ago. Two
> paths produce those params and only one is trustworthy:
>
> | Path | `platform` | Correct? |
> |---|---|---|
> | `tracked: true` on the webview field — replybot stamps `id`, `account_id`, `pageid` and `platform` from the live conversation | from `ctx.platform` | always |
> | legacy hand-authored params | **absent → assumed `messenger`** | only if the survey is Messenger |
>
> The assumption is logged as `[LINKSNIFFER_PLATFORM_ASSUMED]`, an invalid researcher-supplied
> value is rejected rather than forwarded (`[LINKSNIFFER_PLATFORM_INVALID]`), and moving the
> guess to the edge makes it explicit, single-located and **countable** — it is not a new guess,
> `replybot/lib/typewheels/utils.js:72` already hard-returned `'messenger'` for a
> platform-less synthetic event. **Why it is safe today and why it will not stay safe** is in
> §8; the short form is that production WhatsApp traffic is **4 conversations, ever**, with
> **zero** webview fields among the three shortcodes involved.
>
> **`exodus` cannot always determine it either.** `user_list` bails carry the platform per
> entry and are exact. Conditions-based bails read their targets from `states`, and
> `exodus/query/builder.go:82` sends `COALESCE(s.platform, 'messenger') AS platform` because
> `states.platform` is a computed column that is **NULL for 97.8% of rows** — so the default is
> load-bearing, and the great majority of conditions-based bails now carry an **assumed**
> platform rather than a known one. (The `AS platform` alias is not cosmetic:
> `executor.go` looks the value up as `row["platform"]`, and an unaliased `COALESCE` lands
> under the key `"coalesce"`, so the lookup misses and the platform silently stays empty.)
>
> **Consequence for the rollout:** step 3's "confirm zero events lacking a component" is
> necessary but **not sufficient**. Both new posters send a *populated* field, so they pass a
> presence check while possibly carrying the wrong identity. Only hermes' **verify** mode
> catches that, and it is not built (§8).
>
> Two smaller corrections to this section:
>
> - **A missing `user` returned 500, not 400** (`handlers.rs:302-307`, pinned by
>   `hermes/tests/handlers.rs:336`). "Missing user is a server error, missing platform is a
>   client error" is indefensible; all three are 400 now, and a missing `user` is
>   **unconditionally** 400 regardless of the gate.
> - **The rollout's step 1 is a config flag, not a deploy ordering property.** See §4's note
>   on `SYNTHETIC_REQUIRE_CONVERSATION`.

> #### CORRECTED AGAIN 2026-08-17 — there are SEVEN posters. The seventh is a browser, so the prescribed enumeration method cannot find it.
>
> The correction above says "enumerate them at any time by grepping `BOTSERVER_URL` in
> `devops/values/production.yaml`". **That method is incomplete by construction, and it is the
> reason the seventh poster survived an audit that was specifically looking for missing
> posters.** It was found by reading `moviehouse/` directly, not by any grep over cluster
> config.
>
> | Poster | POST site | Event types |
> |---|---|---|
> | **`moviehouse`** | **`moviehouse/src/script.js` → `SERVER_URL`** | **`external` (`moviehouse:play`, `:pause`, `:ended`, `:seeked`, `:volumechange`, `:playbackratechange`, `:error`, and `:heartbeat` every 30 seconds)** |
>
> **Why it is invisible.** `moviehouse` is a **browser page deployed from Netlify**, not a
> cluster service. It has no Deployment, no `BOTSERVER_URL`, and no entry in any values file:
> its endpoint is `SERVER_URL` in `moviehouse/netlify.toml`
> (`https://fly-botserver.vlab.digital/synthetic` — hermes' reused hostname),
> mustache-substituted into `src/script.js` by `gulp replace` at build time. Enumerating
> producers from cluster config cannot see a producer that has no cluster presence. Any future
> audit has to enumerate *code that POSTs to `/synthetic`*, not config that names hermes.
>
> **What it cost, ranked** — and note that only the last item is not already one of this plan's
> named failure modes:
>
> 1. `[INCOMPLETE_CONVERSATION]` was **guaranteed non-zero**, so the §7.1 canary gate ("expect
>    zero") was unsatisfiable. The gate could never have been flipped, and the reason would have
>    looked like a mystery rather than a missing poster.
> 2. Flipping `SYNTHETIC_REQUIRE_CONVERSATION` would have **400'd every moviehouse event and
>    killed video tracking**, including the production smoke survey's `wait` on
>    `moviehouse:play`.
> 3. Every moviehouse event bypassed the state cache and forced a full replay — a ~30k-row scan
>    **every 30 seconds per video watcher**, which is a materially different load profile from
>    the once-per-click posters.
> 4. **A correctness bug, not lost analytics.** `transition.js` falls back to `eventPlatform`,
>    which hard-defaults `'messenger'` (`utils.js:72`). A moviehouse event on a **WhatsApp**
>    conversation therefore built outbound commands for the wrong platform. Video events are
>    conversation-advancing — a field can `WAIT_EXTERNAL_EVENT` on `moviehouse:play` — so this
>    is the same class of defect as §1's, reached by a different route.
>
> **The fix follows linksniffer's shape but not its platform policy.** replybot stamps the
> identity into the URL it generates (`tracked: true`), and the browser reads it back out of
> its own query string and forwards it. Where it diverges: **an absent platform is omitted, not
> assumed.** The full argument is in `moviehouse/README.md` and
> `planning/moviehouse-conversation-identity.md`; the short form is that at one heartbeat every
> 30 seconds an assumption would be a continuous stream of mis-addressed events *and*
> structurally non-zero on a counter nobody can gate on, whereas an omission lands on
> `[INCOMPLETE_CONVERSATION]` — the step-3 counter — and drains to zero as surveys migrate.
> Absent degrades to an account-scoped replay; wrong hangs the conversation. Absent dominates.
>
> **One implementation trap worth recording, because it breaks the page rather than the
> telemetry.** `buildTrackedParams` stamped the participant under `id`, and `makeUrl` merges
> stamped params over authored ones. On a moviehouse URL **`id` is the Vimeo video id**
> (`script.js`: `const videoId = params['id']`). Adding moviehouse to the existing allowlist
> unchanged would have overwritten the video id with the participant's PSID, and every tracked
> moviehouse field would have rendered "Sorry, we couldn't find that video". The allowlist is
> therefore host → **param scheme** (`LINKSNIFFER_PARAM_SCHEME` / `MOVIEHOUSE_PARAM_SCHEME`),
> and `isKnownLinksnifferHost` is renamed `isKnownTrackedHost` because the concept was never
> linksniffer-specific.
>
> **Rollout consequence.** Step 2 ("all posters ship the triple") is no longer a single event:
> moviehouse deploys from **Netlify** on a track with no image tag, no values change and no
> `helm upgrade`. Deploy order is nonetheless safe in both directions, by design — replybot
> stamps the legacy aliases (`userId`, `pageId`) alongside the normalized fields, so a
> replybot-first deploy improves an unmodified moviehouse immediately, and a moviehouse-first
> deploy simply finds no new params.

#### 7.3.2 Hermes stamps the normalized fields

At all three produce sites — `handlers.rs:179` (Messenger), `:235` (WhatsApp), `:319`
(synthetic) — per the §4.2 derivation table. The natural home is `event.rs`, alongside
`stamp_event` / `stamp_whatsapp_event`, which already inject `source`, `phone_number_id` and
normalized timestamps.

The Messenger derivation duplicates `parseMessengerEvent`'s echo rule
(`event-normalizer.js:200-206`) in Rust. This is the only logic in the plan that exists in
two languages: it needs a **shared test-vector fixture set** exercised by both
`hermes/src/event.rs` tests and `replybot/lib/event-normalizer.test.js`, not independent
unit tests on each side.

> **It got the fixture, and it binds FOUR implementations rather than two** — Rust, JS, Go
> (`scribble/account.go`, the backward derivation) and SQL
> (`devops/sql/messages-account-id-expr.sql`, the backfill). See §4.1's note. Drift detection
> is verified: inverting `= 'true'` in the SQL fails exactly the three echo vectors.

### 7.4 Give the log tables an account and a platform

```sql
-- devops/migrations/26-messages-account.sql
ALTER TABLE chatroach.messages   ADD COLUMN account_id VARCHAR;
ALTER TABLE chatroach.messages   ADD COLUMN platform   VARCHAR;
ALTER TABLE chatroach.responses  ADD COLUMN platform   VARCHAR;
ALTER TABLE chatroach.chat_log   ADD COLUMN platform   VARCHAR;
```

Then widen `messages`' index to `(userid, account_id, timestamp)` and its conflict target to
`(hsh, userid, account_id)`.

`scribble/message.go:41` currently builds its row from the Kafka key and never parses the
body; it starts reading `account_id` and `platform` from the envelope (§4.3).

**Backfill from `messages.content`** — historical rows carry the account under its per-shape
name: `phone_number_id` (WhatsApp), `recipient.id` / `sender.id` (Messenger), `page`
(synthetic). §4.2 keeps those fields, so the backfill and the forward path read the same
source and share one implementation.

Must complete **before** §7.5, or every existing conversation replays as empty.

Migrations 18/19 just dropped indexes on `messages` for size; widening one here partly
reverses that. Size it before running.

> #### CORRECTED 2026-08-17 — THE PREMISE IS FACTUALLY WRONG. `(hsh, userid)` is ALREADY account-scoped, so no primary-key change was needed — and this phase collapsed from a 384 GiB rewrite to two nullable columns plus one index.
>
> This is the single largest de-risking in the whole effort, and it comes from reading one
> line of the schema.
>
> **`hsh` is a hash of the ENTIRE `content` blob:**
>
> ```sql
> hsh INT AS (fnv64a(content)) STORED NOT NULL,          -- 01-init.sql:22
> CONSTRAINT "primary" PRIMARY KEY (hsh, userid),        -- 01-init.sql:23
> ```
>
> And the account identifier is **inside `content`** in every event shape — `recipient.id` /
> `sender.id` on Messenger, `phone_number_id` on WhatsApp, `page` on synthetic, and now the
> normalized top-level `account_id` on all three. So two events differing only by account
> produce **different `content`**, hence **different `hsh`**, hence no conflict.
> **`ON CONFLICT (hsh, userid)` is already transitively account-scoped.** There is nothing to
> widen.
>
> *(The hash is `fnv64a`, not `farmhash`. Worth stating explicitly because
> `facebot/testrunner/package.json` genuinely depends on `farmhash` for its own fixture
> hashing and `test.tc.ts` imports it — two different hashes, one of them not the
> database's. Anyone computing an expected `hsh` from the wrong one gets the wrong value.)*
>
> **The only remaining route to cross-account loss is a genuine 64-bit `fnv64a` collision
> between two different contents — and widening the key is not a coherent fix for that
> either.** It would eliminate only the *cross-account subset* of hash collisions and leave
> same-account collisions — overwhelmingly the larger population, since only 0.175% of users
> have ever spanned two accounts (§1.3) — entirely untouched. `SHOW STATISTICS` has reported
> `distinct(hsh) == row_count` at every sample back to 2024 (101,118,611 / 101,118,611 at the
> latest).
>
> Severity differs too, and that asymmetry is the reason 27 and 28 were worth their cost and
> this was not: **a dropped `messages` row costs an event in replay; a dropped `responses` row
> WAS a participant's answer.**
>
> **The rewrite was additionally impossible on disk.** Measured in production 2026-08-17:
>
> ```
> messages   384.6 GiB   9089 ranges   106,275,818 rows
>   primary                        128.2 GiB
>   messages_userid_timestamp_idx  128.2 GiB
>   messages_userid_idx            128.2 GiB   (NOT VISIBLE -- see §8, migration 19)
>
> cluster    4 x 235.9 GiB, 413.7 GiB used, 127.4-133.7 GiB free per node
> ```
>
> `ALTER PRIMARY KEY` rebuilds the primary index **and every secondary index**, so peak would
> have been +384.6 GiB replicated = **+96 GiB/node against 127.4 GiB free on the tightest
> node** — 75% of free space, held for `gc.ttlseconds` (25h) afterwards. And `account_id`
> cannot be nullable inside a primary key (SQLSTATE 42P15), so a **complete** backfill of all
> 106M rows would have been mandatory **first**, adding ~+128 GiB replicated of MVCC garbage
> and taking the realistic peak **past the free space on two of the four nodes**. Expressed at
> cluster level, the §7.4/§7.5 stream's own Option A/B costing put the peak at **~798 of
> 943.6 GiB — 85% full, held 25h for GC**; that framing is attributable to that analysis
> rather than to the migration file, whose header states the per-node form above. (The sizing
> uses the replica-inclusive reading of `range_size`, verified rather than assumed: under the
> per-replica reading `messages` alone would need ~960 GiB inside a cluster whose *total* used
> space is 413.7 GiB, which is impossible; the replica-inclusive reading closes the cluster
> arithmetic to within 1%.)
>
> **What shipped instead** (`devops/migrations/26-messages-account.sql`):
>
> 1. Two nullable, defaultless columns on `messages` — metadata-only, instantaneous on 106M
>    rows. A `DEFAULT` would have forced the very full-table rewrite this avoids.
> 2. `platform` on `responses` and `chat_log`. **Nothing writes these two yet** — see §8.
> 3. One new secondary index, `messages_userid_account_timestamp_idx (userid, account_id,
>    timestamp) STORING (content, platform)`: an online, resumable, cancellable change
>    touching **one** index, +128.2 GiB replicated (~32 GiB/node, ~25% of free). If it goes
>    wrong the partial index is dropped and the primary index was never touched.
> 4. The superseded `messages_userid_timestamp_idx` is made **NOT VISIBLE, not dropped** —
>    migration 18's house pattern on this exact table. Revert is one instant, zero-rebuild
>    statement. Migration 29 drops it after a soak and is **deliberately unwritten** (§8).
>
> **Two consequences that are improvements, not merely savings:**
>
> - **No deploy-ordering hazard at all.** `scribble/message.go` keeps `ON CONFLICT (hsh,
>   userid)`, so old and new scribble run against both schemas in either order — the exact
>   opposite of migrations 27 and 28.
> - **`account_id` stays nullable**, which is what makes the backfill incremental,
>   interruptible, and safe to run **after** the read path ships.
>
> **Therefore "Must complete before §7.5" is REVERSED.** The correct order is schema → read
> path → backfill at leisure: migration 26, then the `chatbase-postgres` `get()` change
> (which *tolerates* NULL `account_id`), then `devops/backfill-messages-account.sh`. Under a
> strict read the un-backfilled rows would replay as EMPTY, turning the catastrophe this
> sentence warns about from a sequencing risk into a **guarantee** — see §7.5's amendment for
> why.
>
> One last note on this section's last paragraph: **migration 19 was never applied**, so the
> harness and production disagree about which indexes `messages` has. Size against production,
> never against the harness. See §8.

### 7.5 Move the replay path onto the tuple

`chatbase-postgres` `get()`: key on `(userid, account_id)` and change the join to
`USING (userid, account_id)`, which also removes the multi-row duplication and fixes the
`message_pointer` leak (§2.2 item 4).

`put()` is not on the live path — `grep` finds only `statestore.js:69` using `db.get`;
`messages` is written by scribble. Leave it.

~~Separate repo: publish and bump `@vlab-research/chatbase-postgres` in
`replybot/package.json:21`.~~ **SUPERSEDED 2026-08-17 — the package was absorbed into
the repo instead.** The client now lives at `replybot/lib/chatbase/`, the dependency and
the `CHATBASE_BACKEND` indirection are gone, and there is nothing to publish or bump. See
§8.1.

**§7.4 and §7.5 are one unit.** §7.4 alone buys nothing; §7.5 without §7.4 replays every
conversation as empty.

> #### CORRECTED 2026-08-17 — `USING (userid, account_id)` does not survive contact with the schema, and the literal form would have introduced a subtler version of the bug this phase exists to fix.
>
> Three deviations from the text above. All are deliberate, all are load-bearing, and at
> least two are the kind a later reader would "correct" back into a bug.
>
> **(a) `USING (userid, account_id)` does not even parse.** `states` has **no `account_id`
> column** — it has `pageid`, until §7.7's rename, which is untouched. The join needs an
> explicit alias or a filter. §7.7 is load-bearing for more than cosmetics.
>
> **(b) `states` is FILTERED by the account, not JOINED on it — and this is the important
> one.** Under the literal composite join, `NULL account_id` matches nothing, so every
> **un-backfilled** `messages` row gets a NULL `message_pointer` and therefore **bypasses
> truncation entirely**. `form.reset` would silently stop truncating history for the entire
> duration of the backfill, and the failure would be *coupled to backfill progress*. That is
> a second, subtler instance of exactly the bug §7.5 exists to fix — history that fails to
> truncate.
>
> Filtering does strictly more of what this section wants, for a reason that has nothing to
> do with style: `states` is `PRIMARY KEY (userid, pageid)`, so `pageid = $2` selects **at
> most one row** for free. The multi-row duplication came from the subquery returning one row
> *per account*, not from the join key — so filtering removes it just as a composite join
> would, fixes the `message_pointer` leak for the same reason, **and** keeps the pointer
> applying to rows whose `account_id` is still NULL.
>
> Recorded prominently because *"but the plan said `USING`"* is precisely the argument
> someone will make later.
>
> **(c) The read is TOLERANT of a NULL account, and must stay that way:**
>
> ```sql
> WHERE userid = $1 AND (account_id = $2 OR account_id IS NULL)
> ```
>
> The strict form (`account_id = $2`) was specified first, in order to force "§7.4 fully
> backfilled before §7.5 ships." **That was wrong and dangerous.**
> `STATE_STORE_LIMIT` (set to `"30000"` in both `production.yaml` and `staging.yaml`; the code
> itself leaves it undefined by default) combined with `ORDER BY m.timestamp ASC` means replay reads the
> **OLDEST** 30k events — precisely the ones a partial backfill has not reached. Under the
> strict contract, any conversation whose old events are not yet backfilled replays as
> **empty**. And there is no recency bound to exploit *because of* that ASC ordering: you
> cannot backfill "just the recent tail" and be safe. Sizing confirms it cannot simply be
> rushed either — 87% of `messages` predates 2025-02 and only ~8% is newer than 2026-01-01,
> so a full backfill is ~106M rows of write amplification.
>
> Under the tolerant clause, historical rows behave **exactly as they do today** — no better,
> no worse — new rows are strictly scoped, and the clause becomes a no-op as the backfill
> drains. **Do not "tighten" it.** Returning NULL-`account_id` rows is not a leak; it is the
> only thing standing between the backfill and mass conversation loss. Its removal condition
> is recorded in §8 and in migration 26 §4 — note that a plain count of NULL `account_id`
> never reaches zero and should not, because a small tail of synthetic events carry no
> account at all and are permanently unattributable.
>
> **(d) The signature is an OBJECT, and a bare string THROWS.** `get({ userid, account },
> limit)`. Passing the old call shape raises `ChatbaseValidationError` rather than silently
> reading unscoped, and omitting the `account` key throws rather than defaulting. That throw
> is the guard that stops a forgotten call site degrading quietly back to the bug — the one
> failure mode that would reintroduce this whole class of defect with no test going red —
> and it is why the call-site migration can be done incrementally with no silent-unscoped-read
> window.
>
> **(e) The unscoped fallback reproduces today's semantics EXACTLY, and the obvious
> aggregation would have been wrong:**
>
> ```sql
> CASE WHEN bool_or(message_pointer IS NULL) THEN NULL ELSE min(message_pointer) END
> ```
>
> A plain `min(message_pointer)` is the obvious choice and is a **silent data-visibility
> regression**: `min()` ignores NULLs, so a participant with one un-pointed conversation would
> have had the *other* conversation's pointer applied, **truncating MORE history than today**.
> It produces a shorter replay, never an error, so no existing assertion would catch it.
>
> **(f) `SELECT content`, not `SELECT *`** — an explicit precondition of migration 19 that was
> never shipped. While `SELECT *` remains, EXPLAIN emits an index recommendation to recreate
> the very index migration 19 drops, because `*` pulls `id`, which lives only in the primary
> index. `get()` discards everything but `content` anyway.
>
> **Finally: "§7.4 and §7.5 are one unit" is right, but its ordering claim is reversed** —
> see §7.4's amendment. Schema, then read path, then backfill.

### 7.6 The messaging account registry — removed

§5's registry (table, backfill, dual-write, `documentation/messaging-accounts.md`, and the
revision to `documentation/platform-abstraction.md`) was built and then **deliberately
reverted** in `5c4cab3e`, before any consumer read from it.

**Why, in the commit's own framing.** The conversation triple `(platform, account_id,
user_id)` never needed the registry — replybot reads all three off the event envelope hermes
stamps at ingest; there is no lookup on the path this branch fixes. `entityToPlatform` guessed
a credential's platform from its `entity` because the create endpoint was never told one — a
one-time migration concern (existing credentials predate the platform column) promoted into
permanent business logic. Platform is user input, not a derivation: the user picks the platform
when connecting an account. And `credentials` is keyed `(entity, key)` where `key` *is* the
account id, and messaging account ids are globally unique in production, so a bare account id
already resolves to exactly one credential without knowing the platform — which is what
`message-worker/tokenstore.go`'s fallback already does. The registry's genuine future use is
**Instagram**, whose webhooks carry the Instagram account id rather than the Page id, so the
derived id matches no `credentials.key` — a mapping problem the registry's row shape solves. It
returns when Instagram or a connect-accounts UI needs it.

**Consequence for this document.** Because the reversal amendment in
`documentation/platform-abstraction.md` is also gone, the **ratified 2026-07-22 decision** —
account identity is `(allocator, id)` serialized to one opaque string, with first-class
`(platform, account_id)` pairs explicitly **rejected** — now **stands unreversed**
(`git diff main -- documentation/platform-abstraction.md` is empty). Anywhere in this document
that treated the reversal as settled ground is flagged **OPEN — needs decision** rather than
silently corrected; see §7.1's "Note on the second bullet" and the interim-exposure paragraph
after the order-of-work table.

**Status:** removed. The full implementation — migration 25, the dual-write transaction, the
pure decision layer, 42 tests, the sql-exporter collectors and
`documentation/messaging-accounts.md` — is preserved on
`origin/archive/messaging-accounts-registry`. §5.1's consumer inventory (still true of live
code) is kept in §5 as background. Independent of §7.1–§7.5; its removal does not block them.

### 7.7 Rename `pageid` → `account_id`

Cosmetic, last. `states`, `responses`, `chat_log`. CRDB `RENAME COLUMN` is metadata-only and
dependent indexes track automatically (migration 22's note), but the name is referenced
across dean, exodus, scribble, formcentral and the dashboard — the cost is in the code, not
the database. One service at a time.

> **Untouched, and less cosmetic than it looks.** Two places now carry an alias purely
> because it has not happened: `chatbase-postgres` `get()` selects `states.pageid` while
> `messages` has `account_id` (§7.5(a)), and exodus's builder joins on `s.pageid`. When §7.7
> lands, dropping those aliases is a rename, not a bug fix — which is the argument for doing
> it rather than the argument for deferring it further.

---

## 8. Open items

Everything below is known, deliberate and unfinished as of 2026-08-17. **Two of these are
regressions, not enhancements**, and are marked.

### 8.1 ~~Blocks final green on the test suite~~ RESOLVED 2026-08-17 by absorbing the package

**Do not publish anything. There is no longer a package.**
`@vlab-research/chatbase-postgres` has been vendored into the repo at
`replybot/lib/chatbase/` (client, `ChatbaseValidationError`, and all 17 of its tests). The
dependency is gone from `replybot/package.json` and from `facebot/testrunner/package.json`,
and the `CHATBASE_BACKEND` env-var indirection is gone with it — `spine-supervisor.js` and
`lib/responses/debugger.js` now `require('../chatbase/chatbase')` directly.

The blocker this section described was real, and worth preserving as the reason the split
was abandoned rather than repaired:

| Step it used to require | Why it was a dead end |
|---|---|
| Publish `0.2.0` | Needed npm credentials, so it could not be done from this repo — the integration suite was gated on a human with a token. |
| Bump `replybot/package.json` `^0.1.0` → `^0.2.0` | A caret on a `0.x` pins the **minor**, so `^0.1.0` never resolves `0.2.0`. Publishing *alone* changed nothing, and the resulting red was indistinguishable from "not published yet". |

Two further facts turned "repair the split" into "delete the split": the indirection had
**exactly one implementation** for its whole life, and the two consumers were on
**different versions** (`^0.2.0` vs `0.0.3`) — so the integration suite was asserting
against a four-versions-older client than production ran, which is a bug in its own right.

> **The old objection no longer applies.** This section used to say vendoring "would turn
> the suite green against code that is not what production would run, which is worse than
> an honest red." That was correct about `npm link`ing a *local build* while the image
> still installed from the registry. It is the reverse of the situation now: replybot's
> Dockerfile does `COPY . /usr/src/app`, so the vendored file **is** what production runs,
> and the harness and production build from one source tree. The property the split never
> had is the one vendoring provides.

### 8.2 Regressions

**The `chat_log` producer is gone, and researcher exports are silently truncated.**
`replybot/lib/chat-log/publisher.js` was deleted in `675c31bd` (2026-07-17, "Phase 2: Refactor
machine.js, transition.js, and core typewheels for UniversalEvent") — **collateral damage in a
refactor, not a deprecation.** It reached production around `replybot-v0.0.211-wa`
(~2026-07-26) and the last `chat_log` row landed **2026-07-27 01:30:05**. Production runs
`v0.0.218`, which still contains the deletion.

The table was at its **highest volume ever** when writes stopped — 606,187 rows in July 2026,
still accelerating (Feb 70,234 · Mar 22,169 · Apr 67,593 · May 224,655 · Jun 488,886 ·
**Jul 606,187** · **Aug 0**) against 1,479,724 total. **The table is dormant by accident, not
deprecated.**

Everything downstream is still deployed and still advertised: the dashboard offers "Create
Chat Log Export" (`dashboard-client/src/containers/CreateChatLogExport/`), the exporter serves
it (`exporter/exporter/main.py:109-111`), and the `chat_log` scribble sink runs against an
empty topic. **So exports succeed and silently return data that stops on 2026-07-27** — every
conversation from the platform-abstraction cutover onward is missing from a feature the product
still offers, with no error shown. Three weeks and counting.

Two things follow, and they point in opposite directions:

- **Migration 27 was cheap precisely because of this window.** An `ALTER PRIMARY KEY` plus
  backfill and `SET NOT NULL` over 1.48M rows ran against a **quiescent** table, with no
  concurrent writes to contend with and no consumer to crash-loop. **That window closes the
  moment the producer returns**, and it does not expire on its own — it closes when we choose.
  Which is why this work landed first rather than racing it.
- **Restoring the producer is BLOCKED** on migration 27 *and* the matching scribble build,
  both deployed. Either half alone fails *every* write with 42P10 — the migration without the
  build mismatches the old three-column `ON CONFLICT`, the build without the migration
  mismatches the new four-column one — and scribble treats a write error as fatal, so the sink
  **crash-loops** rather than degrading. A dormant topic hides the mismatch entirely until the
  first message arrives. **The restoration is what detonates it, so the restoration is what is
  gated.** The restored producer must also publish the account on every entry (see §7.2's
  amendment on the 14,834 NULL rows).

**Migration 19 was never applied.** `messages_userid_idx` is still on disk in production at
`visible = f` — **~128 GiB replicated of dead index** — armed as a canary on 2026-07-22 and
never phase-2'd. Applying 19 before migration 26 makes the whole account-column change **net
disk-negative**. Escalated separately; noted here because it is why harness index counts and
production index counts disagree, and why §7.4's sizing had to be done against production.
Note the file itself (like `18-drop-cold-message-indexes.sql`) is **not on this branch** — both
exist untracked in the primary worktree, so every test harness builds `messages` with indexes
production no longer serves.

### 8.3 Deliberately unwritten or unbuilt

| Item | State |
|---|---|
| **Migration 29** — drop the superseded `messages_userid_timestamp_idx` after a clean soak | Deliberately not written. Migration 26 made the index NOT VISIBLE instead, following migration 18's pattern on this exact table; writing 29 now would invite dropping before the soak. |
| **`platform` on `responses` and `chat_log`** | Columns exist (migration 26); **no writer**. `scribble/response.go` and `scribble/chatlog.go` read no platform from their message shapes, and `chat_log` has no producer at all. The columns landed early because adding them is free and because the chat-log restoration should not also have to carry a migration. |
| **hermes account→platform resolution** | Designed, not built, and now **blocked on the registry's return** (§7.6) — the design was an in-memory `account_id -> (platform, userid)` map read from the registry's rows, and the registry no longer exists. **Two modes were envisioned, and only one would have been useful today** — *fill* (platform absent → resolve and stamp; additive, but a **no-op** now that all six posters send a platform) and *verify* (platform present → check it against the registry; a **tightening**, so it would have sat behind `SYNTHETIC_REQUIRE_CONVERSATION`). Verify is the one that would have mattered, because the live risk is a platform that is **present but assumed** (linksniffer's legacy links, exodus's `COALESCE`) and fill mode cannot see those. Every part of this is a first for hermes: it currently has no database access of any kind, no background tasks and no metrics. This item has no path forward until the registry (or an equivalent) exists again. |
| **§7.7's rename** | Untouched. See §7.7's note for the two aliases it would remove. |
| **The registry's consumer migration** (formerly §5.5 steps 3–5) | Moot — the registry was reverted before any consumer was migrated. See §7.6. |

### 8.4 The linksniffer platform assumption, and when it stops being safe

`linksniffer` assumes `platform=messenger` when the researcher-authored query param is absent
(`linksniffer/server.go:60-68`, logged `[LINKSNIFFER_PLATFORM_ASSUMED]`). **Why that is safe
today, measured in production 2026-08-17** (`planning/whatsapp-webview-exposure.md`):

- **All WhatsApp traffic that has ever existed is 4 conversations**, on 3 shortcodes (`305`,
  `hpvbl`, `hpvincentivedouble`), created 2026-08-13..17. **None of those shortcodes contains a
  webview field** — 0 of 10 `305` variants, 0 of `hpvbl`'s 68 fields, 0 of
  `hpvincentivedouble`'s 18.
- Of 84 live webview surveys on WhatsApp-capable accounts, **0 have ever been served on a
  WhatsApp account**, and **0 of 1007 live webview fields repo-wide author a `platform`
  param.**

**Why it becomes wrong as WhatsApp grows.** `webview` is not Messenger-only — WhatsApp renders
it as a `cta_url` interactive message. Today `transition.js` prefers the conversation's own
platform over the event's hint, so a wrong hint is absorbed. **§7.1 removes that absorption**:
the cache key is derived from the *envelope*, and the lookup happens before `transition.js`
runs, so a wrong `platform` addresses a conversation that does not exist.

There is one **real** exposure today and it is not the platform param: every one of the **49
WhatsApp-capable linksniffer surveys hardcodes a Messenger `pageid`** into the tracked link, or
omits it entirely, and the WhatsApp-served forms *stitch* into some of them. A WhatsApp participant on `1265380589988964` who reaches `hpvfup` and clicks
gets a `linksniffer:click` stamped `page=101435865704727` — a Messenger page belonging to the
same researcher. §7.1 does not create that; the hardcoded `pageid` does. All 16 reachable
fields are `keepMoving: true`, so the cost is **lost click analytics, not a hung
conversation.**

**The migration that fixes it properly: `tracked: true` on every webview field** — replybot
then stamps `id`, `account_id`, `pageid` and `platform` from the live conversation, and nothing
is hand-authored. **Size: 104 live surveys / 346 fields / 7 researchers.** Of those, **13
surveys / 16 fields `wait` on `linksniffer:click`** and therefore **hang** rather than degrade
when a click is misrouted — all `worldbank@vlab.digital` (Girl Effect, Kenya TVET) plus 2 test
forms. `wazzii` / `both` / `tuki` are the most active linksniffer-wait surveys in production
(243 / 224 / 197 participants, last active 2026-08-17). **If worldbank ever runs Girl Effect on
`1265380589988964`, those hang.** That is the migration trigger — not §7.1.

Two hazards for whoever writes that migration: any host allowlist that omits
`gbvlinks.nandan.cloud` misses **56% of production tracked links** (193 of 346 fields, and it
appears in no values file), and 265 of 346 linksniffer fields author no `pageid` at all.

> #### AMENDED 2026-08-17 — the same analysis for moviehouse, and it is worse in every dimension. The hypothetical in this section has already fired in production.
>
> This section's framing — "why the assumption is safe **today**", "that is the migration
> trigger, **not** §7.1" — rests on the intersection of "runs on WhatsApp" and "has a
> hand-authored tracked link" being **empty**. That is true for linksniffer. **It is not true
> for moviehouse**, and the difference was measured, not projected.
>
> **Reproduced, 2026-08-13, four days before this was written.** Participant `15126808320`
> (worldbank), `hpvbl` served on WhatsApp → stitch → `hpvmedia`:
>
> ```
> 22:27:33  bot_echo, phone_number_id 1265380589988964   (delivered over WhatsApp)
>           webview url=…/?id=1143993262&pageId=101435865704727&userId=15126808320
> 22:27:34  page 1265380589988964 -> WAIT_EXTERNAL_EVENT (awaiting moviehouse:play)
> 22:27:48  synthetic {"user":"15126808320","page":"101435865704727", …   <-- WRONG ACCOUNT
> 22:27:49  page 101435865704727 -> WAIT_EXTERNAL_EVENT, issues send_message
> 22:27:55  page 101435865704727 -> BLOCKED       (still BLOCKED in production)
> ```
>
> A **phantom conversation on a Facebook page keyed by a phone number**, now a durable `states`
> row whose key is a Facebook page while its `md.pageid` is a WhatsApp `phone_number_id`. The
> real WhatsApp conversation never got its `moviehouse:play` and the participant had to re-enter
> the survey. The cause is exactly the one this section names for linksniffer — a **hardcoded
> Messenger `pageId`** — reaching a producer that echoes it back on every event.
>
> **A methodological correction to `whatsapp-webview-exposure.md`.** Its WhatsApp-exposure
> filter, `states.pageid IN (<whatsapp credential keys>)`, **cannot see that row**, because the
> row hides on a Facebook page id. Every "0 have ever been served on WhatsApp" figure in that
> document is therefore a *lower bound*, not a proof. Filter on `platform='whatsapp'` (itself a
> lower bound — NULL for most rows) or on phone-number-shaped `userid`.
>
> **The moviehouse migration, sized the same way.** 82 live surveys / **570 fields** / 4
> researchers / **0 currently `tracked`**. WA-owner: 36 surveys / 178 fields.
>
> | | linksniffer | moviehouse |
> |---|---|---|
> | fields | 346 | **570** |
> | fields that `keepMoving` | 634 of 1007 webviews | 225 of 570 |
> | fields that **`wait` on the event** | **19** | **536** |
> | surveys with ≥1 such wait | 15 of 104 | **82 of 82** |
> | ever served on WhatsApp | 0 (lower bound) | **yes, and it broke** |
>
> **The risk profile is inverted.** For linksniffer most fields `keepMoving`, so a misrouted
> click costs analytics. For moviehouse **every one of the 82 surveys waits on a moviehouse
> event**: 410 fields wait on `moviehouse:play` with no timeout and **hang indefinitely**; only
> 126 carry an `op: or` timeout and can self-recover. Nothing degrades gracefully.
>
> **A third legacy host, and it is dead.** `virtuallab-videos.netlify.com` carries **490 of 570
> live moviehouse fields (86%)** and appears in **no file in this repo** — the
> `gbvlinks.nandan.cloud` trap one letter over, and the reason this section's first hazard is
> restated rather than fixed. It also returns **404** (a retired Netlify alias, not a redirect),
> so those 490 fields point at a page that cannot load while waiting on an event it can never
> send. Roughly **4,000 conversations sit in `WAIT_EXTERNAL_EVENT`** across `johhnormsar` (3657),
> `ninevehshorttreat` (207) and `ninevehshortplacebo` (181) — mostly predating the retirement, so
> co-occurrence rather than attributed cause, but unrecoverable either way.
>
> **Priority note: the `.netlify.com` rewrite outranks the `tracked` migration.**
> `tracked: true` on a dead host is correct and useless. Rewriting `.netlify.com` →
> `.netlify.app` across 64 surveys (or retiring them) is what restores function, and it also
> fixes the host half of the `userId` problem below.
>
> **`pageId`: 465 of 570 fields (81.6%) hardcode it**, versus 81 of 346 for linksniffer. Only 2
> interpolate (`{{hidden:pageid}}` — both in `flysmoke`, the single correctly-authored survey in
> the set). **63 hardcode junk**: `105246245358509)` ×37, `720722553` ×18 (a *Vimeo* id),
> `105246245358509)720722553` ×8. Vimeo ids and page ids are both bare 9–15-digit strings, so
> the collision is invisible to any shape validation.
>
> **That junk has a root cause, and it is a live bug in another stream's file.**
> `_removeMdLinks` (`replybot/lib/typewheels/form.js:327-333`) uses a **non-global**
> `mdLinkPattern`, so only the *first* markdown link in a description is unwrapped. Typeform
> auto-linkifies pasted URLs, an edited field accumulates several, and the leftover `](…)`
> fragments concatenate into the query string. Re-running the promotion with interpolation
> applied **first** (as `form.js:169` does) gives a byte-identical histogram, so this is not a
> static-analysis artifact the way §Dirt's `[object Object]` entries were. It reached
> production: `states` holds `pageid = '105246245358509)'`, 1 participant, 2022-10-26,
> `current_form testplac2` — which is precisely the unexplained "trailing paren" row in
> `whatsapp-webview-exposure.md`'s dirt table. **Now explained.** Fix is one `/g`.
>
> **`{{hidden:userid}}` is a hazard with zero live instances** — 0 of 570 moviehouse fields, and
> only 3 survey rows repo-wide, all 2021-era and non-moviehouse. **The real `userId` defect is
> the opposite: 411 of 570 fields (72%) omit it entirely**, which has hard-failed the page since
> commit `126cbc7e` (2025-11-09) inverted the default — omitting `userId` used to select the
> Messenger-Extensions path and now fails `validateRequiredParams()` unless `useExtensions=true`,
> which **zero surveys author** (0 of 570 fields; 0 of all 5149 survey rows). Blast radius on
> currently-active surveys is **zero** (408 of the 411 are on the dead `.com` host; the other 3
> are a test survey), but 411 stored fields encode the pre-`126cbc7e` contract. `tracked: true`
> fixes all of them incidentally, because replybot stamps `userId`.
>
> Full measurement, with SQL: `planning/moviehouse-conversation-identity.md`.

### 8.5 Housekeeping surfaced by this work

- **Leftover 2021-era `kube-scratch` manifests** — `replybot/kube-scratch/` and
  `replybot/kube-scratch-dev/`, both last touched **2021-05-17** — plus the `scratchbot`
  dependency at `devops/vlab/Chart.yaml:61-65` and its chart at
  `replybot/scratch/chart/Chart.yaml`. They name entrypoints this branch deleted as dead code
  (`replybot/lib/responses/scratchbot.js`, `stateman.js`, `batch.js`). Dead config pointing at
  dead code; delete together.
- **`exodus`'s `go test ./...` needs `-p 1`.** `query/` and `db/` both `DELETE FROM` the same
  tables in their setup helpers, and `go test` runs *packages* in parallel, so without `-p 1`
  they truncate each other's fixtures mid-test. Documented at `exodus/README.md:335-351`;
  `make test` already does the right thing.
- **`dashboard-server/config/index.js:100` hardcodes the test port** —
  `port: isTest() ? 5433 : envVars.DB_PORT || 5432` — with **no env override on the test
  branch**, so the suite cannot be pointed at a database that has migrations-under-development
  applied. The `chatbase-postgres` suite solved the same problem with a
  `CHATBASE_TEST_PORT` escape hatch; this one still needs it.

---

## Appendix A — CTWA autofill ref must be order-independent

Separate live defect, found during the same reproduction. Independent of everything above;
ship whenever. **Fixed on this branch** — `WHATSAPP_ENTRY_REF`
(`replybot/lib/event-normalizer.js:275`) now admits leading dotted pairs and reassembles the
whole ref.

The ad entry in §1.1 landed on `FALLBACK_FORM=305` because its autofill text was:

```
ctwaprobe.alpha.creative.Ad1H.form.probetest
```

`WHATSAPP_ENTRY_REF` (`replybot/lib/event-normalizer.js:257`) is

```js
/^(?:start\s+)?form\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/i
```

— anchored on `form.` coming **first**. A CTWA referral carries no `ref` of its own (the
comment at `:279` documents this correctly), so `_refFromText` is the only recovery path,
and it rejected this body outright.

This contradicts `documentation/referral-form-resolution.md`, which states `_group` is
order-independent: "`form.ABC.creative.x` and `creative.x.form.ABC` both resolve to
`form: 'ABC'`. The form pair does not have to come first." The doc is right; the code is
wrong.

**Consequence:** any Click-to-WhatsApp ad whose autofill does not lead with `form.` silently
lands on survey `305` — the same failure shape as VIR-19, and just as invisible, because 305
is a real survey that looks like a completion.

**Fix:** accept a full-match dotted token list containing a `form` pair in any position and
return the whole body as the ref, letting `getMetadata`/`_group` parse it. Keep the
full-match anchoring so a mid-survey free-text answer cannot re-trigger entry. The current
code returns `` `form.${match[1]}` `` — a pattern change must not double-prefix.

`e73f9ff7` is in `replybot-v0.0.218`, so this is live production behavior.

---

## Appendix B — a FORM-LESS entry event may not re-enter a live conversation

Third separate live defect in this family, and the oldest: live in production from at least
**2020-06** to now. It was found while tracing §7.1's failure signature and was originally
recorded here as an *incidental finding* — it is not. It is a defect in scope, now fixed on this
branch, and this appendix is its record. **Fixed on this branch** —
`replybot/lib/typewheels/machine.js`, `exec`'s `REFERRAL` case
(`_refNamesForm` + `DEFER`), with the shell half in `transition.js`.

**Independent of everything else in this document.** It needs no archive lag, no cache miss, no
empty replay and no cross-account event. It is the same *outcome* as §7.1 and Appendix A —
a participant silently switched onto `FALLBACK_FORM=305`, a real live survey belonging to the
same researcher who owns the account the conversation is already on (this mechanism has no
cross-account step, so it cannot land on another researcher's survey — the shortcode lookup
never crosses that boundary), whose misrouted participants finish in one message and therefore
look like completions — reached from a fourth cause.

**The mechanism.** `categorizeMessengerEvent` maps Messenger's bare `get_started` postback to
`conversation_started` with `referral: undefined`, so it routes to `REFERRAL`, `getForm` finds no
ref and resolves `FALLBACK_FORM`. **`REFERRAL` was the one entry path with no
`state.state === 'START'` guard** — deliberately, because a referral naming a form is supposed
to be able to switch a live participant onto it — so `_blankStart` pushed `305` onto a live
conversation's stack at any state and replaced `md` wholesale. A referral whose `ref` yields no
`form` pair (`clickToMessengerAds`, `homescreenpwa`, a referral object with no `ref`, a CTWA
referral with no resolvable ref) does the same thing for the same reason: 4% of cases.

**This is the third webhook in §6b's ad-click race** (handover ~1.5 s before the referral, the
referral, then `get_started` 1–4 s after it) — but the race accounts for only ~11% of it. See
below.

### Production exposure and prior-state distribution (measured 2026-08-17)

3,732 `states` rows have `FALLBACK_FORM` appended to an existing stack — continuously from
2020-06 at 10–90/month. 561 of them (stratified, ≥8 per month across all 76 affected months) had
their real `chatroach.messages` logs replayed through `machine.exec`/`apply`, reproducing
production's own user-keyed replay. State **at the moment of the append**:

| Prior state | Count | Share |
|---|---|---|
| `END` | 263 | 50% |
| `QOUT` | 117 | 22% |
| `RESPONDING` | 73 | 14% |
| `WAIT_EXTERNAL_EVENT` | 34 | 7% |
| `BLOCKED` | 30 | 6% |
| `ERROR` | 4 | 1% |
| `START` | **0** | — |

44% mid-survey; 50% re-engagement after finishing; **every append onto a non-empty form stack**.
96% were appended by a bare `get_started`. Of the 499 `get_started` appends only 62 arrived
within 5 s of the participant's last inbound event (the traced ad-click race, which lands in
`RESPONDING`); 129 arrived more than a day later. **The dominant mechanism is a later Get Started
tap, not the race** — which is a correction to the framing this defect was first recorded under.

### Why the fix could not simply ignore `get_started`

162,148 `states` rows are `FALLBACK_FORM` conversations with a length-1 stack. A replayed
452-row sample shows what enters them: plain `text` 42%, **bare `get_started` 35%**, `media`
18%, form-less referral 3%, `quick_reply` 2%, handover 1%. A bare `get_started` is **not** the
sole organic entry signal — plain text is commoner — but it is roughly a third of them, some
57,000 conversations, and 158 of those 159 had no referral anywhere in their log. Demoting it in
the normalizer would have broken organic Messenger entry outright.

What makes the guard safe is that all 450 replayed entries happened on the **first event the
machine acted on**: `forms: []` and `state: 'START'` coincided for every one.

### The fix, and the three choices inside it

```js
if (!_refNamesForm(nxt) && state.forms.length) {
  return { action: 'DEFER', reason: DEFER_FALLBACK_ENTRY_ON_LIVE_CONVERSATION, event_type: nxt.event_type }
}
return _blankStart(nxt)
```

1. **The discriminator is the REF, not the resolved form.** `getForm(nxt) === FALLBACK_FORM`
   reads as the obvious equivalent and would have broken three live production rows entered on
   `?ref=form.305.country.iraq` (page `102398018371948`) — an explicit ref that happens to name
   the fallback shortcode. `_refNamesForm` re-uses `_group` from `utils.js`, so it cannot
   disagree with `getMetadata` about whether a ref carries a form.
2. **`state.forms.length`, not `state.state !== 'START'`.** The proposal in
   `documentation/referral-form-resolution.md` said `START`; the two agree on all 3,732 appends
   and all 450 entries, and `forms.length` is safer where they diverge — a `machine_report`
   error arriving before entry leaves `ERROR` with an empty stack, and a `START`-name test would
   refuse entry to someone who has no conversation at all.
3. **`DEFER`, reusing §7.1's mechanism, not `_noop()`.** This is the lesson from §7.1 applied:
   `_noop` returns `newState`, `lib/index.js` publishes it, `scribble/state.go` UPSERTs it over
   the live conversation's real `states` row — the row every recovery sweep selects on — and
   bumps `updated`. Nothing happened here, so nothing is written. `DEFER` now carries a
   **`reason`** so `transition.js` can give each its own greppable tag; the synthetic one is the
   instrument for §7.1's "watch 24 h, expect zero" canary and must not be inflated by a defect
   expected to register 10–90/month.

### Named behavioural change

**A participant at `END` who taps Get Started again now receives nothing at all**, where they
used to be entered on the same researcher's `305` survey — a different survey than the one
they finished — and have their answers recorded against it. Half the affected population. Justified because the documented restart mechanism is
`REPLYBOT_RESET_SHORTCODE` via an explicit `form.reset` ref — not a bare `get_started` — and
because every other post-`END` interaction already declines to start a new survey. **A
re-engagement affordance is now a deliberate gap** rather than an accident of an unguarded path.

Two accepted costs: a `QOUT` participant (22%) is not re-sent their pending question, though
`_hasForm` already does that when the live form *is* the fallback — extending it is a product
decision with its own state write and was not taken in a bug fix; and on WhatsApp the refused
event is the participant's own message, so a CTWA arrival with no resolvable ref loses that
message (Messenger's `get_started` carries no content). Re-interpreting the entry as a survey
answer instead is the VIR-19 failure mode and was rejected.

### Detector and coverage

Detector query (3,729 of the 3,732, excluding the 3 explicit `form.305` referrals), the
post-deploy log-tag check, and the full regression-test inventory:
`documentation/referral-form-resolution.md`, "A form-less entry event may not re-enter a live
conversation". Tag: **`FALLBACK_ENTRY_ON_LIVE_CONVERSATION`**.

Because `REFERRAL` had no guard at all, this was live in every version — there is no "broken
from" commit to name, unlike Appendix A.

---

## Order of work

**§7.3 comes first.** The triple cannot be keyed on before every event carries one, so the
envelope work gates the cache fix rather than following it. §7.2 and Appendix A are
independent and fill that time.

| # | Step | State |
|---|---|---|
| 1 | **§7.2** standalone correctness fixes, and **Appendix A**. No dependencies; ship immediately. | **done** — but *not* dependency-free: `responses` and `chat_log` needed migrations 27 and 28. See §7.2's amendment. |
| 1b | **Appendix B** — form-less entry may not re-enter a live conversation. No dependencies; ship immediately, and sooner than the rest: it is the only item here that has been damaging participants continuously since 2020. | **done in code**; staging measurement of the `FALLBACK_ENTRY_ON_LIVE_CONVERSATION` rate not run. |
| 2 | **§7.3.2** hermes accepts and stamps, without rejecting. | **done** — as a config gate (`SYNTHETIC_REQUIRE_CONVERSATION`, default off) rather than a deploy-ordering property. |
| 3 | **§7.3.1** all four posters ship the triple. | **done — all SIX.** §7.3.1's amendment. |
| 4 | **§7.1 pre-step** — log-only canary, 24h. This is the acceptance test for §7.3. | **not run** (nothing is deployed). Must count `[LINKSNIFFER_PLATFORM_ASSUMED]` as well as `[INCOMPLETE_CONVERSATION]`. |
| 5 | **§7.3.1 step 4** — hermes turns on the 400 once the canary reads zero. | not done. Now a config flip. |
| 6 | **§7.1** cache key + tests + `clear-state-cache.sh` + dead-code deletion + docs. | **done in code**; staging and production verification not run. |
| 7 | **§7.4 + §7.5** as one unit. | **done in code**, ordering **reversed**: schema → read path → backfill at leisure, not backfill-first. Blocked on §8.1 for the published client. |
| 8 | **§7.6** registry. | **removed in `5c4cab3e`**; archived on `origin/archive/messaging-accounts-registry`. Returns when Instagram or a connect-accounts UI needs it. |
| 9 | **§7.7** rename, one service at a time. | not started. |

**Interim exposure.** Steps 1–5 leave the cache bug live for as long as the envelope work
takes. That is a deliberate trade: a single cutover to the triple, rather than shipping a
double now and re-keying later. §1.3 sizes what is being accepted — 14 participants active
in 30 days — and §6.0 unsticks any individual who hits it in the meantime. If that window
turns out to be longer than expected, §7.1 can ship early on the double and be re-keyed when
§7.3 lands; the re-key costs one replay per active conversation, not a migration.

> **That trade was taken, deliberately, and is worth naming as a decision rather than a
> default.** The Redis key is the full triple `state:{platform}:{account_id}:{user}`; an
> account-only key was considered — sufficient *if* account ids are globally unique, and it
> would have removed §7.3 from §7.1's critical path entirely — and rejected, on the grounds
> that the registry's reversal (§5.2 as originally proposed) made platform part of account
> identity, so a bare account id could no longer be trusted to determine a platform.
>
> **OPEN — needs decision:** that registry reversal is itself reverted (`5c4cab3e`; see §7.6),
> and `documentation/platform-abstraction.md`'s ratified 2026-07-22 decision — account identity
> is `(allocator, id)`, `(platform, account_id)` pairs explicitly rejected — now stands
> unreversed. Account ids are also globally unique in production (re-verified 2026-08-17, zero
> collisions). So the premise that made §7.3 a hard prerequisite for §7.1 no longer holds as
> stated. This needs a human call: keep §7.3 as a hard prerequisite anyway (e.g. because
> Instagram will reintroduce the same-account-id-two-platforms case once the registry returns),
> or revisit whether an account-only key could have shipped §7.1 sooner. Do not silently
> re-derive a justification either way.
