# Message Templates Across Platforms — Intended Behaviour

**Status:** Design settled in discussion 2026-08-09; **3.1 and 3.2 built the
same day** (dashboard-client only; behaviour now documented in
`documentation/whatsapp-templates.md` § Dashboard-client). 3.3 (publish-time
preflight) is still open, as are both items in §4. Scope was narrowed before
building — editing and shape validation are out (see §3 "Explicitly not in
scope"). The WhatsApp template code itself is written and deployed but has never
been exercised — every template row in `vprod` is against a Facebook page id,
none against a WhatsApp number, so §5 still stands in full.

**Question this answers:** what a researcher does when a survey runs on both
Messenger and WhatsApp and uses a `utility_message` field.

---

## 1. Facts the design rests on

**The send path does no database lookup.** `translateWhatsAppTemplate`
(`translator_whatsapp.go:58`) and `translateMessengerUtility`
(`translator.go:215`) both read `metadata.template` and `metadata.language`
from the survey field and pass the **name** to Meta, which resolves it against
the target account — `/{page_id}` for Messenger, `/{waba_id}` for WhatsApp.
`message_templates` is a dashboard-side registry for CRUD and status only.

**So one name already works on both platforms**, with no survey-JSON change,
provided a template of that name exists and is approved on each account. The
translators absorb the API divergence: Messenger sends
`{Type: "POSTBACK", Payload: ref}` because the value was baked at approval;
WhatsApp sends the full `{"value","ref"}` per button because nothing is baked.

**A survey resolves under any of its owner's account ids.** There is no binding
of survey → account, so "which accounts must this template exist on" is "all of
this researcher's messaging accounts".

**Rejection does not burn a name.** Meta's 30-day name reservation applies only
to deleting an *approved* template — a rejected one can be deleted and
recreated under the same name immediately. So a rejection never forces a rename
on either platform, which makes the `305_misroute_recontact_en` →
`..._en2` workaround in prod avoidable. Recovering from a rejection is
deliberately **out of scope for this document**; see
`planning/whatsapp-template-editing.md`, which also corrects the assumption
this paragraph originally rested on (Messenger templates cannot be edited at
all).

---

## 2. The model

> **One name. One row per account. Independent statuses. Matching shape.
> Independent text.**

- **One name** in the survey JSON. No platform dimension in the survey
  contract — adding one would make survey authoring the first place a user has
  to know which channel they are on, which is exactly what the platform
  abstraction removed.
- **Shape must agree** across registrations of a name: placeholder count,
  button count and order. The survey field supplies one `params` array and one
  set of options, so a mismatch breaks that platform at send time with nothing
  warning beforehand. **This is the only hard coupling.**
- **Text may differ freely.** Only params and options come from the survey; the
  approved body wording is per-account. Divergence here is desirable — WhatsApp
  review will reject phrasing Messenger accepts, and there is no reason to drag
  the working Messenger template along with the fix.
- **Statuses are independent and stay that way.** `recontact_confirm` can be
  APPROVED on the page and REJECTED on the WABA. That is correct behaviour; the
  gap is that nothing currently surfaces it.

---

## 3. What to build

Both items below are client-side only. No new endpoint, no new Meta logic.

**3.1 — Sort the template list by name.** ✅ Built. Every registration of a name
then sits together, statuses side by side.

Correction to the original premise: the list was never per-account —
`list`/`listAll` already `ORDER BY m.name ASC, m.language ASC`
(`message-templates.queries.js:40,54`), so rows arrived name-sorted. What was
missing was the *affordance*: no sorters, and nothing saying name was the axis.
Built as antd column sorters (`defaultSortOrder: 'ascend'` on Name, every other
column re-sortable, all ties falling back to name → language → account) plus a
line of copy above the table.

Deliberately *not* a group-by or a pivot table. `list` already returns every
account's rows when no `accountId` is given (`templateQuery.listAll`,
`message-templates.controller.js:171-173`) and the existing table already
carries name, language, account and status — ordering is the whole change.
Revisit a pivot only if the sorted list proves hard to read in practice.

The one thing sorting cannot show is *absence*: an account with no row has no
row to sort. Accepted for now — 3.3 is the answer to that if it bites.

**3.2 — Duplicate to another account.** ✅ Built as
`/message-templates/new?duplicate=<id>`: the create form fetches the source row
and pre-fills name, language, body and buttons, leaves the account picker empty
(source account labelled `(source)`), and states the shape-agreement rule in a
banner. Two things surfaced while building it — sample values are **not**
copyable because `examples` is never persisted, and the "name taken" vs "name
reserved 30 days" messages had to be matched off the Graph error text since the
two remedies differ. Original text follows.

A "Duplicate" action on an existing
template opens the create form pre-filled with that template's body and
buttons, leaving the account picker to the user. The existing `POST /` already
branches per platform in `resolveAccountOps`, so the right builder
(`buildWhatsAppCreatePayload` / `buildFacebookCreatePayload` in
`message-templates.core.js`) is reached for free.

Its value is that the researcher does not retype the body, which is what makes
shapes diverge in the first place. Must handle a name already taken or
30-day-reserved on the target with a specific message, since the remedy differs
from a generic Meta error.

**3.3 — Preflight at survey publish** (optional, follows from 3.1): flag
`utility_message` fields whose template is missing or unapproved on any of the
researcher's accounts. Turns coverage from something you must know to go look
at into something that finds you.

### Explicitly not in scope

- **Shape validation.** Duplicate (3.2) makes agreement the default because
  nothing is retyped. Enforcing it is left to the researcher for now; revisit
  if shapes diverge in practice despite 3.2.
- **Editing a template, and recovering from a rejection.** Split out to
  `planning/whatsapp-template-editing.md`. It is not one feature — Meta
  supports editing on WhatsApp and not at all on Messenger — and none of it is
  needed for a survey to run on both platforms, which is what this document is
  about.

---

## 4. Open decisions

**4.1 — What happens at send time when the template is missing or unapproved on
that account?** Today Meta errors, message-worker burns `MAX_RETRY_ATTEMPTS`
(3), and the conversation stalls. Options: fail loudly with an `error_tag` so
dean can see and retry it; skip the field and continue the survey; fall back to
a free-form send when the conversation is still inside the 24-hour window.
This is a product decision about what a stalled panel participant experiences,
it applies to Messenger identically, and it should be decided once for both.

**4.2 — Fallback if name churn proves common: logical-name indirection.** The
survey would reference a logical name, with `message_templates` mapping
`(logical name, account_id)` → actual Meta name, making renames and per-platform
divergence invisible to survey authors. Rejected for now: message-worker does no
send-time database lookup today and this would introduce one plus a new
miss-failure mode and a new user-facing concept, on the evidence of two
rejections. Revisit if renames keep happening.

---

## 5. Untested surface

None of the WhatsApp template path has run against real Meta. Given that the
first hour of real WhatsApp traffic surfaced two defects — both at points where
the two APIs genuinely diverge (see the related docs) — the following deserve
explicit testing before anything is fielded:

- WABA-level create against `/{waba_id}/message_templates`, and the real review
  latency (minutes to hours, unlike Messenger).
- Delete, which on WhatsApp requires **both** `hsm_id` and `name` — `hsm_id`
  alone silently deletes nothing. (The reason: deleting by *name* alone is a
  distinct operation that removes every language variant of that name. Passing
  both scopes it to the one row, which is what we want.)
- The body component being **omitted** when there are no params (WhatsApp
  rejects an empty parameters array; Messenger requires body always).
- Per-button components with string `index`, versus Messenger's single
  positional `buttons` component.
- An actual out-of-window send. Note the test problem: proving this needs a
  genuine 24-hour gap since the last inbound message, or a way to drive it
  through dean. Worth designing before someone is a day into waiting.

---

## 6. Related

- `documentation/whatsapp-templates.md` — the existing implementation reference.
- `planning/whatsapp-media-send-path-findings.md`,
  `planning/whatsapp-inbound-media-findings.md` — the two defects found in the
  first production run, both at API divergence points.
- `documentation/utility-messages.md` — the Messenger utility-message system
  this mirrors.
- `planning/whatsapp-template-editing.md` — editing and rejection recovery,
  split out of this document and not currently planned.
