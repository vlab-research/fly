# Exporter Object-Key Collision — Cross-Tenant Data Disclosure

**Status:** Backlog — [VIR-23](https://linear.app/vlab-research/issue/VIR-23/exporter-object-keys-collide-across-researchers-disclosing-respondent). Pre-existing bug, live in production, unrelated to the media
abstraction work that surfaced it.

**Found:** 2026-08-10, while designing inbound respondent-media storage
(`planning/inbound-media-storage.md`), which planned to reuse the exporter's delivery path.

---

## 1. The bug

`exporter/exporter/exporter.py` writes export artifacts to object keys derived from
`survey_name` alone:

| Line | Key |
|---|---|
| 226 | `exports/{survey}.csv` |
| 351 | `exports/{survey}_full_messages{suffix}.csv` |
| 459 | `exports/{survey}_chat_log.csv` |

**`survey_name` is unique per user, not globally.** Nothing in the schema constrains it
across users, and in practice it collides heavily.

Verified read-only against production, 2026-08-10:

| `survey_name` | distinct owners |
|---|---|
| `default` | **8** |
| `Default` | 3 |
| `GW Pediatric Vaccinations` | 2 |
| `UNICEF - Routine Immunization Kyrgyzstan` | 2 |
| `UNICEF - Routine Immunization Turkey` | 2 |
| `malaria no more` | 2 |
| `wastelaosen` | 2 |
| `wastelaoslao` | 2 |

So two researchers exporting a survey they both call `default` write to the same object.

## 2. Why it discloses data, and in the counterintuitive direction

`storage.py:generate_link` issues a presigned URL valid for **7 hours**. The object it
points at is mutable for that entire window.

1. Researcher **A** exports `default`. Object written. A receives a link, valid 7 hours.
2. Researcher **B** exports *their* `default`. **Same key. Overwritten.**
3. A opens their link — still valid, still points at that key — and receives **B's
   respondent data**.

The disclosure flows from the **later** exporter to the **earlier** one. Neither party sees
anything anomalous: B's export succeeded normally, and A downloaded from a link the system
gave them. There is no error, no warning, and nothing in the export status UI that would
show it.

**What is disclosed:** survey responses (`{survey}.csv`), complete message exports
(`_full_messages.csv`) and full conversation logs (`_chat_log.csv`) — all respondent data,
from a study the recipient has no relationship with.

**Authorization is not the flaw.** The exporter's *queries* are correctly scoped — every one
joins through `surveys` to `users.email`, so a researcher cannot query another's data. The
flaw is entirely in the **storage key**, downstream of a correct authorization boundary. That
is why it has survived: reviewing the query layer finds nothing wrong.

## 3. Why it is cheap to fix

`export_data(cnf, export_id, user, survey, options)` — **`user` is already a parameter at
every one of the three key-construction sites.** No new query, no plumbing, no schema change.
The identity needed to disambiguate the key is already in scope and simply is not used.

## 4. Options

The key must stay under the `exports/` prefix: `storage.py:_ensure_lifecycle` filters on
`prefix="exports/"` for the 3-day expiry rule, so a key outside it would silently stop being
cleaned up and accumulate forever. All options below preserve that.

| Option | Key | Assessment |
|---|---|---|
| **A. Hash of the user identifier** | `exports/{sha256(user)[:16]}/{survey}.csv` | **Recommended.** No extra query, no PII in the object key. Opaque, which costs some debuggability. |
| B. `userid` UUID | `exports/{userid}/{survey}.csv` | Cleanest semantically, but `user` here is an email — this needs a lookup or a join the exporter does not currently do. |
| C. Email verbatim | `exports/{email}/{survey}.csv` | **Rejected.** Puts PII in an object key, which then appears in logs, metrics, bucket listings and presigned URLs. |
| D. Include `export_id` | `exports/{export_id}/{survey}.csv` | Also fixes a *second*, lesser issue: a user re-exporting the same survey currently invalidates their own still-live link. But it makes every export a distinct object, changing "latest export" semantics and increasing object count. Worth considering on its merits. |

A and D are compatible and could be combined.

**Decide before implementing:** whether to also adopt D. That is a product-semantics question
(is the export a stable artifact per survey, or one per export run?), not a security one.

## 5. Remediation of existing objects

**None required.** The 3-day lifecycle rule (`expire-exports-3d`) removes every existing
`exports/` object within three days of creation, so all colliding artifacts age out on their
own once the fix ships. There is no backfill and no migration.

In-flight presigned links issued before the fix remain valid against the old keys until they
expire (≤7 hours) or the object ages out. If the disclosure is considered material, the
mitigation is to delete the existing `exports/` objects at deploy time, which invalidates
those links immediately at the cost of forcing affected researchers to re-export.

## 6. Testing

The bug is a property of the *key*, so the regression test must assert on the key, not on
export success — an export that overwrites another's object succeeds perfectly.

- Two different users with the **same** `survey_name` produce **different** object keys.
- The same user and survey produce a **stable** key (unless D is adopted, in which case
  assert the opposite deliberately).
- Generated keys still begin with `exports/`, so the lifecycle rule still matches them. This
  is the one that would otherwise be found months later as a full volume.
- All three artifact types (`.csv`, `_full_messages`, `_chat_log`) are covered — fixing only
  the first is the obvious partial failure.

## 7. Do not inherit this

`planning/inbound-media-storage.md` proposes extending the exporter to deliver respondent
media. **That work must not adopt the current key scheme.** The same collision there would
disclose a ZIP of respondent photographs rather than a CSV — same mechanism, materially
worse payload. Either fix this first, or key the new source correctly from the start and
leave the existing three to this ticket.
