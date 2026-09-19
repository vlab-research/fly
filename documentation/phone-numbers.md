# Phone numbers

> How a number a respondent types becomes the handset a payment provider tops
> up: who parses it, where the country comes from, and what finally goes on the
> wire.
>
> **Components:** the Typeform form (declares the country), `replybot`
> (validates the answer, normalizes it at interpolation time), `dinersclub` →
> DingConnect (dials it).
>
> **Related:** `documentation/questions.md` (authoring the question and the
> payment block), `replybot/README.md` § "Phone numbers", `dinersclub/README.md`
> § "DingConnect Provider", `documentation/payment-recovery.md` (what happens
> when the transfer fails).

---

## 1. Two handling points, one parser

A phone number is touched in exactly two places, and they are on opposite sides
of the conversation:

| Where | What it does | Entry point |
|---|---|---|
| The `phone_number` question | Decides whether the answer is accepted or the question is re-asked | `replybot/lib/generic-validator.js` → `validatePhone` |
| The `\|e164` interpolation transform | Produces the string written into a payment config's `account_number` | `replybot/lib/typewheels/form.js` → `transforms.e164` |

Both call `replybot/lib/phone.js` (`libphonenumber-js`), and both resolve the
country from the same two settings. **That symmetry is the contract**: anything
the question accepts must also normalize at the payment. If validation were the looser of the
two, a respondent would finish the survey, be told they were paid, and the
transfer would go out against a string nobody could dial.

The answer is stored **exactly as typed**. Normalization happens only when a
payment config interpolates it, so exports and the response log carry the
respondent's own text while the provider gets the canonical form.

---

## 2. The flow

```
respondent types "54 9 11 6401-8373"
   │
   ├─ phone_number question ── validatePhone(answer, country of THIS question)
   │      invalid → question is re-asked with label.error.phoneNumber
   │      valid   → answer stored verbatim
   │
   └─ later, a payment question's Description is interpolated:
          "account_number": "{{field:pay_1_phone|e164}}"
             │
             ├─ country ← the question named by the ref (pay_1_phone), not this one
             ├─ normalizePhone(answer, country) → "+541164018373"
             │      unresolvable → the raw answer is passed through unchanged
             │
             └─ Description parsed as YAML → md.payment.details.account_number
                    → Kafka payment event → dinersclub → DingConnect AccountNumber
```

The transform is applied to the *text of the payment question's Description*
before that Description is parsed into metadata (`addCustomType`), which is why a
payment block can interpolate an answer at all. See `documentation/questions.md`
§ "Where you write all of this".

---

## 3. Where the country comes from

A bare national number — `1164018373` — is not a phone number until you say
which country it is in. The country is a property of **the question that
collected the value**, not of the message being rendered, so the transform
resolves the field named in the ref and reads:

1. `md.validate.country` — set in the question's Description YAML
   (`validate: {country: AR}`). Wins when both are set.
2. `properties.default_country_code` — Typeform's own setting on a Phone Number
   question.
3. Otherwise: no country.

Both sides read the field *after* its Description has been merged into `md`
(`addCustomType`), so either setting governs validation and payment alike.

`{{hidden:...}}` values have no question behind them and therefore never have a
country. Neither does a `{{field:...}}` ref that cannot be resolved — when the
form is not in context, or the ref names no field, the transform still runs,
without a country. Degrading is deliberate: a missing country must not turn a
payment into an interpolation error.

Country codes are accepted in either case — `ar` and `AR` are the same country.
`phone.js` uppercases the code once, before it reaches `libphonenumber-js`,
which only knows the uppercase form.

### No country is a usable state, not a broken one

With no country, only an international number resolves — with or without the
leading `+`. A bare national number is rejected by the question and left
untouched by the transform.

This is the right failure. Guessing a country for a bare national number does
not produce a rejected payment; it produces a **successful** top-up of a real
handset belonging to someone else in whichever country was guessed. A rejection
is visible — the respondent is asked again — and a wrong-country transfer is
not.

---

## 4. What the question accepts

Written against a question that declares `AR`, all of these are the same
reachable handset and all are accepted:

| Input | Why |
|---|---|
| `+5491164018373` | International, canonical |
| `+54 9 11 6401-8373` | Spaces and dashes are ignored |
| `5491164018373` | People routinely omit the `+` |
| `54 9 1164018373` | Both at once |
| `1164018373` | Bare national, resolved against the question's country |
| `mi numero es 5491164018373` | Surrounding words are ignored |

Rejected: too few digits to dial (`23345`), too many (`+549112326403068`), and —
when the question names no country — anything bare national.

The raw text is tried against the declared country **first**, and only then with
a `+` prepended. A national number therefore keeps its national reading rather
than being re-interpreted as some other country's international number.

---

## 5. What reaches the provider

`normalizePhone` returns E.164, with one deliberate exception.

**Argentina.** An Argentine mobile's E.164 carries a carrier-select `9` between
the country code and the area code. The string sent to DingConnect drops it:
`+5491164018373` → `+541164018373`. That is the shape this account's Argentine
transfers are accepted in; the `9` form is untested against it. This lives in
`phone.js` `_forProvider`, and changing it changes what every Argentine
respondent is paid on.

**When nothing resolves**, `|e164` passes the raw answer through unchanged
rather than emptying the field. DingConnect then rejects it with
`AccountNumberInvalid`, which `dinersclub/classify.go` classifies as
`RecoveryPermanent` — no retry loop, the respondent's failure surfaces through
the normal payment-failure path (`documentation/payment-recovery.md`). A
rejected payment is recoverable by a human; a payment to a plausible wrong
number is not.

---

## 6. What a form author must get right

Three things are study configuration, not platform behavior, and all three are
silent when wrong:

1. **Declare the corridor's real country.** The declared country is what a
   bare national number resolves against, so a wrong one does not fail — it
   pays someone else. With `US` declared on an Argentine survey,
   `2346459349` is accepted, normalized to `+12346459349`, and the incentive is
   delivered to a US handset. The six LAC Pay 1 forms (Argentina, Bolivia and
   Honduras, each in EN and ES) declare `AR`, `BO` and `HN`. In the projects-88 study tooling the country comes
   from `build_xlsx.INCENTIVE[country]["phone_country"]`: `set_payment_pins.py`
   writes it onto the forms and `verify_forms.py` fails on any form whose
   phone question disagrees.

2. **Quote the interpolated value in the payment block.** The Description is
   parsed as YAML, and an unquoted `+541164018373` parses as the integer
   `541164018373` — the `+` is gone before anything downstream sees it. Write
   `"account_number": "{{field:pay_1_phone|e164}}"`.

3. **Ask for what the country setting supports.** If the question declares no
   usable country, its wording must ask for the country code, because a bare
   national answer will be refused and the respondent will simply be asked
   again.

---

## 7. Things to know

- **Stored answers are not normalized.** Exports and the response log carry the
  respondent's raw text, so two rows that pay the same handset can look
  different. This is intentional (the answer is evidence of what was said) but it
  means downstream analysis must normalize for itself.
