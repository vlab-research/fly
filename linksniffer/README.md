# linksniffer

A stateless tracked-link forwarder. When participants click tracked links, linksniffer:
1. Receives a click with query parameters (replybot-built, or legacy hand-authored)
2. Posts a synthetic event to track the click
3. Redirects the participant to their destination URL

linksniffer has no database, no persistent state, and no dependencies beyond the Go standard library and Echo. Tracking is best-effort; the redirect is the product.

## Query Parameters

Replybot builds new tracked links with a canonical set of query parameters. Legacy links built before this design carry older param names; linksniffer reads both.

**Canonical (replybot-built) params:**

| Parameter | Purpose |
|-----------|---------|
| `vlab_user` | Participant ID |
| `vlab_account` | Account ID |
| `vlab_platform` | Platform: `messenger` or `whatsapp` |
| `vlab_video` | Vimeo video ID (moviehouse only) |
| `url` | Destination URL (base, without protocol) — content, not identity |
| `p` | Protocol: `https` (default), `http`, `tel`, `mailto`, `sms` — content, not identity |

**Legacy (hand-authored) param names:**

| Legacy | Canonical |
|--------|-----------|
| `id` | `vlab_user` |
| `account_id` | `vlab_account` |
| `pageid` | `vlab_account` (older alias) |
| `platform` | `vlab_platform` |

When both canonical and legacy names are present, the canonical name wins. When a canonical param is empty, linksniffer does not shadow it with a legacy value — an empty string is a poisoned cache key, worse than an absent one. This fallback chain is load-bearing: a Messenger conversation stays open for 24 hours, so links delivered before this deploy get clicked after it, carrying legacy param names. Dropping support would 400 those clicks and lose the event a `wait` on `linksniffer:click` is blocked on.

Destination params (`url` and `p`) are content, not identity, and are always written by replybot in new fields. They keep their names across both eras.

## Synthetic Event

linksniffer posts to the botserver's `/synthetic` endpoint with:

```jsonc
{
  "user": "<user_id>",              // from vlab_user or legacy id
  "account_id": "<account>",        // from vlab_account, account_id, or pageid
  "page": "<account>",              // same as account_id (legacy; kept for compatibility)
  "platform": "messenger|whatsapp", // from vlab_platform, platform, or assumed
  "event": {
    "type": "external",
    "value": {
      "type": "linksniffer:click",
      "url": "<final_url>"           // constructed from url and p
    }
  }
}
```

This conforms to the [event envelope contract](../documentation/event-envelope.md) with the triple `(platform, account_id, user_id)` required by the gate `SYNTHETIC_REQUIRE_CONVERSATION`.

## Platform Handling

When a link provides neither `vlab_platform` nor `platform`, linksniffer defaults to `"messenger"` and logs:

```
[LINKSNIFFER_PLATFORM_ASSUMED] id=<user_id> account=<account_id>
```

This happens only with **legacy hand-authored links** — replybot-built canonical links always provide `vlab_platform`. The assumption is necessary because old links delivered before this deploy continue to arrive for 24 hours (Messenger's message window). Dropping the fallback would 400 those clicks and lose the event.

Count `[LINKSNIFFER_PLATFORM_ASSUMED]` to zero to confirm every production link supplies its platform. This is a separate counter from hermes' `[INCOMPLETE_CONVERSATION]` — an assumed platform stamps cleanly and passes the conversation envelope gate.

### Invalid platform: `[LINKSNIFFER_PLATFORM_INVALID]`

A platform value that is not `messenger` or `whatsapp` (e.g., a typo, wrong case, or the non-platform `synthetic`) is rejected:

```
[LINKSNIFFER_PLATFORM_INVALID] id=<user_id> account=<account_id> platform="<value>" -- not a known platform, assuming messenger
```

The value becomes part of the conversation identity downstream, so a typo would otherwise create a poisoned cache key addressing a conversation that does not exist. Validating at the edge and logging under its own tag keeps typos separate from legacy assumed-platform clicks.

## Always-Redirect Guarantee: `[LINKSNIFFER_EVENT_FAILED]`

Tracking is best-effort. If the event POST fails — whether the server returns non-200 or is unreachable — linksniffer still redirects the participant to their destination URL:

```
[LINKSNIFFER_EVENT_FAILED] id=<user_id> account=<account_id> error=<error>
```

This guarantee is critical: a participant's link never fails because the tracking backend is temporarily down. The click is **lost** (not mis-recorded); any `wait` conditioned on `linksniffer:click` will not resolve from it. But the participant reaches their destination.

The one exception is a **missing `vlab_user` (or legacy `id`)**, which returns `400` — a misconfigured link that should surface the authoring mistake instead of silently producing untrackable clicks.

## Malformed Destination: `[LINKSNIFFER_BAD_URL]`

When the destination cannot be URL-unescaped, linksniffer returns `400` and logs:

```
[LINKSNIFFER_BAD_URL] id=<user_id> url="<value>" could not be unescaped: <error>
```

## Known Gaps

- An empty or missing `url` produces a redirect to `https://`, which is broken. This case actually cannot redirect meaningfully and is not currently rejected.
- `vlab_account` / `account_id` / `pageid` remain optional, so replybot-built links without an account post an empty value. Hermes stamps the envelope only when a field derives to a non-empty string, so this surfaces as `[INCOMPLETE_CONVERSATION]` downstream rather than a poisoned cache key.

## Environment

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `BOTSERVER_URL` | yes | — | URL to hermes' `/synthetic` endpoint, e.g. `http://gbv-hermes/synthetic` |

## Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/` | GET | Click a tracked link (receives query params, posts event, redirects) |
| `/health` | GET | Health check (returns `pong` with 200) |

Port: **1323**

## Pure Functions

The handler logic separates concerns using pure, unit-testable functions:

- **`firstNonEmpty(values ...string) string`** — pure: returns the first non-empty value, or empty string. Implements the canonical-first, legacy-fallback chain: replybot's `vlab_*` params win, legacy names consulted only when canonical is empty.
- **`resolvePlatform(platformParam string) (platform string, assumed bool, invalid bool)`** — pure: resolves and validates the platform, returning the platform value, whether it was assumed (no param provided), and whether a supplied value was rejected as invalid (not `messenger` or `whatsapp`).
- **`buildRedirectURL(baseURL, protocol string) string`** — pure: constructs the final URL from base and protocol — e.g. `https://` + destination, `tel:` + number, etc.

These are unit-testable with no server, no HTTP, no mocking. The handler (`forward`) is a thin imperative shell that calls them and manages IO (logging, event POST, redirect).

## Testing

Run all tests:

```bash
cd linksniffer
go test ./... -v
```

Tests cover:
- Canonical `vlab_*` params (read first, win over legacy names)
- Legacy param fallback chain (e.g. `vlab_account` → `account_id` → `pageid`)
- Empty canonical params do not shadow legacy values
- Fallback chains preserve empty values (do not shadow with non-empty legacy)
- Platform assumption when no platform param supplied, logging `[LINKSNIFFER_PLATFORM_ASSUMED]`
- Explicit platform pass-through (and that it does *not* log the assumed tag)
- Rejection of unknown/mis-cased platform, logging `[LINKSNIFFER_PLATFORM_INVALID]`
- **Redirect always happens when the event POST fails** — both non-200 and connection refused
- Destination protocol support (https, http, tel, mailto, sms)
- 400 on missing user ID
- Exact posted JSON body, including field order

## See Also

- `documentation/event-envelope.md` — the synthetic event contract and the conversation identity envelope
- `documentation/questions.md` § "Tracked links" and "Videos (Moviehouse)" — how researchers author first-party link and video fields
- `replybot/README.md` § "First-party URL Types" — how replybot builds the canonical URLs with conversation identity
