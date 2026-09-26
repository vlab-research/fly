# Verification V1: `bouncer` (id.vlab.digital) and the `id_verification` field type

Linear: **VIR-84**. Sibling tickets, not part of this plan: VIR-85 identity and
payout dedup (the core of the strategy), VIR-86 fraud-signal scoring, VIR-87
attention-check docs, VIR-88 plausibility classifier, VIR-89 media challenges.

**STATUS (2026-09-26): steps 1–5 of §8 built on `feature/human-verification`,
not deployed.** The design was generalized from a single `captcha` type to
`id_verification` with a list of parameterized methods before anything
shipped. bouncer's and replybot's unit tests pass. Checked end to end in a real
browser against Cloudflare's test keys and a fake hermes. Next: the human steps in
§7, then staging (§8.6). `tags.bouncer` is `false` in both environments until then.

## 1. Goal and non-goals

A survey can ask a participant to pass one or more verification checks, and
**wait** until they have. V1 ships one method, `captcha`. It is the cheapest layer
of bot defense: it raises the cost of an attack, and it does not stop a human
click-farm or a bot that pays a solving service. VIR-85 is where the payoff gets
removed.

The field is generic from day one because more methods are expected (e.g. a phone
OTP). Each is an object with its own parameters, so adding one never changes the
field type or breaks existing surveys.

Non-goals for V1: scoring, fraud analytics, a failure event, methods that happen
inside the chat rather than on a page (VIR-89 belongs in replybot, not here), and
automatic blocking. The survey author decides what happens, through placement and
the `wait`.

## 2. Authoring

```yaml
type: id_verification
buttonText: Verify you're human
methods:
  - type: captcha
    provider: default     # or turnstile; omitted means default
```

| method `type` | parameters | notes |
|---|---|---|
| `captcha` | `provider`: `default` \| `turnstile` | `default` means "we pick" and is resolved in bouncer, so switching providers is a bouncer deploy with no survey edits |
| `auto` | `provider`: `default` | **Test-only.** Passes with no participant action. bouncer refuses it unless `BOUNCER_ALLOW_AUTO=true` (only the Facebot harness sets it; staging and production pin it `"false"`) |

Rules, enforced in replybot (at translation) **and** in bouncer (on every request):
- the list is non-empty;
- the type is known;
- each type appears at most once;
- the provider is known for that type;
- **there are no unknown parameters**, so a typo like `provder` fails loudly
  instead of silently verifying less than was asked.

## 3. Shape

```
replybot ──(button: signed URL)──▶ participant's browser
                                      │ GET  https://id.vlab.digital/verify?vlab_user&vlab_account&vlab_platform&vlab_methods&vlab_sig
                                      ▼
                                   bouncer ── link complete? signed? methods known? → resolve default → render steps
                                      │ page runs steps in order, collects each proof
                                      │ POST /verify/submit {link…, results: [{token}, …]}
                                      ▼
                                   bouncer ── re-check link → check each proof in order (Turnstile siteverify, …)
                                      │ all passed
                                      ▼
                          POST http://gbv-hermes/synthetic
                          { user, account_id, page, platform,
                            event: { type: external, value: { type: bouncer:verified, methods: [...ran] } } }
                                      ▼
                  replybot: wait { type: external, value: { type: bouncer:verified } } fulfilled
```

A new Go service, **`bouncer`**, named in the house style (linksniffer, dinersclub,
moviehouse), is served at `id.vlab.digital`. It is stateless: each submit carries the
whole signed link again, plus one proof per method.

### Why it is a server, not a Netlify page like moviehouse

moviehouse POSTs events **from the browser** to hermes `/synthetic`, which has no
authentication (`hermes/README.md`). For "is human" that would defeat the purpose,
because anyone could POST success without passing anything. The browser only ever
talks to bouncer. bouncer holds the provider secrets, checks the proofs server-side,
and is the only thing that emits `bouncer:verified`.

### Why the URL is signed, and why the methods are in the signature

The identity and the requested methods travel in the URL. Unsigned, one real person
could edit `vlab_user` and pass for a thousand fake conversations, or delete a method
from the list. So:

```
vlab_methods = base64url( JSON( normalized methods ) )          // e.g. [{"type":"captcha","provider":"default"}]
vlab_sig     = hex( HMAC-SHA256( BOUNCER_HMAC_KEY, "v2|" + user + "|" + account + "|" + platform + "|" + vlab_methods ) )
```

- The HMAC covers the **raw `vlab_methods` string**, not a re-serialization. Go and
  JS never have to agree on JSON key order or spacing.
- `v2|` is a version tag. `|` cannot occur in a PSID, a phone number, a page id, a
  platform name or base64url, so distinct links cannot collide.
- There is no expiry and no nonce. A replayed link can only re-verify **the same**
  conversation, which is harmless because the wait is idempotent.
- bouncer compares with `hmac.Equal`.
- A shared test vector in both test suites pins the scheme.

The key is a shared secret in two places, replybot's `gbv-bot-envs` and bouncer's own
secret, generated once per environment (`openssl rand -hex 32`).

### Why Cloudflare Turnstile is the default captcha

It is free, usually invisible or a single tap, and has no image grids. That matters on
low-end Android in the countries we recruit from. Tokens are single-use and expire
in 300s. bouncer requires siteverify's `hostname` to equal its own host, and `cdata` to
equal `vlab_sig` (the widget is rendered with that cData). So a token solved on one
conversation's page cannot be spent on another's.

Under Cloudflare's published dummy secrets, siteverify returns a fixed
`hostname: localhost` / `cdata: test-data`. bouncer detects those secrets, logs
`[BOUNCER_TEST_KEYS]`, and skips the binding checks. This costs nothing, because an
always-pass secret already lets everyone through.

## 4. The event

```jsonc
{
  "user": "<vlab_user>",
  "account_id": "<vlab_account>",
  "page": "<vlab_account>",
  "platform": "messenger|whatsapp",
  "event": { "type": "external", "value": {
    "type": "bouncer:verified",
    "methods": [{ "type": "captcha", "provider": "turnstile" }]   // what ran, default resolved
  } }
}
```

**It is emitted once, after every method has passed, and only on success.**
`waitConditionFulfilled` matches by *subset* (`waiting.js` `_contains`), so any
`bouncer:verified` event, including a hypothetical `passed: false` one, would release
the wait. A failed step stays on the page and the participant retries. `methods` is
extra data for analysis and does not affect matching.

bouncer requires all three identity components. It is a new service with no legacy
URLs in flight, so it is compliant with `SYNTHETIC_REQUIRE_CONVERSATION` from day one.

**The event is the product.** If hermes does not answer 200, the page says "try
again" and never shows "verified". This is the opposite of linksniffer's best-effort
rule.

## 5. replybot

- `normalizeVerificationMethods(methods, ref)` (pure) validates against
  `VERIFICATION_METHODS`, fills in `provider: default`, and throws `[INVALID_FIELD_CONTENT]`.
- `encodeVerificationMethods`, `verificationSignature` and `buildIdVerificationUrl` are
  all pure.
- `translateIdVerification`:
  - base from `BOUNCER_URL` (`[MISSING_SERVICE_URL]` if unset);
  - key from `BOUNCER_HMAC_KEY` (`[MISSING_SERVICE_SECRET]` if unset). Both throw at the
    point of use, so other field types keep working;
  - **injects the default wait** `{type: external, value: {type: bouncer:verified}}` when
    none is authored. An authored wait (e.g. one with a timeout) wins;
  - **refuses `keepMoving`**, because `machine.js` returns on `keepMoving` before it reads
    `wait`, which would send the button and move on unverified;
  - emits the usual `webview` wire message with `extensions: false`.
- `generic-validator.js`: `id_verification: validateStatement`.

**Recommended placement: immediately before a payment field.** This is documented in
`documentation/questions.md` as the standard advice.

## 6. bouncer

| File | Contents |
|---|---|
| `methods.go` | Pure. `Method`, `allowedProviders`, `defaultProvider`, `decodeMethods` (strict: unknown JSON fields rejected), `resolveMethods` |
| `identity.go` | Pure. `parseLink` (every component required, platform ∈ {messenger, whatsapp}), `sign`/`verifySig` |
| `turnstile.go` | Pure `judgeSiteverify`, plus a thin siteverify client |
| `eventer.go` | Pure `buildEvent`, and `Send` for the IO |
| `server.go` | `openLink` (parse → signature → methods), `checkStep` (one case per method:provider), and the handlers |
| `page.html` | Embedded. One section per step, and a `runners` table keyed `type:provider`. Turnstile is rendered explicitly with `cData = vlab_sig` |

| Path | Method | Purpose |
|---|---|---|
| `/verify` | GET | Check the link, render the steps; 400 + "link isn't working" if it is bad |
| `/verify/submit` | POST | `{vlab_*, results: [{token}, …]}` → check each step → event → `{status}` |
| `/health` | GET | `pong` |

**Adding a method:**
1. bouncer: `allowedProviders`/`defaultProvider`, a `checkStep` case, and a page
   runner. A test asserts that every allowed provider resolves to one `checkStep` handles.
2. replybot: `VERIFICATION_METHODS`.
3. Deploy bouncer first.

## 7. Configuration and deploy (all through files, per CLAUDE.md)

| What | Where |
|---|---|
| bouncer image | `.github/workflows/release.yml` case `bouncer`, tag `bouncer-v0.0.1` |
| bouncer chart | `bouncer/chart/`, published to the OCI chart repo (`devops/README.md` §helm push) |
| umbrella dep | `devops/vlab/Chart.yaml`, behind `tags: [bouncer]` |
| deployment values | `devops/values/{staging,production}.yaml` `bouncer:` block: ingress `/verify` on `id.vlab.digital` / `staging.id.vlab.digital`, env `BOTSERVER_URL`, `BOUNCER_HOSTNAME`, `TURNSTILE_SITE_KEY`, `envFrom: bouncer` |
| bouncer secrets | `bouncer/.env-example` → `bouncer/.env-{staging,production}` → `devops/secrets.sh <ns> bouncer …`: `TURNSTILE_SECRET_KEY`, `BOUNCER_HMAC_KEY` |
| replybot config | values `BOUNCER_URL` (`https://id.vlab.digital/verify`); `BOUNCER_HMAC_KEY` in `replybot/.env-<env>` → `gbv-bot-envs` |

**Manual, one-time, human steps** (outward-facing, not done by the agent), listed in
`bouncer/README.md` § Deploy:
1. Cloudflare Turnstile widget per host.
2. DNS.
3. The HMAC key in both env files.
4. The site key in values.
5. Push the chart **before any `helm upgrade` from this branch**, then `helm dep update`.

## 8. Build order

1. bouncer core + tests. **Done.**
2. replybot `id_verification` + tests, including the shared vector. **Done.**
3. The page, checked in a browser with Turnstile test keys, pass and fail. **Done.**
4. Packaging: Dockerfile, chart, CI case, values (`tags.bouncer: false`). **Done.**
5. Docs: `bouncer/README.md`, `documentation/questions.md`, `documentation/event-envelope.md`,
   `replybot/README.md`, and the MCP authoring hints. **Done.**
6. **Staging rollout** (human-gated): the §7 manual steps, deploy, then one end-to-end run on
   Messenger and one on WhatsApp through a test survey.
7. Production.

## 8a. End-to-end test

`facebot/testrunner/test.tc.ts` § "Verification (bouncer)" runs bouncer in the
testcontainers stack, with the `auto` method enabled, against the form
`forms/idVrfy.json`. A real captcha cannot be solved in CI, so `auto` stands in for
it, and everything except the provider call is real:
- replybot signs the link with `BOUNCER_HMAC_KEY` from env;
- bouncer checks it with its own copy of the key;
- `bouncer:verified` reaches hermes and advances the survey.

The second test checks that a link tampered to another user, or with a swapped method
list, gets a 400 on both the page and submit, and that the survey keeps waiting until
the genuine link is submitted. The Turnstile call itself is covered by bouncer's unit
tests and was checked by hand in a browser with Cloudflare's test keys.
`testcontainers-integration.yml` now also triggers on `bouncer/**`.

## 9. Open questions / follow-ups

- **Localization.** Page copy in the participant's language, deferred until a study
  needs it. Turnstile's widget localizes itself.
- **Exporter.** `exporter/exporter.py` buckets unknown external subtypes as
  `external_other`. Adding `bouncer` to the tracking categories is a follow-up.
- **Rate limiting** on `/verify/submit` per identity. V1 relies on the providers' own
  limits.
- **Per-method events** for analytics, if a multi-method list is ever used and we
  want to know where people drop off. Today the single success event records what ran.
