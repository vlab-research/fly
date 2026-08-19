# The event envelope

Every event on the `chat-events` topic carries the identity of the conversation it
belongs to, as two normalized top-level fields. This document is the contract: what the
fields mean, who produces them, who consumes them, and what a missing one means.

`chat-events` has **two live producers**, not one. Hermes is the only *ingester*, and that
much is true of **every live environment** without qualification: it serves `/webhooks`,
`/whatsapp`, `/synthetic` and `/health`, `botserver.enabled: false` in both
`devops/values/production.yaml` and `devops/values/staging.yaml`, and every `BOTSERVER_URL`
in both clusters points at `http://gbv-hermes/synthetic`. But being the only ingester is not
the same as being the only producer, and conflating the two has already cost one bug. See
[Producers](#producers) before assuming an event was stamped upstream.

---

## Producers

| Producer | Writes | Stamps the envelope | Deployed |
|---|---|---|---|
| **hermes** | every ingested webhook and `/synthetic` POST | yes, all three shapes | **live** — `vprod` + `vstag` |
| **message-worker** | the WhatsApp send echo only | yes, since 2026-08-17 | **live** — `vprod` + `vstag` |
| botserver | every ingested webhook and `/synthetic` POST | **no, and never did** | **nowhere** — disabled in both live environments; enabled only in undeployed config |

Produce sites: `hermes/src/handlers.rs` via `producer.rs`; `message-worker/worker.go`
`emitWhatsAppEcho` → `kafka.go`; `botserver/server/handlers.js`.

**Producers are not the same set as posters.** The seven services that POST to `/synthetic`
are *upstream* of hermes, not producers of `chat-events` themselves — but they are equally
bound by the envelope, because hermes can only stamp what they send. Auditing one set does
not audit the other: see [The posters](#the-posters), and in particular the note on
`moviehouse`, which is invisible to every config-derived enumeration in this document.

### message-worker is a direct producer, and it bypasses hermes

WhatsApp has no native echo webhook (unlike Messenger's `is_echo`), so after a successful
WhatsApp send message-worker publishes a `bot_echo` event itself — the event that advances
replybot's state machine `RESPONDING → QOUT`. It goes **straight to `KAFKA_EVENT_TOPIC`**
(`message-worker/config.go`, default `chat-events`, wired to the `chatTopic` anchor in every
values file), so nothing upstream derives its identity. message-worker stamps `account_id`
and `platform` itself, from `cmd.PlatformAccountID` and the WhatsApp branch it is already
inside — no inference is involved. It retains `phone_number_id` alongside them, per
[Nothing was removed](#nothing-was-removed).

Until 2026-08-17 it stamped neither. Every WhatsApp send therefore archived a `messages`
row with a NULL `account_id`, and because the replay query's temporary
`AND (account_id = $2 OR account_id IS NULL)` clause exists to keep **historical**
un-backfilled rows replaying, each NULL row matched *every* account and leaked across all of
a participant's conversations. The fix is one field; the guard below is the part that
generalises.

### The producer-side guard

`message-worker/kafka.go` funnels `PublishEvent` **and** `PublishRawEvent` through a single
`publish()`, which checks the envelope before anything reaches the topic. Both doors, one
check — a future direct producer inside that service is covered whether or not its author
knows the guard exists.

The check inspects the **serialized bytes**, not a typed struct
(`message-worker/envelope.go` `MissingEnvelopeFields`, pure and total). That is what makes
it shape-agnostic: it holds for the replybot-shaped echo, for `types.UniversalEvent`, and
for shapes not yet written. A field counts as present only when it is a **non-empty JSON
string** — the same rule hermes applies when stamping and replybot's `identityComponent`
applies when reading. Two real shapes fail it in ways a presence check would pass: an empty
string, and `types.UniversalEvent`, whose `platform` is the object
`{"type":…,"account_id":…}` with no top-level `account_id` at all.

| `STRICT_EVENT_ENVELOPE` | Behaviour |
|---|---|
| absent or false (default) | log `CHAT_EVENTS_ENVELOPE_MISSING` at `Error`, publish anyway |
| true | log, then refuse to publish |

Like `SYNTHETIC_REQUIRE_CONVERSATION`, it is declared explicitly as `"false"` in both
`devops/values/production.yaml` and `devops/values/staging.yaml` rather than left to
`config.go`'s default, so turning it on is a reviewable committed diff plus a rollout
restart — never a `kubectl set env` against live state.

**Reporting is the default on purpose, and the reason is not timidity.** A refusal cannot
break message *delivery* — the message is sent before the echo is emitted, and the echo's
error is already swallowed at the call site — but it does drop the echo, and the echo is the
only thing that advances a WhatsApp conversation. Refusing stalls every WhatsApp survey;
publishing unstamped degrades replybot to an unscoped replay, which still advances the
conversation. Degraded-but-moving beats stopped for a producer bug a human has to fix
anyway. Strict mode is for staging, and for production once the tag reads zero.

The log line carries the Kafka key, the topic and which fields are missing — never the
body, which holds participant message content.

### botserver stamps nothing — and runs nowhere

botserver only ever set `source` and `timestamp`; closing that gap is why hermes exists. It
is `enabled: false` in **both** live environments, so no live event is unstamped for this
reason and "hermes is the single ingester" needs no qualification.

It is listed above anyway, because it is a real producer that really does not stamp, and one
committed file still turns it on: `devops/values/integrations/fly.yaml` deploys **no hermes
block at all** and sets no `botserver.enabled`, against a chart default of `true`
(`devops/vlab/values.yaml`).

**That file is dead config, not an environment.** No CI workflow references it; its only
consumer is `devops/scripts/bootstrap-fly.sh`, the sole kind-related script in the repo; the
cluster has exactly two namespaces, `vprod` and `vstag`, with no `fly` namespace and one
kube context.

It has deliberately **not** been migrated to hermes — that is work spent on something nobody
runs — but it is now labelled, in both the values file and the bootstrap script. The trap it
sets is specific and worth naming: bootstrap a local cluster to test conversation identity,
land in an environment where nothing stamps the envelope, watch every state read fall back
to an unscoped replay and two accounts bleed into each other, and conclude the fix does not
work. Reviving it means swapping the `botserver:` block for a `hermes:` one — a drop-in
replacement on the same service alias and the same paths, so the `http://fly-botserver/*`
URLs need no change.

The `facebot/testrunner` harness is **not** a producer: it creates the topic and consumes
it, and runs the *hermes* image under the `botserver` network alias, so its producer set
matches production.

`REPLYBOT_EVENT_TOPIC` is set to the chat topic in every values file and is **read by zero
lines of replybot source** — vestigial. replybot's relationship to `chat-events` is
consumer-only, via `BOTSPINE_MESSAGE_TOPIC`; it produces to the state, response, payment and
commands topics only.

---

## The two fields

```jsonc
{
  ...everything the shape already carried, unchanged...,
  "account_id": "<account>",              // the messaging account this event belongs to
  "platform":   "messenger" | "whatsapp"  // the conversation's transport
}
```

A conversation is identified by the triple `(platform, account_id, user_id)`, not by the
user alone. A Messenger PSID is page-scoped in theory but demonstrably not in practice,
and a WhatsApp `wa_id` is the participant's phone number — identical across every
business number they message. Every platform we add next (SMS, Telegram, RCS, email)
identifies the user by a global address, so this is the general case, not a WhatsApp
special case.

The **Kafka key is unchanged** — it remains the user id, so a participant's events still
partition together and stay ordered. Only the message body changed.

### `source` is not `platform`

Both fields exist and both stay. They are not synonyms.

| Field | Answers | Values |
|---|---|---|
| `source` | where the event came *in from* | `messenger`, `whatsapp`, `synthetic` |
| `platform` | what transport the *conversation* runs on | `messenger`, `whatsapp` |

They differ exactly on synthetic events, and that difference is the whole reason
`platform` has to be sent explicitly rather than inferred. A payment result or a timeout
arrives with `source: "synthetic"`, which says nothing about whether the participant is
reachable on Messenger or WhatsApp. `platform` is **never** `"synthetic"`.

### Nothing was removed

`phone_number_id`, `page`, `recipient.id` and `sender.id` all keep their names and
meanings. That is deliberate: the `messages` backfill reads the account out of historical
`messages.content` under those per-shape names, so keeping them means old and new rows
share one extraction path instead of needing two.

---

## Derivation

Hermes derives both fields at ingest, per shape.

| Shape | `account_id` | `platform` |
|---|---|---|
| Messenger | `sender.id` if `message.is_echo` else `recipient.id` | `"messenger"` |
| WhatsApp | `phone_number_id` | `"whatsapp"` |
| Synthetic | the POSTed `account_id`, else `page` (deprecated alias) | the POSTed `platform` |

On Messenger and WhatsApp hermes derives with certainty. On synthetic events it cannot —
so the poster must supply them, and that is a required part of the `/synthetic` contract
rather than an optional extra.

**A field is stamped only when it derives to a non-empty string.** Absent is safe: the
state-cache consumer treats a missing component as "do not touch the cache" and replays
from the event log. An empty string would be a poisoned key, which is not safe. A
conversation is never keyed under a name that could not be verified.

`platform` is stamped unconditionally on Messenger and WhatsApp, independently of whether
`account_id` derives — the transport is known there regardless.

### The echo inversion

An echo is a message the **page** sent, so the roles invert: the page is the `sender` and
the participant is the `recipient`. This one rule is the only logic in the envelope work
that exists in two languages — Rust in `hermes/src/event.rs`, JavaScript in
`replybot/lib/event-normalizer.js` `parseMessengerEvent`.

It is therefore pinned by a **shared cross-language fixture** rather than by independent
unit tests on each side that could drift:

```
testdata/event-envelope/messenger-account-derivation.json
```

Both suites load that one file — `hermes/src/event.rs` via `include_str!`,
`replybot/lib/event-normalizer.test.js` via `require`. Each vector pins `user_id`,
`account_id` and `platform` together, because `get_user_from_event` and
`parseMessengerEvent` implement the *same* inversion and both halves have to agree.

The fixture lives at the repo root because the rule is jointly owned; putting it inside
either service would make the other's test a cross-service reach-in. It is safe there
despite the per-service Docker build contexts: hermes' loader sits in a `#[cfg(test)]`
module that `cargo build --release` never compiles, and `replybot/Dockerfile` does not run
tests.

---

## The `/synthetic` contract

```jsonc
POST /synthetic
Headers: X-Vlab-Poster: <service name>
{
  "user":       "<user_id>",              // required
  "account_id": "<account_id>",           // required; `page` accepted as a deprecated alias
  "platform":   "messenger" | "whatsapp", // required
  "event":      { "type": "...", "value": ... }
}
```

Hermes passes unknown fields through untouched, so a poster may carry extra fields.

### The posters

**Seven services post synthetic events, and only six of them can be found by grepping
`BOTSERVER_URL` in `devops/values/production.yaml`.** That grep is the enumeration method
this document used to prescribe, and it is incomplete by construction — see the note on
moviehouse below.

| Poster | Event types | Sends the triple |
|---|---|---|
| `dean` | `redo`, `timeout`, `repeat_payment`, `follow_up`, `block_user` | yes |
| `dinersclub` | `external` (payment results) | yes |
| `message-worker` | `machine_report` (on every send failure) | yes |
| `replybot` | `machine_report` (on every report) | yes |
| `linksniffer` | `external` (`linksniffer:click`) | yes — but `platform` is *assumed* when absent, see below |
| `exodus` | `bailout` | yes — but conditions-based bails send an *assumed* platform, see below |
| **`moviehouse`** | `external` (`moviehouse:play`, `:pause`, `:ended`, `:seeked`, `:volumechange`, `:playbackratechange`, `:error`, **`:heartbeat` every 30s**) | yes — and `platform` is **omitted rather than assumed** when absent, see below |

`replybot` and `message-worker` are the highest-volume producers by a wide margin — one
posts on every report, the other on every send failure. **`moviehouse` is the highest
frequency *per participant*:** a heartbeat every 30 seconds for the duration of a video.

**Three of the seven send, or decline to send, a platform they cannot actually know.**
`dean`, `dinersclub`, `message-worker` and `replybot` all have the conversation's real
platform at the call site. `linksniffer`, `exodus` and `moviehouse` do not always.
linksniffer and exodus fill the gap with `messenger`; moviehouse leaves it out. The
*assumed* case is invisible to any check that only asks whether the field is *present*.
Nothing catches it today. The *omitted* case is visible to `[INCOMPLETE_CONVERSATION]`,
which is the point of choosing it.

### moviehouse is a producer, and a `BOTSERVER_URL` grep cannot see it

**Record this, because it is how the seventh poster went unnoticed while six were being
fixed.** `moviehouse` is a **browser page**, deployed from **Netlify**, not a cluster
service. It has no `BOTSERVER_URL`, no Deployment, and no entry in any values file: its
endpoint is `SERVER_URL` in `moviehouse/netlify.toml`
(`https://fly-botserver.vlab.digital/synthetic` — hermes' reused hostname),
mustache-substituted into `moviehouse/src/script.js` at build time. Enumerating producers
from cluster config is therefore structurally incomplete, and any future audit of the
producer set must include `moviehouse/` explicitly.

Its consequences before the fix were not merely untidy. Every moviehouse event bypassed the
state cache and triggered a full replay — every 30 seconds, per watcher — and, because
`transition.js` falls back to `eventPlatform`'s hard `'messenger'` default, a moviehouse
event on a **WhatsApp** conversation built outbound commands for the wrong platform. Video
events are conversation-advancing (a field can `WAIT_EXTERNAL_EVENT` on `moviehouse:play`),
so that was a correctness bug, not lost analytics.

### moviehouse omits an absent platform rather than assuming one

moviehouse receives its params from replybot, which builds the entire URL for
`moviehouse` field types. Replybot is the sole authority on the URL (`moviehouse/src/identity.js`
documents the contract). It posts `user`, `account_id`, `page` (retained alias) and
`platform`, preferring `account_id` over its legacy `pageId`.

Where it **diverges from linksniffer deliberately**: an absent or invalid `platform` is left
out of the body, logged `[MOVIEHOUSE_CONVERSATION_INCOMPLETE]` /
`[MOVIEHOUSE_PLATFORM_INVALID]` in the browser console. It does not assume `messenger`.

| | linksniffer | moviehouse |
|---|---|---|
| absent `platform` | assume `messenger`, log `[LINKSNIFFER_PLATFORM_ASSUMED]` | **omit**, log `[MOVIEHOUSE_CONVERSATION_INCOMPLETE]` |
| invalid `platform` | reject, then assume `messenger` | **reject, assume nothing** |
| posts per participant | one per click | one per video event **+ one every 30s** |
| counted by | a second counter that does not gate | `[INCOMPLETE_CONVERSATION]`, the existing step-3 counter |

The reasoning, in the order that decided it:

1. **Absent degrades; wrong hangs.** Per [Consumers](#consumers), an event carrying an
   account and no platform bypasses the cache *and still gets an account-scoped replay* — the
   conversation advances, just slower. A wrong platform addresses a conversation that does not
   exist, so a `wait` on `moviehouse:play` never resolves *and* the commands are built for the
   wrong transport.
2. **Volume inverts linksniffer's calculus.** A heartbeat every 30 seconds turns a one-shot
   risk into a continuous stream of mis-addressed events, and would make a second
   `*_PLATFORM_ASSUMED` counter structurally non-zero at high volume — permanently
   un-gateable.
3. **Omission is counted; assumption needs an instrument that is not built.** An absent
   platform lands on `[INCOMPLETE_CONVERSATION]` and drains to zero as surveys adopt the
   `moviehouse` field type. An assumed platform stamps cleanly and passes the gate, and
   nothing we have distinguishes it from a correct one.
4. **The gate makes omission self-limiting.** `SYNTHETIC_REQUIRE_CONVERSATION` may only be
   turned on once `[INCOMPLETE_CONVERSATION]` reads zero, and that condition *is* "no
   moviehouse event omits a platform". "Gate on **and** platform absent" is contradictory by
   construction, whereas "gate on and platform silently wrong" is the steady state an
   assumption creates.

**The migration behind it is larger than linksniffer's and it hangs rather than degrades.**
82 live surveys / 570 fields / 4 researchers (vprod, 2026-08-17), and **all 82 contain at
least one field that `wait`s on a moviehouse event** — 410 with no timeout. Unlike linksniffer,
whose WhatsApp exposure was measured as empty, **moviehouse's has already fired**: on
2026-08-13 a WhatsApp conversation's `moviehouse:play` was routed to a phantom conversation
on a hardcoded Messenger page, which is still `BLOCKED` in production. Full measurement in
`planning/moviehouse-conversation-identity.md`. Two legacy hosts are now dead: `virtuallab-videos.netlify.com`
(returns 404, carries **86% of the field corpus**, 490 fields) and `gbvlinks.nandan.cloud`
(linksniffer legacy host, TLS fails, 193 tracked-link fields).

`botparty.ExternalEvent` lives in a **separate repo** and has no `Platform` field. Rather
than publish and bump it across two services, `dinersclub` and `message-worker` each
declare a local struct and a local sender, which is what `dean` already did. Hermes passes
the extra field through, so a local struct is sufficient and needs no coordination.

### linksniffer sends the triple, but assumes the platform on legacy links

`linksniffer/server.go` reads its params from **researcher-authored query parameters** — the
survey's webview `url` object, documented in `documentation/questions.md` under "Links". It
now reads `account_id` in preference to the legacy `pageid`, accepts an optional `platform`,
and posts `user`, `account_id`, `page` (retained alias) and `platform`. It remains a
stateless forwarder with no database.

Two paths produce those params, and only one of them is trustworthy:

| Path | `platform` | Correct? |
|---|---|---|
| a `link_tracking` field — replybot builds the whole URL and writes `vlab_user`, `vlab_account` and `vlab_platform` from the conversation | from `ctx.platform` | always |
| legacy hand-authored params | **absent → assumed `messenger`** | only if the survey is Messenger |

The assumption is logged as `[LINKSNIFFER_PLATFORM_ASSUMED]` and is deliberate, temporary and
*measured*. It is not a new guess — `replybot/lib/typewheels/utils.js:72` already hard-returns
`'messenger'` for a synthetic event with no platform hint. Moving the guess to the edge makes
it explicit, single-located and countable rather than silent and deep in the pipeline.

A researcher-supplied `platform` that is not a known transport is rejected rather than
forwarded (`[LINKSNIFFER_PLATFORM_INVALID]`, then assumed `messenger`), because the value
becomes a component of the conversation identity downstream and a typo would otherwise
become a poisoned cache key.

**The residual risk is WhatsApp.** `webview` is not Messenger-only — WhatsApp renders it as a
`cta_url` interactive message, ~8% of production participants hit a webview, and
`documentation/platform-abstraction.md` states that `tel:`/`mailto:`/`sms:` destinations are
*expected* to route through linksniffer's `p` param. So a WhatsApp survey with hand-authored
link params will post `platform: "messenger"` for a WhatsApp conversation.

**What used to absorb a wrong hint is gone.** Before §7.1, `transition.js` preferred
`state.md.platform` over the event's hint, so a mis-stamped `linksniffer:click` was silently
corrected downstream. **§7.1 deleted that preference** — recovering any component of the
conversation from `state.md` is exactly the bug it fixes — and the state cache is now keyed
`state:{platform}:{account_id}:{user}` from the *envelope*, with the lookup happening **before**
`transition.js` runs. So a wrong `platform` addresses a conversation that does not exist, and
the `wait` on `linksniffer:click` never resolves. The assumption did not become risky at §7.1;
it became **load-bearing**, because nothing downstream corrects it any more.

**What makes it safe today is measurement, not a fallback.** Per
`planning/whatsapp-webview-exposure.md` (production, 2026-08-17): all WhatsApp traffic that has
ever existed is **4 conversations**, on 3 shortcodes, and **none of those shortcodes contains a
webview field**. Of 84 live webview surveys on WhatsApp-capable accounts, **0** have ever been
served on a WhatsApp account, and **0 of 1007** live webview fields repo-wide author a
`platform` param. The intersection of "runs on WhatsApp" and "has a hand-authored tracked link"
is empty — today.

**Migrating WhatsApp surveys to the `link_tracking` field type is therefore a prerequisite for
§7.1's safety margin, not merely for the gate.** Size: **104 live surveys / 346 fields / 7 researchers**, of
which **13 surveys / 16 fields `wait` on `linksniffer:click`** and therefore **hang** rather
than degrade when a click is misrouted. The trigger is a researcher running one of those
surveys on a WhatsApp account — `wazzii` / `both` / `tuki` are the most active of them (243 /
224 / 197 participants) and are Messenger-only in practice so far.

### exodus sends a platform on both paths — but assumes it on one

`exodus/sender` carries `Platform` on `UserTarget` and posts `account_id`, `page` and
`platform`. `user_list` bails supply the platform explicitly per entry and are exact.

Conditions-based bails read their targets from `states`, and `exodus/query/builder.go:82` now
selects `COALESCE(s.platform, 'messenger') AS platform`. So they are **compliant with the
contract** — the field is always populated and they will not 400 once the gate is on — but the
value is an **assumption** on most rows: `states.platform` is a computed column over
`state_json->'md'->>'platform'` and is **NULL for 97.8% of rows**, so the default is
load-bearing rather than cosmetic.

Two details worth keeping:

- **The `AS platform` alias is required, not cosmetic.** `exodus/executor/executor.go` looks the
  value up as `row["platform"]`; an unaliased `COALESCE` lands under the key `"coalesce"`, the
  lookup misses, and the platform silently stays empty.
- **`COALESCE`, not a bare `s.platform`.** A bare column would leave pre-persistence targets
  with an empty platform *and* log `Invalid platform type in query result: <nil>` once per
  target. The default is safe in the direction that matters: a `states` row on a
  `whatsapp_business` account always carries `platform='whatsapp'`, so NULL means the row
  predates the persistence, which means Messenger.

An earlier revision of this section said conditions-based bails "do not yet select
`s.platform`" and therefore "would 400 once the gate is on." That was true when written and is
no longer; the residual issue is an *assumed* platform, which no current check can see.

---

## Rejecting an incomplete synthetic event

A synthetic event without a platform cannot be attributed to a conversation, so accepting
it silently reproduces the bug the envelope exists to prevent. Hermes therefore rejects an
incomplete `/synthetic` POST with **400**, logging the poster's identity so the culprit is
findable.

A missing `user` is **always** a 400 — it was already unconditionally rejected, and 400
rather than 500 says truthfully that the request was malformed, not that hermes failed.

A missing `account_id` or `platform` is 400 **only when the gate is on**:

| `SYNTHETIC_REQUIRE_CONVERSATION` | Behaviour |
|---|---|
| absent, or anything but `true`/`1` (default) | accept, stamp what derives, log the gap |
| `true` or `1` (case-insensitive) | 400, produce nothing |

The variable is declared explicitly as `"false"` in both `devops/values/production.yaml`
and `devops/values/staging.yaml`, so turning it on is an edit to a committed file plus a
rollout restart — never a `kubectl set env` against live state.

### Rollout order is not optional

1. hermes accepts-but-does-not-require, and stamps what it can
2. every poster ships the triple
3. confirm zero events lacking a component
4. hermes turns on the 400

Turning the 400 on before step 2 completes 400s in-flight posters mid-deploy. Because
`message-worker` posts on every send failure and `replybot` on every report, the blast
radius is the entire error-reporting path — the mechanism that drives a stuck conversation
into `ERROR` where a sweep can retry it — not an edge case.

**All seven posters now send the triple where they can determine it.** `linksniffer` always
sends a `platform`, and `exodus` conditions-based bails now send
`COALESCE(s.platform, 'messenger')` (`exodus/query/builder.go:82`).

**But step 3's counter is not yet zero, and `moviehouse` is why.** It deliberately omits a
platform it cannot determine, so every event from a survey that has not adopted the
`moviehouse` field type increments `[INCOMPLETE_CONVERSATION]` — at one heartbeat every 30 seconds
per watcher. That is the intended, countable behaviour, not a regression: **the counter is
the migration's progress bar.** Step 4 is blocked on the survey migration, not on a code
change. Turning the 400 on before that migration completes would reject every moviehouse
event and kill video tracking outright.

Note the ordering hazard specific to moviehouse: it deploys from **Netlify**, on a different
track from every cluster service, so "all posters shipped" is not a single rollout event. See
`moviehouse/README.md` § Deployment.

**What blocks step 4 is the thing step 3 cannot measure.** Two posters send a platform that is
*populated but assumed*, so they pass a presence check while possibly carrying the wrong
conversation identity:

1. **`[LINKSNIFFER_PLATFORM_ASSUMED]` must also read zero** — a tracked-link click that assumes
   `messenger` passes the gate, so the gate's own counter cannot see it. Counting only
   `[INCOMPLETE_CONVERSATION]` would declare the rollout safe while WhatsApp webview links were
   still mis-attributed. Closing this is the `link_tracking` survey migration, not a code
   change.
2. **exodus's `COALESCE` default applies to 97.8% of rows**, so the great majority of
   conditions-based bails carry an assumed platform. Nothing counts that today.

Neither is caught by a presence check, which is all we have: both send a platform, it is
just the wrong one. Detecting a present-but-wrong platform would need something that knows
which platform an account actually belongs to, and no such thing exists today.

Because `linksniffer:click` is what `wait` conditions on webview fields resolve against, a
wrong platform hangs the conversation just as surely as a rejected event does — it simply
fails later and more quietly.

### Log tags

The rollout gate is only as trustworthy as the signal it is flipped on, so "the poster did
not send it" and "hermes could not derive it" are logged distinctly. All are greppable
literal prefixes.

| Tag | Meaning | Action |
|---|---|---|
| `[NO_USER]` | `/synthetic` with no `user`. Always 400. | fix the poster |
| `[NO_CONVERSATION]` | `/synthetic` missing `account_id`/`platform`, gate **on**. 400. | fix the poster |
| `[INCOMPLETE_CONVERSATION]` | same, gate **off**. Accepted. | this is the step-3 counter |
| `[NO_CONVERSATION_MESSENGER]` | `account_id` not derivable from a Messenger webhook | malformed webhook, not a poster bug |
| `[NO_CONVERSATION_WHATSAPP]` | `phone_number_id` empty on a WhatsApp webhook | malformed webhook, not a poster bug |

Two more are emitted by **linksniffer**, not hermes, and are the reason the gate needs a
second counter:

| Tag | Meaning | Action |
|---|---|---|
| `[LINKSNIFFER_PLATFORM_ASSUMED]` | no `platform` param on a tracked link; `messenger` assumed. Includes `id` and `account`. | migrate the survey to the `link_tracking` field type — **this is the second step-3 counter** |
| `[LINKSNIFFER_PLATFORM_INVALID]` | `platform` param present but not a known transport; `messenger` assumed | fix the survey's link params |

Two are emitted by **moviehouse**, in the participant's **browser console** — so unlike
every other tag in this document they are *not* greppable in cluster logs. The server-side
counter for the same condition is `[INCOMPLETE_CONVERSATION]`, which is exactly why
moviehouse omits rather than assumes.

| Tag | Meaning | Action |
|---|---|---|
| `[MOVIEHOUSE_CONVERSATION_INCOMPLETE]` | no `account_id`/`pageId`, or no valid `platform`, on a moviehouse URL. Logged once per page load. | change the survey field's type to `moviehouse` |
| `[MOVIEHOUSE_PLATFORM_INVALID]` | `platform` present but not a known transport; **none is sent** | fix the survey's link params |

linksniffer also emits `[LINKSNIFFER_EVENT_FAILED]` when the event POST fails and
`[LINKSNIFFER_BAD_URL]` when the destination cannot be unescaped. Neither is an envelope
concern — the first is the always-redirect guarantee firing, and it means an event was
*lost*, so it is a gap in the click record rather than a mis-keyed one.

3. **`moviehouse` events from un-migrated surveys omit the platform**, which *is* counted by
   `[INCOMPLETE_CONVERSATION]` — so unlike the two above it is visible to step 3. It is listed
   here because it is the reason that counter is currently non-zero, and because the
   remediation is the same survey migration rather than a code change.

Counting `[INCOMPLETE_CONVERSATION]` **and `[LINKSNIFFER_PLATFORM_ASSUMED]`** to zero is what
licenses step 4. Note that `[INCOMPLETE_CONVERSATION]` proves only that hermes *stamped* the
fields — it does not prove they are *right* (an assumed platform stamps cleanly), nor that
they survive into `messages.content`, which is what the replay path reads.

---

## Consumers

| Consumer | Uses |
|---|---|
| replybot state cache | both, as the Redis key `state:{platform}:{account_id}:{user}` |
| `scribble/message.go` | both → `messages.account_id`, `messages.platform` |
| `messages` backfill | both, extracted from historical `content` (per-shape; see below) |
| replay (`chatbase.get()`) | `account_id`, to scope the archived log it replays |

**The two fields are read independently, not as a package.** replybot's
`conversationFromRawEvent` returns each component as "a non-empty string or null" and lets
the two consumers gate differently, because they need different things: the **cache key**
`state:{platform}:{account_id}:{user}` cannot be built without a platform, but the **replay**
`get({ userid, account }, limit)` takes no platform at all. So an event carrying an account
and no platform bypasses the cache *and still gets an account-scoped replay*. Collapsing
that case to "unknown conversation" would throw away an account the event actually carried
and fall back to an unscoped replay — which reads the **oldest** events across every account
the participant has, and so silently truncates rather than merely interleaving. See
`replybot/README.md`.

**No consumer falls back to `md`, to `source`, or to per-shape extraction.** The envelope
is the single source. That is what makes a missing field a loud, countable failure instead
of a silent mis-keying — `md.pageid` and `md.platform` are precisely the fields that bleed
between conversations, so recovering identity from them defeats the purpose.

### The archival consumer, and the one place per-shape extraction survives

`scribble/message.go` writes the envelope verbatim into `messages.content` and additionally
reads the two normalized fields into `messages.account_id` and `messages.platform`. It is
the **only** thing that makes the archive replayable per conversation: the replay path
(`replybot/lib/chatbase` `get()`) selects on `(userid, account_id)`, so an event
whose account was never recorded cannot be attributed to a conversation afterwards.

Two properties of that consumer are worth stating, because they look like violations of the
rules above and are not:

**Absence is tolerated, not rejected.** Both columns are nullable and unvalidated. Scribble
treats any write error as fatal, so a required identity would let a producer that stopped
stamping the fields crash-loop the archival sink and archive nothing at all. Instead the row
is stored and the unknown identity is recorded as `NULL` — which is *countable*, and is the
gate the backfill drains against. Loud where something can act on it; not fatal where
nothing can.

**Per-shape extraction still exists, for history only.** Rows archived before hermes stamped
the normalized fields carry the account only under its per-shape name, which is exactly why
[nothing was removed](#nothing-was-removed) from the envelope. That rule lives in
`devops/sql/messages-account-id-expr.sql` and `messages-platform-expr.sql` (used by
`devops/backfill-messages-account.sh`) and in `ConversationFromHistoricalContent` in
`scribble/account.go`. It is scoped strictly to the backfill — the forward path in the same
file reads the normalized fields and nothing else, and there is a test asserting each
per-shape field is ignored on that path.

Because the echo inversion is the load-bearing part of that rule — 28.8% of archived rows,
roughly 30M, are Messenger echoes — the SQL and the Go are both pinned to the shared
fixture, and `TestBackfillSQLMatchesGo` in `scribble/account_test.go` asserts they agree
with each other over every vector. That makes the fixture's reach four implementations:
Rust, JS, Go, and SQL.

---

## See also

- `hermes/README.md` — the ingester, its endpoints and its environment
- `message-worker/README.md` — the second producer, its echo and the envelope guard
- `replybot/README.md` — the consuming side: the three-case conversation contract
- `planning/conversation-identity.md` — why a conversation is a triple, and the full phase plan
- `planning/event-envelope-contract.md` — the implementation contract for this phase
- `documentation/platform-abstraction.md` — account-id routing and the credential model
- `linksniffer/README.md` — the tracked-link forwarder, its query params and its log tags
- `moviehouse/README.md` — the seventh poster: a Netlify-hosted browser page, its 30-second heartbeat, and why it omits an absent platform
- `documentation/questions.md` "Tracked links" / "Videos (Moviehouse)" — how a researcher authors the first-party link types
- `exodus/README.md` — the bail service and the platform gap on its query path
