# moviehouse — the seventh synthetic producer

Closes the last gap in §7.3.1 of `planning/conversation-identity.md`: every producer that
POSTs to hermes' `/synthetic` must carry the conversation triple `(platform, account_id,
user_id)`.

> ## ⚠️ The design in this document is SUPERSEDED. The measurements are not.
>
> Everything under **Production measurement** downward is still valid and is the reason the
> replacement exists — read it. Everything above it describing *how* moviehouse comes to have
> a correct identity in its query string has been replaced.
>
> **What was built here:** `tracked: true` on a `webview` field, a host allowlist
> (`KNOWN_TRACKED_HOSTS`) mapping each of our hostnames to a per-service param scheme
> (`LINKSNIFFER_PARAM_SCHEME` / `MOVIEHOUSE_PARAM_SCHEME`), because linksniffer read the
> participant from `id` while on a moviehouse URL `id` is the Vimeo video id.
>
> **What replaced it:** `link_tracking` and `moviehouse` are now first-class **field types**,
> and **replybot builds the whole URL** — base from config (`LINKSNIFFER_URL` /
> `MOVIEHOUSE_URL` in the `replybot.env` block of `devops/values/<env>.yaml`), identity from
> the conversation, content from the field. The researcher writes `videoId: "164118668"` and
> nothing else.
>
> **Why**, in the terms this document itself established:
>
> - **The allowlist was the bug, not the fix.** This document identified
>   `virtuallab-videos.netlify.com` as "the `gbvlinks.nandan.cloud` trap one letter over" —
>   two hostnames carrying 683 live fields between them that no config-derived enumeration
>   could see. It then proposed enumerating them by hand, which is the same method that had
>   already failed twice. It has since been measured that **both** rotted entries are *dead*:
>   `.netlify.com` 404s, and `gbvlinks.nandan.cloud` resolves to the cluster ingress but is
>   claimed by no Ingress, so nginx answers with the ingress controller's self-signed
>   "Kubernetes Ingress Controller Fake Certificate" and TLS fails. An allowlist can only ever
>   describe hosts a researcher typed in the past; replybot using **its own** host needs no
>   list and cannot rot.
> - **The param-scheme collision cannot exist.** The schemes existed solely because `id` meant
>   two different things on two of our own pages. Now the video id is an explicit `vlab_video`
>   param replybot sets, and there is ONE identity set — `vlab_user`, `vlab_account`,
>   `vlab_platform` — read by both services. The `vlab_` prefix makes the collision
>   structurally impossible rather than carefully avoided.
> - **The whole `pageId` defect class is deleted, not mitigated.** §`pageId` carries
>   linksniffer's hardcoded-page defect measured 465 of 570 fields hardcoding an account, 63
>   of them junk, and §*This is not a projection* traced one of them corrupting a live
>   WhatsApp conversation. `tracked: true` *overrode* a hardcoded `pageId`. The new design
>   gives a researcher nowhere to write one.
> - **Nothing depends on remembering a flag.** Choosing the field type is the opt-in.
>
> Two consequences for this document's own conclusions:
>
> - **§Non-goals "Not a values change" is now wrong.** It is a values change — but to
>   `replybot`'s env block, not to a moviehouse deployment. moviehouse still ships from
>   Netlify on its own track; what the cluster now declares is *where replybot points
>   participants*.
> - **§The priority this measurement changes still holds, and is now cheaper to act on.** The
>   490 fields on the dead `.netlify.com` host are fixed by the same edit that adopts the new
>   type: changing `type: webview` + a hand-built URL to `type: moviehouse` + `videoId` drops
>   the hostname along with everything else. Migration is one edit per field, not two.
>
> Researcher-facing documentation for the replacement is `documentation/questions.md`
> ("Tracked links", "Videos (Moviehouse)"). Implementation notes are in
> `replybot/README.md`, `moviehouse/README.md` and `linksniffer/README.md`.

## Why it was missed

`moviehouse` is a **browser page**, deployed from **Netlify**, not the cluster. The
enumeration method the plan prescribes — "grep `BOTSERVER_URL` in
`devops/values/production.yaml`" — is structurally blind to it: its `/synthetic` URL lives in
`moviehouse/netlify.toml` as `SERVER_URL`, mustache-substituted into `src/script.js` at build
time. Six posters comply; this is the seventh.

It posts on **every video event and a heartbeat every 30 seconds**, so it is not an edge case:
it is the highest-frequency per-participant producer in the system while a video plays.

## Consequences before this change

| | |
|---|---|
| `[INCOMPLETE_CONVERSATION]` | guaranteed non-zero → the rollout's step-3 canary is unsatisfiable |
| `SYNTHETIC_REQUIRE_CONVERSATION: true` | would **400 every moviehouse event** and kill video tracking outright |
| replybot state cache | every event misses the cache and triggers a full replay — a ~30k-row scan every 30s per watcher |
| **correctness** | `transition.js` falls back to `eventPlatform`, which hard-defaults `'messenger'`. A moviehouse event on a **WhatsApp** conversation therefore builds outbound commands for the wrong platform. Video events are conversation-advancing (a field can `WAIT_EXTERNAL_EVENT` on `moviehouse:play`), so this is a correctness bug, not lost analytics. |

## Approach — the linksniffer precedent  *(SUPERSEDED — see the banner above)*

replybot stamps the identity into the URL it generates; the browser reads it back out of its
own query string and forwards it. moviehouse already does half of this — `getQueryParams()`
parses its own query string into an object, which is where `pageId` and `userId` come from.

### Part 1 — replybot stamps moviehouse URLs

`generic-translator.js` gates `tracked: true` stamping behind a linksniffer-only allowlist.
The concept is **"a first-party host we stamp identity for"**, not "a linksniffer host", so the
allowlist generalizes.

**The load-bearing discovery: the stamped param names cannot be shared.** linksniffer's user-id
param is `id`. On a moviehouse URL, **`id` is the Vimeo video id**
(`script.js`: `const videoId = params['id']`). `makeUrl` merges extra params with extra
winning, so naively adding moviehouse to the existing allowlist would **overwrite the video id
with the participant's PSID** and every tracked moviehouse field would render
"Sorry, we couldn't find that video". The allowlist therefore maps host → **param scheme**:

| component | linksniffer | moviehouse |
|---|---|---|
| user id | `id` | `userId` |
| account | `account_id` + `pageid` (legacy alias) | `account_id` + `pageId` (legacy alias) |
| platform | `platform` | `platform` |
| *(left alone)* | — | `id` — the Vimeo video id |

Stamping the **legacy alias too** (`pageId`, and `userId` which is also moviehouse's existing
param) is deliberate and buys deploy-order independence: replybot ships to the cluster,
moviehouse ships via Netlify, and the order is not guaranteed. A replybot-first deploy makes an
**unmodified** moviehouse forward the correct account under `page` immediately, and fixes the
fields that author the broken `{{hidden:userid}}` (not a real key — silently interpolates to
empty, hard-failing the page).

### Part 2 — moviehouse forwards the identity

Read `account_id` (preferring it over the legacy `pageId`) and `platform` from the query params
it already parses; POST `user`, `account_id`, `page` (retained deprecated alias — §4 keeps
per-shape aliases because the historical `messages` backfill reads them), `platform`.

## Decision: absent params → omit, never assume

Two precedents pull different ways. linksniffer sends an explicit logged assumption
(`platform=messenger`, `[LINKSNIFFER_PLATFORM_ASSUMED]`); the general rule everywhere else is
never guess an identity. **moviehouse omits.** Reasoning:

1. **Absent degrades; wrong hangs.** Per `documentation/event-envelope.md`, an event carrying an
   account and no platform *bypasses the cache and still gets an account-scoped replay* — the
   conversation advances, just slower. A **wrong** platform addresses a conversation that does
   not exist, so the `wait` on `moviehouse:play` never resolves *and* the outbound commands are
   built for the wrong transport. On the correctness axis absent strictly dominates wrong.
2. **Volume inverts linksniffer's calculus.** linksniffer posts once per click, where an
   assumption costs one event. moviehouse posts every 30 seconds for the whole watch. An
   assumption is not a one-shot risk here; it is a continuous stream of mis-addressed events,
   and it would make a second `*_PLATFORM_ASSUMED` counter **structurally non-zero at high
   volume** — permanently un-gateable, which is the exact failure this task exists to fix.
3. **Omission is already counted; assumption needs an instrument that does not exist.** An
   absent platform lands on hermes' `[INCOMPLETE_CONVERSATION]`, which *is* the step-3 counter
   and which drains to zero as surveys adopt `tracked: true`. An assumed platform stamps
   cleanly, passes the gate, and is invisible to it — only hermes' **verify** mode sees a
   present-but-wrong platform, and verify mode is designed but not built (§8.3).
4. **The gate makes omission self-limiting.** With the gate off (today, and it must stay off
   until this deploys) omission is accepted and correct-but-slow. The gate may only be turned on
   once `[INCOMPLETE_CONVERSATION]` reads zero — and that condition *is* "no moviehouse event
   omits a platform". So "gate on **and** platform absent" is contradictory by construction if
   the rollout order is respected, whereas "gate on and platform silently wrong" is the steady
   state an assumption would create.

Corollary, following linksniffer: a `platform` param that is **present but not a known
transport** is dropped rather than forwarded (`[MOVIEHOUSE_PLATFORM_INVALID]`) — the value
becomes a component of the conversation identity downstream, so a typo or casing mismatch
would be a poisoned cache key. Dropping it is the same choice as omitting, not a fallback to
`messenger`.

Both diagnostics are logged **once per page load**, not once per event: a per-event warning at
one heartbeat every 30 seconds plus play/pause/seek would flood the console for a single
watcher.

## Functional core / imperative shell

- `moviehouse/src/identity.js` — the pure core. `resolveConversation(params)` and
  `buildSyntheticBody(spec)`: no DOM, no network, no globals, total. Loaded as a browser global
  by `index.html` and as a CommonJS module by the test.
- `moviehouse/src/script.js` — the shell. Reads the query string, logs the two diagnostics
  once, POSTs.
- `replybot/lib/generic-translator.js` — `trackedParamScheme(url)` and
  `buildTrackedParams(ctx, scheme)` stay pure; `translateWebview` remains the only place that
  logs.

## Production measurement, vprod + vstag, read-only, 2026-08-17

Methodology copied from `planning/whatsapp-webview-exposure.md`: "live" = `DISTINCT ON (userid,
shortcode, survey_name) ORDER BY created DESC`; no live field carries a literal
`"type":"webview"`, so all detection replays `addCustomType` + `_cleanStrings` in Node over
`js-yaml@3.14.2`, then classifies both the string and object `url` forms. The pipeline
reproduces the linksniffer run exactly — 1024 candidates → **1007 effective webview fields /
203 surveys**, string 780 / object 227 — which is what licenses the moviehouse numbers below.

### The real hosts

| host | evidence | live prod fields | vstag fields | HTTP today |
|---|---|---|---|---|
| `virtuallab-videos.netlify.app` | repo + data | 79 / 18 surveys | 13 / 3 | **200** |
| `staging--virtuallab-videos.netlify.app` | repo + data | 1 / 1 (`flysmoke`) | 1 / 1 | **200** |
| **`virtuallab-videos.netlify.com`** | **DATA ONLY — in no repo file** | **490 / 64 surveys / 3 researchers** | 0 | **404 — dead** |
| `staging--virtuallab-videos.netlify.com` | neither; probed speculatively | 0 | 0 | 404 — **not listed** |

**`virtuallab-videos.netlify.com` is the `gbvlinks.nandan.cloud` trap one letter over** — the
pre-migration Netlify apex, carrying **86% of all live moviehouse fields**, invisible to any
config-derived allowlist. It is worse than the linksniffer case in one respect: it is not
merely unlisted, it is **dead**. Netlify returns 404 (not a redirect) for the retired alias,
and all 490 fields `wait` on `moviehouse:play`, so those waits can never resolve.

Two properties of the match are now load-bearing rather than incidental, because
`netlify.app`/`netlify.com` are **multi-tenant apexes** unlike `links.vlab.digital`: the
comparison must be an exact hostname (never `endsWith`), and it must not pick up inherited
object keys. Hosts already live in this system that must not match:
`staging--vlab-research.netlify.app` (the dashboard), `nigeria-pledge.netlify.app`,
`pledge-for-positive-change.netlify.app`. Netlify also serves
`<branch>--virtuallab-videos.netlify.app` for every branch, so a new branch deploy needs an
explicit entry. All pinned by tests.

### Migration size — inverted from linksniffer

**82 live surveys / 570 fields / 4 researchers / 0 currently `tracked: true`.**

| class | surveys | fields | keepMoving fields | **`moviehouse:*` wait fields** |
|---|---|---|---|---|
| WA-owner | **36** | **178** | 34 | **144** |
| Messenger-only | 46 | 392 | 191 | 392 |
| **total** | **82** | **570** | 225 | **536** |

| researcher | class | fields | surveys | hosts |
|---|---|---|---|---|
| `mchatila@worldbank.org` | Messenger-only | 391 | 45 | `.netlify.com` only — **all dead** |
| `nandanmarkrao@gmail.com` | **WA-owner** | 103 | 20 | `.com` 98, `.app` 4, `staging--` 1 |
| `worldbank@vlab.digital` | **WA-owner** | 75 | 16 | `.app` only |
| `test@test.com` | Messenger-only | 1 | 1 | `.netlify.com` |

**The risk profile is the opposite of linksniffer's.** There, 634 of 1007 fields were
`keepMoving` and only 19 waited on a click, so most degraded gracefully. Here **every one of
the 82 surveys contains at least one field that waits on a moviehouse event**, and the wait
shape histogram is `moviehouse:play` alone **410**, `play` + `timeout` **126**, no wait 34 — so
**410 fields hang indefinitely** on a missed event and only 126 can self-recover via an
`op: or` timeout. Nothing degrades gracefully.

Currently active (last activity 2026-08-17, all `.app`, all worldbank unless noted): `tuki`
244 participants, `both` 223, `girleffecttuki` 97, `girleffectboth` 75, `hpvmedia` 17,
`bothswahili` 10, `tukiswahili` 9, `kenya_tvet_bl` 8, `flysmoke` 2 (nandan). Dormant but large,
all on the dead `.com` host: `johhnormsar` 7342 participants with **3657 stuck in
`WAIT_EXTERNAL_EVENT`**, `ninevehshortplacebo` 422/181, `ninevehshorttreat` 419/207. Roughly
**4,000 conversations sit waiting for a `moviehouse:play` from a host that 404s** — mostly
predating the retirement, so co-occurrence rather than an attributed cause, but nothing can
rescue them now.

### This is not a projection. It already happened, on 2026-08-13.

The linksniffer measurement could say the intersection of "runs on WhatsApp" and "has a
hand-authored tracked link" was **empty**. For moviehouse it is **not empty** — it was
exercised four days before this work, and there is a message-level trace.

Participant `15126808320`, worldbank, `hpvbl` (WhatsApp) → stitch → `hpvmedia`:

```
22:27:33  bot_echo, phone_number_id 1265380589988964  (delivered over WhatsApp)
          webview url=…/?id=1143993262&pageId=101435865704727&userId=15126808320
22:27:34  page 1265380589988964 -> WAIT_EXTERNAL_EVENT (awaiting moviehouse:play)
22:27:48  synthetic {"user":"15126808320","page":"101435865704727", …    <-- WRONG ACCOUNT
           "event":{"value":{"type":"moviehouse:play","id":"1143993262"}}}
22:27:49  page 101435865704727 -> WAIT_EXTERNAL_EVENT, issues send_message
22:27:55  page 101435865704727 -> BLOCKED      (still BLOCKED in production today)
```

The button was delivered over WhatsApp; `userId` interpolated correctly; **`pageId` was the
hardcoded Messenger page `101435865704727`**. moviehouse echoed it back as `page`, replybot
routed the event to a **phantom conversation on a Facebook page keyed by a phone number** —
which is now a durable `states` row whose key is a Facebook page while its `md.pageid` is a
WhatsApp `phone_number_id` — and the real WhatsApp conversation never received its
`moviehouse:play`. The participant had to re-enter the survey.

Methodological note for whoever measures next: the template's WhatsApp filter
`states.pageid IN (<whatsapp keys>)` **cannot see this row**, because the row hides on a
Facebook page id. Filter on `platform='whatsapp'` (a lower bound — the column is NULL for most
rows) or on phone-number-shaped `userid`.

### `pageId` carries linksniffer's hardcoded-page defect, worse

**465 of 570 fields (81.6%) hardcode `pageId`**, versus 81 of 346 for linksniffer. 2 fields
interpolate (`{{hidden:pageid}}`, both in `flysmoke` — the only correctly-authored survey in
the set), and 103 omit it.

| literal | fields | real `credentials.key`? |
|---|---|---|
| `105246245358509` | 314 | yes — mchatila `facebook_page` |
| `101435865704727` | 56 | yes — worldbank `facebook_page` |
| **`105246245358509)`** | **37** | **no — trailing paren, junk** |
| **`720722553`** | **18** | **no — this is a Vimeo video id** |
| `111108121363615` | 12 | yes — worldbank |
| `104662068658429` | 12 | yes — mchatila |
| **`105246245358509)720722553`** | **8** | **no — two ids concatenated** |
| `881943064995558` | 7 | yes — worldbank |
| `1855355231229529` | 1 | yes — nandan |

All 36 WhatsApp-capable moviehouse surveys hardcode a **Messenger** page or omit it, save
`flysmoke`. That is the linksniffer conclusion restated — and §Reproduced above is it firing.

Note the shape collision that makes the junk undetectable by validation: Vimeo ids and Facebook
page ids are both bare 9–15-digit strings.

### Out-of-scope defects found, for other owners

1. **`_removeMdLinks` is missing its `/g` flag** — `replybot/lib/typewheels/form.js:327-333`
   uses a non-global `mdLinkPattern`, so only the **first** markdown link in a description is
   unwrapped. Typeform auto-linkifies pasted URLs, so an edited field ends up with several, and
   the leftover `](…)` fragments concatenate into the query string. That is the cause of all 63
   junk `pageId`s above. **It is a live bug, not a static-analysis artifact:** re-running the
   promotion with interpolation applied *first* (as `form.js:169` does) yields a byte-identical
   histogram. It reached production — `states` has a row with
   `pageid = '105246245358509)'`, 1 participant, 2022-10-26, `current_form testplac2`, which is
   the unexplained "trailing paren" entry in `whatsapp-webview-exposure.md`'s dirt table. Now
   explained. **FIXED** as part of the replacement design: `mdLinkPattern` is now `/g`, pinned
   by a failing-first regression test in `form.test.js` ("unwraps EVERY markdown link, not just
   the first", "does not leak a link fragment into the following value").

   **Measured blast radius of the fix (vprod, read-only, 2026-08-17).** 49 live fields have
   more than one markdown link in a single description; **46 of them parse differently** under
   `/g`. All 46 are `webview`. None goes from working to broken:

   | | fields | why it does not matter |
   |---|---|---|
   | `virtuallab-videos.netlify.com` | **45** | the dead 404 host. The URL could not load before the fix and cannot after it. Shortcodes `mosulpilot5`, `mosulrctest{,2,3}`, `mosultest5`, `rolling{,2}`, `testplac{,3}`, `twozero` — all dormant, last activity 2022. |
   | `survey.alchemer.com` | **1** | `gwmarijuanascreener`, and this one IS live — 9,658 participants, last activity 2026-07-03. But the URL is **already broken both ways**: Typeform autolinked the researcher's URL into two overlapping links, so the old parse yields a trailing literal `[…](…)` fragment and the new parse yields the destination doubled. Neither loads. The field is `keepMoving: true`, so the conversation does not hang either way. |

   So the fix strictly removes literal markdown garbage from outbound URLs and repairs nothing
   that was working. **Worth raising separately with the owner:** `gwmarijuanascreener` has
   been serving a broken "Take Survey" button to a 9,658-participant study, and no code change
   can fix it — the corruption is in the stored Typeform description and needs a re-author.
   **Note the divergence this creates:** the separately-published
   `@vlab-research/translate-typeform` carries the identical non-global regex at `index.js:12`,
   and `facebot/testrunner/mox.ts` builds its expected messages with it. They agree on every
   current fixture — no fixture has more than one markdown link in a single description, which
   was checked rather than assumed — but a future fixture with two would break the integration
   suite's equivalence check. The package should get the same one-character fix.
2. **`{{hidden:userid}}` is a documented hazard with zero live instances** — 0 of 570 moviehouse
   fields, and only 3 survey rows repo-wide mention it, all 2021-era and non-moviehouse. The
   `moviehouse/README.md` warning is correct but describes a trap nobody has fallen into.
3. **411 of 570 fields (72%) omit `userId` entirely, and since 2025-11-09 that hard-fails the
   page.** Commit `126cbc7e` inverted the default: omitting `userId` used to select the
   Messenger-Extensions path, and now it fails `validateRequiredParams()` unless
   `useExtensions=true` — which **zero surveys author** (0 of 570 fields, and 0 of all 5149
   survey rows mention it). Blast radius on *currently active* surveys is nonetheless **zero**:
   408 of the 411 are on the already-dead `.netlify.com` host, and the remaining 3 are a nandan
   test survey. Worth recording because 411 stored fields encode the pre-`126cbc7e` contract.
   **Adopting `type: moviehouse` incidentally fixes all of them** — replybot always writes
   `vlab_user`, and moviehouse's required-params check now runs over the resolved participant
   rather than over a literal `userId` param.
4. **One `buttonText` exceeds WhatsApp's 20-char `cta_url` cap** — `test@test.com` / `Ep5wnS`,
   23 chars. Messenger-only owner, so not a live exposure. The other 569 are ≤16.
5. **The phantom `states` row** at `(101435865704727, 15126808320)`, `BLOCKED`, is still in
   production. Observed only; no mutation proposed here.

### The priority this measurement changes

The `.netlify.com` rewrite outranks this work. **490 fields point at a host that returns 404**,
all of them waiting on an event that can never arrive. `tracked: true` on a dead host is
correct and useless. The allowlist entry is the cheap half; rewriting `.netlify.com` →
`.netlify.app` across 64 surveys (or retiring them) is the half that restores function — and it
also resolves the host problem for 408 of the 411 `userId` hard-fails. That is a product
decision about whether those surveys are still wanted.

## Non-goals

- ~~**Not a values change.**~~ **SUPERSEDED — it is one.** moviehouse still deploys from
  Netlify (site `virtuallab-videos`, `main` → production, `staging` branch →
  `staging--virtuallab-videos.netlify.app`) on a different track from everything else here.
  But replybot now needs the participant-facing address to build URLs against, so
  `MOVIEHOUSE_URL` is declared in the `replybot.env` block of both values files. The Netlify
  side is unchanged; the cluster side gained one variable.
- **No fixture is migrated to the new field types.** `facebot/testrunner` and `smoke-test`
  fixtures are left alone, and the reason survives the redesign intact: `mox.ts` builds
  expected messages with the separately-published `@vlab-research/translate-typeform`, which
  knows only `webview` (`translate-fields.js:375`) and has no `link_tracking` or `moviehouse`
  translator, so a migrated fixture would break the equivalence check. Both suites are
  unaffected by the change — every fixture is a hand-authored `webview`, which is exactly the
  path the new design leaves byte-identical.
- Requiring `account_id`/`platform` in `validateRequiredParams()` is **not** done — it would
  hard-fail the page for every legacy URL and kill video tracking.
