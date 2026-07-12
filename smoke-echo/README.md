# smoke-echo

A minimal Messenger app whose only purpose is to be the "other side" of the Fly
**thread-control handoff** feature during the production smoke test
(`../smoke-test/`).

Facebook's handover protocol fundamentally requires *two* Facebook Apps: a
Primary Receiver (Fly's replybot app) that owns the conversation by default,
and a Secondary Receiver that the Primary can temporarily hand the thread to.
There's no way to exercise that handoff from inside Fly alone — Facebook
routes each webhook to whichever app currently owns the thread. `smoke-echo`
is that second app: a tiny stateless service that

1. receives thread control,
2. sends the user a message so you can *see* control actually moved,
3. waits for the user's reply and echoes it back,
4. immediately hands control back to Fly with the echoed text in the metadata.

The smoke survey (`smoke-test/form-a.json`, `handoff_statement` /
`handoff_result` questions) then asserts the round trip by printing
`{{hidden:e_handover_metadata_echo_text}}` and
`{{hidden:e_handover_metadata_smoke_echo}}` — proof that the metadata
flattening worked end to end. (Fly flattens the returning app's
`pass_thread_control` metadata into hidden fields prefixed
`e_handover_metadata_`, so a returned `{"echo_text": "..."}` becomes
`e_handover_metadata_echo_text`.)

No database, no Kafka, no persistent state — if a run gets interrupted, just
re-run the smoke test from the top.

## One-time Facebook setup (you do this — needs Meta Business / Developer Console access)

1. **Create a second Facebook App** (e.g. "Fly Smoke Echo"). Leave it in
   **Development Mode** — don't submit it for App Review.
2. **Add yourself (and anyone else running the smoke test) as a Tester or
   Admin** on the new app. Development-mode apps can fully use Messenger,
   including `pass_thread_control`/`take_thread_control`, for anyone with a
   role on the app — App Review is only required to talk to people who
   *don't* have a role on the app, which doesn't apply to a smoke test run by
   your own team.
3. **Connect the app to each smoke-test Page** — one per environment you want
   to smoke-test (e.g. the production smoke page and the staging smoke page).
   Connecting the app to a page is what makes it a Secondary Receiver on that
   page; no new Page is needed, the handover protocol is built around multiple
   apps sharing one page. Connecting it generates a **Page Access Token** scoped
   to this app *for that page* — you'll get one token per page.
4. **Subscribe its webhook to both `messaging` and `messaging_handovers` on
   each page.** `messaging_handovers` is how it learns it just gained control;
   `messaging` is how it then receives the user's reply (once an app owns a
   thread, the user's messages are delivered to it as normal `messaging`
   events, not `standby`).
5. Note down, for the deployment step below:
   - the new app's **App ID** (this is `FACEBOOK_APP_ID` for this service — one
     value, shared across all pages)
   - the **Page Access Token for each page** (goes into `SMOKE_ECHO_PAGES`)
   - a **verify token** string of your choosing (used for the webhook
     handshake — same idea as botserver's `VERIFY_TOKEN`, called
     `FACEBOOK_VERIFY_TOKEN` here)
   - Fly's replybot **App ID for each page** — production and staging use
     different Fly apps (`FACEBOOK_APP_ID` in `devops/values/production.yaml`
     vs `staging.yaml`); each becomes that page's `flyAppId` in
     `SMOKE_ECHO_PAGES` so the echo app knows who to hand control back to

## Configuration

smoke-echo is **multi-page**: one app can be the Secondary Receiver on several
pages at once (e.g. the production smoke page *and* the staging smoke page).
Facebook's handover protocol is per-page — each page has its own page access
token (issued to *this* app for *that* page) and its own Primary Receiver
("Fly") app that control is handed back to — so tokens and Fly app ids are
configured **per page** via a single JSON env var, keeping the service stateless
(no DB, no Kafka).

| Env var | Purpose |
|---|---|
| `FACEBOOK_VERIFY_TOKEN` | Must match the verify token you set in the FB webhook config |
| `SMOKE_ECHO_PAGES` | JSON map of `pageId → { token, flyAppId }` (see below) — the per-page tokens and handback targets |
| `FACEBOOK_APP_ID` | This app's own App ID — used to recognize "control was passed to *me*" (same across all pages) |
| `FACEBOOK_GRAPH_URL` | Defaults to `https://graph.facebook.com/v22.0` (matches replybot/botserver) |
| `PORT` | Defaults to `8080`; `kube/deployment.yaml` sets it to `80` |

`SMOKE_ECHO_PAGES` is a JSON object keyed by page id:

```json
{
  "1855355231229529": { "token": "<prod page token>",    "flyAppId": "699455733740842" },
  "935593143497601":  { "token": "<staging page token>", "flyAppId": "790352681363186" }
}
```

- `token` — the page access token generated when you connected **this** app to
  that page. It must be the smoke-echo app's own token for that page; another
  app's token (e.g. Fly's) will not work (`/me/...` resolves to the token's
  page, and only the app that owns the thread can pass control).
- `flyAppId` — the Primary Receiver (Fly replybot) App ID **for that page**;
  production and staging use different Fly apps, which is the whole reason this
  is per-page.

**Legacy single-page fallback:** if `SMOKE_ECHO_PAGES` is unset, the service
falls back to the original `PAGE_ACCESS_TOKEN` / `FLY_APP_ID` env vars for every
page. Once `SMOKE_ECHO_PAGES` is set it is authoritative — a webhook for a page
not in the map is skipped rather than sent with the wrong page's token.

`FACEBOOK_APP_SECRET` is *not* currently read by this service — the code
doesn't validate webhook signatures (botserver doesn't either; see its
`// TODO: Add validation with APP SECRET!!!`). Keep it in `.env` if you'd
rather have it on hand for that later; it's harmless to include in the
secret either way.

In the cluster, these live in a Secret named `smoke-echo-env`, referenced via
`envFrom` in `kube/deployment.yaml`. Because `SMOKE_ECHO_PAGES` is a JSON blob,
the cleanest path is to keep the values in a gitignored `.env` and create the
secret from literals (so the JSON is preserved verbatim):

```bash
kubectl create secret generic smoke-echo-env \
  --from-literal=FACEBOOK_VERIFY_TOKEN='...' \
  --from-literal=FACEBOOK_APP_ID='976665718578167' \
  --from-literal=SMOKE_ECHO_PAGES='{"1855355231229529":{"token":"...","flyAppId":"699455733740842"},"935593143497601":{"token":"...","flyAppId":"790352681363186"}}'
```

## Build & deploy

Images are built and pushed to **GitHub Container Registry** by CI
(`.github/workflows/release.yml`), the same as every other Fly service. Push a
tag of the form `smoke-echo-v<version>` to trigger a build:

```bash
git tag smoke-echo-v0.1.3
git push origin smoke-echo-v0.1.3
# CI publishes ghcr.io/vlab-research/smoke-echo:v0.1.3
```

Then bump `image` in `kube/deployment.yaml` to the new tag and apply the plain
manifests in `kube/` (no Helm):

```bash
# secret created from .env, as shown above (one-time)
kubectl apply -f kube/
```

Notes:
- The GHCR package must be **public** (vlab's other packages are, and the
  cluster pulls them with no imagePullSecret). Make it public on first publish.
- `kube/ingress.yaml` mirrors `botserver`'s ingress in
  `devops/values/production.yaml` — same `letsencrypt-prod` cluster issuer and
  `nginx` ingress class, host `fly-smoke-echo.vlab.digital`.
- For a quick local/manual build you can still
  `docker build -t ghcr.io/vlab-research/smoke-echo:<tag> . && docker push …`,
  but prefer the CI tag flow so images are reproducible.

Once it's deployed and reachable over HTTPS, point the new Facebook App's
webhook at `https://fly-smoke-echo.vlab.digital/webhook` and complete the
verification handshake (Facebook will `GET` it with `hub.verify_token` /
`hub.challenge`, which `verifyToken` in `server/handlers.js` answers).

## Wiring it into the smoke survey

`smoke-test/form-a.json` gates the handoff behind a `test_handoff` yes/no
question, then runs `handoff_statement` → `handoff_result`. The
`handoff_statement` description uses the **wait-based** handoff format:

```json
{"type":"wait","wait":{"type":"handover"},"handoff":{"target_app_id":"976665718578167","metadata":{"check":"smoke_test"}}}
```

Two things matter here (both were bugs we hit):

- **`"type":"wait"` is required.** Without it the question is a plain
  statement: the handoff still fires, but its echo is treated as a statement
  and the `wait` is never armed, so the survey never resumes when control
  returns. (See the docs site, *Reference → Questions → Passing Thread
  Control*.)
- **`target_app_id` is the smoke-echo app's real App ID** (`976665718578167`
  here). If you stand up a different echo app, replace it and push the update:

```bash
cd ../smoke-test
python3 deploy.py update form-a
```

## What a successful run looks like

Walking through the smoke test survey via the page's `m.me` link, when you
reach the handoff question:

1. The bot goes quiet for a moment (control has been passed away from Fly)
2. **smoke-echo sends**: "🔄 Thread control handed off to the Smoke Echo
   app! Send me any message and I'll echo it back, then hand you back to the
   survey."
3. You reply with anything, e.g. "hello"
4. **smoke-echo sends**: `📣 You said: "hello" — handing control back to the
   survey now!`
5. Control returns to Fly, and the very next message is the survey's
   `handoff_result` statement: *"Handoff complete! The echo app heard you say
   "hello" (status: ok) and handed control back to me."*

If step 5 shows empty `{{hidden:...}}` placeholders instead of your text,
the metadata round-trip or flattening is broken — check replybot logs for the
`handoff_return` synthetic event (see `replybot/HANDOFF_PROTOCOL.md`
"Troubleshooting"). If the bot never resumes at all, the `timeout_minutes: 5`
fallback in the handoff question means Fly will reclaim the thread on its own
after 5 minutes — useful as a sanity check that `take_thread_control` works
even when this echo app misbehaves.

## Manual recovery: handing control back

If a smoke run gets interrupted while smoke-echo owns the thread, Fly can no
longer send to the user ("another app is controlling this thread now"). Since
smoke-echo IS the current owner, it can hand control back on demand via
`POST /admin/passback`. Because the service is multi-page, you must pass the
**page id** — it selects which page's token to use and defaults the target to
that page's Fly app:

```bash
# staging page, back to staging Fly (default for that page)
curl -X POST https://fly-smoke-echo.vlab.digital/admin/passback \
     -H 'content-type: application/json' \
     -d '{"userId":"1972130092884542","pageId":"935593143497601"}'
```

A `GET` with `?userId=...&pageId=...` works too. Pass `targetAppId` to override
the handback target. A wrapper script is included:

```bash
./scripts/passback.sh <messenger-user-id> <page-id> [target-app-id]
```

The endpoint returns `400` if the page isn't configured in `SMOKE_ECHO_PAGES`,
and `502` (with the raw Facebook error) if the pass-thread-control call fails.

## Local development

```bash
npm install
npm test    # mocha unit tests for the webhook handlers
```
