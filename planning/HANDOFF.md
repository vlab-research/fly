# Platform Abstraction v2 — Handoff (START HERE)

**Branch:** `feature/platform-abstraction-v2`
**Worktree:** `/home/nandan/Documents/vlab-research/fly-platform-abstraction-v2`
**Date:** 2026-07-18 (updated same day, session 3)
**Status:** facebot integration **26 / 26 passing** (full-suite verification run green). The 2 remaining failures
were root-caused and fixed (§4-A/B), plus one load-flaky test stabilized (§4-D). Unit suites: replybot **326/0**
(was 298 — see §4-C, 28 tests were silently skipped), message-worker go tests pass, dinersclub fake-provider
tests pass. stack.ts instrumentation stripped (§5 done). All changes are **uncommitted** on the branch —
commit series planned in §5, awaiting owner go-ahead. Next: staging deploy (§6.3), then WhatsApp P0 (§6.4).

Read this first, then `planning/REBUILD-CHECKPOINT.md` (background + earlier history). This doc supersedes it for current state.

---

## 1. The one principle that makes everything make sense

The facebot test computes each **expected** message by running `@vlab-research/translate-typeform`'s `translator`
(`facebot/testrunner/node_modules/@vlab-research/translate-typeform/translate-fields.js`, invoked via `getFields()` in `mox.ts`).
That library is **the same one main/prod uses** to build Messenger payloads. So the definition of "correct" is:

> **v2's replybot generic-translator + message-worker translator must reproduce translate-typeform's per-field-type output exactly** (comparison is canonicalized for JSON key order).

This is data-continuous with prod. When translate-typeform, the replybot logic engine (`form.js`), and the owner-confirmed
decisions all agree, we change v2 to match — we do **not** relax tests to fit a v2 quirk.
(Owner has confirmed this framing, with the caveat: always sanity-check the *goal*, don't cargo-cult the spec.)

Field → Messenger rendering per the spec:
- short_text/long_text/number/date/**email/phone_number**/upload/wait/stitch → plain `{text}` (NO quick reply)
- multiple_choice/dropdown/yes_no/legal/welcome_screen → `quick_replies`, payload `{"value":<label>,"ref":<fieldRef>}`
- opinion_scale/rating → `steps` numeric quick replies `[start .. start+steps-1]` (start=1 unless `start_at_one:false`→0)
- webview → button template (`web_url`, `webview_height_ratio:"full"`, `messenger_extensions` default true)
- notify → `one_time_notif_req`; notification_messages → `notification_messages`; thankyou_screen → **first line of title only**
- button_choice → button/postback (≤3); picture_choice → generic carousel; share → element_share button
  — **NOT yet implemented in v2**; add only if a test needs them.

---

## 2. How to verify (commands)

```bash
cd /home/nandan/Documents/vlab-research/fly-platform-abstraction-v2

# Unit (fast)
cd replybot && npm test                       # expect 298 passing / 0 failing
cd ../message-worker && go build ./... && go test ./...   # expect pass
cd ../facebot/testrunner && npm run build     # tsc, expect clean

# Integration (heavy: ~7-13 min, boots full stack; rebuilds changed images)
cd facebot/testrunner
npm run test:tc > /tmp/run.log 2>&1           # runs ALL 26 tests in ONE parallel stack boot
# single test:  npm run test:tc -- --grep "notify token"
```

**HARD GUARDRAILS (unchanged, do NOT violate):** never `docker system prune` / `rm` / `pkill` / `kill`. facebot
testcontainers runs are resource-heavy. If a run stalls on disk/CPU, STOP and ask the owner — do not remediate.
Disk has been ~83% (73G free) and runs have completed fine; watch for `no space`/`ENOSPC` in the log.

---

## 3. What changed this session (all business-logic changes, with rationale)

Two systemic bugs + shape-fidelity fixes. `git diff --stat` on the branch shows the full set. **Nothing is committed yet.**

### Systemic bug A — choice-answer rejection (the linchpin) — `replybot/lib/generic-validator.js`
`validateQuestion` built valid answers from `c.ref || c.label` (UUID) but the translator emits the **label** and the
logic engine (`form.js getChoiceValue`) resolves choice-jumps to the **label**. Fixed → `choices.map(c => c.label)`.
Confirmed on the running stack (`response="Foodafone" validValues=[uuid] valid=false` → after fix `valid=true`).

### Systemic bug B — synthetic-event crash (cause of the timeout cascade) — `event-normalizer.js` + `transition.js`
`parseSyntheticEvent` returned `source:{type:'synthetic'}` with **no `account_id`** → `transition.js` called
`getForm(undefined,…)` → TypeError → state ERROR right after a flow advanced (payment/bailout/external/timeout flows).
Fix: normalizer carries `account_id` from event `page`; `transition.js` falls back `page = source.account_id || state.md.pageid`;
synthetic `platform` maps to `state.md.platform || 'messenger'` (message-worker rejects `platform:'synthetic'`).
**TODO(whatsapp):** persist `md.platform` at conversation start so the synthetic platform is exact, not defaulted.

### Shape fixes (match translate-typeform)
- **Messenger templates** — `message-worker/translator.go` + `types/messenger.go`: added `translateMessengerWebview`
  (button/web_url), `translateMessengerNotify` (one_time_notif_req), `translateMessengerNotificationMessages`,
  dispatched by `metadata.type` inside the text case. `Attachment.Payload` is now `interface{}` (holds media
  `AttachmentPayload` OR new `TemplatePayload`). Added 3 Go unit tests. No reader touched `.Payload`'s concrete
  fields, so media JSON is unchanged.
- **email → plain text** — `translateMessengerText`: removed the `user_email` quick-reply. **Owner-confirmed** (consistent
  with the phone plain-text decision). Updated the Go unit test that asserted the old shape.
- **opinion_scale/rating** — `generic-translator.js` + `generic-validator.js`: exactly `steps` numeric options
  `[start..start+steps-1]`, no spurious `steps` metadata key, rating uses numeric labels (was `"N stars"`). Translator
  and validator share one helper so they cannot drift.
- **thankyou_screen** — `generic-translator.js translateStatement`: `title.split('\n')[0]` (drops the Typeform
  "Now create your own…" boilerplate line).
- **phone validation** — `generic-validator.js validatePhone`: now uses the `phone` package (rejects `"23345"`, accepts
  `"+918888000000"` and extracts from `"+918888000000 use this"`). Was `typeof r==='string' && r.length>0` (too lenient).
- **error details restored** — `transition.js` catch: spreads `...e.details` (e.g. `status:404` for FORM_NOT_FOUND),
  matching **main** (v2 had dropped it). The error report is fed back as a `synthetic_machine_report` event →
  `MACHINE_REPORT` → ERROR state.

### Docs updated
- `message-worker/README.md` — Messenger translation table now includes the template dispatch.
- `planning/REBUILD-CHECKPOINT.md` — session-2 progress section.

### Regression safety
replybot stayed 298/0 throughout; go tests green; integration moved monotonically 0→1→12→22→24 with no
previously-passing test regressing. Verified the risky ones by hand: phone strictness against BOTH the reject case
(test 6) and the messy-input normalize case (test 13); `interface{}` change against all media/whatsapp/instagram Go tests.

---

## 4. The 2 remaining failures — RESOLVED (session 3). Actual root causes below.

Both prior triages were partly wrong; the fixes were confirmed by observing the running stack
(`--grep "notify token|E\.164"` run: both pass).

### 4-A. Test 13 — phoneE164 — FIXED in **dinersclub** (owner-approved product change)
- The prior triage was wrong: the END state **does** land in the `states` table and `waitFor('END')` succeeds
  (scribble flushes partial batches after `KAFKA_POLL_TIMEOUT` — see `spine` `consumeStream`, which breaks on
  ReadMessage timeout and processes what it has). The `TypeError … (reading 'should')` was
  `md.e_payment_fake_phone` being `undefined`, not a missing row.
- **Root cause:** the form's fake-payment `result` echoes `"phone": "{{field:ref_num|e164}}"`, but dinersclub's
  shared `Result` struct (`provider.go`) had no `phone` field → silently dropped at unmarshal → never reached the
  synthetic external event → never flattened into `md.e_payment_fake_phone`. Same on main ⇒ why it "fails on prod".
- **Fix:** `Phone *string \`json:"phone,omitempty"\`` on `Result` + unit test
  (`TestFakeProviderPayoutEchoesPhoneInResult`). No test/form changes. Owner chose this over a
  `payment_details` passthrough or relaxing the test.

### 4-B. Test 21 — notify/OTN — FIXED in **replybot** (two v2 bugs, both masked by a wrong unit fixture)
- The stall was **before** the dean trigger (post-optin report: `commands: []`, no token stored, user stuck at QOUT
  → the 2nd flowMaster never received fields[1]).
- **Bug 1 — machine.js OPTIN:** checked `nxt.payload.type !== 'one_time_notif_req'`, but the normalizer emits
  `payload.type:'optin'` with the Messenger subtype in `payload.optin_type` → every optin no-op'd, token never
  stored. Fix: check `payload.optin_type`.
- **Bug 2 — event-normalizer optin payload:** Messenger sends `optin.payload` as a JSON **string**
  (`'{ "ref": … }'`), but `validateNotify` matches `r.ref` against the field ref → optin was rejected as an
  invalid answer ("please use the buttons" repeat). Fix: normalizer parses it via `parsePayload`, same as
  quick_reply/postback.
- **Fixture fix:** `events.test.js` `optin` fixture had `payload.type:'one_time_notif_req'` + object payload —
  i.e. the shape the buggy code expected, not what the normalizer emits. Fixed to the real shape; added a
  normalizer unit test for the optin shape. Downstream (tokenWrap → `_response` token → `buildCommands`
  `platform_context` → message-worker `recipient:{one_time_notif_token}`) was already correct.

### 4-C. Bonus find — 28 unit tests were silently skipped
`replybot` `npm test` used an **unquoted** `lib/**/*.test.js` glob — `sh` expands `**` one level deep only, so
top-level `lib/event-normalizer.test.js` and `lib/generic-translator.test.js` never ran (that's how the wrong
fixture survived). Fixed by quoting the glob so mocha expands it: suite is now **326 passing / 0 failing**.

### 4-D. Flaky under load — "Sends follow ups when the user does not respond" (test-only fix)
In the first full 26-test run this failed with dean logging "sent **0** new events": the test waited for *any*
`states` row before the one-shot `triggerDean('followups')`, but dean's followups query only matches
`current_state = 'QOUT'` (`dean/queries.go` `FollowUps`) — if the trigger beats scribble's QOUT upsert there is
no second chance. Passes solo on the same code (race confirmed). Fix: the test now waits for
`current_state === 'QOUT'` before triggering, mirroring dean's predicate (same pattern as the
WAIT_EXTERNAL_EVENT waits). No product change.

---

## 5. Before committing (cleanup)

**DONE (session 3):** the two `.withLogConsumer(...)` blocks in `facebot/testrunner/stack.ts` are removed;
testrunner `npm run build` clean. (Code-level DEBUG logs were already removed in session 2.)

Untracked scratch to ignore/clean: `facebot/testrunner/forms/temp.json`, `temp-j1sp7ffL.json`, `dist/`, `go.work.sum`.

Suggested commits (small, story-telling): (1) linchpin validator, (2) synthetic-event page/platform,
(3) shape fixes: email/opinion/rating/thankyou/phone, (4) message-worker templates, (5) transition error details,
(6) replybot OPTIN subtype + optin payload parsing + fixture (§4-B), (7) replybot test glob fix (§4-C),
(8) dinersclub Result.phone (§4-A), (9) docs (READMEs + this handoff). End messages with the
`Co-Authored-By: Claude Opus 4.8 (1M context)` trailer. Only commit/push when the owner asks.

---

## 6. Remaining roadmap (order)

1. ~~Debug tests 13 & 21 to green~~ **DONE** (§4) — full 26-test verification run green (26/26).
2. ~~Strip stack.ts instrumentation~~ **DONE**; commit (§5) — awaiting owner go-ahead.
3. **-wa staging deploy** — see `documentation/staging-tagging-and-deploy.md`; re-test on staging. (Note: staging has
   had exactly one two-message attempt ever; it is NOT a validated baseline.)
4. **WhatsApp P0** (see `documentation/platform-abstraction.md`): real WhatsApp API client (replace stub), WhatsApp
   token store by phone_number_id, botserver WhatsApp webhook, WhatsApp event normalization. Also do the
   `md.platform` persistence TODO from §3-B here.

---

## 7. Open decisions for the owner
- ~~Tests 13 & 21~~ resolved (§4): owner approved the dinersclub `Result.phone` change for 13; 21 was a pure v2 bug.
- Next decision point: when to commit (§5 list) and proceed to staging deploy (§6.3).
