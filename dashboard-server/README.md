# Dashboard Server
Backend service to serve data to dashboard client.

## API Architecture

### Server Overview
- **Framework**: Express.js
- **Port**: 3000
- **API version prefix**: `/api/v1`

### Authentication

JWT-based authentication with two modes, implemented in `middleware/auth.js`:

- **Client (dashboard) auth**: JWT tokens issued by Auth0. The React SPA obtains a Bearer token from Auth0 and sends it with every request.
- **Server-to-server auth**: HS256-signed JWTs for internal service communication (e.g., export callbacks).

### User Scoping and Authorization

All queries filter by `req.user.email` so that users only see their own surveys and data. This is the primary access-control mechanism.

For survey-specific endpoints, there are two authorization middleware patterns:

**1. `validateSurveyAccess`** - Validates access to a single survey by shortcode or ID:

```javascript
const validateSurveyAccess = async (req, res, next) => {
  const { email } = req.user;
  const surveys = await Survey.retrieve({ email });
  const survey = surveys.find(s => s.shortcode === surveyId || s.id === surveyId);
  if (!survey) return res.status(403);
  req.survey = survey;
  next();
};
```

**2. `validateSurveyNameAccess`** - Validates access to all forms under a survey_name:

```javascript
const validateSurveyNameAccess = async (req, res, next) => {
  const { email } = req.user;
  const { surveyName } = req.params;
  const surveys = await Survey.retrieve({ email });
  const matchingSurveys = surveys.filter(s => s.survey_name === surveyName);
  if (matchingSurveys.length === 0) return res.status(403);
  req.surveyShortcodes = matchingSurveys.map(s => s.shortcode); // All shortcodes for this survey_name
  next();
};
```

This pattern is used when a "survey" (identified by `survey_name`) can contain multiple forms (shortcodes), and the endpoint needs access to data across all forms.

### Route Structure

| Route | Purpose |
|-------|---------|
| `/responses` | Survey response data |
| `/surveys` | Survey CRUD and settings |
| `/users` | Account operations |
| `/exports` | Async data export (via Kafka) |
| `/typeform` | Typeform integration |
| `/credentials` | Credential management. **Messaging entities dual-write the account registry — see "Credentials and the messaging account registry"** |
| `/facebook` | Facebook integration |
| `/auth` | Authentication endpoints |
| `/users/:userId/bails` | User-scoped bail-out system management (list, create, get, update, delete, preview); access controlled via `validateUserAccess` middleware |
| `/users/:userId/bail-events` | All bail events for a user |
| `/surveys/:surveyName/states` | Participant state monitoring (summary, list, detail) |
| `/surveys/:surveyName/health` | Survey health findings for the Monitor tab (24h aggregates + declarative ruleset); see `documentation/dashboard-study-health.md` |
| `/platform/notices` | Platform-wide notices proxied from AlertManager (whitelisted alertnames, fail-soft) |
| `/media` | Researcher media library — upload bytes, get back a permanent public URL. Platform-independent: no page selector, no connected-page requirement. See "Media endpoints" below |
| `/message-templates` | Facebook Utility Message templates (CRUD per `(page, name, language)`); see `documentation/utility-messages.md` |
| `/tickets` | Support tickets — thin UI proxy over Linear (no local storage); see `documentation/tickets.md` |

### Credentials

`POST /api/v1/credentials` is the **single** credential-create path. Both messaging
connect flows go through it — `dashboard-client` `FacebookPages.js` and
`WhatsAppEmbedded.js` each POST `entity` themselves — so there is no separate
"connect" endpoint distinct from a generic one, which is worth knowing before adding
entity-specific behaviour here.

A messaging credential's `key` **is** the platform account id (`facebook_page` →
page id, `whatsapp_business` → phone_number_id), and those ids are globally unique
across messaging entities, so a token can be resolved from an account id alone
without knowing the platform. See `message-worker/tokenstore.go`.

### Media

The media feature moved from page-scoped Facebook `attachment_id`s to an
asset/handle model (`planning/media-abstraction.md`; migration
`24-media-assets.sql`).

| File | Role |
|---|---|
| `api/media/media.core.js` | Pure decision layer — validation, hashing, keys, URLs, reconcile planning. No IO |
| `api/media/media.controller.js` | The imperative shell: sequences IO, maps outcomes onto HTTP |
| `api/media/storage/index.js` | S3 client (`minio`), `{put, get, delete, publicUrl}` |
| `api/media/media.platform-upload.js` | Pre-upload of bytes to Messenger / WhatsApp, producing a handle |
| `api/media/media.reconcile.js` | The reconciler shell around `planReconcile` — reads state, bounds the work, executes, reports |
| `scripts/media-reconcile.js` | CronJob entry point (`node scripts/media-reconcile.js`) |
| `api/media/media.routes.js` | Multer wiring and the three endpoints |
| `queries/media/media.queries.js` | `media_asset` reads/writes and the `media_handle` upsert |
| `queries/credentials` → `getMessagingAccounts` | The fan-out target set |

#### Media endpoints

| Endpoint | Behaviour |
|---|---|
| `POST /media/upload` | multipart `file`. `201` with the new asset, or **`200` with the existing one** on a dedupe hit |
| `GET /media` | The caller's assets, newest first |

The response shape is `{id, filename, mediaType, mimeType, byteSize, created, url}`.
**`url` is the whole product** — it is what a researcher pastes into a survey.
It is derived from the asset id and `MEDIA_PUBLIC_BASE` rather than stored (§5),
so moving the media domain is a helm edit and not a data migration. No platform
identifier and no handle state is ever returned: handle freshness is our problem,
not the author's.

**`DELETE /media/:id` is not offered in v1.** We hold the only copy of every
researcher's file, distributed MinIO does not cover cluster-level disk loss, and
nothing checks whether a live survey references an asset before deletion — so
a delete click is permanent, unrecoverable data loss that silently breaks
respondent flows with zero signal to anyone. See `planning/media-abstraction.md`
§11.6 for the full reasoning. Deletion can be revisited once backup (VIR-24)
exists and reference counting against surveys is implemented. In the interim,
the accidental-confidential-upload case is handled out-of-band.

**`GET /media/pages` was deleted.** Asset creation is platform-independent, so
there is no page for the author to select. An account picker at upload was
considered and rejected in design (§2): it is the prod/staging environment
question moved one screen earlier, the author still lacks the information to
choose correctly since a survey resolves under *any* of its owner's accounts,
and a wrong pick fails **silently** as a URL send that looks fine.

#### The upload pipeline

```
validate -> hash -> dedupe -> put -> insert asset -> respond -> fan out
```

Two things about that order are deliberate.

**`put` before `insert`.** The asset id is generated in the controller rather
than defaulted by the database, because the object key derives from it. That
makes the failure mode the better one: a stored object with no row is
unreachable garbage, while a row with no object is a broken image in a
respondent's chat.

**Fan-out runs after the response is sent and can never fail the upload.** A
handle is always an optimisation, never a requirement, so an upload must succeed
with zero connected accounts, with a dead page token, or with Meta down — and it
does, pinned by test in all three cases. Failures are `Promise.allSettled` +
logged; the reconciler backfills. `uploadMedia` still *returns* a promise that
resolves after fan-out, purely so tests can observe it.

**Dedupe is per researcher, never global** (`UNIQUE (userid, content_hash)`).
The same user re-uploading identical bytes gets the existing asset back with no
second row and no second object; a *different* user uploading the same bytes
gets their own row. Global dedupe would give them one shared row, and the second
researcher's media tab — which filters by `userid` — would not show their own
file. That asymmetry is pinned against a real database.

#### Fan-out writes `account_id = credentials.key`

This is the one seam that matters. `message-worker` looks a handle up by
`(asset_id, account_id)` alone, and `account_id` is `credentials.key` — the page
id or phone number id. **Not** `credentials.entity`, **not**
`details->>'page_id'`. Writing anything else produces handles nothing ever
reads, and the failure is *invisible*, because a lookup miss is the designed URL
fallback rather than an error. Both the unit and the integration suite assert
this against decoy fields planted in `details`.

`platform` is written as the canonical spelling (`messenger`/`whatsapp`, not
`facebook_page`/`whatsapp_business`) and is descriptive only — never a lookup key.

#### Platform pre-upload (`media.platform-upload.js`)

Both platforms are one code path: the same multipart POST with a different
endpoint, form shape and response field.

| Platform | Endpoint | Id field | Handle TTL |
|---|---|---|---|
| Messenger | `POST /me/message_attachments` | `attachment_id` | **90 days** |
| WhatsApp | `POST /{phone_number_id}/media` | `id` | 30 days |

The TTLs are read from `DEFAULT_RECONCILE_POLICY.ttlMs` in the core rather than
duplicated here, so the reconciler's notion of when a handle dies and the
writer's notion of when it expires cannot drift. **Never write a handle with a
null expiry** — see the warning in the reconciliation section below.

#### Object storage (`api/media/storage/index.js`)

The S3 API and nothing else (§4.1): no cloud-provider SDK, no provider identity
system, no two-backend abstraction. The client is **`minio` (minio-js)** for the
same reason `media-proxy` uses `minio-go` — it is an S3 client rather than a
vendor SDK, it is a fraction of the dependency weight of `@aws-sdk/client-s3`,
and both sides of the read/write pair then speak the same library's semantics.

**`put` sets `Content-Type` and `Content-Disposition` as object metadata at
PutObject, and that is load-bearing.** media-proxy reads them back off the
object and never sniffs at serve time, which is exactly what keeps the proxy
database-free — it cannot be the thing that breaks when CockroachDB is slow. If
they stop being written, the proxy serves media with no content type, browsers
sniff, and an uploaded payload becomes active content on our own domain. Pinned
by an integration test that `statObject`s a real MinIO.

**`get` exists for exactly one caller: the reconciler.** The upload path already
holds the buffer, `message-worker` never touches storage, and the public read
path is media-proxy — but a refresh re-uploads the *same* bytes to Meta, and we
hold the only copy of them. It is the one reader of object storage inside the
application.

`STORAGE_BACKEND=none` is a dev no-op that discards bytes (matching the
exporter's convention) and warns on every write. Its `get` **throws** rather
than returning an empty buffer: handing the reconciler zero bytes would write a
handle pointing at nothing, which is worse than no handle at all. The reconciler
script refuses to start under `none` for the same reason.

#### Upload size cap

The multer `fileSize` limit is **derived** from `MEDIA_TYPE_LIMITS` — the
largest per-type limit — and never hardcoded. It used to be a flat 25 MB, which
preempted `validateUpload`: a 40 MB video died inside multer with a generic
"file too large" instead of "video is 40.0 MB, maximum is 16.0 MB". Since §11.5's
bargain is that we refuse rather than transcode, the refusal has to name the
actual problem and the actual fix, so multer must be a backstop against
unbounded memory and never the thing that decides eligibility.

#### Local development and tests

`dashboard-server/docker-compose.yml` brings up CockroachDB and MinIO. It
applies `devops/migrations/*.sql` in sorted order — the same production
migration files `facebot/testrunner/stack.ts` uses, rather than a hand-maintained
dev schema, because a migration that does not apply cleanly there has not been
tested. The `media` bucket is created **private**, with no anonymous policy,
mirroring production: MinIO's canned `download` policy grants `s3:ListBucket`
alongside `s3:GetObject`, and `public` grants anonymous writes. Local dev being
more permissive than production is how a bad assumption ships.

```bash
cd dashboard-server
cp .env-dev-example .env      # gitignored; local throwaway credentials
docker compose up -d
npm run test:media            # unit + integration for api/media (both processes)
npm run test:media:upload     # core, controller, reconciler unit, upload integration
npm run test:media:reconcile  # the reconciler shell, in its OWN mocha process
npm test                      # unit only; *.integration.test.js excluded
npm run test:integration      # every integration suite
```

`.env-dev-example` is the template for the local stack. It is deliberately a
**different file** from `.env-example`, which is the template for the production
`dashboard-media` secret and holds only the two scoped S3 keys, left empty — so a
working root credential never sits one copy-paste away from a cluster secret.
See `documentation/secrets.md`.

`*.integration.test.js` is excluded from `npm test` because it needs the stack
up, and failing loudly beats a suite that silently skips the only tests that
touch bytes.

**`test:media` is two mocha processes on purpose, not a glob.** The query layer
is a singleton over one `pg` Pool and `media.integration.test.js` closes that
pool in its `after` hook, so a single process would hand the reconciler suite a
dead connection — which surfaces as a confusing connection error rather than a
test failure. Splitting the run is the cheapest honest fix.

Note that re-running `docker compose up` against an existing volume replays the
migrations, and `04-pointers.sql` is not written idempotently (`ADD COLUMN`
without `IF NOT EXISTS`), so the `migrate` container logs an error and exits
non-zero on a second boot. The schema is already applied at that point, so the
suites run fine; `docker compose down -v` gives a clean apply.

#### Media functional core (`api/media/media.core.js`)

`media.core.js` is the pure decision layer — **no fs, no
network, no database, no `Date.now()`**; anything time-dependent takes `now` as a
parameter, so expiry behaviour is asserted by passing a clock instead of waiting
30 days.

#### Upload Validation and Eligibility (§11.5)

**The dashboard refuses ineligible uploads rather than transcoding or downscaling them.**
Uploads must be both of an allowed MIME type and within the per-type byte limit. Limits
are enforced at the **strictest supported platform's limit**, making eligibility a system-wide
invariant: every asset that exists is guaranteed sendable on every supported platform.
This removes the need for any later per-platform eligibility check.

Limits verified 2026-08-10 against Meta's WhatsApp Cloud API media reference and the
Messenger `saving-assets` page (`planning/media-abstraction.md` §11.5).

| Type | Allowed MIME types | Max size | Rationale |
|---|---|---|---|
| Image | JPEG, PNG (8-bit only) | 5 MB | WhatsApp strictest limit |
| Video | MP4, 3GPP | 16 MB | WhatsApp strictest limit |
| Audio | AAC, MP4, MPEG, AMR, OGG | 16 MB | WhatsApp strictest limit |
| Document | PDF, DOCX, XLSX, PPTX | 100 MB | Meta's list, minus what cannot be identified |

Rejected types (GIF, WebP, WebM, QuickTime, WAV) are not WhatsApp-sendable, so they are
refused with a specific error message naming both the rejected type and the accepted
alternatives for that media class.

**Acceptance is bounded by identification, never by the claimed type or the extension.**
`sniffContentType` returns `application/octet-stream` for anything it cannot positively
name — the same result it returns for an HTML/SVG payload relabelled as an image — and
octet-stream is always refused. That is a deliberate XSS guard (uploaded content is served
back from our own domain), not a gap to "fix" by loosening the check. Widening support
means teaching the sniffer new magic bytes, never accepting unclassified bytes.

Meta lists **eight** document MIME types. Four are accepted, four are not, and each
omission is a decision:

- **PDF** — `%PDF-` magic.
- **DOCX / XLSX / PPTX** — ZIP containers (`PK\x03\x04`). The subtype is read out of the
  package's own `[Content_Types].xml` (inflated from the first ZIP entry) by matching the
  declared `…main+xml` part type, so it is identification rather than a guess. A ZIP that
  does not resolve is reported as `application/zip` — named, so the error can say "ZIP
  archive", but not accepted. Macro-enabled packages (docm/xlsm/pptm) declare a different
  main part, so they fall through to plain ZIP and are refused, which is welcome: they
  carry executable content.
- **DOC / XLS / PPT** — OLE2/CFB compound files (`D0 CF 11 E0 A1 B1 1A E1`). The magic
  names the container, which `.msi` and `.msg` share; telling the three Office types apart
  needs a CFB directory walk down the FAT sector chain, which is out of proportion here.
  Reported as `application/x-ole-storage` and refused with an error naming the format.
- **`text/plain`** — **deliberately not supported.** Text has no magic bytes, so "is this
  text?" cannot be answered; every HTML and SVG payload the octet-stream rejection exists
  to catch is also plain text. Accepting it would mean accepting anything. Pinned by test.

**PNG bit depth is checked; codecs are not.** Meta requires images to be "8-bit, RGB or
RGBA". A 16-bit PNG passes every size and MIME check and is then refused by WhatsApp at
fan-out, leaving an asset that gets no handle and sends by URL forever with nothing
erroring. The depth is one byte at a fixed offset (byte 24 of the IHDR), so it is enforced
and the error names the actual depth. Colour type is **not** enforced — 8-bit greyscale and
palette PNGs are accepted in practice. Video/audio codec constraints (H.264, AAC, OPUS)
need demuxing and are **not** enforced, so the "every asset is sendable everywhere"
invariant holds for size and MIME but not for codecs: the by-URL health signal has a small
non-zero floor rather than being provably zero (§11.5).

#### Core Functions

| Function | Contract |
|---|---|
| `hashContent(buffer)` | sha256 hex. Dedupe **detection** only (`UNIQUE (userid, content_hash)`) — identity is the asset's UUID |
| `storageKeyFor(assetId)` | `a/<uuid>`; throws on anything that is not a UUID, which is what keeps a key inside the prefix |
| `publicUrlFor(base, assetId, filename)` | `<base>/a/<uuid>/<filename>`; the filename segment is cosmetic and percent-encoded |
| `parseAssetId(url)` | uuid or null. **Host-independent** — path shape only |
| `sniffContentType(buffer, claimed)` | Magic-byte detection. A claim can only narrow within the same container, never widen trust; anything unrecognised is `application/octet-stream`. ZIPs are resolved to docx/xlsx/pptx via the package manifest, or reported as plain `application/zip`; OLE2 is named but not resolved |
| `pngBitDepth(buffer)` | The depth byte from a PNG's IHDR, or `null` when there is no readable header. `validateUpload` accepts only 8 |
| `validateUpload(file)` | `{ok:true, filename, mimeType, mediaType, byteSize}` / `{ok:false, error}` — every client-asserted fact is recomputed. Size limits are enforced using the **sniffed** MIME type, never the client's claim |
| `buildAssetRecord(email, hash, meta)` | The write-once `media_asset` row |
| `planReconcile(now, assets, accounts, handles, policy)` | The reconciler's entire decision layer — see below |

Two properties are load-bearing and are pinned by tests:

- **`parseAssetId` is the JS twin of `message-worker/mediaresolve.ParseAssetID`.**
  Both decide the same question on opposite sides of the system, and the test
  tables are deliberately identical. Host-independence is what lets a production
  media URL pasted into a survey run on staging: it parses, misses the local
  lookup, and sends the production URL, which the production proxy serves.
- **Handles are matched on `account_id` alone, never on `(platform, account_id)`.**
  `credentials.entity` says `facebook_page`/`whatsapp_business` while
  `SendMessageCommand` says `messenger`/`whatsapp`, so a two-part key would let
  the writer and reader disagree — and the failure would be invisible, since a
  lookup miss is the designed URL fallback rather than an error. `platform` is
  descriptive only. See the comment in `devops/migrations/24-media-assets.sql`.

#### Reconciliation

`planReconcile` compares desired state (each asset × each of its owner's
messaging accounts) with the handle rows it is given and returns
`{type: 'create'|'refresh'|'prune', assetId, accountId, platform, reason}`
actions. One mechanism covers missing handles, near-expiry handles, accounts
connected after upload, and disconnected accounts. Refresh keys off
`uploaded_at` plus a per-platform TTL — **never off last use** — and applying the plan makes a
re-run return nothing, so it is safe on a tick. Since eligibility is enforced
at upload time, there is no per-platform eligibility check in reconciliation —
every stored asset is sendable everywhere.

**Handle TTLs (`DEFAULT_RECONCILE_POLICY`), verified 2026-08-10 against Meta's docs:**

| Platform | TTL from `uploaded_at` | Source |
|---|---|---|
| Messenger | **90 days** | Meta: "Attachment IDs expire after 90 days" |
| WhatsApp | 30 days | Meta: "Media IDs returned by the API expire after 30 days" |

Handles are refreshed `refreshMarginMs` (3 days) before end of life, so in practice a
Messenger handle is replaced at 87 days and a WhatsApp one at 27.

**Every platform we fan out to must have a finite TTL here.** Messenger was recorded as
never expiring until 2026-08-10. That is a silent-failure bug, not a nit: with no TTL,
`endOfLife` cannot place the handle's death, `planReconcile` never refreshes it by age, and
because a handle is only ever an optimisation, nothing errors when it dies — every send
just falls back to URL, forever, on the platform carrying ~100% of live media traffic
(§11.1). The reconcile tests run against the shipped constants precisely so this cannot
regress unnoticed.

#### The reconciler shell (`media.reconcile.js`, `scripts/media-reconcile.js`)

**Deployment shape (§11.3, decided at stage F): a standalone script sharing
dashboard-server's modules, run as a Kubernetes CronJob out of the dashboard
image** — `devops/vlab/templates/media-reconciler-cronjob.yaml`, hourly, enabled
per environment in `devops/values/{production,staging}.yaml`.

The alternative §11.3 left open was an internal HTTP endpoint that cron would
call. Rejected: it would need its own authentication — one more secret to issue,
rotate and get wrong — for exactly one caller, and it would put a job that
re-uploads hundreds of megabytes on the process serving the researcher UI. The
script gets process isolation, its own resource limits and its own failure
surface, and still reuses the same S3 client, the same `getMessagingAccounts`
lookup and the same `planReconcile`, because it is the same codebase.

```
listAssetOwners -> per owner: accounts + assets + handles
                -> planReconcile (pure)
                -> prioritiseActions (pure)   <- the bound lives here
                -> prune, then upload grouped by asset
                -> summary
```

The CronJob template lives in the **umbrella** chart rather than the `dashboard`
subchart (a versioned OCI artifact) so it can reuse `.Values.dashboard.env` and
`.Values.dashboard.envFrom` verbatim. A second copy of the database host, the S3
endpoint and the bucket is a copy that can silently disagree — and a reconciler
pointed at the wrong bucket does not error, it finds no bytes and every send
quietly falls back to URL.

**The per-run bound, and why there are two of them.** Desired state is
assets × accounts, which grows multiplicatively, and one production user has 29
messaging accounts (§11.1b). Every action is a file upload to Meta of up to
100 MB, so an unbounded pass is not a run, it is an incident: connecting one
account for that user turns their whole library into uploads in a single tick.
Count alone is the wrong unit — 200 actions is a few seconds of thumbnails or
20 GB of documents — so the run is bounded by **`maxActions` (200) and
`maxBytes` (512 MiB)**, whichever binds first. Steady state is far below both.

Ordering is by urgency, and the ordering *is* the anti-starvation design:

| Class | Meaning | Why it sits where it does |
|---|---|---|
| `expiring` | works today, dies soon | the only class where deferring makes something **worse** |
| `dead` | `platform_media_id IS NULL` | already sending by URL |
| `missing` | no handle at all | already sending by URL, and has been since upload |

Within `expiring`, soonest `expires_at` first — **not** oldest `uploaded_at`, or
a WhatsApp handle (30-day TTL) uploaded 28 days ago would sort behind a
Messenger one (90-day TTL) uploaded 60 days ago. Within `missing`, oldest asset
first, so an asset that has never had a handle does not sit behind newer uploads
on every tick. Refreshes cannot starve creates over time because a refreshed
handle is not due again for a full TTL.

**Prunes are never deferred** (one `DELETE`, no bytes, no Meta round trip), and
the byte budget **stops at the first action that does not fit** rather than
skipping it for smaller ones — skipping would reorder by size and starve large
assets permanently. The very first action is always admitted, so one oversized
asset cannot deadlock the queue.

**Whatever is deferred is named in the log, not just counted.** A silent cap
reads as "covered everything" when it did not (§10), so the summary carries the
count, the deferred bytes and up to 20 identified actions.

**Concurrency and races.** `concurrencyPolicy: Forbid` stops overlapping runs,
but the pass is safe without it: every write is
`INSERT … ON CONFLICT (asset_id, account_id) DO UPDATE`, so racing a concurrent
upload-time fan-out costs a wasted upload and nothing else. The one genuine
read-then-write window is the **prune** — it decides an account is disconnected
from a snapshot — so `deleteHandleIfUnchanged` matches on the `uploaded_at` the
snapshot read. If the credential came back and fan-out wrote a fresh handle
underneath, the `DELETE` is a no-op instead of discarding a good handle. Pinned
by test.

**Bytes are fetched once per asset** and reused across that asset's accounts —
one storage read instead of 29 for the widest fan-out. The byte budget is
charged per *upload* (the cost to Meta), not per fetch.

**Failure is never fatal to the run** (§13). A broken owner, an unreadable
object, a dead page token: each is logged, counted in `failed`, and the pass
continues. There is **no error-driven invalidation** (§8.4, settled by §11.2) —
Meta documents no error code for an expired or nonexistent media id, and the
nearest one is an explicit catch-all, so classifying against a guessed taxonomy
would bulk-invalidate good handles and trigger a re-upload storm. Age is the
mechanism; the next tick retries.

**Exit codes are a design decision.** `0` whenever the pass ran, whatever it
found — individual upload failures are expected and every one of those messages
still sends by URL, so exiting non-zero would fire `CronJobRepeatedlyFailing`
for a condition nobody needs to be woken for, and an alert that cries wolf gets
muted. `1` only when the pass could not run at all (no database, malformed
config). The health signal for the handle layer is the by-URL counter (§8.5),
not this exit code.

**Settings** (all optional; defaults in `DEFAULT_RECONCILE_POLICY` and
`DEFAULT_LIMITS`):

| Env var | Default | Notes |
|---|---|---|
| `MEDIA_RECONCILE_REFRESH_MARGIN` | `72h` | **The unit is required.** A bare `72` is refused at startup rather than read as 72 ms, which would silently disable refresh-ahead |
| `MEDIA_RECONCILE_MAX_ACTIONS` | `200` | staging runs `20` — a tighter blast radius where a reconciler bug shows up first |
| `MEDIA_RECONCILE_MAX_BYTES` | `536870912` | staging runs 128 MiB |
| `MEDIA_RECONCILE_PRUNE` | `on` | `off` keeps handles for disconnected accounts; they are never looked up, so this is a debugging affordance |

TTLs are deliberately **not** configurable: 90 days and 30 days are facts about
Meta, not preferences, and a second copy of them in a values file is a copy that
can disagree with the `expires_at` the writer stamped.

**Manual run** (needs the same env as the dashboard):

```bash
cd dashboard-server && node scripts/media-reconcile.js
```

### Database and Query Pattern

- Direct CockroachDB queries via a `pg` connection pool
- All queries are parameterized with email-based filtering
- JOINs through `surveys -> users` for data scoping
- The `states` table links to surveys via the `current_form` column (shortcode string), not a direct foreign key

#### Query Module Pattern

Query modules in `queries/` follow a consistent pattern for binding to the connection pool:

```javascript
// queries/<module>/<module>.queries.js
async function queryFunction(params) {
  const query = `SELECT ... WHERE ... = $1`;
  const { rows } = await this.query(query, [params]);
  return rows;
}

module.exports = {
  name: 'ModuleName',
  queries: pool => ({
    queryFunction: queryFunction.bind(pool),
  }),
};
```

Key aspects:
- Queries are functions bound to the pool via `this.query()`
- All queries use parameterized inputs (`$1`, `$2`, etc.) for SQL injection protection
- Type casting with `::int` for counts ensures proper integer types in results
- Functions return raw query results or structured objects (e.g., `{ items, total }` for pagination)

#### States Query Module

The `queries/states/` module provides three functions for querying participant state data: `summary`, `list`, and `detail`. All three are scoped to `(email, surveyName, shortcodes)` and apply the same scoping logic — see the docstring at the top of `queries/states/states.queries.js` for the full explanation.

**Why each query takes both `surveyName` and `shortcodes`**: the `states` table only carries `current_form` (the shortcode), but a single shortcode can belong to multiple `survey_name`s under the same owner with different historical versions. Each query does two things:

1. **Pre-filter on `current_form = ANY(shortcodes)`** — uses the `states (current_state, current_form, ...)` indexes to prune the scan down to candidate rows. Without this the resolution runs against every row in `states`.
2. **Scalar subquery against `surveys`** — for each candidate row, resolves which historical version of the shortcode the user was on (`s.created <= states.form_start_time`, ordered DESC, LIMIT 1) and filters on the resolved `survey_name`. This is the bit that disambiguates between sibling surveys that share a shortcode.

The resolution is written as a scalar subquery rather than `JOIN LATERAL` because CockroachDB's planner rewrites the LATERAL form into a surveys×states cross product. On HPV Nigeria Study (28 versions, 14 shortcodes, ~150k candidate state rows) the LATERAL form took ~46s and the scalar form takes ~5s for the same result.

State rows with NULL `form_start_time` (haven't started a form) are excluded. Killed versions (`off_time` set) are intentionally kept so historical attribution stays correct.

If the resolution rule in formcentral ever changes (shortcode + timestamp → surveyid), update this subquery to match — formcentral is the canonical source.

#### Health API (`api/health/`)

Functional core / imperative shell: `rules.js` (declarative, data-only
ruleset + platform-notice whitelist), `aggregate.js` (pure fold from query
rows to the aggregate bag), `evaluate.js` (pure rule engine),
`notices.js` (pure AlertManager-alert translation). IO lives at the edges:
the `healthSummary` query (in `queries/states/`, reusing the states scoping
SQL with a 24h window) and the AlertManager fetch in the controller.

The error/blocked classification is a shared taxonomy contract with
sql_exporter — see the "Taxonomy contract" section of
`documentation/study-error-alerting.md`. Full feature design:
`documentation/dashboard-study-health.md`.

Env: `ALERTMANAGER_URL` (optional) — base URL for the notices proxy
(in-cluster: `http://alertmanager-operated.monitoring:9093`). Unset →
`/platform/notices` returns `{ notices: [] }` and the feature is cleanly
off. All AlertManager failures are fail-soft (2s timeout, empty notices).

### External Integrations

- **Cube.js**: Used for analytics aggregation on the dashboard
- **Kafka**: Used for async export jobs; export requests are published to Kafka and results are delivered asynchronously
- **Linear**: Support tickets (`/tickets`) are proxied to Linear's GraphQL API using a service-account API key (`LINEAR_API_KEY`) filing into a single team (`LINEAR_TEAM_ID`). Nothing is stored locally — "my tickets" is scoped by a `vlab-reporter:<email>` sentinel embedded in each issue description. See `documentation/tickets.md`.

## Testing

### Test Setup

Integration tests require a running CockroachDB instance. Tests use the configuration from `DATABASE_CONFIG` in the test environment.

To run tests:
```bash
# Start test database (if using docker-compose)
docker-compose up -d

# Run all tests
npm test

# Run specific test file
npm test -- states.test.js
```

### Test Pattern

API integration tests follow a consistent pattern (see `api/bails/bails.test.js` and `api/states/states.test.js`):

**Setup (before hook):**
1. Create test user with `User.create({ email })`
2. Create test survey(s) with `Survey.create({ ...surveyConfig })`
3. Insert test data into relevant tables via direct SQL
4. Generate auth token with `makeAPIToken({ email })`

**Tests:**
- Test 401 (unauthorized) for endpoints without authentication
- Test 403 (forbidden) for endpoints with wrong user access
- Test happy path scenarios with valid auth and data
- Test filtering, pagination, and edge cases
- Verify response structure and data integrity

**Cleanup (after hook):**
1. Delete test data in reverse order (child tables first)
2. Delete test surveys
3. Delete test user
4. Close database pool with `vlabPool.end()`

### States API Tests

The states API tests (`api/states/states.test.js`) verify:

**Summary endpoint (`GET /surveys/:surveyName/states/summary`):**
- Returns aggregated counts grouped by state and form
- Respects user authorization

**List endpoint (`GET /surveys/:surveyName/states`):**
- Returns paginated results with correct structure
- Filters by state, error_tag, and userid search
- Pagination works correctly with limit/offset

**Detail endpoint (`GET /surveys/:surveyName/states/:userid`):**
- Returns full state detail including `state_json`
- Returns 404 for nonexistent userid
- Returns 403 for userid in unauthorized survey

**Test Data Setup:**
- Two surveys with same `survey_name` but different shortcodes
- Multiple state rows with different states (RESPONDING, ERROR, WAIT_EXTERNAL_EVENT, END)
- Includes rows with error_tag, stuck_on_question, and timeout_date for comprehensive testing

## Build

The Dockerfile is pinned to `node:14-bullseye` and installs deps with `npm i`. Two things to know before touching it:

- **Don't use `node:14-stretch`.** Debian stretch is EOL and Docker stopped updating it, so that tag is stuck at Node ≤14.17. The `require('util/types')` subpath needs Node ≥14.18 (it's pulled in by current `pg` transitives), and on stretch the container crashes at startup with `Cannot find module 'util/types'`. The `bullseye` tag tracks the latest 14.x (currently 14.21.x) and has the subpath.
- **Don't switch to `npm ci` without also bumping Node.** Node 14 ships npm 6, and the committed `package-lock.json` is lockfile v2, which npm 6 can't parse (`Cannot read property '@cubejs-backend/postgres-driver' of undefined`). `npm i` is the workaround until someone upgrades Node — replybot's Node 12 → 22 LTS bump (`replybot-v0.0.192`) is the template for that work. The downside of `npm i` is that builds re-resolve dependencies, so a transitive bump can cause runtime surprises like the `util/types` one.
