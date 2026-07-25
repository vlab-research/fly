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
| `favorite_color`, `test_payment`, `try_again`, `test_handoff` | Quick-reply questions + **field logic jumps** | `multiple_choice` |
| `why_red` / `feedback` (B) | Free-text answer | `short_text` |
| `siblings` | Numeric answer + validation | `number` |
| `phone` | Phone answer + normalization | `phone_number` |
| `payment_wait` → `payment_success`/`payment_failure` | **Payment** (Reloadly) via `wait: external` + **hidden-field logic** | `wait` / `payment:reloadly`; branch on `e_payment_reloadly_success` |
| `handoff_statement` → `handoff_result` | **Thread-control handoff** round trip + metadata flattening | `handoff`; interpolates `e_handover_metadata_*` (needs `smoke-echo`) |
| `utility_message` | Facebook **UTILITY template** message (choices must match the page's approved button labels — [see below](#the-utility_message-field-page-specific-not-env-specific)) | `utility_message` |
| `media_video` | Bot-sent **video** attachment | `attachment` (`keepMoving`) |
| `media_file` | Bot-sent **file/PDF** attachment | `attachment` (`keepMoving`) |
| `send_picture` → `picture_received` | **Inbound user media** (user sends a photo); stored URL interpolated back | `upload` (`{type:image}`) → `user_media`/MEDIA event |
| `test_environment` → `movie_webview_prod`/`movie_webview_staging` → `movie_watched`/`movie_timeout` | **Env pick → webview button → moviehouse external events → logic reacting to them** (works in prod & staging) | quick-reply env branch; `webview` + `wait{op:or,[external moviehouse:play, timeout]}`; branch on `e_moviehouse_play_id` |
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

### Why it's the one environment-specific step

moviehouse bakes its target backend (`SERVER_URL`) in at build time, so the
**production** player (`virtuallab-videos.netlify.app`) posts events to
production Hermes and the **staging** player
(`staging--virtuallab-videos.netlify.app`) posts to staging Hermes — two
different URLs. For a play event to reach the replybot running *this* survey,
the button must open the player wired to the *same* environment. Everything
else in the smoke test is environment-neutral (handoff even shares one
smoke-echo app across both envs).

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
- **Interpolation fails silently.** `getFromMetadata`
  (`replybot/lib/typewheels/form.js`) returns `""` for any unknown key rather
  than throwing, so a typo'd `{{hidden:…}}` yields a URL with an empty param and
  the failure only shows up as an error page inside the webview.
- **Residual risk:** picking the wrong environment button still misroutes the
  play event (you'd only ever see `movie_timeout`). The on-screen echo-back is
  the guard — read it before pressing play.

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

(prod's column is still named `facebook_page_id`; staging has been renamed to
`account_id` by the platform-abstraction migration.) Then align `choices` in
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
