# Facebook Messenger Echo Events Investigation
## Is Facebook Suppressing `is_echo: true` for `user_phone_number` Quick Replies?

**Investigation Date:** May 24, 2026  
**Status:** Findings compiled from public documentation, changelogs, and developer community

---

## Executive Summary

Facebook's public documentation is **unclear or silent** on whether messages with `user_phone_number` quick replies should trigger `message_echoes` webhook events. The official `message_echoes` documentation page is currently inaccessible. Multiple historical developer community forum threads report permission errors when subscribing to the `message_echoes` webhook field. **No evidence found of a recent Facebook-side change intentionally suppressing echoes for this message type** — however, the ambiguity in documentation leaves this unclear.

---

## Key Findings

### 1. Official Documentation Status

#### message_echoes Webhook Page
- **URL:** https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-echoes
- **Status:** Currently returns "Your Request Couldn't be Processed" error
- **Impact:** Developers cannot access the authoritative definition of when echoes are triggered, what message types are included, or if exceptions exist for quick replies

#### user_phone_number Quick Reply Documentation
- **URL:** https://developers.facebook.com/docs/messenger-platform/send-messages/quick-replies
- **Status:** Also returns error (appears intermittent)
- **What we know:** When the `user_phone_number` quick reply is sent, Facebook automatically pre-fills it with the user's profile phone number. When tapped, the number appears in the webhook event's `payload` field
- **Echo behavior:** **NOT documented** — no mention in available documentation whether this quick reply type triggers `is_echo: true` events

#### Send API Documentation
- **URL:** https://developers.facebook.com/docs/messenger-platform/reference/send-api
- **Status:** Accessible
- **Notable:** The Send API does not return `recipient_id` for messages sent via `recipient.user_ref` or `recipient.phone_number`. This suggests special handling for phone-number-related messaging, but does not address echo behavior

### 2. Recent Changelog Entries (2025-2026)

From [Meta Graph API Changelog](https://developers.facebook.com/docs/graph-api/changelog) and [Messenger Platform Changelog](https://developers.facebook.com/docs/messenger-platform/changelog):

- **April 27, 2026:** Deprecated message tags `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` now return error 100. No mention of `message_echoes` changes.
- **2025:** `message_echoes` webhook payload updated to include appointment data when a business responds to an appointment. Updates also added `reply_to` object with `is_self_reply` flag to message and echo webhooks.
- **No specific changelog entry found** documenting changes to echo behavior for quick replies or `user_phone_number` specifically

**Key observations:**
- The recent changelog shows `message_echoes` is actively maintained and enhanced
- No deprecation of `message_echoes` found
- No documented changes affecting quick reply echo behavior

### 3. Developer Community Reports

Multiple historical forum threads (2-3 years old, still unresolved):

| Thread | Topic | Status |
|--------|-------|--------|
| [1337589180810120](https://developers.facebook.com/community/threads/1337589180810120/) | "Can't subscribe to some webhook fields (message_echoes...)" | ~1 year ago, no resolution provided |
| [379395684688385](https://developers.facebook.com/community/threads/379395684688385/) | "Error subscribing to message_echoes" | ~2 years ago; error code 1929002 "Invalid Permissions" |
| [780793213656751](https://developers.facebook.com/community/threads/780793213656751/) | "We can't subscribe to message_echoes and..." | ~2 years ago, permission errors; docs didn't specify required permissions |

**Pattern:** Developers report permission errors when subscribing to `message_echoes`, but these are longstanding issues, not recent changes. No specific complaints about missing echoes for `user_phone_number` quick replies found.

### 4. GitHub Issues on Messenger Libraries

Searched popular libraries (facebook-messenger, restfb, Botpress Messenger):
- GitHub issue [#151](https://github.com/jgorset/facebook-messenger/issues/151) (May 2017): User wanted to implement `message_echo` webhook; documentation discouraged it; no dedicated handler in the library at that time
- GitHub issue [#861](https://github.com/restfb/restfb/issues/861) (March 2018): Request for support for new quick reply types: `user_phone_number` and `user_email`; **no mention of echo behavior**
- **No recent GitHub issues (2025-2026)** found reporting missing echoes for phone/email quick replies

### 5. Quick Reply Types Documentation

From available Meta Developers documentation:

**Supported quick reply content types:**
- `text`
- `location`
- `user_phone_number`
- `user_email`
- `user_ref`

**Behavior for user_phone_number / user_email:**
- If the user's profile lacks the field, the quick reply won't display
- When tapped, the payload appears in the messages webhook with `quick_reply` field
- **Echo behavior:** Not explicitly documented in any source reviewed

---

## What Facebook's Documentation DOES NOT Say

The following are **silent** in public documentation:

1. **Explicit list of message types that trigger echoes** — Only the existence of `message_echoes` webhook is documented; conditions are absent
2. **Exceptions or suppressions** — No documented cases where certain message content (e.g., sensitive data) suppresses echoes
3. **Quick reply interaction with echoes** — No documentation connecting quick reply types to echo behavior
4. **Differences between text messages and quick-reply messages** — Webhook payload structure is different, but echo behavior equivalence is not stated

---

## Documented Echo Behavior (from available sources)

From [Facebook Messenger Webhook documentation](https://developers.facebook.com/docs/messenger-platform/webhooks) and developer guides:

- `message_echoes` is a subscribable webhook event type
- Used to sync outbound transcripts (confirm what the bot sent)
- Returns `app_id` (if multiple apps are subscribed to the page)
- Includes appointment data if the message is an appointment response (2025+ addition)
- **When exactly it triggers:** Not explicitly stated in accessible docs

---

## Status Page & Incidents

[Meta Developer Status Dashboard](https://developers.facebook.com/status/dashboard/):
- **Status:** Returns HTTP 404 Not Found
- Could not verify if there have been recent Messenger webhook incidents

---

## Most Likely Hypothesis

**Based on available evidence, a Facebook-side intentional suppression is UNLIKELY, but possible causes are:**

1. **Documentation gap, not a feature change** — The most likely scenario
   - `message_echoes` documentation is inaccessible, creating uncertainty
   - Developers cannot confirm whether quick-reply-only messages should echo
   - The Send API treats phone-number-based sends specially (doesn't return `recipient_id`), which *might* extend to echo behavior, but this is speculative

2. **Silent server-side change** — Possible but undocumented
   - Recent changelogs (2025-2026) show `message_echoes` actively maintained
   - No changelog entry mentions removing echoes for any message type
   - If changed, Facebook would likely document it (as they did for appointment data)

3. **Permission/configuration issue** — Possible, similar to historical reports
   - Long-standing forum threads show developers unable to subscribe to `message_echoes` due to permission errors
   - Could also affect delivery of echoes for certain message types

4. **Message-type-specific behavior** — Possible but undocumented
   - Quick replies with sensitive data (`user_phone_number`, `user_email`) might have special handling
   - No public documentation supports this; Send API behavior suggests possible distinction (lacks recipient_id return)

---

## What Needs Confirmation

To definitively rule in/out Facebook changes, you'll need to:

1. **Test against a staging/test Facebook Page:**
   - Send a message with plain text → verify `is_echo: true` received
   - Send a message with `quick_replies: [{content_type: "text"}]` → verify echo
   - Send a message with `quick_replies: [{content_type: "user_phone_number"}]` → verify echo status
   - Repeat with `user_email`
   - Compare timestamps and webhook delivery logs

2. **Open a Facebook Developer Support ticket** asking:
   - "Are `message_echoes` webhooks expected for messages with `user_phone_number` quick replies?"
   - "Has echo behavior for quick replies changed in the last 6 months?"
   - Request access to the `message_echoes` reference documentation

3. **Check app permission requirements:**
   - Verify your app has `pages_messaging` permission (required for echoes)
   - Verify webhook subscription includes `message_echoes` without permission errors
   - Check if phone-number-related sends require additional permissions

---

## Sources

- [Meta Developers: Messenger Platform Changelog](https://developers.facebook.com/docs/messenger-platform/changelog/)
- [Meta Developers: Graph API Changelog v25.0](https://developers.facebook.com/docs/graph-api/changelog/version25.0/)
- [Meta Developers: Message Echoes Reference](https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-echoes) (currently inaccessible)
- [Meta Developers: Quick Replies Documentation](https://developers.facebook.com/docs/messenger-platform/send-messages/quick-replies/) (currently intermittently inaccessible)
- [Meta Developers: Send API Reference](https://developers.facebook.com/docs/messenger-platform/reference/send-api/)
- [Meta Community: Error Subscribing to message_echoes](https://developers.facebook.com/community/threads/379395684688385/) (2022-2024 reports)
- [GitHub: facebook-messenger Issue #151](https://github.com/jgorset/facebook-messenger/issues/151)
- [GitHub: restfb Issue #861](https://github.com/restfb/restfb/issues/861)

---

## Recommendation

**This appears to be an undocumented behavior or a documentation gap rather than a recent intentional Facebook change.** However, the inaccessible documentation makes it impossible to confirm. The next step is empirical testing against a live Facebook Page to determine if echoes are suppressed for `user_phone_number` quick replies, combined with a support ticket to Facebook to request clarification.
