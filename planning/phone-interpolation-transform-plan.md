# Plan: Phone normalization via interpolation transform syntax

## Problem

Phone number responses pass validation but get stored with trailing text (e.g. `+254712345678 use this`). The `phone` library accepts these — it extracts a valid E.164 number from messy input — but the **raw text** is what lands in `qa`. Both downstream uses (payment API call, unique transaction ID) read from `qa` via `getFieldValue()`, so two submissions of the same number with different trailing characters produce different transaction IDs, breaking duplicate payment detection.

The fix should **preserve raw data in `qa`** and normalize at the point of use — not at store time. This keeps the audit trail intact and follows the existing pattern (`parseNumber` is called at use sites for number fields, not at store time).

## Solution: `|transform` pipe syntax in interpolation

Extend the `{{...}}` interpolation language to support a pipe-and-transform suffix:

```
{{field:phone|e164}}
```

This is safe to use in `properties.description` YAML — Typeform treats descriptions as opaque strings and never validates or processes their contents. The pipe syntax only needs to appear in payment YAML descriptions, not in field titles.

The form YAML for a payment field would change from:

```yaml
payment:
  provider: reloadly
  details:
    phone: "{{field:phone}}"
    transaction_id: "survey_x_{{field:phone}}_1"
```

to:

```yaml
payment:
  provider: reloadly
  details:
    phone: "{{field:phone|e164}}"
    transaction_id: "survey_x_{{field:phone|e164}}_1"
```

Raw input is preserved in `qa`. The normalized E.164 value is only produced when the template is interpolated to build the payment object.

---

## What to change

### 1. `translate-typeform` source — add `normalizePhone` export

**File**: `/home/nandan/Documents/vlab-research/translate-typeform/validator.js`

Add after `_isPhone`:

```js
function normalizePhone(number, country, mobile) {
  return phone('' + number, country || '', !mobile)[0] || null
}
```

Add to the `module.exports` line:

```js
module.exports = { validator, defaultMessage, followUpMessage, offMessage, normalizeUnicodeNumerals, parseNumber, normalizePhone }
```

### 2. Installed copy — same change

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/node_modules/@vlab-research/translate-typeform/validator.js`

Identical change. (The source repo change is for the next published version; the installed copy change makes it work now.)

### 3. `form.js` — extend `getDynamicValue` to handle pipe transforms

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/form.js`

Import `normalizePhone` at the top alongside existing translate-typeform imports:

```js
const { translator, addCustomType: baseAddCustomType, parseNumber, normalizePhone } = require('@vlab-research/translate-typeform')
```

Add a `_applyTransform` helper:

```js
function _applyTransform(name, value) {
  const transforms = {
    e164: v => normalizePhone(v, '', false) || v
  }
  const fn = transforms[name]
  if (!fn) throw new TypeError(`Unknown interpolation transform: ${name}`)
  return fn(value)
}
```

Extend `getDynamicValue` to split on `|` before processing the ref:

```js
function getDynamicValue(ctx, qa, v) {
  const pipeIdx = v.indexOf('|')
  const ref = pipeIdx === -1 ? v : v.slice(0, pipeIdx).trim()
  const transform = pipeIdx === -1 ? null : v.slice(pipeIdx + 1).trim()

  const [loc, key] = ref.split(':')
  const val = loc === 'hidden' ?
    getFromMetadata(ctx, key) :
    getFieldValue(qa, key)

  if (val === undefined || val === null) {
    throw new TypeError(`Trying to interpolate a non-existent value: ${v}`)
  }

  return transform ? _applyTransform(transform, val) : val
}
```

This is fully backward-compatible — tokens without `|` behave exactly as before.

### 4. Revert premature machine.js changes

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js`

An earlier incomplete session added a `_normalizePhoneOutput` function and modified the `act()` RESPOND case. These changes should be reverted:

- Remove the `normalizePhone` import from the `require('@vlab-research/translate-typeform')` line
- Remove the `_normalizePhoneOutput` function (added just before `function act(...)`)
- Revert the `act()` RESPOND case to its original form:
  ```js
  case 'RESPOND': {
    const qa = apply(state, output).qa
    const messages = respond({ ...ctx, md: { ...state.md, ...output.md } }, qa, output)
    const payment = messages.map(m => getPaymentFromMessage(ctx, m)).find(p => p)
    const handoff = messages.map(m => getHandoffFromMessage(ctx, m)).find(h => h)
    return { messages, payment, handoff }
  }
  ```

---

## Files to change

| File | Change |
|------|--------|
| `translate-typeform/validator.js` | Add `normalizePhone` function + export |
| `fly/replybot/node_modules/@vlab-research/translate-typeform/validator.js` | Same (installed copy) |
| `fly/replybot/lib/typewheels/form.js` | Import `normalizePhone`, add `_applyTransform`, extend `getDynamicValue` |
| `fly/replybot/lib/typewheels/machine.js` | Revert premature normalization changes |

The actual **form YAML** for the affected payment question also needs updating to use `{{field:phone|e164}}` — this is a form configuration change, not a code change.

---

## Tests

### Unit tests — `form.js`

In `form.test.js`, add cases to the interpolation tests:

- `{{field:phone|e164}}` with a messy stored value (`'+254712345678 use this'`) resolves to `'+254712345678'`
- `{{field:phone|e164}}` with a clean stored value (`'+254712345678'`) resolves to `'+254712345678'` (idempotent)
- `{{field:phone}}` (no transform) continues to resolve to the raw stored value (backward compat)
- An unknown transform name (e.g. `{{field:foo|bogus}}`) throws a TypeError

### Unit tests — `validator.js` (translate-typeform)

In `validator.test.js`, add:

- `normalizePhone('+254712345678!', '', false)` returns `'+254712345678'`
- `normalizePhone('+254712345678 use this', '', false)` returns `'+254712345678'`
- `normalizePhone('hello world', '', false)` returns `null`
- `normalizePhone('+254712345678', '', false)` returns `'+254712345678'` (clean input, idempotent)

### Run existing tests

```bash
# In translate-typeform source
cd /home/nandan/Documents/vlab-research/translate-typeform && npm run test-ci

# In replybot
cd /home/nandan/Documents/vlab-research/fly/replybot && nvm use && npm test
```
