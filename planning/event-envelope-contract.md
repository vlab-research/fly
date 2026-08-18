# Event envelope — the wire contract (§7.3 of `planning/conversation-identity.md`)

**Status:** implementing. This file is the single source of truth handed to every
implementation stream in this workstream. If an implementation disagrees with this
file, the implementation is wrong.

Read `planning/conversation-identity.md` §3.1, §4 and §7.3 for *why*. This file is *what*.

---

## 1. The two new fields

Every event body published to the events topic (`chat-events`) carries, **in addition to
everything it carries today**:

```jsonc
{
  ...everything existing, unchanged...,
  "account_id": "<account>",              // the messaging account this event belongs to
  "platform":   "messenger" | "whatsapp"  // the conversation's transport, NEVER "synthetic"
}
```

- **Remove nothing.** `phone_number_id`, `page`, `recipient.id`, `sender.id` all stay
  exactly where they are. §7.4's backfill reads historical `messages.content` using those
  per-shape names; dropping them would force old and new rows down different extraction
  paths.
- **The Kafka key does not change.** It stays the user id. Only the body changes.
- **`source` and `platform` are different fields and both stay.**
  `source` = where the event came *in from* (`messenger` | `whatsapp` | `synthetic`).
  `platform` = what transport the *conversation* runs on (`messenger` | `whatsapp`).
  They differ exactly on synthetic events, which is the entire reason `platform` must be
  sent explicitly rather than inferred from `source`.

## 2. Derivation, per shape, in hermes

| Shape | `account_id` | `platform` |
|---|---|---|
| Messenger | `sender.id` if `message.is_echo` else `recipient.id` | `"messenger"` |
| WhatsApp | `phone_number_id` | `"whatsapp"` |
| Synthetic | POSTed `account_id`, else POSTed `page` (deprecated alias) | POSTed `platform` |

**Stamp a field only when it derives to a non-empty string.** Never stamp `null`, never
stamp `""`. A conversation must never be keyed under a name we cannot verify — §7.1's
consumer treats an absent field as "do not touch the cache", which is safe; an empty-string
field would be a poisoned key, which is not.

`platform` is stamped unconditionally on Messenger and WhatsApp — it is known with
certainty there regardless of whether `account_id` derives.

## 3. The `/synthetic` request contract

```jsonc
POST /synthetic
Headers: X-Vlab-Poster: <service name>          // NEW, for attributing rejections
{
  "user":       "<user_id>",              // required, unchanged
  "account_id": "<account_id>",           // required; `page` accepted as deprecated alias
  "platform":   "messenger" | "whatsapp", // required -- NEW
  "event":      { "type": "...", "value": ... }
}
```

Hermes passes unknown fields through untouched, so posters may carry extra fields.

### The posters — there are SIX, not four

`planning/conversation-identity.md` §7.3.1 names four. Enumerating `BOTSERVER_URL`
across `devops/values/production.yaml` finds six services posting to `/synthetic`.

| Poster | Sends today | Change | Status |
|---|---|---|---|
| `dean/queries.go` `ExternalEvent` | `user`, `page`, `platform` | rename the JSON field `page` → `account_id` | in this phase |
| `dinersclub/main.go` `sendResult` | `user`, `page` | local struct; send `account_id` + `platform` (`pe.Platform`) | in this phase |
| `message-worker/worker.go` `reportError` | `user`, `page` | local struct; send `account_id` + `platform` (`cmd.Platform`) | in this phase |
| `replybot/lib/index.js` `publishReport` | `user`, `page` | send `account_id` + `platform` | in this phase |
| `linksniffer/eventer.go` `Send` | `user`, `page` | **cannot comply yet — see below** | BLOCKED |
| `exodus/sender/sender.go` `BailoutEvent` | `user`, `page` | needs `Platform` on `UserTarget`, from `states.platform` | deferred (other stream owns `exodus/**`) |

**linksniffer is the hard one.** `linksniffer/server.go` `forward` reads `id` and
`pageid` from **researcher-authored query parameters** — the survey's webview `url`
object, documented in `documentation/questions.md` under "Links". Both are optional,
so many production links already post an empty `page`. There is no `platform`
parameter and nowhere to put one: `replybot/lib/generic-translator.js` `makeUrl` /
`translateWebview` build the URL from the field alone and have no access to the
conversation. Making linksniffer compliant means threading the conversation into the
translator so replybot appends `platform` / `account_id` to `links.vlab.digital` URLs
automatically — invisible to researchers, but a real refactor with production-wide
blast radius on every webview URL. **That is a design decision, not an implementation
detail, and it is out of scope for this phase.**

Consequence: **the 400 gate cannot be flipped on until linksniffer and exodus are
handled.** Flipping it early kills every tracked link click — and `linksniffer:click`
is what `wait` conditions on webview fields resolve against, so those conversations
would hang — plus every exodus bail.

This does **not** block §7.1. §7.1's rule for a missing component is "do not read and
do not write the cache, compute state from the event log", so a linksniffer event
without the triple degrades to a replay rather than breaking. And `transition.js`'s
`state.md.pageid` fallback for `getForm` is untouched by §7.1, which only forbids
`md` as a source for the *cache key*.

`botparty.ExternalEvent` has no `Platform` field and lives in a **separate repo**. Do not
publish and bump it across two services. `dinersclub` and `message-worker` each declare a
**local struct and a local sender** — `dean` already does exactly this
(`dean/queries.go` + `dean/dean.go` `send`). Follow that pattern.

## 4. The 400, and how it is gated

Hermes rejects a `/synthetic` POST missing any of `user` / `account_id` / `platform` with
**400**, logging the rejection with the poster's identity (`X-Vlab-Poster`, falling back to
`User-Agent`) and the event type, so we can find who.

**This is off by default.** Rollout order is non-negotiable (§7.3.1):

1. hermes accepts-but-does-not-require, and stamps what it can  ← ships first
2. all posters ship the triple — **six of them, and two are not ready; see above**
3. confirm zero events lacking a component (the §7.1 canary)
4. hermes turns on the 400 — **a values change, not a deploy**

Steps 1–3 are what this phase delivers. Step 4 is implemented but **must not be
flipped** until linksniffer and exodus comply.

**Gate:** environment variable `SYNTHETIC_REQUIRE_CONVERSATION`.

- Absent, or any value other than `true`/`1` (case-insensitive) → **off** (accept-and-stamp).
- `true` / `1` → **on** (400 on a missing component).
- Declared explicitly as `"false"` in `devops/values/production.yaml` and
  `devops/values/staging.yaml` so step 4 is a one-line edit to a committed file, per the
  project's "live config is never hand-edited" rule.

**Status codes are 400 across the whole malformed-body path, gate or no gate.**
`handle_synthetic` returns **500** today when `user` is missing
(`hermes/src/handlers.rs:302-307`, pinned by `hermes/tests/handlers.rs:336`). Adding a
400 for the new fields while that stays 500 would make the contract incoherent — a
poster could not tell "you sent garbage" (client fault, do not retry) from "we broke"
(server fault, retry). So:

- missing `user` → **400, always**, independent of the gate. Already unconditionally
  rejected; only the code changes. Safe for every caller, because `botparty.Send`,
  dean's `send` and the new local senders all treat any non-200 identically.
- missing `account_id` or `platform` → **400 only when the gate is on**; accepted with a
  warning log when it is off.

### Canary observability — the signal must not be ambiguous

Step 4 is gated on a canary reading zero. "Zero events lacking a component" measured at
replybot proves only that hermes *stamped* the fields; it does not prove they survive
into `messages.content`, which is what §7.5's replay actually reads — and the
testcontainers harness has no `messages` sink at all
(`facebot/testrunner/stack.ts:265-278` runs only `scribble-states` and
`scribble-responses`), so no integration test will catch a field dropped between the
topic and the archive.

What hermes *can* do is make its half unambiguous. Three **distinct, greppable log
tags**, so "the poster did not send it" is never confused with "hermes could not derive
it":

| Situation | Meaning |
|---|---|
| synthetic POST missing a component | the **poster** is not compliant — log the poster identity |
| Messenger `account_id` not derivable | malformed webhook (no recipient, or echo with no sender) |
| WhatsApp `phone_number_id` empty | malformed webhook |

Gating step 4 on a single undifferentiated counter would mean flipping the 400 on a
signal nobody can attribute.

## 5. Shared test vectors — the one piece of logic that exists twice

The Messenger `account_id` derivation duplicates the echo rule already implemented in JS in
`replybot/lib/event-normalizer.js` `parseMessengerEvent`. **This is the only logic in the
whole plan that exists in two languages.**

It is covered by one shared fixture, not by independent unit tests on each side that can
drift:

```
testdata/event-envelope/messenger-account-derivation.json
```

| Suite | Loads it via |
|---|---|
| `hermes/src/event.rs` `#[cfg(test)] mod tests` | `include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/event-envelope/messenger-account-derivation.json"))` |
| `replybot/lib/event-normalizer.test.js` | `require('../../testdata/event-envelope/messenger-account-derivation.json')` |

**Why the repo root and not inside either service.** The rule is jointly owned; putting the
fixture inside one service would make the other's test a cross-service reach-in and imply
ownership that does not exist.

**Why this is safe for the Docker builds**, whose contexts are per-service directories
(`.github/workflows/release.yml` `resolve`), so `testdata/` is *not* in either context:

- hermes — the loader sits in a `#[cfg(test)]` module. `cargo build --release --bin hermes`
  does not compile test modules, so `include_str!` is never evaluated during the image build.
- replybot — `replybot/Dockerfile` does not run tests; `CMD` is `npm start`.

CI runs both from a full `actions/checkout`, so the relative paths resolve.
`.github/workflows/replybot-test.yml`'s `paths:` filter gains `testdata/**` so a fixture
change actually triggers the JS side.

Each vector is `{ name, description, event, expected: { user_id, account_id, platform } }`.
`expected` values of `null` mean "not derivable"; both harnesses normalize absent/undefined
to `null` before comparing. `user_id` is included because `get_user_from_event` (Rust) and
`parseMessengerEvent` (JS) implement the *same* inversion, and pinning both halves in one
fixture is what stops them drifting apart.

## 6. Functional core

The derivation of `{account_id, platform}` from a raw event is a **pure function** —
`event.rs` on the Rust side, the poster's payload construction on the Go/JS side. The
handler and the HTTP client are the shell. Deciding what the envelope says must be
unit-testable without a server, a broker, or a socket.

## 7. Ownership during implementation

| Area | Owner |
|---|---|
| `hermes/**`, `testdata/**`, `devops/values/*.yaml` | envelope stream (this workstream) |
| `dean/**`, `dinersclub/**`, `message-worker/**` | envelope stream |
| `replybot/lib/index.js`, `replybot/lib/typewheels/transition.js` | envelope stream |
| `replybot/lib/event-normalizer.js` | **correctness stream — do not edit.** Additive tests in `event-normalizer.test.js` only. |
| `scribble/**`, `exodus/**` | correctness stream |
| `facebot/testrunner/**` | test stream |
