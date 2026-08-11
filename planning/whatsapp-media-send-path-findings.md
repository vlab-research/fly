# WhatsApp Media Send Path — Out-of-Order Delivery

**Status:** Open. Observed in production 2026-08-05 during the first end-to-end
WhatsApp test (Track A, number `1203867182815254`, survey `flysmoke`).

**Scope of this document:** the problem, what was verified, what is only
hypothesised, and the option space. It deliberately does **not** pick a design
or specify an implementation — the constraints below are the real input, and
several of the open questions must be answered before any option can be
responsibly chosen.

---

## 1. The observed issue

On the first WhatsApp survey run, `flysmoke`'s opening pair arrived on the
handset in the wrong order: the first question ("What is your favorite color?")
was delivered **before** the welcome image whose caption frames the survey.

The two messages are emitted together by replybot as one batch. The intended
order is media first, then the question.

This matters beyond cosmetics. "Context image, then first question" is a common
survey opening, and a question that arrives before the text explaining it
degrades response quality — the respondent answers without the framing, or
disengages.

---

## 2. What was verified

All of the following is confirmed from production logs and database state, not
inferred:

- **Both messages were issued as one batch.** Identical
  `issued_at: 1785972543651` on both commands.
- **message-worker processed them sequentially and in the correct order** —
  media at `ts 1785972545.51`, question at `ts 1785972546.32`, roughly 0.8s
  apart. `NUM_WORKERS=1` in `devops/values/production.yaml`.
- **Neither send errored.** Both logged `command processed successfully`.
- **Conversation state is clean** — `states` row for
  `pageid=1203867182815254` shows `current_state=RESPONDING`,
  `platform=whatsapp`, `current_form=flysmoke`, `error_tag` and
  `fb_error_code` both NULL.

**Therefore the reordering happened after message-worker's API call, not
before it.** Nothing in replybot, Kafka, or the worker's dispatch is
implicated. This rules out a large part of the stack and should not need
re-investigating.

---

## 3. Root-cause hypothesis — NOT proven

`translator_whatsapp.go:198` sets `Link: *msg.MediaURL` unconditionally. Every
WhatsApp media message is therefore sent as a URL, which requires Meta to fetch
the asset from that URL before it can deliver the message. The text/interactive
message that follows carries no such dependency.

The hypothesis is that the fetch puts the media message behind the one after
it. The survey's image is hosted on `i.imgur.com`, which is known to be slow or
hostile toward datacenter hotlinking — a plausible aggravating factor.

**This is a hypothesis.** Meta's delivery internals are not observable from
here, and it has not been established that Meta offers *any* ordering guarantee
for sequential sends to a single recipient. See open questions.

---

## 4. Key findings

**4.1 — The WhatsApp translator ignores `MediaAttachmentID`.**
`translator.go:352` honours it on the Messenger path (sending
`{"attachment_id": "..."}` in place of a URL). `translator_whatsapp.go` never
consults the field. The field rides along on the shared `MessageContent`
because it was introduced for Messenger.

**4.2 — The media-upload subsystem is Messenger-only.**
`dashboard-server/api/media/media.facebook.js` posts to
`/me/message_attachments` with a **page token**; there is no WhatsApp
equivalent anywhere in the repo. Migration `10-media.sql` is titled "tracking
Facebook message_attachments uploads". Migration `22-account-id-rename.sql`
renamed `media.facebook_page_id` → `account_id` — a metadata-only column
rename, nothing more.

This is the shape of the gap generally: the platform-abstraction work made
**routing and naming** generic (credential lookup, translator dispatch, account
keying) and stopped where Meta's two APIs genuinely diverge. Media upload is
one of those divergence points, and it is a second implementation rather than a
rename.

**4.3 — The failing asset is an arbitrary URL, not a dashboard media item.**
The command carried `media_url: https://i.imgur.com/ZSHauqq.png` with
`media_attachment_id: null`. Any solution scoped only to dashboard-uploaded
files would not have prevented this. Surveys reference media from arbitrary
origins (Typeform, imgur, wherever the author put it).

**4.4 — Expiry is asymmetric between the platforms.**
Facebook `attachment_id`s are permanent. **WhatsApp media ids expire after 30
days.** The `media` table records `created` but has no expiry or refresh
concept, because Messenger never needed one. A survey fielded for three months
with a welcome image would silently break at day 30 under a naive
upload-once-and-store approach.

**4.5 — Media ids are scoped per account *and* per platform.**
A Facebook attachment id is valid only for the page that uploaded it; a
WhatsApp media id only for the `phone_number_id` that uploaded it. The `media`
table is already keyed by `account_id`, so its shape accommodates this — one
row per (asset, account) pair, as it already works across multiple pages. A
survey fielded on both a page and a number needs two uploads and two ids.

---

## 5. Constraints any solution must respect

1. **Arbitrary URLs, not just dashboard uploads** (per 4.3).
2. **Account-scoped ids** — a cache keyed only by URL is wrong (per 4.5).
3. **30-day expiry on the WhatsApp side** — anything that stores an id needs a
   refresh or self-heal story (per 4.4).
4. **No Messenger regression.** The Messenger path works today and carries all
   current production traffic.
5. **Ordering is the goal; media ids are a means.** If a cheaper mechanism
   guarantees ordering, the media-id work may be worth doing for latency and
   cost reasons but is not the fix per se.
6. **WhatsApp option limits still apply** to the messages around it (≤3 options
   → buttons, 4–10 → list, >10 → `ErrTooManyOptions`) — unrelated, but any
   test survey touching this path will hit them.

---

## 6. Option space

Presented for evaluation, not as a recommendation. Several are combinable.

**A. Upload-and-cache in the send path (message-worker).**
On send, resolve `(account_id, media_url)` to a cached media id; upload via
`POST /{phone_number_id}/media` on miss or expiry. Covers arbitrary URLs,
removes the fetch from the critical path, and can self-heal from an invalid-id
error. Costs: message-worker gains upload responsibility and a cache store, and
the first send of any asset still pays the upload.

**B. Pre-upload at survey authoring/publish time.**
Resolve media when a survey is created or published rather than at send.
Removes all latency from the send path. Costs: needs to know the target
account(s) at authoring time — which the current model does not guarantee,
since a survey resolves under *any* of its owner's account ids — and needs a
refresh path for the 30-day expiry.

**C. Delivery-confirmation serialization.**
Hold the next message in a batch until the prior one's `sent` status webhook
arrives. Directly targets ordering rather than its proximate cause, and is
platform-agnostic. Costs: cross-message state in message-worker, meaningful
added latency per message, and a timeout policy for statuses that never arrive.

**D. Inter-message delay within a batch.**
Cheap mitigation; narrows the window without guaranteeing anything. Possibly
acceptable as a stopgap, poor as an endpoint.

**E. Host media on a fast origin.**
Move assets off imgur. Reduces fetch latency and therefore the reorder window.
Does not guarantee ordering and does not address arbitrary author-supplied
URLs.

**F. Accept it, and constrain survey authoring.**
Advise against media-immediately-before-question openings. Zero engineering
cost, pushes the problem onto researchers, and is unenforceable.

**G. Extend the dashboard media page to WhatsApp accounts.**
Worth doing independently so researchers can upload assets against a number as
they do against a page — but note 4.3: on its own it does not fix this bug.

---

## 7. Open questions

These should be answered before committing to a design.

1. **Is fetch latency actually the cause?** Cheapest discriminating tests: re-run
   with a fast-CDN asset and see whether ordering holds; inspect the `sent`
   status webhooks for both messages and compare Meta-side timestamps.
2. **Does Meta guarantee ordering at all** for sequential sends to one
   recipient on one number? If not, options A/B/D/E are all mitigations rather
   than fixes, and only C is sound. This is the single highest-value question
   and should be settled first.
3. **What does Meta return for an expired or invalid media id?** A
   distinguishable error code makes self-healing clean; anything vaguer makes
   it guesswork and pushes toward proactive refresh.
4. **Where should cached ids live?** Reuse `chatroach.media` (already keyed by
   `account_id`, but built as a dashboard-owned table and currently
   INSERT/SELECT-only for `chatroach`), or a separate cache owned by
   message-worker? Note the grants in `10-media.sql` if reusing it.
5. **Does the Messenger path have the same latent issue** when a survey uses a
   raw URL rather than an uploaded `attachment_id`? If so the fix may belong
   above the platform split rather than inside the WhatsApp translator.
6. **What about video, audio and documents?** Larger assets mean longer fetches
   and presumably a wider reorder window. Any test matrix should cover more
   than images.
7. **How does this interact with `emitWhatsAppEcho`?** The state machine
   advances off emitted echoes rather than real delivery; it is not established
   whether echo emission ordering is affected or relevant here.

---

## 8. Related

- `documentation/platform-abstraction.md` — account keying, translator dispatch,
  the WhatsApp implementation status table. **Note:** §6's claim that unmatched
  plain text receives no reply was observed to be false in this same test — a
  default-form path replied. Unrelated to this issue, but that section needs
  correcting.
- `documentation/whatsapp-onboarding.md` — Track A setup and environment status.
- `planning/media-upload-plan.md`, `planning/media-upload-findings.md` — the
  original (Messenger-only) dashboard media feature.
- `message-worker/translator_whatsapp.go` — `translateWhatsAppMedia`.
- `message-worker/translator.go:352` — the Messenger `attachment_id` branch.
- `devops/migrations/10-media.sql`, `22-account-id-rename.sql`.
