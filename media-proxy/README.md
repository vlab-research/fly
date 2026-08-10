# media-proxy

The **sole public read path for media assets**. It serves `media.vlab.digital`.

A researcher uploads a file in the dashboard's media tab and gets back a URL. This
service is what answers that URL — for a respondent's phone, for a browser preview,
and for Meta's fetcher when a message is sent by URL rather than by a cached platform
media id.

Design source: `planning/media-abstraction.md` §4.4, with the security model in §4.6
and the test philosophy in §10.

---

## What it does, in full

Four things. There is deliberately nothing else in here.

1. **Validate the path shape.** `/a/<uuid>` optionally followed by one filename
   segment. Anything else is rejected before storage is touched.
2. **Fetch from object storage** over the S3 API with a read-scoped credential, and
   **stream** the body (`io.Copy` — objects run to video size and are never buffered
   whole).
3. **Set headers in code**, from object metadata written at upload — never sniffed,
   never client-supplied.
4. **Serve GET and HEAD only.**

## The path contract

```
URL:  https://media.vlab.digital/a/550e8400-e29b-41d4-a716-446655440000/welcome.png
key:  a/550e8400-e29b-41d4-a716-446655440000
```

- The uuid is matched as a fixed 8-4-4-4-12 hex shape. The segment that becomes part
  of an object key therefore cannot contain `..`, `/`, or anything else meaningful to
  a storage backend. **Traversal is impossible by construction, not by escaping.**
- **The filename segment is cosmetic and ignored.** It exists for humans and for
  WhatsApp document sends. Two URLs differing only in filename address the same
  object, so a rename never touches storage and filenames can never collide.
- Query strings and fragments are ignored; the uuid is lower-cased before use, so
  case in a pasted URL cannot address a second object.
- **`a/` is the only reachable prefix.** Whatever else lives in the bucket is
  unaddressable through this service.
- `/health` is the one non-asset route. It reports on the process and never touches
  storage — a proxy whose backend is down should raise a 502 alert, not get restarted
  by kubelet.

The regex here is character-for-character the one in `message-worker/mediaresolve`.
They are duplicated rather than shared because the two modules build and ship
independently (each Dockerfile copies only its own directory), and coupling two deploy
units for one line of regex is a worse trade. The parity is pinned instead by a test
table copied verbatim between the two suites — see `internal/media/path_test.go`.

## Headers it sets

| Header | Value | Why |
|---|---|---|
| `Content-Type` | from object metadata | Set by dashboard-server at `PutObject`. Never sniffed at serve time, never taken from the request. Falls back to `application/octet-stream`, which renders as nothing anywhere. |
| `Content-Disposition` | from object metadata | Same origin. Defaults to `inline` so images and video preview; dashboard-server sets an explicit `attachment` for file assets. |
| `X-Content-Type-Options` | `nosniff` | The browser must not second-guess the stored type. |
| `Content-Security-Policy` | `default-src 'none'` | Neutralises an uploaded HTML or SVG payload: even served as `text/html` it can load nothing, run nothing, reach nothing. |
| `Cache-Control` | `public, max-age=31536000, immutable` on success; `no-store` on errors | The URL *is* the identity — an asset id addresses one set of bytes forever, so a cached success can never be stale. Errors are excluded so a 404 served during a storage blip is not pinned into a CDN for a year. |
| `ETag`, `Last-Modified`, `Content-Length` | passed through | Ordinary cache validators. |

`nosniff` and the CSP are on **every** response, successes and rejections alike.

## Statuses: everything is 404, never 405

Every rejection returns a bare **404 with an empty body** — wrong method, malformed
path, unknown prefix, and genuinely-absent asset are indistinguishable from outside.

This is a deliberate choice over the more conventional `405 Method Not Allowed`.
Asset URLs are **capability URLs** (§4.6): unguessable, non-enumerable, and readable
by anyone holding one. A 405 would answer `POST /a/<uuid>` differently depending on
whether that uuid exists, and would carry an `Allow` header confirming the resource is
real — an existence oracle on exactly the identifier whose unguessability is the whole
security model. A uniform 404 leaks nothing, and it is one rule rather than a table of
cases that can drift apart.

The one status that *is* distinct is **502**, when the storage backend itself fails.
That must not collapse into 404, or a dead MinIO would look like a bucket full of
missing assets — a quiet outage instead of a loud one.

## Why the bucket is private

**There is no anonymous read policy on the media bucket at all**, and this service is
the only way in.

MinIO's canned anonymous policies are traps. `download` grants `s3:GetObject` **and
`s3:ListBucket`** — it permits exactly the enumeration it appears to prevent, which
would turn unguessable capability URLs into a directory listing. `public` is read
*and write*, so a mis-set policy allows anonymous uploads into a bucket served under
our own domain. A fully private bucket removes that entire failure class structurally
rather than by getting a policy right.

Private also means every read passes through code we control, which is what makes the
header table above enforceable in the first place.

The credential this service holds is a **MinIO service account scoped to read the
`media` bucket only**. It is not the root credential and cannot reach the `exports`
bucket, which holds respondent data.

`media.vlab.digital` is a **separate origin from the dashboard** on purpose: an
uploaded HTML or SVG has no dashboard session to reach even if the CSP were removed.

## Why it has no database

**It has no database client, and adding one would be a regression.**

`Content-Type` and `Content-Disposition` come from S3 object metadata rather than from
the `media_asset` row. That single decision is what keeps this service database-free —
and being database-free is what stops it from being the thing that breaks when
CockroachDB is slow. Media delivery is on the critical path for every message that has
no cached platform handle (§13); coupling it to the database that the whole chat
pipeline is already contending on would put the two failures in series.

The metadata is still **server-set**: dashboard-server writes it at upload, from a
sniffed-and-validated type, never from the client. Moving where it is *read* from does
not weaken where it is *decided*.

For the same reason this is not a route on dashboard-server (it would couple media
delivery to dashboard uptime) and not folded into hermes (it would couple it to the
inbound webhook path).

## Layout

```
main.go                      wiring only: env -> S3 client -> handler -> http.Server
config.go                    environment (§4.7)
internal/media/
    path.go                  PURE  path contract: ParseAssetID, ObjectKeyFor, MethodAllowed
    headers.go               PURE  ResponseHeaders — the whole header table, as data
    object.go                       Object, ObjectStore interface, ErrNotFound
    handler.go               shell  decide (pure) then do: ask the store, copy bytes
    s3store.go               shell  the only file that names S3; translates NoSuchKey -> ErrNotFound
```

`ObjectStore` is the service's entire dependency on the outside world — two methods,
no bucket in the signature, no S3 vocabulary above `s3store.go`. That is the
cloud-agnostic rule of §4.1 expressed as a type, and it is what lets the whole suite
run against a stub.

`main.go` deliberately does **not** use `http.ServeMux`: ServeMux cleans and redirects
paths before a handler sees them, which would mean a traversal attempt got a 301 from
the router rather than a rejection from the path contract — correct by accident, and
untrue the day the router changes.

## Configuration

All from the environment (§4.7). Non-secret values go in `devops/values/<env>.yaml`
via helm; the two keys go in a gitignored `.env` applied with `devops/secrets.sh`.
Nothing is set imperatively.

| Variable | Default | Notes |
|---|---|---|
| `S3_ENDPOINT` | — | Required. `https://…` enables TLS; a bare `host:port` is plaintext. |
| `S3_REGION` | `us-east-1` | MinIO ignores it; the S3 protocol requires it. |
| `S3_ACCESS_KEY_ID` | — | Required. The read-scoped service account. |
| `S3_SECRET_ACCESS_KEY` | — | Required. |
| `MEDIA_BUCKET` | `media` | Separate bucket from `exports` — different blast radius. |
| `MEDIA_PREFIX` | `a/` | Must match the URL prefix and dashboard-server's `storageKeyFor`. |
| `PORT` | `8080` | |

Missing required values fail loudly at startup rather than on the first request: a
proxy that boots healthy with the wrong bucket would 404 every asset while looking
fine to Kubernetes.

There is no `DATABASE_URL`, and that absence is the design.

## Tests

```bash
go build ./... && go vet ./... && go test ./... -cover
```

The suite runs with **no MinIO and no network** — the handler depends on the
`ObjectStore` interface and the tests supply a stub that records every key it is asked
for. §10 calls the path validation security-critical and therefore exhaustive, and the
assertion that carries the most weight is `store.calls() == 0` on every rejected
request: a 404 produced by asking storage and getting a miss looks identical from
outside while being a completely different, and much worse, system.

Covered: the accepted shapes; traversal, other prefixes, other buckets and malformed
uuids rejected without reaching storage; the filename segment provably ignored (many
filenames, one key); `nosniff`, CSP and the stored content type on every response;
non-GET/HEAD rejected before storage; HEAD answered from `Stat` with no body.

Not covered by unit tests, on purpose: that the env vars are wired, that the bucket
policy denies anonymous access, that the ingress and certificate resolve. §10 assigns
that class to the **deploy gates** in §9.2 — configuration bugs never survive first
contact with a smoke test, and a test for them costs maintenance forever.

## Deployment

All from files, per `CLAUDE.md` — nothing here is applied imperatively.

| Concern | File | Applied by |
|---|---|---|
| Deployment, Service, PDB | `media-proxy/chart/` | `helm upgrade gbv devops/vlab -f devops/values/<env>.yaml -n <ns>` |
| Per-env config (§4.7) | `devops/values/{production,staging}.yaml`, under `media-proxy:` | same |
| Public host + TLS | `devops/media-ingress.yaml` | `kubectl apply -f devops/media-ingress.yaml` |
| The two S3 keys | gitignored `media-proxy/.env-media-<env>` (template: `.env-example`) | `bash devops/secrets.sh <ns> media-proxy media-proxy/.env-media-<env>` |
| The credential itself | `devops/minio-media-readonly-policy.json` | `bash devops/minio/media-svcacct.sh <production\|staging>` |

The chart is vendored into the `devops/vlab` umbrella as a `file://` dependency,
following hermes, rather than published to the OCI registry: this service's chart
changes in lockstep with the values files above, and a separately-versioned
artifact would let the two drift.

The chart has **no ingress template** on purpose — the public host is the raw
manifest, and nginx will not admit two Ingresses claiming one host.

**Pods do not reload secrets.** After `secrets.sh`, roll the deployment:
`kubectl rollout restart deployment/gbv-media-proxy -n <ns>`.

## Operations

Run **≥2 replicas with a PodDisruptionBudget**. §13: if media-proxy is down, media
sends that have no cached handle fail — handle sends are unaffected, which is the
strongest single argument for the handle layer existing.

Both are set in the values files, and both are requirements rather than defaults
worth trimming. `replicaCount: 2` alone only guarantees two pods *exist*; the PDB
is what stops a node drain or a cluster upgrade from evicting both at once — which
is exactly the window in which "there is always a second one" is being relied on.
The Deployment also rolls with `maxUnavailable: 0`, so a deploy never dips below
the running count either.

Alert on 502 rate (storage backend failing), not on 404 rate — capability URLs get
pasted into chats and crawled, so misses are ordinary traffic.

`/health` never touches storage (above), so a dead MinIO surfaces as 502s rather
than as kubelet restarting these pods. Restarting them would fix nothing and would
remove the only thing still able to serve.

Storage capacity has its own alerts and runbooks — `documentation/alerting.md`
§10. The `media` bucket has no lifecycle rule and only grows.

## Known gaps

- **No `Range` support.** Requests are served whole and `Accept-Ranges` is not
  advertised, so clients do not attempt partial fetches. §4.4 does not mention ranges
  and Meta's fetchers pull whole objects. If browser video seeking on
  `media.vlab.digital` ever matters, this is where it goes — passing the client's
  `Range` through to `GetObject` and returning 206.
- **No conditional-request handling.** `ETag` and `Last-Modified` are emitted but
  `If-None-Match` / `If-Modified-Since` are not honoured with a 304. With a one-year
  immutable `Cache-Control` a well-behaved cache should never revalidate, so this buys
  little today.
