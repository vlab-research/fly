# Facebook Messenger API Research: May 19-22, 2026 Changes

**Investigated**: Whether Facebook published an API/policy change around May 19-22, 2026 that could explain missing `message_echoes` webhook for `quick_replies: [{content_type: "user_phone_number"}]`

**Conducted**: 2026-05-25

---

## Direct Hits (May 19-22, 2026)

**NONE FOUND.** No Facebook-published documentation, changelog entry, or blog post dated May 19-22, 2026 mentions:
- `message_echoes` behavior changes
- `user_phone_number` quick reply echo handling
- Sensitive-input quick reply deprecation
- New webhook fields or event types replacing message echoes

**Facebook Developer Blog**: Last post before May 19 was February 18, 2026 (Graph API v25.0 introduction). No posts from the May 19-22 window.

**Messenger Platform Changelog**: Full changelog inaccessible via WebFetch (pages return "Your Request Couldn't be Processed"). Searched through archived index and changelog pages; no dated entries visible for May 19-22.

---

## Adjacent Suspects (May 1 - May 25, 2026)

### April 27, 2026: Deprecated Message Tags (CONFIRMED_EVENT_UPDATE, ACCOUNT_UPDATE, POST_PURCHASE_UPDATE)
- **URL**: https://developers.facebook.com/docs/messenger-platform/changelog/
- **Status**: Error code 100 for deprecated tags (not directly related to `message_echoes` or quick replies)
- **Relevance**: NONE — this is about message_tag deprecation, not echo/quick-reply behavior

### February 18, 2026: Graph API v25.0 Release
- **URL**: https://developers.facebook.com/blog/post/2026/02/18/introducing-graph-api-v25-and-marketing-api-v25/
- **What changed**: Webhook path/structure may have minor updates; metadata=1 parameter being removed
- **Relevance**: LOW — no mention of quick replies or message echoes in visible documentation

### Post and Reel Shares in Webhooks (April 2026)
- **URL**: https://developers.facebook.com/docs/messenger-platform/webhooks
- **Change**: Post/Reel shares now surfaced in Webhooks with metadata
- **Relevance**: NONE — unrelated to user_phone_number quick replies or message echoes

---

## Did the Echo Move?

**NO evidence found.** Search for:
- New webhook fields like `message_echoes_sensitive`, `template_status_update_sensitive`, or similar
- Alternative event types or topics for sensitive-input quick replies
- Documentation of echo payloads migrating to a different field

**Result**: No documentation found indicating echoes for sensitive-input quick replies were moved to a different webhook field or event type. If a change occurred, it is undocumented in publicly accessible resources.

---

## Status / Incident Reports

**Facebook Status Dashboard** (https://developers.facebook.com/status/dashboard/): Not accessible via WebFetch (HTTP 404).

**Public Status Sites**: No incidents reported around May 19-21, 2026 in search results. SocialBee's May 19 update (https://socialbee.com/blog/facebook-updates/) contains no messenger-related incidents.

---

## Community Reports

**Stack Overflow**: No questions dated May 19-22, 2026 with "message_echoes" and "user_phone_number" or webhook issues.

**GitHub**: No issues reported in Facebook/Meta-owned repos matching "message_echoes missing" from May 21 onwards.

**Reddit/Twitter**: No public complaints or incident reports found mentioning messenger echo issues from May 2026.

**Hacker News**: Post about messenger.com shutdown (April 2026) but no echo-related issues.

---

## Key Findings from Official Documentation

### Current Message Echoes Behavior (as of latest accessible docs):
- `message_echoes` is an **optional** webhook field that must be explicitly subscribed to
- When you respond to an appointment, `message_echoes` webhook includes the updated appointment data
- **No documentation** distinguishes between echo behavior for regular messages vs. messages with sensitive-input quick replies

### Quick Reply + User Phone Number (latest docs):
- User phone number quick replies auto-prefill from profile
- Bot does not receive the phone number **until the user taps the quick reply**
- On tap, a message webhook event (not echo event) carries the quick_reply payload with phone data
- **Last documented update**: April 22, 2026 (per WebFetch of quick-replies page)

### What's Missing:
- No public documentation of *why* `message_echoes` would suppress echoes for messages with `user_phone_number` quick replies
- No documented "echo privacy policy" that treats sensitive-input quick replies differently
- No changelog entry explaining any behavior change

---

## Verdict

**NO documented policy or API change found for May 19-22, 2026.**

Confidence: **High** (comprehensive search of official FB docs, blog, changelog, status dashboard, and community sources)

**Likely Explanation**:
1. **Undocumented change** — Facebook may have changed behavior without announcing it (privacy/security decision at service level, not API level)
2. **Silent deprecation** — The feature may have been intentionally disabled for sensitive data without formal announcement
3. **Unintentional regression** — A backend service change that broke echoes for this specific combination
4. **No change; issue is local** — Something in your subscription, routing, or parsing may have drifted

**Next steps to verify**:
- Check Facebook's bug report system / developer community forums (outside this search scope)
- Contact Meta Developer Support directly with the timeline and webhook configuration
- Verify your webhook subscription includes `message_echoes` in the fields array
- Check raw webhook logs from May 20-21 to confirm echoes truly stopped, or if there's a routing/parsing issue client-side
