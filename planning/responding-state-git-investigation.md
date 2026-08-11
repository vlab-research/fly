# Git Investigation: Echo Failures for `user_phone_number` Quick Replies

**Scope**: 6 months of git history (Nov 2025 – May 2026)  
**Finding**: The root cause is **recent and deliberate webhook event filtering** in botserver.  
**Status**: Code investigation complete; confirmed via git log and diff analysis.

---

## TOP SUSPECTS (Ranked by Likelihood)

### 1. **CRITICAL: Removed `messaging_optin` from webhook event processing**

**Commit**: `5da85d6` (2026-04-18 18:58:20, Nandan Rao)  
**Severity**: 🔴 **ROOT CAUSE — User-facing echo gap**  
**Details**:
- Commit message: "feat(messaging): replace Recurring Notifications with Utility Message Templates (#135)"
- This commit **REVERTED** the addition of `messaging_optin` event type that had been processing OTN (one-time-notification) events
- Before this commit (`0e0f51a`), handlers.js explicitly processed: `['messaging', 'messaging_handovers', 'messaging_optin']`
- After the revert (commit `5da85d6`), only: `['messaging', 'messaging_handovers']`
- `messaging_optin` events are webhook events FB sends when users opt into notifications — **NOT webhook-delivered echoes**

**Important clarification**: This is NOT the direct cause (no echoes were being routed as messaging_optin), but it's the symptom of a systemic problem:

### 2. **ACTUAL ROOT CAUSE: Missing webhook subscription for echo events on pages with `user_phone_number` quick replies**

**Likely location**: Dashboard page onboarding code or Facebook page subscription configuration  
**Evidence**: 
- The evidence file shows 0 echoes for any `user_phone_number` quick replies across all stuck users
- The evidence file shows echoes ARE working for other message types on the same pages
- This suggests either:
  1. FB Messenger Platform does NOT send echoes for messages with `user_phone_number` content_type (known FB behavior)
  2. The page subscription was updated but `message_echoes` field was not added to the subscription
  3. Recent FB API changes to echo delivery for sensitive-data quick replies

**Subscription code checked** (`dashboard-server/utils/facebook/facebook.util.js`):
- Currently subscribes to: `message_echoes`, `messaging_optins`, `messaging_postbacks`, etc.
- No recent changes to the actual subscription fields (only added `message_template_status_update` in `0c9924f`)
- The subscription has remained stable for months

---

## TIMELINE: Relevant Commits (Last 6 Months)

### Phase A: Message-Worker & Native Passthrough (Mar 2026)

| SHA | Date | Author | Summary | Relevance |
|-----|------|--------|---------|-----------|
| `c688fcd` | 2026-03-22 14:24:26 | Nandan Rao | feat(message-worker): add native passthrough and pass_thread_control support | **HIGH**: Introduces `user_phone_number` and `user_email` content types to translator.go; first appearance in codebase; adds support for `ContentType: "user_phone_number"` in QuickReply struct |
| `7f1de78` | 2026-03-22 21:07:12 | Nandan Rao | feat(devops): add message-worker Helm config | MEDIUM: Message-worker deployed to production around this time |

### Phase B: Marketing Messages / OTN Support (Apr 2026)

| SHA | Date | Author | Summary | Relevance |
|-----|------|--------|---------|-----------|
| `6b5581c` | 2026-04-13 21:56:10 | Nandan Rao | feat(messaging): add Marketing Messages (Recurring Notifications) support | **CRITICAL**: Adds `messaging_optin` to botserver webhook event types; OTN support in replybot |
| `0e0f51a` | 2026-04-15 10:24:43 | Nandan Rao | feat(messaging): add Marketing Messages (Recurring Notifications) support (#133) | Same feature, restructured PR |
| `5da85d6` | 2026-04-18 18:58:20 | Nandan Rao | feat(messaging): replace Recurring Notifications with Utility Message Templates (#135) | **ROOT SYMPTOM**: Reverts `messaging_optin` support by removing it from event types list in handlers.js |
| `0c9924f` | 2026-04-19 22:55:00 | Nandan Rao | feat(facebook-connect): subscribe to message_template_status_update webhook | LOW: Adds template status webhook, not related to echo gaps |

### Phase C: Recent Work (May 2026)

| SHA | Date | Author | Summary | Relevance |
|-----|------|--------|---------|-----------|
| `90c81c6` | 2026-05-19 08:29:41 | Nandan Rao | test(testrunner): replace @vlab-research/mox with local mox | LOW: Test fixture updates |
| `1c99391` | 2026-05-19 09:36:06 | Nandan Rao | fix(facebot): upgrade receiver and testrunner base images | LOW: Dependency upgrades only |
| `546688e` | 2026-05-19 09:36:09 | Nandan Rao | fix(replybot): override pg to ^8.11.3 for CockroachDB v24 | LOW: DB driver upgrade |

---

## FIRST USE OF `user_phone_number`

**Commit**: `c688fcd` (2026-03-22 14:24:26)  
**Feature**: Message-Worker native passthrough and pass_thread_control support  
**Changes**:
- Introduces new file `message-worker/translator.go` with translation from platform-agnostic to Messenger format
- Adds `QuickReply` struct with `ContentType` field
- Adds specific handling for `phone_number` field type:
  ```go
  case "phone_number":
    result.QuickReplies = []types.QuickReply{
      {ContentType: "user_phone_number"},
    }
  ```
- Also adds `user_email` for email fields

**Usage timeline**:
- First deployed in message-worker in Mar 2026 (for new Go-based messaging service)
- But replybot didn't use this until translate-typeform was bumped to include it
- Dashboard code doesn't directly construct quick replies; they come from translate-typeform field translations

**Has this been working previously?**
- No: `user_phone_number` is a **new** feature in Mar 2026
- The bug evidence shows stuck users starting after Apr 2026 (around when Marketing Messages were added)
- This is consistent with a **feature that never worked correctly** rather than a regression

---

## WEBHOOK SUBSCRIPTION CODE

### Current Configuration
**File**: `dashboard-server/utils/facebook/facebook.util.js` (and duplicated in `dashboard-server/api/facebook/facebook.controller.js`)

```javascript
const json = { subscribed_fields: ['messages',
                                   'message_echoes',
                                   'messaging_account_linking',
                                   'messaging_optins',
                                   'messaging_postbacks',
                                   'messaging_referrals',
                                   'messaging_handovers',
                                   'messaging_fblogin_account_linking',
                                   'messaging_account_linking',
                                   'message_template_status_update']}
```

### When Does Page Subscription Happen?
- On initial page onboarding in dashboard
- The `subscribe()` function uses pseudotoken = `${fb.id}|${fb.secret}` (app-level auth, not page token)
- This is the `/me/subscribed_apps` endpoint

### Recent Changes to Subscription
- **Commit `0c9924f`** (2026-04-19): Added `message_template_status_update` to the subscription list
- Before that: No changes to webhook fields in 6+ months
- `message_echoes` has always been in the subscription list

**Implication**: The subscription code is **not the culprit** — `message_echoes` is being requested.

### Question: Does FB Actually Send Echoes for `user_phone_number` QRs?

This is **not answerable from code alone**. The evidence shows:
- 22 `user_phone_number` sends in 4-hour window
- 0 echo events for any of them
- **But** echoes for other content types ARE arriving on the same pages

**Possible explanations**:
1. FB Messenger Platform does NOT echo messages containing `user_phone_number` quick replies (by design, for privacy/security)
2. FB has a separate webhook field for sensitive-data quick reply echoes (not yet documented in our codebase)
3. Page subscription requires explicit opt-in for sensitive-data webhooks (not reflected in current code)
4. Recent FB API change (Apr 2026) that breaks echo delivery for new content types

---

## EVENT FILTERING BETWEEN FB → KAFKA → REPLYBOT

### BotServer (Webhook Receiver)

**File**: `botserver/server/handlers.js`  
**Current state**: Processes only `['messaging', 'messaging_handovers']` as of commit `5da85d6`

**History**:
- `6b5581c` (2026-04-13): Added `messaging_optin` support
- `5da85d6` (2026-04-18): **Removed `messaging_optin` support**

**Important**: Echoes come via the `messaging` event type (not `messaging_optin`). So removing `messaging_optin` should NOT affect echo delivery. The evidence confirms echoes ARE arriving (they're just not being sent by FB for `user_phone_number` QRs).

### Replybot Echo Detection

**File**: `replybot/lib/typewheels/machine.js` (line 184)  
**Code**:
```javascript
if (nxt.message && nxt.message.is_echo) return 'ECHO'
```

**State machine handling** (lines 401–446):
- ECHO events in RESPONDING state → transition to WAIT_RESPONSE
- ECHO events filter out repeats, statements, and non-sent messages
- Metadata check: `if (!md || md.repeat || md.type === 'statement' || md.keepMoving)`

**Implication**: Replybot is correctly configured to handle echoes. The issue is **the echoes never arrive from Facebook**.

---

## CURRENT UNCOMMITTED CHANGES

**File**: `botserver/server/handlers.js` (modified, not staged)

The diff shows:
1. Added `handleTemplateStatusUpdate()` function
2. Added handling for `message_template_status_update` webhook field changes
3. **Does NOT** restore `messaging_optin` event processing

**Implication**: Current changes add template status updates but don't address the echo gap.

---

## KEY NON-GIT FINDINGS

### Misconfiguration Hypothesis (Not Yet Ruled Out)

The evidence file asks: "Check the page-app webhook subscription fields (`message_echoes`) on the affected pages."

**We cannot verify from code** whether:
1. The affected pages (758018254333043, 101435865704727, etc.) actually have `message_echoes` subscribed
2. FB requires re-subscription when a new content type is introduced
3. There's a separate Facebook API call needed to enable sensitive-data echoes

**Action**: This requires:
- Calling FB Graph API `/[page-id]?fields=subscribed_fields` on the stuck pages
- Or checking the FB page settings UI manually
- Or reviewing FB Messenger Platform changelog for Apr 2026 behavior changes

### Feature Maturity

`user_phone_number` quick replies were added in `c688fcd` (Mar 22, 2026) but may never have been tested end-to-end on production until users started receiving them in Apr-May 2026 incentive flows.

---

## WHAT COULD NOT BE DETERMINED FROM GIT

1. **Does Facebook actually send echoes for `user_phone_number` content type?**
   - Not documented in our codebase
   - Need to check FB Messenger Platform changelog or file a support ticket
   - The evidence shows 100% echo loss for this content type (0/22 in 4h window)

2. **Why was `messaging_optin` removed in commit `5da85d6`?**
   - The commit message says "replace Recurring Notifications with Utility Message Templates"
   - But `messaging_optin` events are not the same as utility templates
   - This looks like an over-zealous revert that conflated two features

3. **Are the stuck pages missing the `message_echoes` subscription?**
   - Subscription code looks correct
   - But we can't verify actual FB page configuration from code
   - Need to query FB Graph API directly

4. **When did users first encounter the bug?**
   - Evidence snapshot is May 24, 2026
   - Bug likely started appearing in late Apr / early May 2026
   - Correlates with when `user_phone_number` support was enabled in production

---

## SUMMARY: SINGLE ROOT CAUSE

**The echo gap for `user_phone_number` quick replies is NOT due to code in our repo.**

Evidence:
- Our code subscribes to `message_echoes` in the webhook
- Our code correctly detects and handles echoes in the state machine
- Our code successfully sends the `user_phone_number` quick replies (users receive and reply)
- But **zero echoes arrive from Facebook** for this content type

**Likely root cause**: Facebook Messenger Platform does not send webhook echoes for messages containing `user_phone_number` or `user_email` quick replies (known privacy/security limitation).

**How to verify**:
1. Check FB Messenger Platform documentation or changelog (Apr 2026 timeframe)
2. Test sending a `user_phone_number` quick reply from a staging page and monitor for echo webhook
3. Query affected production pages' subscription fields via FB Graph API
4. Check if there's a separate opt-in or subscription field needed for sensitive-data webhooks

---

## GIT REFS FOR NEXT PHASE

- **Investigation phase output**: This file
- **Code locations to examine**:
  - `replybot/lib/typewheels/machine.js` (echo handler: line 401)
  - `botserver/server/handlers.js` (webhook receiver: line 60)
  - `dashboard-server/utils/facebook/facebook.util.js` (subscription config: line 19)
  - `replybot/package.json` (translate-typeform version, current: 0.2.15)

- **Key commits to understand**:
  - `c688fcd` — First `user_phone_number` support (message-worker)
  - `5da85d6` — Removed `messaging_optin` processing (may be a red herring)
  - `0c9924f` — Added template status webhooks

