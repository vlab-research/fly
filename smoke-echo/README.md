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
3. **Connect the app to the existing smoke-test Page** (the same page
   `smoke-test/` already uses for `flysmoke`/`flysmokeb`). This is what makes
   it a Secondary Receiver — no new Page is needed; the handover protocol is
   built around multiple apps sharing one page. Connecting it generates a
   **Page Access Token** scoped to this app.
4. **Subscribe its webhook to both `messaging` and `messaging_handovers`.**
   `messaging_handovers` is how it learns it just gained control;
   `messaging` is how it then receives the user's reply (once an app owns a
   thread, the user's messages are delivered to it as normal `messaging`
   events, not `standby`).
5. Note down, for the deployment step below:
   - the new app's **App ID** (this is `FACEBOOK_APP_ID` for this service)
   - the **Page Access Token**
   - a **verify token** string of your choosing (used for the webhook
     handshake — same idea as botserver's `VERIFY_TOKEN`, called
     `FACEBOOK_VERIFY_TOKEN` here)
   - Fly's replybot **App ID** (already known — it's `FACEBOOK_APP_ID` in
     `devops/values/production.yaml`'s botserver/replybot env), needed here as
     `FLY_APP_ID` so the echo app knows who to hand control back to

## Configuration

| Env var | Purpose |
|---|---|
| `FACEBOOK_VERIFY_TOKEN` | Must match the verify token you set in the FB webhook config |
| `PAGE_ACCESS_TOKEN` | Page access token generated when connecting this app to the page |
| `FACEBOOK_APP_ID` | This app's own App ID — used to recognize "control was passed to *me*" |
| `FLY_APP_ID` | Fly replybot's App ID — where control gets handed back to |
| `FACEBOOK_GRAPH_URL` | Defaults to `https://graph.facebook.com/v22.0` (matches replybot/botserver) |
| `PORT` | Defaults to `8080`; `kube/deployment.yaml` sets it to `80` |

`FACEBOOK_APP_SECRET` is *not* currently read by this service — the code
doesn't validate webhook signatures (botserver doesn't either; see its
`// TODO: Add validation with APP SECRET!!!`). Keep it in `.env` if you'd
rather have it on hand for that later; it's harmless to include in the
secret either way.

In the cluster, these are expected to live in a Secret named
`smoke-echo-env`, referenced via `envFrom` in `kube/deployment.yaml`. The
simplest path: collect every value (including `FACEBOOK_VERIFY_TOKEN`,
`PAGE_ACCESS_TOKEN`, `FACEBOOK_APP_ID`, `FLY_APP_ID` — and optionally
`FACEBOOK_APP_SECRET`) in a gitignored `.env` here, same as
`smoke-test/.env`, and load it directly:

```bash
kubectl create secret generic smoke-echo-env --from-env-file=.env
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
`handoff_statement` description uses the **first-class handoff field** format
(see `replybot/HANDOFF_PROTOCOL.md`):

```json
{"type":"handoff","handoff":{"target_app_id":"976665718578167","mode":"wait","metadata":{"check":"smoke_test"}}}
```

Two things matter here:

- **`"type":"handoff"` is required.** The runtime synthesizes the
  `wait: {type: "handover"}` automatically when the echo of the handoff
  message arrives. (An older wait-based format —
  `{"type":"wait","wait":{"type":"handover"},"handoff":{...}}` — was used
  before commit `c2e2eed9`; under the current runtime it would arm the wait
  but never fire the handoff. Do not use it.)
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
handover event processing (see `replybot/HANDOFF_PROTOCOL.md`
"Troubleshooting"). One confirmed cause: replybot's flattening depends on its
event-parsing pipeline — returned metadata must land under
`e_handover_metadata_*` keys (see the prefix note above); a pipeline that
flattens to `e_handover_*` produces exactly this symptom. If the bot never
resumes at all, note there is currently **no timeout fallback** — Fly will
wait in `WAIT_EXTERNAL_EVENT` indefinitely, so use `scripts/passback.sh`
(below) to hand control back manually.

## Manual recovery: handing control back

If a smoke run gets interrupted while smoke-echo owns the thread, Fly can no
longer send to the user because another app controls the thread. The smoke-echo
service exposes an admin endpoint to hand control back to Fly on demand.

### `scripts/passback.sh`

A small helper script is included:

```bash
./scripts/passback.sh <messenger-user-id> [target-app-id]
```

Examples:

```bash
# Hand control back to Fly (default target app)
./scripts/passback.sh 1989430067808669

# Hand control back to a specific app
./scripts/passback.sh 1989430067808669 699455733740842
```

The script reads `FLY_APP_ID` from `smoke-echo/.env` if available, otherwise
defaults to `699455733740842`. The target endpoint defaults to the production
URL `https://fly-smoke-echo.vlab.digital/admin/passback`; override it by setting
`SMOKE_ECHO_ENDPOINT`.

### Under the hood

`scripts/passback.sh` is a thin wrapper around the `POST /admin/passback` endpoint
built into the service:

```bash
curl -X POST https://fly-smoke-echo.vlab.digital/admin/passback \
     -H 'content-type: application/json' \
     -d '{"userId":"1989430067808669"}'
```

A `GET` with `?userId=...` works too, for convenience from a browser. The endpoint
defaults the target to `FLY_APP_ID`; pass `targetAppId` to override.

## Local development

```bash
npm install
npm test    # mocha unit tests for the webhook handlers
```
