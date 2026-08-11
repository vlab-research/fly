# Inbound Media — Design (deferred)

**Status:** Designed, **not built, deliberately deferred 2026-08-11.** Written
2026-08-10 in the `fly-media-abstraction` worktree; deferred after the
production numbers in §0.1 came in.

**This is the single document for inbound media.** It absorbs the former
`planning/whatsapp-inbound-media-findings.md` (deleted; its probe evidence is
Appendix A, with its original section numbers preserved, so every
"findings §X" citation in this document resolves to **Appendix A §X**).
Appendix B holds everything removed from the codebase, verbatim, so the feature
can be restored in one change.

**Why it is deferred:** no researcher has ever used an upload question (§0.1).
Building it now would create a permanent store of respondent photographs — with
a backup obligation, a retention policy question and an erasure gap (§9) — for
zero users. Nothing is being lost in the meantime, because nothing is being
collected.

**What was removed on deferral**, so the platform stops claiming a capability
it does not have:

| Where | Change |
|---|---|
| `smoke-test/form-a.json` | `send_picture` + `picture_received` fields and their wiring (Appendix B) |
| `smoke-test/README.md` | flow table, branch diagram, `upload` gotcha |
| `documentation/platform-abstraction.md` | corrected the `user_media` payload shape; added "Inbound media is NOT a supported feature" |

**What was deliberately left in place:** `validateUpload`
(`replybot/lib/generic-validator.js`), the normalizer media branch
(`event-normalizer.js:371-384`), and the media-id persistence from `471475a2`.
They are small, correct, and are what makes re-adding this cheap. Do not remove
them.

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

## 0. Production findings, 2026-08-11

Read-only queries against vprod (CockroachDB, follower reads). **These were run
after the design below was written and they correct it in four places.** Where
this section and a later section disagree, this section is right.

### 0.1 Nobody uses this. That is why it is deferred.

Across **5,125 surveys and 187,148 fields**, exactly **18 fields** declare
`type: upload`. All 18 belong to four surveys owned by `nandanmarkrao@gmail.com`
(`flysmoke`, `smllinktest`, `smlbaseline`, `testuploadtype`). **Zero belong to a
researcher.**

The full production history of inbound media answers is **five rows**:

| when | platform | stored `responses.response` |
|---|---|---|
| 2026-07-27 ×2, 2026-08-11 | messenger | `https://scontent.xx.fbcdn.net/...` |
| 2026-08-09 ×2 | whatsapp | `1338855734902082`, `1046120588390346` |

This confirms §7.2's join contract exactly as designed — and it closes §3.4:
**there is no backfill problem**, and the deadline pressure driving §13's build
order is imaginary. Nothing is bleeding because nothing is being collected.

Detector note for anyone re-running this: the effective field type comes from
`md`, not Typeform's `type`. `form.js:addCustomType` parses
`properties.description` as YAML and `params.type` **overrides** `field.type`.
An upload question is a `short_text` whose description is
`{"type":"upload","upload":{"type":"image"}}`. Match on the description with
`~ 'type"?\s*[:=]\s*"?upload'` — a plain `LIKE '%"type":"upload"%'` misses the
half that use a space after the colon.

### 0.2 Messenger inbound URLs live ~30 days, not minutes

**This inverts §2's central claim.** The `oe=` parameter on the signed CDN URL
is a hard expiry:

| sample sent | `oe=` | expires | TTL |
|---|---|---|---|
| 2026-07-27 | `6A8E299E` | 2026-08-25 | **29.84 days** |
| 2026-08-11 | `6AA208FD` | 2026-09-10 | **29.93 days** |

WhatsApp's `ext=` (~302 s) and Messenger's `oe=` are different mechanisms on
different clocks. So §2's "for Messenger there is no budget at all", "the first
fetch is the only fetch", "Messenger is the strict one", and §3.3's "the sweeper
cannot help Messenger" are all **wrong**. On these numbers WhatsApp (7 days) is
the strict platform and Messenger the forgiving one — the conventional reading
after all. It also means Messenger media *is* backfillable for ~30 days.

**Not fully verified:** the signature was decoded, the URL was not fetched.
`oe` is the documented expiry but Meta may enforce other limits. **Fetching an
aged URL unauthenticated is the one probe still owed** — it is Stage A, it is
one `curl`, and it decides whether "download on receipt" is a hard requirement
or a preference.

### 0.3 Messenger carries no hash, no mime type, no size

The raw inbound payload is exactly `{"type":"image","payload":{"url":"..."}}`.
So §11.3 is answered **no**: §3.2 step 5's free integrity check is
**WhatsApp-only**. On Messenger you must trust `Content-Type` and have no
defence against storing a truncated object.

### 0.4 The real inbound media volume is unsolicited — and the design would store it

Sampling 400 recently-active respondents: on one World Bank page
(`111108121363615`), **92 distinct respondents sent 160 images in four weeks**,
to surveys with **no upload question at all**. Respondents just send photos.

§3.2 step 1's filter is *"is this an inbound message event carrying media?"*,
which would permanently store every one of them: no join key to any response, no
researcher who asked for it, no export path, and maximal PII exposure for zero
research value.

**The filter must be scoped to media answering an upload question.** That
requires survey context the consumer explicitly does not have (§7.1), so either
ingest gates on a response row appearing, or §7's join-at-read-time premise
needs revisiting. **This is an unresolved hole in the design, not a tuning
note.**

### 0.5 The `messages` scan is no longer cheap

§11.4 calls the volume query "cheaply answerable". It is not. Migration 18
(applied 2026-07-22) dropped both global timestamp indexes on
`chatroach.messages`; only `primary` and `messages_userid_timestamp_idx` remain,
and there is no index on `timestamp` or `content`. That query is now a **full
scan of ~101M rows / ~400 GiB**. Sample by `userid` (which *is* indexed)
instead — that is how §0.1 and §0.4 were measured.

(§3.4's other claim holds: the raw webhook item is in `messages.content`
verbatim, id, `sha256`, `mime_type` and all.)

### 0.6 Two defects in the schema and the join, both with the same root cause

**The design keys on Meta's media id, and Messenger does not have one.**

1. **`UNIQUE (platform, account_id, platform_media_id)` does nothing for
   Messenger.** `platform_media_id` is NULL there, and NULLs are distinct in a
   unique index — so §3.2 step 2's `ON CONFLICT DO NOTHING` **never fires**, and
   Kafka's at-least-once delivery duplicates downloads and stored objects on the
   platform carrying ~100% of traffic.
2. **The §7.2 join is not 1:1.** Two response rows in production hold a
   **byte-identical** Messenger URL (verified by `md5(response)`), so the join
   fans out: duplicate manifest entries, ZIP filename collisions, and a wrong
   `missing` counter.

**Both close with the same fix: key on the message `mid`**
(`m_1X_qEefFwSPdn1wVGkpY1pJaDwO6MfM6T1OEQCh-Kvt…`), which is present on both
platforms and unique per message. Use `(platform, account_id, message_id)` as
the natural key in §6.1 instead.

---

## 0bis. Relationship to the absorbed findings

The probe evidence in **Appendix A** is backed by two live runs against Meta and
remains the authoritative record of *what Meta actually does*. This design
adopts it wholesale except where §0 above corrects it.

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

**Verdict: extend, do not supersede.** Appendix A §1–§5 stand as the record of
what Meta actually does, established by probe rather than by documentation. This
document supersedes only its **§6.2 storage/retrieval design** and its **§7 open
items**, both of which it flagged as unsettled — and §0.2/§0.3 above correct its
Messenger claims.

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

1. ~~**Messenger's inbound attachment URL TTL is unknown.**~~ **Mostly answered
   by §0.2** — the `oe=` signature decodes to ~30 days on both samples, which
   inverts §2. **Still owed: one unauthenticated `curl` of an aged URL** to
   confirm Meta honours it. `planning/whatsapp-media-watch.sh` is the template.
   This remains the single highest-value probe and it is Stage A.
2. **Is `id` present for all six WhatsApp media types?** Findings §7.4, still open. Both
   probed samples were images. The design depends on `id` for everything except
   Messenger.
3. ~~**Whether Messenger inbound carries a hash.**~~ **Answered: no** (§0.3).
   Integrity verification is WhatsApp-only.
4. ~~**Volume.**~~ **Answered: effectively zero** (§0.1) — five media responses
   in all of production, none from a researcher. Every capacity decision in
   §5.5 is therefore untested rather than merely unmeasured, and must be
   revisited against real numbers if this is ever built. Note §0.5: the
   `messages` query this item proposed is now a ~400 GiB full scan; sample by
   `userid` instead. **§0.4 is the volume question that actually matters now** —
   unsolicited media, which the design would store and should not.
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

**The trigger to start is a researcher actually needing an upload question.**
Until then this stays deferred (§0.1). When that day comes, the first move is
not Stage A — it is **§0.6 and §0.4**: re-key the schema on the message `mid`,
and decide how ingest is scoped so it does not hoover up unsolicited media.
Neither is a coding task; both are design corrections this document has not yet
absorbed into §3–§7.

The original ordering below assumed ingestion carried a deadline. It does not
while nothing is collected — but it *will* from the moment the first upload
question goes live, so Stages A–D still have to land before that question is
published, not after.

| Stage | What |
|---|---|
| 0 | Re-open §3.2's filter (§0.4) and §6.1's natural key (§0.6). **Do this first.** |
| A | Probe the Messenger CDN URL TTL — one unauthenticated `curl` of an aged URL (§0.2, §11.1). It can invalidate §3.3's Messenger handling. |
| B | Migration `25-inbound-media.sql`; bucket + two scoped service accounts (§4.1). |
| C | `media-ingest`: consumer, tokenstore reuse, resolve→download→verify→store, sweeper. Pure core (filter, key derivation, hash verification) table-tested with no Kafka, no Meta, no MinIO — per §10 of the media plan. |
| D | Backup mirror covering `respondent-media` **before** the first asset is stored (§4.3). Capacity alerting alongside. |
| E | Exporter `response_media` source: the §7.2 join, ZIP assembly, manifest, the shortfall counter (§7.3). Test that a second user's identical `survey_name` yields zero rows (§5.2). |
| F | `SOURCE_MAP` entry, dashboard UI, presign expiry decision (§8.1). |
| G | Documentation: `documentation/inbound-media.md`; updates to `exports-storage.md` (third bucket, no lifecycle) and `platform-abstraction.md` (replace the "Inbound media is NOT a supported feature" section). |
| H | Restore the smoke-test coverage from Appendix B — **in the same change**, so the media path is never unwatched again. |

Stages 0–D are the deadline-bearing half. E–H can lag without losing data.

---

# Appendix A — Probe evidence (absorbed from `whatsapp-inbound-media-findings.md`)

*Original section numbers are preserved: every "findings §X" citation in this
document resolves here. Its §6 (design) and §7 (open items) are superseded by
the body above and are not reproduced; §0.2 and §0.3 correct its Messenger
claims.*

**Provenance:** Root cause identified and verified. Design settled — see §6.
Observed in production 2026-08-05 during the first end-to-end WhatsApp test
(Track A, number `1203867182815254`, survey `flysmoke`). Probed 2026-08-05
after the fact, and again 2026-08-06 against a live event 14 seconds old —
two independent media samples, agreeing on every point except one, where the
live run corrected an over-strong claim (see §4.2b).

## 1. The observed issue

Answering an upload question by sending a photo over WhatsApp returns
"sorry, that answer is not valid". This reproduces for every WhatsApp media
answer; it is not intermittent and not asset-specific.

Messenger is unaffected — but see §5.3, it is broken in a different way.

---

## 2. Root cause — verified

A field-name mismatch in the inbound normalizer.

**The actual webhook payload** (captured verbatim from replybot logs in
production):

```json
{
  "from": "15419799714",
  "id": "wamid.HBgLMTU0MTk3OTk3MTQVAgASGCBBQzZFQzMyQ0ZCQ0VFOTAxMTEyNTdBQ0Y1NDhCRUMwMwA=",
  "timestamp": 1785972838000,
  "type": "image",
  "image": {
    "mime_type": "image/jpeg",
    "sha256": "IykpcWWXi/vfsIJ1QUUouc+HEoWd5W/ypMuc/6L7/es=",
    "id": "2563305464111161",
    "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=2563305464111161&source=webhook&ext=1785973140&hash=..."
  },
  "source": "whatsapp",
  "phone_number_id": "1203867182815254"
}
```

**What the normalizer reads** — `replybot/lib/event-normalizer.js:379`:

```js
payload: { id: media.id || null, url: media.link || null }
```

It reads `media.link`. The inbound field is `media.url`. `link` is the field
name WhatsApp uses for **outbound** sends (`{"image":{"link":"..."}}`), and it
appears to have been carried over to the inbound parser by analogy.

**Where it fails** — `replybot/lib/generic-validator.js:209-211`:

```js
const url = r && r.payload && r.payload.url
const validType = (r && r.type) === uploadType
const valid = validType && !!url
```

`url` is always `null`, so `valid` is always `false`, so every media answer is
rejected regardless of type or content.

**Messenger is unaffected by this particular defect** because
`event-normalizer.js:96-101` passes `data.message.attachments` through
unchanged, preserving Facebook's native `payload.url`.

---

## 3. Scope — what is *not* broken

From the same production run, confirming the bug is narrow:

- Interactive **button replies** (≤3 options) parse correctly.
- Interactive **list replies** (4–10 options) parse correctly.
- Text validation works — `siblings` correctly rejected "Goo" and accepted "5".
- Numeric, phone-number and multiple-choice field types all validated correctly.
- The flow reached `WAIT_EXTERNAL_EVENT` on a real Reloadly payment.

So this is specifically the media ingestion path, not WhatsApp inbound
generally.

Blast radius is currently small: across eight replybot pods in `vprod`, six
hours of logs contained exactly **one** media event — the test image. Nothing
is silently accumulating broken media answers in production.

---

## 4. What the live probe established

Two independent runs against the production credential for phone number
`1203867182815254`.

- **Run A** (2026-08-05), media `2563305464111161`, probed ~25 min after the
  event — every URL already expired.
- **Run B** (2026-08-06), media `1981434135889496`, probed **14 seconds** after
  the event, inside the URL's lifetime. This is the run that settles the
  auth-vs-expiry question Run A could not.

Reproducible via `planning/whatsapp-media-probe.sh <media_id>` for the
after-the-fact case, or `planning/whatsapp-media-watch.sh` to catch a live
event and probe inside the window. Both are read-only and never print the
token.

| # | Request | Run A (aged ~25 min) | Run B (aged 14 s) |
|---|---|---|---|
| 1 | Webhook `url`, **no auth** | `401` | **`401`** |
| 2 | Webhook `url`, **with** Bearer | `401` (expired) | **`200`, `image/jpeg`, 155,656 B** |
| 3 | `GET /v18.0/{media_id}`, with Bearer | `200` | `200` |
| 4 | Resolved URL, **no auth** | `401` | `401` |
| 5 | Resolved URL, with Bearer | `200`, 152,619 B | `200`, 155,656 B |
| 6 | Resolved URL, +6 min, with Bearer | `401` — expired | not re-run |

### 4.1 — Media URLs require a Bearer token. Always.

Run B test 1 is decisive: a webhook lookaside URL **14 seconds old**, well
inside its lifetime, still refuses an unauthenticated GET with `401
Authentication Error`. The `hash=` parameter is **not** a self-contained
pre-signature. Confirmed independently by test 4 on both runs against
freshly-resolved URLs.

No unauthenticated consumer can fetch WhatsApp media, ever, from either URL
source.

### 4.2 — The URL expiry is hard, and applies to both URL sources.

Run A: `ext=1785973140` against event timestamp `1785972838` — **302 s**.
Run B: **303 s**. So ~5 minutes, marginally variable rather than a fixed
constant; do not hard-code 300.

Run A test 2 shows a valid token does not rescue an expired URL, and test 6
shows URLs from `GET /{media_id}` expire on the same clock.

### 4.2b — The webhook `url` *is* usable — with a token, inside the window

Run B test 2 returned `200` and the full 155,656-byte JPEG from the
webhook-embedded URL directly. Run A's `401` on the same request was **purely
expiry**, not a property of the URL.

This corrects an over-strong claim in the previous revision of this document,
which held that the webhook URL was unusable in principle. It is not. It is
merely useless *to this architecture* — see 4.5.

### 4.3 — The media ID is the durable handle.

Run A test 3 resolved cleanly 25 minutes after the event, long after every URL
associated with it had died. Meta documents a 30-day media retention window;
only the 25-minute figure is verified here, but the ID is unambiguously the
reference that survives.

### 4.4 — `sha256` is a usable content identity.

The webhook's `sha256` is base64; the resolve endpoint returns hex. They decode
to the same digest — verified on **both** samples, independently. Usable for
content-addressed dedup and integrity checking without any extra call.

Run B also confirms the response bytes agree across sources: the webhook URL
and the resolved URL both returned exactly 155,656 bytes, matching `file_size`.

### 4.5 — Consequence: the `url` field is useless *to us*.

Not inert in principle (4.2b) — useless in this architecture, for two reasons
that both hold:

- It needs credentials, and replybot does not have any (5.2). The only
  component positioned to read it cannot use it.
- It is dead within ~5 minutes, so nothing asynchronous or downstream can use
  it either, and anything persisting it stores a value that is unresolvable
  seconds later.

The one-line field fix (`media.link` → `media.url`) therefore unblocks the
conversational flow but writes a value into `responses` that is worthless by
the time anyone reads it.

---

## 5. Structural facts about the current pipeline

### 5.1 — The media ID is discarded before storage

`machine.js:582-583` builds the attachment object carrying both `id` and `url`,
but that object is consumed **only** by the validator (`machine.js:934-936`).
What propagates is `responseValue`, which is the bare URL string
(`machine.js:853-856` → `responses/responser.js:8`).

So the ID never reaches the `responses` table. Any fix that stores only the URL
discards the sole recoverable reference to the asset.

### 5.2 — replybot holds no credentials

`replybot/lib/typewheels/tokenstore.js` was deleted during the
platform-abstraction work; there is no tokenstore anywhere under `replybot/lib`
today. replybot cannot call `GET /{media_id}` or attach a Bearer header. Any
resolution or download step is therefore architecturally excluded from replybot
as currently structured.

Per-account tokens live in the `credentials` table, keyed
`(entity, key)` = (`whatsapp_business` | `facebook_page`, account id).
`message-worker/tokenstore.go:84` is the working reference implementation.

### 5.3 — Messenger has the same disease

Nothing anywhere in the repo re-hosts, refreshes or re-fetches media — verified
by grep across replybot, hermes, message-worker and event-exporter. Messenger
stores its own expiring CDN URL (`oe=`/`oh=` signed) exactly the same way.
**Messenger upload answers have been storing dead links all along.** This is
not a WhatsApp regression; WhatsApp is currently below an already-broken
baseline.

Any durable-media design must cover both platforms or it will be built twice.

### 5.4 — Media IDs are already on the Kafka topic

`hermes/src/handlers.rs:177` stamps each raw WhatsApp message with its
`phone_number_id` and produces the **whole item** to `event_topic`. replybot
consumes from that topic and normalizes afterwards. In production both are
bound to the same anchor in `devops/values/production.yaml` —
`vlab-prod-chat-events`.

The full `image` object, ID included, is therefore already flowing through
Kafka today. A downloader needs **no new topic and no producer changes** — only
a new consumer group.

---

## 8. Related

- `planning/whatsapp-media-send-path-findings.md` — the **outbound** media
  counterpart found in the same session (out-of-order delivery). Same root
  shape: the platform abstraction generalised routing and naming but not the
  points where Meta's two APIs genuinely diverge. The underlying divergence
  this document establishes — Messenger is URL-first, WhatsApp is ID-first —
  is likely the same fault line.
- `documentation/platform-abstraction.md` — §"Replybot Event Normalizer" lists
  the WhatsApp inbound event mapping. Line 363 documents the media payload as
  `{ type, url }`, which is both the defective shape and out of step with the
  code's actual `{ type, payload: { id, url } }`. Needs updating once 6.1
  lands.
- `replybot/lib/event-normalizer.js:371-384` — the WhatsApp media branch.
- `replybot/lib/generic-validator.js:203-214` — `validateUpload`.
- `message-worker/tokenstore.go:84` — reference token lookup.
- `exporter/exporter/storage.py` — reference S3/MinIO backend.


---

# Appendix B — Restoring the smoke-test coverage

Everything removed from `smoke-test/` on 2026-08-11, verbatim. Restore it in
**Stage H**, in the same change that builds the downloader — the `media.link` /
`media.url` bug (Appendix A §2) was silently broken from the platform
abstraction until this coverage caught it, and it is the only end-to-end guard
on the inbound path.

### B.1 The two fields (`form-a.json`, inserted after `confirm_attachment`)

```json
{
  "type": "short_text",
  "ref": "send_picture",
  "title": "📸 Now testing INBOUND media. Please send me a picture — tap the attachment/camera button in Messenger and choose any photo.",
  "properties": {
    "description": "{\"type\":\"upload\",\"upload\":{\"type\":\"image\"}}"
  },
  "validations": { "required": false }
},
{
  "type": "statement",
  "ref": "picture_received",
  "title": "📸 Got your picture! The bot received it and stored the image URL: {{field:send_picture}}",
  "properties": {
    "hide_marks": false,
    "button_text": "Continue"
  }
}
```

**Fix the `picture_received` wording on restore.** Since `471475a2` the stored
value is a media **id** on WhatsApp, not a URL, so "stored the image URL"
interpolates a bare number into a sentence calling it a URL. It was already
wrong when removed. Say *handle*, or branch on platform.

### B.2 The logic wiring

Removing the fields required rerouting two jumps; restoring them reverses that:

| Logic block | Deferred state (now) | Restored state |
|---|---|---|
| `test_attachments` | `Yes → media_third_party_url`, then the `test_environment` branch to `movie_webview_<env>` | `Yes → media_third_party_url`, then `always → send_picture` |
| `confirm_attachment` | carries the `test_environment` branch to `movie_webview_<env>` | **delete this block** — it falls through to `send_picture` |
| `picture_received` | *(deleted)* | recreate it carrying the `test_environment` branch: `staging → movie_webview_staging`, `always → movie_webview_prod` |

The env branch is the load-bearing part: it must sit on whichever field
immediately precedes the moviehouse webview, because the same form is deployed
to prod and staging and the player host differs. Restoring `send_picture` moves
that branch from `confirm_attachment` back to `picture_received`.

Validate after editing — this catches every mistake the rerouting can make:

```bash
python3 - <<'EOF'
import json
d=json.load(open('smoke-test/form-a.json'))
refs={f['ref'] for f in d['fields']}
print("logic blocks with no field:", {l['ref'] for l in d['logic']} - refs)
print("dangling jump targets:", [(l['ref'], a['details']['to']['value'])
      for l in d['logic'] for a in l['actions']
      if a['details']['to']['type']=='field' and a['details']['to']['value'] not in refs])
EOF
```

### B.3 `README.md` restorations

- Flow table row:
  `| `send_picture` → `picture_received` | **Inbound user media** (user sends a photo); stored URL interpolated back | `upload` (`{type:image}`) → `user_media`/MEDIA event |`
- Branch diagram: `test_attachments ──No───► send_picture` (currently
  `movie_webview_<env>`).
- The `test_environment` and `movie_webview_*` rows and the "Three logic rules"
  paragraph name `confirm_attachment` as the env-branch carrier; change back to
  `picture_received`.
- Replace the "There is no inbound-media (`upload`) field, deliberately" gotcha
  with the original:

  > **The `upload` field forces a real photo.** `validateUpload` requires
  > `answer.type === 'image'` with a `payload.url`; typing text is rejected and
  > the prompt repeats. That is intentional — the point is to prove the
  > `user_media` → MEDIA path. (Proven in `replybot/.../machine.test.js`, the
  > "Adds the URL given an attachment as responseValue" test.)

### B.4 Documentation

Replace the "Inbound media is NOT a supported feature" section in
`documentation/platform-abstraction.md` with a real `documentation/inbound-media.md`
(Stage G).
