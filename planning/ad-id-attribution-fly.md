# Ad-id attribution — fly side

Branch: `feature/ad-id-attribution`. Worktree: `../fly-ad-id-attribution`.

Companion planning notes from the test passes:
`ad-id-attribution-replybot-tests.md`, `ad-id-attribution-qa-findings.md`.
The durable documentation lives in
`documentation/referral-form-resolution.md` § "Ad identity (`md.ad_id`)" and
`replybot/README.md`; this file records *why*, and what was left undone.

## The shape of the work

vlab is moving off the dotted stratum string
(`creative.Static English.Age.Age.State.Bauchi.form.mnchweek`) that currently
rides in the referral and gets dot-parsed into `state.md`. It will key
attribution on an opaque **ad id**, own the `(network, ad_id) -> stratum`
mapping itself, and join at analysis time.

Fly's whole role is to **capture and expose one opaque identifier**. Everything
here is additive:

- the legacy dotted-ref parsing is untouched and stays permanently — existing
  Messenger studies depend on it and will never migrate;
- nothing is gated, deprecated, or refactored;
- no migration is introduced.

## The empirical question, and how it was settled

The brief flagged a contradiction: `documentation/referral-form-resolution.md`
showed a WhatsApp referral with `"source": "ads"` (singular key, plural value),
while a live Meta probe returned a key set containing `source_type`.

**Settled: it is `source_type`, with the value `"ad"`.** Evidence:

1. A real production CTWA arrival pulled from `chatroach.messages`
   (2026-08-16 18:21 UTC, `phone_number_id` 1203867182815254) carrying
   `"source_type":"ad"`, `"source_id":"120254866237980150"`, plus `source_url`,
   `headline`, `body`, `media_type`, `image_url`, `ctwa_clid`,
   `welcome_message` — **and no `ref`** (the form came from the autofill text
   `ctwaprobe.alpha.creative.Ad1H.form.probetest`).
2. Two independent test fixtures already in the repo
   (`event-normalizer.test.js`, `machine.test.js`) use `source_type: 'ad'`.
3. `"source": "ads"` appears **only** in prose — this document's predecessor and
   `replybot/README.md`. No production payload, hermes type, or fixture has ever
   carried it. It looks like a transcription of *Messenger's* referral `source`
   field (`"ADS"`, `"SHORTLINK"`), a different platform's different field.

Both docs have been corrected.

Because the historical record could not be exhaustively swept — `messages` is
106M rows and a `LIKE` scan over it exhausted the DB connection — the gate
**accepts both spellings**. Reading a key that never arrives costs nothing;
missing one loses attribution permanently. The accepted keys and values sit in
one place (`AD_SOURCE_KEYS` / `AD_SOURCE_VALUES` in `utils.js`).

## Design decisions

**The WhatsApp gate is the whole correctness story.** `source_id` is not
ad-specific: on an organic reshare of a page post the source is a *post* and
`source_id` is a post id. Capturing it unconditionally would write post ids into
`ad_id`, where they can never match vlab's mapping and would accumulate forever
in the "unmapped" bucket that exists to surface real bugs — silently, because
the conversation otherwise proceeds normally. A post-sourced arrival is an
organic entrant and gets no `ad_id`. When in doubt the gate captures *nothing*.

**Messenger needs no gate.** `referral.ad_id` is an ad id by definition and
Messenger only populates it for ad-sourced referrals.

**Fly owns the key outright, including the negative case.** `_group` parses the
ref *before* the synthetic keys are stamped, so a ref token literally named
`ad_id` would otherwise land in `md.ad_id`. `getMetadata` deletes it and then
sets only what it actually resolved. The alternative — letting a ref token
survive when fly resolves nothing — was rejected: this column feeds vlab's join,
so a study author who could write into it would pollute the very bucket the gate
protects.

**Query-level projection, not a computed column.** `responses.clusterid` is a
`STORED` generated column, which was the obvious precedent. Rejected:
`responses.metadata->>'ad_id' AS ad_id` needs no migration, works retroactively
on every existing row, and avoids a backfill on a very large production table.

**The export column is always-on, not opt-in.** The exporter's `add_metadata`
mechanism is already generic — a researcher *could* type `ad_id` into the
free-text "Metadata to add as columns" box today. But the export is the manual
join path for people working in R or Stata, and a join key you have to know to
ask for is a join key most exports will ship without. Hence
`ALWAYS_EXPORTED_METADATA`. Consequence: every responses export is one column
wider than before (the five shape assertions in `test_exporter.py` were bumped
accordingly).

## Deliberately deferred

- **`ctwa_clid` is not stamped.** Considered and deferred to a separate stream:
  it is per-click rather than per-ad and belongs to Conversions API attribution,
  a different concern. Leaving it out keeps this diff reviewable. It remains
  preserved on the raw event.
- **No `ad_network` key.** `md.platform` already holds `messenger`/`whatsapp`;
  vlab derives the network from it.
- **No testcontainers end-to-end run.** The chain is covered in segments (raw
  webhook → `state.md` in `machine.test.js`; `metadata` → SQL column against a
  real DB in `response.test.js`; metadata → CSV in the exporter tests). The
  remaining link, `state.md` → `responses.metadata`, is existing unchanged
  plumbing. Booting the full stack was judged not worth the cost and contention
  with ~20 concurrent worktrees.
- **The exporter is still not in the testcontainers stack.** The
  `feature/exporter-integration-tests` branch turns out to contain a *verified
  plan* (`planning/exporter-integration-tests-HANDOFF.md`) plus two unrelated
  bug fixes — the harness itself is unimplemented. Nothing existed to extend.

## Pre-existing bug found, not fixed

`format_data(pd.DataFrame([]), ...)` — a zero-response survey — raises
`KeyError: 'surveyid'` inside `vlab_prepro`'s `add_form_data` merge, long before
the `ad_id` step is reached. Verified to fail identically without this change. A
fix exists on the unmerged `feature/exporter-integration-tests` branch (commit
`07ff6c4e`). Captured as a `strict=True` xfail in `test_exporter.py` so the gap
stays visible and flips to XPASS the moment that fix lands.

## Follow-up: percent-encoded metadata in the WhatsApp entry gate

vlab's ad metadata values contain spaces (`Static English - Girls`,
`Bauchi State`). On CTWA there is no advertiser-settable `ref`, so those values
reach fly through the ad's autofill message text — which `WHATSAPP_ENTRY_REF`
rejected, because `%` was not in its character class. The arrival fell through
to `FALLBACK_FORM`: the VIR-19 shape again. Decoding already worked
(`_group(pairs.map(...))`); only the gate was wrong.

Final pattern (`replybot/lib/event-normalizer.js`):

```
/^(?:start\s+)?form\.((?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+(?:\.(?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+)*)$/i
```

Still anchored and full-match — widening the alphabet must not weaken the
property that stops a mid-survey free-text answer from re-triggering entry.
Both alternation branches are disjoint (`%` is not in the class) and tokens are
split by a literal `.` neither branch can produce, so matching is unambiguous
and linear: no ReDoS exposure.

**Why well-formed escapes only, never a bare `%`:** `%zz`, a trailing `%`, and a
truncated `%2` all make `decodeURIComponent` throw; `getMetadata` swallows the
throw and falls to `FALLBACK_FORM`, reintroducing the bug in a subtler form.

**Why that alone was not enough.** Syntactic well-formedness is *necessary but
not sufficient*: `%FF`, `%C3`, `%80` and `%E2%82` are all valid `%XX` octets
that still throw, because they are not valid UTF-8. UTF-8 well-formedness is not
practically expressible as a regex, so the residual is absorbed in
`getMetadata`, which now decodes **per token** through `_decodeToken` and keeps
an undecodable token verbatim. One malformed targeting value can no longer
discard the entire `md` — `form` included — and cost a user their survey; the
bad value lands as raw `%FF`, visible and debuggable. This also closes the
identical, pre-existing exposure on the Messenger `m.me?ref=` path, where a
single bad escape currently nukes the whole conversation into `FALLBACK_FORM`.

**Interop gap for the vlab side:** Python's `quote()` never encodes `.`, `-`,
`_` or `~`. A `.` inside a value corrupts the pair structure (it reads as a
separator), and `~` is outside the gate's alphabet so the match fails outright.
vlab must encode or strip both when building refs.

**The mirrored copy of this pattern in vlab's tests is now stale** and must be
re-synced to the pattern above.

## Note for whoever picks this up

`replybot/lib/typewheels/events.test.js` is a **fixtures module**, not a test
suite, despite the filename, and its events are already normalized. Anything
that must exercise referral handling has to build a raw webhook and run it
through `parseEvent`, or it silently skips normalization and proves less than it
appears to.
