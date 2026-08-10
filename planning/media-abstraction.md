# Media Abstraction — Build Plan

**Status:** Approved in design, ready to build. Rewritten 2026-08-09.
**Supersedes:** the previous version of this file, and `media-abstraction-design.md`,
`media-abstraction-plan.md`, `media-abstraction-implementation.md` (all deleted).
**Origin:** `planning/whatsapp-media-send-path-findings.md`. This plan does **not** claim
to fix the message-ordering bug described there — see §11.

**Documentation is written after the build** — see §12 for the targets.

---

## 1. What we are building

A researcher uploads a file to the media tab and gets back a URL. They paste it into
their survey. It is delivered reliably on every platform, indefinitely. No platform
identifiers, no environment selection, no expiry ever reach the authoring surface.

Today the platform detail leaks into the *user interface*: the dashboard hands back a
Facebook `attachment_id`, the author pastes it into survey JSON, and because those ids
are page-scoped the smoke survey carries `media_attachment_id_prod` **and**
`media_attachment_id_staging` plus a whole question asking the respondent which
environment they are in, purely to choose between them (`smoke-test/form-a.json`).
WhatsApp ids are number-scoped identically, so that hack multiplies rather than
transfers. `translator_whatsapp.go:309` hard-fails on an attachment id it cannot use,
so those two questions cannot send on WhatsApp at all.

An author choosing between a URL and an id, or between environments, is an author doing
the system's job.

### What is already true

`dashboard-server/api/media/media.facebook.js` **already pre-uploads** — it POSTs bytes
to `/me/message_attachments` with a page token at upload time, ahead of any send, and it
works in production. The mechanism is not the problem. The problem is the *model*: the
resulting `attachment_id` is stored on the asset row, conflating the file with the
platform's handle on it, and then surfaced to the author.

**Fix the model, keep the mechanism.**

---

## 2. Model

**Asset** — platform- and account-independent. The bytes, plus a stable public URL we
serve. Created by a researcher upload. This is what a survey references.

**Handle** — one per `(asset, account)`: a WhatsApp media id, a Messenger attachment id.
Volatile, has an expiry. **A handle is always an optimisation, never a requirement.**

(Keyed on `account_id` alone, not `(platform, account_id)` — account ids are globally
unique across messaging platforms by migration 20, and the two-part key was a
silent-failure trap. See §5.)

The invariant everything rests on:

> Every asset has a public URL we control, so *any* failure of the handle layer degrades
> to a URL send rather than a failed message.

### The account set is enumerable, not unknown

The findings doc rejected pre-upload because a survey resolves under *any* of its
owner's accounts, so the target account is unknown at authoring time. That is true —
`surveys` has no account column, and `event-normalizer.js:214/458` sets
`source.account_id` from the *inbound* page or number.

But "unknown" and "one of these three" are different problems. The set is exactly:

```sql
SELECT key FROM chatroach.credentials
WHERE userid = $1 AND entity IN ('facebook_page','whatsapp_business')
```

You do not predict the account — you upload to all of them.

Two corrections to what this section originally said, both found by verifying against the
real schema and real production data:

- It claimed the query above is **"served as an index-only scan by migration 20's
  `unique_messaging_account`"**. It is not. That index is `ON credentials (key)` — it *leads
  with `key`*, so it cannot serve a `userid`-scoped lookup at all. What actually serves it is
  `01-init.sql`'s `INDEX (userid, entity, key, created DESC) STORING (details)`. Harmless in
  practice, but anyone reasoning about fan-out cost from the wrong index reasons wrongly.
  (`unique_messaging_account` is still load-bearing — for a different thing: it makes account
  ids globally unique across platforms, which is what lets `media_handle` key on `account_id`
  alone. See §5.)
- It claimed **"3–5 accounts at most"**. Also false — production has a user with 29. See
  §11.1b for the real distribution and what it costs fan-out.

So handle creation moves to **upload time**, where the user is known and therefore their
accounts are. No publish hook is needed anywhere.

**Decided: fan out to all accounts, do not ask the author to pick one.** An
account picker at upload was considered and rejected. It is the prod/staging environment
question (§1) moved one screen earlier — the author is still choosing a platform scope,
still without the information to choose correctly, since a survey can resolve under any of
its owner's accounts. Worse, it fails *silently*: a wrong pick degrades to a URL send that
looks fine, which makes by-URL an expected outcome and destroys the §8.5 counter as a
health signal. It would also restore the connected-page requirement for upload that §3
removes. Fan-out to 3–5 accounts is best-effort and never blocks the upload response, so
the cost is small and it is robust to author error by construction.

If fan-out cost becomes real for large assets (§11.7 — a 16MB video pushed to 5 accounts
at upload and again every refresh), gate it on **size and type**, which is a rule the
system applies, not a question it asks the author.

### Both platforms are one code path

The plan this replaces had two mechanisms — Messenger captured `attachment_id` from a
send response, WhatsApp deliberately uploaded. Under pre-upload they are the same
operation with a different endpoint:

| Platform | Endpoint | Expiry |
|---|---|---|
| Messenger | `/me/message_attachments` | **+90 days** |
| WhatsApp | `/{phone_number_id}/media` | +30 days |

> **Corrected 2026-08-10 against Meta's official docs.** This table previously said
> Messenger had *no known expiry*. It does: *"Attachment IDs expire after 90 days"*
> (`messenger-platform/send-messages/saving-assets`). The "never expires" belief comes from
> a real but different fact on the same page — attachments in an already-sent message
> thread are permanent; the reusable id is not.
>
> This was a latent silent failure, not a documentation nit. With no expiry recorded,
> the reconciler would never refresh a Messenger handle; every one would die at 90 days and
> every send would fall back to URL indefinitely, with nothing erroring and nothing
> alerting. Messenger carries ~100% of live media traffic (§11.1), so it would have been
> the whole feature quietly doing nothing.

So `SendMessageResponse.AttachmentID`, the `messenger_client.go:141` response parse, and
the `MEDIA_HANDLE_CAPTURE` flag are all **not built**. `media.facebook.js` is generalised
rather than deleted.

### The background job is a reconciler, not a refresher

Desired state: one fresh handle per `(asset × each of the owner's messaging accounts)`.
Actual state: the rows in `media_handle`. The job reconciles.

One mechanism covers three cases:

- **Expiry** — the original case.
- **New account** — researcher connects a fourth page after uploading; handles appear on
  the next tick. No credential-creation hook.
- **Partial upload failure** — upload-time fan-out is over the network to 5 accounts
  while a researcher waits. Reconciliation means it does **not have to be reliable**; it
  is a warm-the-cache optimisation.

**Refresh off `uploaded_at`, not last-use.** Meta's reference says 30 days from upload;
third-party docs claim 30 days from last use. From-upload is the stricter of the two, so
a job built on it is correct under both — and §11.2 stops being a blocker.

### Third-party URLs are out of scope, deliberately

An author pasting `https://i.imgur.com/…` keeps working **exactly as today** — sent by
URL, no lookup, no regression. We do not mirror it.

This is a stated decision, not an omission. It removes from the build: the SSRF guard
(which was the highest-severity item in the previous plan), the publish hook, survey-JSON
URL rewriting, fetch-on-publish, and dead-link handling.

The cost: the imgur case from the findings doc is not fixed until the researcher
re-uploads that image through the media tab. That is a reasonable thing to tell
researchers, and it is discoverable because the tab hands them a URL.

---

## 3. The authoring interface

**Today** — two mutually exclusive fields, one of which is a platform identifier:

```json
{"type":"attachment","keepMoving":true,"attachment":{"type":"image","url":"https://i.imgur.com/ZSHauqq.png"}}
{"type":"attachment","keepMoving":true,"attachment":{"type":"image","attachment_id":"1434849748462496"}}
```

**After** — one field, always a URL:

```json
{"type":"attachment","keepMoving":true,"attachment":{"type":"image","url":"https://media.vlab.digital/a/550e8400-e29b-41d4-a716-446655440000/welcome.png"}}
```

An arbitrary third-party URL remains equally valid — it just does not get a handle.
**`attachment_id` disappears from the authoring interface.** The prod/staging environment
question is deleted; account scoping is handled by the handle layer.

### Dashboard flow

| Step | Today | After |
|---|---|---|
| Upload | file → Facebook `/me/message_attachments` → store `attachment_id` | file → object storage → create `media_asset` → fan out handles → return public URL |
| Requires a connected page? | Yes | **No** — asset creation is platform-independent; fan-out is best-effort |
| Returns | `attachment_id` | `public_url`, copy-paste ready |

Dropping the page-token requirement for *asset creation* is a real UX gain: today a
researcher cannot upload media before connecting a page. Handle creation still needs
tokens, but it is best-effort and the reconciler backfills — so a researcher with no
accounts yet uploads fine, and handles appear when they connect one.

The list view shows filename, type, size, preview and the URL. Handle state is **not**
shown — it is our problem.

---

## 4. Storage and security

### 4.1 Governing rule: the application stays cloud-agnostic

**No application component depends on a cloud provider's SDK or identity system.**
Storage is reached over the S3 API and nothing else.

CockroachDB's GCS backup (`documentation/backups.md`) is not a counterexample: that is
the *database's* dependency, repointable, and it does not live in our code.

Consequences: **one S3 client, not a two-backend abstraction**; federated identity is
moot for the application.

### 4.2 Backend: MinIO, distributed

`mode: distributed`, 4 replicas, one PVC each, erasure coding. Because exports are
transient (3-day lifecycle) and the exporter recreates its bucket on next run via
`_ensure_client`, this is a **destroy-and-redeploy during a maintenance window, not a
data migration**.

Distributed mode covers disk and node failure. It does **not** cover loss of the
cluster's disks, and media is unrecoverable by construction — we hold the only copy.
Hence §4.5.

### 4.3 Buckets, credentials, policies

| Concern | Decision |
|---|---|
| Bucket | A separate **`media` bucket**, not a prefix beside `exports/`. Media is world-readable; exports are respondent data. Different posture, different blast radius. |
| Write credential | A **scoped MinIO service account** — Get/Put/Delete on `media/*` only. **Not** the root `minio-auth`. Must not reach the exports bucket. |
| Anonymous access | **None. The bucket is fully private.** |
| Public read path | The media-proxy (§4.4). |
| Worker credential | **None** — message-worker never touches storage. |
| Dev / local | Static keys in a gitignored `.env`, per `documentation/secrets.md`. |

**Why no anonymous policy at all.** MinIO's canned anonymous policies are traps.
`download` grants `s3:GetObject` **and `s3:ListBucket`** — it permits exactly the
enumeration it appears to prevent. `public` is read *and write*, so a mis-set policy
allows anonymous uploads into a bucket served under our own domain. A private bucket
removes that failure class structurally.

### 4.4 The media-proxy

A minimal stateless Go service on `media.vlab.digital`, the **sole** public read path.
Not the ingress proxying MinIO (that needs the anonymous policy above), and not a route
on dashboard-server (that couples media delivery — critical path for message delivery —
to dashboard uptime).

Four responsibilities:

1. **Validate path shape** — `a/<uuid>` optionally followed by `/<filename>`, and nothing
   else. The filename segment is **cosmetic and ignored**; the object key is `a/<uuid>`.
   No other prefix is reachable.
2. **Fetch from MinIO** with the scoped read credential; stream the body.
3. **Set headers in code** — `Content-Type` and `Content-Disposition` from **S3 object
   metadata** set at PutObject (never sniffed at serve time, never client-supplied), plus
   `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`
   (neutralises HTML/SVG payloads), long immutable `Cache-Control`.
4. **GET and HEAD only.** Everything else rejected before it reaches MinIO.

Taking `Content-Type` from object metadata rather than the `media_asset` row is what
keeps the proxy **database-free** — it cannot be the thing that breaks when CRDB is slow.
It is still server-set, at upload, by dashboard-server.

**Go**, for repo reasons: `go.work` at the root already carries message-worker and dean,
so it inherits toolchain, CI, Dockerfile conventions and base images. `minio-go` is
first-party. Shape: one handler, path regex, `GetObject`, `io.Copy`, four headers, **no
database**.

*Rejected:* folding it into hermes — it would save a Deployment but couple media delivery
to the inbound webhook path.

Run **≥2 replicas with a PDB**. It is on the critical path for every media send that has
no handle (§13).

### 4.5 Backup and capacity

**Backup is DEFERRED — decided 2026-08-10. Not on the critical path; planned separately in
`planning/media-backup.md` and implemented later.**

The design is unchanged: an **`mc mirror` CronJob to an S3-compatible endpoint set by
environment** — `BACKUP_S3_ENDPOINT` / `BACKUP_S3_BUCKET` plus credentials, **no provider
named**; **off-cluster** (a second bucket on the same MinIO shares the same disks and is
not a backup); residency the operator's choice. Plus **a restore rehearsal**, because a
backup never restored is not a backup. The manifest is written and reviewable; it is simply
not in the initial deploy, and its endpoint value is still unset.

**The risk, stated once.** Distributed MinIO covers disk and node failure. It does **not**
cover loss of the cluster's disks, and media is unrecoverable by construction — we hold the
only copy of every researcher's file. Until the mirror runs, a cluster-level loss loses the
media library permanently: assets 404, surveys show broken images, and there is no
re-upload path because the bytes exist nowhere else.

**Why deferring is safe now, and when it stops being.** The bucket is empty. Exposure is a
function of *adoption*, not time — it grows with every file uploaded. The feature also ships
dark, so nothing is uploaded until the media tab reaches users.

> **Trigger: the mirror must be running before researchers are told the media tab exists.**
> Not before merge, not before the flag flips — before anyone uploads a file they cannot
> reproduce. An adoption event, not a date.

**Capacity alerting is NOT deferred** and stays in the initial deploy: bucket size and PVC
utilisation, because media has no lifecycle rule and only grows — unlike exports, which have
a 3-day rule. Without it, the first symptom of a full volume is failed uploads.

### 4.6 Security model, stated plainly

Asset URLs are **capability URLs**: unguessable (v4 UUID, 122 bits of randomness),
non-enumerable, and **permanently readable by anyone who obtains one**. Appropriate for
survey imagery, wrong for anything confidential — and that must be said in
researcher-facing terms in `documentation/media.md`. Private media is explicitly out of
scope; if ever needed it is a proxy-with-auth feature designed separately.

**Why UUID and not a shorter id.** Every compact scheme — `unique_rowid()`, sequences,
snowflake, `gen_random_ulid()` — achieves compactness by being time-ordered, and
time-ordering is exactly what destroys unguessability. ULID additionally leaks upload
time in the URL and gives assets from one session a shared prefix. The URL is generated
by the media tab and copy-pasted once; nobody types it. Not worth trading the security
property for 14 characters.

Supporting controls: server-side `Content-Type`, `nosniff`, CSP; `media.vlab.digital` as
a **separate origin from the dashboard** so an uploaded HTML/SVG cannot reach dashboard
sessions; uploads restricted to authenticated researchers with size and type caps.

### 4.7 Environment

```
STORAGE_BACKEND        s3 | none                # none = dev no-op, matches exporter
MEDIA_BUCKET           media
MEDIA_PREFIX           a/
MEDIA_PUBLIC_BASE      https://media.vlab.digital
S3_ENDPOINT            https://storage-api.vlab.digital
S3_REGION              us-east-1                # MinIO ignores it; the SDK requires it
S3_ACCESS_KEY_ID       <scoped media service account>
S3_SECRET_ACCESS_KEY   <scoped media service account>
BACKUP_S3_ENDPOINT     <operator's choice, off-cluster>
BACKUP_S3_BUCKET       <operator's choice>
MEDIA_HANDLE_USE       on | off                 # kill switch, message-worker only
```

Non-secret values in `devops/values/<env>.yaml` applied by helm; the keys in a gitignored
`.env` applied via `devops/secrets.sh`. Nothing set imperatively.

---

## 5. Schema

`devops/migrations/24-media-assets.sql`. (Not 23 — `23-states-errored-at.sql` already exists.)

The existing `chatroach.media` is dropped rather than migrated. Its rows **cannot**
participate in the new model: they carry an `attachment_id` but no bytes in storage, no
`content_hash`, no key — and Meta offers no download for an attachment id (§8.2). They
would become a third row shape that every query has to exclude. Dropping loses list-view
history and nothing else; the send path reads `attachment_id` from *survey JSON*, not
from this table.

**Before dropping, run `SELECT count(*) FROM chatroach.media`** so it is a known decision
rather than an assumption.

```sql
DROP TABLE IF EXISTS chatroach.media;

-- Immutable facts about bytes. Write-once, never updated.
-- Owned by the dashboard; read by the media tab.
CREATE TABLE chatroach.media_asset(
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    userid       UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
    content_hash VARCHAR NOT NULL,        -- dedupe DETECTION only, never identity
    media_type   VARCHAR NOT NULL,        -- image | video | audio | file
    mime_type    VARCHAR NOT NULL,
    byte_size    INT NOT NULL,
    filename     VARCHAR NOT NULL,
    created      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (userid, content_hash),
    INDEX (userid, created DESC)
);

-- Volatile cache state per (asset, account).
-- Written by upload fan-out and the reconciler; read only by message-worker.
--
-- KEYED ON account_id ALONE, NOT (platform, account_id). account_id is
-- credentials.key -- the page_id or phone_number_id -- which migration 20
-- (unique_messaging_account) enforces as globally unique across messaging
-- platforms. DEPENDENCY: if that index is ever dropped, handles can collide.
--
-- The two-part key was a silent-failure trap. This codebase spells the platform
-- two ways -- 'messenger'/'whatsapp' in SendMessageCommand, 'facebook_page'/
-- 'whatsapp_business' in credentials.entity, with tokenstore.go translating
-- between them. Fan-out iterates credentials (holding 'facebook_page') while the
-- worker sends a command (holding 'messenger'), so a two-part key invites the
-- writer and reader to disagree. And the failure is invisible: a miss is not an
-- error, it is the designed URL fallback, so every message still delivers while
-- the handle layer does nothing.
--
-- account_id has exactly one spelling, and the write and read sides already agree
-- on it in production -- tokenstore resolves access tokens by that same equality,
-- so if it did not hold, no message would send at all. platform stays as a
-- DESCRIPTIVE column (which endpoint uploaded this, useful for debugging and
-- reconciler reporting) and is never a lookup key.
--
-- No FK on account_id: a partial unique index cannot back one, and credentials
-- rotate. A stale handle for a disconnected account is simply never looked up;
-- the reconciler prunes it.
CREATE TABLE chatroach.media_handle(
    asset_id          UUID NOT NULL REFERENCES chatroach.media_asset(id) ON DELETE CASCADE,
    account_id        VARCHAR NOT NULL,   -- credentials.key; globally unique per migration 20
    platform          VARCHAR NOT NULL,   -- descriptive only, never a lookup key
    platform_media_id VARCHAR,            -- NULL = known-dead, send by URL
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at        TIMESTAMPTZ,        -- NULL = no known expiry (Messenger)
    PRIMARY KEY (asset_id, account_id),
    INDEX (expires_at)                    -- reconciler sweep
);

GRANT SELECT ON TABLE chatroach.media_asset  TO chatreader;
GRANT SELECT ON TABLE chatroach.media_handle TO chatreader;
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE chatroach.media_asset  TO chatroach;
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE chatroach.media_handle TO chatroach;
```

`UPDATE` is the grant that matters — `10-media.sql` granted only `INSERT, SELECT`, which
cannot support refresh. Apply via `devops/run-migration.sh`.

### Why two tables

Not asset-vs-handle so much as **immutable vs volatile**. The test:

> You can `DELETE FROM media_handle` at any moment and nothing breaks. Every send
> degrades to a URL send; the reconciler refills on the next tick.

That is not true of `media_asset` — losing it loses the researcher's library. Different
durability, different mutability, different reader, different writer.

A single-table design with `account_id IS NULL` discriminating asset rows from handle
rows does work (partial unique indexes enforce it, UPDATE-in-place means nothing is ever
deleted). It saves one `CREATE TABLE` and two `GRANT` lines, and costs a discriminator
predicate on every query written from now on. **There is no join to save on either
side** — the worker reads only handles, the dashboard reads only assets.

### Why UUID identity, hash as a column

`content_hash` was doing two jobs — dedupe detection and identity. Splitting them:

- **`UNIQUE (userid, content_hash)`** gives "you already uploaded this, here's the
  existing one" per researcher. Global uniqueness would mean two researchers uploading
  the same image share one row, and the second one's media tab — which filters by
  `userid` — would not show their own file.
- **UUID as key and URL** means the URL identifies exactly one row, so handles key on
  `asset_id` with a real FK, and deletion is safe. Content-addressed keys would make
  deletion a refcounting problem (delete user A's asset, user B's identical asset 404s)
  and would give anyone holding a file a confirmation oracle for whether it is in the
  library.

Cost: bytes are duplicated across researchers who upload the same file. For a handful of
users uploading mostly distinct survey imagery, negligible — and it buys safe deletion.

`ON DELETE CASCADE` owns *deletion*; the reconciler owns *freshness*. Different jobs, no
conflict.

### Mutate, not append-only

Refresh is `INSERT ... ON CONFLICT (asset_id, account_id) DO UPDATE SET ...`. The primary
key enforces "exactly one handle per (asset, account)" in the database rather than by query
discipline; reconcile is idempotent by construction; lookup is a pure equality seek with no
`ORDER BY` and no dependence on cross-node clock ordering.

Append-only would give refresh history, which is genuinely useful while §11.2 is open —
**get that from a log line or a `chat-event` at refresh time**, so the observability lives
where you would query it and the table keeps its invariant.

### Not stored

No `storage_key`, no `public_url`. Both derive from `id` and `MEDIA_PUBLIC_BASE`, so
moving the domain is a helm edit rather than a data migration.

```
URL:  https://media.vlab.digital/a/<uuid>/<filename>
key:  a/<uuid>
```

The filename is in the URL for humans and for WhatsApp document sends, but **out of the
object key** — so it is cosmetic, can change without touching storage, and cannot
collide.

---

## 6. Functional core

Pure, clock-injected, no IO. Table-tested with no database, no MinIO, no Meta.

**message-worker**, new package `mediaresolve` — one function:

```go
// h == nil                                    -> ByURL
// h.ExpiresAt != nil && within margin of now  -> ByURL
// otherwise                                   -> ById(h.PlatformMediaID)
func Resolve(now time.Time, h *Handle, margin time.Duration) Sendable
```

The margin is the only real logic and is exactly what deserves a clock-injected table
test: it means a handle the reconciler has not reached yet degrades instead of failing,
and it absorbs clock skew.

Everything the previous plan put here has left the worker: `ValidateForPlatform` moves to
upload-time validation, `PlanRefresh` moves to the reconciler, `Classify` is **not built**
(§8.4).

**dashboard-server**, in `api/media/media.core.js` (already pure, stays pure):

```js
hashContent(buffer)                    -> string   // sha256, dedupe detection
storageKeyFor(assetId)                 -> string   // a/<uuid>
publicUrlFor(base, assetId, filename)  -> string
buildAssetRecord(email, hash, meta)    -> object
validateUpload(file)                   -> {ok}|{ok:false,error}
sniffContentType(buffer, claimed)      -> string   // never trust the client
planReconcile(now, assets, accounts, handles, policy) -> [actions]
parseAssetId(url)                      -> uuid|null
```

`planReconcile` is the reconciler's whole decision layer, pure and clock-injected —
expiry behaviour is tested by passing a clock rather than waiting 30 days.

---

## 7. Component work

**message-worker**
- New `mediaresolve` package (§6) — `Resolve`, plus URL → UUID parsing.
- New `mediastore.go` — **one** query, via the CRDB connection already used by
  `tokenstore.go`, and shaped as an interface + Postgres impl + stub exactly like
  `TokenStore`:
  ```sql
  SELECT platform_media_id, expires_at FROM media_handle
  WHERE asset_id = $1 AND account_id = $2
  ```
  A primary-key seek, no platform bind (§5). **Read-only. The worker never writes media
  state and never touches storage.**
- `types/whatsapp.go:103` — `WhatsAppMedia` is `{Link, Caption}`; add `ID`, `omitempty` on
  both so exactly one serialises.
- `translator_whatsapp.go:307` — take a resolved `Sendable` instead of reading `MediaURL`.
  The `ErrAttachmentIDUnsupported` path stays for attachment-id-only fields.
- `translator.go:352` — take a resolved `Sendable`; the legacy `attachment_id` branch is
  untouched.
- `translator_instagram.go:59` — **third media call site, missed by the original plan.**
  `translateInstagramMedia` has the same `Blank(msg.MediaURL) → ErrAttachmentIDUnsupported`
  shape as WhatsApp and takes a resolved `Sendable` on the same terms. Instagram media ids
  are out of scope for fan-out (no upload endpoint in play), so in practice it always
  resolves `ByURL` — but it must go through the resolver rather than reading `MediaURL`
  directly, or it silently diverges from the other two.

All three translators are already **pure functions** of `types.MessageContent`. The lookup
stays outside them: `processSendMessage` (`worker.go:110`) resolves once, then passes a
`Sendable` value into translation. That keeps the functional core intact and every
translator table-testable with no database.
- Flag `MEDIA_HANDLE_USE`.
- **A counter on by-URL sends** (§8.5).

URL matching is **host-independent**: extract `/a/<uuid>` from the path of any URL, look
it up, and fall back on a miss. That makes a prod media URL in a survey run on staging
work correctly — no asset row in staging's DB, so it misses and sends the prod URL, which
the prod proxy serves.

**dashboard-server**
- New `api/media/storage/index.js` — S3 client, `{put, delete, publicUrl}`. Sets
  `Content-Type` and `Content-Disposition` as object metadata at PutObject.
- Generalise `media.facebook.js` → `media.platform-upload.js`: same shape, endpoint and
  token per platform. **Not deleted.**
- Rewrite `media.core.js` (§6) and `media.controller.js` — validate → hash → dedupe →
  put → insert asset → best-effort fan-out → return asset.
- Rewrite `queries/media/media.queries.js` for the two new tables.
- The reconciler (§7, below).

**dashboard-client**
- Media page: filename, type, size, thumbnail, copy-to-clipboard URL. No page selector.

**replybot**
- `lib/generic-translator.js:219` is currently `media_url: attachmentId ? null : (...)` —
  it **nulls the URL whenever an id is present**, so a legacy field reaches the worker
  with no fallback. Pass both through; the worker decides.
- Nothing else. There is no publish hook.

**New: media-proxy** (§4.4).

**New: reconciler — BUILT, stage F.** Desired state is
`assets × their owner's messaging accounts`. Shape decided (see §11.3): a **standalone
script**, `dashboard-server/scripts/media-reconcile.js`, run as a **CronJob out of the
dashboard image** (`devops/vlab/templates/media-reconciler-cronjob.yaml`), hourly. The
decision layer is `planReconcile`, unchanged; `api/media/media.reconcile.js` is the shell
around it, and the only new logic it adds is `prioritiseActions` — the per-run bound, which
is pure for the same reason `planReconcile` is.

---

## 8. Backwards compatibility

### 8.1 The surface

- **No WhatsApp BC** — not live.
- **No legacy dashboard media to migrate** — see §5.
- **The real surface is Messenger survey JSON in the field** carrying `attachment_id`.

**Step zero is an audit**, not a guess: query published surveys for
`description LIKE '%attachment_id%'`, counted by owner (§11.1).

### 8.2 The one-way door

The dashboard discards uploaded bytes (`media.controller.js:57-75` stores only
`attachment_id` + filename), and Meta offers no download for an attachment id. **Legacy
`attachment_id` values can never be auto-migrated into assets.** The only paths are: the
researcher re-uploads the original file, or the legacy branch stays.

Therefore the legacy branch is **permanent supported behaviour, not scheduled for
removal**. A hard deadline would strand surveys whose source files no longer exist.

### 8.3 Resolution rules — additive, order-sensitive

A pure function, three rules, in order:

1. `media_attachment_id` present **and** platform is Messenger → send by that id, exactly
   as today. **Legacy passthrough, byte-for-byte unchanged** (`translator.go:352`).
2. `media_url` present → parse `/a/<uuid>`; if a valid handle exists for
   `(asset, platform, account)` send by handle, else send by URL.
3. Neither → existing error, unchanged.

Rule 1 guarantees no Messenger regression by construction. Rule 2 is behaviour-neutral
until assets and handles exist, so the resolver ships dark. A third-party URL takes the
same rule-2 path and simply always misses — no special case.

WhatsApp keeps failing on rule 1 — correct, since no survey should reach production with
an `attachment_id` after this lands, and failing loudly beats silently sending nothing.

### 8.4 `Classify` and reactive fallback are deferred

The previous plan invalidated a handle on a send failure classified as `HandleInvalid`
and retried by URL. That is **not built in v1**, for two reasons:

- §11.2 is open — nobody has observed what Meta returns for an expired or invalid media
  id. Writing `Classify` now means writing it against a guessed taxonomy, and its failure
  mode is bad: misclassifying a transient error invalidates good handles in bulk and
  triggers a re-upload storm.
- With pre-upload plus a reconciler, a dead handle costs **one failed send** and is fixed
  on the next tick. It is not the mechanism the cache depends on.

Add it once a real expired-id error has been seen in the wild — then it is written
against observed behaviour. Default the classifier to `Transient` and require a specific
allowlisted code to invalidate.

### 8.5 Where the risk actually is

Working assumption pending §11.1: **essentially all production Messenger media is sent by
`attachment_id` today**; raw-URL sends are rare or absent. That means rule 1 is not a shim
for stragglers — it is how production works.

The first behaviour change on live respondent traffic is enabling `MEDIA_HANDLE_USE`
(§9.2 step 5), on messages that have a URL fallback beneath them. Staged: `USE=off` and
confirm handle rows appear, then staging, then one production account, then all.

**The by-URL counter is the health signal.** In this design a by-URL send for
dashboard-uploaded media is an anomaly — it should be near zero, and if it is not, the
fan-out or the reconciler is broken. In a lazy design a by-URL send is expected on first
send, so a completely broken handle pipeline looks healthy. This is the one metric that
makes the difference observable.

> **Shipped instead, 2026-08-10: a `media_health` collector in
> `devops/sql-exporter`, plus two alerts in `devops/alerts/`.** Runbooks:
> `documentation/alerting.md` §11.
>
> The reasoning above is right and the counter is still wanted. But it measures the
> **symptom** — it only moves after a respondent has already been served the degraded
> path — and it has nowhere to live: **no application service in this repo exposes
> `/metrics` at all**, so building it means first standing up a metrics endpoint, a
> Service and a ServiceMonitor for message-worker.
>
> The **cause** is a query. §2's desired state is "one handle per (asset × each of the
> owner's messaging accounts)", so a fan-out that never happened is measurable the moment
> the upload returns, and a handle that will be dead in three days is measurable today.
> Seven gauges (`media_handles_desired` / `_missing` / `_expired` / `_expiring` / `_dead`,
> `media_handles`, `media_assets`) lead the by-URL counter by days, cost one bounded index
> span and one small join per minute, and are zero-safe against the empty tables production
> has today.
>
> **Three things the SQL cannot see, which is why §8.5 is not closed:**
>
> - **The read path.** §13's "CRDB slow or down" row — the worker logging a lookup error
>   and treating it as a miss — leaves the rows perfect while every send degrades. Same for
>   `MEDIA_HANDLE_USE` simply being off. Only a worker-side counter sees this.
> - **Third-party URLs** (§2). No asset row, so invisible here, and a by-URL send forever
>   by design. This is why the counter's floor is not zero.
> - **Codec-level refusals** (§11.5). Visible here, but as a missing or dead handle
>   indistinguishable from a reconciler fault without reading the rows.
>
> Build the counter when message-worker gets a metrics endpoint. Until then the collector
> is the signal, and it is the earlier of the two.

---

## 9. Build order

**One worktree, one branch, one PR at the end.** The stages below are a *build and deploy*
sequence, not a merge sequence — there is no reason nine reviews beat one, and the
properties the old PR split was protecting are enforced by the flag and the deploy order
instead, where they actually belong.

```bash
git worktree add ../fly-media-abstraction -b feature/media-abstraction
```

### 9.1 Build stages

Order matters — each stage's acceptance is a checkpoint to hit before moving on, so a
break is attributable to one stage rather than to the whole branch. All of it merges once.

| # | Contents | Acceptance |
|---|---|---|
| A | `mediaresolve` + `media.core.js` cores, with tests | Full branch coverage of the pure functions; no IO imported |
| B | Resolver wired into the send path; rule-1 passthrough; by-URL counter | **Smoke test on Messenger byte-identical to today** with `MEDIA_HANDLE_USE=off` |
| C | dashboard-server storage backend + endpoint rewrite; `generic-translator` passes both fields | Upload returns a public URL fetchable over TLS |
| D | dashboard-client media page | Researcher uploads without a connected page and copies a URL |
| E | Upload-time fan-out, both platforms, one path | `media_handle` rows appear while `USE=off` |
| F | Reconciler — **DONE** | Forced-expiry rehearsal re-uploads and stays green; a newly connected account gets backfilled. Both are covered by `media.reconcile.integration.test.js` against real CockroachDB + MinIO with an injected clock, so the rehearsal does not wait 90 days |
| G | IaC + migration files (below), smoke survey rework (§11.4) | Reviewed as files; applied in 9.2 |

Stages A–B are the ones to hold the line on. With `MEDIA_HANDLE_USE=off` the deployed
code is exactly the old "PR 4" no-op — rule-1 passthrough only — so the proof that the
resolver did not disturb the path all production traffic currently takes is preserved by
the flag, not by a separate release.

### 9.2 Deploy sequence

These are **not** collapsible and do not all happen at merge. Infrastructure and schema go
first because code depends on them; behaviour change on live respondent traffic goes last
and is staged by flag.

1. **MinIO redeployed distributed** (4 replicas), `media` bucket, scoped service-account
   policy, **no anonymous policy** — a maintenance window, destroy-and-recreate (§4.2).
   *Gate:* exporter still writes exports; anonymous access to the media bucket denied
   entirely, including via `storage-api`.
2. **media-proxy** (≥2 replicas + PDB), `media.vlab.digital` ingress + TLS, capacity
   alerting. *Gate:* `curl` an object over TLS from outside; non-`a/<uuid>` path 404s;
   non-GET rejected. **The `mc mirror` CronJob and the restore rehearsal are deferred
   out of this step** (§4.5) — they gate *researcher adoption*, not deploy.
3. **Migration 24** via `devops/run-migration.sh`. *Gate:* applied on staging, grants
   verified as `chatreader`/`chatroach`.
4. **Merge and deploy the branch with `MEDIA_HANDLE_USE=off`.** Nothing a respondent can
   observe changes. *Gate:* Messenger smoke test byte-identical to today; `media_handle`
   rows appearing from fan-out.
5. **Staged enablement:** staging → one production account → all. *Gate:* send-failure
   rate flat; logs show id sends; the by-URL counter (§8.5) near zero for
   dashboard-uploaded media.

Steps 1–4 change nothing a respondent can observe. Step 5 is the first behaviour change on
live traffic, and every message under it has a URL fallback beneath it.

### 9.3 Release artifacts — what must exist before step 1

Two images this branch introduces or changes do not exist yet. **Both must be built before
any values file is applied**, and neither can be built before merge: a tag builds the image
from the tagged commit, and tagging an unmerged feature branch would publish an image built
from code that is not on the release line (see `documentation/release-lineages.md` — feature
branches merge into `staging`, and `staging` is what `vstag` builds from).

So this is a **post-merge, pre-deploy** step, in this order:

| # | Artifact | Why |
|---|---|---|
| 1 | **`media-proxy-v0.0.1`** | New service, never released. `versionMediaProxy: v0.0.1` in both values files refers to an image that does not exist. |
| 2 | **A new `dashboard` tag**, and `versionDashboard` bumped to match in both values files | The reconciler CronJob runs `node scripts/media-reconcile.js` **out of the dashboard image**, and that script does not exist in `v0.0.71` (production) or `v0.0.68-wa` (staging). |

`media-proxy` was absent from `.github/workflows/release.yml`'s service map and would have
failed with *"Unknown service"* rather than building. That is fixed; the tag now works.

**Choosing the dashboard version is not mechanical.** Production is on `v0.0.71` and staging
on `v0.0.68-wa` — separate lineages by design, and `release-lineages.md` additionally flags
`main`'s post-cutover role as unresolved. Whoever merges picks the version for the line they
merged into; do not assume `+1` on both.

**If this step is skipped:** the reconciler CronJob crashes hourly with `Cannot find module`.
That is *not* silent — `defaultRules.create: true` with `kubernetesApps: true` in
`devops/prometheus/values.yaml` means `KubeJobFailed` / `KubeCronJobRepeatedlyFailing` fire
to `#vlab-alerts`. Loud, but a wholly avoidable page. The media-proxy equivalent is an
`ImagePullBackOff`, equally visible.

Note the **ordering constraint**: media-proxy must be deployed (step 2) before the dashboard
starts issuing asset URLs (step 4), because a URL minted from `MEDIA_PUBLIC_BASE` is
worthless until something answers it.

### IaC

| File | Change |
|---|---|
| **`devops/minio/minio.yaml`** — the file that actually deploys MinIO | Deployment + single PVC → 4-replica StatefulSet with a PVC each, headless peer service, anti-affinity, PDB |
| `devops/values/minio.yaml` | `mode: distributed`, `replicaCount: 4`, PVC sizing; `media` in `defaultBuckets`. **No anonymous policy.** |

> **This table originally named only `devops/values/minio.yaml`, which would have been a
> no-op.** That file is Bitnami-chart-shaped and is *not* what deploys MinIO here — the live
> path is `kubectl apply -f devops/minio/`, as `documentation/exports-storage.md` states.
> Both are now maintained and cross-referenced.
>
> Also: §4.3 specifies **one** scoped credential, and **three** are needed — a writer for
> dashboard-server (Get/Put/Delete), a **read-only** one for media-proxy (`GetObject`, and
> deliberately **no `ListBucket`**, so a compromised proxy cannot enumerate the bucket), and
> a Get+List one for the mirror job. The proxy must not hold the writer's credential and the
> mirror's List must not be granted to the proxy.
>
> And MinIO had **no ServiceMonitor at all**, so §4.5's capacity alerting on bucket size was
> unbuildable until one was added.
| `devops/values/production.yaml`, `staging.yaml` | Media env vars (§4.7); media-proxy deployment; reconciler CronJob; `MEDIA_HANDLE_USE` |
| new `devops/media-ingress.yaml` | `media.vlab.digital`, nginx, cert-manager `letsencrypt-prod` → media-proxy |
| new `devops/minio-media-policy.json` | Scoped service-account policy, checked in, applied from file |
| new `devops/backup/minio-media-mirror.yaml` | `mc mirror` CronJob; endpoint from env, no provider named |
| `devops/migrations/24-media-assets.sql` | §5 |
| dashboard-server `.env` + `.env-example` | The two scoped S3 keys, via `devops/secrets.sh` |

No `kubectl patch`/`edit`; everything applied from files per `CLAUDE.md`. The MinIO
redeploy destroys and recreates PVCs — safe because exports are transient, but it is a
maintenance window and the exporter recreates its bucket on next run.

---

## 10. Tests

**What we test: business logic, and regressions.** Not configuration matching. A wrong env
var, an unset bucket policy, a mis-wired ingress or a value mismatch between two components
is found the first time we deploy and run a smoke test — that class of bug never survives
first contact, and a test for it costs maintenance forever while buying nothing. So the
deploy gates in §9.2 own configuration; the suites below own logic.

This is why there is **no seam test** between dashboard-server's fan-out and the worker's
lookup. The original worry — the writer and reader disagreeing on the handle key — is
designed out by keying on `account_id` alone (§5), and what little remains is a wiring
question that a smoke test answers immediately.

### Three independent flows, sharing nothing

The stacks stay separate because their boundaries genuinely are. Notably **MinIO does not
belong in the message-pipeline stack**: the worker reads a handle row and, on a miss, puts
a *URL string* in the payload — facebot captures that payload and never fetches it. No byte
is read from storage anywhere in the message flow, so a MinIO container there would be
inert scenery.

| Flow | Boundary under test | Needs |
|---|---|---|
| Message pipeline (existing facebot testcontainers stack) | handle rows → Meta payload shape | CRDB + facebot. **No MinIO, no dashboard-server** |
| dashboard-server (its own mocha suite) | bytes + user → objects + rows | its own MinIO + local CRDB |
| media-proxy (**new, own suite**) | stored object → HTTP response | Go httptest + MinIO. Nothing else |

### 1. Pure cores — the actual logic

Table-driven, clock-injected, no IO. `Resolve`'s expiry margin is tested by passing a clock,
not by waiting 30 days. `ParseAssetID` covers host-independence (a prod URL parsed on
staging), the ignored filename segment, and every rejection case. `planReconcile` covers
missing / near-expiry / newly-connected-account / idempotent-second-run. `media.core.js`
covers hashing, key and URL derivation, validation and content-type sniffing.

### 2. Legacy Messenger passthrough — pinned golden JSON

**The single highest-value test in this build.** §11.1 established that `attachment_id`
carries ~100% of live media traffic across surveys still taking thousands of responses a
day. A byte-exact pin on the serialised Messenger attachment payload for a legacy
`attachment_id` field turns "we didn't disturb the path everything depends on" from a hope
into a build failure. It is a pure regression test and costs nothing to keep.

### 3. Degradation — the design's core invariant

A `MediaStore` stub returning an error; assert the worker **logs it and sends by URL**
rather than failing the message (§13). This is what makes "the handle layer can fail
entirely" true rather than aspirational, and it is business logic, not configuration.
Deterministic at unit level; follows the existing `stub_clients.go` pattern. Deliberately
*not* an integration test that pauses CockroachDB — CRDB backs scribble and replybot too,
so that could only run serially and would be slow and brittle for no extra truth.

### 4. Message-pipeline integration — resolution rules end-to-end

Real CRDB (migration 24 applies automatically — `stack.ts` runs all `devops/migrations/*.sql`
on boot), real Kafka, real worker, facebot as the Graph API. Handles seeded as rows in
`seed-db.ts`; facebot gains the two upload endpoints and an inspection route. Asserts:
legacy id → unchanged payload; asset URL with a live handle → sends by id; asset URL with
no handle → sends by URL and increments the counter; third-party URL → always by URL;
WhatsApp `{id}` vs `{link}`.

**Handle reuse** — the same asset sent twice must send by id both times. Without it, every
send could be a silent URL fallback and the whole suite still passes green.

### 5. dashboard-server — dedupe semantics

Storage backend against local MinIO. Re-uploading the same file as the same user returns
the existing asset rather than a second row; a *different* user uploading identical bytes
gets their own row (§5's `UNIQUE (userid, content_hash)` reasoning). That asymmetry is
business logic and worth pinning.

### 6. media-proxy — path validation

Security-critical and therefore exhaustive: only `a/<uuid>[/<filename>]` is served;
traversal, other prefixes, other buckets and malformed uuids all 404 **without reaching
MinIO**; the filename segment is provably ignored; `nosniff`, CSP and the stored content
type present on every response; non-GET/HEAD rejected. This is logic in a regex and a
handler, not configuration.

### 7. Smoke survey — the only real-Meta coverage

§11.4, both platforms, reworked in this branch. The legacy BC field must pass on Messenger
and fail cleanly on WhatsApp. (§11.2's questions were answered from Meta's documentation
instead — see that section; the smoke survey now confirms behaviour rather than discovering
it.)

### Deploy gates, not tests

These are one-time verifications in §9.2, not suite items: **anonymous bucket access denied**
(MinIO policy config), **restore rehearsal** from the mirror target into a clean MinIO
(deferred with backup itself — §4.5 — and gating researcher adoption rather than deploy),
and **forced-expiry rehearsal** on a staging
handle.

---

## 11. Open items

**11.1 How many live surveys carry `attachment_id`? — ANSWERED 2026-08-09** (read-only
against production). The §8.1 query as written was wrong: `chatroach.surveys` has no
`description` column. Attachment config lives in `form_json`, inside `properties.description`
on fields of type **`statement`** (not type `attachment`), in two syntaxes — JSON
(`{"type": "attachment", ...}`) and YAML (`type: attachment\n...`). Any future audit must
match both.

Taking the latest row per `shortcode` (5127 survey rows collapse to **1046 live
shortcodes**):

| Fact | Value |
|---|---|
| Live shortcodes using media at all | **37** |
| …by `attachment_id` | **27**, across **3 owners** |
| …by URL | **10**, across 2 owners — all imgur, all YAML syntax |
| Responses in last 90d on the 10 URL surveys | **0** |
| `chatroach.media` rows to be dropped | **72**, 3 owners |

**§8.5's working assumption is confirmed, and more strongly than it assumed.** The 27
`attachment_id` surveys carry essentially all live media traffic and are *high volume and
current* — `mentalitybaseline` 29,306 responses/90d, `ENGbauchiMNCHmid` 15,236,
`mentalityendline` 14,076, most with responses from today. The 10 URL surveys are dormant
demo/test forms (`picexample`, `XXXXXXXX`, `testendline_*`) with **zero** traffic in 90
days.

Consequences:
- Rule 1 (legacy passthrough) is not a shim — it is how 100% of production media works.
  "Byte-for-byte unchanged" is the single most important property of this build, and stage
  B is where it is proven.
- Rule 2 ships genuinely dark: no live traffic touches it until researchers adopt the tab.
- The by-URL counter starts at ~0 and should stay there — a clean health signal, exactly
  as §8.5 predicted.
- Dropping `chatroach.media` costs 72 rows of list-view history across 3 owners.

**11.1b Fan-out width — §2's "3–5 accounts at most" is false.** Messaging accounts per
user in production: 12 users have 1, three have 2, one has 3, two have 4, one has 7, and
**one has 29** (`dpinzonhernandez@worldbank.org`). That user authors no media today, and
all three current media authors have 3–4 accounts, so fan-out is safe as built. But 29 is
the real upper bound, and it makes the §2 size/type gate a live concern rather than a
hypothetical one: a 16MB video for that user would be ~464MB per fan-out and again per
refresh cycle. Decide the gate alongside §11.5.

`whatsapp_business` credentials: **2**, across 2 users — confirming §8.1's "no WhatsApp
BC, not live."

**11.2 Expiry semantics — RESEARCHED 2026-08-10 against Meta's official documentation.**

**Confirmed durations:**

| Clock | Duration |
|---|---|
| WhatsApp uploaded media id | 30 days |
| **Messenger attachment id** | **90 days** (see §2 — this corrects a false "never expires") |
| WhatsApp *webhook* media id (inbound) | 7 days — a separate, shorter clock if we ever cache inbound media |
| WhatsApp media URL | 5 minutes |

**The upload-vs-last-use question is genuinely unanswerable from Meta's docs, and that is
the finding.** The reference says *"Media IDs returned by the API expire after 30 days"*
and never states 30 days *from what*. A neighbouring sentence — *"all media files … persist
for 30 days"* — leans toward from-upload but describes the stored file, not the id's
validity. The widely-repeated "30 days from last use" claim has **no official backing**.

This confirms the plan's existing choice: **refresh off `uploaded_at`.** It is correct under
the from-upload reading and merely early under the from-last-use one. The reverse assumption
silently serves dead ids.

**No documented error code exists for an expired or nonexistent media id.** The Cloud API
error-code table has no entry for it. The nearest, `131053` (*"Unable to upload the media
used in the message … such as an unsupported media type"*), is an explicit catch-all
merging permanent and transient causes. The commonly-cited "code 100, subcode 33, object
does not exist" appears **only in third-party blogs and wrapper libraries**, never in
Meta's documentation. There is no HTTP-status column in that table at all.

**This settles §8.4 permanently rather than deferring it.** Error-driven invalidation cannot
be built on documented behaviour, and the failure mode of getting it wrong is bulk
invalidation of good handles plus a re-upload storm. **Age-based expiry is the mechanism;
error-driven invalidation is not to be built** unless someone first observes real expired-id
error payloads in production and writes a classifier against what was actually seen.

**11.3 Reconciler deployment shape — DECIDED & BUILT 2026-08-10 (stage F): a standalone
script sharing dashboard-server's modules, run as a CronJob.**

Not an internal HTTP endpoint on dashboard-server. That option would need **its own
authentication** — one more secret to issue, rotate and get wrong — and would exist for
exactly one caller, cron. It would also put a job that re-uploads up to hundreds of
megabytes on the process serving the researcher UI, where a long pass competes with request
handling and a crash takes the dashboard with it. The script runs from the **dashboard
image**, so it still shares the same S3 client, the same `getMessagingAccounts` lookup and
the same `planReconcile`, while getting process isolation, its own resource limits and its
own failure surface for free.

The CronJob template lives in the **umbrella** chart (`devops/vlab/templates/`) rather than
the `dashboard` subchart, which is a versioned OCI artifact. That is what lets it reuse
`.Values.dashboard.env` and `.Values.dashboard.envFrom` verbatim instead of restating the
database host, the S3 endpoint, the bucket and the two scoped MinIO keys. A second copy of
those is a copy that can silently disagree — and a reconciler pointed at the wrong bucket
does **not** error: it finds no bytes, logs failures, and every send quietly falls back to
URL.

**What §11.3 did not say, and had to be decided here — the per-run bound.** §7 and §11.3
describe the reconciler as if the work were free. It is not: desired state is
`assets × accounts`, which grows multiplicatively, and §11.1b's 29-account user makes that
concrete. Every action is a **file upload to Meta of up to 100 MB**, so connecting one
account for that user would otherwise turn their whole library into uploads inside a single
tick. Two bounds, because count alone is the wrong unit — 200 actions is a few seconds of
thumbnails or 20 GB of documents:

| Bound | Production | Staging |
|---|---|---|
| `maxActions` | 200 | 20 |
| `maxBytes` | 512 MiB | 128 MiB |

Work is ordered by urgency — `expiring` (works today, dies soon: the only class where
deferring makes something *worse*) before `dead` and `missing` (both already sending by
URL); within `expiring`, soonest `expires_at` first rather than oldest `uploaded_at`, or a
30-day WhatsApp handle sorts behind a 90-day Messenger one. Prunes are never deferred (one
DELETE, no bytes). **Whatever is deferred is NAMED in the log, not just counted** — §10 is
explicit that a silent cap reads as "covered everything" when it did not.

**Also decided here: exit codes.** `0` whenever the pass ran, whatever it found. Individual
upload failures are expected and every one of those messages still sends by URL, so exiting
non-zero would fire `CronJobRepeatedlyFailing` for something nobody needs to be woken for —
and an alert that cries wolf gets muted, taking the real signal with it. `1` only when the
pass could not run at all. The health signal for the handle layer is the by-URL counter
(§8.5), not this exit code.

**Storage grew a reader.** §4.3 lists no in-application reader of object storage — the
worker never touches it and the public path is media-proxy. But refresh re-uploads the same
bytes and we hold the only copy, so `storage.get` exists for exactly one caller, the
reconciler. Under `STORAGE_BACKEND=none` it **throws** rather than returning an empty
buffer, and the script refuses to start: handing the reconciler zero bytes would write a
handle pointing at nothing, which is worse than no handle at all.

**11.4 Smoke survey rework** (`smoke-test/form-a.json`), part of stage G — **DONE**, with
one correction to the spec below.

> **Correction: the environment question could not be deleted.** This plan said to delete
> it outright, on the grounds that it exists only to choose between prod and staging
> attachment ids. That is not its only job. `test_environment` also drives the
> `movie_webview_prod` / `movie_webview_staging` branch — moviehouse bakes a different
> player host per environment, and the same Typeform form is shared across both, so there
> is no other way to route it. Deleting the field would have silently dropped moviehouse
> coverage in one environment. What was actually done: the field is **kept**, its
> attachment-id branch removed, its title rewritten to drop all page-scoping and
> attachment-id language, and the moviehouse branch left intact. Media no longer branches
> on environment at all, which was the actual goal.

- **Delete** `media_attachment_id_staging` and the attachment-id branch of the environment
  question (but not the question itself — see above).
- **Keep** `media_attachment_id_prod`, renamed `media_legacy_attachment_id`, as the BC
  regression test — must keep working on Messenger, must fail cleanly on WhatsApp.
- **Add** `media_asset_url` (dashboard-issued URL), `media_third_party_url` (the imgur
  image, to prove the unmirrored path still works), and `media_asset_repeat` (the same
  asset sent twice — the only field that proves handle reuse).
- **Keep** video and PDF for the non-image size and format limits.
- Rewrite the survey copy: several questions explain page-scoping and attachment ids to
  the respondent, concepts that no longer exist.

**Blocked until stage C:** `media_asset_url` and `media_asset_repeat` currently carry the
placeholder `https://media.vlab.digital/a/00000000-0000-0000-0000-000000000000/PLACEHOLDER-…`,
because no upload path exists yet to issue a real one. **Those two fields are expected to
fail until a real asset URL is substituted** — flagged in the field titles and in
`smoke-test/README.md`. Substituting it is a required step before the smoke test can gate
anything.

**11.5 Upload-time normalisation — DECIDED & IMPLEMENTED: reject, do not transcode.**

The dashboard does **not** downscale, re-encode or otherwise repair uploads. A file that
cannot be delivered on every supported platform is **refused at upload with a specific,
actionable error**, and the researcher fixes it themselves. No image pipeline, no
transcoding dependency, no silent mutation of a researcher's file.

Implementation status: `validateUpload` enforces per-type limits table in `media.core.js`;
error messages name both the problem and accepted alternatives; size limits are checked
against the sniffed MIME type (never the client's claim). Tests cover boundary cases,
rejected types, and sniff-priority regressions. See `dashboard-server/README.md` for
current limits.

**Reject at the strictest limit across supported platforms, not per-platform.** This is
the consequential half of the decision. It means eligibility becomes an **invariant**:
every asset that exists is handle-able everywhere. Which in turn deletes work —

- no runtime "is this asset eligible here?" branch in the send path,
- no per-platform eligibility hook in `planReconcile`'s `policy`,
- no class of asset that is permanently by-URL, so the §8.5 signal stays clean.

**The cost, stated plainly:** a researcher running a Messenger-only study is held to
WhatsApp's tighter limits, and will be told to shrink a 6MB PNG for a platform they do not
use. That is accepted deliberately. The alternative — accept it, and let it silently send
by URL on WhatsApp forever if they ever connect one — reintroduces exactly the invisible
degradation this plan exists to remove. A one-time, explicit, actionable error beats a
permanent invisible one.

This also reverses the direction of §11.7: video and audio limits stop being a source of
reconciler load, because oversized media never enters the system.

**Limits to enforce** (per media type, strictest platform). **Verified 2026-08-10 against
Meta's official documentation** — WhatsApp Cloud API media reference and the Messenger
`saving-assets` page:

| Type | Accepted | Cap |
|---|---|---|
| image | JPEG, PNG | 5 MB |
| video | MP4, 3GPP | 16 MB |
| audio | AAC, AMR, MPEG, MP4, OGG | 16 MB |
| document | PDF + Office/text — see below | 100 MB |

Messenger's own cap is 25 MB with no published MIME whitelist (Meta documents only coarse
`image`/`audio`/`video`/`file` buckets), so WhatsApp is the binding constraint throughout,
as assumed. `video/3gpp` **is** officially supported — do not drop it.

**Documents are 8 MIME types, not one.** Meta lists `application/pdf`, `text/plain`,
`application/msword`, `application/vnd.ms-excel`, `application/vnd.ms-powerpoint`, and the
three OOXML equivalents (`…wordprocessingml.document`, `…spreadsheetml.sheet`,
`…presentationml.presentation`). The earlier PDF-only rule would have refused seven
officially-supported formats.

**But acceptance is bounded by what the sniffer can positively identify**, and that is not
a limitation to paper over — it is the control that stops an HTML payload renamed `.png`
from being served from our own domain (§4.6). Consequences:

- OOXML formats are ZIP containers and legacy Office formats are OLE2 — both identifiable
  by magic bytes, so both can be supported by teaching the sniffer.
- **`text/plain` has no magic bytes at all.** It cannot be distinguished from arbitrary
  unidentifiable input, which is exactly what the octet-stream rejection exists to catch.
  Accepting it would mean accepting anything. **`text/plain` is therefore not supported**,
  and that is a deliberate refusal, not an oversight.

### The eligibility invariant is weaker than §11.5 first claimed

Size and MIME are enforceable at upload. **Codec-level constraints are not**, without
decoding the file:

| Constraint | Enforceable? |
|---|---|
| *"Images must be 8-bit, RGB or RGBA"* | **Partly — SHIPPED 2026-08-10.** PNG bit depth is byte 24 of the IHDR, cheap to read, and a non-8-bit PNG is now refused with an error naming its actual depth. Colour type is deliberately not enforced: 8-bit greyscale and palette PNGs are accepted in practice, and refusing them would cost real files for no observed gain. |
| *"OPUS codecs only; base audio/ogg not supported; mono input only"* | **Partly** — an `OpusHead` marker in the first Ogg page is cheap; channel count needs a little more. |
| *"Only H.264 video codec and AAC audio codec … single audio stream or no audio stream"* | **No** — requires demuxing. Out of proportion. |

So a file can pass upload validation and still be refused by WhatsApp at fan-out. Such an
asset gets no handle and sends by URL forever — the very class §11.5 claimed to have
eliminated. **The claim holds for size and MIME, not for codecs.** Practically this means
the by-URL signal has a small non-zero floor rather than being provably zero, which is worth
knowing before treating a non-zero reading as a fault.

**Stickers are out of scope.** Meta supports `image/webp` as a sticker at 100 KB static /
500 KB animated — a limit 50× tighter than anything else here, and a distinct message type
the authoring interface has no concept of. WebP stays refused as an image. Recorded so the
omission is a decision rather than a gap.

**"document: any" was the wrong spec and is not what shipped.** Acceptance is driven by
`sniffContentType`, which returns `application/octet-stream` for *anything it cannot
positively identify* — and that includes an HTML or SVG payload renamed `.png`. So
"accept any document" would mean "accept unidentifiable bytes", which is exactly the
active-content class §4.6 refuses to serve from our own domain. Widening document support
means teaching the sniffer new document magic bytes, never loosening the octet-stream
rejection.

**What shipped (2026-08-10): four of Meta's eight document types.**

| Meta type | Shipped | How |
|---|---|---|
| `application/pdf` | accepted | `%PDF-` magic |
| the three OOXML types | accepted | ZIP magic (`PK\x03\x04`), then the subtype read from the package's own `[Content_Types].xml` — the first ZIP entry is inflated and its declared `…main+xml` part type matched. Identification, never a guess from the extension |
| `application/msword`, `…ms-excel`, `…ms-powerpoint` | refused | OLE2/CFB magic names the container — which `.msi` and `.msg` share — but telling the three Office types apart needs a CFB directory walk down the FAT sector chain. Reported as `application/x-ole-storage` and refused with an error naming the format |
| `text/plain` | refused | no magic bytes at all; see above. Deliberate, pinned by test |

A ZIP that does not resolve to an OOXML package — a plain archive, an ODT, or a
macro-enabled `docm` whose main part type differs — is reported as `application/zip`:
named, so the error can say "ZIP archive", but never accepted. Refusing macro-enabled
packages falls out of matching the exact main part type, and is welcome rather than
incidental: they carry executable content.

This **narrows** the previous `ALLOWED_MIME_TYPES`: GIF, WebP, QuickTime, WebM and WAV
were accepted before and are not WhatsApp-sendable, so they are now refused. Each has a
regression test pinning the narrowing, so nobody quietly restores one. The flat 200 MB cap
is replaced by the per-type table.

Errors must name the actual problem and the fix — "image is 6.2 MB, maximum is 5 MB" and
"GIF is not supported; use JPEG or PNG" — never a generic "invalid file".

**"document | any" does not mean "accept whatever bytes the sniffer returns."**
`sniffContentType` reports `application/octet-stream` both for a genuinely-unrecognised
container and for an HTML/SVG payload relabelled as an image (§4.6's "believing image/png
for these bytes would serve executable HTML from our own domain" guard, pinned by the
`refuses to identify an html payload` / `rejects an svg` tests). Trusting octet-stream as
"a document" would defeat that guard. So in `media.core.js`, "any" is implemented as "any
container the sniffer can positively name as a document" — today PDF and the three OOXML
types, per the table above. Extending that further (csv, rtf, …) means teaching the sniffer
their magic bytes first, not widening the accept check to include octet-stream.

**11.6 Orphaned assets.** **Deletion is NOT in v1.** The reasons:

1. **No backup.** We hold the only copy of every researcher's file. Distributed MinIO
   covers disk and node failure but not loss of the cluster's disks. Once backup
   (VIR-24 / `planning/media-backup.md`) exists and runs, deletion becomes safe.
2. **No reference counting against surveys.** Nothing checks whether a live survey
   references an asset before deleting it, so a deletion silently breaks any live
   respondent flow that references that asset with zero signal to anyone. The
   design (§11.5) rejects ineligible files at upload — we can do the same
   here: accept that deletion exists, but require explicit opt-in (reference
   counting) before surfacing it.

The accidental-confidential-upload case is handled out-of-band: a researcher tells us
and we delete it after a human considers whether the URL escaped. This trades friction
for the ability to make an informed decision. Deletion can be revisited once backup
exists AND reference counting against surveys is implemented.

**11.7 Video, audio, documents.** Different size limits; larger uploads make the
reconciler's re-upload work non-trivial. The smoke survey already exercises a video and
a PDF.

---

## 12. Documentation, written after the build

| Doc | Content |
|---|---|
| `documentation/media.md` | **New.** The asset/handle model, authoring interface, the reconciler, expiry, and the capability-URL model in researcher-facing terms — "anyone with the link can view this forever; do not upload anything confidential." Also: third-party URLs work but are not accelerated. |
| `documentation/platform-abstraction.md` | Media in the implementation-status table; correct §6's known-false claim about unmatched plain text |
| `documentation/whatsapp-onboarding.md` | Media works on WhatsApp; the `messages` webhook subscription dependency |
| `documentation/secrets.md` | The scoped-service-account pattern for storage |
| `documentation/exports-storage.md` | The `media` bucket, deliberately outside the `exports/` lifecycle rule |
| `dashboard-client/README.md`, `dashboard-server/README.md` | Media page behaviour, new endpoint shape, the reconciler |
| `message-worker/README.md` | Resolver, the read-only media lookup, `MEDIA_HANDLE_USE`, the by-URL counter |
| `smoke-test/README.md` | What each media field proves, including the BC field |
| new `media-proxy/README.md` | Purpose, path contract, headers, why the bucket is private, why it has no database |

---

## 13. Failure modes (reference)

| Failure | Behaviour |
|---|---|
| No handle yet (fan-out lagging) | Send `by_url`. Reconciler fills it. No user impact |
| Handle expired, reconciler hasn't run | Resolve margin catches it → `by_url`. No user impact |
| Handle dead early and unpredictably | Send fails once; reconciler replaces it. One failed message (§8.4) |
| Asset ineligible (>5MB, wrong format) | Never uploaded; always `by_url` |
| CRDB slow or down | **Lookup error must be logged and treated as a miss** → `by_url`. This is what makes "the handle layer can fail entirely" true rather than aspirational |
| MinIO down | Handles still work; new uploads fail at the dashboard, where a human sees it |
| Third-party URL dead | Same as today — the send fails. We do not mirror |
| Fan-out fails at upload | Reconciler backfills. Upload still succeeds |
| media-proxy down | **Media sends with no handle fail.** ≥2 replicas + PDB; alert on error rate. Handle sends are unaffected — this is the strongest argument for the handle layer |

The recurring shape: the handle layer can fail entirely and messages still send.
