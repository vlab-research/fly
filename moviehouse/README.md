# Moviehouse

A lightweight video hosting web application that embeds Vimeo videos in Messenger WebView. Part of the Fly ecosystem, Moviehouse provides a seamless video viewing experience for chatbot users.

## Usage

### Opening Videos from Fly Chatbot

Fly surveys use a `moviehouse` field type to play videos. The researcher supplies
only the video id; replybot builds the entire URL with the conversation identity
(`vlab_user`, `vlab_account`, `vlab_platform`) baked in:

```yaml
type: moviehouse
videoId: "164118668"
buttonText: Watch the video
```

The equivalent query-string URL that replybot produces:

```
https://virtuallab-videos.netlify.app/?vlab_video={VIDEO_ID}&vlab_user={PARTICIPANT}&vlab_account={ACCOUNT_ID}&vlab_platform={PLATFORM}
```

**Required by replybot when building a `moviehouse` field:** none — the researcher
writes only the video id. Replybot derives everything else from the conversation.

**Legacy hand-authored `webview` fields** (pre-migration, pointing at moviehouse URLs
directly) work unchanged if they carry all three components `(user, account, platform)`;
see [Conversation identity](#conversation-identity).

**Optional Parameters for legacy hand-authored URLs:**
- `useExtensions=true` - Resolve the PSID via Messenger Extensions instead of
  the URL. Only then is a `userId` unnecessary.
- `account_id` - The messaging account this conversation belongs to. Preferred
  over `pageId`.
- `platform` - `messenger` or `whatsapp`. Required for correct routing.

### The two modes — and legacy hand-authored URLs

`script.js` branches on the `useExtensions` query param at `DOMContentLoaded`:

| URL | Mode | Behavior |
|-----|------|----------|
| *(no `useExtensions`)* — **the default** | Direct | `validateRequiredParams()` demands the resolved `vlab_video`, `vlab_account`, **and `vlab_user`** (or legacy aliases), then plays with the PSID straight from the URL. |
| `useExtensions=true` | Messenger Extensions | `MessengerExtensions.getContext()` resolves the PSID; `userId` in the URL is ignored. Requires the domain to be whitelisted on the Facebook App. |

In direct mode, omitting the required params fails closed with
**"Required parameters are missing: {canonical names}. Please make sure you opened this
link correctly."** — the page never loads the player.

All new `moviehouse` fields built by replybot include all required params, so this
is a safety net for hand-authored URLs only. Legacy fields that omit one or more
components will show this error. Migrating them to `type: moviehouse` fixes them
immediately, since replybot stamps all three.

### Example

**New way (recommended):**

```yaml
type: moviehouse
videoId: "164118668"
buttonText: Watch the video
keepMoving: true
```

That is the entire field. There is no participant id to pass, no page id to copy
from another survey, and no platform to infer — Fly knows which conversation it is
sending into, and stamps all three into the URL itself.

**Legacy hand-authored `webview` fields** continue to work if they are complete:

```json
{
  "type": "webview",
  "url": "https://virtuallab-videos.netlify.app/?id=164118668&pageId=101435865704727&userId={{hidden:id}}&platform=messenger",
  "buttonText": "Watch the video",
  "extensions": true,
  "keepMoving": true
}
```

A legacy `webview` that omits any required component will fail with the missing-parameter error.
Migrating to `type: moviehouse` fixes it immediately.

### On WhatsApp

The page itself needs no changes: the default direct mode reads the PSID from
the URL, so it works in the phone's ordinary browser with no Messenger
Extensions. For `moviehouse` fields, replybot stamps `vlab_account` as the
WhatsApp `phone_number_id` and `vlab_user` as the user's phone number.

**For legacy hand-authored URLs**, the platform must be supplied explicitly.
Nothing downstream recovers it: the state cache is keyed `state:{platform}:{account_id}:{user}`
from the **event envelope**, looked up before `transition.js` runs. So a WhatsApp
moviehouse event with no `platform` param causes outbound commands to be built for
the wrong transport. Migrating to `type: moviehouse` fixes this, since replybot
always stamps the platform from the live conversation.

What differs is how the *button* is delivered. Messenger gets a `web_url` button
template; WhatsApp gets an interactive `cta_url` message, whose button label is
capped at **20 characters** — over that, the send fails outright rather than
truncating. Keep `buttonText` short for any survey that runs on WhatsApp. See
`../documentation/platform-abstraction.md` → *webview → `cta_url`*.

### Tracked Events

All video interactions are automatically sent back to the Fly server:
- `moviehouse:play` - Video starts playing
- `moviehouse:pause` - Video paused
- `moviehouse:ended` - Video finished
- `moviehouse:seeked` - User skipped to different time
- `moviehouse:volumechange` - Volume adjusted
- `moviehouse:playbackratechange` - Playback speed changed
- `moviehouse:error` - Video error occurred

Plus `moviehouse:heartbeat` **every 30 seconds while the video is playing** — see
`HEARTBEAT_IMPLEMENTATION_PLAN.md`. That interval is why moviehouse is the
highest-frequency per-participant event producer in the system while a video plays,
and why the design choices below are stricter than linksniffer's.

## Conversation identity

moviehouse is a **producer of `chat-events`** — the seventh service that POSTs to
hermes' `/synthetic` endpoint — and it is bound by the same contract as the other
six: every event must carry the conversation triple `(platform, account_id,
user_id)`. See `../documentation/event-envelope.md`.

It was missed in the original audit of that contract because **it is a browser
page deployed from Netlify, not a cluster service.** The enumeration method the
plan prescribes — grep `BOTSERVER_URL` across `devops/values/*.yaml` — cannot see
it: its endpoint lives in `netlify.toml` as `SERVER_URL`, mustache-substituted into
`src/script.js` at build time. Any future audit of the producer set has to include
this directory explicitly.

### The POST body

```jsonc
POST {SERVER_URL}
{
  "user":       "<psid or wa_id>",        // from `vlab_user`; resolves legacy `userId`
  "account_id": "<account>",              // from `vlab_account`; resolves legacy `pageId`, `account_id`
  "page":       "<account>",              // deprecated alias, retained deliberately
  "platform":   "messenger" | "whatsapp", // from `vlab_platform`; resolves legacy `platform`. OMITTED if absent.
  "data":       { /* the Vimeo event payload, or { currentTime } */ },
  "event":      { "type": "external", "value": { "type": "moviehouse:<event>", "id": "<videoId>" } }
}
```

`page` is kept alongside `account_id` because the historical `messages` backfill
reads the account out of archived `messages.content` under the per-shape name — see
event-envelope.md, "Nothing was removed". The canonical `vlab_*` param names are
resolved in `src/identity.js` by `resolveConversation(params)` and its helpers,
which read the canonical names first and fall back to the legacy ones for URLs
already in circulation.

### Two paths produce those params, and only one is trustworthy

| Path | `platform` | Correct? |
|---|---|---|
| `moviehouse` field type — replybot stamps `vlab_user`, `vlab_account`, `vlab_platform` from the live conversation | from `ctx.platform` | always |
| legacy hand-authored `webview` URL — researcher supplies params directly | **must be supplied by researcher; absent → omitted** | only if the researcher got it right |

### An absent platform is omitted, never assumed

This is the one place moviehouse deliberately **diverges from linksniffer**, which
assumes `platform=messenger` and logs `[LINKSNIFFER_PLATFORM_ASSUMED]`. Four
reasons:

1. **Absent degrades; wrong hangs.** An event carrying an account and no platform
   bypasses the state cache and still gets an account-scoped replay, so the
   conversation advances — just slower. A *wrong* platform addresses a conversation
   that does not exist, so a `wait` on `moviehouse:play` never resolves and the
   outbound commands are built for the wrong transport.
2. **Volume inverts linksniffer's calculus.** linksniffer posts once per click. At
   one heartbeat every 30 seconds an assumption is not a one-shot risk; it is a
   continuous stream of mis-addressed events.
3. **Omission is already counted; assumption needs an instrument that does not
   exist.** An absent platform lands on hermes' `[INCOMPLETE_CONVERSATION]`, which
   *is* the rollout's step-3 counter and drains to zero as surveys adopt the
   `moviehouse` field type.
   An assumed platform stamps cleanly and passes the gate — only hermes' **verify**
   mode would see it, and verify mode is designed but not built.
4. **The gate makes omission self-limiting.** `SYNTHETIC_REQUIRE_CONVERSATION` may
   only be turned on once `[INCOMPLETE_CONVERSATION]` reads zero, and that condition
   *is* "no moviehouse event omits a platform". "Gate on **and** platform absent" is
   contradictory by construction; "gate on and platform silently wrong" is the
   steady state an assumption would create.

A `platform` param that is present but **not a known transport** is dropped rather
than forwarded — including a casing mismatch like `Messenger` and the non-platform
`synthetic`. The value becomes a component of the conversation identity downstream,
so a typo would be a poisoned cache key. It is dropped, not defaulted.

### Log tags

Both are `console.warn`, emitted **once per page load** rather than once per event —
a heartbeat every 30 seconds plus play/pause/seek would otherwise flood the console
for a single watcher.

| Tag | Meaning | Action |
|---|---|---|
| `[MOVIEHOUSE_CONVERSATION_INCOMPLETE]` | no `account_id`/`pageId`, or no valid `platform` | change the survey field's type to `moviehouse` |
| `[MOVIEHOUSE_PLATFORM_INVALID]` | `platform` present but not a known transport; none is sent | fix the survey's link params |

These are browser-side, so they are **not** greppable in cluster logs the way
linksniffer's are. The server-side counter for the same condition is hermes'
`[INCOMPLETE_CONVERSATION]`.

### Migration status

Measured in `vprod` 2026-08-17: **82 live surveys / 570 fields / 4 researchers, every
one still a hand-authored `webview`.** WhatsApp-capable owners account for 36 surveys / 178
fields (`worldbank@vlab.digital`, `nandanmarkrao@gmail.com`);
`mchatila@worldbank.org` owns 391 fields, all on the dead legacy host.

**Every one of the 82 surveys contains at least one field that `wait`s on a
moviehouse event** — 410 fields wait on `moviehouse:play` with no timeout and
therefore **hang** rather than degrade; only 126 carry an `op: or` timeout that can
self-recover. This is the opposite of linksniffer's profile, where most fields were
`keepMoving` and only 19 waited on the event.

**The WhatsApp exposure is not hypothetical.** On 2026-08-13 a `hpvbl` conversation
served over WhatsApp stitched into `hpvmedia`, whose `doctor_video` field hardcodes
`pageId=101435865704727` — a *Messenger* page. moviehouse echoed that back as `page`,
the `moviehouse:play` was routed to a phantom conversation on the Facebook page keyed
by the participant's phone number (that `states` row is still `BLOCKED` in
production), and the real WhatsApp conversation never received its event. 465 of 570
fields hardcode `pageId`; only 2 interpolate it. Full trace and SQL in
`../planning/moviehouse-conversation-identity.md`.

### Used by the Fly smoke test

The production smoke survey (`../smoke-test/`, `form-a.json` → `movie_webview`)
opens this player via a `webview` button and `wait`s on the `moviehouse:play`
event, then branches on the flattened `e_moviehouse_play_id` hidden field with
logic. See `../smoke-test/README.md` → "The moviehouse section" for the full
wiring and the string-`id` matching gotcha. This is the canonical live example
of reacting to moviehouse events.

### Browser Requirements

**Mobile:** Must be viewed in the Messenger mobile app
**Desktop:** Can be viewed at messenger.com in a modern browser

These constraints apply to **Messenger Extensions mode** (`useExtensions=true`),
where the page displays browser/forbidden errors (`2071010`, `2071011`) if
opened outside a Messenger conversation. In the default direct mode the PSID
comes from the URL, so any browser can open the link.

## Hosts

moviehouse deploys from Netlify, not the cluster. Replybot owns the URL end to end,
so it learns the correct hostname from config — no allowlist, no per-service logic,
just an environment variable in `devops/values/{production,staging}.yaml`:

| Environment | URL | Replybot env var | HTTP |
|---|---|---|---|
| Production (`vprod`) | `virtuallab-videos.netlify.app` | `MOVIEHOUSE_URL` | **200** |
| Staging (`vstag`) | `staging--virtuallab-videos.netlify.app` | `MOVIEHOUSE_URL` | **200** |

Replybot writes these exact hostnames into every new `moviehouse` field's URL.

### Dead hosts and lessons from the old allowlist

Two legacy hosts are unreachable today, and both illuminate why replybot owns the URL:

- **`virtuallab-videos.netlify.com`** (retired alias, not a redirect): 404. Carries **490 of 570** live moviehouse fields (`vprod`, 2026-08-17) — 86% of the entire corpus — and was never in any values file.
- **`gbvlinks.nandan.cloud`** (linksniffer legacy host): TLS fails. Resolves to the cluster ingress IP, but no Ingress claims the hostname, so nginx serves the ingress controller's self-signed "Kubernetes Ingress Controller Fake Certificate". Carries 193 of 346 production tracked-link fields.

Every field on those hosts is permanently broken. The `.netlify.com` transition teaches
two lessons:

1. **An allowlist of researcher-typed hostnames rots.** The superseded design had replybot
   match the host a researcher had typed against a hand-maintained list. A list like that can
   only ever describe the past: it is static until someone edits it, and nothing makes an
   entry go stale visibly. Both of its entries that mattered turned out to be *dead* —
   `.netlify.com` 404s while carrying 490 fields, and `gbvlinks.nandan.cloud` fails TLS while
   carrying 193, having been missing from the list entirely. replybot using **its own**
   configured host needs no list and cannot rot.
2. **Netlify branch deploys made the list unbounded.** Netlify serves
   `<branch>--virtuallab-videos.netlify.app` for *every* branch, so an allowlist needed a new
   entry for each one. Static-site deploys from Netlify are fast; a cluster config change is
   not, so the list was structurally always behind. Under the current design a branch deploy
   is just a different `MOVIEHOUSE_URL`, which is what an environment variable is for.

## Structure

Four source files, no bundler, no framework. `gulp replace` mustache-substitutes
`netlify.toml`'s environment into `src/` and writes `dist/`.

| File | Role |
|---|---|
| `src/identity.js` | **Pure core.** `resolveUser`, `resolveVideoId`, `resolveConversation` and `buildSyntheticBody`, plus the canonical param names. No DOM, no network, no globals; total. |
| `src/script.js` | **Imperative shell.** Reads the query string, initialises Sentry and the Vimeo player, logs the two diagnostics once, POSTs. |
| `src/index.html` | Loads Vimeo's player, Sentry, then `identity.js` **before** `script.js` — `script.js` reads `MoviehouseIdentity` at parse time. |
| `src/style.css` | — |

`identity.js` is loaded two ways from one file: as a browser global
(`MoviehouseIdentity`) via a `<script>` tag, and as a CommonJS module by the test.
The `typeof module` guard at the top is what makes both work with zero build
tooling. `gulpfile.js` lists its sources explicitly rather than globbing `src/`,
so `identity.test.js` is never shipped to `dist/`.

Mustache placeholders (`{{{SERVER_URL}}}`, `{{{HEARTBEAT_INTERVAL_MS}}}`,
`{{{APP_ID}}}`) live only in `script.js`. That is the reason for the split beyond
tidiness: an un-substituted `script.js` cannot be `require`d in Node (the
placeholders are harmless, but `Sentry.init` and `new URL(window.location)` run at
load), so the logic under test has to live outside it.

## Testing

**moviehouse has no test framework of its own** — no mocha, no jest, no karma, no
CI workflow. Rather than add one for two pure functions in a three-file static
site, `src/identity.test.js` runs on **Node's built-in test runner**, which needs
zero dependencies:

```bash
cd moviehouse
npm test          # node --test src/
```

19 tests, covering `account_id` preferred over `pageId`, whitespace-only params
treated as absent, the rejection of unknown/mis-cased platforms, that no platform
is ever assumed, and that an unresolved component is omitted from the body rather
than sent empty.

This diverges from the repo's mocha/chai convention (`replybot`, `dashboard-*`)
deliberately, to avoid adding a dependency tree here. If moviehouse ever grows a
real test suite, converting these to mocha is mechanical.

There is **no browser-level test** of the player wiring; the checklist in
`HEARTBEAT_IMPLEMENTATION_PLAN.md` § "Testing Checklist" is still manual, and the
end-to-end coverage is the production smoke survey described above.

Lint:

```bash
npm run lint      # eslint src gulpfile.js
```

`.eslintrc.js` is browser-env with `ecmaVersion: 2018`, so **no `??` and no `?.`** —
they will not parse. `gulpfile.js` and `*.test.js` are overridden to the Node env.

## Deployment

**moviehouse does not deploy from this cluster.** It is a Netlify site, so it ships
on a completely different track from every other service in this repo.

| | |
|---|---|
| Netlify site | `virtuallab-videos` (ID `40af3fe3-4d9c-4bb2-aaa8-e4f6d3c373fc`) |
| Production | branch `main` → `virtuallab-videos.netlify.app` |
| Staging | branch `staging` → `staging--virtuallab-videos.netlify.app` |
| Build | `gulp replace` (the `start` script), output `dist/` |
| Config | `netlify.toml` — `APP_ID`, `SERVER_URL`, `HEARTBEAT_INTERVAL_MS` per context |

Deploying is: merge to `staging` (or `main`), let Netlify build, and verify.
See `../documentation/staging.md` for the site's branch/context mapping and the
Facebook App domain whitelisting that Messenger Extensions mode needs.

The repo has a **`netlify-check`** capability for polling deploy status. Note that
it is written for the `vlab-research` site (the dashboard), so it will need the site
name pointed at `virtuallab-videos` to be useful here.

### The moviehouse↔cluster boundary is named in two places

Replybot owns the URL end to end, so moviehouse's production address is declared in
replybot's config, not in this directory:

- **Cluster side** — `devops/values/production.yaml`: `replybot.env.MOVIEHOUSE_URL = "https://virtuallab-videos.netlify.app"` (and staging equivalent)
- **Netlify side** — `moviehouse/netlify.toml`: `SERVER_URL` (mustache-substituted into `src/script.js`), which posts to hermes at `https://fly-botserver.vlab.digital/synthetic`

Moviehouse's own `SERVER_URL` and replybot's `MOVIEHOUSE_URL` are independent config
values in independent files in independent systems. Both have to be correct for the
round trip to work. If moviehouse's `SERVER_URL` is wrong, it posts events nowhere.
If replybot's `MOVIEHOUSE_URL` is wrong, the button goes nowhere.

### Deploy-order independence is designed in

Replybot ships to the cluster, moviehouse ships from Netlify, so the order cannot be
guaranteed. **This is safe**: replybot stamps the canonical `vlab_*` params alongside
their legacy aliases (`userId`, `pageId`), so moviehouse always finds the right values
regardless of deploy order.

**`SYNTHETIC_REQUIRE_CONVERSATION` must stay off until surveys are migrated.**
Turning it on earlier 400s every moviehouse event and kills video tracking outright.
That gate is what unblocks the migration — see `../documentation/event-envelope.md`.

## See also

- `../documentation/event-envelope.md` — the `/synthetic` contract and the producer set
- `../documentation/questions.md` § "Videos (Moviehouse)" — how a researcher authors one
- `../linksniffer/README.md` — the other first-party page replybot stamps, and where its choices differ
- `../planning/moviehouse-conversation-identity.md` — why the platform is omitted rather than assumed
- `../documentation/staging.md` — the Netlify site and its branch contexts