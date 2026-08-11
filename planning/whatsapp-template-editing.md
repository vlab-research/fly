# Editing Message Templates and Recovering from Rejection

**Status:** Not planned, not needed now. Split out of
`planning/whatsapp-templates-cross-platform.md` on 2026-08-09 so that document
could stay about running one survey across both platforms. This one exists so
the research is not lost and so the next person does not re-derive it.

**Question this answers:** what a researcher does when a template is rejected,
or when approved wording needs to change.

---

## 1. Today there is no edit path at all

`dashboard-server/api/message-templates/message-templates.routes.js:30-34`
exposes exactly four operations:

```
POST   /            create
GET    /            list
GET    /:id         get one
DELETE /:id         delete
```

No PUT, no PATCH, and no Meta edit call anywhere in
`message-templates.facebook.js`. `documentation/whatsapp-templates.md` records
this as "no-edit semantics", which is accurate but reads as a design choice
rather than what it is on one of the two platforms — a hard API limit.

---

## 2. What Meta actually supports (verified 2026-08-09)

**The two platforms do not agree, and this is the central fact.**

### Messenger: editing is impossible

The Graph API reference for `/{page_id}/message_templates` has Reading,
Creating and Deleting sections. Under **Updating** it says verbatim:

> You can't perform this operation on this endpoint.

There is no edit at any status. A rejected Messenger template cannot be fixed
in place, ever.

### WhatsApp: editing is fully supported

`POST /v{version}/{TEMPLATE_ID}`

| | |
|---|---|
| Editable statuses | `APPROVED`, `REJECTED`, `PAUSED` |
| Frequency, approved | 10 edits per 30 days, 1 per 24 hours |
| Frequency, rejected or paused | unlimited |
| Editable fields | `components`, time-to-live, `category` — but **not** the category of an approved template |
| Not editable | `name`, `language` |
| Component granularity | all-or-nothing: *"You cannot edit individual template components; the API replaces all components with those in the edit request payload"* |
| After edit | *"the API automatically re-approves the template unless it fails template review"* |

Note: the Template API *reference* page lists `name` and `language` among the
edit parameters, contradicting the template-management *guide*. The guide is
the one to trust, and it does not matter for us either way — our identity tuple
is `(account_id, name, language)`, so moving either would be a different
template, not an edit.

### Deletion, which is the Messenger escape hatch

> If you delete an **approved** template, you cannot create a new template with
> the same name for 30 days.

The reservation is scoped to *approved* templates. **A rejected template
carries no reservation** and can be deleted and recreated under the same name
immediately.

Also worth knowing, since it explains an existing quirk in our code:

> Deleting a template by name deletes all templates that match that name
> (meaning templates with the same name but different languages will also be
> deleted). To delete a template by ID, include the template's ID along with
> its name in your request; only the template with the matching template ID
> will be deleted.

This is *why* WhatsApp delete requires both `hsm_id` and `name` — the two-arg
form is the narrow one. We already do the narrow form
(`message-templates.controller.js:69`).

---

## 3. What this means

**Rejection recovery is two different flows, not one.**

| | Messenger | WhatsApp |
|---|---|---|
| Fix a rejected template | delete, then create again under the same name — no reservation applies | edit in place, unlimited attempts, name and language preserved |
| Fix approved wording | delete + recreate, but the name is **reserved 30 days** — in practice this means a new name | edit in place, 10 per 30 days |

The second row is the sharp one. On Messenger, changing the wording of a
working approved template effectively costs you the name for a month, and the
name is what the survey JSON references. There is no good answer today beyond
"create the replacement under a new name first, then switch the survey, then
delete the old one" — which does work, and is worth writing down as the
procedure even without building anything.

**The `_en2` episode was avoidable, but not by editing.**
`305_misroute_recontact_en` is a Facebook page template and is REJECTED in
prod. It could never have been edited. It could have been deleted and
recreated as `_en`, because rejected templates carry no name reservation. So
the original diagnosis ("editing in place would have kept the name") was wrong
in its mechanism and right in its conclusion.

---

## 4. If this is ever built

Roughly in order of value per unit of work:

**4.1 — Document the procedure before building anything.** The delete-and-
recreate path for a rejected template already works with the endpoints we have.
The gap is that nobody knows the 30-day reservation does not apply to rejected
templates, so they invent `_en2` instead. This is a paragraph in
`documentation/whatsapp-templates.md` and some UI copy on the delete
confirmation, and it captures most of the real-world value here.

**4.2 — Surface the rejection reason and the appeal route.** The reason is
already stored and shown (`TemplateDetail.js:122-130`), captured from the
create response — note that Facebook's GET never returns it, which is why
`refreshTemplateStatus` only polls PENDING rows
(`message-templates.controller.js:129-133`). What is missing is the Business
Manager deep link to appeal, which is near-free.

**4.3 — Edit, WhatsApp only.** `POST /{template_id}` with a full component
replacement, wired to a form pre-filled from the stored row, then re-poll
status. The all-or-nothing component replacement means the edit payload is the
same shape as the create payload, so `buildWhatsAppCreatePayload` is reusable
as-is. Gate the UI on platform — offering an Edit button that only works for
half the accounts is worse than not having one.

**4.4 — Guided delete-and-recreate, Messenger only.** The same intent, executed
as two calls, with the 30-day reservation stated and the approved-vs-rejected
distinction driving whether the name can be reused. Only worth building if 4.1
proves insufficient on its own.

**A note on shape.** `planning/whatsapp-templates-cross-platform.md` argues
that registrations of a name must agree on placeholder count and button
count/order across accounts, because the survey field supplies one `params`
array and one set of options. Editing is exactly where that agreement can
silently break — a WhatsApp edit to clear a rejection can add a placeholder
that the Messenger registration does not have. Validation was deliberately left
out of the current scope on the grounds that duplicate-to-create means nothing
is retyped. That reasoning does not extend to editing. If 4.3 gets built,
shape validation should be reconsidered alongside it.

---

## 5. Sources

- [Graph API Reference — Page Message Templates](https://developers.facebook.com/docs/graph-api/reference/page/message_templates/)
  — the Messenger "you can't perform this operation" statement.
- [WhatsApp — Template management](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management/)
  — edit endpoint, statuses, frequency limits, delete and name reservation.
- [WhatsApp — Template API reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/template-api)
  — parameter list; contradicts the guide on name/language, see §2.

## 6. Related

- `planning/whatsapp-templates-cross-platform.md` — the parent document; one
  name across both platforms, coverage, duplicate.
- `documentation/whatsapp-templates.md` — the implementation reference.
- `documentation/utility-messages.md` — the Messenger utility-message system.
