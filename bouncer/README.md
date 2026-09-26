# bouncer

Verification for surveys. A survey lists the checks it wants, each an object with
its own parameters, and bouncer runs them on a page at `id.vlab.digital/verify`.
Once all of them pass, bouncer emits the synthetic event `bouncer:verified` for the
conversation, and a survey waiting on it continues.

Researchers use it through replybot's `id_verification` field type
(`documentation/questions.md` § "Verification (captcha)"). Design and rationale:
`planning/human-verification-captcha.md`.

## Methods

| `type` | Parameters | `default` resolves to | Proof the page submits |
|---|---|---|---|
| `captcha` | `provider`: `default` \| `turnstile` | `turnstile` | `{token}` from the Turnstile widget |
| `auto` | `provider`: `default` | `none` | `{}`. It passes with no participant action. **Test-only**: refused (400, `[BOUNCER_AUTO_DISABLED]`) unless `BOUNCER_ALLOW_AUTO=true` |

`default` is resolved **here** (`defaultProvider` in `methods.go`), so switching
providers is a bouncer deploy and needs no survey edits. `allowedProviders` must match
replybot's `VERIFICATION_METHODS`. Each type may appear at most once in a list.

Adding a method means adding it to `allowedProviders`/`defaultProvider`, a case in
`Server.checkStep`, and a runner in `page.html`'s `runners`, plus replybot's
`VERIFICATION_METHODS`. Deploy bouncer first: it refuses methods it does not know.

### `auto` and the end-to-end test

A real captcha can't be solved in CI, so the Facebot testcontainers suite
(`facebot/testrunner/test.tc.ts` § "Verification (bouncer)") runs bouncer with
`BOUNCER_ALLOW_AUTO=true` and a form asking for `auto`. Everything except the provider
call is real:
- replybot signs the link with the `BOUNCER_HMAC_KEY` from its env;
- bouncer checks the signature and the methods with its own copy of the key;
- the `bouncer:verified` event has to reach hermes and advance the survey;
- tampered links (another user, swapped methods) must get a 400 while the survey keeps
  waiting.

It is safe to leave `auto` in the method list, because participants cannot add it to a
link (the method list is signed). The environment gate stops a researcher from using it
in a real survey. Staging and production set `BOUNCER_ALLOW_AUTO: "false"` explicitly.

## Flow

1. replybot sends a button to `BOUNCER_URL?vlab_user&vlab_account&vlab_platform&vlab_methods&vlab_sig`.
   `vlab_methods` is base64url JSON of the normalized list, e.g.
   `[{"type":"captcha","provider":"default"}]`.
2. `GET /verify` checks that the link is complete, that the signature matches and that every
   method is known. It then resolves `default` and renders one step per method.
3. The page runs the steps in order, collecting each step's proof, and then POSTs them
   all together to `/verify/submit`. There is no server-side session: each submit carries the
   whole signed link again.
4. bouncer checks each proof in order. For Turnstile, it calls `siteverify` and requires
   `success`, `hostname == BOUNCER_HOSTNAME` and `cdata == vlab_sig` (the widget is
   rendered with that cData, so a token solved for one conversation cannot be spent on another).
5. Only when every step has passed does it POST to hermes `/synthetic`:

```jsonc
{
  "user": "<vlab_user>",
  "account_id": "<vlab_account>",
  "page": "<vlab_account>",
  "platform": "messenger|whatsapp",
  "event": { "type": "external", "value": {
    "type": "bouncer:verified",
    "methods": [{ "type": "captcha", "provider": "turnstile" }]   // what actually ran
  } }
}
```

### Why the browser never posts the event

hermes `/synthetic` is unauthenticated. If the page posted the event itself, as
moviehouse does, anyone could post "verified" without passing anything. Only
bouncer, holding the provider secrets, emits the event.

### Why there is no failure event

replybot matches waits by subset (`waiting.js` `_contains`). Any event of type
`bouncer:verified`, whatever else it carried, would release a wait on
`{type: bouncer:verified}`. A failure stays on the page, and the participant retries.

### Why the event is not best-effort

linksniffer redirects even when its event POST fails. Here the event is the product.
If hermes does not answer 200, the page says "try again" and never shows "verified".

## Signature

```
vlab_sig = hex( HMAC-SHA256( BOUNCER_HMAC_KEY, "v2|" + user + "|" + account + "|" + platform + "|" + vlab_methods ) )
```

The HMAC covers the raw `vlab_methods` string exactly as sent, so neither side has
to reproduce the other's JSON serialization, and a participant cannot strip a method out.
It must stay byte-identical to replybot's `verificationSignature`. The shared test vector
(`identity_test.go`, `replybot/lib/generic-translator.test.js`) breaks if either side
drifts. There is no expiry: a replayed link can only re-verify the same conversation.

## Endpoints

| Path | Method | Purpose |
|---|---|---|
| `/verify` | GET | Check the link, render the steps (400 + "link isn't working" page if the link is bad) |
| `/verify/submit` | POST | `{vlab_user, vlab_account, vlab_platform, vlab_methods, vlab_sig, results: [{token}, …]}` → `{status: verified \| failed \| retry \| broken}` |
| `/health` | GET | `pong` |

Port: **1323**. The ingress exposes only `/verify`.

## Environment

bouncer refuses to start if any of these is missing.

| Variable | Source | Purpose |
|---|---|---|
| `BOTSERVER_URL` | values | hermes `/synthetic`, e.g. `http://gbv-hermes/synthetic` |
| `BOUNCER_HOSTNAME` | values | The public host. It must equal the ingress host, because siteverify's `hostname` is checked against it |
| `TURNSTILE_SITE_KEY` | values | Public widget key |
| `TURNSTILE_SECRET_KEY` | secret `bouncer` | siteverify secret |
| `BOUNCER_ALLOW_AUTO` | values | Optional. `true` allows the test-only `auto` method. Never set it in a real environment |
| `BOUNCER_HMAC_KEY` | secret `bouncer` | Link-signing key. It **must equal** `BOUNCER_HMAC_KEY` in replybot's `gbv-bot-envs` |

With one of Cloudflare's published dummy secrets (`1x…AA` always passes, `2x…AA`
always fails, `3x…AA` already spent), bouncer logs `[BOUNCER_TEST_KEYS]` at startup and
skips the hostname and cdata checks, because siteverify returns fixed values
(`localhost`, `test-data`) for those secrets. This costs nothing: an always-pass
secret lets everyone through anyway.

## Log tags

| Tag | Meaning |
|---|---|
| `[BOUNCER_VERIFIED]` | Every step passed and the event was delivered (logged with `methods=`) |
| `[BOUNCER_VERIFY_FAILED]` | A step did not pass (logged with `method=type:provider`), or the number of results did not match the methods |
| `[BOUNCER_BAD_SIGNATURE]` | The link or POST was tampered with, or the replybot and bouncer keys differ. If **every** request logs this, check the keys first |
| `[BOUNCER_BAD_LINK]` | A missing component, an unknown platform, or `vlab_methods` that does not decode to a known, valid list |
| `[BOUNCER_PROVIDER_ERROR]` | The provider (e.g. Cloudflare) was unreachable or returned non-200. The participant is told to retry |
| `[BOUNCER_EVENT_FAILED]` | hermes did not accept the event. The participant is told to retry |
| `[BOUNCER_TEST_KEYS]` | Running with a dummy Turnstile secret |
| `[BOUNCER_AUTO_ENABLED]` | Startup: the `auto` method is allowed. It should appear only in test environments |
| `[BOUNCER_AUTO_DISABLED]` | A link asked for `auto` in an environment that refuses it |

## Local run

```bash
cd bouncer
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA \
TURNSTILE_SITE_KEY=1x00000000000000000000AA \
BOUNCER_HMAC_KEY=bouncer-test-vector-key \
BOUNCER_HOSTNAME=localhost \
BOTSERVER_URL=http://localhost:18099/synthetic \
go run .
# signed link for the test vector:
open "http://localhost:1323/verify?vlab_user=1234567890&vlab_account=acct-1&vlab_platform=whatsapp&vlab_methods=W3sidHlwZSI6ImNhcHRjaGEiLCJwcm92aWRlciI6ImRlZmF1bHQifV0&vlab_sig=c0a8ef438ad169bcc0eda1faf601c89b76ce5482ae042c06db452d8361cef1fd"
```

## Testing

```bash
go test ./...
```

Handlers are tested with fake `Verifier` and `Sender`. The pure pieces (`parseLink`,
`sign`/`verifySig`, `decodeMethods`/`resolveMethods`, `judgeSiteverify`, `buildEvent`) are tested directly.

## Deploy

One-time, per environment (`staging.id.vlab.digital` / `id.vlab.digital`):

1. **Cloudflare**: create a Turnstile widget for the host, and copy the site key and secret.
2. **DNS**: point the host at the ingress IP.
3. **Secrets**: generate `openssl rand -hex 32`. Put it as `BOUNCER_HMAC_KEY` in
   **both** `bouncer/.env-<env>` (with `TURNSTILE_SECRET_KEY`) and `replybot/.env-<env>`.
   Then run `devops/secrets.sh <ns> bouncer bouncer/.env-<env>` and re-apply `gbv-bot-envs`.
4. **Values**: set `TURNSTILE_SITE_KEY` in `devops/values/<env>.yaml` and flip `tags.bouncer: true`.
5. **Image**: tag `bouncer-v0.0.1` (the release workflow builds `ghcr.io/vlab-research/bouncer`).
6. **Chart**: `helm package chart && helm push bouncer-0.0.1.tgz oci://us-west1-docker.pkg.dev/toixotoixo/vlab-research/charts`,
   then `helm dep update devops/vlab` to refresh `Chart.lock`. **The umbrella chart lists
   bouncer as a dependency, so this must happen before the next `helm upgrade` from a
   branch containing it.**
7. `helm upgrade`, then `kubectl rollout restart deployment/gbv-replybot` so replybot picks up
   the key.
