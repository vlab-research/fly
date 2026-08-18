# Conversation identity — integration test specification

**Companion to:** `planning/conversation-identity.md` (the implementation plan).
**Status:** specification only. No test code, harness code or service code written yet.
**Worktree:** `/home/nandan/Documents/vlab-research/fly-conversation-identity`, branch `feature/conversation-identity`.
**Written:** 2026-08-16.

This document answers two questions: **what must the test suite prove**, and **what can
the harness not currently express**. The code changes in the plan are small. The risk is
entirely in whether the seams got tested, and several of those seams are not reachable
from any test harness we have today.

Read §0 first. Two of the recon answers change the plan.

---

## 0. Recon findings

### 0.1 Is Redis in the testcontainers stack? — **YES.** And it is the *only* state.

`stack.ts:281-285` starts `redis:7-alpine` under network alias `redis`; `stack.ts:39`
declares it on the `Stack` interface; `stack.ts:347-348` injects `REDIS_HOST=redis` /
`REDIS_PORT=6379` into replybot; `stack.ts:496` stops it. The README's container list
(`facebot/testrunner/README.md:20-27`) omits Redis — **that is a doc bug, not a missing
container.** Fix it in the documentation pass.

So the epicentre of the bug is live in the harness and the core regression test is
writable today. Good.

The second half of this finding is more important and cuts the other way:

**The harness never populates `chatroach.messages`.** `stack.ts:265-278` starts exactly
two scribble containers — `scribble-states` and `scribble-responses` — and
`scribble/kube-dev/` contains only `states.yaml` and `responses.yaml`. The `messages` and
`chat-log` destinations exist in the binary (`scribble/scribble.go:64-69`) but nothing in
the stack runs them. Nothing else writes that table (`grep "INTO messages"` finds only
`devops/all.sql` DDL and read-only queries in `replybot/lib/responses/pgstream.js:73` and
`debugger.js:18,26`).

Therefore `StateStore._getEvents` (`statestore.js:68-72` → `this.db.get(user, LIMIT)`)
always returns an empty log in the harness, and `getState` on a cache miss returns
`getState([])`. Consequences:

- **In the harness, Redis is 100% of conversation state.** That makes the §7.1 cache-key
  bug maximally reproducible — exactly what we want for the regression test.
- **Replay (§7.4/§7.5) is completely untestable today.** No `messages` sink → no log →
  nothing to replay. Standing up a `messages` scribble container is a hard prerequisite
  for the whole of §7.4 + §7.5, and it is not mentioned anywhere in the plan.
- **`chat_log` is neither produced nor consumed.** `stack.ts` sets `VLAB_CHAT_LOG_TOPIC` on
  replybot and creates the topic, but **replybot has had no chat-log publisher since
  2026-07-17 and production stopped writing on 2026-07-27** — see finding (7). A8 added the
  consuming sink; the producer is what is missing. §7.2(c) has no end-to-end path until a
  publisher is restored.

### 0.2 Can the harness express two accounts on the same platform? — **NO.**

`seed-db.ts` seeds exactly one of everything:

| Thing | Value | Evidence |
|---|---|---|
| Researcher | `test@test.com`, one row in `users` | `seed-db.ts:13-16` |
| Messenger page | `935593143497601`, `entity='facebook_page'`, `details.token='test'` | `seed-db.ts:19-22` |
| WhatsApp number | `106540352242922`, `entity='whatsapp_business'`, `details.token='test'` | `seed-db.ts:27,37-38` |
| Reloadly cred | keyed on the same page id | `seed-db.ts:122-127` |
| Media handles | Messenger handle on the page id, WhatsApp handle on the phone id | `seed-db.ts:100-116` |

Every survey is seeded under that one `userId` (`seed-db.ts:164-167`), and `mox.ts:9`
hardcodes the same page id as `PAGE_ID`. There is **one researcher, one page, one
number**. Not one of the tests in §B can be written against this.

### 0.3 Is queued outbound keyed by user id alone? — **YES, everywhere.**

- `facebot/receiver/index.js:54-60` — Messenger sends are bucketed as
  `messages[data.recipient.id]`, i.e. by the *user*. The page is not in the POST body at
  all: `messenger_client.go:96` posts to a fixed `/me/messages` and identifies the page
  only through `Authorization: Bearer <token>` (`messenger_client.go:103`).
- `facebot/receiver/index.js:83-93` — WhatsApp sends are bucketed as `messages[data.to]`.
  The account **is** on the wire (`whatsapp_client.go:78` posts to
  `/{platform_account_id}/messages`, and the receiver route captures it as
  `req.params.phoneNumberId` at `index.js:66`) — **and the receiver throws it away.**
- `facebot/receiver/index.js:131-145` — `GET /sent/:id` pops one message off the single
  FIFO for that user id.
- `socket.ts:34-42` `receive(id)`, `:56-61` `receiveSent(userId)`, `:122-150`
  `flowMasterWhatsApp(userId, ...)`, `:152-190` `flowMaster(userId, ...)` — all keyed by
  user id.

**This is the single biggest harness change.** Two live conversations for one user id on
two accounts interleave into one FIFO, and no assertion helper can tell whose message it
just popped. Every test in §B1–§B3 is blocked on fixing it. See §A3.

### 0.4 Do the mox builders let you choose the account? — Mostly yes; three gaps.

| Builder | Account parameter | Gap |
|---|---|---|
| `makeReferral` `mox.ts:65` | `pageId = PAGE_ID` | none |
| `makeEcho` `mox.ts:82` | `pageId = PAGE_ID`, used as `sender.id` (echo inversion) | **callers never pass it** — `socket.ts:183` and `test.tc.ts:96-101` call `makeEcho(get, userId)`, so every echo is stamped with the default page regardless of which account the flow is on |
| `makePostback` `mox.ts:95` | `pageId` threaded to `baseMessage` | none |
| `makeQR` `mox.ts:109` | `pageId` | none |
| `makeTextResponse` `mox.ts:118` | `pageId` | none |
| `makeHandover` `mox.ts:131` | `pageId` | none |
| `makeNotify` `mox.ts:148` | `pageId` | none |
| `makeSynthetic` `mox.ts:122-129` | `pageId` → emitted as `page` | **no `platform`, no `account_id`** — this is the §7.3.1 contract the harness must be able to violate *and* satisfy |
| `makeWhatsApp*` `mox.ts:186-235` | `phoneNumberId = WA_PHONE_NUMBER_ID` | none |
| `_baseMessage` `mox.ts:52,159` | `pageId = PAGE_ID` | none |

So the builders are nearly ready; the defaults and the echo call sites are what pin
everything to one account.

### 0.5 Does `responses.ts` scope its DB reads by account? — **NO.**

```ts
// responses.ts:19
'SELECT * FROM responses WHERE userid=$1 ORDER BY timestamp ASC'
// responses.ts:24
'SELECT * FROM states WHERE userid=$1'   // then `return rows[0]`
```

`getState` returning `rows[0]` is actively dangerous for this work: with two accounts it
returns a nondeterministic row, so a test could pass by reading the *wrong* conversation.
Every assertion in §B needs account-scoped readers.

### 0.6 Which services in the plan are NOT in the stack?

In the stack: cockroach, redpanda, **redis**, scribble-states, scribble-responses,
formcentral, **dinersclub** (`stack.ts:330-334`), hermes-as-botserver, replybot,
**message-worker** (`stack.ts:399-404`), facebot, plus dean on demand
(`dean-trigger.ts:8-44`). Dinersclub and message-worker *are* present — correcting the
brief's assumption.

Not in the stack, and where their coverage must live instead:

| Service | Where tests live | What the equivalent coverage looks like |
|---|---|---|
| **exodus** | `exodus/query/builder_test.go` (golden-SQL string tests) + `exodus/query/db_integration_test.go` (real CRDB on :5433 via `TEST_DATABASE_URL`, seeded by `insertSurvey`/`insertState`/`insertResponse`, run with `make test-integration`) | §B7-d belongs in `db_integration_test.go` in the style of `TestIntegration_OR_QuestionResponse` — seed one userid with responses on account A and state on account B, run the generated bail query, assert the participant is **not** returned. A golden-SQL twin in `builder_test.go` pins the join text. |
| **scribble** (`messages`, `chat_log` destinations) | `scribble/*_test.go` against a real CRDB via `test_helpers.go:52 testPool()` | §B7-a/b/c belong here — see §B7. `TestStateWriterOverwritesOnePersonsState` (`state_test.go:53`) currently *asserts the bug* and must be rewritten. |
| **hermes** | `hermes/tests/handlers.rs` (674 lines, axum `oneshot` + `MockProducer` capturing `(topic, key, payload)`) and `hermes/tests/event.rs`, plus inline `#[cfg(test)]` in `src/event.rs:99+`. `cargo test`. | §B4 and §B6 belong here. The MockProducer already exposes produced bytes, so envelope assertions are one `serde_json::from_slice` away. |
| **dean** | `dean/queries_test.go` against real CRDB. `TestEventsCarryPlatformFromStateWithMessengerDefault:76-122` is the existing pattern. | §B5-dean extends that test to assert `account_id` alongside `platform`. |
| **dinersclub** | `dinersclub/provider_test.go` + `dinersclub/test.yaml` (docker-compose with CRDB + `../devops/migrations` mounted) | §B5-dinersclub: assert the POST body built at `main.go:86` carries `platform`. Needs an httptest server standing in for hermes — one does not exist in dinersclub today. |
| **message-worker** | `message-worker/worker_test.go`, pure unit with `mockBotserver` HTTP mock | §B5-worker: assert the `machine_report` POST built at `worker.go:486` carries `platform`. `mockBotserver` already captures bodies. |
| **dashboard-server** | `dashboard-server/queries/states/states.queries.js` — no container in the stack | §B3's containment assertion is made at the *data* layer (which account a row is scoped to), not through the dashboard API. Out of scope to run the dashboard; see §D. |

### 0.7 Is there an end-to-end WhatsApp path? — **YES, and it is complete.**

`sender.ts:26-30` routes `source: 'whatsapp'` bodies to hermes `/whatsapp`;
`handlers.rs:124-142,163-186` ingests them; replybot normalizes; message-worker's
`whatsapp_client.go:78` posts to the facebot mock's `/:phoneNumberId/messages`
(`receiver/index.js:66-94`); `socket.ts:122-150 flowMasterWhatsApp` drives the flow.
`test.tc.ts:929-1043` holds eight WhatsApp tests covering text answers, bare-text entry,
`cta_url` webview, both media-handle branches, and interactive choice jumps.

It is **not** media-only. This is the sharpest instrument we have: `wa_id` is a global
phone number, so a two-number WhatsApp test reproduces the bug deterministically rather
than incidentally. Every builder already takes `phoneNumberId`. The only thing missing is
a second seeded number and a way to tell the two outbound streams apart.

### 0.8 How is the schema applied?

`stack.ts:167-187`: read every `*.sql` in `devops/migrations`, sort **lexically**, execute
each in its own `cockroach sql -e` invocation, throw on any non-zero exit. Then
`stack.ts:190-198` adds a test-only `UNIQUE(userid, shortcode)` on `surveys`.

Files present on this branch (23): `01-init`, `02-export-status`, `03-survey-settings`,
`04-pointers`, `05-off-time-in-survey`, `06-exodus-bails`, `07-timeout-date-validation`,
`08-chat-log`, `09-export-log-redesign`, `10-media`, `11-nullable-destination-form`,
`12-bail-event-bailed-userids`, `13-message-templates`, `14-message-templates-buttons`,
`15-bail-survey-id`, `16-export-db-polling`, `17-export-metadata`,
`20-messaging-account-unique`, `21-states-platform`, `22-account-id-rename`,
`22-surveys-shortcode-covering-index`, `23-states-errored-at`, `24-media-assets`.

Three things follow:

1. **New migrations are picked up automatically.** `25-messaging-accounts.sql` (§5.2) and
   `26-messages-account.sql` (§7.4) will be applied by the harness with no `stack.ts`
   change, and by every Go service's test DB too — `devops/Makefile:79-91 test-db`
   (`cat ./migrations/*.sql | cockroach sql`), `dinersclub/test.yaml:53-58` and
   `formcentral/test.yaml:56-62` all mount the same directory.
2. **Fully qualify every table as `chatroach.`.** `devops/Makefile:84` pipes the
   *concatenation* into one session, so one unqualified name aborts every migration after
   it — the exact failure documented at `documentation/platform-abstraction.md:263`.
3. **`18-drop-cold-message-indexes.sql` and `19-drop-message-userid-idx.sql` are absent on
   this branch** (they exist untracked in the primary worktree). The harness therefore
   builds `messages` with indexes production no longer has. §7.4's index widening must be
   sized against production, not against what the harness shows.

---

## 0.9 Corrections to `planning/conversation-identity.md`

These are findings, not opinions. Each changes what has to be built.

**(1) §7.2 is wrong that "None needs a migration." Two of the four fixes cannot ship
without a primary-key migration, and shipping them without one crash-loops scribble.**

- `responses` is `PRIMARY KEY (userid, timestamp, question_ref)` (`01-init.sql:87`) — the
  exact tuple `response.go:86` names in its `ON CONFLICT`.
- `chat_log` is `PRIMARY KEY (userid, timestamp, direction)` (`08-chat-log.sql:31`) — the
  exact tuple `chatlog.go:65` names.

Adding `pageid` to the conflict target does not make the second row insertable; it makes
the insert **raise a primary-key violation** instead of being silently swallowed. Scribble
treats a write error as fatal (`scribble.go:36-39` → `log.Fatalf`), so the consumer
crash-loops on a poison batch. The plan's own hedge — "Confirm the supporting unique
indexes exist before changing the target" — resolves to *they do not, and cannot, while
the PK is what it is.*

The real work is `ALTER TABLE ... ALTER PRIMARY KEY` on both tables. And both `pageid`
columns are **nullable** (`01-init.sql:79`, `08-chat-log.sql:20`), so the migration must
also backfill and `SET NOT NULL`, or adopt a sentinel. That is a data migration on the two
largest tables in the system, which puts §7.2 in a completely different risk class from
"ships immediately, no dependencies."

**CORRECTION (2026-08-17): this reasoning does NOT extend to `messages` — see finding (11).**
`messages`' conflict target is `(hsh, userid)` where `hsh` is a computed `fnv64a(content)`, and
the account lives inside `content`, so it is already transitively account-scoped and needs no PK
change at all. The `responses` and `chat_log` analysis above stands; only the extension to
`messages` was wrong.

Only `scribble/state.go:37` (`DedupStates`) and `exodus/query/builder.go` are genuinely
migration-free. Those two really can ship on day one.

**(2) §5.2's `PRIMARY KEY (platform, account_id)` reverses a ratified, documented design
decision.** *(RAISED here; **RESOLVED 2026-08-17** — the reversal is accepted deliberately.
See the resolution note at the end of this item.)*

`documentation/platform-abstraction.md:246-261` records a **RATIFIED DESIGN DECISION
(2026-07-22)**: account identity is `(allocator, id)` serialized to one string, and
first-class `(platform, account_id)` pairs were *considered and decided against*, on the
grounds that "platform is an attribute of an account, never part of its identity" and that
Meta is one allocator issuing page ids and `phone_number_id`s from a single graph-id space.
The doc even lists the tripwires that would reopen the decision (an allocator whose ids
cannot be prefix-encoded; a need to shard by platform; an observed uniqueness failure) and
a standing namespace policy (`sms:`, `tg:` prefixes stamped at hermes ingestion).

This is not a blocker for §7.1 — the Redis key can carry platform as a component whether
or not it is part of *account* identity — but §5.2 and §7.6 need either a documented
reversal with the tripwire that fired, or a redesign onto the ratified model. It also
means the §7.1 test the plan asks for ("same account id, two platforms → two distinct
keys") describes a state the ratified model says cannot exist. Keep the test — it is cheap
and defensive — but do not let it be the justification for the registry's PK.

**RESOLUTION (2026-08-17): the ratified decision is reversed, and `PRIMARY KEY (platform,
account_id)` stands.** Recorded here so the reasoning is not lost; the amendment to
`documentation/platform-abstraction.md:240-263` itself ships with §7.6 and is not written
here.

The reversal does **not** rest on any of the three tripwires the ratified doc named — none
fired, and its id-uniqueness argument remains correct as far as it goes. It rests on a case
that argument did not consider: **Instagram**. `message-worker/translator_instagram.go:10`
notes Instagram uses the same API structure as Messenger and sends through the **Page's**
token, so `platform='instagram'` and `platform='messenger'` are two platforms sharing **one**
credential and **one** account id. If platform were merely an attribute of an account, an
account could not have two of them. `entity → platform` is not a function — which is exactly
why `message-worker/tokenstore.go:29` and `dinersclub/provider.go:76` each carry a
hand-written `platformToEntity` map whose "absent or unmapped" fallback is already
load-bearing. That is a structural break in the premise, not a tripwire.

Two consequences for this document:

- §7.6 is **unparked**. It is removed from §D and specified in §B11 below. It still ships
  last and gates nothing, so it is the lowest priority in this plan.
- B10-3 / B1-3 ("same account id, two platforms → two distinct keys") are **load-bearing,
  not merely defensive**. Under platform-as-identity that case is admissible, and Instagram
  is the concrete instance of it.

**(3) `transition.js:27` has the same `md` fallback for the account that §7.1 forbids for
the platform, and it is not in the plan's root-cause inventory.**

```js
const page = parsedEvent.source.account_id || (state && state.md && state.md.pageid)
```

§2.1 lists only the platform recovery at `transition.js:36`. The account fallback at :27 is
the same class of bug: on a synthetic event it reads the account out of the very state blob
that bleeds, and that `page` is what `getForm(pageid, shortcode, timestamp)` and the
outbound command are built from. Any conversation whose cached state came from another
account will route its *outbound* messages using the other account's page id. §7.1's rule —
"all three components come from the event, never from `state.md`" — must be applied here
too, which means synthetic events must carry the account (§7.3.1) before this fallback can
be removed. Add it to the §2.1 inventory.

**(4) Hermes returns 500, not 400, on a malformed synthetic POST today.**

`handlers.rs:302-307` returns `INTERNAL_SERVER_ERROR` when `user` is missing, and
`hermes/tests/handlers.rs:336 synthetic_event_missing_user_returns_500` pins that. §7.3.1
specifies 400 for the new required fields. Either change all three to 400 (and update that
test) or the contract is "missing user is a server error, missing platform is a client
error," which is indefensible. Recommend: 400 for all three, in the same change.

**(5) The Kafka key stays the user id — and that is load-bearing, so say so.**

`replybot/lib/index.js:31-33` produces with `userid` as the key, and hermes keys on the
user (`event.rs:23-54 get_user_from_event`). Both of a participant's conversations
therefore land on the same partition and are processed in strict order by one replybot
spine. That is *why* the bug is a deterministic last-writer-wins rather than a race, and it
is why a two-account test is reproducible rather than flaky. It also means the fix must not
change the key: doing so would reshuffle partitions and break ordering guarantees the rest
of the system leans on. Worth an explicit non-regression test (§B1-4).

**(6) DECIDED 2026-08-17 — the Redis key is the full triple `state:{platform}:{account_id}:{user}`.**

The alternative considered was an account-only key `state:{account_id}:{user}`, which would
have been sufficient *if* account ids are globally unique, and which would have removed §7.3
from §7.1's critical path entirely. It was rejected: decision (2) above establishes that
platform is part of account identity, so the key carries it.

Two consequences, both accepted deliberately rather than overlooked:

- **§7.3 remains a hard prerequisite for §7.1.** The key contains `platform`, which is only
  reliably present on every event once hermes and all four synthetic posters normalize it.
  The §C.2 ordering below therefore stands unchanged.
- **The plan's "interim exposure" trade is accepted.** Steps 1–5 of the order of work leave
  the cache bug live for as long as the envelope work takes. §1.3 sizes that exposure at 14
  participants active in 30 days, and §6.0 unsticks any individual who hits it. This is a
  deliberate choice of one clean cutover over shipping a double key now and re-keying later
  — not an oversight.

The shape is still routed through a single builder in both suites —
`facebot/testrunner/conversation.ts` `stateKey()`/`stateKeyGlob()` and the `expectedKey()`
helper in `replybot/lib/typewheels/statestore.test.js` — because
`devops/clear-state-cache.sh`'s `SCAN MATCH state:*:*:<userid>` must agree with it, and one
builder is how that agreement is kept honest.

**(7) `chat_log` has had NO WRITER since 2026-07-27. The table is dormant BY ACCIDENT, and the
account-scoping migration is therefore CHEAP NOW and must still ship.**

*(Corrected 2026-08-17. An earlier revision of this finding concluded the opposite — that
migration 27 was unnecessary — on the strength of a misdated deploy. See "How I got the dating
wrong" below; the reasoning error is recorded because it is an easy one to repeat.)*

A8 added a `scribble-chat-log` sink to the harness. It boots, reports ready, and consumes
**nothing** — zero rows after a full 46-test suite run, and not one "Consumed N messages" line in
its log, while the states/responses/messages sinks each logged dozens. The sink is fine. The
producer does not exist.

**What happened, with dates:**

1. **The producer was deleted** in commit `675c31bd` ("Phase 2: Refactor machine.js,
   transition.js, and core typewheels for UniversalEvent"), **committed 2026-07-17**.
   `replybot/lib/chat-log/publisher.js` is gone — confirmed with
   `git log --diff-filter=D -- 'replybot/lib/chat-log/*'`.
2. **Production kept writing for another ten days.** The `-wa` release line carrying that commit
   reached production around `replybot-v0.0.211-wa` (2026-07-26), and `chat_log` writes stop dead
   the next day.
3. **Production `chat_log` today: 1,479,724 rows, newest `2026-07-27 01:30:05`.** Monthly
   inserts:

   | Feb | Mar | Apr | May | Jun | **Jul** | Aug |
   |---|---|---|---|---|---|---|
   | 70,234 | 22,169 | 67,593 | 224,655 | 488,886 | **606,187** | **0** |

   **July was the highest-volume month in the table's history.** This was not a feature winding
   down; it was cut off at peak.
4. **No other producer exists.** Repo-wide grep over `*.js *.ts *.go *.rs *.py` for
   `chat_log|chatlog|CHAT_LOG|vlab-chat-log` finds only `scribble/chatlog.go` (the **consumer**),
   `exporter/exporter/main.py:109-111` (a **reader**), the dashboard export UI (a **reader**), and
   the testrunner helpers added by this work.
5. **The infrastructure is still fully deployed**, which is why the loss was invisible:
   `production.yaml:20` defines `chatLogTopic: "vlab-prod-chat-log"`, `:87` creates the topic,
   `:325-331` deploys a scribble instance with `destination: "chat-log"` consuming it, and
   `:618-619` still injects `VLAB_CHAT_LOG_TOPIC` into a replybot that ignores it. Staging
   mirrors all four. (The bare `vlab-chat-log` name appears only in the harness.)
6. **replybot's README contradicts itself:** `:80` documents the publisher as live; `:469` says it
   "was removed with the platform abstraction". Line 469 is correct.

**CONCLUSION: migration 27 must still ship, and now is the cheapest it will ever be.**

The publisher was **collateral damage in a refactor, not a deprecation.** Nobody decided to
retire chat logging — the dashboard still ships the export feature and the helm charts still
deploy the whole pipeline. So the producer will be restored, and when it is, the account-scoping
fix has to already be in place or the silent-row-loss bug arrives with it.

The useful consequence is the inverse of a deferral: `devops/migrations/27-chat-log-account-scoped-key.sql`
does an `ALTER PRIMARY KEY` plus a backfill and `SET NOT NULL` on a nullable `pageid` over 1.48M
rows — and right now the table is **quiescent**, with no concurrent writes to contend with and no
consumer to crash-loop if the migration is slow. **That window closes the moment the producer
comes back.** Run it while it is easy.

**How I got the dating wrong** (recorded so the next person does not): I used
`git tag --contains 675c31bd`, saw `replybot-v0.0.218` and every tag back to `v0.0.206-wa`, and
concluded this had been "deployed behaviour for many releases". `git tag --contains` answers
*which releases contain a commit* — a property of the tag graph — not *which release production
was running*, and certainly not *when that release was deployed*. The commit date (2026-07-17) is
also not the deploy date (~2026-07-26). Verifying against the data would have caught it
immediately: a table with 606k inserts in the month a feature was supposedly long dead is a
contradiction. **Check the data before concluding a feature is dead.**

**Consequences for testing:**

- **§7.2(c) is a fix to a currently-dormant table, not to dead code.** Keep the unit test in
  `scribble/chatlog_test.go` — it is the only coverage available and it is exactly what protects
  the restored producer. The **§B7-c integration twin is unwriteable until a producer exists**,
  and that is a temporary gap, not a permanent one. Whoever restores the publisher must write it
  then.
- **The `scribble-chat-log` container stays in the harness.** It costs nothing, it will start
  passing traffic the day the producer returns, and its silence is itself the signal that the
  producer is still missing.

**(7b) ESCALATED SEPARATELY — silent chat-log export truncation since 2026-07-27.**

Not this plan's work; recorded here with the date so whoever picks it up does not have to
re-derive it.

The dashboard still advertises "Create Chat Log Export"
(`dashboard-client/src/containers/CreateChatLogExport/`, `SurveyScreen.js:310`) and the exporter
still serves it (`exporter/exporter/main.py:109-111`). Since **2026-07-27 01:30:05** no new rows
have been written, so any researcher exporting chat logs for a conversation after that timestamp
receives **silently truncated or empty data with no error**. Three weeks and counting as of
2026-08-17. Every conversation from the platform-abstraction cutover onward is missing from a
feature the product still offers.

**(8) There are SIX synthetic posters, not four. RESOLVED 2026-08-17 — the canary's "expect
zero" premise holds.**

§7.3.1 enumerates four posters (dean, dinersclub, message-worker, replybot). Two more POST to
`/synthetic`: **`linksniffer`** and **`exodus`**. §7.3.1's table should list six — an unlisted
poster is precisely the thing that keeps a canary non-zero.

**Does linksniffer belong on `/synthetic` at all? Yes — settled.** A linksniffer click flows
through replybot's machine, produces a `newState` that is persisted, and forms can `wait` on
`linksniffer:click` to advance. Anything that mutates conversation state is a conversation event
and needs attribution, so the triple is the right contract for it.

**Decided:** linksniffer sends `platform=messenger` explicitly, with a greppable tag when it
cannot determine the platform. A first-class opt-in tracked-webview property is being added so
new surveys are correct by construction.

Consequences:

- **§B10-6's "expect literal zero" premise HOLDS.** The canary can reach zero, and §7.1's
  pre-step keeps its acceptance criterion as written. (An earlier revision of this document
  flagged that premise as in flux; it is not. Un-flagged.)
- **§B5 gains two cases** (`linksniffer`, `exodus`), owned by the envelope stream.
- **The canary log line should identify the poster.** With six producers, "some event lacked a
  platform" is not actionable; "linksniffer could not determine platform" is. §7.3.1 already asks
  for the poster's identity on the 400 — the same applies to the canary, and to §B10-6's tag.

**(9) The envelope stream is complete (2026-08-17), so §B4/§B5/§B6 are no longer blocked.**
Hermes stamps `account_id`/`platform` on all three shapes; the four named posters send the
triple; the 400 is gated behind `SYNTHETIC_REQUIRE_CONVERSATION` (default off), which
implements §7.3.1's accept-but-not-require rollout step directly rather than relying on deploy
ordering — a genuine improvement on the plan, since the rollout step becomes a config flip
rather than a race. The shared Messenger-echo fixture required by §B4-7 exists at
`testdata/event-envelope/messenger-account-derivation.json`, consumed by Rust via `include_str!`
and by JS via `require` — i.e. one fixture, two languages, as specified.

**(10) REPRODUCED IN THE HARNESS 2026-08-17 — the §1.1 bug, with a sharper signature than the
plan records. The two conversations do not merely overwrite each other; they MERGE into one
stitched form stack, and answers are recorded against the other researcher's field refs.**

B2-1 running against the real stack, one participant, researcher A's page `935593143497601` and
researcher B's page `811223344556677`, forms `isoFormA` (A) and `isoFormB` (B). Verbatim from
replybot:

```
newState: {
  state:    "RESPONDING"  ->  "ERROR",
  forms:    ["isoFormB", "isoFormA"],          <- BOTH researchers' forms, one conversation
  qa:       [["isoa_q1", "Excellent"]],        <- form A's field ref holding form B's choice label
  md:       { form: "isoFormA", pageid: "935593143497601", platform: "messenger" },
  question: "isoa_q1"
}
error: FORM_NOT_FOUND — "Survey with shortcode isoFormA at timestamp 1786977773569
        for page 811223344556677 could not be found."   (ourform.js:42)
```

Three things this shows that the plan states only abstractly:

1. **The mechanism is form STITCHING, not overwriting.** The entry on account A is stitched onto
   the live account-B conversation (`forms: ["isoFormB","isoFormA"]`) because the shared cache
   key makes them look like one conversation. §2.2 describes overwriting; the observed behaviour
   is worse, because the merged stack then drives form resolution.
2. **Answer misattribution is literal and demonstrable.** `qa` holds `["isoa_q1","Excellent"]` —
   `isoa_q1` is researcher A's field ref, `"Excellent"` is researcher B's choice label. The
   participant's answer to B's question was recorded against A's field. This is §2.2 item 2's
   "reaches response attribution, not just observability", shown rather than argued.
3. **`md.pageid` and the arriving account disagree**, which is what makes the subsequent
   `getForm` call 404: it looks up researcher A's shortcode against researcher B's page.

**The signature is `FORM_NOT_FOUND`, not the `FIELD_NOT_FOUND` of the live incident.** Same
mechanism, one step earlier. This fixture puts the two forms under *different researchers* —
required by §B3's containment test — so the form lookup fails before the machine reaches
`getField`. In the live incident both forms resolved, so the failure surfaced one layer down at
`form.js:185`. Neither tag is in `DEAN_ERROR_TAGS` (`NETWORK,INTERNAL,STATE_ACTIONS`), so both
are equally terminal and equally un-healed by a deploy. B2-1 therefore asserts on **both** tags,
plus the deterministic merged-form-stack assertion (`forms === [liveForm]`), which holds
regardless of which error fires.

**Correction to the plan:** §1.1 and §2.2 should record form stitching and cross-researcher
answer misattribution as the mechanism, with `FIELD_NOT_FOUND` as one of at least two terminal
signatures rather than the signature.

**(11) §7.4's PREMISE IS FACTUALLY WRONG, and correcting it collapses the phase from a 384 GiB
primary-key rewrite to two nullable columns plus an index.** *(From the §7.4/§7.5 stream,
2026-08-17. Recorded here because this list is the corrections register.)*

§7.4 says `messages`' conflict target must widen from `ON CONFLICT (hsh, userid)` to
`(hsh, userid, account_id)`. It does not need to, because **`hsh` is a hash of the entire
`content` blob** — `01-init.sql:22` defines it as a computed `fnv64a(content)` STORED column —
and the account identifier is inside `content` in every event shape (`recipient.id` /
`sender.id` on Messenger, `phone_number_id` on WhatsApp, `page` on synthetic, and now the
normalized `account_id` on all three).

Two events that differ only by account therefore produce **different `content`**, hence
**different `hsh`**, hence no conflict. `ON CONFLICT (hsh, userid)` is **already transitively
account-scoped**. Nothing to widen; the primary key is not touched.

This is the single largest de-risking in the plan so far. §7.4 becomes: add two nullable
columns (`account_id`, `platform`), add one secondary index, backfill. No `ALTER PRIMARY KEY` on
`messages` at all.

It also means my §0.9-1 finding was **right about `responses` and `chat_log` and wrong to
extend the same reasoning to `messages`**. The difference is exactly that `messages`' conflict
target includes a content hash while the other two enumerate business columns. Corrected:

| Table | Conflict target | Already account-scoped? | Needs `ALTER PRIMARY KEY`? |
|---|---|---|---|
| `messages` | `(hsh, userid)`, `hsh = fnv64a(content)` | **Yes**, transitively via content | **No** |
| `responses` | `(userid, timestamp, question_ref)` = the PK | No | **Yes** (migration 28) |
| `chat_log` | `(userid, timestamp, direction)` = the PK | No | Yes (migration 27 — cheap now, see finding 7) |

**(11a) FACT, not a correction: the hash is `fnv64a`.** `chatroach.messages` declares
`hsh INT AS (fnv64a(content)) STORED NOT NULL` (`01-init.sql:22`).

Stated explicitly because the repo contains a *second, unrelated* hash that is easy to mistake for
it: `facebot/testrunner/package.json:23` and `replybot/package.json:27` both depend on
**`farmhash`**, and `test.tc.ts` uses `farmhash.fingerprint32(...)` for its own fixture bucketing
(`:437,497,528,765`). Two different hashes, one of them not the database's. Anyone reasoning about
`hsh` from the surrounding JS would compute the wrong value.

*Provenance note, recorded because it is the same class of error as (12a) below: an earlier revision
of this entry read "The plan says `farmhash`" and framed this as a correction. **The plan never
asserted that.** `planning/conversation-identity.md:1206` in fact already states "The hash is
`fnv64a`, not `farmhash`" for exactly the reason above. The false correction came from a relayed
report that I recorded without checking the source document. A corrections register containing a
false correction is worse than one that omits it — verify against the artifact, not against a
summary of it.*


**(11b) §7.5's `USING (userid, account_id)` does not survive contact with the schema.** `states`
has **no `account_id` column** until §7.7 performs the rename — it has `pageid`. So the join
needs an explicit alias, e.g. `JOIN (SELECT userid, pageid AS account_id, message_pointer FROM
states WHERE ...)`, or it fails at parse time. A small thing that would have burned the first
person to implement §7.5 verbatim, and a reminder that §7.7's rename is load-bearing for more
than cosmetics.

**(12) §5's consumer inventory and production counts are both wrong.** *(Verified 2026-08-17.)*

- **There are SIX consumers of the bare-account-id lookup, not ten.** `message-worker/tokenstore.go:108`,
  `dinersclub/provider.go:93`, `formcentral/db.go:82`, `dean/queries.go:245` (the plan says 244),
  `states.queries.js:57`, `credentials.queries.js:42`. The "dashboard-client account screens" the
  plan counts are **not** consumers — they do a client-side `.filter()` over data already fetched,
  and never issue the lookup. And `media` / `message_templates` were already migrated by migration
  22, so they are done rather than pending. §5.1's "duplicated across ten call sites" overstates the
  §5.5 step-3 migration by roughly 40%.
- **Production counts: 62 `facebook_page` + 2 `whatsapp_business` = 64**, and `key = details->>'id'`
  holds **64/64**. §5.3's backfill assertion is therefore safe as written. Note
  `documentation/platform-abstraction.md:210`'s "63/63 verified" is **stale** — right conclusion,
  outdated denominator. Re-verify before running, as §5.3 already advises.
- **Instagram is dead code today** (see B11-4): translator, stub client and enum entry exist, but
  hermes has no Instagram webhook, no `instagram` entity is registerable, and nothing produces
  `platform='instagram'`. This does not weaken the §0.9-2 reversal — the structural argument about
  `entity → platform` not being a function stands on Meta's API design — but it does mean the
  justification is **prospective rather than incident-driven**, and §7.6 should say so plainly.

**(13) §7.5's implementation deviates from the plan in three approved ways. All three are
load-bearing, and at least two are the kind a later reader would "correct" back into a bug.**
*(From the §7.4/§7.5 stream, 2026-08-17.)*

**(13a) `get()` takes an OBJECT, and a bare string THROWS.** The signature is
`get({ userid, account }, limit)`. Passing a bare userid — the old call shape — raises rather
than silently reading unscoped. That throw is the guard that stops a forgotten call site
degrading quietly back to the bug, and it is the reason the migration can be done incrementally
without a silent-unscoped-read window. **Needs a test** (see §B8-7 below); it cannot be written
until 0.2.0 is published.

**(13b) `states` is FILTERED by account, not JOINED on `(userid, account_id)` as §7.5
specifies.** This is not a stylistic choice and the reason matters for B8-2:

> Under the literal composite join, every **un-backfilled** row gets a NULL `message_pointer`
> and therefore **bypasses truncation entirely** — so `form.reset` would silently stop working
> on history until the backfill completed. Filtering preserves truncation throughout the
> migration window.

So the plan's `USING (userid, account_id)` would have introduced a second, subtler version of
exactly the bug §7.5 exists to fix — history that fails to truncate — and would have coupled it
to backfill progress. Recorded prominently because "the plan said `USING`" is precisely the
argument someone will make later. (Note this compounds with §0.9-11b: the literal `USING` does
not even parse, since `states` has `pageid` and not `account_id` until §7.7.)

**(13c) The unscoped fallback path was de-duplicated with
`CASE WHEN bool_or(message_pointer IS NULL) THEN NULL ELSE min(message_pointer) END`.**
This reproduces the old "any account's pointer allows it" semantics **exactly**. A plain
`min(message_pointer)` would have been the obvious aggregation and would have been **wrong**:
`min()` ignores NULLs, so a participant with one un-pointed conversation would have had the
other conversation's pointer applied, **truncating MORE history than today**. That is a silent
data-visibility regression that no existing assertion would catch — it produces a shorter
replay, not an error. **Needs a test** (§B8-8 below); also blocked on 0.2.0.

**(13d) The old `messages` index was made NOT VISIBLE rather than dropped**, following migration
18's own pattern on this exact table, with migration 29 to drop it after a soak (deliberately not
written yet). So the harness may now see both the old and new index simultaneously.

This **confirms §0.8's observation**: migrations 18 and 19 are absent from this branch, so the
harness builds `messages` with four content-storing indexes that production does not have.
Migration 26 handles both shapes. Anyone sizing index cost from the harness will overestimate it;
size against production.

**(14) The echo branch is 28.8% of `messages` — and the shared fixture now binds FOUR
implementations. Do not casually refactor it.**

The Messenger echo inversion (`account_id = sender.id` when `message.is_echo === true`, else
`recipient.id`) accounts for **115,134 of a uniform 400k sample — roughly 30M rows**. §4.1 and
§7.3.2 treat it as a normalization detail; it is nearly a third of the archive.

That rule is now implemented **four times**: Rust (`hermes/src/event.rs`, the forward path), JS
(`replybot/lib/event-normalizer.js`), Go (`scribble/account.go`, the backward derivation) and SQL
(`devops/sql/messages-account-id-expr.sql`, the backfill) — **all four bound to the single shared
fixture** at `testdata/event-envelope/messenger-account-derivation.json`.

§7.3.2 anticipated two implementations and asked for a shared fixture. It got four. That fixture
is now the only thing keeping a third of the archive's account attribution consistent across two
languages and a SQL expression, and its drift-detection is verified (inverting `= 'true'` fails
exactly the three echo vectors). **It should be treated as production interface, not test
scaffolding** — adding a vector is cheap, changing or reorganising one is a four-implementation
change. Worth an explicit note in `documentation/event-envelope.md`.

**(12a) §1.3 presents an INFERENCE as a MEASUREMENT. The platform split is wrong; the §1.4
conclusion still holds.** *(Re-measured against production 2026-08-17.)*

§1.3 states: "**3,826 of those rows are `platform = 'messenger'`**; 5 are WhatsApp." The actual
distribution across the multi-account cohort:

| `states.platform` | rows | users |
|---|---|---|
| **NULL** | **3,820** | **1,907** |
| `messenger` | 6 | 4 |
| `whatsapp` | 5 | 2 |

So only **6 rows** are literally `messenger`; 3,820 have a **NULL** platform.

**§1.4's conclusion is unaffected** — the §7.2 stream verified that every `states` row on a
`whatsapp_business` account carries a non-NULL platform, so NULL means "predates `md.platform`
persistence", which means Messenger. Messenger has been colliding all along, and the fix must be
general rather than a WhatsApp special case. That reasoning is sound.

What is wrong is the **provenance**: the plan reports a derived value as though it were queried.
The distinction matters the moment someone writes a check, an alert, or a repair script against
`states.platform = 'messenger'` — which would match **6 rows instead of 3,826** and look like the
problem had evaporated.

**Consequence for anything reasoning about `states.platform`:** it is NULL for the overwhelming
majority of rows, including 3,820 of the 3,831 multi-account rows. `COALESCE(platform,
'messenger')` is correct **today** and is an **inference**, not an observation. Migration 21's own
header says as much; §1.3 is where that caveat got lost.

*(This is why §7.4 stores `platform` on the log tables rather than deriving it — see §3.1. An
archival table must not depend on an inference from mutable current state.)*

**Not affected: this document's own tests.** B1-2 and B1-3 assert `states.platform` equals
`whatsapp`/`messenger`, and that is safe because they create **fresh** conversations through the
live harness, where replybot persists `md.platform` at conversation start. Confirmed empirically —
B1-3's pre-fix red was `expected 'whatsapp' to equal 'messenger'`, a non-NULL value on both sides.
No test here reads a historical row.

**(15) THE MOST IMPORTANT TESTING LESSON IN THIS EFFORT — a unit suite can pin one half of a
contract while the other half is broken, and stay green the whole time.** *(2026-08-17. Both
bugs below were caught by the first end-to-end integration run and by nothing else.)*

This is not a note about two bugs. It is a note about a **class of test that looks like
coverage and is not**, and it caught us twice in one run, in two different services, in two
different languages. Both times the suite was green. Both times the plan asserted the
behaviour was correct and *had a test cited for it*.

**Case A — the gate that could never fire.** §7.1's `statestore.js` ends with
`(conv && conv.account) || null`, so a platform-less-but-account-bearing event still gets an
account-scoped replay. The plan records this as "the live gate", explicitly considers the
strict alternative and rejects it, and cites B10-9b as the test that pins it.

B10-9b passed throughout, and the gate was **dead code from the day it shipped**. The
*extractor* upstream ended `if (!platform || !account) return null` (`utils.js:98`), so the
store could never receive a partial conversation from a real event. B10-9b constructs
`{ platform: null, account }` **by hand** and hands it straight to the store — so it pinned
the consumer's half of a contract whose producer half was broken, and reported that as
coverage.

> **The rule this yields: a gate is only tested if something tests the thing that feeds it.**
> Where a test constructs its input by hand rather than obtaining it from the real upstream,
> it proves the consumer handles that shape — never that the shape occurs. Those are different
> claims, and the plan needed the second one.

Nothing asserted the extractor could *emit* a partial conversation because
`utils.test.js` had **no test of `conversationFromRawEvent` at all** — the function was
introduced by §7.1 with unit coverage only at its consumer. Fixed: `utils.test.js`
`describe('conversationFromRawEvent')` now pins all three rows at the extractor (9 tests), so
B10-9a/b/c are reachable end to end rather than hypothetically.

**Case B — the producer nobody enumerated.** §4's "`chat-events` is produced only by hermes"
was checked by reading *ingress* config, so message-worker — which publishes the WhatsApp
echo straight to the topic while being no one's idea of an ingester — was invisible to the
check and stamped no envelope. Same shape of error: the thing that *feeds* the contract was
never enumerated, only the things that consume it. Fixed at the chokepoint
(`message-worker/kafka.go` `publish()`), with the decision pure and unit-tested
(`envelope.go` `MissingEnvelopeFields`) and a table case (`"THE BUG: the six-field echo as it
shipped"`) that fails against the exact pre-fix body.

**What both cases have in common, and what to do about it.** Each contract had a consumer
test and no producer test. Neither absence was visible from the suite — 564 replybot tests
green, all Go tests green — because the missing test is by definition the one nobody wrote.
Two habits fall out, and they are cheap:

1. **For any contract with a producer and a consumer, assert both ends, and assert the
   producer end on real output.** For an event shape that means the serialized bytes that
   actually left the service (`TestProcessSendMessage_WhatsAppEchoOnTheWireCarriesTheEnvelope`
   inspects `PublishRawEvent`'s argument, not the builder's return). For a pure extractor it
   means feeding it the shape a real producer emits.
2. **When a plan says "this alternative was considered and rejected; a test pins it",
   check *which layer* the test pins it at.** That sentence appeared verbatim in §7.1 about
   the gate that could not fire.

**B10-8 is the test that caught Case A**, and it is worth noting *why* it could: it is the
only test in the suite that drives a platform-less event through the **whole** path — hermes
stamps `account_id` from the deprecated `page` alias and no `platform`, replybot extracts,
the store gates, the replay runs. Its failure signature was
`expected '305' to equal 'isoFormA'` (305 is `FALLBACK_FORM`) — an unscoped replay reading
`ORDER BY timestamp ASC LIMIT 30000`, oldest-first, whose window was consumed by the other
conversation before it reached this one. Silent truncation, not interleaving. **Do not let
B10-8 be weakened or deleted to make anything pass; it is the only end-to-end assertion of
the middle row of the three-case contract.**

---

## A. Harness capability gaps

Nothing in §B can be written until these land. Each is a prerequisite, not a nice-to-have.

| # | File | Change | Why |
|---|---|---|---|
| A1 | `seed-db.ts` | Seed **two researchers** and **four messaging accounts**: researcher R1 (`test@test.com`) owning Messenger page `935593143497601` and WhatsApp number `106540352242922` (unchanged, so existing tests keep passing); researcher R2 (`test2@test.com`) owning Messenger page `<PAGE_ID_B>` and WhatsApp number `<WA_ID_B>`. Export all four ids as named constants. | §0.2. Without a second account no isolation test exists; without a second *researcher* the §2.2-item-2 cross-researcher leak is untestable. Keeping R1's ids byte-identical avoids rewriting the media fixture (`seed-db.ts:100-116`) and 40-odd existing tests. |
| A2 | `seed-db.ts` | Give each account a **distinct credential token** (`token: 'tok-page-a'`, `'tok-page-b'`, …) instead of the shared `'test'` (`seed-db.ts:20,30`). | On Messenger the token in `Authorization: Bearer` (`messenger_client.go:103`) is the **only** account signal on the wire — `/me/messages` carries no page id. A distinct token per page is what makes "this message went out on page B" assertable. |
| A3 | `facebot/receiver/index.js` | Bucket by conversation, not by user. Store each captured send as `{data, cb, accountId, token, platform}` where `accountId` is `req.params.phoneNumberId` for WhatsApp (`index.js:66`, currently discarded) and the resolved page for Messenger (via the `Authorization` header, mapped through A2). Add `GET /sent/:accountId/:userId` alongside the existing `GET /sent/:id`, and keep the old route working (pop from any bucket) so existing tests are untouched. | §0.3. This is the change everything else waits on. Two concurrent conversations for one user currently share one FIFO and the helpers cannot tell them apart. |
| A4 | `socket.ts` | `receive`, `receiveSent`, `flowMaster`, `flowMasterWhatsApp` take an optional account. Suggest a `Conversation = { userId, accountId, platform }` handle and account-aware overloads: `flowMaster(conv, flow)`. Existing `flowMaster(userId, flow)` call sites keep working. | Same. Also: `flowMaster:183` must echo on the **conversation's** page — see A5. |
| A5 | `socket.ts:183`, `test.tc.ts:96-101` | Thread the account through the auto-echo: `makeEcho(get, userId, Date.now(), conv.accountId)`. | §0.4. `makeEcho` already accepts `pageId` and stamps it as `sender.id`; the call sites drop it, so every echo in a two-account test would be attributed to page A and would corrupt the very state the test is measuring. |
| A6 | `mox.ts:122-129` | `makeSynthetic(userId, event, accountId, platform?)` emitting `{user, source:'synthetic', account_id, page, platform, event}`. Add a deliberately-malformed sibling (`makeSyntheticRaw(body)`) that posts an arbitrary body. | §7.3.1's contract is a required triple; the harness must be able to post both a conforming and a non-conforming body to prove the 400 (§B6). Keeping `page` alongside `account_id` mirrors §4.2's deprecated-alias rule. |
| A7 | `responses.ts` | Account-scoped readers: `getResponses(chatbase, userid, pageid)`, `getState(chatbase, userid, pageid)` returning a single row, plus `getAllStates(chatbase, userid)` returning **all** rows so a test can assert *how many* conversations exist. Add `getChatLog(...)` and `getMessages(...)` once A8 lands. | §0.5. `rows[0]` off an unscoped query can pass a test by reading the wrong conversation. |
| A8 | `stack.ts` | Add a **`scribble-messages`** container (`SCRIBBLE_DESTINATION=messages`, `KAFKA_TOPIC=chat-events`) and a **`scribble-chat-log`** container (`SCRIBBLE_DESTINATION=chat-log`, `KAFKA_TOPIC=vlab-chat-log`). Both need new `scribble/kube-dev/{messages,chat-log}.yaml` to match the `loadKubeEnv` pattern (`stack.ts:255-263`). Add both to `Stack` and `stopStack`. | §0.1. Without the messages sink the event log is empty, so §7.4 and all of §7.5's replay behaviour — including the `message_pointer` leak, which is the most subtle bug in the plan — cannot be exercised at all. Without the chat-log sink, §7.2(c) cannot be. |
| A9 | `stack.ts` | Expose the Redis container's mapped port on the `Stack` and let the suite open an `ioredis` client. | §B1 and §B10 assert on **key shape** and on **cache non-writes** — "neither `get` nor `setex` was called." From outside the container the only way to see that is to read Redis directly (`KEYS state:*` on a fresh, isolated stack is acceptable; this is not production). |
| A10 | `stack.ts` | Optionally expose the Redpanda mapped port so a test can consume `chat-events` directly. | §B4 wants to assert the envelope on the wire. Two observation points are available — the Kafka topic and the archived `messages.content` — and they prove different things; see §B4. |
| A11 | `test.tc.ts` | New serial `describe` block, **not** inside `parallel('Basic Functionality')`. | Every two-account test drives two conversations for one user id and asserts on shared Redis and DB state. `mocha.parallel` plus `NUM_WORKERS=1` on message-worker (`stack.ts:384`) already makes un-drained sends starve neighbours (README:130-134); interleaved two-account flows would make failures unattributable. |
| A12 | `facebot/testrunner/forms/` | Two new fixtures, `isoFormA.json` and `isoFormB.json`, with **distinct field refs and distinct question text**, seeded under **different researchers** (R1 gets A, R2 gets B). | The §1.1 repro depends on the two conversations being on different forms with non-overlapping field refs — that is what turns a leak into `FIELD_NOT_FOUND` instead of a silently-accepted wrong answer. Reusing one form would hide the bug. |
| A13 | `facebot/testrunner/README.md` | Add Redis to the container list (:20-27); document the two-researcher fixture, the new sinks, the conversation-keyed receiver, and the account-scoped readers. | The README is otherwise excellent and is treated as ground truth. Leaving Redis out of it is how this recon question got asked in the first place. |

**Deliberately not changed:** the Kafka key (§0.9-5), `mox.ts`'s use of
`@vlab-research/translate-typeform` (README:208-210 — the equivalence check is
intentional), and the `flowMaster` echo *mechanism* (only its account argument).

---

## B. The test contract

Organised by what each test proves. "Gates" names the plan section that must not ship
without it. "Lives in" names the suite, because roughly half of these are not integration
tests at all.

### B1 — Conversation isolation

Two conversations for one participant, on two accounts, progress independently and neither
observes the other's state.

**B1-1 · Two Messenger pages, same user id, different researchers, different forms**
*Lives in:* `test.tc.ts`, new serial block. *Gates:* §7.1.
Setup: one `userId`. Referral on page A → `isoFormA`. Referral on page B → `isoFormB`.
Answer A's Q1, then B's Q1, then A's Q2, then B's Q2 — strictly interleaved, each through
its own account-scoped `flowMaster`.
Assert: each `flowMaster` receives only its own form's questions, in its own order;
`getAllStates(chatbase, userId)` returns **exactly two** rows; row A has
`pageid = PAGE_A` and `current_state`/`state_json.forms` for `isoFormA`, row B likewise
for `isoFormB`; neither row's `state_json.md.pageid` names the other account; Redis holds
**two** keys matching `state:*:*:<userId>`.

**B1-2 · Two WhatsApp numbers, same `wa_id`** — *the sharpest regression test.*
*Lives in:* `test.tc.ts` WhatsApp block (serial). *Gates:* §7.1.
Same shape as B1-1 using `makeWhatsAppReferral(userId, form, time, WA_ID_A|WA_ID_B)` and
`flowMasterWhatsApp`. Assert identically, plus: each outbound send was captured under its
own `phoneNumberId` bucket (A3).
Why it matters: `wa_id` is a global phone number, so this fails today 100% of the time,
whereas the Messenger case depends on PSID reuse. If only one isolation test can be
maintained, keep this one.

**B1-3 · Cross-platform, same user id** — Messenger page A and WhatsApp number B, one
`userId`. *Gates:* §7.1.
Assert: two independent conversations; two state rows differing in `pageid` **and** in the
`platform` computed column (`21-states-platform.sql`); the outbound Messenger send carried
page A's token (A2) and the outbound WhatsApp send went to number B's endpoint.
Note this is contrived — a real participant cannot share an identifier across the two
platforms — but it is the only test that proves `platform` is a live component of the key
rather than dead weight. Mark it as such in a comment.

**B1-4 · Kafka partitioning is unchanged**
*Lives in:* `test.tc.ts` (needs A10) or a replybot unit test. *Gates:* §7.1, §7.3.
Assert: both conversations' events are produced to `chat-events` under the **same** key
(the user id) and are consumed in production order. This pins §0.9-5: the fix must change
the state key, never the partition key.

### B2 — The §1.1 reproduction, verbatim

**B2-1 · Entry on account A must not hijack a live conversation on account B**
*Lives in:* `test.tc.ts`, serial. *Gates:* §7.1 — **this is the regression test for the
whole bug and the suite must not ship without it.**

Setup, in this order:
1. `userId` starts `isoFormB` on account B (researcher R2) and advances to a question with
   buttons. Leave it live.
2. The same `userId` sends a CTWA-style entry on account A (researcher R1) that resolves to
   `isoFormA` and runs to `END`. This is the write that poisons `state:<userId>` today.
3. The same `userId` presses a button in the **account B** conversation
   (`makePostback(fieldB, userId, 0, Date.now(), PAGE_B)`).

Assert, all four:
- The reply on account B is the **next question of `isoFormB`** — not an error, not a
  form-A field.
- `getState(chatbase, userId, PAGE_B).current_state` is **not** `'ERROR'`, and
  `state_json.error` is absent.
- No `FIELD_NOT_FOUND` anywhere: grep the replybot container logs
  (`stack.replybot.logs()`) for `FIELD_NOT_FOUND` and assert zero hits. This is the exact
  string from `form.js:185` in the live repro and it is worth asserting literally.
- The account on the row matches the account the event arrived on:
  `state_json.md.pageid === PAGE_B` and `state_json.forms.slice(-1)[0] === 'isoFormB'`.

Run it in both directions (A poisons B, and B poisons A) so the test does not accidentally
depend on write ordering.

**B2-2 · The WhatsApp twin of B2-1** — same three steps on two phone numbers. Deterministic
today; the Messenger version depends on PSID collision.

### B3 — Cross-researcher containment

**B3-1 · Researcher A's participant data never lands in researcher B's scope**
*Lives in:* `test.tc.ts`, serial. *Gates:* §7.1, §7.2. Covers §2.2 item 2.
Setup: B1-1's two-page, two-researcher flow, with distinguishable answers ("ANSWER-FOR-R1"
on account A, "ANSWER-FOR-R2" on account B).
Assert:
- `getResponses(chatbase, userId, PAGE_A)` contains only R1's answers against `isoFormA`'s
  `question_ref`s and R1's `surveyid`; the mirror holds for `PAGE_B`. No response row
  carries a `question_ref` from the other researcher's form.
- Every `responses.pageid` is one of the two seeded ids and matches the form's owner.
- `states` row for `PAGE_A` has no `state_json.qa` entry containing R2's answer text, and
  vice versa. This is the assertion the dashboard's scoping
  (`dashboard-server/queries/states/states.queries.js`) actually relies on.
- `state_json.md` on each row contains no field sourced from the other conversation
  (spot-check `form`, `pageid`, `startTime`, `seed`).

**B3-2 · Payment `md` does not cross** — extend B3-1 with a form carrying an
`e_payment_*` field on account A only; assert account B's `state_json.md` has no
`e_payment_*` key. §2.2 item 2 calls payment fields out specifically.

### B4 — Envelope contract (§4.2)

Every event on `chat-events` carries top-level `account_id` and `platform`.

**Where to observe.** Both, and they prove different things:
- **Hermes unit/integration tests** (`hermes/tests/handlers.rs`, MockProducer) are the
  primary and cheapest observation point. The producer captures `(topic, key, payload)`;
  deserialize the payload and assert the two fields. Fast, exhaustive, no containers.
- **The archived `messages.content`** (needs A8) is the *durable* observation point and is
  the one that matters, because `scribble/message.go:42` archives the body verbatim and
  that archive is what §7.5's replay reads. A field that hermes stamps but that never
  reaches `messages.content` would pass the hermes test and still break replay.
- Consuming the Kafka topic from the harness (A10) is a third option; prefer it only for
  B1-4, where partition/key is the subject.

**B4-1 · Messenger, normal event** — `stamp_event`. Assert `account_id == recipient.id`,
`platform == "messenger"`, and `sender.id`/`recipient.id` unchanged.
**B4-2 · Messenger, echo** — `message.is_echo: true`. Assert `account_id == sender.id`
(the inversion), `platform == "messenger"`. Both mirror `get_user_from_event`'s existing
echo rule at `event.rs:34-45` and `parseMessengerEvent`'s at
`event-normalizer.js:200-206`.
**B4-3 · WhatsApp** — `stamp_whatsapp_event`. Assert `account_id == phone_number_id`,
`platform == "whatsapp"`, and that `phone_number_id` is **still present** (§4.2 keeps it
for the §7.4 backfill).
**B4-4 · WhatsApp status event** (`statuses[]`, keyed on `recipient_id` —
`event.rs:160 stamp_whatsapp_status_keys_on_recipient`) — same assertions.
**B4-5 · Synthetic** — assert the posted `account_id` and `platform` are passed through
untouched, and that `page` (deprecated alias) still populates `account_id` when
`account_id` is absent.
**B4-6 · Handover / `messaging_handovers`** — `handle_webhook` produces these too
(`handlers.rs:233`); assert the same two fields. Easy to forget: `pass_thread_control`
events have no `message` object, so the echo rule's `.unwrap_or(false)` path is what runs.
**B4-7 · The shared fixture set** — §7.3.2 requires the Messenger echo rule to exist in Rust
*and* JS, exercised by one fixture rather than independent unit tests on each side. **It now binds
FOUR implementations**, which is more than anyone anticipated when it was created:

| Implementation | Role |
|---|---|
| `hermes/src/event.rs` (Rust) | forward path — stamps `account_id` at ingest |
| `replybot/lib/event-normalizer.js` (JS) | normalization |
| `scribble/account.go` (Go) | backward derivation from historical `content` |
| `devops/sql/messages-account-id-expr.sql` (SQL) | the backfill's extraction |

All four load `testdata/event-envelope/messenger-account-derivation.json` — Rust via
`include_str!`, JS via `require`, Go and SQL through `TestBackfillSQLMatchesGo`. Drift detection is
verified: inverting `= 'true'` to `!= 'true'` fails exactly the three echo vectors.

Vectors must cover at minimum: normal, echo, echo-without-`message`, missing-recipient, handover,
WhatsApp message, WhatsApp status.

> **Treat this fixture as production interface, not test scaffolding.** The rule it pins is
> **28.8% of `messages`** — ~30M rows (finding (14)) — and it is the only thing keeping that
> attribution consistent across two languages and a SQL expression. Adding a vector is cheap;
> changing or reorganising one is a four-implementation change. Worth an explicit note in
> `documentation/event-envelope.md`.


**B4-8 · Durability** — end-to-end (needs A8): drive one message through the harness, then
`SELECT content FROM chatroach.messages WHERE userid = $1`, parse it, and assert both
fields survived. *This is the test that gates §7.4's backfill being implementable.*

### B5 — The four synthetic posters (§7.3.1)

Each poster stamps `platform` and `account_id`.

**B5-1 · replybot `machine_report`** — *highest volume: posted on every report.*
`replybot/lib/index.js:14-28` currently sends `{user, page, event}` with no platform.
*Lives in:* a replybot unit test around `publishReport` (needs the function exported or
the processor tested with a stubbed `fetch`), **plus** an integration assertion in
`test.tc.ts` that after any flow, `messages` contains a `machine_report` event carrying
both fields. Note `report.platform` is already computed by `transition.js:36-38` and
dropped on the floor at the POST — the fix is threading, not derivation.
**B5-2 · message-worker `machine_report` on send failure** — *also high volume.*
`worker.go:486` builds `botparty.NewExternalEvent(cmd.UserID, cmd.PlatformAccountID, ...)`;
`cmd.Platform` is in scope and unsent. *Lives in:* `worker_test.go` with the existing
`mockBotserver` capturing the POST body. Integration twin: the existing "Retries sending
the message when it fails with a proper code" test (`test.tc.ts:874`) already forces this
path — extend it to assert the resulting event's fields.
**B5-3 · dean** — `dean/queries.go:19` already sends `Platform`; only `page` → `account_id`
renames. *Lives in:* extend `dean/queries_test.go:76-122
TestEventsCarryPlatformFromStateWithMessengerDefault` to assert `account_id` too.
Integration twin: any `triggerDean(..., 'followups')` test asserts the resulting synthetic
event carries both.
**B5-4 · dinersclub** — `main.go:86` drops `pe.Platform`. *Lives in:* a new
`dinersclub/main_test.go` with an `httptest.Server` standing in for hermes; none exists
today, so this is new scaffolding. Integration twin: the existing payment tests
(`test.tc.ts:145,160`) already round-trip through dinersclub → hermes → replybot; assert
the synthetic event's fields.
**B5-5 · Negative control** — for each poster, a test that the field is **absent** fails.
Trivially satisfied by writing each test red first (see §C).

### B6 — Hermes rejects incomplete synthetic events

*Lives in:* `hermes/tests/handlers.rs`, in the style of `synthetic_event_missing_user_returns_500:336`.

**B6-1 · Reject** — three cases: missing `user`, missing `account_id` (and no `page`),
missing `platform`. Each asserts **400** and **zero produce calls**
(`producer.get_calls().is_empty()`). Per §0.9-4, change the existing missing-user 500 to
400 in the same commit and update that test's name.
**B6-2 · Accept** — a complete triple produces exactly one record with both fields on the
body and the user as the key.
**B6-3 · The deprecated alias** — `{user, page, platform}` with no `account_id` is accepted
and produces `account_id == page`.
**B6-4 · Rollout ordering — accept-but-not-require is provably non-breaking.**
This is the test that protects the deploy. Under the step-1 build (accept, stamp, do not
reject), assert that **all four legacy poster bodies** are accepted with 200 and produce a
record:
`{user, page, event}` (replybot today), `{user, page, platform, event}` (dean today),
`{user, page, event}` from message-worker, and dinersclub's. Missing fields are simply
absent from the produced envelope; nothing 400s.
Without this test, step 2 of §7.3.1's rollout is a guess — and the failure mode is every
in-flight synthetic event 400ing mid-deploy, which means dropped timeouts, dropped payment
results and dropped machine reports across the whole fleet.
**B6-5 · The canary is observable** — under the step-4 build, assert the rejection is
logged with the poster's identity. Cheap; it is the §7.1 pre-step's only instrument.

### B7 — §7.2 silent-data-loss regressions

**Every one of these must fail against current code before the fix lands.** That is the
point of the section: they are not coverage, they are proof the bug exists.

**B7-a · `DedupStates` keeps both accounts**
*Lives in:* `scribble/state_test.go`. *Gates:* §7.2. *No migration needed.*
Setup: one batch of two `State` writeables, same `UserID`, different `PageID`.
Assert: `len(DedupStates(batch)) == 2` and, after `SendBatch`, `states` holds two rows.
**Note:** `TestStateWriterOverwritesOnePersonsState` (`state_test.go:53`) currently asserts
the *opposite* for the same-page case. Keep that test (same page really should collapse);
add the different-page case beside it. The DB write is already correct —
`SertQuery("UPSERT", "states", ...)` keys on `PRIMARY KEY (userid, pageid)` — so the loss
is purely `state.go:44`'s `dataMap[state.UserID]`.

**B7-b · Two `responses` rows differing only by account both persist**
*Lives in:* `scribble/response_test.go`, alongside `TestResponseWriterWritesPageIdIfExists:149`.
*Gates:* §7.2 **and its new PK migration** (§0.9-1).
Setup: two response messages with identical `(userid, timestamp, question_ref)` and
different `pageid`.
Assert: both rows present. **Today this fails by silently keeping one; after a naive
conflict-target change it would fail by raising a PK violation.** Write a third assertion
that no error was returned, so the test distinguishes the two failure modes — otherwise a
crash-looping scribble looks like a passing "row is missing" test in CI.

**B7-c · Same for `chat_log` on `(userid, timestamp, direction)`**
*Lives in:* `scribble/chatlog_test.go`, beside `TestChatLogWriterIgnoresDuplicateMessages:348`
and `TestChatLogWriterAllowsSameUserDifferentDirections:372`, which are the exact pattern.
Second-granularity timestamps make this the most exposed of the three (§2.1).

**No integration twin is possible right now**, and that is a temporary gap. Per finding (7),
`chat_log` has had no producer since 2026-07-17 and production stopped writing on 2026-07-27, so
there is no end-to-end path to drive. The unit test is therefore the *only* coverage — and it
matters more than usual, because it is what protects the restored publisher from shipping the
silent-row-loss bug along with it. Whoever restores the producer owns writing the integration
twin (drive B1-1, assert `chat_log` holds both conversations' messages) at that time.

Do **not** read the missing twin as evidence the fix is unnecessary: migration 27 must ship, and
it is cheapest now precisely because the table is quiescent.

**B7-d · exodus bail targeting does not cross accounts**
*Lives in:* `exodus/query/db_integration_test.go`, style of `TestIntegration_OR_QuestionResponse:134-178`.
*Gates:* §7.2. *No migration needed.*
Setup: one `userid`; a `responses` row on account A satisfying the bail condition; a
`states` row on account B only.
Assert: the generated query returns **zero** rows. Today it returns the account-B row,
because `builder.go:239` joins `ON s.userid = <cte>.userid` over CTEs
(`builder.go:183-188`, `225-235`) that aggregate `responses` across all accounts.
Golden-SQL twin in `builder_test.go` pinning the join text to
`ON s.userid = rt0.userid AND s.pageid = rt0.pageid` and the CTE `GROUP BY userid, pageid`.
Add the positive control too: same account → the row **is** returned, so the test cannot
pass by returning nothing for the wrong reason.

### B8 — Replay and the `message_pointer` leak (§7.4/§7.5)

> **~~THE HARD BLOCKER ON FINAL GREEN~~ — CLEARED 2026-08-17. The package was absorbed into the
> repo; there is nothing left to publish.**
>
> The client now lives at `replybot/lib/chatbase/`. `stack.ts:124` still builds replybot from
> its Dockerfile, but that Dockerfile's `COPY . /usr/src/app` now brings the client with it,
> so the stack builds the scoped `get()` from this working tree — no registry round trip, no
> npm credentials, nothing to bump.
>
> Preserved because it explains why the split was deleted rather than repaired:
>
> | Step it used to require | Why it was a dead end |
> |---|---|
> | Publish `0.2.0` | Needed the user's npm credentials — the integration suite was gated on a human with a token. |
> | Bump `replybot/package.json:21` `^0.1.0` → `^0.2.0` | A caret on a `0.x` pins the **minor**, so `^0.1.0` never resolves `0.2.0`. Publishing alone changed nothing, and the red was indistinguishable from "not published yet". |
>
> The old "neither step can be worked around here: vendoring would turn the suite green against
> code that is not what production would run" objection was about `npm link`ing a local build
> while the image kept installing from the registry. Vendoring into the repo is the opposite:
> the harness and production now build from the same source tree, which is the property the
> split never had.
>
> **Formerly blocked on it: B8-1b, B8-2, B8-5b** (still tagged
> `[RED: needs chatbase-postgres@0.2.0 published]` in `test.tc.ts` — the tag is stale and
> should be retitled when those tests are next confirmed green), plus B8-7 and B8-8.
>
> **B8-5a passes — but VACUOUSLY.** With `get()` unscoped, every archived row is returned to every
> account, so of course the NULL-`account_id` row is replayed. Its green is evidence that nothing
> is scoped yet, **not** evidence that the tolerant contract works. It becomes a real assertion
> only once 0.2.0 ships, at which point B8-5b is what distinguishes tolerance from no scoping at
> all. **Do not count B8-5a as coverage before then.**

**A8 IS DONE and the messages sink works** — 575 archived rows observed after one suite run, so
§B8 is writable at last. Two structural notes that were not obvious until it ran:

**(a) B8-1 and B8-2's SETUP also depends on §7.1**, not merely on §7.5. Establishing two live
conversations for one participant is impossible while the cache key is shared: the second entry
stitches onto the first (finding (10)), and forcing a miss does not help because the *replay* is
contaminated too. So pre-§7.1 they fail during setup, never reaching their replay assertions.

**(b) Hence B8-1b, which breaks that circular dependency** by seeding the archived log *directly*
— inserting `messages` rows in exactly the shape `scribble/message.go:41-42` writes them. Replay
reads `messages`, so that is all §7.5 needs. **This lets §7.4/§7.5 be verified independently of
§7.1** instead of queueing behind it. Keep both: B8-1b can go green first, B8-1 is the end-to-end
proof.

**B8-1b · Replay scoping, isolated from cache scoping** *(gated on §7.4+§7.5 ONLY)*
*Lives in:* `test.tc.ts`, `B8` block.
Setup: seed the archived log **directly** with two conversations for one participant — researcher
A's `isoFormA` on page A, researcher B's `isoFormB` on page B — inserting `messages` rows in
exactly the shape `scribble/message.go:41-42` writes them. Then force a miss on both and drive one
event on account A.
Assert: `forms === ['isoFormA']`, `md.pageid === PAGE_A`, and A's `qa` contains no `isob_` ref.
Non-vacuity guard first: at least 2 archived rows.
Pre-fix this fails because `chatbase.get()`'s `WHERE userid = $1` returns both accounts' rows.
**This is the §7.5 test to develop against** — it is the only one that does not wait on §7.1.

**B8-1 · Cache miss replays only that conversation's events** *(gated on §7.1+§7.4+§7.5)*
*Lives in:* `test.tc.ts`, serial. *Gates:* §7.5.
Setup: drive B1-1 to build history on both accounts. Delete **only** account A's Redis key.
Send another event on account A.
Assert: the state reconstructed for A contains A's `qa` history and **none** of B's; B's
state is untouched; the reply is the correct next question of `isoFormA`.
Today this replays both conversations interleaved (§2.2 item 3) — though only after A8,
because without the messages sink the replay is empty and the test would pass vacuously.
**Guard against exactly that**: assert first that `SELECT count(*) FROM messages WHERE
userid = $1` is greater than zero. A vacuous pass here would be the worst outcome in this
document.

**B8-2 · `form.reset` on account A does not stop truncation on account B** *(gated on §7.1+§7.5; no isolated variant — the pointer checkpoint is a property of the states/messages JOIN, so it needs two real states rows with two real pointers)*
*Lives in:* `test.tc.ts`, serial. *Gates:* §7.5. Covers §2.2 item 4.
Setup: both conversations live with history. Trigger a `form.reset` on account A, which
sets A's `message_pointer` (`04-pointers.sql:1`, computed from `state_json.pointer`;
`machine.js:350`). Then force a cache miss on account B and replay.
Assert: B's replay is **still truncated** at B's own pointer — B's pre-reset history is
excluded. Today `chatbase.get()`'s `LEFT JOIN (SELECT userid, message_pointer FROM states
WHERE userid = $1) USING (userid)` returns one row per account, the message rows are
duplicated N times, and the pointer check passes if **any** account's pointer allows it.
Also assert no message appears twice in the replayed log — that is the multi-row
duplication, and it is separately observable.

**B8-3 · `messages` rows carry the account** — after any flow, assert
`messages.account_id` and `messages.platform` are populated and correct. *Gates:* §7.4.
**B8-4 · Backfill parity — NOT WRITTEN HERE; covered better elsewhere.** *(Decided 2026-08-17.)*

Backfill correctness is proved at layers closer to the code:

- **Parity** (the SQL rule vs the Go rule): scribble's `TestBackfillSQLMatchesGo` evaluates
  `devops/sql/messages-{account-id,platform}-expr.sql` — the actual files the batched UPDATE
  substitutes — against the shared echo fixture, and asserts agreement with
  `ConversationFromHistoricalContent`. Drift-verified.
- **Real-shape behaviour, poison resilience, idempotency, resumability**: the §7.4 stream's own
  suite over `devops/backfill-messages-account.sh`.

A version in this harness would have to **fabricate historical rows**, because the harness is a
fresh database where every row is written by current code — the same structural fact that broke
B8-6's first mechanism. It would duplicate the stream's test from further away, with a worse
failure signal.

The forward/backward *consistency* question — does the backfill's derivation agree with what the
live pipeline writes — **is already B8-3**, in its only meaningful form. The forward/backward
*overwrite* seam does not exist: `backfill-messages-account.sh:348`'s UPDATE carries
`AND account_id IS NULL`, so forward-written rows are excluded by construction.

**This decision is void if the backfill ever gains a branch that writes over a non-NULL
`account_id`.** Then B8-4 must be written.


**B8-5 · The migration-window contract for `chatbase.get()`** — *rewritten 2026-08-17; the
strict form this entry used to specify was wrong and dangerous.*

**The contract is TOLERANT, not strict:**

```sql
WHERE userid = $1 AND (account_id = $2 OR account_id IS NULL)
```

An earlier revision specified the strict form — that a tuple-keyed `get()` returns **empty**
for NULL-`account_id` rows — in order to force "§7.4 fully backfilled before §7.5 ships."

**Why that was wrong.** `STATE_STORE_LIMIT=30000` combined with `ORDER BY timestamp ASC` means
replay reads the **OLDEST** 30k events, not the newest. Under the strict contract, any
conversation whose *old* events are not yet backfilled replays as **empty** — which converts
the "every existing conversation replays as empty" catastrophe from a sequencing risk into a
**guarantee**. And there is no recency bound to exploit *precisely because of* that ASC
ordering: you cannot backfill "just the recent tail" and be safe. Sizing confirms the backfill
cannot simply be rushed — 87% of `messages` predates 2025-02, only ~8% is newer than
2026-01-01, so a full backfill is ~106M rows of write amplification.

Under the tolerant contract, historical un-backfilled rows behave **exactly as they do today**
— no better, no worse — new rows are strictly scoped, and the clause becomes a no-op as the
backfill drains.

**B8-5a · a NULL-`account_id` row IS replayed.** Seed a historical-shaped archived row, force a
miss, drive an event. Assert the conversation is reconstructed (`forms` includes its form). An
empty replay here is the catastrophe. Runs today.

**B8-5b · a POPULATED, NON-MATCHING `account_id` row is NOT replayed.** *(needs migration 26.)*
Seed one NULL row for account A and one fully-backfilled row for account B; drive account A;
assert `forms` includes A's form and **not** B's. This is the more important half: without it
the tolerant clause is **indistinguishable from having no account predicate at all**. It fails
loudly rather than skipping when the column is absent, so it cannot go quietly missing once 26
lands.

> **DO NOT "TIGHTEN" B8-5 BACK TO THE STRICT FORM.** Returning NULL-`account_id` rows is not a
> leak — it is the only thing standing between the backfill and mass conversation loss. The ASC
> ordering is the whole reason. If you are reading this because a scoped read looked too
> permissive, B8-5b is the test that proves scoping still works.

**B8-6 · the tolerance keeps its documented removal condition.**

The NULL branch is explicitly temporary, and temporary is what becomes permanent by accident.
But the two halves of "still temporary" live in different places, and conflating them produces a
test that lies:

| Claim | Where it can be checked |
|---|---|
| The tolerance still **works** | A harness test — this is B8-5a. |
| The tolerance is still **needed** | A **production** query. **Not** a harness test. |

*An earlier revision of this entry specified B8-6 as asserting that NULL rows still exist in the
harness, so that it would fail once the backfill completed and force the cleanup. That was wrong
and failed immediately for the wrong reason: **the harness is a fresh database in which every row
is written by current code, so it has zero NULL rows by construction**, while production has
~106M. A fresh-DB row count says nothing about production's backfill progress — it was a false
positive dressed as a tripwire. Recorded because it is a tempting mistake: "assert the migration
is still in progress" feels testable and is not, in an environment that has no history.*

So B8-6 owns the **intent** only: it asserts this document still carries the removal-condition
marker below, and that the marker still names the observable that decides it. That keeps the
odd-looking `OR account_id IS NULL` clause attached to its reasoning, and makes removing the
tolerance an act of deleting a documented decision rather than quietly tightening a `WHERE`.

The **removal trigger** is a production-data check, and belongs with the other production
invariants (alongside §5.3's registry count assertion), not in the harness:

```sql
-- Recurring check. When this reaches 0 in every environment, the tolerance is dead code.
SELECT count(*) FROM chatroach.messages WHERE account_id IS NULL;
```

> **NULL-ACCOUNT-ID TOLERANCE REMOVAL CONDITION** — the `OR account_id IS NULL` clause in
> `replybot/lib/chatbase` `get()` may be removed when, and only when, **zero rows in
> `chatroach.messages` have a NULL `account_id` in every environment**. At that point: drop the
> clause, delete B8-5a and B8-6, and tighten B8-5b into the strict contract. B8-6 is written to
> fail at exactly that moment so the decision is made once, deliberately, rather than drifting.

**B8-7 · `get()` rejects an unscoped call.** *(DONE 2026-08-17; §0.9-13a.)*
Assert that `get(userid, limit)` — a bare string, the pre-fix call shape — **throws**, and that
`get({ userid, account }, limit)` succeeds. This is the guard that stops a forgotten call site
degrading silently back to an unscoped read: the one failure mode that would reintroduce the bug
with no test going red. Unit-level; no integration echo needed.

> Written and passing. It came in with the absorbed package and now runs in replybot's own
> suite: `replybot/lib/chatbase/chatbase.test.js`, "throws on a bare user id rather than
> silently reading unscoped" and "throws when the account key is absent entirely" (the second
> covers the `{ userid }`-with-no-`account` case, which is a *different* mistake from
> `account: null` and must not be conflated with it). Needs a CockroachDB on 5433;
> `.github/workflows/replybot-test.yml` provides one.

**B8-8 · The unscoped fallback preserves "any pointer allows it" exactly.** *(Unblocked and
still unwritten; §0.9-13c.)*
Its home is now `replybot/lib/chatbase/chatbase.test.js`, alongside B8-7. The nearest existing
test, "never returns the same row twice", sets **both** accounts' pointers to NULL; B8-8 is the
**mixed** case (one pointer set, one not) and is not covered by it.
Setup: one participant, two conversations, where **one has a `message_pointer` and the other does
not**. Exercise the unscoped/fallback path.
Assert the pointer resolves to **NULL** — no truncation — reproducing today's semantics, and
assert explicitly that it is **not** the non-NULL pointer. That is what a plain
`min(message_pointer)` would return, and `min()` ignoring NULLs would truncate **more** history
than today. The regression is invisible by construction: it yields a shorter replay, never an
error. This test is the only thing that would catch it.

### B9 — Appendix A: CTWA autofill ref must be order-independent

*Lives in:* `replybot/lib/event-normalizer.test.js` (unit) **and** `test.tc.ts` WhatsApp
block (integration). *Gates:* Appendix A. Independent of everything else; ship first.

**B9-1 · Order-independent resolution** — a WhatsApp text body of
`ctwaprobe.alpha.creative.Ad1H.form.probetest` on a CTWA referral with no `ref` resolves to
form `probetest`. Assert the resolved `md.form === 'probetest'` and **not** `'305'`.
Integration twin: seed a `probetest` survey, send the referral, assert the first question
is `probetest`'s.
**B9-2 · `form.` first still works** — `form.probetest`, `start form.probetest`, and
`form.a.b.c` all keep resolving as today. Regression guard on
`WHATSAPP_ENTRY_REF` (`event-normalizer.js:257`).
**B9-3 · No double prefix** — the current code returns `` `form.${match[1]}` ``; the new
pattern returns the whole body. Assert the resolved ref is not `form.form.probetest` and
that `_group` parsing of the returned ref yields `{form:'probetest', ctwaprobe:'alpha',
creative:'Ad1H'}` — i.e. the whole dotted body reaches `getMetadata`.
**B9-4 · Mid-survey free text does NOT re-trigger entry** — the constraint that makes this
fix dangerous. Assert each of these produces **no** entry: `I think the form.probetest is
bad`, `please form.probetest`, `form.probetest thanks`, `whatever`. Full-match anchoring
must survive.
**B9-5 · Integration: no silent 305** — send a CTWA referral with a non-leading `form.`
token and assert the conversation is **not** on `FALLBACK_FORM`. The whole point of the
defect is that 305 looks like a completion, so an "a survey started" assertion would pass
while the bug is live. Assert the *identity* of the survey.

### B10 — §7.1 missing-tuple behaviour

*Lives in:* `replybot/lib/typewheels/statestore.test.js` (unit, with the injectable
`redisClient` — `statestore.js:17,24-25`) plus one integration test. *Gates:* §7.1.

**B10-1 · Key shape** — `_makeKey('whatsapp', '106540352242922', 'user123')` is
`'state:whatsapp:106540352242922:user123'`. Replaces the existing `state:user123`
assertions at `statestore.test.js:62-106`.
**B10-2 · Two accounts, same platform, same user → two distinct keys**, and a write under
one is invisible to the other. The plan calls this "the regression test for the whole bug"
at the unit level; B2-1 is its integration counterpart. Keep both — the unit test localises
the failure, the integration test proves it end to end.
**B10-3 · Same account id, two platforms → two distinct keys.** Defensive; see §0.9-2 for
why this case may be unreachable in the real system.
**B10-4 · Missing `platform` → no cache read, no cache write.** Assert `redis.get` is
**not** called and `redis.setex` is **not** called (sinon spies on the injected client),
and that the returned state came from `db.get`. Never a partially-scoped write.
**B10-5 · Missing `account_id` → identical assertions.**
**B10-6 · One greppable tag, logged once.** Assert a single log line containing a distinct
token (propose `CONVERSATION_TUPLE_MISSING`) and that it is emitted once per event, not per
retry. This is the entire instrument for the §7.1 pre-step canary; if it is noisy or
missing the canary is worthless.
**B10-7 · No `md` fallback.** Given an event with no `platform`/`account_id` but a state
whose `md.platform` and `md.pageid` are populated, assert the cache is still not touched.
This is the test that stops someone "helpfully" adding a fallback later.
**B10-9 · The replay-scoping contract — all three rows.** *(Added 2026-08-17. §7.1 has landed and
these pass.)*

Until these existed, **the only unit-level assertion of replay scoping anywhere** was an incidental
`expect(mockDb.get.firstCall.args[0]).to.equal('user123')` — which pinned the *pre-§7.5 positional*
call shape and went red when `get()` became `get({ userid, account }, limit)`. B10-4 and B10-5
asserted `mockDb.get.called` rather than its **arguments**, so they would have passed against a
completely unscoped replay. The third row had no coverage at all.

| # | Given | `get()` must receive |
|---|---|---|
| **B10-9a** | account present, platform present | `{ userid, account: <account> }` |
| **B10-9b** | account present, **platform ABSENT** | `{ userid, account: <account> }` — account **preserved** |
| **B10-9c** | no account | `{ userid, account: null }` — key **present and null** |

**B10-9b is the one that most needs pinning.** The cache cannot be keyed without a platform, but
the *replay* can still be scoped by account, and must be. The live gate is
`(conv && conv.account) || null`. An `isNamed`-style gate — "only scope when the whole tuple is
known" — resolves this case to `account: null` and **throws away an account the event actually
carried**, silently replaying every conversation the participant has, for every
platform-less-but-account-bearing event. That alternative was considered and rejected; B10-9b is
what stops it returning as a "simplification".

**B10-9c** asserts the key is *present and null*, not merely absent, because omitting it **throws**
by design (§0.9-13a) — that throw is the guard against a forgotten call site degrading quietly to
an unscoped read.

B10-4 and B10-5 were also strengthened to assert the argument rather than just `.called`.

**B10-8 · Integration: a tuple-less event still advances the conversation.** Post a
synthetic event without `platform` (via A6's raw builder) against a live conversation and
assert the machine still runs — degraded to a replay, not an error. This is what makes the
no-fallback rule safe to ship.
**B10-9 · `clear-state-cache.sh`** — with `DRY_RUN=1`, a userid matches
`state:*:*:<userid>` across both accounts and reports two keys; the script uses `SCAN`, not
`KEYS`. Assertable as a shell test against the harness's Redis (A9). The script runs
against production Redis; `KEYS` there is a stall.

---

### B11 — The messaging account registry (§5 / §7.6)

**Unparked 2026-08-17** per §0.9-2. **`devops/migrations/25-messaging-accounts.sql` now exists and
is verified** — applies clean in both application modes (26 files lexically one-at-a-time, and the
single concatenated `make test-db` session), fully `chatroach.`-qualified, idempotent on re-run,
with GRANTs the §5.2 draft omitted. So B11 is implementable. It still ships **last** and gates
nothing; lowest priority in this plan.

Three of the tests below deviate from what §5 describes, because §5 turned out to be wrong about
the live system. Each deviation is verified and approved; the plan text, not the implementation,
is what needs correcting.

**B11-1 · No messaging credential lacks a registry row.** *(Replaces §5.3's count-equality
assertion, which is WRONG.)*
`count(messaging_accounts) == count(credentials WHERE entity IN (...))` **breaks on a correct
change**: one credential can legitimately back **two** registry rows — that is precisely the
Instagram case in B11-4. An equality assertion would fire on the very change the registry exists
to enable.
The shipped form is an Instagram-proof **non-existence** check — no messaging credential without a
registry row — with both raw counts still exported so equality remains *evaluable* without being
*asserted*.
It ships as a **sql-exporter collector** (`messaging_account_health`), which is this repo's actual
convention for recurring data invariants. §5.3's "shipped as a recurring check" should not be read
as "a CronJob".

**B11-2 · Cascade behaviour, including the deliberate `ON DELETE CASCADE` on the credentials FK.**
*(A deviation from §5.2, approved.)*
§5.2's FK omits `ON DELETE CASCADE`. Without it a messaging credential becomes **undeletable**,
which breaks account **reconnection**: `credentials` has `UNIQUE(entity,key)`, the create path has
no `ON CONFLICT`, so re-POSTing a page 23505s and the operational recovery is delete-then-recreate.
Assert: deleting a credential removes its registry row; deleting a **user** removes both (the
double cascade is verified working). Also assert reconnection end-to-end — delete then recreate the
same page — since that is the flow the cascade exists to protect.

**B11-3 · The malformed-messaging-create guard.** *(§5.4 is factually wrong; test what shipped.)*
§5.4 says "the direct-create path rejects messaging entities" and implies **two** create paths.
**There is one**: `POST /api/v1/credentials`, used by *both* `FacebookPages.js:147` and
`WhatsAppEmbedded.js:132-146`. A blanket rejection of messaging entities would therefore have
broken **both live connect flows**.
What shipped rejects only **malformed** messaging creates: missing or empty `key`, or
`details.id` disagreeing with `key`. Assert exactly that — a well-formed messaging create must
still succeed, and a malformed one must be rejected. Do **not** write §5.4's rejection.

**B11-4 · Instagram is data, not a special case.** *The test that carries the reversal's
justification.*
Verified empirically on CockroachDB v24.1.28:

| Case | Result |
|---|---|
| `('messenger', page_id)` + `('instagram', igsid)`, same credential | **Admitted** — both insert, both resolve to the one credential |
| `('messenger', page_id)` + `('instagram', page_id)` — same id | **Rejected**, 23505 on `global_account_id` |

So B11-4 passes as specified — **but only because Instagram uses its own IGSID rather than the page
id.** That is true of Meta's model and is **not enforced by our schema**. Pin it in the test's
comment: if Instagram ever presented the page id as its account id, the transitional
`global_account_id` index would reject the second row and this case would fail. The test rests on
an external assumption, and a future reader must be able to see that.

**Read B11-4's status honestly: Instagram is currently DEAD CODE.** The translator, a stub client
and the enum entry exist, but hermes has no Instagram webhook, no `instagram` entity is
registerable, and nothing anywhere produces `platform='instagram'`. The reversal's justification is
therefore **prospective** — it rests on Meta's API design (Instagram DMs send through the Page's
token, so one credential backs two platforms), not on an observed production incident. That is
still a sound basis for the schema, but it should not be cited as though it had already bitten us.

**B11-5 · FK integrity.** A registry row whose `(userid, credentials_entity, credentials_key)` does
not exist is rejected. Plus the §3.1 corollary: because `credentials` cascades on user delete, the
**log** tables must keep their own `platform` column (§7.4), or deleting a researcher strips the
platform binding from history. Archival tables must not depend on a cascading table for meaning.

**B11-6 · `global_account_id` is NOT safely droppable — it has acquired two dependants.**

§5.2 labels `UNIQUE INDEX global_account_id (account_id)` "TRANSITIONAL" and §5.5 step 5 says to
drop it. **Dropping it now breaks things that did not depend on it when the plan was written:**

1. **It is what makes `account_id → platform` single-valued**, which the planned hermes platform
   resolution depends on. Without global uniqueness a bare account id no longer determines a
   platform, and hermes cannot stamp `platform` by lookup.
2. **Migration 24 documents that dropping `unique_messaging_account` lets `media_handle` rows
   collide** — that table is keyed on `(asset_id, account_id)` with **no platform component**, so
   global account-id uniqueness is load-bearing for media resolution too.

Assert that the index exists and that a cross-platform duplicate `account_id` is rejected — and
label the test as pinning a **transitional** constraint with **named dependants**, so that whoever
eventually drops it must deal with both first rather than deleting a test that looks obsolete.
§5.5 step 5 needs updating in the plan to say so.

**Explicitly NOT in B11:** migrating the read consumers onto the tuple (§5.5 step 3). Each is
independently deployable and the registry is derived from the same rows the old query reads, so each
consumer's own suite covers its own switch. A single mega-test would couple those deploys together.

## C. Ordering

Mapped onto the plan's "Order of work."

### C.0 — Writable now, red today, no harness change

Start here; these need nothing from §A and each fails against current code.

| Test | Suite |
|---|---|
| B7-a `DedupStates` two accounts | `scribble/state_test.go` |
| B7-d exodus bail targeting (+ golden SQL) | `exodus/query/*_test.go` |
| B9-1…B9-4 CTWA order-independence | `replybot/lib/event-normalizer.test.js` |
| B10-1…B10-7 statestore unit tests | `replybot/lib/typewheels/statestore.test.js` |
| B4-1…B4-7 hermes envelope | `hermes/tests/{handlers,event}.rs` |
| B6-1…B6-5 hermes synthetic rejection + rollout | `hermes/tests/handlers.rs` |
| B5-2 message-worker POST body | `message-worker/worker_test.go` |
| B5-3 dean `account_id` | `dean/queries_test.go` |

B7-b and B7-c are *also* writable now — but see §0.9-1: they cannot be made green without a
PK migration, so land them red and leave them red until that migration exists. Tag them
explicitly (`[RED: needs PK migration]`, following the existing convention at
`test.tc.ts:358,383`) so nobody "fixes" them by weakening the assertion.

### C.1 — Harness changes, in dependency order

1. **A1 + A2** (two researchers, four accounts, distinct tokens) — independent, low risk.
2. **A3** (conversation-keyed receiver) — the keystone. Nothing in §B1–§B3 moves without it.
3. **A4 + A5 + A6 + A7** (socket, echo threading, mox, readers) — all depend on A3.
4. **A9** (Redis port) — independent; needed by B10-9 and the Redis assertions in B1.
5. **A8** (messages + chat-log sinks) — independent of A3, and the *only* prerequisite for
   all of §B8. Start it early; it needs two new `scribble/kube-dev/*.yaml` files.
6. **A11 + A12 + A13** (serial block, form fixtures, README).

### C.2 — Then, against the plan's phases

| Plan step | Tests that gate it |
|---|---|
| 1. §7.2 + Appendix A | B7-a, B7-d, B9-* — green. B7-b, B7-c red pending the PK migration (§0.9-1). |
| 2. §7.3.2 hermes accepts and stamps | B4-1…B4-7, **B6-4 especially** — accept-but-not-require must be proven non-breaking *before* any poster changes. |
| 3. §7.3.1 all four posters | B5-1…B5-5. |
| 4. §7.1 pre-step canary | B10-6 (the tag is the instrument) + B4-8 (the fields survive to `messages`, which is what "zero missing" actually means downstream). |
| 5. Hermes turns on the 400 | B6-1…B6-3, B6-5. |
| 6. §7.1 cache key | B10-1…B10-9 (**all 25 green as of 2026-08-17**), then **B1-1, B1-2, B1-3, B1-4, B2-1, B2-2, B3-1, B3-2**. B2-1 is the ship gate. |
| 7. §7.4 + §7.5 as one unit | B8-3, B8-5a, B8-6 (§7.4), then **B8-1b** (§7.5 — develop against this one; it does not wait on §7.1). B8-1 and B8-2 need §7.1 for their setup, so they go green last. B8-4 needs migration 26 before it can be written at all. Every non-vacuity guard is mandatory. |
| 8. §7.6 registry | §B11. Unparked 2026-08-17; ships last, gates nothing, lowest priority. |
| 9. §7.7 rename | Green-refactor only: every test above must pass unchanged except for column names. If a rename breaks an assertion, the rename is wrong. |

### C.3 — Standing rule

**Every test in §B7, §B8-1, §B8-2 and §B2 must be demonstrated failing against the current
code before its fix is written, and the failure mode must be recorded in the test's
comment.** These are regressions on silent data loss; a test that was never seen red proves
nothing about a bug whose signature is the *absence* of a row.

---

## D. Explicitly out of scope

- **§7.7 the `pageid` → `account_id` rename.** Pure refactor; covered by every test above
  continuing to pass. No new tests.
- **Repairing the 1,892 dormant Iraq/Virtual-Lab rows.** §1.3 puts it out of scope; that
  study ended 2026-06-18.
- **The §2.3 data-quality findings** (malformed `states.pageid` values, the page id
  appearing as a user id). Real bugs, separate work. Worth one defensive test *if* the
  echo-parse path is touched: `parseMessengerEvent`'s inversion
  (`event-normalizer.js:200-206`) is the suspected cause and B4-2 covers the inversion
  itself.
- **Dashboard-server / dashboard-client.** No container in the stack and adding one is a
  large lift. §B3 asserts containment at the data layer — which row is scoped to which
  account — because that is exactly what `states.queries.js` reads. The API-level
  assertion adds confidence, not coverage.
- **Load, ordering-under-concurrency, and partition rebalancing.** The Kafka key is
  unchanged (§0.9-5), so per-user ordering is preserved by construction. B1-4 pins the key;
  proving the broker's ordering guarantee is not our job.
- **Real Meta API behaviour.** The harness mocks the Graph API by design
  (`facebot/receiver/index.js`); PSID scoping semantics are Meta's, and §1.3 already
  establishes empirically that production does not behave the way the documentation claims.
- **`replybot/lib/responses/stateman.js` and the `Responser` class.** §7.1 deletes both as
  dead code (they call a three-arg `machine.transition` against a two-arg method —
  `transition.js:22`). Deleted code gets no tests; the only requirement is that the suite
  still passes after deletion, which proves the dead-code claim.
