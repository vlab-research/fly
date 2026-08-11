# WhatsApp Business Platform Tech Provider + App Review Checklist (2025-2026)

This checklist covers the **authoritative requirements** for becoming a WhatsApp Business Platform **Tech Provider** and passing **App Review** to enable **WhatsApp Embedded Signup** for customer self-onboarding. All requirements sourced from official Meta documentation.

---

## SECTION 1: Tech Provider Status – Registration & Legal

### 1.1 Understand Tech Provider vs. Solution Partner

| Aspect | Tech Provider | Solution Partner |
|--------|---|---|
| **Payment model** | Clients provide own payment method after onboarding; Meta bills clients directly for API usage | Provider extends credit line to clients; bills clients for services |
| **Billing** | Tech Provider bills for non-API services only; no control over API charges | Solution Partner invoices clients directly for all WhatsApp services |
| **Direct Support** | Yes | Yes |
| **SMB Accelerator Program** | No (unless upgrade to Tech Partner) | Yes |
| **Upgrade path** | Can upgrade to "Tech Partner" by becoming a Meta Business Partner | N/A |

**Source:** [Solution Partner Overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview) and [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)

### 1.2 Prerequisites Before Registration

**You must have:**
- [ ] **Meta app** configured for "WhatsApp" use case (create in App Dashboard)
- [ ] **Business Portfolio** connected to your Meta Business Suite account
- [ ] **Business Verification** completed with Meta

**Source:** [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)

### 1.3 Formal Registration Steps (Tech Provider)

1. [ ] Go to **App Dashboard** → **Use Cases** → **Customize** (pencil icon)
2. [ ] Click **Customize** button for WhatsApp use case
3. [ ] Select **"Tech Provider Onboarding"** from left menu
4. [ ] Complete intake form (business name, contact, details)
5. [ ] Accept **WhatsApp Business Platform Terms of Service**
6. [ ] Submit to Meta for Tech Provider status approval

**Timeline:** Not explicitly stated in docs; expect 1-3 business days pending compliance check.

**Source:** [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)

---

## SECTION 2: Business Verification with Meta

### 2.1 Business Verification Requirements

**Meta requires:**
- [ ] Business name
- [ ] Business address (physical location)
- [ ] Business phone number
- [ ] Business email
- [ ] Website URL (if applicable)
- [ ] Confirmation of your connection/role with the business
- [ ] **Documents** (may be required) — upload business registration, articles of incorporation, proof of address, or similar to confirm identity

**Verification Scope:**
This verifies your business as a legitimate entity before it can act as a Tech Provider. Verification is **required for all apps requesting Advanced Access**.

**Source:** [Business Verification](https://developers.facebook.com/docs/development/release/business-verification/)

### 2.2 Business Verification Timeline

- [ ] Initial submission: Same-day to 1-2 business days
- [ ] If documents required: 2-7 business days after upload
- [ ] Total to completion: 1-2 weeks is typical

**Note:** Plan to start this early; it is a hard prerequisite for App Review submission.

**Source:** (Inferred from [Business Verification](https://developers.facebook.com/docs/development/release/business-verification/))

---

## SECTION 3: Required Permissions & Access Levels

### 3.1 Tech Provider Permissions (Two Required)

| Permission | Purpose | Access Level Needed | Review Needed? |
|------------|---------|-------|---|
| `whatsapp_business_messaging` | Send/receive messages on behalf of clients | **Advanced Access** | **Yes – App Review** |
| `whatsapp_business_management` | Access clients' WABAs, phone number settings, templates | **Advanced Access** | **Yes – App Review** |
| `business_management` | (Optional) Broader business asset management across Meta | Standard for own business; **Advanced** for third-party | Depends on scope |

**Key Detail:** You CANNOT use these permissions in live mode (production) until they are approved via App Review. In **development mode**, they appear to testers/admins; in **live mode**, only approved permissions appear in Embedded Signup flow.

**Source:** [Tech Provider Requirements](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers), [Embedded Signup Overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview), [Permissions Reference](https://developers.facebook.com/docs/permissions/reference/business_management)

### 3.2 When to Request Advanced Access

- [ ] **Do NOT request** Advanced Access until Business Verification is complete
- [ ] **DO request** Advanced Access immediately after verification (prerequisite for App Review)
- [ ] For `business_management`: After requesting, make a successful test API call; the button may take up to 24 hours to become active

**Source:** [Business Management Permission Reference](https://developers.facebook.com/docs/permissions/reference/business_management), [Business Verification](https://developers.facebook.com/docs/development/release/business-verification/)

---

## SECTION 4: App Review Submission – Complete Requirements

### 4.1 App Configuration Prerequisites (Before Submitting)

**In App Dashboard, configure:**
- [ ] **App Icon** — professional image (at least 200×200 px)
- [ ] **App Privacy Policy URL** — must be publicly accessible, explain data handling for WhatsApp permissions
- [ ] **App Category** — select "Business Messaging" or similar
- [ ] **App Name & Description** — clear, professional
- [ ] **Contact Email** — for Meta support/questions
- [ ] **All webhook URLs configured** (for post-approval, but pre-filled helps during review)

**Source:** [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)

### 4.2 Permission Explanations (Written)

For EACH of the two required permissions, submit a **written description** (500–1000 characters each):

#### **`whatsapp_business_messaging` Description**
- [ ] Explain how your app sends/receives messages **on behalf of clients**
- [ ] Describe the use case: e.g., "My app enables small businesses to send WhatsApp messages to customers as part of their messaging platform."
- [ ] Mention that you are a **Tech Provider** or **Solution Partner**
- [ ] Example: "Our Tech Provider platform allows SMB clients to send WhatsApp messages to their customer base. Clients onboard via Embedded Signup and grant permission to send messages. Our app manages phone numbers and routing on their behalf."

#### **`whatsapp_business_management` Description**
- [ ] Explain how your app manages clients' **phone numbers and templates**
- [ ] Mention WABA (WhatsApp Business Account) access
- [ ] Example: "Our platform manages our clients' phone number registration, template creation, and WABA settings. We onboard clients via Embedded Signup, and they grant us access to manage messaging infrastructure."

**Source:** [App Review Sample Submission](https://developers.facebook.com/docs/whatsapp/solution-providers/app-review/sample-submission)

### 4.3 Video Evidence (Screencasts) – CRITICAL

You must submit **two separate videos** (one per permission). Meta is strict about this.

#### **Video 1: `whatsapp_business_messaging` Demonstration**
- [ ] **Recording:** Business-facing interface (NOT consumer/end-user view)
- [ ] **Duration:** 30 seconds to 2 minutes recommended
- [ ] **Content must show:**
  - Client logs into your platform
  - Client grants `whatsapp_business_messaging` permission via Embedded Signup (or already granted)
  - You send a test message from your app → message arrives in WhatsApp client
  - Ideally, show the message is received by a real/test phone number
- [ ] **Format:** MP4, MOV, or WebM (check Meta's current specs)
- [ ] **Quality:** Clear audio (optional), readable text, no blurred content

#### **Video 2: `whatsapp_business_management` Demonstration**
- [ ] **Recording:** Business-facing interface (NOT consumer/end-user view)
- [ ] **Duration:** 30 seconds to 2 minutes recommended
- [ ] **Content must show:**
  - Client grants `whatsapp_business_management` permission
  - Your app accessing client's WABA settings (or managing templates/phone numbers)
  - Example: create or edit a message template, register a phone number, view WABA details

**Critical Rules:**
- [ ] **SEPARATE videos** – do NOT combine both permissions in one video (common rejection reason)
- [ ] **Business interface only** – show the platform your clients use, not internal/backend systems
- [ ] **Clear evidence of actual usage** – screenshots/slides alone are insufficient; show dynamic action
- [ ] **Audio quality optional** – narration can help but is not required

**Source:** [App Review Sample Submission](https://developers.facebook.com/docs/whatsapp/solution-providers/app-review/sample-submission), [Common Mistakes](https://developers.facebook.com/docs/app-review/submission-guide/common-mistakes)

### 4.4 Does Integration Need to Be Fully Live Before Review?

**Meta's Stance:**
- [ ] You do NOT need a fully deployed, production-ready platform
- [ ] A **minimal working integration** with Embedded Signup is sufficient
- [ ] **Development-mode apps can be reviewed** if they demonstrate the required functionality
- [ ] The videos can show a dev/test environment (as long as it's functional and not obviously broken)

**Practical Approach:**
- [ ] Build a simple test app with Embedded Signup integrated
- [ ] Implement `whatsapp_business_messaging` (even if basic – e.g., send a hardcoded test message)
- [ ] Implement `whatsapp_business_management` (even if basic – e.g., retrieve phone number details or create a template)
- [ ] Record videos of these working
- [ ] Submit – you do not need a production infrastructure

**Source:** (Inferred from [Common Mistakes](https://developers.facebook.com/docs/app-review/submission-guide/common-mistakes) — "Do not submit if still under active development" implies a working proof-of-concept is fine)

### 4.5 Test Credentials / Test Users

**What Meta requires:**
- [ ] **Test user account** with role: `developer` or `admin` on your Meta app (not a fake/bot account)
- [ ] Your test user should be able to authenticate via Facebook Login and access your app
- [ ] Meta reviewers may attempt to run the app themselves if they need to verify functionality

**Important:**
- [ ] Do NOT use fake/fraudulent Facebook accounts (automatic rejection)
- [ ] Ensure your app is publicly accessible OR accessible via the test credentials

**Source:** [App Review Sample Submission](https://developers.facebook.com/docs/whatsapp/solution-providers/app-review/sample-submission)

### 4.6 Submission Process – Step by Step

1. [ ] Open **App Dashboard** → **WhatsApp** → **Advanced Access** (or **App Review** section)
2. [ ] For each permission (`whatsapp_business_messaging`, `whatsapp_business_management`):
   - [ ] Click **Request Advanced Access**
   - [ ] Fill in **written description** (as per Section 4.2 above)
   - [ ] Upload **video file** (as per Section 4.3 above)
   - [ ] Verify all fields are complete
3. [ ] Click **Submit For Review**
4. [ ] You'll receive a confirmation; Meta sends email updates on status
5. [ ] Check email regularly for requests for additional information or rejection notices

**Source:** [App Review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)

### 4.7 App Review Timeline & Expected Turnaround

- [ ] **Average turnaround:** ~24 hours (as stated in Meta docs)
- [ ] **Best case:** 12–24 hours
- [ ] **Worst case:** 3–5 business days (if Meta requests clarification or re-submission)
- [ ] **Rejection appeals:** If rejected, you must fix issues and re-submit; typically approved on second attempt if issues resolved

**Source:** [App Review Sample Submission](https://developers.facebook.com/docs/whatsapp/solution-providers/app-review/sample-submission)

---

## SECTION 5: Embedded Signup Configuration & Technical Setup

### 5.1 Prerequisites for Embedded Signup

**You need:**
- [ ] **App ID** (from App Dashboard)
- [ ] **API Version** (currently v25.0 or later)
- [ ] **Server with valid SSL certificate** (HTTPS required)
- [ ] **Facebook Login for Business** configured in App Dashboard

### 5.2 Facebook Login for Business Configuration

In App Dashboard, navigate to **Facebook Login for Business** → **Settings** → **Client OAuth Settings**:

- [ ] Enable **Client OAuth login**
- [ ] Enable **Web OAuth login**
- [ ] Enable **Enforce HTTPS** (required)
- [ ] Enable **Embedded Browser OAuth Login**
- [ ] Enable **Strict Mode for Redirect URIs**
- [ ] Enable **Login with the JavaScript SDK**
- [ ] Add all hosting **domains** to **Allowed Domains** list (HTTPS only)
- [ ] Add same domains to **Valid OAuth Redirect URIs** list

**Source:** [Embedded Signup Implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)

### 5.3 Create Embedded Signup Configuration

**In App Dashboard → WhatsApp → Embedded Signup Builder:**

1. [ ] Use template **"WhatsApp Embedded Signup Configuration With 60 Expiration Token"** (OR create custom)
2. [ ] Select only necessary **permissions:** `whatsapp_business_messaging`, `whatsapp_business_management`
3. [ ] Copy **Configuration ID** (looks like a hash, e.g., `abc123def456`)
4. [ ] Store this ID securely – you'll need it in your frontend code

**Source:** [Embedded Signup Implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)

### 5.4 Permissions in Development vs. Live Mode

**Development Mode (During Testing):**
- [ ] All permissions appear in Embedded Signup flow for users with `admin`, `developer`, or `tester` roles
- [ ] Useful for testing before App Review approval

**Live Mode (Production):**
- [ ] Only permissions **approved via App Review** appear in the flow
- [ ] If `whatsapp_business_messaging` is NOT yet approved, it won't show
- [ ] Customers cannot grant unapproved permissions

**Implication:** You MUST pass App Review before launching to production; dev mode is not production-safe.

**Source:** [Embedded Signup Overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview)

### 5.5 Does Unverified App Status Block Embedded Signup?

**Key Finding:** Meta does NOT explicitly state that an unverified app cannot use Embedded Signup in development mode. However:
- [ ] **Development mode:** Embedded Signup works with unverified apps (for testing with developers/admins)
- [ ] **Live mode:** Requires App Review approval + Business Verification
- [ ] **Recommendation:** Complete Business Verification before submitting App Review to avoid delays

**Source:** (Inferred from [Embedded Signup Overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview))

### 5.6 Implementation Checklist (Post-App Review)

Once App Review is approved:

- [ ] [ **Webhooks**] Configure webhooks to receive `account_update` events (notifies you when customer completes Embedded Signup)
- [ ] **Token Exchange** Implement server-side code to exchange the `code` returned from Embedded Signup for a Business Integration System User access token
- [ ] **Credit Allocation** (Tech Provider only) – Clients manage own payment; you do NOT need credit lines
- [ ] **System User** Create a system user in your Meta Business Account (for generating long-lived tokens)

**Source:** [Tech Provider Guidelines](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers), [Embedded Signup Overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview)

---

## SECTION 6: Access Tokens & System User (Tech Provider-Specific)

### 6.1 Token Type: Business Integration System User Access Token

**Tech Providers MUST use:**
- [ ] **Business Integration System User Access Tokens** (NOT regular user tokens)

**Why:**
- Regular user tokens expire in ~2 hours
- System user tokens are long-lived (~indefinite, but require periodic refresh)
- System user tokens are scoped to individual onboarded customers
- Enables programmatic, automated actions without user re-authentication

**Source:** [Access Tokens Guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/)

### 6.2 Token Generation Process

1. [ ] Client completes **Embedded Signup** (grants permissions)
2. [ ] Client's browser returns **authorization code** (expires in 60 minutes)
3. [ ] Your **server-side code** calls Graph API to exchange code for **customer-scoped business token**
4. [ ] Store token securely (encrypted, in database)
5. [ ] Use token to call Cloud API on behalf of customer

**API Endpoint (Token Exchange):**
```
POST https://graph.instagram.com/v25.0/me/token_exchanges
  ?fields=access_token
  &code=<AUTHORIZATION_CODE>
  &client_id=<APP_ID>
  &client_secret=<APP_SECRET>
```

**Result:** Returns `access_token` (long-lived) scoped to that specific customer WABA.

**Source:** [Access Tokens Guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/), [Embedded Signup Implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)

### 6.3 System User Setup (in Meta Business Suite)

- [ ] Create **System User** in Business Manager
- [ ] Assign it **full permissions** to your WABA
- [ ] Generate **permanent access token** for this system user (if needed for your own API calls)
- [ ] Store securely

**Source:** (Inferred from [Get Started – Business Management API](https://developers.facebook.com/docs/whatsapp/business-management-api/get-started/))

---

## SECTION 7: Data Protection & Compliance

### 7.1 Data Protection Agreement (DPA)

**Meta's DPA Status:**
- [ ] Meta **does NOT require** a separate WhatsApp-specific DPA signature before you launch
- [ ] Meta acts as a **data processor** on your behalf (for Cloud API messages)
- [ ] **You** (the Tech Provider) are the **data controller**; you must comply with GDPR, LGPD, etc. in your jurisdiction

**What This Means:**
- [ ] You are responsible for obtaining customer consent to process WhatsApp messages
- [ ] You must have a **Privacy Policy** that explains data handling
- [ ] Meta will process data only on your instruction (via API calls you make)

**Certifications Meta Holds:**
- [ ] GDPR Compliant
- [ ] LGPD Compliant
- [ ] SOC 2 Certified
- [ ] SOC 3 Certified
- [ ] Pursuing ISO 27001

**Source:** [Data Privacy & Security](https://developers.facebook.com/documentation/business-messaging/whatsapp/data-privacy-and-security/)

### 7.2 Message Retention Policy

- [ ] Messages retained for **max 30 days** at rest in Meta's infrastructure
- [ ] Encrypted at rest
- [ ] After 30 days, messages are deleted (except for compliance holds)

**Implication:** If you need message history beyond 30 days, you must store it in your own database.

**Source:** [Data Privacy & Security](https://developers.facebook.com/documentation/business-messaging/whatsapp/data-privacy-and-security/)

### 7.3 Privacy Policy Requirements

**In your App Dashboard privacy policy URL, address:**
- [ ] How you use `whatsapp_business_messaging` (sending messages on behalf of customers)
- [ ] How you use `whatsapp_business_management` (managing WABA and templates)
- [ ] Data retention practices
- [ ] Third-party sharing (if any)
- [ ] User rights (access, deletion, correction)

**Source:** [App Review Sample Submission](https://developers.facebook.com/docs/whatsapp/solution-providers/app-review/sample-submission)

---

## SECTION 8: Sequencing & Timeline – THE CRITICAL PATH

### 8.1 Recommended Order of Operations

```
PHASE 1: FOUNDATIONAL (1–2 weeks)
  └─ [ ] Create Meta App (WhatsApp use case)
  └─ [ ] Connect Business Portfolio
  └─ [X] Complete Business Verification with Meta
       (Allow 1–2 weeks; get this done ASAP)

PHASE 2: PERMISSIONS & PREPARATION (1 week)
  └─ [ ] After verification: Request Advanced Access for:
         - whatsapp_business_messaging
         - whatsapp_business_management
  └─ [ ] Build minimal Embedded Signup test app (dev environment)
  └─ [ ] Prepare video evidence (screencasts)
  └─ [ ] Write permission descriptions
  └─ [ ] Configure app settings (icon, privacy policy, etc.)

PHASE 3: APP REVIEW SUBMISSION (1 day)
  └─ [ ] Submit Advanced Access request with videos & descriptions
  └─ [ ] Expect decision within 24–48 hours

PHASE 4: APPROVAL & DEPLOYMENT (1–2 days)
  └─ [ ] Upon approval: Implement full Embedded Signup + token exchange
  └─ [ ] Set up webhooks + System User
  └─ [ ] Test end-to-end: customer signup → token → send message
  └─ [ ] Deploy to production

TOTAL: 3–4 weeks from start to production-ready
```

### 8.2 Critical Sequencing Insights

1. **Business Verification is the bottleneck.** Start this immediately; it's a hard prerequisite for everything else.
2. **App Review can proceed in parallel with code development.** You don't need a fully built system – just a working proof-of-concept.
3. **Tech Provider status (registration) happens AFTER App Review approval.** You register as a Tech Provider in your app dashboard once your permissions are approved.
4. **Development mode allows testing before approval.** Use this window to build and validate the integration.
5. **Live mode blocks unapproved permissions.** Once you go live, only approved permissions appear in Embedded Signup – if you haven't gotten App Review approval yet, customers can't grant permissions and onboarding fails.

**Source:** Synthesized from [Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers), [Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview), [App Review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)

---

## SECTION 9: Common Blockers & Gotchas

### 9.1 App Review Rejection Reasons (Common)

| Reason | What Causes It | How to Avoid |
|--------|---|---|
| **Accessibility failure** | Reviewers can't access your app or authenticate | Provide working test account; keep app publicly accessible or provide credentials |
| **Missing/incomplete videos** | One or both videos not submitted | Submit TWO separate videos (one per permission), each showing actual working functionality |
| **Combined permission video** | Single video trying to show both permissions | Submit SEPARATE video for each permission – this is a rejection trigger |
| **Requesting unneeded permissions** | Asking for permissions your app doesn't use | Only request permissions you actually implement and demonstrate |
| **Development-mode submission** | Submitted draft/unfinished app | Ensure app is fully functional before submitting (or at least the features in the video work) |
| **Fake/fraudulent test accounts** | Using bot or spoofed Facebook accounts | Use real, personal Facebook account with `admin` or `developer` role on app |
| **Facebook Login issues** | Reviewers can't find login option or can't authenticate | Test login flow yourself; ensure it works with test account |
| **No privacy policy** | Missing or incomplete privacy policy URL | Provide public-facing privacy policy addressing data handling for WhatsApp |

**Source:** [Common Mistakes](https://developers.facebook.com/docs/app-review/submission-guide/common-mistakes), [App Review Sample Submission](https://developers.facebook.com/docs/whatsapp/solution-providers/app-review/sample-submission)

### 9.2 Business Verification Blockers

| Blocker | Cause | Solution |
|---------|-------|----------|
| **Mismatched business name** | Business name in app doesn't match official records | Update app name to match business registration exactly |
| **Incomplete address** | Missing or incorrect business address | Verify address with business registration / tax docs |
| **Document upload rejected** | Docs unclear, outdated, or don't match profile | Use recent business license, articles of incorporation, or proof of address |
| **Delay waiting for manual review** | Meta's queue is long | Submit docs early; don't wait until last minute before App Review |

**Mitigation:** Start Business Verification immediately upon creating app; don't wait.

### 9.3 Embedded Signup Blockers

| Blocker | Cause | Solution |
|---------|-------|----------|
| **Permissions not appearing in flow** | App is in live mode; permissions not App Review approved | Stay in development mode until approved; test with developers/admins |
| **Token exchange failing** | Wrong API endpoint or missing `client_secret` | Use latest Graph API version; verify credentials; check endpoint |
| **Webhook not receiving events** | Webhook URL not subscribed or not publicly accessible | Set up `account_update` webhook; ensure URL is HTTPS and accessible by Meta |
| **Domain allowlist issue** | Hosting domain not in Facebook Login settings | Add domain to "Allowed Domains" AND "Valid OAuth Redirect URIs" in app settings |

**Source:** [Embedded Signup Implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)

### 9.4 The Biggest Risk: App Review Rejection

**Most Likely Rejection Trigger:** Videos don't show the functionality clearly, or reviewers can't access/test the app.

**Mitigation:**
- [ ] Record high-quality videos with clear screen capture
- [ ] Show actual, working functionality (not just UI mock-ups)
- [ ] Test videos yourself before submitting
- [ ] Provide working test account credentials
- [ ] Make app accessible (HTTPS, public, or via test creds)

**If Rejected:**
- [ ] Read rejection reason carefully
- [ ] Fix the issue (usually video quality, missing feature demo, or accessibility)
- [ ] Re-submit within 7 days (while reason is fresh in Meta's system)
- [ ] Second submission usually approved if issues fixed

**Source:** [Common Mistakes](https://developers.facebook.com/docs/app-review/submission-guide/common-mistakes), [App Review Sample Submission](https://developers.facebook.com/docs/whatsapp/solution-providers/app-review/sample-submission)

---

## SECTION 10: Summary Table – What Needs App Review vs. What Doesn't

| Component | Needs App Review? | Alternative |
|-----------|---|---|
| `whatsapp_business_messaging` | **YES** | Standard access not available; approval required |
| `whatsapp_business_management` | **YES** | Standard access not available; approval required |
| `business_management` | Only if managing third-party business assets | Standard access for own business only |
| Embedded Signup (feature) | **NO** – feature itself not reviewed; permissions are | Can test in dev mode; activate in live after permissions approved |
| Webhooks | **NO** – setup required but no review | Configure in app settings |
| Business Verification | **NO – prerequisite** | Required before App Review, not reviewed as part of it |
| Privacy Policy | **NO – checked during review** | Must exist; should be comprehensive |

**Source:** [Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers), [Embedded Signup Overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview), [App Review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)

---

## SECTION 11: Final Integration Checklist (Before Going Live)

### Pre-Launch Tasks

- [ ] **App Review approved** for `whatsapp_business_messaging` and `whatsapp_business_management`
- [ ] **Business Verification complete**
- [ ] **Tech Provider status granted** (registered in app dashboard)
- [ ] **Embedded Signup implemented** with Facebook Login for Business configured
- [ ] **Token exchange logic** working (code → long-lived token)
- [ ] **System User created** in Business Manager (if using automated calls)
- [ ] **Webhooks configured** (account_update subscription active)
- [ ] **Privacy Policy published** and URL in app settings
- [ ] **Domains allowlisted** in Facebook Login settings
- [ ] **SSL/HTTPS certificate valid** on all production domains
- [ ] **Cloud API messaging tested** (send test message via API)
- [ ] **Error handling implemented** (graceful failures, user-facing error messages)
- [ ] **Logging in place** (for debugging customer issues)
- [ ] **Test customer onboarded** via Embedded Signup (verify full flow end-to-end)

### Post-Launch Monitoring

- [ ] Monitor webhook delivery (no missed `account_update` events)
- [ ] Monitor API error rates (Cloud API calls)
- [ ] Set up alerts for failed customer onboardings
- [ ] Prepare support process for customer issues (token refresh, permission scope clarification, etc.)

---

## MASTER CHECKLIST – PRINT & CHECK OFF

```
FOUNDATIONAL (Weeks 1-2)
[ ] Create Meta app (WhatsApp use case)
[ ] Connect business portfolio
[ ] Complete Business Verification

PERMISSION & APP REVIEW PREP (Week 2-3)
[ ] Request Advanced Access for whatsapp_business_messaging
[ ] Request Advanced Access for whatsapp_business_management
[ ] Build test app with Embedded Signup (dev environment)
[ ] Record video #1: message sending demo
[ ] Record video #2: WABA management demo
[ ] Write permission description #1 (whatsapp_business_messaging)
[ ] Write permission description #2 (whatsapp_business_management)
[ ] Create/finalize privacy policy
[ ] Configure app icon, name, category

APP REVIEW SUBMISSION (Week 3)
[ ] Submit Advanced Access request for whatsapp_business_messaging (with video + description)
[ ] Submit Advanced Access request for whatsapp_business_management (with video + description)
[ ] Provide test account credentials to Meta (if requested)

WAITING FOR APPROVAL (24-48 hours)
[ ] Monitor email for Meta requests or approval notification

POST-APPROVAL DEPLOYMENT (Week 4)
[ ] Verify permissions now appear in live-mode Embedded Signup
[ ] Implement full production Embedded Signup
[ ] Build token exchange backend logic
[ ] Create system user in Business Manager
[ ] Set up webhook subscriptions (account_update)
[ ] Configure allowlisted domains
[ ] Test end-to-end: customer signup → token → message send
[ ] Register as Tech Provider in app dashboard (if not already done)
[ ] Set up monitoring & logging
[ ] Go live

LAUNCH & MONITORING
[ ] Monitor webhook delivery
[ ] Monitor API error rates
[ ] Watch for customer support issues
[ ] Iterate on UX based on early feedback
```

---

## KEY TAKEAWAY: Single Most Important Sequencing Insight

**Business Verification is your critical path.** It is the single biggest time investment (1–2 weeks) and has NO workarounds. Start it immediately upon creating your Meta app. Everything else — App Review submission, Tech Provider registration, Embedded Signup — is blocked until verification is complete. The 3-4 week timeline from conception to production is dominated by this one gate.

**Do not start building code until Business Verification is underway; do not start App Review submission until it's complete.**

---

## KEY RISK: The Biggest Blocker to App Review Success

**Problem:** Reviewers cannot assess your app because:
1. The app is not publicly accessible (or test credentials are wrong/broken)
2. Facebook Login doesn't work
3. The videos don't clearly show the permissions being used

**Impact:** Automatic rejection; 1–2 week delay for re-submission and re-review.

**Mitigation:** Before submitting, internally test with fresh test accounts. Ensure someone outside your dev team can:
- Access the app via the provided link or test credentials
- Successfully authenticate via Facebook Login
- See the Embedded Signup flow in a development-mode app
- Understand from the videos exactly what your app does

Test this flow yourself multiple times before submission.

---

## RELATED RESOURCES

- [Tech Provider Get Started](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)
- [Embedded Signup Overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview)
- [App Review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)
- [Access Tokens Guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/)
- [Business Verification](https://developers.facebook.com/docs/development/release/business-verification/)
- [Data Privacy & Security](https://developers.facebook.com/documentation/business-messaging/whatsapp/data-privacy-and-security/)
- [Common Mistakes in App Review](https://developers.facebook.com/docs/app-review/submission-guide/common-mistakes)

---

**Document Last Updated:** 2026-07-21  
**Sources:** Official Meta for Developers documentation (developers.facebook.com)
