# Facebook Messenger Webhook Fields Enumeration

**Investigation Date**: 2026-05-25  
**Hypothesis**: Facebook moved `message_echoes` data for `user_phone_number` quick replies to a dedicated, PII-segregated webhook field  
**Status**: UNABLE TO FULLY CONFIRM VIA PUBLIC DOCUMENTATION

## Summary

Meta's official developer documentation for complete Page and Messenger webhook field references is **currently unavailable or inaccessible** (multiple WebFetch and WebSearch attempts returned 404/error pages). However, we have confirmed the existence of several webhook fields via documentation fragments and changelog references.

---

## Part 1: All Confirmed Page-Level Webhook Fields

| Field Name | Summary | Introduced | Echo Replacement? | Permissions Required |
|---|---|---|---|---|
| `call_permission_reply` | Caller identification + consent tracking with expiration timestamps | Unknown | No | Unknown |
| `feed` | Page feed/post interactions | Baseline | No | `pages_manage_metadata` |
| `group_feed` | Group feed interactions | Unknown | No | `pages_manage_metadata` |
| `message_context` | Message detections, AI insights, conversion event data | Unknown | Possibly (see below) | `pages_manage_metadata` |
| `message_deliveries` | Confirmation message was delivered to recipient; mids + watermark | Baseline | **PARTIAL** — confirms delivery but not send confirmation | `pages_manage_metadata` |
| `message_echoes` | "Echoes of messages sent by your app" (full outbound message payload) | Baseline | **YES** — this is the current mechanism | `pages_manage_metadata` |
| `message_edits` | User message modifications with full content | Unknown | No | `pages_manage_metadata` |
| `message_reactions` | User reactions (emoji/reaction type) with mid | Unknown | No | `pages_manage_metadata` |
| `message_reads` | Read receipts with watermark | Baseline | No — only acks that message was read | `pages_manage_metadata` |
| `messaging_account_linking` | Account link/unlink button actions | Baseline | No | `pages_manage_metadata` |
| `messaging_customer_information` | **"Customer information screen responses including the information entered by the user"**; sender/recipient IDs, timestamps, screen responses as key-value pairs | Unknown (exists in current docs) | **POSSIBLY** — see deep dive below | `pages_manage_metadata` |
| `messaging_game_plays` | Instant Games round plays; game_id, player_id, score, context | Baseline | No | `pages_manage_metadata` |
| `messaging_handovers` | Conversation ownership changes between apps | Baseline | No | `pages_manage_metadata` |
| `messaging_optins` | User opt-in/out for marketing + one-time opt-in status | Baseline | No | `pages_manage_metadata` |
| `messaging_policy_enforcement` | Policy violations (action + reason); recipient, timestamp | Baseline | No | `pages_manage_metadata` |
| `messaging_postbacks` | Postback button clicks, Get Started, persistent menu | Baseline | No | `pages_manage_metadata` |
| `messaging_referrals` | m.me link or ad referral source tracking | Baseline | No | `pages_manage_metadata` |
| `response_feedback` | User feedback on bot responses | Unknown | No | `pages_manage_metadata` |
| `send_cart` | Shopping cart events | Unknown | No | `pages_manage_metadata` |
| `standby` | Message received but app not current conversation owner | Baseline | No | `pages_manage_metadata` |

**Key**: Fields we currently subscribe to are: `messages`, `messaging_postbacks`, `messaging_optins`, `messaging_account_linking`, `messaging_referrals`, `message_echoes`, `messaging_handovers`, `messaging_policy_enforcement`, `message_template_status_update`, `standby`.

---

## Part 2: Plausible Echo-Replacement Candidates

### 1. **`message_context`** — MEDIUM PRIORITY
- **What it delivers**: "Message detections, AI model insights, and conversion event data" with an "eligible for ads reporting" flag
- **Echo-relevant payload?**: UNCLEAR — documentation fragment does not specify if it includes the bot's outbound message text, message_id, or send confirmation
- **Source**: Initial WebFetch from https://developers.facebook.com/docs/graph-api/webhooks/reference/page (partial data)
- **Assessment**: Could theoretically carry metadata about message intent/type, but unclear if it includes the actual prompt text or mid that would replace echo functionality

### 2. **`messaging_customer_information`** — HIGH PRIORITY
- **What it delivers**: Described as capturing "the information entered by the user" in a "customer information screen" with sender/recipient IDs, timestamps, and key-value pair responses
- **Echo-relevant payload?**: **POSSIBLY** — if the "customer information screen" is META's term for what happens when a user responds to a sensitive quick reply like `user_phone_number`, the key-value pairs could be the phone number + metadata
- **Source**: Initial WebFetch from https://developers.facebook.com/docs/graph-api/webhooks/reference/page
- **Assessment**: **This is the strongest candidate.** If Meta segregated phone number responses into a dedicated webhook that treats them as "customer information" (i.e., PII), they would likely NOT send it via `message_echoes` anymore. Instead, the bot would need to subscribe to `messaging_customer_information` to receive the user's phone number response + confirmation the response was collected.
- **Known limitation**: We could NOT access the full payload documentation for this field during this research.

### 3. **`message_edits`** — LOW PRIORITY
- **Why not**: Relates to user message modifications, not bot-sent confirmations

---

## Part 3: Deep Dive — `messaging_customer_information`

### Current State of Documentation
- **Confirmed to exist**: Yes — listed in official Page webhooks reference
- **What payload includes**: Sender ID, recipient ID, timestamp, screen responses (key-value pairs describing what the user entered)
- **When introduced**: Unknown — not found in accessible changelog
- **What permissions**: `pages_manage_metadata` (same as all other messaging fields)

### Hypothesis Support
The field name itself (`messaging_customer_information`) aligns with:
1. **PII segregation**: Meta moving sensitive data (like phone numbers) to a dedicated field
2. **Regulatory/policy alignment**: A separate "customer information" webhook suggests legal/compliance review moved phone numbers out of general message echoes
3. **Payload structure**: "Screen responses" as key-value pairs exactly matches what a `user_phone_number` quick reply input would produce

### Critical Gap
**We cannot confirm this via public documentation** because:
- The full payload schema for `messaging_customer_information` is NOT accessible in Meta's current public docs
- No changelog entries document when this field was introduced or if it was repurposed in 2025-2026
- No documentation confirms whether it actually receives quick-reply responses or only "customer information forms" (a potentially different feature)

---

## Part 4: Subscribe-vs-Receive Logic

### Current Understanding
All Page-level webhook fields require:
1. **App-level permission**: `pages_manage_metadata` (manages metadata for Pages the app has admin access to)
2. **Page-level subscription**: Admin must explicitly check the field in the webhook subscription UI ("Add Subscriptions" button)
3. **No advanced-access requirement apparent**: Unlike some Graph API endpoints, standard messaging webhooks don't appear to require separate advanced-access feature reviews

### Important Caveat
The Meta developer portal documentation repeatedly returned **404/error pages** during this research. It's possible that:
- Some fields DO require advanced-access feature reviews (not documented publicly)
- New PII-segregated fields like `messaging_customer_information` might require explicit opt-in or special permissions
- The exact opt-in flow may have changed in 2025-2026 without public changelog entries

---

## Part 5: Recommendations

### Immediate Actions (Free to Try — No Risk)
1. **Subscribe to `messaging_customer_information`** in the webhook UI if it's available in the "Add Subscriptions" menu
   - This is the strongest candidate for receiving phone number responses
   - If we're not subscribed and Meta DID move phone echoes there, this would immediately restore data flow
   
2. **Verify subscription status**: Check if `message_template_status_update` (currently subscribed) is still delivering data, as a control test to confirm our subscription mechanism is working

3. **Audit logs**: Check if we ever received `messaging_customer_information` events in 2024-early 2026, even if we didn't explicitly subscribe

### If Immediate Actions Don't Work
4. **Search Meta Support**: Ask Meta directly whether phone number quick-reply confirmations moved to a new webhook field, and if so, which one and what permissions it requires
   
5. **Check advanced-access requirements**: Determine if `messaging_customer_information` (or any new PII-related field) requires a feature review or special declaration in the app's feature permissions

### Fields to Monitor Going Forward
- `call_permission_reply` — mentions "consent tracking," suggests PII-consciousness
- Any new field introduced in 2026 with "information," "consent," "data," or "privacy" in the name

---

## Sources

### Primary Documentation (Attempted)
- [Page Webhook Reference](https://developers.facebook.com/docs/graph-api/webhooks/reference/page/) — **CURRENTLY INACCESSIBLE** as of 2026-05-25
- [Messenger Platform Webhooks](https://developers.facebook.com/docs/messenger-platform/webhooks) — **CURRENTLY INACCESSIBLE**
- [Messenger Platform Reference](https://developers.facebook.com/docs/messenger-platform/reference) — **PARTIAL DATA ONLY**
- [Graph API Changelog](https://developers.facebook.com/docs/graph-api/changelog) — Directory structure only; individual version pages not accessible

### Accessible References
- [Messenger Platform Webhook Events Index](https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/)
- [Facebook Messenger Webhook: 2026 Dev Guide](https://messengerbot.app/facebook-messenger-webhook-setup-2026-developer-guide-for-receiving-and-responding-to-messages/)
- [Message Deliveries Documentation](https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-deliveries/)
- [Message Reads Documentation](https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-reads/)
- [Quick Replies Documentation](https://developers.facebook.com/docs/messenger-platform/reference/buttons/quick-replies)
- [Messaging Postbacks](https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messaging_postbacks/)

### Web Search Results (No Longer Accessible)
- Search: `messaging_customer_information facebook messenger webhook` — returned Meta docs links, but content not accessible
- Search: `messenger user_phone_number quick replies webhook confirmation echo` — returned quick-reply docs but not echo-related confirmations
- Search: `call_permission_reply OR message_context facebook webhook what does it deliver` — returned mostly error pages

---

## Conclusion

**Status of Hypothesis**: UNCONFIRMED but PLAUSIBLE

The existence of `messaging_customer_information` in Meta's current webhook field list strongly suggests that Facebook has created a dedicated channel for customer data (including phone numbers). However, **we cannot definitively confirm via public documentation** that:

1. This field actually receives phone-number quick-reply responses
2. It was introduced/repurposed specifically to replace `message_echoes` for PII
3. Subscribing to it alone will restore the missing echo data

**Recommended immediate next step**: (a) Add `messaging_customer_information` to our subscribed fields if not already present, (b) monitor for events, and (c) contact Meta support if the hypothesis is still unconfirmed after 48 hours of monitoring.

---

## Appendix: Fields We Were Unable to Document

The following fields were mentioned in search results but lack public documentation:
- `message_template_status_update` (currently subscribed, but no accessible docs found)
- Potential PII-related fields: `call_permission_reply` (mentioned but not defined)
- Any fields introduced in v25.0 (Feb 2026) — changelog inaccessible

