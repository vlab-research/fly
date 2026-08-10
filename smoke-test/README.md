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
| `test_environment` | **Env pick, asked once up front.** The account/environment picker for media (attachment_id vs. URL) is gone now that the handle layer scopes by account — this question survives only because moviehouse's webview host is baked in per environment at build time and there is no other way to route the play event | quick-reply; read by `picture_received` logic |
| `test_attachments` → `media_video` → `confirm_video` | Bot-sent **video** attachment, gated behind a yes/no — the question text warns the sends are slow so the pause after tapping Yes isn't mistaken for the bot hanging; answering No skips the whole attachment block straight to `send_picture` | `multiple_choice` → `attachment` (`keepMoving`) |
| `media_file` → `confirm_file` | Bot-sent **file/PDF** attachment | `attachment` (`keepMoving`) |
| `media_legacy_attachment_id` → `media_asset_url` → `media_third_party_url` → `media_asset_repeat` → `confirm_attachment` | Four media-abstraction paths back to back — see [Media fields](#media-fields-what-each-one-proves) below | `attachment` (`keepMoving`), three by `url` + one by legacy `attachment_id` |
| `confirm_video`, `confirm_file`, `confirm_attachment` | **Did it actually arrive?** A failed send is reported and its offset committed, so the survey walks on regardless — these are the only signal that a media send silently failed | `multiple_choice` (answers recorded, no branching) |
| `send_picture` → `picture_received` | **Inbound user media** (user sends a photo); stored URL interpolated back | `upload` (`{type:image}`) → `user_media`/MEDIA event |
| `movie_webview_prod`/`movie_webview_staging` → `movie_watched`/`movie_timeout` | **Webview button → moviehouse external events → logic reacting to them** (works in prod & staging); branched from `test_environment` by `picture_received` | `webview` + `wait{op:or,[external moviehouse:play, timeout]}`; branch on `e_moviehouse_play_id` |
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

This is now the **only** environment-specific step in the survey — the
`attachment_id` prod/staging split that used to be the other one is gone; the
handle layer scopes by account instead of asking the respondent (see
[Media fields](#media-fields-what-each-one-proves)). Everything else in the
smoke test is environment-neutral (handoff even shares one smoke-echo app
across both envs).

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

Four media-abstraction fields run back to back (`media_legacy_attachment_id` →
`media_asset_url` → `media_third_party_url` → `media_asset_repeat`), each
exercising a different resolution path from `planning/media-abstraction.md`
§8.3. `confirm_attachment` is the single arrival check for all four.

| Field | Proves | Expected on Messenger | Expected on WhatsApp |
|---|---|---|---|
| `media_legacy_attachment_id` | **The BC regression guard.** §8.3 rule 1: `media_attachment_id` present + Messenger → send by that id, byte-for-byte unchanged from today. Per the production audit (§11.1), legacy `attachment_id` fields carry ~100% of live Messenger media traffic — this is the single most important field in the file. Its `attachment_id` value must never be changed; Meta offers no way to recover the original file from an id, so a wrong value cannot be fixed, only replaced by a fresh upload elsewhere. | Sends | **Fails cleanly** — `ErrAttachmentIDUnsupported` (`translator_whatsapp.go:309`). This is correct and intended, not a bug: attachment ids were never supported on WhatsApp. |
| `media_asset_url` | The new dashboard-issued asset URL path (§8.3 rule 2: `/a/<uuid>` parsed, handle looked up for `(asset, platform, account)`, sent by handle if found else by URL). **⚠️ Currently a placeholder** — see below. | Sends (by URL until real handles exist) | Sends (by URL until real handles exist) |
| `media_third_party_url` | An ordinary, unmirrored third-party URL (the imgur image already used elsewhere in production surveys) still works — §2's "third-party URLs are out of scope" means no handle, no acceleration, just a plain URL send | Sends | Sends |
| `media_asset_repeat` | **Handle reuse.** The same asset URL as `media_asset_url`, sent a second time. This is the only field that can tell a reused handle apart from a silent per-send URL fallback — without it every send could be falling back to URL and the suite would still pass | Sends | Sends |

### The `media_asset_url` / `media_asset_repeat` placeholder

Both fields currently point at
`https://media.vlab.digital/a/00000000-0000-0000-0000-000000000000/PLACEHOLDER-replace-with-real-asset.png`.
**This is not a real asset** — the dashboard upload path that would create one
does not exist yet (`planning/media-abstraction.md` §3, §11.4). The all-zero
UUID and the `PLACEHOLDER-` filename prefix are deliberate markers, not a typo.

Before these two fields can pass: build the upload path, upload a real file
through it, and replace the URL in both fields with the real `public_url` the
dashboard returns. Until then, expect these two sends to fail (no such object
in storage) — that failure is expected, not a regression.

### Distinguishing "wrong id" from "broken code" (legacy `attachment_id`)

If `media_legacy_attachment_id` fails on Messenger, both of these read as HTTP
code 100 from Meta, but the message text is the whole diagnosis:

| error | meaning |
|---|---|
| `... should represent a valid URL` | the request is **malformed** — an attachment descriptor leaked into `media_url`. This was a real bug, fixed in replybot v0.0.211 / message-worker v0.1.17 |
| `Failed to load attachment from attachment ID.` | the request is **well-formed**; the id just isn't valid for the page this smoke test is currently running against. Attachment ids are still page-scoped — pasting one minted on a different page fails this way |

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

- **The `upload` field forces a real photo.** `validateUpload` requires
  `answer.type === 'image'` with a `payload.url`; typing text is rejected and
  the prompt repeats. That is intentional — the point is to prove the
  `user_media` → MEDIA path. (Proven in `replybot/.../machine.test.js`, the
  "Adds the URL given an attachment as responseValue" test.)
- **Sample media URLs** (`media_video`, `media_file`) point at public sample
  hosts and must be reachable by Facebook's fetchers; swap them if a host goes
  away.
- **Handoff** needs `smoke-echo` deployed and `target_app_id` in
  `handoff_statement` pointing at that app — see `../smoke-echo/README.md`.
- No local state: any interrupted run can just be restarted from the `m.me`
  link.
