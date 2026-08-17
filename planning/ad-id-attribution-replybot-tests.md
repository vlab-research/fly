# md.ad_id — replybot test coverage (QA pass)

Scope: **tests only**, in the `fly-ad-id-attribution` worktree. `replybot/lib/typewheels/utils.js`
(the `adIdFromReferral` resolver + `getMetadata` stamping) was already implemented by another
agent before this pass and was **not modified** here. See the "Ad identity" block comment at the
top of `utils.js` and `documentation/referral-form-resolution.md` § "Ad identity (`md.ad_id`)" for
the full behavior spec this test suite pins down.

## How to run

```
cd replybot
source ~/.nvm/nvm.sh && nvm use   # node 22, .nvmrc
npm test                          # nyc + mocha, full suite
```

Full suite: **482 passing, 1 pending** (pre-existing `xit` in `utils.test.js`'s `hash` describe —
unrelated, untouched), **0 failing**. Each of the three edited files also passes standalone
(`npx mocha lib/typewheels/utils.test.js`, etc.) — see fix note below on why that mattered.

## Files changed

### 1. `replybot/lib/typewheels/utils.test.js` — extended
New `describe('adIdFromReferral', ...)` block, 12 tests, unit-testing the pure resolver in
isolation:
- `messenger: reads referral.ad_id directly, no gate`
- `messenger: no ad_id on the referral -> undefined`
- `messenger: null/undefined referral -> undefined, does not throw`
- `whatsapp: source_type "ad" gates source_id through`
- `whatsapp: source_type "post" must NOT resolve an ad_id` — the regression that matters most
- `whatsapp: source_id with no source_type at all -> undefined`
- `whatsapp: source_type "ad" but no source_id -> undefined`
- `whatsapp: legacy spelling source: "ads" also gates through`
- `whatsapp: source_type/id are trimmed and case-insensitive`
- `whatsapp: whitespace-only source_id is the same as absent -> undefined`
- `normalizes a numeric id to its string form`
- `whatsapp: messenger-shaped referral (ad_id field) resolves nothing` (cross-platform guard)

Also fixed a **latent bug in the existing test file** (not part of the assigned test-writing, but
required to make the new tests pass and to make the file runnable standalone) — see "Bug/fix
found" below.

### 2. `replybot/lib/event-normalizer.test.js` — extended
Two small normalizer-boundary pins (deliberately not duplicating the exhaustive gate-logic
coverage in `utils.test.js`):
- `parseMessengerEvent`: `preserves referral.ad_id through to payload.referral untouched`
- `categorizeWhatsAppEvent` (inside the existing CTWA describe block): `preserves source_type,
  the field the ad-sourcing gate reads`

### 3. `replybot/lib/typewheels/machine.test.js` — extended (the important one)
New `describe('md.ad_id — ad attribution identity captured from the referral', ...)`, appended
after the existing `WhatsApp CTWA ad entry resolves the form...` block. All 9 tests drive a
**raw webhook object** through the real `parseEvent` (event-normalizer) into `getState`, matching
the file's existing pattern for this class of regression (see the `Referral delivered inside a
quick_reply payload string` and `WhatsApp CTWA...` blocks it was modeled on) — not the
pre-normalized fixtures in `events.test.js`, which would bypass the normalizer entirely.

1. `messenger: referral.ad_id lands on state.md.ad_id, and state.md.form still resolves as before`
2. `messenger: an older referral with no ad_id field leaves state.md.ad_id entirely absent`
   (asserts `.should.not.have.property('ad_id')`, not just falsiness)
3. `whatsapp: CTWA source_type "ad" + source_id lands on state.md.ad_id` — real production CTWA
   referral shape (source_url, source_id, source_type, headline, body, media_type, ctwa_clid),
   form recovered from the autofill `text.body`
4. `whatsapp: source_type "post" must NOT produce an ad_id` — **the regression that matters
   most**: a post reshare carries the identical `source_id` shape as a CTWA ad click;
   `source_type` is the only signal that tells them apart, and a weakened gate would pollute
   vlab's unmapped `(network, ad_id)` bucket forever, silently
5. `whatsapp: a referral with no source fields at all resolves no ad_id, form still resolves`
6. `whatsapp: bare-text wa.me entry (no referral object at all) has no ad_id`
7. `messenger: a ref token literally named ad_id never wins over the real ad_id field` — ref
   `form.hpvintrotriple.ad_id.injected` alongside a real `ad_id` field; fly's value wins
8. `messenger: a ref token named ad_id with NO real ad_id field leaves ad_id absent, not
   "injected"` — same collision, but nothing to resolve, so the key must be deleted, not left
   as the injected ref token
9. `ad_id is stamped once at conversation_started and survives a later user reply` — two-event
   `getState([rawCtwaAdArrival, rawReply].map(parseEvent))`, proving persistence rather than
   re-derivation per event

## Bug / fix found (test-infrastructure only, not production code)

`replybot/lib/typewheels/utils.test.js` never imported chai itself — it relied entirely on
`Object.prototype.should` having already been installed as a side effect of some *other* test
file (e.g. `machine.test.js`, which does `const should = chai.should()`) running first when the
whole suite loads via `mocha 'lib/**/*.test.js'`. That happened to work for every existing test in
the file because they all use the `.should` prototype-extension style
(`u.getForm(referral).should.equal('FOO')`), which only needs the global side effect, not a local
`should` binding.

My new tests needed `should.equal(actual, undefined)` (the standard way to assert strict
`undefined`, since `undefined.should` throws) and `should.not.exist(...)` in one case, both of
which need the local `should` variable chai.should()` returns — that variable was never defined
in this file. Result:
- **Run via `npm test` (full suite)**: existing sibling files had already called
  `const should = chai.should()`, which — because `chai.should()` internally does
  `global.should = should` in some code paths — happened to leave a global `should` available,
  but not necessarily in a way this file's tests were entitled to depend on; some of the new tests
  still failed cross-file-load-order-dependent.
- **Run via `npx mocha lib/typewheels/utils.test.js` alone**: every test in the file failed —
  including every pre-existing test — with `TypeError: Cannot read properties of undefined
  (reading 'equal')`, because `.should` was never installed on `Object.prototype` at all.

Fix: added `const chai = require('chai'); const should = chai.should()` to the top of
`utils.test.js`, matching the pattern already used in `machine.test.js` and
`event-normalizer.test.js`. This is a test-file-only change (no production code touched) and makes
`utils.test.js` self-contained and correct to run standalone, which it was not before. Recommend
this fix ships regardless of the rest of this pass — the file was silently depending on undocumented
load order.

## Numeric-id test note

The first draft of `normalizes a numeric id to its string form` used a 18-digit literal
(`120254866237980150`), which exceeds `Number.MAX_SAFE_INTEGER` and silently rounds when the JS
source is parsed (V8 stored it as `120254866237980144`, printed as `'120254866237980140'`) — that
would have been testing float-precision-during-source-parsing, not the `_id()` normalizer's
`String(v).trim()` behavior. Replaced with a 9-digit literal that stays inside the exact-integer
range while still proving numeric input normalizes to a string.

## No bugs found in `utils.js`

All 21 unit/integration cases specified passed against the existing implementation on the first
run (after the two fixes above, which were test-file issues, not `utils.js` issues). In
particular the two cases most likely to catch a real defect — WhatsApp `source_type: 'post'`
resolving no `ad_id`, and the `ad_id`-named ref token never winning over (or leaking as) a real
value — both passed cleanly, confirming the `delete md.ad_id` ordering and the `_isAdSourced` gate
in `utils.js` behave exactly as documented.
