# Integration & Smoke Test Improvement Plan (v2 platform-abstraction)

**Branch:** `feature/platform-abstraction-v2`
**Worktree:** `/home/nandan/Documents/vlab-research/fly-platform-abstraction-v2`
**Status:** Plan — awaiting go-ahead per workstream.

Source of this plan: a four-part parallel audit of `facebot/testrunner/test.tc.ts`
(integration), `test.ts` (k8s smoke), `smoke-test/` + `smoke-echo/` (production
smoke), the `forms/*.json` fixtures, and the replybot runtime feature surface.

## Goals (approved)

1. **Add handoff/handover + `e_handover_metadata_*` integration coverage** (highest-risk gap).
2. **Fix the metadata-presentation false positive** — test replybot's *real* runtime `{{hidden:...}}` interpolation.
3. **Consolidate the suite + clean the forms directory** (same coverage, less noise).
4. **Shrink the k8s smoke suite (`test.ts`)** from a stale 24-test clone to a true cluster smoke subset.

## Recommended sequencing

Do them in this order — earlier steps de-noise the tree so later diffs are legible:

```
WS3 (cleanup) ─► WS2 (interpolation) ─► WS1 (handoff) ─► WS4 (smoke shrink)
```

WS3 first (delete dead forms, kill temp files) shrinks the surface. WS2 is a
small, self-contained correctness fix and introduces the object-based
`getFields` helper that WS1 also wants. WS1 is the big one. WS4 last, once the
integration suite it should mirror-a-subset-of is stable.

---

## Workstream 3 — Consolidate suite + clean forms (do first)

### 3a. Delete the exact-duplicate test + empty describe
- `test.tc.ts`: **delete** `'Retries sending the message only up to a point'`
  (the `Waits` describe block, ~lines 634-659). It is byte-for-byte equivalent
  in behavior to `'Retries sending the message when it fails with a proper
  code'` (Timeouts block): same form (`LDfNCy`), same error code (`-1`), same
  `BLOCKED` / `fb_error_code='-1'` assertions.
- **Caveat:** neither test actually verifies the retry *cap* (that delivery
  stops after N attempts). The name is aspirational. Real cap coverage is folded
  into WS1-adjacent gap work later (`triggerDean(..., 'retries')`), tracked in
  the "Deferred gaps" section — do **not** silently drop the intent, just the
  duplicate body.

### 3b. Parametrize / merge near-duplicates (no coverage loss)
- **Yes/No logic jump** (`'...logic jump "Yes"'` + `'...logic jump "No"'`): both
  use `LDfNCy`, both land on fields `[3,5]`, differ only by quick-reply index →
  collapse to `[0, 1].forEach(idx => it(\`...jump idx ${idx}\`, ...))`.
- **Validation failures** (`'...validation failures'` + `'...custom validation
  error messages'`): keep #10 for the retry-on-invalid mechanic; shrink #11 to
  assert only custom-message *text* substitution (it doesn't need the full
  two-field round trip).
- **Stitched forms** (`'stitches and maintains seed'` + `'does not allow first
  form to be retaken'`): ~90% shared setup (identical farmhash userId selection,
  identical seed). Merge into one test that runs the stitch-and-continue flow,
  then attempts the re-referral, asserting both the `responses`-table state and
  the retake-block message in one pass.

Net: 26 → ~21 tests, same feature coverage.

### 3c. Delete dead form fixtures
Seeded by `seed-db.ts`'s blanket `readdirSync('forms')` glob but referenced by
**no** test in either `test.tc.ts` or `test.ts` (verified by grepping every
filename stem, `title`, and stitch-target string):

```
AMLLjB.json  jMVu4uEd.json  Yym3bbfC.json  PyJ5Dsnc.json
v5C48Byi.json  _gk3gt9ag.json  lrTauhrb.json  nXNk8SAg.json
```

~130KB of production-dump fixtures, several with dangling stitch targets
(`follow2hin`, `follow1eng`, `baselineodi`, `cvfollow5`, `baseline\_eng`). Delete
all 8.

- **Note on reloadly:** `_gk3gt9ag.json` (reloadly failure) + `lrTauhrb.json`
  (reloadly success) are the *only* reloadly-provider fixtures, and reloadly is
  never driven by a test even though `seed-db.ts` seeds reloadly credentials.
  Deleting them means reloadly stays untested. Decision needed: delete now and
  log reloadly as a deferred gap, **or** keep these two and wire up a
  reloadly-provider test mirroring the fake-provider payment tests. Default:
  delete + defer (fake-provider already covers the payment logic-jump behavior).

### 3d. Kill the committed `temp*.json` scratch files
`forms/temp.json` and `forms/temp-j1sp7ffL.json` are **runtime artifacts** —
tests #3 and #21 do `interpolate(readFileSync(...)) → writeFileSync('forms/temp*.json') → getFields(path)`.
They are currently committed with stale baked-in content (one holds a hardcoded
past-run timestamp).

Fix properly (also unblocks WS2):
1. Add an object-accepting variant to `mox.ts`:
   ```ts
   export function fieldsFromForm(form: any): Field[] {
     return form.fields.map(addCustomType).map((f: any) => translator(f).message);
   }
   export function getFields(path: string): Field[] {
     return fieldsFromForm(JSON.parse(fs.readFileSync(path, 'utf-8')));
   }
   ```
2. In tests #3/#21, interpolate into an **in-memory object** and call
   `fieldsFromForm(obj)` — no `writeFileSync`, no temp file.
3. `git rm` the two committed temp files; add `forms/temp*.json` to
   `.gitignore` as a belt-and-suspenders guard.

### 3e. (Optional) guard against future orphans
Add a tiny check (test or lint) that fails if a `forms/*.json` file is seeded but
never referenced — prevents the orphan pile from regrowing. Low priority.

**Acceptance:** `npm run test:tc` green with ~21 tests; `forms/` contains only
referenced fixtures + intentional pairs (`mzs7qmvZ` translation target is used
indirectly — keep); `git status` clean of `temp*.json`.

---

## Workstream 2 — Real runtime `{{hidden:...}}` interpolation test

**The bug being fixed:** the "payment failure" test *looks* like it covers
`{{hidden:e_payment_fake_error_message}}` interpolation, but the test's own local
`interpolate()` helper substitutes the placeholder into the form JSON **before
replybot parses it**. Replybot's runtime `interpolateField` / `getFromMetadata`
engine is never exercised for message text.

### Approach
Referral extra-segments already flow into hidden metadata — the absolute-timeout
test proves this by passing `makeReferral(userId, 'j1sp7ffL.timeout_date.<ts>')`
and consuming `{{hidden:timeout_date}}`. Reuse that mechanism for message text:

1. New minimal fixture `forms/hiddenInterp.json` (~3 fields):
   - field[0] statement titled e.g. `"Hello {{hidden:greeting_name}}, welcome!"`
   - field[1] a normal question, field[2] thankyou.
2. Test:
   ```ts
   const userId = uuid();
   await sendMessage(makeReferral(userId, 'hiddenInterp.greeting_name.Nandan'));
   await flowMaster(userId, [[ok, 'Hello Nandan, welcome!', []]]);
   ```
   The expected text is the **rendered** string — do NOT pre-substitute the
   fixture. This forces replybot's interpolation engine to run.
3. Add a second assertion for a *missing* hidden field (renders empty/blank), to
   pin the "empty placeholder" failure mode that bit the handover contract.

**Acceptance:** test fails if replybot's interpolation is disabled (verify by
temporarily breaking `interpolateField`), passes on current code.

---

## Workstream 1 — Handoff / handover integration coverage (the big one)

**Why:** zero integration coverage today; the `e_handover_metadata_*` flattening
was already broken + fixed once in production (commit `826f37fb`). It spans the
widest surface (botserver → normalizer → machine ECHO/HANDOVER → message-worker
`pass_thread_control` → return webhook → flattening → hidden-field consumption).
**It does NOT need real Facebook** — the testcontainers pipeline forwards raw
webhook JSON verbatim, so a mock handover event drives the whole replybot side.

### Confirmed mechanics (from code)
- `event-normalizer.js:167-178` maps `pass_thread_control` →
  `event_type: 'handover'`, passing `metadata` through untouched.
- `machine.js:19-52` `makeEventMetadata`: for handover, `JSON.parse`s the
  metadata string, wraps it as `{ metadata: parsed }`, merges
  `{ target_app_id: previous_owner_app_id }`, and flattens with prefix
  `e_handover` via `_eventMetadata`. So for returned metadata
  `{echo_text:'hello', smoke_echo:'ok'}`:
  - `e_handover_metadata_echo_text = 'hello'`
  - `e_handover_metadata_smoke_echo = 'ok'`
  - `e_handover_target_app_id = <previous_owner_app_id>`
- Flattening rules to assert (currently untested anywhere): keys are
  `_.snakeCase`d (camelCase → snake); a key literally named `type` is dropped at
  every nesting level (`_eventMetadata` filter); arrays flatten to `_0`/`_1`;
  nested objects recurse.

### 1a. `mox.ts` — `makeHandover` helper
```ts
export function makeHandover(
  userId: string,
  newOwnerAppId: string,       // FLY_APP_ID for the return leg
  previousOwnerAppId: string,  // the echo app's id
  metadata: Record<string, any>,
  time = Date.now(),
  pageId = PAGE_ID,
): any {
  return baseMessage(userId, {
    pass_thread_control: {
      new_owner_app_id: newOwnerAppId,
      previous_owner_app_id: previousOwnerAppId,
      metadata: JSON.stringify(metadata),   // FB delivers metadata as a JSON string
    },
  }, time, pageId);
}
```
(`baseMessage` puts it under `messaging[]` with `sender={id:userId}`,
`recipient={id:pageId}` → normalizer resolves `user_id = sender.id`. Correct.)

### 1b. Minimal handoff fixture `forms/handoffTest.json` (~4 fields)
Mirror the shape proven in `smoke-test/form-a.json`:
- field[0]: a normal question (so there's an answer → RESPOND before handoff).
- field[1]: statement whose `properties.description` is the first-class handoff
  block:
  `{"type":"handoff","handoff":{"target_app_id":"<ECHO_APP_ID>","mode":"wait","metadata":{"check":"itest"}}}`
- field[2]: statement titled e.g.
  `"Echo said: {{hidden:e_handover_metadata_echo_text}} (status {{hidden:e_handover_metadata_smoke_echo}})"`.
- field[3]: thankyou.

### 1c. The end-to-end test (respects the echo-arms-wait ordering)
Per `HANDOFF_PROTOCOL.md`, the handoff fires when the **echo** of the handoff
message arrives, not on send. Flow:
```ts
const userId = uuid();
const ECHO = '976665718578167', FLY = '<replybot app id>';
await sendMessage(makeReferral(userId, 'handoffTest'));
await flowMaster(userId, [[ok, fields[0], []]]);          // first question
await sendMessage(makeTextResponse(userId, 'hi'));
await flowMaster(userId, [[ok, fields[1], []]]);          // handoff statement sent
await sendMessage(makeEcho(fields[1], userId));           // echo arms the wait + fires HandoffCommand
// (optionally assert a pass_thread_control command reached the mock / worker)
await sendMessage(makeHandover(userId, FLY, ECHO, { echo_text: 'hi', smoke_echo: 'ok' }));
await flowMaster(userId, [[ok, 'Echo said: hi (status ok)', []]]);  // survey resumes, interpolated
```

### 1d. Flattening-contract micro-tests (unit-level, cheap, high value)
`makeEventMetadata` is exported from `machine.js`. Add focused unit tests
(replybot `*.test.js`, not testcontainers) driving it directly with:
- nested object metadata → recursive `e_handover_metadata_a_b`
- camelCase key → snake_cased
- array value → `_0` / `_1`
- key named `type` → dropped
- non-JSON string metadata → falls to the catch branch, stays under `metadata`
- **regression pin for `826f37fb`**: assert keys land at `e_handover_metadata_*`,
  NOT `e_handover_*` (one level shallower). This is the exact prod bug.

**Acceptance:** the testcontainers handoff test is green and fails if the
normalizer drops handover events or the flattening prefix regresses; the unit
micro-tests lock the flattening rules.

---

## Workstream 4 — Shrink the k8s smoke suite (`test.ts`)

**Current reality:** `test.ts` is a stale near-clone of `test.tc.ts` — 24 of 26
tests copied, missing the 2 newest (multi-part attachment, phoneE164), and one
assertion is silently wrong (`'true'` vs `'Yes'` in the stitch test). Its *only*
legitimately cluster-specific value: it exercises the **real dean CronJob** and
real service DNS/secrets, whereas `test.tc.ts` fakes dean via `triggerDean()`.

### Approach
Reduce `test.ts` to a true smoke subset (~3-4 tests) that validates
*deployment*, not *logic*:
1. One basic referral → first-question flow (DNS, botserver→replybot→worker→facebot wiring).
2. One **real-cron** dean timeout/followup (the thing testcontainers deliberately can't do).
3. One delivery-error → `BLOCKED` path (worker → FB error surfacing → scribble → DB).
4. (Optional) one stitch flow — but fix the `'true'`/`'Yes'` assertion to match
   current runtime behavior first, or drop it.

Delete the rest; they're redundant maintenance liability. Update `testing.md`
and `facebot/testrunner/README.md` to describe the smoke suite as it now *is*
(genuinely minimal) rather than the aspirational "minimal" it currently claims
while being a full clone.

**Acceptance:** `./dev.sh` runs the trimmed suite green against the dev cluster;
docs match reality.

---

## Deferred gaps (log, don't necessarily do now)

Ranked leftovers from the coverage audit, for a follow-up pass:
- **Dean `retries` query** — no test calls `triggerDean(..., 'retries')`; retry
  *cap* and backoff resend unverified (ties to WS3a's dropped duplicate).
- **User→bot MEDIA / `upload`** — `validateUpload` + machine MEDIA case unexercised.
- **Stitch `metadata:` explicit overrides** — `_stitch`'s `...stitch.metadata`
  merge path never hit (only fixture has no `metadata:` block).
- **Choice-type logic-jump conditions** (`getChoiceValue`).
- **Reloadly payment provider** (see WS3c decision).
- **WATERMARK / BLOCK_USER / UNBLOCK / RESTORE_STATE / referrer-self-loop /
  REPLYBOT_RESET_SHORTCODE** — dedicated machine branches, zero coverage.

## Cross-cutting harness cleanups (fold in opportunistically)

- Replace `snooze(2000)`/`snooze(5000)` around `triggerDean` with `waitFor`
  polling on the real condition — removes fixed dead time + flakiness
  (contradicts `testing.md`'s "no hardcoded waits" claim).
- Document the dean/`QOUT`-state race (inline comment at `test.tc.ts:569-570`)
  in `testing.md` so new followup tests don't trip it.
- Note in docs: `KEEP_STACK=1` is the real debug escape hatch (docs still say
  "comment out afterAll()"); only `Basic Functionality` uses `mocha.parallel`;
  add `mox.ts`/`responses.ts`/`utils.ts` to README's Key Files table.

## Watch-outs

- `mox.ts` intentionally still builds *expected* messages via
  `@vlab-research/translate-typeform` (old FB-native shape). This is a feature:
  it cross-checks message-worker's `TranslateToMessenger` output for
  equivalence. Do not "fix" it to use the new generic-translator.
- `documentation/platform-abstraction.md` exists only in the **main** worktree,
  not in `fly-platform-abstraction-v2`. Confirm whether it should be ported here
  before treating it as in-branch ground truth.
- Per the docs-first protocol: after WS1/WS4 land, do a dedicated doc pass on
  `documentation/testing.md` + `facebot/testrunner/README.md` (handoff coverage
  now exists; smoke suite is now genuinely minimal).
