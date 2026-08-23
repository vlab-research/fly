# Fly Smoke Test (production survey)

A pair of **real Typeform surveys** deployed to production Typeform and walked
through by a human via the Messenger `m.me` link. Unlike the automated tiers
(`documentation/testing.md`: testcontainers + k8s smoke), this exercises the
*live* production pipeline end-to-end — the actual page, tokens, replybot,
message-worker, dinersclub, dean, and the external services (Reloadly,
smoke-echo, moviehouse) — the way a real respondent would.

- `form-a.json` → shortcode **`flysmoke`** — the main feature gauntlet.
- `form-b.json` → shortcode **`flysmokeb`** — reached via a stitch from A; tests
  the timeout / dean-followup path.
- `deploy.py` — thin Typeform API client (create / update / delete / status /
  refs). Form IDs persist in `.ids`; `TYPEFORM_TOKEN` comes from `.env`.
- `../smoke-echo/` — the second Facebook App used only for the thread-control
  handoff round trip (see its README).

## Running it

```bash
python3 deploy.py update form-a      # push local form-a.json to Typeform
python3 deploy.py refs form-a        # print field/choice refs (verify logic targets)
python3 deploy.py status             # ids, urls, field/logic counts
```

Then open the survey on the smoke page: `m.me/<PAGE>?ref=form.flysmoke` and walk
it. Every path converges through the media + moviehouse sections and stitches
into Part B, so a single run covers everything below.

> **Every `{{hidden:X}}` must also appear in the form's top-level `hidden`
> array**, or `update` fails with HTTP 400 `INVALID_PIPING` / *"Invalid
> reference {{hidden:X}}"* naming the offending field index. Typeform only
> validates *declaration*, not whether replybot can actually resolve the key at
> runtime — an undeclared pipe is a loud 400, a declared-but-meaningless one
> (e.g. `{{hidden:userid}}`) deploys fine and silently interpolates to `""`.
>
> After editing choice `ref`s, always run `deploy.py refs` — Typeform can
> reassign refs on update and silently break logic jumps.

## Deploying a form (read this before your first `update`)

### `update` is a whole-form replace, not a patch

`cmd_update` (`deploy.py:128-138`) issues a single `PUT /forms/{id}` carrying
the entire local JSON. Typeform replaces the form wholesale: **anything present
on the live form but absent from the local file is deleted** — fields, logic
blocks, hidden keys, settings alike. There is no merge, no dry-run, and no
confirmation prompt; the only output is `form_a: updated id=QJ6d4JHE`.

The practical consequence: **`form-a.json` is the sole source of truth. Never
edit these forms in the Typeform UI** — the next `update` silently reverts it,
and because the command is quiet you will not find out until a smoke run fails.

Both inputs are gitignored, so a fresh checkout has neither:

| File | Contents | If missing |
|---|---|---|
| `smoke-test/.env` | `TYPEFORM_TOKEN=<personal access token>` | `Error: TYPEFORM_TOKEN not set` |
| `smoke-test/.ids` | `{"form_a": "QJ6d4JHE", "form_b": "Bkmy2zMh"}` | `update` has no target; use `create` (which writes `.ids`) |

### A live-vs-local diff always reports every field as changed

Worth knowing before you write a pre-flight check, because the raw comparison is
almost pure noise — the API returns two classes of key the local file never
carries:

| Key | Why it differs | Real drift? |
|---|---|---|
| `fields[].id` | Typeform mints one per field | **No** — all fields, always |
| `fields[].properties` | server injects defaults (`randomize:false`, `allow_other_choice:false`, `none_of_the_above:false`) plus a `choices[].id` each | **No** |
| `fields[].title` | your content | **Yes** |
| `fields[].properties.description` | your content — the custom-type JSON blob | **Yes** |
| `logic` | your jumps | **Yes** |

On a 33-field form that is 33 `id` diffs and ~14 `properties` diffs with zero
meaning. Compare **semantically**: titles, `properties.description`, and
`logic`. Ignore `id`, and ignore any live-only property whose value is
`false`/empty — those are server defaults, not content you are about to lose.

### Pre-flight: what would this push actually change?

Run this before any `update`. It prints only the diffs that mean something, so
empty output = the push is a no-op:

```bash
python3 - <<'PY'
import json, os, urllib.request
for line in open('.env'):
    if '=' in line and not line.startswith('#'):
        k, v = line.strip().split('=', 1); os.environ.setdefault(k.strip(), v.strip())
fid = json.load(open('.ids'))['form_a']          # form_b for the other one
req = urllib.request.Request(f'https://api.typeform.com/forms/{fid}',
                             headers={'Authorization': "Bearer " + os.environ['TYPEFORM_TOKEN']})
live = json.load(urllib.request.urlopen(req)); local = json.load(open('form-a.json'))
lf = {f['ref']: f for f in live['fields']}; cf = {f['ref']: f for f in local['fields']}
for r in sorted(set(lf) - set(cf)): print(f'DELETED BY PUSH: {r}')
for r in sorted(set(cf) - set(lf)): print(f'ADDED:           {r}')
for r in sorted(set(lf) & set(cf)):
    if lf[r].get('title') != cf[r].get('title'): print(f'TITLE:           {r}')
    if lf[r].get('properties', {}).get('description') != cf[r].get('properties', {}).get('description'):
        print(f'DESCRIPTION:     {r}')
    lost = {k: v for k, v in lf[r].get('properties', {}).items()
            if k not in cf[r].get('properties', {}) and k != 'choices' and v not in (False, '', None)}
    if lost: print(f'PROPERTY LOST:   {r} {lost}')
if json.dumps(live.get('logic')) != json.dumps(local.get('logic')): print('LOGIC differs')
PY
```

`DELETED BY PUSH` or `PROPERTY LOST` means someone edited the live form outside
the repo — reconcile before pushing, or you will destroy their change.

### Choice `ref`s are re-minted on every push

The warning above has a mechanism worth spelling out. Choices written without a
`ref` in the local JSON (`{"label": "MTN Nigeria"}`) arrive as `ref: null`, so
**Typeform mints a fresh ULID for them on every `PUT`** — the live refs change
under you at each deploy, even when the labels do not.

That is harmless *only* while nothing references them. The hazard is a choice
that has **no explicit `ref` in the repo** but whose server-minted ULID *is*
referenced — that jump breaks on the next unrelated deploy, far from the change
that caused it. This check finds exactly that case:

```bash
python3 - <<'PY'
import json, os, urllib.request
for line in open('.env'):
    if '=' in line and not line.startswith('#'):
        k, v = line.strip().split('=', 1); os.environ.setdefault(k.strip(), v.strip())
fid = json.load(open('.ids'))['form_a']
req = urllib.request.Request(f'https://api.typeform.com/forms/{fid}',
                             headers={'Authorization': "Bearer " + os.environ['TYPEFORM_TOKEN']})
live = json.load(urllib.request.urlopen(req)); local = json.load(open('form-a.json'))
lf = {f['ref']: f for f in live['fields']}; whole = json.dumps(live)
risk = False
for f in local['fields']:
    lch = {c.get('label'): c.get('ref') for c in f.get('properties', {}).get('choices', [])}
    for c in lf.get(f['ref'], {}).get('properties', {}).get('choices', []):
        if lch.get(c.get('label')) is None:            # no explicit ref in the repo
            uses = whole.count(c['ref']) - 1           # minus its own definition
            if uses:
                risk = True
                print(f"AT RISK: {f['ref']}.{c.get('label')} — server ref {c['ref']} used {uses}x")
print('OK — every referenced choice has an explicit ref in form-a.json' if not risk else 'FIX: pin those refs')
PY
```

Note the check that does *not* work: flagging every choice ref referenced more
than once. That fires on `choice_red`, `choice_env_staging` and friends — which
are the **correct** pattern (explicit ref in the repo, stable across pushes),
not a problem.

`operator` is the standing counter-example: four unref'd choices, no logic keyed
on them, so its ULIDs churn freely and harmlessly. **Give a choice an explicit
`ref` the moment any logic targets it.**

## Coverage matrix

Each field/section maps to a Fly feature. Types come from
`replybot/lib/generic-translator.js` (outbound) and
`replybot/lib/event-normalizer.js` (inbound). "Custom types" are driven by a
JSON/YAML blob in a field's `properties.description` (parsed by
`addCustomType` in `replybot/lib/typewheels/form.js` — a YAML load, so JSON is
accepted).

| Section (field refs) | Feature exercised | Type / mechanism |
|---|---|---|
| `welcome` | Bot-sent **image** attachment + auto-advance | `attachment` (`keepMoving`) |
| `favorite_color`, `test_payment`, `try_again`, `test_handoff`, `test_utility`, `test_attachments` | Quick-reply questions + **field logic jumps** | `multiple_choice` |
| `why_red` / `feedback` (B) | Free-text answer | `short_text` |
| `siblings` | Numeric answer + validation | `number` |
| `phone` | Phone answer + normalization | `phone_number` |
| `payment_wait` → `payment_success`/`payment_failure` | **Payment** (Reloadly) via `wait: external` + **hidden-field logic** | `wait` / `payment:reloadly`; branch on `e_payment_reloadly_success` |
| `handoff_statement` → `handoff_result` | **Thread-control handoff** round trip + metadata flattening | `handoff`; interpolates `e_handover_metadata_*` (needs `smoke-echo`) |
| `test_utility` → `utility_message` | Facebook **UTILITY template** message, gated behind a yes/no like `test_payment`/`test_handoff` — answering No skips straight to `test_environment` (choices must match the page's approved button labels — [see below](#the-utility_message-field-page-specific-not-env-specific)) | `multiple_choice` → `utility_message` |
| `test_environment` | **Env pick, asked once up front.** Drives *two* branches: the five environment-scoped media fields (`media_third_party_url` logic) and the moviehouse webview host (`confirm_attachment` logic). Both exist because the same Typeform form is deployed to prod and staging, while asset rows, attachment ids and the moviehouse player host are all per-environment | quick-reply; read by `media_third_party_url` and `confirm_attachment` logic |
| `test_attachments` → `media_third_party_url` → `media_legacy_attachment_id_<env>` → `media_asset_image_<env>` → `media_asset_repeat_<env>` → `media_asset_video_<env>` → `media_asset_file_<env>` → `confirm_attachment` | Six media-abstraction paths back to back, gated behind a yes/no — the question text warns the sends are slow so the pause after tapping Yes isn't mistaken for the bot hanging; answering No skips the whole block straight to the moviehouse webview. One shared third-party field, then a five-field prod or staging chain — see [Media fields](#media-fields-what-each-one-proves) below | `multiple_choice` → `attachment` (`keepMoving`), one legacy `attachment_id`, one not-uploaded `url`, four uploaded-asset `url`s |
| `confirm_attachment` | **Did they actually arrive?** A failed send is reported and its offset committed, so the survey walks on regardless — this is the only signal that a media send silently failed. Also carries the env branch into the moviehouse webview | `multiple_choice` |
| `movie_webview_prod`/`movie_webview_staging` → `movie_watched`/`movie_timeout` | **Webview button → moviehouse external events → logic reacting to them** (works in prod & staging); branched from `test_environment` by `confirm_attachment` | `webview` + `wait{op:or,[external moviehouse:play, timeout]}`; branch on `e_moviehouse_play_id` |
| `test_links` → `link_new` → `link_legacy_<env>` → `movie_new` → `confirm_links` | **The conversation triple on first-party URLs** — the four link/webview paths, old and new, gated behind a yes/no. Proves an absent platform is *assumed* rather than dropped, and a stamped one is carried through. See [Conversation identity](#conversation-identity--the-four-link-paths) | `multiple_choice` → `link_tracking`, hand-authored `webview`, `moviehouse`; `wait{op:or,[external linksniffer:click, timeout]}` |
| `stitch_statement` | **Form stitch** A → B | `stitch` |
| `test_timeout` → `timeout_wait` → `welcome_back` (B) | **Timeout / dean followup** | `wait: timeout` |

Interpolation (`{{field:…}}`, `{{hidden:…}}`) is exercised throughout
(payment error, handoff metadata, picture URL, moviehouse video id).

### Not yet covered (known gaps)

Lower-value or harder-to-drive types remain untested here: additional question
types (`yes_no`/`legal`, `opinion_scale`, `rating`, `dropdown`, `email`,
`long_text`, `date`, `picture_choice`, multi-select), the `share` button, `optin`
/ one-time-notification, and `user_reaction` (message emoji reacts, which the
machine intentionally ignores). Add them if a regression ever touches those
paths.

## Conversation identity — the four link paths

A conversation is `(platform, account_id, user_id)`. Every first-party URL has to
produce all three, including the URLs already sitting in participants' inboxes
that predate `vlab_platform` entirely. There are exactly four shapes, and this
survey drives all four:

| # | path | field | what it sends | expect stored |
|---|---|---|---|---|
| 1 | legacy linksniffer | `link_legacy_prod` / `link_legacy_staging` | `id`, `pageid`, **no platform** | `platform = messenger` (**assumed**) |
| 2 | new linksniffer | `link_new` | `vlab_user`, `vlab_account`, `vlab_platform` | the **stamped** value |
| 3 | legacy moviehouse | `movie_webview_prod` / `movie_webview_staging` | `id`, `pageId`, `userId`, **no platform** | `platform = messenger` (**assumed**) |
| 4 | new moviehouse | `movie_new` | `vlab_video` + the triple | the **stamped** value |

**Why only the legacy fields are environment-split.** Paths 2 and 4 are field
*types* (`link_tracking`, `moviehouse`) whose URL replybot owns end to end — the
base comes from `LINKSNIFFER_URL` / `MOVIEHOUSE_URL` in each cluster's values
file, so one field serves both environments and there is no page id for a
researcher to hardcode. Paths 1 and 3 are hand-authored `webview`s with the host
written in, so they need a prod and a staging copy, picked by `test_environment`.

### Verifying it — the survey cannot check this itself

Nothing a participant sees reveals which platform was recorded, so `confirm_links`
only asks whether the redirects worked. **The actual assertion is in the event
stream.** After a run, with the participant's user id:

```sql
SELECT "timestamp" AS at, platform, account_id,
       content::JSONB->'event'->'value'->>'type' AS event
  FROM chatroach.messages
 WHERE userid = '<participant user id>'
   AND content::JSONB->'event'->'value'->>'type'
       IN ('linksniffer:click', 'moviehouse:play')
 ORDER BY "timestamp" DESC LIMIT 20;
```

`platform` and `account_id` must be non-NULL on **every** row — the legacy ones
included, which is the whole point. Quote `"timestamp"`: it is a reserved word and
already a `timestamptz`, so wrapping it in `to_timestamp()` errors.

Cross-check the assumption against linksniffer's own log, where an assumed
platform is tagged separately from a supplied one:

```bash
kubectl logs -n <ns> deployment/gbv-linksniffer | grep LINKSNIFFER_PLATFORM_
```

`LINKSNIFFER_PLATFORM_ASSUMED` on the legacy paths is expected and is the legacy
tail being measured. `LINKSNIFFER_PLATFORM_INVALID` is **not** expected from this
survey at all — see below.

### An invalid platform is refused, not coerced

Since linksniffer v0.0.9, an unrecognised `vlab_platform` returns **400** instead
of quietly becoming messenger. Only *absent* is assumed. replybot writes that
param from `ctx.platform`, so a well-formed link cannot carry a bad value — an
invalid one means a hand-authored `webview` or a tampered URL, and it must break
where a tester sees it rather than become misattributed data months later.

You can confirm the deployed behaviour without running the survey:

```bash
B=https://staging.links.vlab.digital
curl -s -o /dev/null -w '%{http_code}\n' "$B/?id=probe&pageid=<acct>&url=example.com&p=https"                        # 302, assumed
curl -s -o /dev/null -w '%{http_code}\n' "$B/?vlab_user=probe&vlab_account=<acct>&vlab_platform=whatsapp&url=example.com&p=https"  # 302, stamped
curl -s -o /dev/null -w '%{http_code}\n' "$B/?vlab_user=probe&vlab_account=<acct>&vlab_platform=sms&url=example.com&p=https"       # 400, refused
```

Those probes write real rows to `messages`, so use an obviously synthetic user id.

### The assumption has an expiry date

Assuming messenger is only correct **while Messenger is the only live transport.**
When WhatsApp carries production traffic, a legacy URL (paths 1 and 3) clicked by a
WhatsApp participant addresses a Messenger conversation that does not exist — the
2026-08-13 incident, where a hardcoded `pageId` left a phantom conversation BLOCKED
in production. Before that point the legacy URLs must be gone, or the platform must
come from a `credentials.entity` lookup rather than an assumption. See the WhatsApp
launch checklist in `planning/multi-platform-plan.md`.

## The moviehouse section (webview + external events)

This is the pattern most production surveys use for video: send a **webview
button**, then **wait** on the video-player events the page reports back.

### Why it's environment-specific

moviehouse bakes its target backend (`SERVER_URL`) in at build time, so the
**production** player (`virtuallab-videos.netlify.app`) posts events to
production Hermes and the **staging** player
(`staging--virtuallab-videos.netlify.app`) posts to staging Hermes — two
different URLs. For a play event to reach the replybot running *this* survey,
the button must open the player wired to the *same* environment.

It is one of **two** environment-specific steps in the survey; the other is the
media block ([Media fields](#media-fields-what-each-one-proves)), which branches
on the same `test_environment` answer. Everything else in the smoke test is
environment-neutral (handoff even shares one smoke-echo app across both envs).

### How the form handles it — an explicit environment pick

Rather than a hidden per-environment link (which misroutes silently if you use
the wrong one), the survey **asks**. Right before the video step:

- **`test_environment`** — a quick-reply: *Production* / *Staging*.
- Logic routes the answer to one of two otherwise-identical webview fields:
  - `choice_env_staging` → **`movie_webview_staging`** (`staging--…` host)
  - else → **`movie_webview_prod`** (`virtuallab-videos.netlify.app` host)
- **Echo-back:** each field's message opens with *"Testing in PRODUCTION"* /
  *"Testing in STAGING"* so a wrong pick is visible on screen, not silent.
- Both fields **reconverge** into the same `movie_watched` / `movie_timeout`
  logic and then the stitch — the survey returns to environment-neutral flow.

Adding a future environment-specific question follows the same shape: add a
per-env variant and extend the `test_environment` branch; the env is chosen
once here.

### What each webview field does

1. Opens the player at
   `https://<host>/?id=164118668&pageId={{hidden:pageid}}&userId={{hidden:id}}`.
   **`pageId` is interpolated** from `{{hidden:pageid}}` (= `event.source.account_id`,
   set by replybot), so it is automatically the correct page in whichever
   environment the survey is running — no hardcoded page id, and staging's page
   id need not be known here. moviehouse echoes `pageId` back as `page` on every
   event so Fly routes it to the right conversation.
   **`userId` is mandatory** — moviehouse's default mode reads the PSID from the
   URL and refuses to load without it ("Required parameters are missing:
   userId"). `{{hidden:id}}` is the key that resolves to the PSID; `{{hidden:userid}}`
   is *not* a real key and interpolates to an empty string, which fails the same
   way. See `../moviehouse/README.md` → "The two modes".
2. `wait` is `op: or` over the external event `moviehouse:play` (id
   `164118668`) **or** a 3-minute timeout fallback so a run never hard-stalls.
   The wait arms when the echo of the button message returns (same mechanism as
   handoff).
3. moviehouse POSTs `{user, page, event:{type:'external', value:{type:'moviehouse:play', id:'164118668'}}}`
   to its baked-in `SERVER_URL` (`…/synthetic`). Replybot flattens the event
   into the hidden field **`e_moviehouse_play_id`** (= `"164118668"`).
4. **Logic reacts to the event**: the field's rule jumps to `movie_watched`
   when `e_moviehouse_play_id == "164118668"`, else to `movie_timeout`. That is
   the "react to a moviehouse event with logic" check.

**Dependencies / gotchas:**
- Both moviehouse deployments (`../moviehouse/`, `netlify.toml`) must post to
  the `/synthetic` endpoint (Hermes) of their environment — verified:
  prod → `https://fly-botserver.vlab.digital/synthetic`,
  staging → `https://staging.fly-botserver.vlab.digital/synthetic`.
- The video **id must be quoted** in the `wait` (`"id":"164118668"`):
  moviehouse takes the id from a URL query param, so it always arrives as a
  *string*, and the wait matcher compares by strict equality (see `_matches` in
  `replybot/lib/typewheels/waiting.js` and `_removeMdLinks` in `form.js`, which
  leaves numbers un-coerced).
- **`buttonText` is capped at 20 characters on WhatsApp** and WhatsApp rejects
  the whole message when it is longer — `translateWhatsAppWebview` fails with
  `ErrWebviewButtonTextTooLong` rather than truncating, so the survey stops with
  a `STATE_ACTIONS` error naming the field. Messenger has no such cap, so a
  label that works there can stop a WhatsApp run. Both webview fields here use
  `Watch test video` (16 chars) for that reason; the emoji lives in the body
  text instead. See `documentation/platform-abstraction.md` →
  *webview → `cta_url`*.
- **Interpolation fails silently.** `getFromMetadata`
  (`replybot/lib/typewheels/form.js`) returns `""` for any unknown key rather
  than throwing, so a typo'd `{{hidden:…}}` yields a URL with an empty param and
  the failure only shows up as an error page inside the webview.
- **Residual risk:** picking the wrong environment button still misroutes the
  play event (you'd only ever see `movie_timeout`). The on-screen echo-back is
  the guard — read it before pressing play.

## Media fields — what each one proves

Six media-abstraction fields run back to back (`media_third_party_url` →
`media_legacy_attachment_id_<env>` → `media_asset_image_<env>` →
`media_asset_repeat_<env>` → `media_asset_video_<env>` →
`media_asset_file_<env>`), each exercising a resolution path from
`planning/media-abstraction.md` §8.3. `confirm_attachment` is the single arrival
check for all six.

Five of the six exist twice — once per environment — and are picked by the
`test_environment` answer; see [Why five of them are environment-scoped](#why-five-of-them-are-environment-scoped)
below for the mechanism and the branch shape.

The balance is deliberate: **exactly one** legacy test, **exactly one**
not-uploaded (third-party URL) test, and the rest on the modern uploaded-asset
path — the thing this build actually added. An earlier version of this survey
had four different fields pointing at third-party URLs (including two
duplicates of the same imgur image) and only two exercising real assets, which
meant the suite barely touched the code path it exists to test. See
`planning/media-abstraction.md` §11.4 for that history.

| Field | Proves | Expected on Messenger | Expected on WhatsApp |
|---|---|---|---|
| `media_legacy_attachment_id_<env>` | **The BC regression guard.** §8.3 rule 1: `media_attachment_id` present + Messenger → send by that id, byte-for-byte unchanged from today. Per the production audit (§11.1), legacy `attachment_id` fields carry ~100% of live Messenger media traffic — this is the single most important field in the file. Its `attachment_id` value must never be changed; Meta offers no way to recover the original file from an id, so a wrong value cannot be fixed, only replaced by a fresh upload elsewhere. | Sends | **Fails cleanly** — `ErrAttachmentIDUnsupported` (`translator_whatsapp.go:309`). This is correct and intended, not a bug: attachment ids were never supported on WhatsApp. |
| `media_third_party_url` | **The only not-uploaded test.** An ordinary, unmirrored third-party URL (the imgur image already used elsewhere in production surveys) still works — §2's "third-party URLs are out of scope" means no handle, no acceleration, just a plain URL send | Sends | Sends |
| `media_asset_image_<env>` | The modern dashboard-issued asset URL path, image (§8.3 rule 2: `/a/<uuid>` parsed, handle looked up for `(asset, platform, account)`, sent by handle if found else by URL) | Sends (by URL until real handles exist) | Sends (by URL until real handles exist) |
| `media_asset_repeat_<env>` | **Handle reuse.** The exact same asset URL as `media_asset_image_<env>` (same UUID), sent a second time. This is the only field that can tell a reused handle apart from a silent per-send URL fallback — without it every send could be falling back to URL and the suite would still pass | Sends | Sends |
| `media_asset_video_<env>` | The modern path, video — replaces the old direct-URL video test (`media_video`, which pointed at a random `samplelib.com` file instead of our own storage) | Sends | Sends |
| `media_asset_file_<env>` | The modern path, document/PDF — replaces the old direct-URL PDF test (`media_file`, which pointed at `w3.org`) | Sends | Sends |

### Why five of them are environment-scoped

The same Typeform form is deployed to **both** environments — `deploy.py`
publishes one form, and prod and staging replybots both read it. Media values,
however, are not environment-portable:

- **Asset URLs are per-environment.** An asset's row lives in exactly one
  environment's database, and its bytes in that environment's bucket
  (`media.vlab.digital` vs. `staging.media.vlab.digital`). A staging URL left in
  the form makes **production fetch respondent-facing images from staging
  infrastructure** — it may even appear to work, which is worse.
- **Attachment ids are page-scoped.** An id minted on the staging page is
  meaningless on the production page and fails outright — observed as Meta
  error 100, *"Failed to load attachment from attachment ID"* (see
  [below](#distinguishing-wrong-id-from-broken-code-legacy-attachment_id)).

So the five environment-scoped fields exist twice, `_prod` and `_staging`,
mirroring the `movie_webview_prod` / `movie_webview_staging` pattern and driven
by the **same** `test_environment` answer — the environment is still asked
exactly once, up front.

**`media_third_party_url` is deliberately NOT duplicated.** It is an imgur URL:
no asset row, no bucket, no page scoping, nothing environment-dependent about
it. One copy serves both branches, and it is the field that runs *before* the
branch.

#### Branch shape

```
test_attachments ──No──────────────────────────────────► movie_webview_<env>
        │
        └─Yes─► media_third_party_url   (shared, env-neutral)
                        │
      ┌─────────────────┴─ test_environment == Staging ─┐
      ▼ (else)                                          ▼
 media_legacy_attachment_id_prod            media_legacy_attachment_id_staging
 media_asset_image_prod                     media_asset_image_staging
 media_asset_repeat_prod                    media_asset_repeat_staging
 media_asset_video_prod                     media_asset_video_staging
 media_asset_file_prod ─────────┐           media_asset_file_staging ─────┐
                                └──────► confirm_attachment ◄─────────────┘
```

Three logic rules carry it: `media_third_party_url` branches on
`test_environment` (staging first, prod as the `always` default — the same
shape as `confirm_attachment`), and each chain's last field
(`media_asset_file_<env>`) jumps unconditionally to `confirm_attachment`. The
prod chain's jump is load-bearing (without it, it would fall through into the
staging chain); the staging chain's is the natural next field but is written
explicitly so the two read identically.

Everything after `confirm_attachment` is environment-neutral again, except the
moviehouse branch, which re-reads the same `test_environment` answer.

**`media_asset_repeat_<env>` must keep the exact same URL as
`media_asset_image_<env>`.** That identity is the whole point of the field;
giving it a different UUID turns it into a second first-send and proves nothing
about reuse. When substituting new assets, always change the two together —
within one environment.

### Why `welcome` stays on a third-party URL, deliberately

`welcome` is the survey's welcome screen — the very first message a respondent
receives, before any other field runs. It is **intentionally left pointing at
the imgur URL** rather than converted to an asset URL. An asset URL there would
also have to be environment-scoped — and `welcome` runs *before*
`test_environment` is asked, so there would be no answer to branch on. Worse,
one bad or wrong-environment value would fail at message one and make every
other media test below it unreachable — a smoke test should never be able to
lose all its coverage to a single bad value. Keeping `welcome` on a stable, already-working third-party URL is
defensive by design, not an oversight or inconsistency with the rest of this
section.

### Distinguishing "wrong id" from "broken code" (legacy `attachment_id`)

If `media_legacy_attachment_id_<env>` fails on Messenger, both of these read as
HTTP code 100 from Meta, but the message text is the whole diagnosis:

| error | meaning |
|---|---|
| `... should represent a valid URL` | the request is **malformed** — an attachment descriptor leaked into `media_url`. This was a real bug, fixed in replybot v0.0.211 / message-worker v0.1.17 |
| `Failed to load attachment from attachment ID.` | the request is **well-formed**; the id just isn't valid for the page this smoke test is currently running against. Attachment ids are still page-scoped — pasting one minted on a different page fails this way. Seeing it now almost always means the **wrong environment was picked** at `test_environment`, so a staging-page id was sent on the production page (or vice versa) — this is exactly why the field is duplicated per environment |

## The `utility_message` field (page-specific, not env-specific)

The field sends the **`recontact`** / `en_US` utility template. Unlike everything
else in the survey, its *choices are not free text* — they must match the
template that Facebook approved **on the page you are running the smoke test
from**.

An approved utility template bakes `value == button_label` into each POSTBACK
payload at approval time (see `documentation/utility-messages.md` → "Postback
buttons"). The tap therefore arrives as
`{"value":"<approved label>","ref":"utility_message"}`, and
`validateUtilityMessage` (translate-typeform `validator.js`) accepts only the
labels in the question's `properties.choices`. Any mismatch means the button is
rejected with *"Sorry, please use the buttons provided…"* and the template is
re-sent — an unbreakable loop that halts the whole run.

Two rules follow:

- **Choice labels must equal the approved button labels, verbatim** (`OK!`,
  including the `!`).
- **Choice count must equal approved button count** — fewer POSTBACK
  parameters than approved buttons makes Facebook reject the send with
  `User pass less payload than required for POSTBACK button` (code 100,
  subcode 1893029).

Templates live on the **Facebook page**, not on an environment, so the same
page behaves identically in prod and staging. But different pages have
different approved `recontact` templates — as of 2026-07-25, page
`935593143497601` (the page the smoke test runs on) has one button `OK!`,
while page `1180512431819029` has two (`Continue`, `No, thanks`). Before
running the smoke test from a **new** page, check what that page has approved:

```bash
kubectl exec -n vstag gbv-cockroachdb-0 -- ./cockroach sql --insecure \
  --format=records -e "select account_id, name, language, status, buttons \
  from chatroach.message_templates;"
```

(Both environments now use `account_id`; migration 22 renamed it from
`facebook_page_id` in vprod on 2026-07-26.) Then align `choices` in
`form-a.json` and redeploy — approved templates **cannot** be edited, so the
survey is what moves.

## Notes / gotchas

- **There is no inbound-media (`upload`) field, deliberately.** The smoke test
  used to end the media block with a `send_picture` → `picture_received` pair
  proving the `user_media` → MEDIA path. It was removed 2026-08-11: replybot
  validates and stores an inbound media answer, but **nothing downloads the
  bytes**, so the stored value is a handle that expires at Meta (7 days on
  WhatsApp, ~30 on Messenger) and resolves to nothing afterwards. Smoke-testing
  it asserted a capability the platform does not have. Re-add it in the same
  change that builds the downloader — see
  `planning/inbound-media.md`, which keeps the field definition and the
  wiring needed to restore it.
- **`media_third_party_url`** (and `welcome`) point at an imgur URL, which must
  stay reachable by Facebook's fetchers; swap it if the host goes away. There
  is no longer a public-sample-host dependency for video/PDF — those moved to
  dashboard-issued asset URLs (`media_asset_video_<env>`,
  `media_asset_file_<env>`); see
  [Media fields](#media-fields-what-each-one-proves).
- **Picking the wrong environment** at `test_environment` now breaks two things,
  not one: the moviehouse play event misroutes *and* the media block sends the
  other environment's attachment id and asset URLs. Read the on-screen echo-back
  (`[PRODUCTION]` / `[STAGING]` in the media titles, *"Testing in …"* in the
  webview) before continuing.
- **Handoff** needs `smoke-echo` deployed and `target_app_id` in
  `handoff_statement` pointing at that app — see `../smoke-echo/README.md`.
- No local state: any interrupted run can just be restarted from the `m.me`
  link.
