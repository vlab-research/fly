# Replybot

Make sure you have a folder called keys at the root of this project, with a single file: "key.json" -- which is the google application credentials keys.

Also make sure you have the .env file at the root of the project. This is currently the SAME for both botserver and replybot, so symlink one to the other!

## Setup local kubernetes

Make sure you install the following on your machine:

* [Virtual Box](https://www.virtualbox.org/wiki/Downloads)
* [kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl/)
* [minikube](https://kubernetes.io/docs/tasks/tools/install-minikube/)
* [helm](https://docs.helm.sh/using_helm/#installing-helm)

Now setup minikube and kubectl:

``` shell
minikube start
kubectl use-context minikube
```

Now, initialize helm in you minikube cluster and install Kafka using helm:

``` shell
helm --kube-context minikube init
helm repo add bitnami https://charts.bitnami.com/bitnami
helm --kube-context minikube install --name spinaltap --values kafka-values-dev.yaml bitnami/kafka
```

Run this in the shell you will be using

``` shell
eval $(minikube docker-env)
```

To reload or start an app (both botserver and replybot), inside the folder run:

NOTE: You will receive warnings the first time due to the fact that the script tries to delete the deployment, which will error if the deployment does not exist. That's ok.

``` shell
./dev.sh
```

You should now see the pods running at:

``` shell
kubectl get po
```

And you can get logs for an individual pod via:

``` shell
kubectl logs [POD_NAME]
```

Or, handily, you can setup the following script (as kube-logs.sh, for example) and alias it to something useful on your computer:

``` shell
NAME=$1
NUM=$2
kubectl logs $(kubectl get pods -l "app=${NAME}" -o jsonpath="{.items[${NUM}].metadata.name}")
```

Which you can then run:

``` shell
alias kubelog=kube-logs.sh
kubelog gbv-replybot 1
```

## What actually runs

**`lib/index.js` is the only entrypoint** — it is what `package.json`'s `start` runs, and it
is the whole of production replybot. `lib/responses/` is not a second consumer; it holds two
things that are still live:

| File | Status |
|---|---|
| `lib/responses/responser.js` | `responseVals` only — the pure response-row builder, imported by `typewheels/transition.js` on the live path |
| `lib/responses/pgstream.js` | keyset-paginated `messages` reader, used by `debugger.js` |
| `lib/responses/debugger.js` | local CLI: replays one participant's archived log through the real machine and prints each transition. Useful precisely for reproducing cross-conversation state bugs |

**Deleted in §7.1** (`stateman.js`, `scratchbot.js`, `batch.js`, and the `Responser` class):
all four called `machine.transition(state, userId, rawEvent)` with **three** arguments
against a **two**-argument method, so they threw a `TypeError` on their first event and
cannot have worked since that signature changed. Nothing deployed ran them — scribble is the
real writer of both `states` and `responses`, and the `scratchbot` subchart is `false` in
every environment. Their only remaining effect was the persistent belief that `stateman`
writes the `states` table.

Left behind deliberately, needs a follow-up outside replybot's own tree: the 2021-era
scratch manifests that still name the deleted entrypoints —
`replybot/kube-scratch/{stateman,scratch-deployment,batchscratch}.yaml`,
`replybot/kube-scratch-dev/{stateman,scratch-deployment,batchscratch}.yaml`, and
`replybot/scratch/chart/` (whose only purpose was to run `scratchbot.js`) — plus the
`scratchbot` dependency in `devops/vlab/Chart.yaml` and its `scratchbot: false` line in
`devops/values/{production,staging}.yaml` and `devops/values/integrations/fly.yaml`. None is
applied by anything in `devops/`, and none can start now that the JS is gone.
`kube-scratch-dev/debugger.yaml` stays — `debugger.js` stays.

## Event Normalization (UniversalEvent)

All events entering the replybot are normalized by `lib/event-normalizer.js`
into a `UniversalEvent` (`{ event_id, user_id, timestamp, source, event_type,
payload, raw }`) before the state machine sees them. The machine
(`lib/typewheels/machine.js`) switches only on `event_type` and reads typed
`payload` objects — it never touches raw Messenger fields.

The `lib/chat-log/publisher.js` module publishes chat log entries to a Kafka topic for every visible message in a conversation (both bot echoes and user messages). This feeds the `chat_log` database table via a downstream scribble sink.

Notes on specific shapes:

- **Payload parsing** — Messenger delivers `quick_reply`, `postback`, and
  `optin` payloads as JSON strings; the normalizer parses them to objects
  (`parsePayload`), falling back to the raw string when not valid JSON.
- **Optin** — normalized to `event_type: 'optin'` with
  `payload: { type: 'optin', optin_type: <messenger optin.type, e.g.
  'one_time_notif_req'>, token: <one_time_notif_token>, payload: <parsed
  notify-field ref object> }`. The machine's OPTIN case checks
  `payload.optin_type`, stores the token in `state.tokens`, and answers the
  pending `notify` field (the validator matches `payload.payload.ref` against
  the field ref). After a timeout fulfils a notify wait, the stored token is
  attached to the outgoing message and message-worker sends it with
  `recipient: { one_time_notif_token }` instead of the user id.
- **Handover** — Messenger `pass_thread_control` is normalized to
  `event_type: 'handover'` with `payload: { type: 'handover',
  previous_owner_app_id, new_owner_app_id, metadata }`. The machine's
  `HANDOVER_EVENT` case reads `payload.new_owner_app_id`, and the wait/timeout
  logic (`lib/typewheels/waiting.js`) reads the handover value off the
  normalized `payload` — it consumes normalized events **only**. (The legacy
  raw-`pass_thread_control` fallback in `_normalizeEvent` was removed: every
  event is normalized on ingest by `statestore.js`, and `machine.js` stores the
  normalized event in `externalEvents`, so a raw handover never reaches
  `waiting.js`.)

## Entering a conversation

A referral is not the only way in. A **real platform event** arriving on a `START` state
blank-starts a survey on `FALLBACK_FORM` via `_blankStart`, which stamps the `md` the rest of
the pipeline depends on: `startTime` (needed by `getForm` to resolve the form version),
`form`, `pageid` and `seed`.

`TEXT` and `MEDIA` always did this. `QUICK_REPLY`, `POSTBACK` and external events
(`_handleExternalEvent`) did not — they fell through to `RESPOND`, so `apply()` computed
`md: { ...undefined, ...undefined }` = `{}`. That husk is truthy, so it passed the
`!newState.md` guard in `transition.js` and then threw inside `getForm` on the missing
`startTime`. 277 production states were trapped that way, mostly users whose first event
was a quick_reply or a "Get Started" postback. All five paths then shared the same
`state.state === 'START'` check.

### A SYNTHETIC event may not blank-start (`DEFER`)

Sharing that check across all five was one path too many. `_handleExternalEvent` has two
callers and they are not equivalent:

| Caller | `source.type` | At `START` | Why |
|---|---|---|---|
| `HANDOVER_EVENT` | `messenger` | **blank-starts** | A Messenger thread-control passback is genuine first contact: on an ad click it lands ~1.5 s *before* the quick_reply carrying the referral, which then switches the participant onto the referred form. See `documentation/referral-form-resolution.md` §6b and the handover-race test in `machine.test.js`. |
| `EXTERNAL_EVENT` | `synthetic` | **`DEFER`** | A dean `timeout`, a dinersclub payment result, a linksniffer click and a moviehouse video event exist *only because a conversation already exists*. `START` here is self-contradictory. |

For a synthetic event, `state === 'START'` does not mean "new participant" — it means the log
just replayed is not this conversation's log. Either the scribble `messages` sink has not
archived it yet (replybot and scribble consume `chat-events` in parallel, so scribble is
systematically behind for a brand-new conversation), or the event named an account the
conversation does not live on (on a legacy hand-authored `webview`, `linksniffer` and
`moviehouse` read the account out of a query string the *researcher* wrote — routinely a page
id copied from another survey; the `link_tracking` and `moviehouse` field types remove that by
building the query string here instead). Neither is a reason to enter a survey, and entering
one is severe rather than untidy: `FALLBACK_FORM` is production `305`, a real live survey
belonging to another researcher, whose misrouted participants finish in one message and
therefore look like completions.

So `_handleExternalEvent` returns `{ action: 'DEFER' }` when `_isSynthetic(nxt)`:

- `apply` treats `DEFER` as a **pure no-op**. That is load-bearing: `exec` runs during replay
  as well as live (`getState` folds the archived log with it), so throwing here would make any
  log that *opens* with a synthetic event permanently unreplayable — turning a transient archive
  lag into a permanently dead conversation.
- `transition.js`'s `run` returns **without `newState`**, and `lib/index.js` gates both
  `publishState` and `stateStore.updateState` on `report.newState`. So nothing is UPSERTed into
  `chatroach.states` and nothing is written to the cache.
- One line is logged, tagged `SYNTHETIC_EVENT_NO_CONVERSATION` (exported from
  `lib/typewheels/transition.js`), carrying the user, page, platform and event type.

**Publishing nothing is the mechanism, not a detail.** `scribble/state.go` writes with a bare
`UPSERT`, so any state published here overwrites the conversation's real `states` row — and that
row is what every recovery sweep selects on. Leaving it alone *is* the retry path: dean's
`Timeouts()` re-fires every 10 minutes for up to 72 hours while
`current_state = 'WAIT_EXTERNAL_EVENT'`; dean's `Payments()` re-issues `repeat_payment` after
2 hours; moviehouse heartbeats again within 30 s. A linksniffer click has no re-send and is
genuinely lost — named rather than hidden, and still far better than sending the participant
another researcher's survey.

An `ERROR` state with a new retryable tag was considered and rejected: it clobbers that row, a
new tag is not in `DEAN_ERROR_TAGS`, and even inside the tag set the redo re-reads the same
cached corrupt state and re-fails. See the `FIELD_NOT_FOUND` comment at
`devops/values/production.yaml:170-183`.

An exodus `BAILOUT` at `START` is **not** deferred: it names its own form, so it never resolves
through `FALLBACK_FORM`, and exodus has no re-sweep.

Note all of this covers users who arrive without a conversation. A user who *had* one and lost
their `md` — `block_user` drops it — is damaged rather than new, and is not blank-started:
that would append the fallback form and silently reassign a real participant mid-survey.
See `planning/blocked-user-durability-handoff.md`.

### A FORM-LESS entry may not re-enter a live conversation (`DEFER`)

The five paths above guard on `state.state === 'START'`. `REFERRAL` did not, and that was the
last unguarded way into `FALLBACK_FORM`. It blank-started at **any** state, deliberately: a
referral naming a form is *supposed* to be able to switch a live participant onto it. That rule
is right for a ref that names a form and catastrophic for an entry that names none, because
`_blankStart` then pushes `FALLBACK_FORM` onto a live conversation's stack and replaces `md`
wholesale.

Two shapes name no form and both reach the `REFERRAL` case:

| Shape | Where it comes from |
|---|---|
| Messenger's bare `get_started` postback | normalized to `conversation_started` with `referral: undefined` (`event-normalizer.js`) |
| a referral whose `ref` yields no `form` pair | `clickToMessengerAds`, `homescreenpwa`, a referral object with no `ref` at all, a WhatsApp CTWA referral with no resolvable `ref` |

**Production, measured 2026-08-17.** 3,732 `states` rows have `FALLBACK_FORM` appended to an
existing stack, continuously from **2020-06** at 10–90/month. Replaying 561 of their real
`chatroach.messages` logs through `exec`/`apply` puts them, at the moment of the append, in
`END` 50% / `QOUT` 22% / `RESPONDING` 14% / `WAIT_EXTERNAL_EVENT` 7% / `BLOCKED` 6% / `ERROR` 1%
— 44% mid-survey, **none** at `START`. 96% were appended by a bare `get_started`.

So `exec`'s `REFERRAL` case now ends:

```js
if (!_refNamesForm(nxt) && state.forms.length) {
  return { action: 'DEFER', reason: DEFER_FALLBACK_ENTRY_ON_LIVE_CONVERSATION, event_type: nxt.event_type }
}
return _blankStart(nxt)
```

- **The discriminator is the REF, not the resolved form.** `getForm(nxt) === FALLBACK_FORM`
  looks equivalent and is wrong: a ref may name the fallback shortcode explicitly, and three
  live production rows entered on `?ref=form.305.country.iraq`. `_refNamesForm` re-uses
  `_group` from `utils.js` so it cannot disagree with `getMetadata`.
- **The state test is `state.forms.length`, not the `START` name.** They agree on every row
  measured, and `forms.length` is safer where they diverge — a `machine_report` error before
  entry leaves `ERROR` with an empty stack, and refusing entry there would strand someone who
  has no conversation at all.
- **`DEFER`, not `_noop()`.** `_noop` returns `newState`, which `lib/index.js` publishes and
  `scribble/state.go` UPSERTs over the live conversation's real `states` row, bumping `updated`
  with it. Nothing happened, so nothing is written.
- `DEFER` now carries a **`reason`**, and `transition.js` gives each reason its own tag:
  `SYNTHETIC_EVENT_NO_CONVERSATION` (above) and **`FALLBACK_ENTRY_ON_LIVE_CONVERSATION`**. The
  first is the instrument for §7.1's "watch 24 h, expect zero" canary, so it must not be
  inflated by a defect expected to register 10–90/month.

**Entry still works, and that is the constraint that shaped the guard.** 162,148 `states` rows
are `FALLBACK_FORM` conversations with a length-1 stack; a replayed 452-row sample shows plain
`text` 42%, **bare `get_started` 35%**, `media` 18%, form-less referral 3%, `quick_reply` 2%,
handover 1%. `get_started` is not the sole organic entry signal but it is roughly a third of
them (~57,000 conversations), and 158 of 159 had no referral anywhere in their log — so it must
not be demoted in the normalizer. All 450 replayed entries happened on the first event the
machine acted on, i.e. with `forms: []`, which is why this guard cannot touch them.

**Named behavioural change:** a participant at `END` who taps Get Started again now receives
nothing, where they used to be entered on another researcher's live survey. That is half the
affected population. The documented restart mechanism is `REPLYBOT_RESET_SHORTCODE` via an
explicit `form.reset` ref, and every other post-`END` interaction already declines to start a
new survey. A re-engagement affordance is now a deliberate gap rather than an accident.

Full account, including the detector query and the two accepted costs (a `QOUT` participant is
not re-sent their question; a WhatsApp CTWA arrival with no resolvable ref loses its message):
`documentation/referral-form-resolution.md`, "A form-less entry event may not re-enter a live
conversation".

## Transient state fields — error episodes and retries

`apply()` in `lib/typewheels/machine.js` enforces an invariant: **transient
fields exist only in the states that own them.** Left lying around they show a
healthy participant as broken in the Monitor tab's `state_json` viewer and in
the `error_tag`/`fb_error_code` computed columns that StatesList filters on.

| Field | Lives in |
|---|---|
| `error` | `ERROR`, `BLOCKED` |
| `wait` / `waitStart` | `WAIT_EXTERNAL_EVENT` |
| `retries` | `RESPONDING`, `ERROR`, `BLOCKED` |
| `errorOnset` | `RESPONDING` (only while a retry is in flight) |

### An error is an episode, not an event

`state.error.ts` is the **onset** of an error episode, not the timestamp of the
most recent failure — it is what the `errored_at` computed column
(`devops/migrations/23-states-errored-at.sql`) exposes, so that the
current-error population can be aged by when a user actually broke rather than
by `updated`, which Dean re-warms on every retry. See
`documentation/error-events.md` §2.

An episode ends on **recovery**, not on **retry attempt**. That distinction is
what `errorOnset` exists for:

- A Dean retry (`REDO` → `RESPOND_AGAIN`) blips the user through `RESPONDING`.
  The `error` is dropped there — a `RESPONDING` state must never carry one —
  but the onset is parked on `state.errorOnset`: a bare epoch-ms number, no
  `tag`/`code`, so it is invisible to the error computed columns. It has the
  same lifetime as `retries`, the other piece of retry bookkeeping that
  `RESPONDING` legitimately keeps.
- **Retry re-fails** → `exec` reads the onset back (`episodeOnset`) and stamps
  the new, thinner error with the *original* `ts`. Same episode; content updates
  to the latest failure, onset does not move.
- **Retry succeeds** → whichever transition proves it (`WAIT_RESPONSE`,
  `HANDOFF`, `WAIT_EXTERNAL_EVENT`, `END`, or the user answering via `RESPOND`)
  clears `errorOnset` along with the other transient fields. The next failure is
  a new episode with a fresh onset.

Every transition reachable from `RESPONDING` either consumes `errorOnset` (into
`error.ts` on `ERROR`/`BLOCKED`) or clears it, so it cannot leak.

## Repeats (`_gatherResponses`)

Every re-send of a question — follow-up nudge, failed validation, repeat
referral — funnels through `_gatherResponses` in `lib/typewheels/machine.js`,
which fires on `metadata.repeat`. It emits the nudge/error line first and then
the question re-rendered by `repeatField` (the normal translator, stamped
`metadata.isRepeat`).

The one exception is a `utility_message` field, where the nudge is dropped and
only the template is re-sent: the nudge is free-form text and would be rejected
out-of-window with `(#10)`, blocking exactly the users a utility message exists
to reach, and approved template copy cannot carry the nudge anyway. See
`documentation/utility-messages.md` § "Repeats and follow-ups".

## Conversation state cache (`StateStore`)

`lib/typewheels/statestore.js` caches derived state in Redis. **A conversation is
`(platform, account_id, user_id)`, and the cache is keyed on all three:**

```js
// the ONLY place the key shape is written
makeKey(platform, account, user)  //=> `state:${platform}:${account}:${user}`
```

```js
// lib/index.js, per event
const conv = conversationFromRawEvent(event)   // { platform, account } — either may be null
const state = await stateStore.getState(conv, userId, event)
...
await stateStore.updateState(conv, userId, report.newState)
```

**The account and platform come from the event, never from `md.pageid` /
`md.platform`.** Those two fields are precisely what bleeds between conversations, so
recovering the key from them would re-create the bug the key exists to prevent.
`conversationFromRawEvent` (`lib/typewheels/utils.js`) reads the normalized top-level
`account_id` / `platform` the envelope carries (`documentation/event-envelope.md` — note
`chat-events` has **two live producers**, hermes *and* message-worker, each responsible for
stamping its own events) and **nothing else** — no per-shape extraction
(`recipient.id` / `phone_number_id` / `page`), no `md`. It is pure and total: it never
throws, for any input. It deliberately does not adopt `parseEvent`'s error contract — a
corrupt event is `machine.run`'s problem.

### The three-case contract

**The extractor reports what the event carried and decides nothing.** Each component comes
back as a non-empty string or `null`, independently; `null` is returned for the whole
conversation only when the event named *neither*. The two consumers then gate **differently**,
because they need different things:

| Event carries | `conversationFromRawEvent` | Cache (`isNamed`) | Replay (`conv.account`) |
|---|---|---|---|
| platform + account | `{ platform, account }` | keyed, read + write | account-scoped |
| **account, no platform** | `{ platform: null, account }` | **bypassed** | **account-scoped** |
| no account | `{ platform, account: null }`, or `null` | bypassed | unscoped, loud |

**The middle row is the point of the design.** The **cache key**
`state:{platform}:{account}:{user}` cannot be built without a platform, so `isNamed` requires
the full triple. But the **replay** is `db.get({ userid, account }, limit)` — it takes no
platform at all. An event that carried an account and no platform can therefore still get a
correctly scoped replay, and must: refusing to scope it discards information the event
actually gave us.

That is not a rounding error. An unscoped replay reads
`ORDER BY timestamp ASC LIMIT STATE_STORE_LIMIT` — the **oldest** events, across every
account the participant has ever messaged — so for a heavy two-account participant the window
can be consumed entirely by the *other* conversation and never reach this one's recent
events. It does not merely interleave; it **silently truncates**, and the conversation
resolves to `FALLBACK_FORM`.

So the strictness lives in `isNamed`, not in the extractor. A gate of "return null unless
both components are present" reads as the natural simplification and is the bug: it shipped,
it made `statestore.js`'s `(conv && conv.account) || null` unreachable dead code, and both
unit suites stayed green because B10-9b handed the store a partial conversation *directly*
while nothing asserted the extractor could emit one. Only an integration run caught it.
`utils.test.js` `describe('conversationFromRawEvent')` now pins all three rows at the
extractor; `statestore.test.js` B10-9a/b/c pins them at the store.

**When the account is missing:** the cache is neither read nor written. State is computed
from the durable event log and `getState` logs one line tagged `CONVERSATION_TUPLE_MISSING`,
carrying which component was absent and whether the fallback replay was `account-scoped` or
`unscoped`. Exactly one line per event: `updateState` stays silent because `getState` already
spoke, which is what makes the tag usable as a canary. Never key a conversation under a name we
cannot verify, and never poison the cache with a partially-scoped write.

**This is NOT "the same work a cache miss already does", and the plan's claim that it was is
corrected in `planning/conversation-identity.md` §7.1.** A cache miss happens to an
*established* conversation, so the archive has had a day to catch up. The degraded path happens
to whatever arrives, including the second event of a brand-new conversation — and replybot and
scribble consume `chat-events` **in parallel**, so for a new conversation scribble is behind by
construction. A short or empty replay reconstructs as `START`, which used to blank-start
`FALLBACK_FORM`; see "A SYNTHETIC event may not blank-start (`DEFER`)" above. Two further
differences: an empty replay is also reachable with a perfectly current archive if the event
named the wrong account, and this path has **no memoization at all** (the write is refused too),
so it re-scans up to `STATE_STORE_LIMIT` rows on *every* event rather than once per TTL.

**The canary cannot read zero today, and that is expected.** `moviehouse` is a **seventh**
synthetic poster — a browser, so it is invisible to the `BOTSERVER_URL` grep that enumerates the
other six. `moviehouse/src/script.js` POSTs `{ user, page, data, event }` to hermes' public
ingress with **no `platform`**, for every video event and for a heartbeat every 30 s. So every
moviehouse event takes this path by design, and it must be subtracted before the tag is read as
a rollout signal. It also means flipping `SYNTHETIC_REQUIRE_CONVERSATION` on would 400 every
moviehouse event and kill video tracking — moviehouse has to send `account_id` and `platform`
first, and it deploys from Netlify rather than the cluster.

**A component counts only if it is a non-empty string.** An empty string is a poisoned cache
key rather than a name — the same rule hermes applies when stamping
(`documentation/event-envelope.md`) and message-worker's producer guard applies when
publishing.

`lib/index.js` parses the event twice — once for `conv`, once inside `machine.run`. That is
deliberate: it preserves `machine.run`'s `CORRUPTED_MESSAGE` contract, and a `JSON.parse` is
cheap next to the Redis round trip it guards.

Why any of this matters: keyed on the user alone (`state:${user}`), a participant who
messaged two of a researcher's accounts shared **one** state blob. An entry on account A
would be handed to a live conversation on account B, which then answered a form-A field
against form B, raised `FIELD_NOT_FOUND`, and sat in `ERROR` permanently — `FIELD_NOT_FOUND`
is not in `DEAN_ERROR_TAGS`, so nothing retried it, and every touch refreshed the 24h TTL.
Reproduced live 2026-08-16; see `planning/conversation-identity.md` §1.1. Recovery for an
already-stuck participant is `devops/clear-state-cache.sh`, which matches
`state:*:*:<userid>` and must agree with `makeKey`.

`_getEvents` replays the **conversation's** log, not the participant's:
`db.get({ userid, account }, LIMIT)`, with the account threaded in from the same event
envelope the cache key comes from. See the next section for that contract and for what
happens when the account is unknown.

## Archived event log client (`lib/chatbase`)

`lib/chatbase/chatbase.js` is the Postgres/CockroachDB client `StateStore` replays from
on a cache miss. It is **vendored**, not a dependency.

### Why it lives here

It used to be the `@vlab-research/chatbase-postgres` npm package, loaded through a
`CHATBASE_BACKEND` environment variable naming the module to `require`. Both halves of
that arrangement were absorbed away, for reasons that are worth writing down because
"make it a package again" is a tempting and wrong instinct:

- **The indirection had exactly one implementation, for its entire life.** No second
  `chatbase-*` backend was ever written. `CHATBASE_BACKEND` was a plugin point with one
  plugin, and every deployment set it to the same string. It is now a direct `require`.
- **Both consumers were in this repo, on different versions.** replybot ran `^0.2.0`;
  `facebot/testrunner` pinned `0.0.3`. The integration suite was therefore asserting
  against a client four versions older than the one production ran — a skew that could
  only ever hide bugs, never surface them.
- **The publish step blocked integration testing.** The harness builds replybot from its
  Dockerfile with `npm ci`, so no change to the client could be tested until it was on
  the registry. Worse, `npm` semantics made the fix look like a no-op: a caret on a `0.x`
  version pins the *minor*, so `^0.1.0` never resolves `0.2.0` and publishing alone
  silently changes nothing.

Vendored, the code replybot's tests run is the code its image ships (`COPY . /usr/src/app`),
which is the property the split never had.

### The read contract

```js
await chatbase.get({ userid, account }, limit)   // NOT get(userid, limit)
```

**A conversation is `(platform, account_id, user_id)`, so the first argument is an
object.** Reading by user id alone interleaves every account that participant has ever
talked to — that is the bug this shape exists to prevent.

- **A bare string throws** `ChatbaseValidationError`. It does not fall back to the old
  user-keyed read. That is deliberate: the failure mode of this whole class of bug is
  *silence*, so an un-updated caller must break at its first call rather than quietly
  keep interleaving two researchers' conversations.
- **A missing `account` key also throws.** `{ userid, account: null }` means "the account
  is genuinely unknown, read across all of them" and is allowed; omitting the key means
  the caller forgot, and those are not the same thing.
- **`account: null` is the degraded path**, not a default. `StateStore.getState` passes it
  only when the event envelope carried no account, where replaying the whole user's log is
  the right answer for lack of a better one.

The scoped query filters `messages` on `(m.account_id = $2 OR m.account_id IS NULL)` and
filters the `states` subquery to that one account's `message_pointer`. The `IS NULL`
branch is **migration scaffolding**: rows predating `devops/migrations/26-messages-account.sql`
carry no account until `devops/backfill-messages-account.sh` reaches them, and excluding
them would make every un-backfilled conversation replay as empty. `chatbase.js` carries the
removal gate for that branch inline.

### Testing it

`lib/chatbase/chatbase.test.js` is **the only replybot test file that needs an external
service** — it tests SQL, so it cannot be mocked, and it came in with the client. It wants
a CockroachDB with the full migration set on port **5433** (`make -C devops test-db`;
override with `CHATBASE_TEST_PORT`). `.github/workflows/replybot-test.yml` starts one for
exactly this file. Against an older schema the scoped tests fail with `42703` (undefined
column), which names the missing migration rather than silently returning nothing.

## Platform Tracking (md.platform)

The conversation's platform (`'messenger'` | `'whatsapp'`) is persisted in
`state.md.platform` at conversation start (`lib/typewheels/utils.js
getMetadata`, via `eventPlatform`). It rides along in the state the replybot
publishes to `VLAB_STATE_TOPIC`, so it lands in the `states` table's
`state_json` — where the computed column `states.platform`
(`devops/migrations/21-states-platform.sql`) exposes it — and in
`responses.metadata` (which is `state.md`).

It is persisted for **observability and downstream consumers**, not for routing.
`md.platform` and `md.pageid` are **never read back** to decide where a message goes.

Why it matters: synthetic re-entry events (dean timeouts, follow-ups,
repeat-payments) have `source.type: 'synthetic'`, not a real platform.
Outbound `SendMessageCommand`s must carry the conversation's actual platform
or message-worker rejects/misroutes them. `transition.js` resolves both routing
components **from the event only**:

```js
const page     = parsedEvent.source.account_id   // no md.pageid fallback
const platform = eventPlatform(parsedEvent)      // no md.platform fallback
```

`eventPlatform` (`lib/typewheels/utils.js`) reads `source.type` for real platform events
and `source.platform` for synthetic ones (`parseSyntheticEvent` surfaces the payload's
top-level `"platform"`, which every poster now sends — §7.3.1). It never returns
`'synthetic'`.

**Both `md` fallbacks were removed in §7.1** and both were the same defect as the
user-keyed state cache, one layer down:

- `state.md.platform` (was `transition.js:37`) — the platform recovery.
- `state.md.pageid` (was `transition.js:28`) — **worse in consequence, and missing from the
  original root-cause inventory.** `page` is what `getForm(pageid, shortcode, startTime)`
  and every outbound command are built from, so a conversation served a cached state from
  another account routed its *outbound messages* to the other researcher's page. Recorded
  here so the finding is not lost again; see `planning/conversation-identity-test-plan.md`
  §0.9-3.

Two greppable tags replace the silent guesses:

| Tag | Means | Where |
|---|---|---|
| `EVENT_ACCOUNT_MISSING` | the event carried no `account_id`; `getForm` is about to be called with `undefined` | `transition.js` |
| `EVENT_PLATFORM_GUESSED` | the event carried no platform; `'messenger'` was assumed | `utils.js eventPlatform` |

**Removing the `md.platform` fallback raises the cost of a *wrong* platform on the event,
and linksniffer is the one producer that can send one.** `documentation/event-envelope.md`
("linksniffer sends the triple, but assumes the platform on legacy links") documents that a
webview link with hand-authored params carries no platform, so linksniffer assumes
`messenger` and logs `[LINKSNIFFER_PLATFORM_ASSUMED]`. On a WhatsApp survey that assumption
is wrong. Before §7.1 the wrong value was harmless, because `transition.js` preferred
`state.md.platform` over the event. Now:

- the cache key is `state:messenger:<whatsapp_account>:<user>` — a conversation that does not
  exist, so every such event costs a full replay; **and**
- the outbound commands carry `platform: 'messenger'` for a WhatsApp account, so
  message-worker misroutes or rejects them.

Note that `EVENT_PLATFORM_GUESSED` does **not** fire here: the platform is present, it is
just wrong. The instrument is linksniffer's own `[LINKSNIFFER_PLATFORM_ASSUMED]` counter.
`documentation/event-envelope.md` documents that WhatsApp surveys must use first-party field
types (`link_tracking` and `moviehouse`), which always stamp the platform explicitly.

`EVENT_PLATFORM_GUESSED` is **transitional**. `eventPlatform`'s old comment justified the
silent `'messenger'` default as "exact for all conversations predating WhatsApp support",
which was true when written and is false now: a WhatsApp conversation whose event lost its
platform gets guessed as Messenger and its commands rejected. It stays a guess only until
the last synthetic posters land (linksniffer is being fixed in parallel and will send
`platform=messenger` explicitly as a temporary, measured assumption). Sequence for
finishing the job: grep the tag; when it reads zero for 24h, set `STRICT_EVENT_PLATFORM=1`
(staging first — it makes `eventPlatform` **throw** instead of guessing), then delete the
fallback and the flag.

### Replybot as a synthetic poster

`lib/index.js` `publishReport` POSTs a `machine_report` to hermes' `/synthetic` endpoint on
**every** report, which makes replybot one of the two highest-volume synthetic producers in
the system.

```jsonc
{
  "user":       "<report.user>",
  "account_id": "<account>",
  "platform":   "messenger" | "whatsapp",
  "event":      { "type": "machine_report", "value": { /* the report */ } }
}
```

All three are **required** by the event envelope contract
(`documentation/event-envelope.md`); the request carries `X-Vlab-Poster: replybot`.

**Where `account_id` and `platform` come from, and why in that order.** The
**normalized envelope on the raw inbound event wins** — hermes stamps top-level
`account_id` and `platform` on every event, and the envelope is the single source of
conversation identity precisely because `md.pageid` / `md.platform` are the fields that
bleed between accounts. Only if the envelope lacks them does `publishReport` fall back to
`report.page` / `report.platform`, which `transition()` derives (and which *do* consult
`state.md`). That fallback is a transitional bridge for events produced before hermes
started stamping, not the intended path.

`transition()` has always computed the platform and dropped it on the floor; it is now
carried on the report alongside `page`.

**Why the envelope has to come first, concretely.** A `CORRUPTED_MESSAGE` report — thrown
by `parseEvent` on an unknown `source` or missing fields — has neither `page` nor `platform`,
because it never reached the state machine. Today that report still resolves downstream via
the `state.md.pageid` fallback. Reading the envelope off the raw event is what keeps that
path working once the fallback goes away, and a corrupted-message report is exactly the one
that must not be lost: it is what drives the conversation into `ERROR`.

When either component is missing, `publishReport` logs
`MISSING_CONVERSATION_ON_REPORT` and still POSTs — during the rollout the gate is off, and
swallowing the report would lose the error. Once the gate is on, hermes rejects it loudly,
which is the intended design.

Invariant: `md.platform` never holds `'synthetic'` — `eventPlatform`
whitelists real platforms only. Payment events published to
`VLAB_PAYMENT_TOPIC` also carry a top-level `platform` field. It is now passed into
`actionsResponses(..., platform)` from `transition()` — i.e. derived from the event, the
same rule as `page` — and threaded through the `act()` ctx into `_wrapPayment`
(`machine.js`). It used to be read from `newState.md.platform` with a `'messenger'`
fallback.

Note: `synthetic_conversation_started` is NOT currently categorized as a
REFERRAL by `machine.js categorizeEvent` (it falls through to UNKNOWN/no-op),
so conversations cannot currently start from a synthetic event; the
platform-hint handling in `getMetadata` is nonetheless in place should that
path be wired up. Pre-normalized UniversalEvents injected through
`/synthetic` (parseEvent passes objects with an `event_type` straight
through) DO start conversations and carry their own `source.type`.

## First-party URL Types: `link_tracking` and `moviehouse`

Replybot owns the complete URL end-to-end for two field types that researchers write. The researcher supplies only content — a destination URL or a Vimeo video ID — and chooses the type; replybot stamps the conversation identity (participant, account, platform) and hosts both services. This replaces the prior approach of researchers hand-authoring webview URLs with query parameters, which distributed four failure modes across surveys.

### The field types

**`link_tracking`:** Send a link as a button, record the click, optionally wait.

```yaml
type: link_tracking
url: "https://asiapacific.unwomen.org/en/countries/india"
buttonText: Visit UN Women
keepMoving: true
```

Destinations work with `tel:`, `mailto:`, and `sms:` the same way; all are tracked identically. Pair with `wait` to hold the conversation until the participant clicks:

```yaml
type: link_tracking
url: "https://example.com/resource"
buttonText: Read more
responseMessage: Click the button to continue
wait:
  op: or
  vars:
    - type: external
      value:
        type: linksniffer:click
    - type: timeout
      value: 1 day
```

**`moviehouse`:** Play a Vimeo video with events for play, pause, seek, finish, and a 30-second heartbeat.

```yaml
type: moviehouse
videoId: "164118668"
buttonText: Watch the video
wait:
  type: external
  value:
    type: moviehouse:play
```

Quote the video ID — unquoted, YAML reads it as a number, which can silently truncate leading zeros.

Both types default `extensions: false` (researcher can override) because Messenger defaults `messenger_extensions` to true, requiring domain whitelisting or the button fails to open. They emit `metadata.type === 'webview'` on the wire as the transport discriminator.

### Configuration: public hostnames from env vars

The base addresses come from config, read exactly like every other service address (BOTSERVER_URL, FORMCENTRAL_URL):

```javascript
const LINKSNIFFER_URL = process.env.LINKSNIFFER_URL   // e.g. "https://links.vlab.digital"
const MOVIEHOUSE_URL = process.env.MOVIEHOUSE_URL     // e.g. "https://virtuallab-videos.netlify.app"
```

These are set in the `replybot.env` block of `devops/values/production.yaml` and `devops/values/staging.yaml`, and they are **public hostnames** — a participant's phone browser opens them. They are not cluster-internal service names.

If either env var is unset or blank, the error is thrown at the point of use, not at startup. A startup refusal would take down all of replybot for a gap affecting one field type and would break every dev/test environment. The thrown error carries **no tag**, so `transition.js` routes it to the untagged `STATE_ACTIONS` catch-all, which downstream reads as "platform fault" (correct — a missing env var is ops, not study config) and which is listed in `DEAN_ERROR_TAGS` in production.yaml, so dean retries it automatically once the config is fixed.

### Canonical conversation-identity params

Because replybot owns both ends, there is **ONE canonical set of query param names**, read by both linksniffer and moviehouse:

```javascript
const IDENTITY_PARAMS = {
  user: 'vlab_user',          // participant id
  account: 'vlab_account',    // account id
  platform: 'vlab_platform'   // 'messenger' | 'whatsapp'
}
const VIDEO_PARAM = 'vlab_video'  // moviehouse only; the Vimeo video id
```

The `vlab_` prefix is deliberate: it makes collision structurally impossible rather than merely unlikely. Unprefixed names like `id` used to mean "the participant" on linksniffer and "the Vimeo video" on moviehouse — the exact collision that forced two param schemes. Nothing else in the system and nothing on a destination site is called `vlab_*`.

**linksniffer's destination params are content, not identity**, so they keep their names:
- `url` — the destination with the protocol stripped
- `p` — the protocol (`https`, `http`, `tel`, `mailto`, `sms`)

### Legacy fallbacks are load-bearing

URLs delivered to participants before a deploy get clicked after deploy (Messenger's 24-hour window). linksniffer reads the canonical `vlab_*` names first, then falls back to legacy names:

```javascript
vlab_user → id
vlab_account → account_id → pageid
vlab_platform → platform
```

An empty canonical param does not shadow a legacy one — `firstNonEmpty` skips empties because an empty-string identity would become a poisoned cache key downstream.

### Translator functions (pure)

`lib/generic-translator.js` exports:

- **`identityParams(ctx)`** — Extracts the conversation triple as query params from context. Returns `{ params, missing }` with missing component names. Logs nothing by itself; the caller decides whether to warn.
- **`splitDestination(destination)`** — Parses a `tel:`, `mailto:`, `sms:`, or `https:` destination into `{ url, protocol }`.
- **`buildServiceUrl(base, params)`** — Constructs `base?param1=val1&param2=val2`.
- **`buildLinkTrackingUrl(base, destination, ctx)`** — Full pipeline: splits destination, stamps identity, builds final URL.
- **`buildMoviehouseUrl(base, videoId, ctx)`** — Full pipeline: stamps identity, builds final URL with `videoId`.

The impure shell is **`serviceBase(envVar, fieldType, ref)`** — reads the env var, validates it has a scheme, throws with tags `[MISSING_SERVICE_URL]` or `[INVALID_SERVICE_URL]` if not, returns the base.

All identity extraction and URL building is pure. The log tag for incomplete identity (missing participant, account, or platform) is **`[FIRST_PARTY_URL_INCOMPLETE] type=<field_type> ref=<field_ref> missing components: <names>`** — a warn, never throws.

### Unchanged: validator and machine.js wiring

`replybot/lib/generic-validator.js` has `link_tracking` and `moviehouse` entries mapped to `validateStatement` — these are **not optional**. The field type promotion in `addCustomType` (form.js) promotes them exactly like webview, and `machine.js:1119` calls `validator()` with the promoted type.

Semantics of `keepMoving` / `wait` / `responseMessage` are preserved EXACTLY: the translator spreads `...md` into the message metadata first, and `machine.js` reads those by name off the metadata (`md.keepMoving`, `md.wait`), never by field type.

### Raw webviews are untouched

A hand-authored `webview` field is sent exactly as the researcher wrote it — no host matching, no decoration, byte-identical output, even when it points at one of our own hosts:

```json
{
  "type": "webview",
  "url": "https://asiapacific.unwomen.org/en/countries/india",
  "buttonText": "Visit UN Women",
  "extensions": false,
  "keepMoving": true
}
```

To get tracking on a link to our own host, the researcher changes the field's `type` to `link_tracking` or `moviehouse`.

### Production hostnames

- `links.vlab.digital` → 302 redirect, working. This is the production linksniffer host and matches `linksniffer.ingress.hosts[0].host`.
- `staging.links.vlab.digital` → 200 (staging linksniffer).
- `virtuallab-videos.netlify.app` → 200 (production moviehouse). `staging--virtuallab-videos.netlify.app` → 200 (staging).
- `gbvlinks.nandan.cloud` → dead. TLS fails (no Ingress claims the hostname, nginx serves the ingress controller's self-signed certificate); carries 193 stored fields.
- `virtuallab-videos.netlify.com` → dead. 404 (`.netlify.com` alias, retired); carries 490 stored fields.

## WhatsApp Entry Points

WhatsApp conversations are initiated via three distinct paths, all reaching the same referral-based survey start logic in `machine.js`:

### Entry Point 1: Click-to-WhatsApp (CTWA) Referral Object

Production path for ad-driven conversions. User clicks a Click-to-WhatsApp ad or promotional link that includes a referral object.

**Flow:**
1. User clicks a CTWA ad (configured on Meta's Ad Manager, or a direct click-to-WhatsApp link with referral data)
2. User's first inbound message arrives at Hermes (`POST /whatsapp`, `handlers.rs:handle_whatsapp()`) with `messages[].referral: { source, source_id, ctwa_clid, headline, body, ... }`
3. Hermes stamps with `source: "whatsapp"` and `phone_number_id` (`event.rs:stamp_whatsapp_event()`), publishes raw event to Kafka unchanged
4. Replybot's event-normalizer (`categorizeWhatsAppEvent`) recognizes `data.referral`
5. If the referral has no usable `ref`, `_refFromText(data)` derives one from the ad's autofill text on `text.body`; the rest of the referral object is preserved unmutated
6. Returns `event_type: 'conversation_started'`, `payload.referral: data.referral`
7. `getMetadata()` (`typewheels/utils.js`) extracts the form shortcode and all sibling `key.value` pairs from `payload.referral.ref` via `_group()`
8. Machine's REFERRAL case resolves survey by shortcode via formcentral
9. Survey starts with no-retake enforcement

**Referral object structure (from Meta webhook):**
```javascript
{
  "source": "ads",                      // "ads", "message", "id_matching", etc.
  "source_id": "ad_campaign_123",       // Campaign or source identifier
  "ctwa_clid": "click_to_whatsapp_id",  // Click tracking ID
  "headline": "ad headline text",       // Ad creative headline
  "body": "ad body text"                // Ad creative body
  // NOTE: no "ref". Every field above is Meta-assigned. `ref` appears in a
  // single Meta doc with no explanation of how to set it, and nobody has
  // confirmed it can be — so in practice CTWA arrivals carry none.
}
```

**Metadata does reach `md`, via the autofill message — not via the referral
object.** Because the referral carries no `ref`, the ad's `autofill_message`
(which prefills the user's first message body) is the actual carrier: the same
dot-separated `key.value` token list the `wa.me` path uses arrives on
`text.body`, and `_refFromText` recovers it. A real ad reading
`ctwaprobe.alpha.creative.Ad1H.form.probetest` yields
`{ form: 'probetest', ctwaprobe: 'alpha', creative: 'Ad1H' }` in `md`.

The important caveat is **where the targeting is authored**: per ad *creative*,
not per click. N targeting cells means N creatives, unlike Messenger where one
ad backs unlimited `m.me?ref=` variants. The Meta-assigned fields (`source_id`,
`ctwa_clid`, `headline`, `body`) are still preserved on the raw event but not
mapped into `md`.

An explicit `referral.ref`, if one ever arrives, **wins** over the text.

**Key:** The referral object is a Meta-level webhook field; it comes ONLY from CTWA ads or explicit Meta referral links, not from plain wa.me links or manual user typing.

### Entry Point 2: Bare-Text Reference Token

Fallback path for testing and direct wa.me links. Any plain text message matching a specific pattern triggers survey entry.

**Pattern:** Message body (trimmed) must exactly match `WHATSAPP_ENTRY_REF`
(`lib/event-normalizer.js`), case-insensitive:

```js
/^(?:start\s+)?((?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)*)form\.([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)$/i
```

Capture groups are leading `key.value` pairs / shortcode / trailing tokens.
`_refFromText()` reassembles them and is the **single shared helper** for both
WhatsApp text entry paths — this bare-text one and the CTWA autofill recovery in
Entry Point 1 — so the two cannot drift apart.

- Valid: `form.flysmoke`, `FORM.FLYSMOKE`, `start form.myform`, ` form.flysmoke ` (surrounding whitespace is trimmed before matching)
- Valid with metadata (since v0.0.217): `form.flysmoke.creative.3b.gender.men` → `md` gets `creative`/`gender`, matching `m.me?ref=` on Messenger
- Valid with the form pair **anywhere** in the list (since v0.0.219): `creative.3b.gender.men.form.flysmoke` resolves identically
- Invalid: `tell me form.flysmoke` (extra text—no match), `form.` (no shortcode)
- Invalid: `creative.form.ABC` — see the even-boundary rule below

Only the literal `form` token is lowercased, wherever it sits in the list; the
shortcode and all metadata tokens keep the case as typed. An odd token count
(`form.ABC.creative`) matches deliberately — `_group` leaves the dangling key
`undefined` rather than throwing, so the survey still starts.

**Order-independence and the even-boundary rule (v0.0.219).** The `form` pair no
longer has to come first, which is what `_group` always implied and what
Messenger's production refs have always looked like
(`creative.3b.gender.men.form.hpvintrotriple`). It must, however, *begin on an
even token boundary*: `_group` pairs tokens two at a time, so a `form` token
landing in a value slot resolves to no form at all (`creative.form.ABC` groups
to `{ creative: 'form', ABC: undefined }`). The leading `(?:key\.value\.)*`
group enforces that, and such a message is deliberately left as `user_text`
rather than synthesized into a referral that could only resolve to
`FALLBACK_FORM`.

Before v0.0.219 the pattern was anchored on a leading `form.`, which silently
dropped every form-last ref to `FALLBACK_FORM` — a live survey owned by another
researcher, so the misroute looked like a completion. Reproduced live on
2026-08-16 against `replybot-v0.0.218`; see
`documentation/referral-form-resolution.md` § "CTWA autofill order-independence".

**Encoding caveat for link authors:** raw `&` and `#` inside a `wa.me?text=`
value silently truncate the prefilled message. Percent-encode them (`%26`, `%23`)
if a targeting value could ever contain one.

**Flow:**
1. User sends plain text via wa.me link (e.g., `https://wa.me/1023456789?text=form.flysmoke`), manual SMS-like typing, or smoke testing
2. Inbound message arrives with `messages[].text.body = "form.flysmoke"` and NO `referral` field
3. Hermes stamps and publishes raw event to Kafka
4. Replybot's event-normalizer (`categorizeWhatsAppEvent` → `_refFromText`) tests the text against `WHATSAPP_ENTRY_REF` when no referral is present
5. On match, **synthesizes** `event_type: 'conversation_started'`, `payload.referral: { ref: "<whole matched ref>" }`
6. `getMetadata()` extracts the form shortcode and metadata pairs from the synthesized referral
7. Machine's REFERRAL case processes identically to CTWA referral path
8. Survey starts with no-retake enforcement

**Why strict full-match:** Prevents mid-survey user replies from accidentally
re-triggering a survey entry. An existing user answering a question must not be
interrupted if their answer happens to mention "form.myform". The pattern is
anchored `^…$` with no `m` flag, and every token is `[A-Za-z0-9_-]+` separated by
literal dots — so **no whitespace can appear anywhere inside the token list**
(the only whitespace admitted is the optional leading `start `). Any surrounding
prose forces a space into a position where only a token character or `.` is
legal, and the match fails. This holds for form-last refs too:
`I already did creative.x.form.abc yesterday` stays `user_text`.

**Shortcode extraction and case:**
- The pattern's three groups are leading pairs / shortcode / trailing tokens; `_refFromText` re-emits them with the literal `form` token lowercased
- The shortcode and every metadata token are preserved exactly as typed
- `FORM.MyForm` → ref becomes `form.MyForm`
- `Creative.X.FORM.MyForm` → ref becomes `Creative.X.form.MyForm`
- The whole ref body is returned; key/value parsing belongs to `getMetadata()`/`_group()` and is not duplicated in the normalizer

**e2e-tested paths** — `lib/event-normalizer.test.js`, describes "bare-text form
ref entry (wa.me links, smoke tests)", "Messenger-parity metadata", "form pair in
any position (order-independent)", "mid-survey free text never re-triggers
entry", "CTWA referral without a ref", and the end-to-end "WhatsApp entry text →
md.form":
- `form.<shortcode>` typed manually or via wa.me?text= prefill
- `start form.<shortcode>` (user explicitly says "start")
- Form pair leading, trailing, and mid-list, including the live CTWA case `ctwaprobe.alpha.creative.Ad1H.form.probetest`
- Case-insensitive regex but case-preserving shortcode (user types FORM.MYFORM or Form.MyForm)
- Whitespace tolerance (leading/trailing spaces stripped before matching)
- Underscore and hyphen in shortcode allowed
- Rejects mid-text refs, form-first and form-last
- Rejects bare `form.` without shortcode, and `creative.form.ABC` (odd token boundary)

The end-to-end describe is the one that matters most: it drives **raw**
hermes-shaped webhooks through `parseEvent` into `getMetadata` and asserts the
resolved `md.form`, rather than only asserting that the regex matched.
(`lib/typewheels/events.test.js` is a fixtures module of already-normalized
events, so it cannot exercise normalization.)

### Entry Point 3: Pre-Normalized UniversalEvent (/synthetic)

Staging and testing path. No Meta webhook required; inject a fully-formed UniversalEvent directly.

**Flow:**
1. POST a pre-normalized UniversalEvent JSON to `POST /synthetic` (`hermes/src/handlers.rs:handle_synthetic()`)
2. Event includes `source.type: 'whatsapp'`, `event_type: 'conversation_started'`, `payload.referral.ref: "form.<SHORTCODE>"`
3. Hermes publishes to Kafka as-is (no re-parsing needed; `parseEvent` recognizes pre-formed events with `event_type` field)
4. Replybot consumes and routes to REFERRAL handler
5. Machine calls `getForm` with WhatsApp account_id and shortcode
6. Survey starts

**Example payload:**
```json
{
  "event_id": "evt_test_001",
  "user_id": "27123456789",
  "timestamp": 1721678400000,
  "source": { "type": "whatsapp", "account_id": "1023456789" },
  "event_type": "conversation_started",
  "payload": {
    "type": "conversation_started",
    "trigger": "referral",
    "referral": { "ref": "form.testform" }
  },
  "raw": {}
}
```

**Use case:** Repeatable testing without Meta webhook setup or CTWA ad configuration.

### Non-Entry: Plain Text Not Matching Reference Pattern

A WhatsApp user sending plain text that does NOT match the form ref pattern (e.g., "hi", "help", "how do I join") with no referral object:
- Normalizes as `event_type: 'user_text'` (`categorizeWhatsAppEvent`, text branch)
- Machine's TEXT handler finds no active conversation and ignores the message (no-op)
- User receives no bot reply

This is intentional: WhatsApp is a customer-service platform, not a broadcast tool. Users must explicitly request a survey via an entry point (CTWA ad, form-ref link, or /synthetic), not stumble into one via casual text. Unlike Messenger (which has a "Get Started" button offering opt-in), WhatsApp conversations are always user-initiated and require explicit entry.

### Metadata Extraction (`getMetadata` in `typewheels/utils.js`)

All three entry paths converge on the same `getMetadata(event)` function:
- Only `event_type: 'conversation_started'` events extract metadata
- Parses the `referral.ref` string by splitting on `.` and grouping pairs via `_group()`
- `_group()` is **order-independent** — it pairs tokens two at a time from index 0, so the `form` pair can sit anywhere in the list as long as it starts on an even boundary
- **Messenger example:** `creative.x.gender.men.form.ABC` → `{ creative: "x", gender: "men", form: "ABC" }`
- **WhatsApp CTWA example:** ref recovered from the ad's autofill text — `ctwaprobe.alpha.creative.Ad1H.form.probetest` → `{ ctwaprobe: "alpha", creative: "Ad1H", form: "probetest" }` (the Meta-assigned referral fields are still not mapped)
- **WhatsApp bare-text example:** synthesized as `{ ref: "creative.x.form.ABC123" }` → `{ creative: "x", form: "ABC123" }`

**Platform tracking:** `md.platform = eventPlatform(event)` persists `'messenger'` or `'whatsapp'` with the conversation state, so synthetic re-entry events (dean timeouts, follow-ups) recover the correct platform.

### Testing

`npm test` runs the full mocha suite via the quoted glob `'lib/**/*.test.js'`
(mocha expands it; unquoted, the shell would skip top-level `lib/*.test.js`
files like `event-normalizer.test.js` and `generic-translator.test.js`).
Test fixtures for UniversalEvents live in `lib/typewheels/events.test.js` and
must mirror the normalizer's real output shapes.

(The former chat-log publisher — `lib/chat-log/publisher.js` and
`VLAB_CHAT_LOG_TOPIC` — was removed with the platform abstraction; see
`documentation/chat-message-logging.md`.)
