# Template send failures: an error tag, a dean retry, a Monitor finding

**Status:** design, not built. Resolves §4.1 of
`planning/whatsapp-templates-cross-platform.md`, which asked what should happen
at send time when a `utility_message` field's template is missing or unapproved
on the target account.

**Decision taken (2026-08-09):** fail loudly with an `error_tag`, let dean retry
it, and surface it to the researcher in the Monitor tab. The other two options
in §4.1 — silently skipping the field, and falling back to a free-form send
inside the 24-hour window — are rejected: skipping corrupts the survey record,
and the fallback only works inside a window that, by definition, has usually
closed by the time a template send is attempted.

---

## 1. What actually happens today — worse than "the conversation stalls"

§4.1 said Meta errors, message-worker burns its retries, and the conversation
stalls. Tracing it end to end, the participant does not stall. They are
**terminally blocked, in a state dean structurally cannot reach, and counted as
attrition.**

| Step | Behaviour | Evidence |
|---|---|---|
| Send | Meta rejects the template send | — |
| Worker retry | 3 attempts over 100→200→400ms — useless against an approval-latency problem measured in minutes-to-hours | `message-worker/config.go:79` |
| Tag | every `*PlatformError` → `tag = "FB"`, `code = platformErr.StatusCode` | `message-worker/worker.go:379-385` |
| …and `StatusCode` is **Meta's error code**, not the HTTP status, whenever the body parses | so the discriminator we need is already on the wire | `whatsapp_client.go:110-134` |
| State | `tag === 'FB'` → **`BLOCKED`**, which is terminal | `replybot/lib/typewheels/machine.js:329` |
| Dean | escapes `BLOCKED` only via `fb_error_code = ANY($1)`, where `$1` = `2022,613,-1,190,80006,551`. Messenger's `100` and every WhatsApp `132xxx` are absent → **never retried** | `dean/queries.go:142`, `devops/values/production.yaml:190-191` |
| Monitor | Messenger `100` → `template_missing`; WhatsApp `132xxx` → falls through to `other`. Both sit under `BLOCKED`, the surface that reads as *the user blocked us* | `dashboard-server/queries/states/states.queries.js:217-225` |

Three distinct defects, not one:

1. **Wrong terminal state.** A researcher's un-created template parks the
   participant in `BLOCKED` — the bucket meaning "this person walked away."
2. **Unreachable by retry.** `BLOCKED` is escapable only by `fb_error_code`
   membership, and no template code is a member. This is precisely the failure
   shape `planning/message-worker-provider-error-tagging.md` documents for the
   131 participants stranded in July.
3. **WhatsApp is not in the taxonomy at all.** `template_missing` exists but
   matches only Messenger's `100`. The `132xxx` family is unclassified.

> The irony worth recording: the taxonomy already has a `template_missing`
> category (`states.queries.js:218`). It was defined for Messenger and never
> wired to a retry, so it names the problem without doing anything about it.

---

## 2. Why retry is the right instinct here

WhatsApp review is **a real review taking minutes to hours**
(`documentation/whatsapp-templates.md`), unlike Messenger's usually-instant
auto-approval. So the single most likely template failure — a template
submitted, still `PENDING`, sent against too early — is *self-healing on a
delayed retry*. `DEAN_ERROR_INTERVAL` is `48 hours` with
`DEAN_RETRY_MAX_ATTEMPTS = 60`, which spans that comfortably.

That is the case for routing to `ERROR` rather than `BLOCKED`: not because the
error is transient in general, but because its most common cause resolves on
its own within the existing retry window.

---

## 3. The one real decision: one tag or two

`devops/values/production.yaml:170-186` carries a hard-won warning. When
`FIELD_NOT_FOUND` was made retryable, it burned all 60 attempts per state
forever, because the error was usually permanent. The comment says plainly: do
not re-add it as a standing entry.

Template failures split the same way:

| Meta code | Meaning | Heals on retry? |
|---|---|---|
| WhatsApp `132001` | template does not exist / wrong name or language | **Yes** — once created and approved |
| (pending approval) | submitted, not yet APPROVED | **Yes** — this is the common case |
| WhatsApp `132015` / `132016` | paused / disabled by Meta | No — needs researcher action |
| WhatsApp `132000` / `132012` | parameter count or format mismatch | **No** — a shape mismatch retrying cannot fix |
| Messenger `100` | template not found on the page | Yes |

`132000`/`132012` are exactly the permanent class the dean comment warns about
— and exactly what §2 of the cross-platform doc predicts when a name's
registrations disagree in shape across accounts.

**Recommendation: two tags.**

- `TEMPLATE_MISSING` → `ERROR`, **in** `DEAN_ERROR_TAGS`. Not yet approved, or
  not created on this account.
- `TEMPLATE_INVALID` → `ERROR`, **not** retried. Shape mismatch, paused,
  disabled. Visible to the researcher, but never burning 60 attempts against a
  fault no retry can clear.

Both route to `ERROR`, so both leave `BLOCKED` honest. The cost is carrying two
new values through a taxonomy that is hand-maintained in six places (§5).

One tag is cheaper and defensible if we accept 60 bounded retries over 48h for
the permanent subclass. It is the wrong trade only because we have already paid
for that lesson once.

---

## 4. The change, by component

1. **message-worker** — `reportError` (`worker.go:376`) classifies by Meta code
   before falling back to `FB`. **This collides with
   `planning/message-worker-provider-error-tagging.md`**, which rewrites the same
   ~15-line switch and is written but unimplemented (`worker.go:379` is still
   the old `if IsPlatformError(err) { tag = "FB" }`). Land them together; doing
   them separately means writing the same switch twice and reconciling.
2. **replybot** — no change. `machine.js:333` already routes any non-`FB` tagged
   error to `ERROR`.
3. **dean** — no code change. Add `TEMPLATE_MISSING` to `DEAN_ERROR_TAGS` in
   `devops/values/{staging,production}.yaml`.
4. **Monitor** — a finding keyed on the new tags, plus WhatsApp's `132xxx` in
   the `fb_error_code` CASE so the category stops being `other`.
5. **Docs** — `documentation/study-error-alerting.md` (taxonomy contract),
   `documentation/error-events.md` (producer list), `message-worker/README.md`.

---

## 5. Costs and traps, stated up front

- **Six sites, four languages.** `study-error-alerting.md:226-233` inventories
  every place the classification is hand-copied: two SQL `CASE`s, two JS arrays,
  and PromQL matchers repeated 3×. Nothing fails loudly when one is missed.
  `planning/error-ontology-design.md` exists because of this; this change adds
  to the debt it describes rather than paying it down.
- **The Redis cache trap.** `production.yaml:179-185`: adding a tag to
  `DEAN_ERROR_TAGS` *alone did nothing* for FIELD_NOT_FOUND, because replybot
  serves state from a Redis cache and only replays the log on a miss, with
  `updateState()` refreshing a 24h TTL on every event. A sweep of 40
  participants recovered zero. **Needs verifying for this case** — the FB
  precedent was a *corrupt state* re-read from cache, whereas a template failure
  leaves the state sound and only the external send failed, so the retry should
  re-issue a fresh send. Do not assume; confirm before relying on the retry.
- **Meta codes are unverified.** Per §5 of the cross-platform doc, no part of
  the WhatsApp template path has ever run against real Meta. Every `132xxx`
  mapping above is from documentation, not observation.

---

## 6. Sequence

1. Confirm the Meta codes against a real failed template send (needs §1 of the
   cross-platform doc's untested surface to be exercised first).
2. Land the message-worker classification together with the provider-error
   tagging fix, on `staging`, with table-driven tests.
3. Values change + soak in `vstag`.
4. Monitor finding + taxonomy sites.
5. Docs.

Steps 2-5 are blocked on nothing; step 1 gates confidence in the code mapping,
not the design.

---

## 7. Related

- `planning/whatsapp-templates-cross-platform.md` — §4.1, the question this answers
- `planning/message-worker-provider-error-tagging.md` — the colliding, unimplemented change
- `planning/error-ontology-design.md` — why the six-site taxonomy is the real problem
- `planning/null-fb-error-code-findings.md` — the 131 stranded participants
- `documentation/study-error-alerting.md` — taxonomy contract and consumer inventory
- `documentation/error-events.md` — how errors are recorded
