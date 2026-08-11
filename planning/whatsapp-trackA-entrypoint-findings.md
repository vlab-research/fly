# WhatsApp Entry-Point & Referral Behavior — Track A Findings

**Scout #2 investigation:** How a WhatsApp conversation gets bound to a survey for staging testing.

---

## 1. Recognized Referral Shape (WhatsApp)

A WhatsApp `conversation_started` referral is **triggered by `data.referral` field** in the raw WhatsApp event:

```javascript
{
  type: "text" | "interactive" | "button" | <other>,
  text: { body: "..." },                    // optional
  referral: {
    ref: "form.<SHORTCODE>",                // REQUIRED format for getForm() to work
    source: "ctwa" | "ad" | "etc",
    type: "OPEN" | "OPEN_THREAD" | "etc"
  },
  from: "<phone>",
  timestamp: <seconds>,
  phone_number_id: "<PHONE_ID>"
}
```

**Normalization path (event-normalizer.js:237–248):**
- `categorizeWhatsAppEvent()` checks `if (data.referral)` → emits `event_type: 'conversation_started'`
- Payload: `{ type: 'conversation_started', trigger: 'referral', referral: <raw_referral_obj> }`
- The `referral.ref` is extracted by `getForm()` (utils.js:86–89) by parsing the dot-separated string `form.<shortcode>` → `{form: '<shortcode>', ...}`

**Key constraint:** The WhatsApp normalizer does **NOT** check for referral in `message.quick_reply.payload` like Messenger does (platform-abstraction-hardening.md §7). WhatsApp only recognizes `data.referral` as a top-level field.

---

## 2. Problem: Plain Inbound "Hi" Has No Referral

A user who sends a plain WhatsApp text message (e.g. "hi") without a click-to-WhatsApp referral produces:

```javascript
{
  type: "text",
  text: { body: "hi" },
  from: "27123456789",
  phone_number_id: "PHONE_1",
  timestamp: 1640995200000
  // NO referral field
}
```

**Normalization result:**
- `categorizeWhatsAppEvent()` falls through to `if (data.type === 'text')` → `event_type: 'user_text'`
- `getForm()` returns `undefined` → survey logic calls `getForm(pageid, undefined)` → **errors**

**Why this is hard:** WhatsApp has no "Get Started" button like Messenger. A new user can only start a survey via a **click-to-WhatsApp referral link** carrying the form shortcode.

---

## 3. Viable Entry Points (Ranked for Staging Testing)

### Rank 1: Click-to-WhatsApp Referral (REAL, requires Meta setup)
**When:** User clicks a WhatsApp button/link containing the referral parameter.
**Flow:** Meta adds `referral: {ref: 'form.<shortcode>', source: 'ctwa'}` to the first message.
**Hermes step:** `handlers.rs:handle_whatsapp()` extracts `phone_number_id` from metadata, calls `stamp_whatsapp_event()` (event.rs:73) → tags `source: 'whatsapp'` + `phone_number_id`.
**Payload to replybot:** Raw WhatsApp event with `referral` field.
**Status:** Dormant in staging (no Meta webhook configured yet) — will work once `WHATSAPP_VERIFY_TOKEN` is set and Meta webhook points to Hermes.

---

### Rank 2: Synthetic conversation_started (RECOMMENDED FOR TESTING)
**Pattern:** Inject a synthetic event directly via `POST /synthetic` (Hermes handlers.rs:194–219).

**Exact payload shape for WhatsApp user on phone_number_id Y to start survey shortcode X:**

```json
{
  "user": "<WHATSAPP_PHONE_NUMBER>",
  "source": "synthetic",
  "page": "<PHONE_NUMBER_ID_Y>",
  "event": {
    "type": "conversation_started",
    "value": {
      "trigger": "referral",
      "referral": {
        "ref": "form.<SHORTCODE_X>",
        "source": "synthetic_test",
        "type": "OPEN_THREAD"
      }
    }
  }
}
```

**How it works:**
- Hermes `handle_synthetic()` stamps `source: 'synthetic'` + `timestamp: now_ms` (handlers.rs:211–216)
- Replybot `parseSyntheticEvent()` (event-normalizer.js:214–231) transforms to UniversalEvent with `event_type: 'synthetic_conversation_started'` (prefix `synthetic_` + type from `event.type`)
- Machine categorizes `event_type === 'conversation_started'` → calls `getForm()` from the referral ref
- **Result:** Survey for shortcode X starts, user bound to phone_number_id Y

**Advantages:**
- No Meta webhook setup needed
- Deterministic, repeatable for testing
- Works on staging immediately
- Can be called from dinersclub, exodus, or testrunner (all POST to `/synthetic`)

**Hermes test evidence:** `hermes/tests/handlers.rs:166–242` shows synthetic event injection via `POST /synthetic`.

---

### Rank 3: Synthetic + Message Sequence (Workaround)
If you want to **start a survey WITHOUT a referral**, you could:
1. Inject a synthetic `conversation_started` (above) to arm the survey
2. Follow with real/synthetic user messages

But this is a workaround — production entry point is always referral.

---

## 4. Synthetic Payload Deep Dive (Implementation)

**Structure that parseSyntheticEvent transforms:**

| Kafka key | Value | Machine sees |
|-----------|-------|--------------|
| `user` | WhatsApp phone number (e.g. `27123456789`) | `user_id` |
| `source` | `'synthetic'` | `source.type: 'synthetic'` |
| `page` / `pageid` / `account_id` | Phone number ID (e.g. `PHONE_1`) | `source.account_id` |
| `event.type` | `'conversation_started'` | `event_type: 'synthetic_conversation_started'` |
| `event.value.referral` | `{ref: 'form.<shortcode>', ...}` | `payload.referral` (passed through) |

**Machine categorizes** `synthetic_conversation_started` the same way as `conversation_started` because `getForm()` doesn't check the event source — it only reads `event.payload.referral.ref`.

---

## 5. Known Issues & Latent Bugs

### No Messenger-Style Referral Bug in Quick_Reply
**Background:** Messenger has a known bug (platform-abstraction-hardening.md §7) where `quick_reply.payload.referral` is a JSON string, not parsed before checking — so referral gets dropped.

**WhatsApp status:** Not applicable. WhatsApp's `quick_reply`/`interactive` button replies do **not** carry referrals. Referrals only come as:
- Top-level `data.referral` (recognized ✓)
- Or embedded in `button.payload` (not parsed as referral by normalizer — treated as button reply value)

**Potential latent issue:** If a WhatsApp template button's payload is set to a ref-like string (e.g. `button.payload = "form.ABC"`), it gets treated as a `user_interaction` value, not a referral. This is semantically different from Messenger's postback referral handling. **Not a regression — just a different design.** (Would need explicit ref-parsing in `makeWhatsAppReply` builder or machine validation to fix.)

---

## 6. Test Coverage & Entry-Point Paths

**Normalizer tests (event-normalizer.test.js:373–377):**
```javascript
it('categorizes a referral as conversation_started', () => {
  const { event_type, payload } = categorizeWhatsAppEvent({ 
    type: 'text', 
    text: { body: 'x' }, 
    referral: { ref: 'form.ABC123' } 
  })
  event_type.should.equal('conversation_started')
  payload.referral.ref.should.equal('form.ABC123')
})
```

**Testrunner mox builders (mox.ts):**
- `makeWhatsAppReferral(userId, formId)` — builds a referral webhook envelope
- `makeSynthetic(userId, event, pageId)` — builds a synthetic event

**Synthetic path in testrunner (sender.ts:20–24):**
```typescript
case 'synthetic':
  url = `${BOTSERVER_URL}/synthetic`;
  json = message;
  break;
```

---

## 7. Recommended Staging Test Workflow

**For Track A testing (survey start verification):**

1. **Programmatic:** Inject synthetic referral via POST to Hermes `/synthetic`:
   ```bash
   curl -X POST http://staging.fly-botserver.vlab.digital/synthetic \
     -H 'Content-Type: application/json' \
     -d '{
       "user": "27123456789",
       "source": "synthetic",
       "page": "<PHONE_ID>",
       "event": {
         "type": "conversation_started",
         "value": {
           "trigger": "referral",
           "referral": { "ref": "form.flysmoke" }
         }
       }
     }'
   ```

2. **Via testrunner:** Update `mox.ts` to add `makeSyntheticWhatsAppReferral()`:
   ```typescript
   export function makeSyntheticWhatsAppReferral(userId: string, formId: string, phoneNumberId: string): any {
     return makeSynthetic(userId, {
       type: 'conversation_started',
       value: {
         trigger: 'referral',
         referral: { ref: `form.${formId}`, source: 'synthetic_test' }
       }
     }, phoneNumberId);
   }
   ```

3. **Verify:** Check replybot logs for `event_type: 'synthetic_conversation_started'` → `getForm()` extraction → survey transition.

---

## 8. Undocumented Behavior Found

**Not yet documented (candidate for docs update pass):**

1. **WhatsApp entry-point mechanism** — How a survey actually starts on WhatsApp vs. Messenger. Hermes stamps `phone_number_id`; replybot maps it to survey via `getForm()` + referral ref. This is end-to-end but not explained in `documentation/platform-abstraction.md`.

2. **Synthetic referral payload shape** — The `event.value` structure for `conversation_started` synthetic events is not documented. Only found in testrunner `mox.ts` by convention.

3. **Account ID routing for WhatsApp** — While `documentation/platform-abstraction.md` mentions phone_number_id as account_id, it doesn't explain the Hermes→replybot flow (source tagging, stamping, Kafka routing by `from`/`recipient_id`).

---

## Summary Table

| Mechanism | How Survey Starts | Normalizer Path | Staging Ready? | Notes |
|-----------|------------------|-----------------|----------------|-------|
| **Click-to-WhatsApp referral** (real) | Meta webhook with `referral` field | `categorizeWhatsAppEvent()` line 240 | No — needs Meta setup | High fidelity; production entry point |
| **Synthetic referral** (testing) | POST `/synthetic` with conversation_started event | `parseSyntheticEvent()` → prefixes type | **Yes** | Immediate; deterministic |
| **Plain text message** | User sends "hi" | → `user_text`, no form binding | No — errors | WHY the brief's problem exists |

---

## Conclusion

**Recommended for staging Track A testing:** **Synthetic conversation_started via POST /synthetic (Rank 2).**

Exact payload provided above (§4). No Meta setup needed. Works immediately. Can be injected from testrunner, dinersclub, or curl. Once validated, click-to-WhatsApp referral can be enabled by setting `WHATSAPP_VERIFY_TOKEN` + configuring Meta webhook.
