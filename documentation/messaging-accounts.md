# The messaging account registry

`chatroach.messaging_accounts` — the authority on **which messaging accounts we send and
receive on, and whose they are.**

Created by `devops/migrations/25-messaging-accounts.sql`. Design origin:
`planning/conversation-identity.md` §5 and §7.6. This document supersedes the account-identity
section of `documentation/platform-abstraction.md`, which now carries a dated reversal note
pointing here.

**Status: written, read by nobody.** Migration 25 and the dashboard-server dual-write are the
whole of the current scope. Every consumer still resolves credentials the old way. See
[What is deliberately not done](#what-is-deliberately-not-done).

---

## 1. What it owns

One row per messaging account, keyed by the platform it runs on and the id that platform
issued it.

```sql
chatroach.messaging_accounts(
  platform    VARCHAR NOT NULL,        -- 'messenger' | 'whatsapp' | 'instagram' | ...
  account_id  VARCHAR NOT NULL,        -- page_id | phone_number_id
  userid      UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
  credentials_entity VARCHAR NOT NULL,
  credentials_key    VARCHAR NOT NULL,
  created     TIMESTAMPTZ NOT NULL DEFAULT current_timestamp(),

  PRIMARY KEY (platform, account_id),

  CONSTRAINT credentials_exist
    FOREIGN KEY (userid, credentials_entity, credentials_key)
    REFERENCES chatroach.credentials (userid, entity, key) ON DELETE CASCADE,

  UNIQUE INDEX global_account_id (account_id),   -- TRANSITIONAL, see §6
  INDEX by_owner (userid, platform)
)
```

`platform` uses the **`SendMessageCommand` spelling** (`messenger`, `whatsapp`) — never the
`credentials.entity` spelling (`facebook_page`, `whatsapp_business`). The registry is the
place that fixes that translation once, so nothing downstream has to guess which vocabulary a
given field is in. That ambiguity is a documented source of silent failure: see
`devops/migrations/24-media-assets.sql`, which chose to key `media_handle` on `account_id`
alone specifically to avoid a two-part key that "invites the writer and the reader to
disagree."

## 2. Why it is not in `credentials`

`credentials` is a **generic** key/value store. It holds `api_token`, `reloadly`, `secrets`,
`typeform_token` and `facebook_ad_user` alongside the two messaging entities. How a subsystem
uses a credential is that subsystem's business.

Today the messaging invariant lives *inside* that shared store, as a partial index
(`devops/migrations/20-messaging-account-unique.sql`):

```sql
UNIQUE INDEX unique_messaging_account ON chatroach.credentials (key)
  STORING (details, userid)
  WHERE entity IN ('facebook_page', 'whatsapp_business');
```

Two things are wrong with that location:

1. **Its scope is an allowlist**, and the same allowlist is duplicated across six runtime
   call sites (§5). Add SMS or Telegram and the new entity falls outside every one of those
   predicates — its account ids become silently unconstrained, and the failure mode is a
   **collision that routes a participant to the wrong researcher**, not a rejected INSERT.
2. **`entity` is not the platform.** `entity → platform` is not a function, so it cannot be
   translated by a lookup table — which is exactly what
   `message-worker/tokenstore.go:29` and `dinersclub/provider.go:74` each try to do, with a
   hand-written map and a load-bearing fallback.

A domain-owned table that *points at* a credential fixes both: a new platform is a row, and
the platform is a column rather than something inferred.

## 3. Why `PRIMARY KEY (platform, account_id)` — and the reversal

This key **reverses a ratified decision** (2026-07-22) that account identity was
`(allocator, id)` serialized to one opaque string. The full record — the original reasoning
preserved verbatim, what changed, and what did not — is in
`documentation/platform-abstraction.md`. In brief:

- **None of the three tripwires the original decision named fired.** No un-prefixable
  allocator, no need to shard by platform, and **no observed uniqueness failure.** Verified in
  production 2026-08-17: zero duplicate `key` values across both messaging entities.
- **The original id-uniqueness argument remains correct.** Meta is one allocator across page
  ids and `phone_number_id`s; a bare Meta id genuinely is unambiguous. The reversal does not
  depend on that being wrong.
- **What carried is structural: platform cannot be an attribute *of* an account, because
  `entity → platform` is not a function.** Instagram DMs are delivered through the connected
  Facebook **Page's** token, so `platform='instagram'` and `platform='messenger'` are two
  platforms over **one** credential and **one** entity. An attribute is single-valued; this is
  not. Note what is and is not sourced here: our code records only the weaker half —
  `message-worker/translator_instagram.go:10`, *"Instagram uses the same API structure as
  Messenger"* — while the Page-token fact is **Meta's** documented model for Instagram
  messaging on a professional account, not a claim made anywhere in this repo.
- **Instagram is not live.** This is a *prospective* structural break, not an incident. A
  translator and a stub client exist and `PlatformInstagram` is in the enum
  (`message-worker/types/command.go:13`), but hermes has no Instagram webhook, no `instagram`
  credential entity is registerable, and nothing produces `platform='instagram'`. The claim
  rests on **Meta's** API design, not on our dead code. Weigh it as an argument about the
  model.

## 4. Verified production facts (2026-08-17)

Re-verify before running anything; these counts have drifted before (an earlier doc recorded
63 `facebook_page`).

| Fact | Value |
|---|---|
| `facebook_page` credentials | **62** |
| `whatsapp_business` credentials | **2** |
| Backfill row count | **64** |
| Rows where `key = details->>'id'` | **64 / 64**, zero NULL `details->>'id'` |
| Duplicate `key` across both messaging entities | **0** — the transitional index is satisfiable |
| Messaging credentials with no matching `users` row | **0** |
| `unique_entity_key_per_user` | **exists**, `(userid ASC, entity ASC, key ASC)`, secondary unique constraint (`01-init.sql:181`) — supplies the index the FK requires, in matching column order |

## 5. Remaining consumer inventory

**The plan (§5.1) said ten. The verified number is six.** Recorded here with `file:line` so
whoever does §5.5 step 3 does not have to re-derive it. Every one of these resolves a
messaging credential from a **bare account id** and/or hardcodes the
`entity IN ('facebook_page','whatsapp_business')` allowlist.

| # | Site | Shape | Passes platform? |
|---|---|---|---|
| 1 | `message-worker/tokenstore.go:105-111` | `WHERE key = $1 AND entity IN (...)` | Yes on the primary path (`WHERE entity = $1 AND key = $2`, lines 95-101); **this is the fallback** used when platform is absent or unmapped |
| 2 | `dinersclub/provider.go:93` | `WHERE key=$1 AND entity IN (...) LIMIT 1` | Same split — primary path at lines 90-91; this is the fallback |
| 3 | `formcentral/db.go:82` | `WHERE key=$1 AND entity IN (...) LIMIT 1` (subquery for `userid`) | No |
| 4 | `dean/queries.go:245` | `ON pageid = c.key AND c.entity IN (...)` | No |
| 5 | `dashboard-server/queries/states/states.queries.js:57` | `AND credentials.entity IN (...)` | No |
| 6 | `dashboard-server/queries/credentials/credentials.queries.js:42` | `AND entity IN (...)` | No |

**Corrections to the plan's list:**

- `dean/queries.go:244` → actually **:245**.
- `credentials.queries.js:42` and `states.queries.js:57` are two *different* files; the plan
  ran them together. Real paths are in the table.
- **"the dashboard-client account screens" are not consumers.** `Accounts.js` and
  `MessageTemplates/accounts.js` do client-side `.filter(c => c.entity === ...)` over an
  already-fetched list. They are not credential lookups and need no migration.
- **`media` and `message_templates` queries were already migrated** off the
  `facebook_page_id` computed column onto a real `account_id` column by migration 22. They
  are done, not pending.

**Two are only fallbacks, and that matters for sequencing.** Sites 1 and 2 already prefer a
`(entity, key)` lookup when the platform is known; the bare-id query is the `else` branch.
Those two are therefore the cheapest to migrate and the ones whose `platformToEntity` map
(§5.5 step 4) disappears with them.

**An additional dependant that is not a query.** `chatroach.media_handle` is keyed on
`account_id` **alone** and `24-media-assets.sql` documents the dependency explicitly: "If
`unique_messaging_account` is ever dropped, handles can collide across platforms." It issues
no credential lookup, so it is not a consumer — but it *is* a reason the global-uniqueness
guarantee cannot simply evaporate. Count it when planning §5.5 step 5.

## 6. The transitional index, and how it interacts with Instagram

`UNIQUE INDEX global_account_id (account_id)` exists because the six consumers above still
route on the bare account id. It is scheduled for deletion — **from this table, without ever
touching `credentials`**, which is the point of moving the invariant here.

Its interaction with the Instagram case was tested rather than reasoned about. Reproduced on
CockroachDB **v24.1.28**:

| Case | Result |
|---|---|
| `('messenger', page_id)` + `('instagram', igsid)`, both FK'd to the **same** `facebook_page` credential | **Admitted.** Both rows insert; both resolve to the one credential. This is B11-4 and it passes. |
| `('messenger', page_id)` + `('instagram', page_id)` — Instagram under the **same** account_id | **Rejected**, `SQLSTATE 23505`, `CONSTRAINT global_account_id`. |

**So the transitional index and the Instagram case are not in conflict — provided Instagram is
registered under its own IGSID rather than under the page id.** That is true of Meta's model
(an Instagram professional account has its own id distinct from the Page's), but it is an
*assumption*, and `global_account_id` — not the primary key — is what would reject a
violation. Pin it in a test rather than trusting it.

**The consequence that matters most:** while this index exists, `account_id → platform` is
**single-valued**, because no account id can appear twice. That is what makes the resolution
in §9 well-defined. **Dropping this index breaks that resolution**, so §5.5 step 5 is no
longer just "remove a transitional line" — it now has a dependant. See §9.

## 7. How a new platform onboards

The design goal of the tuple key: **a new platform needs no migration and no seventh
allowlist.**

1. Insert rows with the new `platform` value. No DDL.
2. Add the platform's outbound client and translator in `message-worker`.
3. Add the ingestion endpoint in hermes, stamping `platform` and `account_id` on the envelope.
4. **While `global_account_id` still exists**, the new platform's account ids must stay
   globally unique against every existing account id. If they are not Meta graph ids, prefix
   them per the namespace policy in `documentation/platform-abstraction.md` (`sms:+234…`,
   `tg:7123…`). That policy is scoped there to exactly this transitional need — the tuple
   itself does not require prefixing.
5. Nothing in `credentials` changes, and no consumer predicate needs editing — **once the
   consumers in §5 route on the registry.** Until then, a new platform still has to be added
   to those six predicates, because they are what actually resolve credentials today. The
   registry removes that obligation; it has not removed it yet.

## 8. The write path

**A messaging credential with no registry row is an invisible account** — messages arrive for
it and route nowhere, while the dashboard shows it as connected. There is no self-healing
path. So the two rows are written **in one transaction**.

The single credential-create path is `POST /api/v1/credentials` →
`dashboard-server/api/credentials/credentials.controller.js` →
`dashboard-server/queries/credentials/credentials.queries.js`. When `entity` is a messaging
entity it also inserts the registry row, deriving:

| Registry column | Value |
|---|---|
| `platform` | `messenger` for `facebook_page`, `whatsapp` for `whatsapp_business` |
| `account_id` | the credential's `key` |
| `credentials_entity` / `credentials_key` | the credential's `entity` / `key` |
| `userid` | the user the credential resolves to |

**That entity→platform map is a write-path default, not a general function.** It answers
"which platform row does a newly connected credential get *by default*", which is
single-valued. It is not the inverse of §3's claim: a `facebook_page` credential can later
gain an `('instagram', igsid)` row, added as its own registration rather than derived.

**§5.4 assumed two paths; there is one.** The plan specified that connect flows dual-write
while "the direct-create path rejects messaging entities." Those are the same route:
`dashboard-client/src/containers/FacebookPages/FacebookPages.js:147` and
`.../WhatsAppEmbedded/WhatsAppEmbedded.js:132-146` both POST `entity` directly to
`POST /api/v1/credentials`. A blanket rejection of messaging entities there would break both
live connect flows. Since the one path always dual-writes, the invisible-account state it was
meant to prevent is already unreachable. The guard that ships instead rejects *malformed*
messaging creates — a missing/empty `key`, or a `details.id` that disagrees with `key` — which
is the subset that would actually produce a bad or unroutable registry row.

## 9. Account → platform resolution (design only — NOT built)

**Handed over as a design, per instruction. No hermes code was written.**

### 9.1 The problem

Some event posters know the `account_id` but not the `platform`. Since §7.1 landed,
`replybot/lib/typewheels/statestore.js:34` keys state as `state:{platform}:{account}:{user}`
straight from the envelope, and the old `state.md.platform` fallback is deliberately gone (a
green test asserts it never happens). A poster that guesses the platform now writes to the
**wrong conversation key**, and because `linksniffer:click` is what `wait` conditions resolve
against, the participant's conversation **hangs**.

`linksniffer` is the live instance. It does not hardcode the platform — it accepts an optional
`platform` query param and **assumes `messenger` when it is absent or unrecognised**
(`linksniffer/server.go:60-68`), logging `[LINKSNIFFER_PLATFORM_ASSUMED]` or
`[LINKSNIFFER_PLATFORM_INVALID]`. Its query params are researcher-authored, and a researcher
building a webview has no reason to add `platform`, so the assumption fires by default. That was
sound when `webview` was believed Messenger-only; it is not — WhatsApp renders it as `cta_url`.

**There is no heuristic.** Page ids and `phone_number_id`s are both bare Meta graph ids,
indistinguishable by inspection — exactly what `documentation/platform-abstraction.md` asserts.
**A lookup is the only correct answer, and this registry is the lookup.**

### 9.2 Scope — smaller than it first appears

Verified against `hermes/src/`: hermes stamps `platform` **unconditionally** on both inbound
webhook paths — `handlers.rs:266` (`stamp_event(…, "messenger")`) and `event.rs:179-209`
(`stamp_whatsapp_event`, which sets `platform = "whatsapp"` from the entry's
`phone_number_id`). Those two can never arrive without a platform.

**So resolution is needed on `/synthetic` only** (`handlers.rs:338-412`). That is the internal,
low-volume path. The high-volume inbound message path is untouched, which is what makes this
safe to add to the single ingester.

**All six synthetic posters now send a platform** — `dean`, `dinersclub`, `message-worker`,
`replybot`, `linksniffer`, and `exodus` (whose conditions-based bails were the last holdout and
now send `COALESCE(s.platform, 'messenger')`). So resolution has **nothing to fill in today**;
its value is as a backstop for the next poster, and — in verify mode — as the only check on the
two posters that send an *assumed* platform rather than a known one. See §9.6, which is where
that distinction is worked through; it is the crux of whether this is worth building now.

### 9.3 Shape — in-memory map, refreshed; never a hot-path read

```
account_id -> (platform, userid)     -- from messaging_accounts, ~64 rows
```

**Every one of these is a first for hermes**, and that is the main cost of this design.
Verified: hermes has **no database access of any kind** (`hermes/Cargo.toml` — no `sqlx`,
`tokio-postgres`, `deadpool`, `diesel`; it is a stateless HTTP→Kafka bridge), **no background
tasks** (no `tokio::time::interval` anywhere), and **no Prometheus metrics** (observability is
`tracing` with bracketed grep tags only). Adding this means: a new DB dependency and DSN, the
first `tokio::spawn` refresh loop, and an `Arc<RwLock<HashMap<…>>>` in `AppState`.

**Single-valuedness is not free.** The map is a function `account_id -> platform` **only because
`UNIQUE INDEX global_account_id (account_id)` exists** (§6). This is a dependency running
opposite to the one §5.5 assumes: **dropping that transitional index makes this lookup
ambiguous.** Before it can be dropped, either resolution moves to something tolerating multiple
platforms per account id, or every poster carries the platform itself. Recorded in §11.

**Instagram under this lookup.** An `account_id` resolves to exactly one row, so a page id
resolves to `messenger` and an igsid to `instagram` — correct, and correct *because* they are
different ids. Were Instagram ever registered under the page id, `account_id` alone could not
resolve the platform at all; the transitional index rejects that case today (§6), which is a
second reason to pin the IGSID assumption in a test.

**Per-pod cache, 3 replicas.** `devops/values/production.yaml` runs `hermes.replicaCount: 3`.
Each pod holds its own copy and refreshes independently, so after a new account connects the
pods disagree for up to one refresh interval. Acceptable for a 64-row, slowly-changing table,
and the miss path below closes the window for the case that matters.

### 9.4 The three failure modes — explicit answers

Guessing is what caused this bug, so each answer says what happens *instead* of guessing.

**(a) Cache miss — account not in the map.** Do **not** guess. A miss means either a
newly-connected account (stale cache) or a genuinely unknown account. Trigger an out-of-band
refresh, retry once, and if it still misses, log `[PLATFORM_UNRESOLVED]` naming the
`account_id`. Rate-limit the miss-triggered refresh, or a flood of unknown ids becomes a query
flood — that is the one path by which hot-path DB load could sneak back in.

**Whether an unresolved miss is a 400 is GATED, not unconditional — see §9.6.** An
unconditional 400 here would reject events that the gate currently lets through, tightening
behaviour before anyone flips the flag and inverting the rollout ordering §7.3.1 was careful
about. So: gate ON → 400; gate OFF → keep today's behaviour exactly (publish with
`[INCOMPLETE_CONVERSATION]`, plus the new `[PLATFORM_UNRESOLVED]` line). Resolution is then
**purely additive** and safe to deploy on its own.

When the gate is on, a rejected event is visible, alertable and retryable by its poster. A
guessed platform is an invisible wrong-key write that hangs a conversation with nothing in any
log. The whole reason this work exists is that the second option was taken once already.

**(b) Initial load fails at startup — START ANYWAY, degraded.** This is the one place where
hermes's existing convention should *not* be followed. Hermes currently `exit(1)`s on any
startup failure including Kafka readiness (`main.rs:28-36`), and copying that for the registry
load would couple **all inbound message ingestion to CockroachDB availability at pod start** — a
Cockroach blip during a rollout would stop hermes from starting and ingest nothing at all. That
is strictly worse than the problem being solved.

Instead: log loudly, start, serve, and retry the load with backoff. The blast radius of an
empty map is confined to §9.2's scope — inbound `/webhooks` and `/whatsapp` are unaffected
because they never need resolution, and `/synthetic` events that already carry a platform are
unaffected too. Only platform-less `/synthetic` events are rejected, per (a). Kafka is genuinely
required for hermes to do anything; the registry is required only for a backstop on one path, so
they warrant different startup treatment.

**(c) A newly-connected account, without a restart.** Two mechanisms, both needed. A periodic
refresh bounds staleness in the normal case. The miss-triggered refresh in (a) handles the
urgent case — a researcher connecting an account and immediately testing it is the most likely
first encounter with a cold entry, and waiting a full interval there would look exactly like a
broken connect flow.

### 9.5 Observability

Follow the existing convention — bracketed, greppable `tracing` tags, since there is no metrics
pattern to follow. Suggested: `[PLATFORM_RESOLVED]` (a poster omitted the platform and the
lookup supplied it — this should trend to zero as posters are fixed), `[PLATFORM_UNRESOLVED]`
(the 400 in (a)), and `[REGISTRY_LOAD_FAILED]` / `[REGISTRY_STALE]` for (b).

`[PLATFORM_RESOLVED]` is the one that matters operationally: it names the posters still relying
on the backstop. A Prometheus counter would be better than a log line, but it would establish
hermes's first metrics pattern — worth doing, worth costing separately.

### 9.6 Interaction with `SYNTHETIC_REQUIRE_CONVERSATION`

The gate is **currently OFF** — `synthetic_require_conversation` defaults to `false`
(`hermes/src/config.rs:20-26`) and is set `"false"` in **both** `devops/values/production.yaml`
and `staging.yaml`. Today, when off, a platform-less `/synthetic` event is published **as-is**
with an `[INCOMPLETE_CONVERSATION]` warning (`handlers.rs:372-380`) — which is precisely how a
wrong-keyed state write reaches replybot.

**Resolution changes what the gate costs, and the sequencing follows from that.** Ship
resolution first; then enabling the gate is cheap, because by then the only events it rejects
are the genuinely unresolvable ones rather than every poster that merely omitted a field.

**The rejection must be gated, or the ordering inverts.** With the gate off, hermes today
*accepts* platform-less synthetic events. If resolution added an unconditional 400 on an
unresolvable account, deploying resolution would start rejecting traffic the gate still permits
— a tightening smuggled in under a correctness fix. So the 400 lives behind the same flag, and
resolution deployed with the gate off is **strictly additive**: it fills in a platform when it
can, and otherwise leaves behaviour byte-for-byte as it is today. That makes resolution safe to
deploy independently of the gate.

**Two modes, and only one of them is useful today.** This distinction matters more than the
gating does:

| Mode | Trigger | Effect | Tightening? |
|---|---|---|---|
| **Fill** | `platform` **absent** | resolve from `account_id` and stamp it | No — additive |
| **Verify** | `platform` **present** | check it against the registry; disagreement is a fault | **Yes** — must be gated |

**Fill mode is a no-op as of 2026-08-17, because every poster now sends a platform.** All six
send it, including the last holdout: `exodus` conditions-based bails now send
`COALESCE(s.platform, 'messenger')`. So nothing currently reaches the unresolved path at all,
and fill mode's value is entirely prospective — a backstop for the *next* poster.

**The live risk is the one fill mode cannot see: a platform that is present but assumed.** Two
instances, and in both the field is populated, so fill mode never fires:

- `linksniffer` assumes `messenger` when the query param is absent (`server.go:60-68`).
- `exodus`'s `COALESCE(s.platform, 'messenger')` defaults to `messenger` whenever
  `states.platform` is NULL — **97.8% of rows**, so the default is load-bearing rather than
  cosmetic, and the great majority of conditions-based bails now carry an *assumed* platform.

Only **verify** mode catches those, and it is exactly what §5.2 anticipated — "the envelope's
`platform` is checkable against the account rather than trusted blindly." It is also
unambiguously a tightening, so it belongs behind the gate and should ship after fill mode has
been running quietly.

Neither assumption has live exposure **today**: production WhatsApp traffic is 4 conversations
ever, with zero webview fields. The assumptions are correct for essentially all current traffic
and become wrong as WhatsApp grows — which is why this is worth building before it bites, and
also why it does not block anything.

Two further cautions:

- **The gate should still require `account_id`.** Resolution downgrades "platform missing" from
  fatal to recoverable; it does nothing for a missing account id, which stays unresolvable.
  Note `missing.user` is already an unconditional 400 (`handlers.rs:354-357`) regardless of the
  gate; `account_id` belongs in that category too.
- **Do not let resolution become a permanent silent crutch.** If hermes quietly compensates,
  a poster that stops sending `platform` is never noticed. Prefer keeping the gate strict and
  treating resolution as a backstop that *reports* (§9.5) — and watch
  `[PLATFORM_RESOLVED]`, which names the posters still relying on it.

### 9.7 Alternatives considered

- **Fix linksniffer directly** — it already accepts a `platform` param, so replybot could
  interpolate the platform into tracked-link URLs at send time. Rejected as the primary fix: it
  repairs one poster out of six, and it puts correctness into researcher-authored survey content
  where a typo silently mis-routes. Worth doing *as well*, to reduce reliance on the backstop.
- **A DB read per `/synthetic` request.** Rejected: it puts CockroachDB in the ingester's
  request path for a 64-row table that changes when a human clicks "connect".
- **Have replybot resolve it.** Rejected: replybot is downstream of the state-key decision, so
  resolving there is circular — this is the same circularity §3.1 describes for
  `state.md.platform`. Hermes is upstream of every consumer, which is why it is the right place.

## 10. The recurring check

§5.3's standing assertion ships as a **sql-exporter collector**, which is this repo's
convention for scheduled SQL checks (`devops/sql-exporter/templates/configmap.yaml`,
collector `messaging_account_health`, `min_interval` 60s, scraped by Prometheus). No CronJob —
the existing pattern is metrics-plus-alert-rule.

| Metric | Meaning |
|---|---|
| `messaging_accounts_invisible` | Messaging credentials with **no** registry row. **MUST be 0.** The alerting signal. |
| `messaging_accounts_registered` | `count(messaging_accounts)` |
| `messaging_credentials_total` | `count(credentials WHERE entity IN (...))` |

**Why not §5.3's literal count-equality.** The equality
`count(messaging_accounts) == count(credentials WHERE entity IN (...))` is **transitional and
breaks on a correct change**: one credential can legitimately back more than one registry row
(Instagram). The first Instagram account connected makes the counts unequal with nothing
wrong. The durable invariant is the non-existence one — "no messaging credential lacks a
registry row" — which is Instagram-proof and is the direction that actually hurts. Both raw
counts are exported anyway so §5.3's equality is still evaluable in PromQL during the
transition, and so its eventual divergence is a visible fact rather than a page.

Verified: the query returns `invisible_accounts = 0` against a correctly backfilled database,
and `1` after inserting a messaging credential with no registry row.

**Remediation** when it fires: re-run migration 25. The backfill is idempotent
(`ON CONFLICT DO NOTHING`), so it repairs the gap without side effects — then find out how a
credential was created outside the transaction.

## 11. What is deliberately not done

`planning/conversation-identity.md` §5.5 sequences this, and the ordering is load-bearing
because the registry is *derived from the same rows the old queries read* — which is what
makes each consumer independently deployable.

| Step | Status |
|---|---|
| 1. Table + backfill + dual-write; nothing reads it | **This work** |
| 2. Verify the assertion across a week of real account connects | **A real gate, not a formality** |
| 3. Migrate the six read consumers, one service at a time | Not started |
| 4. Delete `platformToEntity` from `tokenstore.go` and `provider.go` | Not started |
| 5. Drop `unique_messaging_account` from `credentials`, then `unique_facebook_page` and the `facebook_page_id` computed column | Not started — **and now has a new blocker, see §6/§9** |

Nothing reads `messaging_accounts`. That is the intended end state of this phase.

## 12. Operational notes

**`ON DELETE CASCADE` on the credentials FK is a deliberate change from the §5.2 draft.**
The draft declared no delete action. With CockroachDB's default that makes a messaging
credential **undeletable** while a registry row references it — reproduced on v24.1.28:

```
SQLSTATE 23503 ... Key (userid, entity, key)=(...) is still referenced from
table "messaging_accounts". CONSTRAINT: credentials_exist
```

which breaks account **reconnection** (`credentials` has `UNIQUE(entity, key)` and the create
path has no `ON CONFLICT`, so re-POSTing an existing page raises 23505; recovery is
delete-then-recreate), any future disconnect feature, and seven dashboard-server test
teardowns that `DELETE FROM credentials`. CASCADE is also the correct semantics: a registry row
without its credential is an account that can neither send nor receive.

Note the asymmetry — CASCADE makes "credential gone, registry row orphaned" impossible, but
does nothing about the **opposite and more dangerous** state, a credential with no registry
row. Only §10's check catches that.

**Deleting a user cascades correctly through both paths.** `userid` cascades from `users` on
this table *and* on `credentials`. Verified on v24.1.28: deleting a user removes credential
rows and registry rows together, with no 23503 from the interleaved cascade.

**Archival tables must keep their own `platform` column.** Because `credentials` cascades on
user delete, a deleted researcher would otherwise strip the platform binding from history.
This is why §7.4 puts `platform` on the log tables rather than joining to the registry.

**Migration 25 is idempotent and safe to re-run**, which is what makes it the remediation for
§10. `CREATE TABLE IF NOT EXISTS` plus `INSERT ... ON CONFLICT DO NOTHING`. Verified: a second
application inserts 0 rows and exits 0.

**Fully `chatroach.`-qualified throughout**, because `devops/Makefile` pipes the
*concatenation* of every migration through one `cockroach sql` session — one unqualified name
aborts every migration after it (`documentation/platform-abstraction.md`, "Test-DB gotcha").
Verified both application modes on v24.1.28: 26 files one-at-a-time in lexical order
(`facebot/testrunner/stack.ts`), and the single concatenated session (`make test-db`).
