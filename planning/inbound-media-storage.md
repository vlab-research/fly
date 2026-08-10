# Inbound Media Storage — Design

**Status:** Design. Nothing built. Written 2026-08-10 in the
`fly-media-abstraction` worktree.

**What this covers:** media that **respondents send us** — photographs, documents,
audio, video arriving on the inbound webhook — which we must download from Meta with
our own credentials and store permanently, and which researchers must be able to
retrieve for their own survey and nothing else.

**What this is not:** the outbound media library. That is
`planning/media-abstraction.md`, which is built. This document is the feature that §4.6
of that plan named and deliberately excluded:

> *"Private media is explicitly out of scope; if ever needed it is a proxy-with-auth
> feature designed separately."*

This is that separate design. Its conclusion is that it should **not** be a
proxy-with-auth.

---

## 0. Relationship to the existing document

**There is a prior document, and it is good.**
`planning/whatsapp-inbound-media-findings.md` (untracked, present in the main worktree
at `/home/nandan/Documents/vlab-research/fly/planning/`, referenced by commit
`471475a2`). It is a findings document backed by two live probes against Meta.

**What it got right, and this design adopts wholesale:**

- The root cause of every WhatsApp media answer being rejected (`media.link` vs
  `media.url`), now fixed in `471475a2`.
- **The media ID is the only durable handle.** Verified: URLs 401 without a Bearer
  token even 14 seconds old, and expire hard at ~302–303 s. §4.1, §4.2.
- **A design that puts a URL on a queue is broken.** The consumer must resolve
  ID→URL→bytes as one tight in-process step. §6.2. This is the single most important
  structural constraint and it is correct.
- **`sha256` arrives free in the webhook** and decodes to the same digest the resolve
  endpoint returns as hex. §4.4. Usable for integrity verification without an extra
  call.
- **The media IDs are already on the Kafka topic** — `hermes/src/handlers.rs:177`
  stamps `phone_number_id` and produces the whole item. A downloader needs **no new
  topic and no producer change**, only a new consumer group. §5.4. Confirmed.
- **replybot cannot do this** — its tokenstore was removed during platform
  abstraction. §5.2. Confirmed.
- **Messenger has the same disease** and has had it all along, storing its own expiring
  CDN URLs. §5.3. Any design covering only WhatsApp gets built twice.
- It explicitly refused to inherit a bucket policy by default (§7.1) — it raised access
  policy as a decision requiring deliberation rather than assuming one. That instinct is
  why this document has something to build on.

**What it got wrong or left open:**

1. **The retention deadline is wrong by a factor of four.** §6.2 says *"the budget goes
   from 5 minutes to Meta's retention window"* and *"retries with the 30-day retention
   window as the hard deadline"*, and §7.3 lists confirming 30 days as an open item.
   **Inbound webhook media ids expire after 7 days, not 30.** The 30-day clock is the
   *uploaded*-media clock — the outbound one. `media-abstraction.md` §11.2 already
   records this correctly. A retry policy budgeted at 30 days would silently exceed the
   real deadline for four weeks' worth of assumptions. See §2 below.
2. **It names the table `media_assets`.** `media_asset` (singular) now exists and means
   something else entirely — the researcher's outbound library. Reusing that name, or
   that table, is rejected in §6.
3. **It could not answer the access-policy question** (§7.1) because the requirement had
   not been stated. It now has been: private, no public URLs, ever. §7.1's option list
   offered "public bucket (simplest, worst)" — that option is dead.
4. **It did not consider the exporter.** It proposed storage and a retrieval record but
   no delivery mechanism to researchers. The delivery mechanism already exists (§5).

**Verdict: extend, do not supersede.** That document remains the authoritative record
of *what Meta actually does*, established by probe rather than by documentation, and
this design does not restate its evidence. This document supersedes only its **§6.2
storage/retrieval design** and its **§7 open items**, both of which it flagged as
unsettled. Its §1–§5 stand.

---

## 1. The tension this design exists to resolve

`media-abstraction.md` built something **deliberately public**. §4.6, stated plainly:

> Asset URLs are **capability URLs**: unguessable, non-enumerable, and **permanently
> readable by anyone who obtains one**.

That is the correct design for survey imagery — a welcome banner a researcher wants
rendered on a respondent's phone by Meta's fetcher, with no auth possible at the far
end. It is **categorically wrong** for a photograph a respondent sent us.

The media-proxy is the sharp end of this. Its README is explicit that it has **no
database and no auth by design**, and that adding a database would be a regression. It
validates a path shape and streams bytes. There is no place in it where an
authorisation decision could go, and putting one there would destroy the property that
makes it correct for its actual job.

**So the resolution is not to extend the proxy. It is to not involve it.**

The design below shares the *storage layer* with outbound media and shares **nothing**
of its access model. Concretely:

| Reused from what was built | Not reused |
|---|---|
| MinIO / the S3 API as the only storage interface (§4.1) | The `media` bucket |
| The S3 client pattern — `minio-go` in Go, `minio` in Node | The media-proxy |
| `content_hash` as a **column, not an identity** (§5) | Capability URLs |
| UUID identity so deletion is safe, not refcounted (§5) | `MEDIA_PUBLIC_BASE` and any public base at all |
| The scoped-service-account credential pattern (§4.3) | The `a/` prefix and its path contract |
| The asset-row shape — hash, mime, size, filename, timestamps | `media_asset` itself (§6) |

---

## 2. The deadline is the primary design driver

| Clock | Duration | Source |
|---|---|---|
| WhatsApp **webhook (inbound)** media id | **7 days** | `media-abstraction.md` §11.2, Meta docs |
| WhatsApp media URL (either source) | **~302–303 s**, hard | probed, findings §4.2 |
| WhatsApp **uploaded** media id (outbound) | 30 days | §11.2 |
| Messenger attachment id (outbound) | 90 days | §11.2 |
| Messenger inbound attachment CDN URL | **unknown, short, signed** | see below |

Two consequences, and they are not the same consequence.

**For WhatsApp: 7 days is the whole budget, and it is not a comfortable one.** It is
enormous relative to normal consumer lag (seconds) and small relative to an unnoticed
outage over a public holiday. The retry policy in §4 is therefore budgeted in **hours**,
with the 7-day figure as the point past which the asset is provably gone rather than
as a retry horizon. A backlog that has not drained in 24 hours is an incident, not a
queue.

**For Messenger there is no budget at all.** Messenger inbound attachments carry a
signed CDN URL and **no id** (findings §5.3, and `event-normalizer.js:96-101` passes
`data.message.attachments` through unchanged). There is no durable handle to resolve
later. The first fetch is the only fetch. Whatever the CDN URL's real TTL is — and it
is *unknown*, see §10 — a Messenger asset not downloaded on receipt is lost with no
recovery path and no way to detect the loss after the fact.

**This inverts the usual reading of "WhatsApp is the harder platform."** For inbound
media, WhatsApp is the *forgiving* one because the id survives; Messenger is the strict
one. Any design validated only against WhatsApp will appear to tolerate delay and will
silently lose Messenger media. Messenger also carries ~100% of live media traffic today
(§11.1).

**Therefore: download on receipt, for both platforms, from the same consumer.** Not
"promptly." Not "within the window." On receipt, as the consumer's only job, with lag
alerting as the control.

---

## 3. Where the bytes are downloaded

### 3.1 A new consumer, not an existing service

**Decision: a new Kafka consumer group on the existing chat-events topic
(`vlab-prod-chat-events`), in a new small service.** Working name `media-ingest`.

The findings doc reached this shape (§6.2) and it survives contact with the delivery
design. Restating why each alternative loses:

- **replybot** — holds no credentials (findings §5.2), cannot attach a Bearer header.
  Restoring a tokenstore there would undo platform-abstraction work. Worse, it would
  couple the respondent's acknowledgement to a network fetch: a slow download would
  become a slow reply. Validation must stay synchronous and local; ingestion must not.
- **hermes** — it is the webhook receiver and must return 200 to Meta fast. Putting a
  multi-megabyte download in that path is the same coupling the media-proxy README
  rejects when it declines to be folded into hermes.
- **message-worker** — it *does* hold credentials (`message-worker/tokenstore.go:81-119`,
  `GetToken(ctx, platform, platformAccountID)` against `chatroach.credentials`, with a
  TTL cache) and is the tempting answer. It is also the only service that holds them
  *and* consumes Kafka. Rejected on two grounds: it subscribes **only** to
  `vlab-prod-commands` (`cmd/message-worker/main.go:86`), so it does not see inbound
  events at all — this is not "add a filter," it is a second subscription with an
  unrelated lifecycle; and it is the **outbound** send path, on the critical path for
  message delivery. A download backlog would contend with sends, and its failure mode is
  "messages stop going out," which is the worst thing in the system to put behind a bulk
  byte-mover.
- **the exporter** — wrong clock entirely. It is a polled batch job; the deadline here
  is a stream deadline.

`media-ingest` should be **Go**, for the same repo reasons media-proxy is (§4.4):
`go.work` already carries message-worker, media-proxy and dean, and — decisively — it
can reuse `tokenstore.go`'s credential resolution and `minio-go` directly rather than
reimplementing both.

### 3.2 What it does, per event

Pure decision, then IO — the "separate decide from do" rule:

1. **Filter** (pure): is this an inbound message event carrying media? Both platforms,
   all six WhatsApp media types (`event-normalizer.js:371` already maps `voice`→`audio`).
2. **Claim** (IO): insert `inbound_media` with `status='pending'` on the natural key.
   `ON CONFLICT DO NOTHING` makes redelivery idempotent — Kafka is at-least-once and
   this consumer will see duplicates.
3. **Resolve** (IO, WhatsApp only): `GET /v{ver}/{media_id}` with the Bearer token for
   `account_id`, obtained exactly as message-worker does. Messenger skips this — it
   already has a URL, and that URL is the only one it will ever have.
4. **Download** (IO): stream to a temp file. **Never buffer whole** — video runs to tens
   of megabytes and this consumer must not be sized by the largest asset.
5. **Verify** (pure): the webhook's `sha256`, base64-decoded, against the digest of the
   downloaded bytes. Free integrity checking (findings §4.4), and the only defence
   against storing a truncated object as if it were complete. A mismatch is a failure,
   not a warning.
6. **Store** (IO): `PutObject` to `r/<uuid>` in the respondent-media bucket (§7), with
   `Content-Type` from the verified type and `Content-Disposition: attachment`.
7. **Commit** (IO): update the row to `status='stored'` with key, size, hash.

**Step 3 must never be separated from step 4 by a queue, a retry boundary, or a
process restart.** That is findings §6.2's load-bearing constraint and it is the one
rule whose violation is invisible in testing — a URL persisted anywhere works fine
under low load and fails only when lag exceeds five minutes.

**Do not use the webhook's embedded URL as a fast path**, even though findings §4.2b
proves it works while fresh. The findings doc already rejected this and the reasoning
holds: it adds a second code path whose success depends on queue latency, so it
succeeds in testing and fails selectively under load.

### 3.3 Failure: retry, then dead-letter loudly

Three outcomes, and they must be distinguishable in the row:

| Outcome | `status` | Behaviour |
|---|---|---|
| Transient (5xx, timeout, token refresh, MinIO down) | `pending`, `attempts++` | Retry with backoff. Alert if `attempts` high or `first_seen` old. |
| Permanent within the window (404 on the id, hash mismatch after retries) | `failed` | Stop. Alert. A human decides. |
| Deadline passed (`first_seen` older than 7 days, WhatsApp) | `expired` | Stop. **This is data loss and must page, not log.** |

**It must never be "lost forever" silently.** The row exists from step 2, before the
download is attempted, precisely so that a failure is a queryable row rather than an
absence. The findings doc made exactly this argument when it rejected deriving the
storage path optimistically (§6.2, *"a failed download then leaves a permanent 404 with
nothing signalling it"*) and it is the right one.

**Retries do not belong on the Kafka offset.** Blocking the partition on one bad asset
stalls every subsequent message on that partition, including — since this is the shared
chat-events topic — a Messenger asset whose URL is dying while it waits. Commit the
offset, leave the row `pending`, and let a **sweeper** re-drive `pending` rows on a
timer. The sweeper is the retry mechanism; Kafka is only the discovery mechanism.

**There is no dead-letter topic anywhere in this system**, so "dead-letter it" is not an
available primitive — the `inbound_media` row *is* the dead-letter queue, which is
another reason step 2 writes it before attempting anything. The two existing patterns
are both worse and neither should be copied:

- **replybot** catches per-event errors, logs them, and commits the offset
  (`replybot/lib/index.js:82-90`) — the event is silently lost. Acceptable for a
  conversational turn the respondent can retry; unacceptable for bytes that expire.
- **scribble** `log.Fatalf`s on unhandled errors (`scribble/scribble.go:32-40`) and runs
  the `messages` sink in strict mode (`production.yaml:327-328`), so a poison message
  restarts the pod and wedges the partition until Kafka retention expires.

Row-based retry avoids both: nothing is lost and nothing wedges.

For WhatsApp the sweeper works because the id is durable for 7 days. **For Messenger
the sweeper cannot help**, because the URL it would retry is already dead. A Messenger
download that fails on first attempt beyond a few in-process retries is `failed`
permanently. That asymmetry should be explicit in the code and in the alert text, or
someone will assume the sweeper covers both.

### 3.4 Backlog

Existing inbound media stores dead URLs and, before `471475a2`, no id at all. Findings
§7.5 raises this and recommends writing it off.

**That recommendation should be revisited, because a recovery source exists that the
findings doc did not account for.** The raw hermes-stamped webhook item — media id,
`mime_type`, `sha256` and all — is stored **verbatim and indefinitely** in
`chatroach.messages.content` by scribble (`scribble/message.go:40`;
`01-init.sql:17-27`). There is no TTL, no row-level TTL and no pruning job anywhere in
the repo. Kafka additionally retains the raw event for **31 days**
(`devops/values/production.yaml:68-72`).

So the id is recoverable for *every* inbound media message ever received, not just those
that reached `responses`. What is **not** recoverable is the bytes, and that is governed
by Meta's 7-day clock regardless of what we hold.

**Revised decision: write off the bytes, but run the count.** A one-off query over
`messages` establishes how much inbound media has ever been received and how much of it
falls inside the 7-day window on the day ingestion ships. Anything inside that window is
recoverable by feeding those ids through the same ingest path — which is worth doing
precisely because the machinery already exists at that point. Anything outside it is
gone and should be recorded as a known loss rather than discovered later.

Current expectation is that this is small (findings §3: six hours of production logs
across eight pods contained exactly one media event), but that is an observation from one
window, not a count.

---

## 4. Storage posture

### 4.1 Its own bucket

**Decision: a third bucket, `respondent-media`. Not `media`, not the exports bucket.**

**Why not `media`.** The media-proxy serves every object under `a/` in that bucket to
anyone who can guess or obtain the path, with no auth and no database. The proxy is
correct, and its correctness depends on the premise that *everything in that bucket is
publicly readable by design*. Putting respondent photographs in the same bucket makes
that premise false and makes the whole system's safety depend on a prefix string
appearing correctly in three services. §4.3 drew this line for exactly this reason —
*"Media is world-readable; exports are respondent data. Different posture, different
blast radius."* Inbound media is respondent data. It goes on the far side of that line.

**Why not the exports bucket either.** Two reasons, both concrete:

1. **The exports bucket has a destructive lifecycle rule.** `expire-exports-3d` deletes
   objects 3 days after creation, and `_ensure_lifecycle` reapplies it on **every
   export run** (`exporter/exporter/storage.py`). It is prefix-scoped to `exports/`
   today, so a `media/` prefix in that bucket would survive — but the safety of
   permanent respondent data would rest on a prefix filter in a rule that is
   re-asserted continuously by a different service, and whose failure mode is silent
   deletion. That is not a boundary worth having.
2. **Production reaches the exports bucket with MinIO root credentials**
   (`documentation/exports-storage.md`, noted there as legacy). Root access to the
   permanent respondent-media store is not something to inherit by accident.

A separate bucket makes the credential story clean, which is the actual point:

| Principal | Access |
|---|---|
| `media-ingest` | `PutObject` on `respondent-media/r/*`. **No read, no delete, no list.** |
| exporter | `GetObject` on `respondent-media/r/*` + existing write on exports. **No delete.** |
| media-proxy | **None.** It must not hold a credential that reaches this bucket. |
| dashboard-server | **None** in v1 (§8.3). |
| Anonymous | **None.** No policy of any kind, per §4.3's reasoning about MinIO's canned policies. |

Write-only ingest and read-only export means **no single component can both read and
delete**, and the service handling untrusted respondent input cannot read back anything
it did not just write.

**No lifecycle rule on this bucket.** The exports default (3 days) would destroy
research data. Absence of a rule is the correct configuration here and should be
asserted somewhere, because "no rule" is indistinguishable from "rule not applied yet."

### 4.2 There is no URL

**Decision: inbound media objects have no URL — public, capability, or otherwise.**

Bytes leave storage exactly twice: written by `media-ingest`, read by the exporter while
assembling a ZIP. There is no per-object read path for a human, no proxy, no presigned
object URL, no `INBOUND_MEDIA_PUBLIC_BASE`. The environment variable does not exist,
which is stronger than it existing and being unset.

This is what "no publicly-available URLs, ever" means when taken literally, and taking
it literally happens to also be the simplest design — there is no auth layer to write
because there is no read endpoint to protect.

**The honest caveat is in §8.1**: the ZIP the researcher downloads *is* delivered by a
presigned URL, and a presigned URL is a capability URL with an expiry. That is a real
residual and it is named rather than hidden.

### 4.3 Backup

`planning/media-backup.md`'s mirror must cover this bucket, and **its trigger is
stronger.** Researcher media is at least re-uploadable by the researcher who owns the
original file. Respondent media is re-uploadable **by nobody** — the respondent is
gone, Meta's copy expired within days, and the bytes exist in exactly one place.

The media-backup trigger is "before researchers are told the media tab exists." The
inbound equivalent is **"before the first respondent asset is stored"** — which is the
day this ships, not an adoption event. It should be a hard prerequisite rather than a
deferred item.

The `mc mirror --remove` question in media-backup.md §6 also gets a different answer
here: with erasure obligations (§9) the backup **must** propagate deletes, or a
deletion request is not honoured.

---

## 5. Delivery: extend the exporter

### 5.1 The mechanism already exists

**Decision: a fourth export source, `response_media`, producing a ZIP. Not a new
download mechanism.**

The instinct to prefer this over inventing something was correct — the exporter is not
merely *a* bulk delivery path, it is a complete job queue with a UI, a status model,
retries, and an authorisation model that already solves the hard part of this problem.

What exists (`exporter/README.md`, `exporter/exporter/exporter.py`,
`dashboard-server/api/exports/`):

- `chatroach.export_status` as a **database-polled job queue**. Workers `claim_job()`
  atomically, transition `Requested → Processing → Finished|Failed`, retry up to
  `MAX_EXPORT_RETRIES`, and reset jobs stuck beyond `STUCK_TIMEOUT_MINUTES`.
- Three sources already: `responses`, `chat_log`, `full_messages` — so "add a source"
  is an established extension point, not a new concept.
- `POST /exports?survey=<name>` with `{export_type}` in the body, dispatched through
  `SOURCE_MAP` in `exports.controller.js`. Adding `response_media` is one map entry.
- `GET /exports/status/survey?survey=<name>` for polling, already wired to a UI.
- `set_metadata` for per-job counts (already used for `users=`).
- Presigned download links and a 3-day object lifecycle.

Building a parallel ZIP endpoint would duplicate every one of those and would have to
re-derive the authorisation model in §5.2. There is no argument for it.

### 5.2 Authorisation is already structural, and it is good

This is the part worth stating precisely, because the answer to "how does authorisation
prove the survey is theirs" is **"it never asks."**

`exports.controller.js` takes `email` from `req.user` — populated by
`dashboard-server/middleware/auth.js` (`express-jwt`, dual client/server config) — and
inserts `(export_id, email, survey_name, source, options)`. **It performs no ownership
check at all.** That looks like a bug and is not, because every export query in the
exporter is scoped by a join, e.g. `exporter.py:296-300`:

```sql
FROM responses
LEFT JOIN surveys ON responses.surveyid = surveys.id
LEFT JOIN users   ON surveys.userid = users.id
WHERE users.email = %s
  AND surveys.survey_name = %s
```

and `exporter.py:374-379` for full messages, and `exporter.py:500-503` for chat logs.

**A researcher naming someone else's survey gets an empty export, not their data.**
Authorisation is a property of the query rather than a check that can be forgotten at a
new call site — which is exactly the right shape, and it means the media export inherits
correct authorisation *for free provided it is written the same way*.

**This is therefore the single most important implementation constraint in §5:** the
`response_media` query must reach media rows **only through that same join**, never by
`surveyid` or `shortcode` taken from the request. Selecting media by survey id and
filtering afterwards would be a cross-tenant data leak in a feature whose entire purpose
is confidentiality. It should carry a test that asserts a second user's identical
`survey_name` yields zero rows.

### 5.3 Two pre-existing gaps this feature must not inherit

Both found while tracing the export path. Neither is caused by this work; both become
materially worse if copied.

1. **Export object keys are not namespaced by user.** The key is
   `exports/{survey}.csv` (`exporter.py:226`), `exports/{survey}_chat_log.csv` (:459),
   `exports/{survey}_full_messages{suffix}.csv` (:351). `survey` is `survey_name`,
   which is **not globally unique** — it is unique per user. Two researchers with a
   survey named `default` overwrite each other's export objects.

   The disclosure direction is worth stating precisely, because it is the opposite of
   the intuitive one: the **first** researcher's presigned URL stays valid for 7 hours
   and, after the second export overwrites the key, **serves the second researcher's
   bytes**. The victim does nothing wrong and receives someone else's data by following
   their own link. Today that is a CSV of responses. For a ZIP of respondent
   photographs it is a cross-tenant disclosure of personal data.

   **The media export must key by `export_id`:** `exports/media/{export_id}.zip`. The
   export id is already a `crypto.randomUUID()` generated per request in
   `exports.controller.js`. Fixing the CSV keys is out of scope here but should be filed.

2. **`save_file` hardcodes `content_type="text/csv"`** (`storage.py`). A ZIP written
   through it would be served as CSV. Parameterise it.

### 5.4 What the job does

1. Resolve `(email, survey_name)` → the media rows, via the §5.2 join (§7.2 gives the
   query).
2. Stream each object from `respondent-media` and write it into a ZIP **on local disk**,
   the way `full_messages` already uses `NamedTemporaryFile` (`exporter.py:414`).
3. Include a **manifest CSV** inside the ZIP mapping each filename to
   `respondent_id, question_ref, timestamp, mime_type, byte_size, sha256`. Without it a
   folder of `IMG_0001.jpg` is not research data.
4. `fput_object` the ZIP to `exports/media/{export_id}.zip`, presign, write
   `export_link`.
5. `set_metadata` with `assets`, `bytes`, and — importantly — **`missing`**: responses
   that referenced media for which no `stored` row exists (§7.3).

**Filenames inside the ZIP** should be `{respondent_id}/{question_ref}/{asset_id}.{ext}`
— stable, collision-free, and not derived from anything the respondent controls. Meta
supplies a filename for documents; it is untrusted input and must not become a path.

### 5.5 Large volumes

Thousands of images and gigabytes is the expected case, not the edge case, and it is
where "just stream a ZIP from an HTTP handler" fails — which is the second reason to use
the exporter rather than a synchronous endpoint. A request-scoped stream ties a
multi-gigabyte transfer to one HTTP connection with no resumption and no visible
progress; the job queue gives retries, status polling, and a link the researcher can use
later.

Specifics that need deciding rather than discovering in production:

- **Disk.** The exporter builds artifacts on local disk. `full_messages` CSVs already
  reach ~1.6 GB (`documentation/exports-storage.md`); a media ZIP will exceed that.
  Ephemeral storage limits on the exporter pod need raising, and running out must fail
  the job cleanly rather than evicting the pod.
- **Don't recompress.** JPEG and MP4 do not compress. Use `ZIP_STORED`, which turns the
  job into IO plus a small constant of CPU.
- **MinIO capacity.** MinIO is now a **4-replica StatefulSet, 50 Gi PVC each, erasure
  EC:2 → ~100 Gi usable** (`devops/minio/minio.yaml:104-117,236`). That is the real
  number; `documentation/exports-storage.md` still describes the superseded single-node
  25 Gi deployment and is **stale** (see §11.5). ~100 Gi is a real constraint once
  permanent respondent media and multi-gigabyte transient ZIPs share it.
  **Capacity alerting is a prerequisite, not a follow-up** — the same argument
  `media-abstraction.md` §4.5 makes for not deferring it.
- **A cap.** A maximum asset count or byte budget per job, exceeded → `Failed` with a
  clear message, rather than a worker thread occupied for hours. `WORKER_THREADS`
  defaults to 4, so one runaway media export removes 25% of export capacity for every
  other researcher. Multi-part output (`{export_id}.part1.zip`) is the escape hatch if
  the cap proves too tight, but a cap with a good error beats an unbounded job.
- **`STUCK_TIMEOUT_MINUTES` is 120.** A media export slower than that gets reset and
  retried while still running, and will then race itself. Either the timeout becomes
  per-source or the cap must keep jobs well inside it. **This is a real
  correctness issue, not a tuning note.**

---

## 6. Schema: a separate table

**Decision: a new table, `chatroach.inbound_media`. It does not extend `media_asset`.**

`media-abstraction.md` §5 justified two tables with a specific test — not
asset-vs-handle but **immutable vs volatile**, plus *"different durability, different
mutability, different reader, different writer."* Applying that same test here decides
the question, and it decides it against reuse on every axis:

| | `media_asset` | inbound media |
|---|---|---|
| Writer | dashboard-server, on researcher upload | `media-ingest`, from a Kafka event |
| Reader | the media tab | the exporter |
| Mutability | **write-once, never updated** | `pending→stored\|failed\|expired`, `attempts++` |
| Owner | `userid` → `users(id)`, a researcher | a **respondent**, who is not a user |
| Identity | `UNIQUE (userid, content_hash)` | `(platform, account_id, platform_media_id)` |
| Public URL | yes, that is the point | **never** |

The decisive one is `userid UUID NOT NULL REFERENCES chatroach.users(id)`. Inbound
media has no researcher at write time — the ingest consumer sees a phone number and a
`phone_number_id`, not a survey owner. Making that column nullable to accommodate
inbound media would turn the researcher's library table into a discriminated union
whose every query needs a predicate, which is the exact cost §5 declined to pay for a
much smaller saving. And a mutable status column in a table documented as
"write-once, never updated" breaks a stated invariant that other code will rely on.

A shared table would also put respondent data one forgotten `WHERE` clause away from
the media tab, which lists assets by user and hands back public URLs.

### 6.1 Sketch

```sql
CREATE TABLE chatroach.inbound_media(
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- provenance: which account received it, and Meta's handle
    platform          VARCHAR NOT NULL,        -- whatsapp | messenger
    account_id        VARCHAR NOT NULL,        -- credentials.key
    platform_media_id VARCHAR,                 -- WhatsApp only; NULL on Messenger
    source_url        VARCHAR,                 -- Messenger only; dead within minutes

    -- the join key to responses (§7.2)
    respondent_id     VARCHAR NOT NULL,        -- responses.userid
    response_value    VARCHAR NOT NULL,        -- exactly what machine.js persisted

    -- bytes
    content_hash      VARCHAR,                 -- sha256 hex; from the webhook, verified
    mime_type         VARCHAR,
    media_type        VARCHAR,                 -- image | video | audio | file
    byte_size         INT,
    storage_key       VARCHAR,                 -- 'r/<uuid>'; NULL until stored

    -- lifecycle
    status            VARCHAR NOT NULL DEFAULT 'pending',
    attempts          INT NOT NULL DEFAULT 0,
    last_error        VARCHAR,
    first_seen        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    stored_at         TIMESTAMPTZ,

    UNIQUE (platform, account_id, platform_media_id),
    INDEX (status, first_seen),                -- sweeper and expiry alerting
    INDEX (respondent_id, response_value)      -- the export join
);
```

Three deliberate departures from `media_asset`, each with a reason:

- **`storage_key` is stored, not derived.** §5 omitted it because it derives from `id`
  and `MEDIA_PUBLIC_BASE`. Here there is no public base to derive from, and making the
  key explicit means a future change to key layout does not orphan existing objects.
- **Identity is still a UUID, and `content_hash` is still only a column.** §5's argument
  — content-addressed keys make deletion a refcounting problem — applies *more* strongly
  here, because deletion obligations are stronger (§9). Two respondents sending the same
  image must produce two independently-deletable rows. The oracle concern §5 raised is
  moot (no URL exists), but the deletion concern is decisive on its own.
- **`content_hash` is verified, not merely recorded.** The webhook hands us the digest
  (findings §4.4), so the stored object can be checked against it for free. Dedupe is
  explicitly **not** an optimisation to apply — it is reporting only, for the same
  deletion reason.

`GRANT SELECT` to `chatreader`; `INSERT, SELECT, UPDATE` to `chatroach`. Whether
`DELETE` is granted depends on §9 and should be decided there rather than by default.

Migration number: `25-inbound-media.sql` (24 is taken by `24-media-assets.sql`).

---

## 7. Linking media to survey, respondent and question

### 7.1 The problem

The ingest consumer sees the raw webhook: media id, respondent phone number,
`phone_number_id`. It does **not** see `surveyid`, `shortcode` or `question_ref` —
those are decided downstream by replybot's state machine, possibly after the download
has already finished. The two facts are produced by different services at different
times and neither can wait for the other.

### 7.2 Join at read time, not write time

**Decision: `inbound_media` stores no survey linkage. The export joins to `responses`.**

Since `471475a2`, `machine.js` persists the media **id** as `responseValue` for
WhatsApp (`machine.js:853-856` → `responses/responser.js:8`); Messenger persists its
CDN URL, unchanged. So `responses.response` holds exactly one of the two values the
ingest row also holds. Storing that string verbatim as `response_value` makes the join
uniform across platforms:

```sql
SELECT im.*
FROM chatroach.inbound_media im
JOIN chatroach.responses r
  ON  r.response = im.response_value
  AND r.userid   = im.respondent_id
JOIN chatroach.surveys s ON r.surveyid = s.id
JOIN chatroach.users   u ON s.userid   = u.id
WHERE u.email = %s
  AND s.survey_name = %s
  AND im.status = 'stored'
```

The last three lines are `exporter.py`'s existing authorisation join, unchanged. That is
the whole point of choosing this shape: **the linkage question and the authorisation
question get the same answer.**

**Why not have replybot write the link.** It would need a second writer on a table it
does not own, re-coupling the service the findings doc worked to keep credential-free;
and it does not remove the ordering problem, since the response row and the download
complete in either order. Join-at-read is order-independent by construction.

**Why not have the consumer resolve the survey itself.** It would have to reimplement
replybot's state machine to know which question was being answered. That is the same
logic in two places, diverging.

### 7.3 The fragility, named

This join depends on `responses.response` containing exactly the media id. That is a
**contract established by `471475a2`** — the commit message itself flags it as *"a
change to the response record's contract [that] should be reviewed as such."* If a
future change wraps, prefixes or JSON-encodes that value, the join silently returns
fewer rows and the researcher gets a short ZIP with no error.

**Mitigation, and it is not optional:** the export job counts responses of type `upload`
for the survey, counts matched media rows, and records **both** in `export_status.metadata`.
A mismatch is surfaced in the UI and in the ZIP manifest. Silent shortfall is the failure
mode this design is most exposed to, so it must be measured rather than trusted. `set_metadata`
already exists for exactly this kind of counter.

---

## 8. What researchers can and cannot do

### 8.1 The residual capability URL — stated honestly

The requirement is "no publicly-available URLs. Ever." The design achieves that for
**objects**. It does not achieve it for the **ZIP**, because the exporter delivers via
`get_presigned_url(..., expires=timedelta(hours=7))` (`storage.py:159`).

A presigned URL is unauthenticated, bearer-style, and works for anyone holding it. It is
a capability URL with a 7-hour life and a bag of respondent photographs behind it.

**This is the one place where the stated requirement and the reused mechanism genuinely
conflict, and it should be resolved deliberately rather than inherited.** Three options:

1. **Accept it, shorten it.** 7 hours is sized for a CSV a researcher may fetch later.
   For respondent media, minutes is more appropriate. Cheapest, and strictly better than
   today's export posture.
2. **Proxy the download through dashboard-server** — authenticate with the existing JWT,
   re-run the §5.2 ownership check, stream from MinIO. No URL ever leaves the auth
   boundary. This is genuinely the "proxy-with-auth" that §4.6 anticipated, but placed on
   the *export* rather than on individual assets — one endpoint, one check, coarse
   granularity. Costs a long-lived streaming connection on dashboard-server, and note it
   is **not free today**: dashboard-server's `dashboard-media` credential is scoped to
   `media/*` and deliberately cannot reach the exports bucket
   (`devops/values/production.yaml:495-533`), so this option requires granting it a new
   read credential — which is exactly the sort of scope creep §4.1 is trying to prevent.
   The precedent exists (`GET /api/v1/responses/csv` already streams a CSV with
   `Content-Disposition: attachment`, `response.controller.js:34-49`), so the pattern is
   established even though the credential is not.
3. **Both** — proxy by default, presign as fallback.

**Recommendation: (1) now, (2) if the posture is challenged.** (1) is a one-line change
and captures most of the risk reduction; (2) is the correct end state but is a separable
piece of work and should not gate ingestion, which is the part with a deadline.

Whichever is chosen, note that the ZIP object itself inherits the exports bucket's 3-day
lifecycle. That is the right default — the artifact is transient, the source of truth is
the respondent-media bucket — and it means a leaked link dies quickly on its own.

### 8.2 Authentication

Unchanged and reused: `express-jwt` via `dashboard-server/middleware/auth.js`, `email`
from `req.user`, and the §5.2 join. **No new authentication mechanism is introduced by
this design**, which is the strongest thing that can be said about it.

### 8.3 No single-asset preview — deliberately out of scope

Researchers will want to look at one image in the dashboard without downloading a
gigabyte. **v1 does not offer this**, and that is a decision rather than an oversight:
it is the requirement that pulls hardest toward a per-object read path, and every
per-object read path is one auth bug away from being the media-proxy again.

If it is later required, the shape is fixed in advance: a dashboard-server route that
takes an `inbound_media.id`, re-runs the §5.2 join to prove ownership, and **streams**
the object. Not a presigned URL — a presigned URL for an individual respondent
photograph is precisely the capability URL this design exists to avoid, and it would
leak into browser history, referrers and screenshots.

---

## 9. Retention, deletion, and what is unknown

**The honest position: there is no data-retention policy in this repository to inherit,
and this design cannot invent one.**

What is knowable is stated; what is not is flagged as a decision for someone with the
authority to make it.

**Known and decided:**

- No lifecycle rule on `respondent-media`. Automatic expiry of research data is the
  wrong default, and the exports 3-day rule would be catastrophic here.
- The ZIP artifact **does** expire (3 days, inherited). Correct — it is a copy.
- Deletion must be **possible and complete**: row, object, and backup mirror. Hence
  `mc mirror --remove` (§4.3), against media-backup.md §6's open question.

**Not decided, and requiring a human:**

- **How long is respondent media kept?** Indefinitely is the current implicit answer and
  it is almost certainly not the right one for photographs of people. Tie it to survey
  closure, to a fixed period, or to a per-survey setting — but pick one.
- **Erasure requests.** If a respondent asks for their data to be deleted, the mechanism
  is `DELETE FROM inbound_media WHERE respondent_id = $1` plus object deletion plus
  backup propagation. No component currently has delete permission on the bucket (§4.1,
  deliberately). Whether that permission goes to a dedicated admin path or nowhere is a
  decision this design leaves open, but **the absence of a delete path is currently a
  compliance gap, not a security feature**, and should not be mistaken for one.
- **Residency.** media-backup.md §3 already flags residency as possibly a compliance
  constraint for "respondent-adjacent" data. This is not adjacent, it is respondent data
  proper, and the backup target's jurisdiction becomes a real question rather than a
  cost question.

---

## 10. PII and consent — flagged, not solved

Respondents send what they send. Across surveys in this system that plausibly includes
faces, household interiors, identity documents, medical records, and images of people
who are not the respondent and never consented to anything.

Facts about the design as it stands, stated so nobody assumes otherwise:

- **No content inspection.** No moderation, no PII detection, no face blurring. Bytes are
  stored as received. Adding any of these is a large separate project and is out of
  scope.
- **No per-question consent capture.** An `upload` question collects an image; nothing
  records what the respondent was told about its retention or use.
- **The blast radius of the ZIP is the researcher's laptop.** Once downloaded, this
  design has no further control — no watermark, no audit of what was viewed, no expiry.
  That is a property of the requirement ("onto their computer"), not a flaw in the
  implementation, but it means the *download event* is the meaningful audit boundary and
  `export_status` is the only place it is recorded. That is worth keeping.
- **`media.core.js`'s type validation does not apply here.** `validateUpload` and the
  MIME allowlist govern *researcher uploads*. Respondent media is whatever Meta
  delivers. `Content-Disposition: attachment` on every stored object, plus the fact that
  nothing serves them to a browser, is what keeps an uploaded HTML or SVG inert — the
  same reasoning as §4.6's supporting controls, reached by a different route.

**Recommended, cheap, and not built here:** a `README.txt` inside every ZIP stating what
it contains, that it is respondent personal data, and what the researcher's obligations
are. It costs nothing and it is the only point in the flow where a human reliably looks.

---

## 11. Open questions

1. **Messenger's inbound attachment URL TTL is unknown.** Meta's `oh=`/`oe=` signed CDN
   URLs have never been probed the way WhatsApp's were. Since Messenger carries ~100% of
   live media traffic and has **no durable id**, this is the highest-value unknown in the
   document. `planning/whatsapp-media-watch.sh` is the template for probing it, and it
   should be probed before building, not after.
2. **Is `id` present for all six WhatsApp media types?** Findings §7.4, still open. Both
   probed samples were images. The design depends on `id` for everything except
   Messenger.
3. **Whether Messenger inbound carries a hash.** WhatsApp's free `sha256` is what makes
   §3.2 step 5 free. If Messenger has none, integrity verification is one-sided.
4. **Volume.** Nobody has measured how much media a real survey collects. Every capacity
   decision in §5.5 — the cap, the disk, the ~100 Gi budget — is currently a guess.
   **This one is cheaply answerable and should be answered before stage B**: the raw
   webhook items are all in `chatroach.messages` (§3.4), so a single query counts every
   inbound media event ever received, by type and by survey. It replaces four guesses at
   once and it is the same query the backfill count needs.
5. ~~**MinIO topology.**~~ **Resolved while writing this.** MinIO is already the
   distributed 4-replica StatefulSet with 50 Gi per PVC and EC:2
   (`devops/minio/minio.yaml:104-117,236`), and `media` / `media-staging` buckets already
   exist with scoped writer, reader and backup service accounts
   (`devops/minio/media-svcacct.sh`). So §4.1's third bucket follows an established
   provisioning pattern rather than inventing one — `media-svcacct.sh` is the script to
   copy.

   **The remaining item is a documentation bug, not a design question:**
   `documentation/exports-storage.md` still describes the superseded single-node, 25 Gi
   Deployment. It is the file this design would otherwise have been read against.
   Correcting it belongs in stage G, and arguably sooner.
6. **Whether `STUCK_TIMEOUT_MINUTES` becomes per-source** (§5.5). Needs deciding before
   the first large export, not after.

---

## 12. Explicitly out of scope

- Single-asset preview in the dashboard (§8.3).
- Any public or capability URL for an individual asset (§4.2).
- Content moderation, PII detection, redaction (§10).
- Backfill of pre-`471475a2` media (§3.4) — written off deliberately.
- Fixing the non-namespaced export CSV keys (§5.3) — filed, not fixed here.
- Dedupe as a storage optimisation (§6.1) — the deletion semantics forbid it.
- Serving inbound media back to respondents. Nothing in the product requires it and it
  would reintroduce the outbound problem in the inbound direction.

---

## 13. Build order

Ingestion first, because it is the only part with a deadline. Every day without it is a
day of permanently lost respondent media; delivery can be built against data already
accumulating.

| Stage | What |
|---|---|
| A | Probe the Messenger CDN URL TTL (§11.1). It can invalidate §3.3's Messenger handling. |
| B | Migration `25-inbound-media.sql`; bucket + two scoped service accounts (§4.1). |
| C | `media-ingest`: consumer, tokenstore reuse, resolve→download→verify→store, sweeper. Pure core (filter, key derivation, hash verification) table-tested with no Kafka, no Meta, no MinIO — per §10 of the media plan. |
| D | Backup mirror covering `respondent-media` **before** the first asset is stored (§4.3). Capacity alerting alongside. |
| E | Exporter `response_media` source: the §7.2 join, ZIP assembly, manifest, the shortfall counter (§7.3). Test that a second user's identical `survey_name` yields zero rows (§5.2). |
| F | `SOURCE_MAP` entry, dashboard UI, presign expiry decision (§8.1). |
| G | Documentation: `documentation/inbound-media.md`, and updates to `exports-storage.md` (third bucket, no lifecycle) and `platform-abstraction.md` (which findings §8 already notes is stale on the media payload shape). |

Stages A–D are the deadline-bearing half. E–G can lag without losing data.
