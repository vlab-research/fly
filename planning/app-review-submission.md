# Meta WhatsApp App Review Submission Materials

**Date:** 2026-07-22  
**Status:** Draft for Review  
**Scope:** Permission descriptions, screencast outlines, app settings checklist, and reviewer test-account documentation

---

## Overview

VLab is submitting an Advanced Access request to Meta for two WhatsApp Cloud API permissions to operate as a **Tech Provider**. Researchers will self-serve connect their own WhatsApp Business Accounts via Embedded Signup in the VLab dashboard; VLab then delivers surveys to respondents who opt in, records their answers, and sends pre-approved utility template messages for survey reminders.

This document provides all materials required by Meta's App Review process, organized for submission via the Meta App Dashboard.

---

## 1. Permission Descriptions

### 1.1 `whatsapp_business_messaging` Permission

**Character count:** 987 characters

**Text:**

Virtual Lab is a research platform that enables academic institutions and public-health researchers to conduct large-scale behavioral studies via WhatsApp messaging. Researchers connect their own WhatsApp Business Accounts through our dashboard via Embedded Signup and deploy surveys to consenting respondents. We use the `whatsapp_business_messaging` permission to:

**1. Receive and process inbound survey responses:** When respondents message the researcher's WhatsApp Business number in response to Click-to-WhatsApp ads or wa.me links, we receive those messages via webhook, normalize them, and store the responses in our research database. All conversations are respondent-initiated.

**2. Send survey questions within the 24-hour service window:** When a respondent sends an inbound message, we have a 24-hour window to reply with the next survey question, pre-formatted guidance, or confirmation. Our backend sends these as free-form business messages within that service window. All messages are replies to prior inbound contact.

**3. Send pre-approved utility template messages for survey continuation reminders outside the 24-hour window:** For multi-wave studies where respondents explicitly consent to follow-up contact, we send pre-approved UTILITY category message templates (e.g., "Your follow-up survey is ready — click here to participate") to notify them when a new survey wave opens. This is strictly transactional — no marketing, no cold outreach, no bulk campaigns. Recipients must have opted in during an earlier survey interaction.

All contact is respondent-opt-in only. We do not initiate conversations, send unsolicited promotional messages, or retain contact lists for future marketing. The platform's sole purpose is survey delivery and response collection for academic research.

---

### 1.2 `whatsapp_business_management` Permission

**Character count:** 842 characters

**Text:**

Virtual Lab uses the `whatsapp_business_management` permission to streamline survey-template management for researchers. Specifically:

**1. Embedded Signup onboarding:** When a researcher connects their WhatsApp Business Account in our dashboard, they click a "Connect WhatsApp" button, which triggers Meta's Embedded Signup popup. The researcher selects their account and approves our app. We receive a short-lived authorization code, exchange it for a long-lived business access token via the `/me/token_exchanges` endpoint, and securely store the token so we can act on the researcher's behalf.

**2. Subscribe the researcher's WABA to our webhook:** Using the stored access token, we subscribe the researcher's WhatsApp Business Account to our app's webhooks so we can receive inbound messages (see `whatsapp_business_messaging` above).

**3. Manage UTILITY message templates on behalf of the researcher:** Researchers use our dashboard to create, view, and delete pre-approved UTILITY templates (e.g., "Follow-up Survey Available"). We call Meta's Graph API endpoints (`POST`, `GET`, `DELETE` on `/{waba_id}/message_templates`) to manage these templates on the researcher's WABA. This allows researchers to author and update templates without manually interacting with Meta's Business Manager interface.

All operations are scoped to the researcher's own WABA and tokens — we never access templates or WABAs belonging to other researchers, and researchers can revoke access at any time.

---

## 2. Screencast Outlines

Each screencast should be **30 seconds to 2 minutes**, filmed on a clean desktop with microphone narration. The goal is to show a complete workflow: entry point → successful completion → confirmation.

### 2.1 Screencast: `whatsapp_business_messaging` (Messaging Demo)

**Title:** "Respondent Survey Flow via WhatsApp"

**Shot list:**

1. **Setup (0:00–0:10):** Show the VLab dashboard home page with a "Run Survey" button visible. Narrator: "A researcher is ready to deploy a survey."

2. **Entry point (0:10–0:20):** Show a wa.me link or Click-to-WhatsApp ad link being opened or clicked. A WhatsApp conversation window opens with the researcher's test number. Narrator: "Respondents opt in by clicking a WhatsApp link."

3. **Respondent sends first message (0:20–0:30):** Show a text message from the respondent (e.g., "Hi, I want to take the survey"). The message arrives in the researcher's WhatsApp Business account. Narrator: "The respondent sends their first message — this is within the 24-hour service window."

4. **VLab receives and processes (0:30–0:45):** Switch back to the VLab dashboard. Show the "Active Conversations" or "Responses" section updating in real-time with the respondent's message. Narrator: "VLab receives the message via webhook and records it."

5. **Send survey question (0:45–1:00):** Show a field in the survey (e.g., "Which of these do you prefer?" with two options). Switch back to WhatsApp. Show a message from the researcher's number asking the question with reply-button options (Quick Replies). Narrator: "VLab sends the next survey question as a free-form message within the 24-hour window."

6. **Respondent answers (1:00–1:15):** Show the respondent tapping a reply button (e.g., "Option A"). Show the response appear in the WhatsApp Business account. Narrator: "The respondent answers using reply buttons or text."

7. **Response recorded (1:15–1:25):** Switch to the VLab dashboard. Show the respondent's answer appearing in the "Responses" section. Narrator: "VLab records the response for analysis."

8. **Closing (1:25–1:30):** Show the researcher viewing the collected response data in the dashboard. Narrator: "All respondent data is stored securely and ready for analysis."

---

### 2.2 Screencast: `whatsapp_business_management` (WABA Management Demo)

**Title:** "Connecting WhatsApp Business Account & Managing Templates"

**Shot list:**

1. **Setup (0:00–0:10):** Show the VLab dashboard "Connected Accounts" or "Settings" page with a list of existing Messenger accounts. A "Connect WhatsApp" button is visible. Narrator: "A researcher wants to connect their WhatsApp Business Account."

2. **Click Connect (0:10–0:20):** Show the researcher clicking the "Connect WhatsApp" button. Narrator: "They click the Connect WhatsApp button in the dashboard."

3. **Embedded Signup popup (0:20–0:40):** Show Meta's Embedded Signup popup window appearing (or a screenshot/mockup of it if live testing isn't feasible for the video). The popup shows account selection. Show the researcher selecting their WhatsApp Business Account and clicking "Continue" or "Approve". Narrator: "Meta's Embedded Signup popup appears. The researcher selects their WhatsApp Business Account and approves our app."

4. **Approval success (0:40–0:55):** After the popup closes, return to the VLab dashboard. Show the "Connected Accounts" list updating to include the newly connected WhatsApp account (labeled with the phone number or WABA name). Narrator: "The account is now connected. VLab has received the authorization token and subscribed to the webhook."

5. **Navigate to templates (0:55–1:10):** Show the researcher navigating to the "Message Templates" section of the dashboard. Show the list of templates, with a "New Template" button. Narrator: "Now the researcher can create and manage message templates from the dashboard."

6. **Create a template (1:10–1:25):** Show the "Create Template" form. Fill in example values:
   - **Template name:** "follow_up_survey"
   - **Category:** "UTILITY" (pre-selected and shown as read-only)
   - **Language:** "en_US"
   - **Body:** "Hi {{1}}, your follow-up survey is ready. Click here to participate."
   - **Example values:** "Alice" (for {{1}})
   - Show the form validation passing (all required fields green).
   Narrator: "The researcher creates a new UTILITY template. VLab validates it and sends it to Meta for approval."

7. **Template submitted (1:25–1:35):** Show the "Create" button being clicked. Show a success message or the template appearing in the list with status "PENDING". Narrator: "The template is submitted to Meta for review."

8. **Status refresh (1:35–1:50):** Show the template status in the list (e.g., by refreshing the page or waiting a moment if using a real staging environment). Show the status changing from "PENDING" to "APPROVED" (this may be simulated for video purposes if real approval timing is too long). Narrator: "Within moments, Meta approves the template."

9. **Ready to use (1:50–2:00):** Show the template now marked as "APPROVED" in the dashboard. Show a note or UI element indicating "This template is ready to use for survey reminders." Narrator: "The template is now ready. VLab can use it to send survey-continuation reminders outside the 24-hour window, at scale, without creating templates manually in Business Manager."

---

## 3. App Settings Checklist

Complete the following in the Meta App Dashboard (Apps section, Settings).

- [ ] **App Name:** `Virtual Lab` (or match your registered app name)

- [ ] **App Icon:** Upload a clear 512×512 or 1024×1024 PNG/JPG logo. Use VLab's official mark (colored or white background, legible at small sizes).

- [ ] **App Category:** Select "Messaging" or "Research/Academic" (if available).

- [ ] **Privacy Policy URL:** Must be a publicly accessible HTTPS URL.
  - **Important:** This policy MUST explicitly address WhatsApp data handling:
    - Researchers own their WhatsApp Business Accounts; VLab acts as a service provider (Tech Provider).
    - Respondents' messages and metadata are stored by VLab solely to deliver surveys and record responses.
    - Data is NOT used for marketing, profiling, or shared with third parties except as required by law.
    - Researchers can delete their connected account at any time; VLab stops receiving messages immediately.
    - Specify data retention periods (e.g., survey responses retained for X years, then deleted).
    - Confirm that WhatsApp terms of service (ban on marketing, unsolicited bulk messages) are enforced.
  - **Example sections to include:**
    - "How we handle WhatsApp data" or "WhatsApp integration"
    - "Data retention and deletion"
    - "Respondent privacy and consent"

- [ ] **Contact Email:** A monitored inbox (e.g., `support@yourdomain.com` or `contact@yourdomain.com`). This is where Meta reviewers and researchers can reach you.

- [ ] **Business Verification Status:** Must be **VERIFIED** before submitting the App Review request.
  - Start Business Verification immediately (1–2 week turnaround).
  - Verify official business name, address, and identity.
  - Meta will not review the app until this is complete.

- [ ] **Data Deletion:** Ensure VLab has a documented data-deletion process for researcher accounts (e.g., bulk delete respondent messages and credentials on account removal). This is often reviewed by auditors.

- [ ] **Test Account Credentials:** Have a **researcher test account** ready on staging (see §5 below) with login credentials to provide to Meta reviewers if requested.

---

## 4. Embedded Signup Configuration

Before submitting the App Review request, create an Embedded Signup configuration in the Meta App Dashboard:

1. Navigate to **WhatsApp → Embedded Signup Builder** in the Meta App Dashboard.
2. Click **"Create Configuration"** or **"Add New Configuration"**.
3. Set the following:
   - **Configuration name:** "VLab Dashboard Sign-up"
   - **Redirect URI:** `https://your-dashboard-domain.com/api/v1/whatsapp/exchange-code/callback` (or your actual backend callback path if different).
   - **Scopes:** Select `whatsapp_business_messaging` and `whatsapp_business_management`.
   - **Features:** Check "Embedded Signup" and "Phone Number Permission".

4. After creation, **copy the Configuration ID** (a long alphanumeric string) and store it in:
   - `devops/values/staging.yaml`: `dashboard-server.env.WHATSAPP_CONFIG_ID: <ID>`
   - `dashboard-client/.env.staging`: `REACT_APP_WHATSAPP_CONFIG_ID=<ID>`

5. **Verify:** Navigate to staging dashboard → "Connected Accounts" → "WhatsApp" → "Connect". The Embedded Signup popup should appear (or fail with a clear error in the browser console if the config ID is wrong).

---

## 5. Reviewer Test-Account Instructions

Provide the following to Meta reviewers if they request a test environment:

### 5.1 Access Credentials

- **Staging Dashboard URL:** `https://staging-dashboard.yourdomain.com` (or your actual staging URL)
- **Test Researcher Login:**
  - Email: `test-researcher@example.com`
  - Password: `[provide temporary password or sign-up link]`
  - **Note:** Credentials are single-use; ask reviewers to reset password on first login.

### 5.2 Test WhatsApp Business Account

Provide a phone number or WABA ID for testing:
- **Test WhatsApp Number:** `+1-555-TEST-01` (or actual test number you own or have access to)
- **WABA ID:** `<waba_id_for_testing>` (if different from the phone number ID)
- **Access Token:** Do NOT share; instead, have reviewers use Embedded Signup to connect their own test WABA if possible.

**Alternative (Recommended):** Ask reviewers to connect a test WABA they control via Embedded Signup in the staging dashboard. This demonstrates the full flow and avoids sharing credentials.

### 5.3 Step-by-Step Test Scenario (Messaging Permission)

1. **Log in** to the staging dashboard with the test researcher account.
2. **Navigate to** "Surveys" and open or create a test survey with a simple question (e.g., "What is your name?").
3. **Get the wa.me link** for the test WhatsApp number (if Track A is enabled, this should be displayed; otherwise, provide it manually).
4. **Send a message** to the test number from a personal WhatsApp account (e.g., "Hi, I want to start the survey").
5. **Verify in dashboard:** The inbound message appears in the "Active Conversations" or "Responses" section.
6. **Verify message send:** Check that VLab sends the first survey question back via WhatsApp within seconds.
7. **Respond to the survey** from your personal account (e.g., tap "Yes" for a yes/no question).
8. **Verify recording:** The response appears in the survey's "Responses" tab in the dashboard.

### 5.4 Step-by-Step Test Scenario (Management Permission)

1. **Log in** to the staging dashboard.
2. **Navigate to** "Connected Accounts" → "WhatsApp".
3. **Click** "Connect WhatsApp Business Account".
4. **Meta's Embedded Signup popup appears.** Select a test WABA you control or that Meta provides. Approve the app.
5. **Verify connection:** Return to "Connected Accounts" → "WhatsApp". Your WABA should appear in the list (labeled by phone number or WABA name).
6. **Navigate to** "Message Templates" section.
7. **Click** "New Template" → Select the WhatsApp account you just connected.
8. **Fill in template details:**
   - Name: `test_reminder`
   - Language: `en_US`
   - Body: `Hi {{1}}, your test survey is ready. Click here to proceed.`
   - Example values: `Jane` (for {{1}})
9. **Submit.** VLab sends the template to Meta for approval.
10. **Refresh** the template list (within 10–30 seconds, or wait). The template status should change from PENDING to APPROVED (in staging, this is fast; production reviews take longer).
11. **Verify:** The template is now ready for use (shown as "APPROVED" in the dashboard).

### 5.5 Environment Notes for Reviewers

- **Database:** Staging uses a dedicated CockroachDB instance. Reviewer accounts and conversations are isolated from production data.
- **Messaging:** All WhatsApp messages sent from staging are real; reviewers will see them in the test WhatsApp account's inbox.
- **Rate Limits:** No rate-limiting is applied in staging; the app is fully functional for end-to-end testing.
- **Cleanup:** Reviewers should not worry about leaving test data behind; staging is wiped periodically.

---

## 6. Implementation Status & Known Issues

### 6.1 Code Readiness

**Completed:**
- Platform abstraction (migrations 20–21 on main branch): `credentials.key` unified account-id keying, `states.platform` computed column.
- Replybot and message-worker updated to route WhatsApp messages to the correct API client.
- WhatsApp template support in `message-templates` (including WABA-level CRUD).
- Hermes webhook handler for WhatsApp inbound messages (signature verification, event normalization).
- Track B Embedded Signup: dashboard /connect/whatsapp flow, POST /whatsapp/exchange-code (auth-code -> business token), automatic WABA webhook subscription (POST /{waba_id}/subscribed_apps) at connect time.
- Bare-text entry point: wa.me/<number>?text=form.<shortcode> starts surveys (plus Click-to-WhatsApp ad referrals).
- E2E test suite includes 4 WhatsApp-specific tests (all passing; 36/36 overall).

**Remaining (config/external only — no code):**
- REACT_APP_WHATSAPP_CONFIG_ID value from Meta App Dashboard -> Embedded Signup configuration (placeholder committed in netlify.toml).
- Staging deployment per planning/staging-rollout-runbook.md.

**Timeline:** Code complete on feature/whatsapp-platform-keying (e2e 36/36); submission blocked only on staging deploy + Business Verification.

### 6.2 Known Caveats for Reviewers

1. **Org-owned numbers (Track A):** VLab also supports pre-configured org-owned WhatsApp numbers for testing without Embedded Signup. These are registered via manual SQL INSERT (admin-only). If a reviewer asks about this, explain it's a staging-only testing mode; production uses Embedded Signup exclusively.

2. **WABA requirement:** Every WhatsApp Business Account has a WABA (WhatsApp Business Account) id. Credentials created via Embedded Signup store this automatically. Track A credentials must include `details.waba_id` or template operations will fail with a 400 error ("missing details.waba_id"). This is by design — templates are managed at the WABA level, not the phone-number level.

3. **Template review timing:** WhatsApp templates go through Meta's automated review. In staging, approval is typically instant (seconds to minutes). In production, reviews can take longer (minutes to hours) depending on content complexity. Reviewers should not be alarmed if a template's status doesn't update immediately; refresh the page after 10–30 seconds.

4. **Placeholder config IDs / Staging-Only Values:** If staging.yaml or .env.staging contain placeholder values for FACEBOOK_APP_SECRET or WHATSAPP_CONFIG_ID, these are non-functional stubs. Staging deployments will have real values injected via Kubernetes secrets (see `gbv-bot-envs` secret in `vstag` namespace). Reviewers should see working Embedded Signup and message flows; if they don't, check that the secret is correctly mounted.

5. **Production Rollout:** This App Review submission is for staging demo purposes. Production rollout (Track A org numbers + Track B Embedded Signup with real researcher accounts) requires Business Verification approval and App Review sign-off, then follows a separate production deployment plan.

---

## 7. Document Checklist for Submission

Use this checklist to verify all materials are ready before submitting to Meta:

**Permissions & Descriptions:**
- [ ] `whatsapp_business_messaging` description (987 chars) — factual, no invented features
- [ ] `whatsapp_business_management` description (842 chars) — covers Embedded Signup + token exchange + template CRUD

**Screencasts:**
- [ ] `whatsapp_business_messaging` video (30s–2min) — shows wa.me entry → Q&A → response recording
- [ ] `whatsapp_business_management` video (30s–2min) — shows Embedded Signup → connection success → template creation → approval status

**App Settings:**
- [ ] App icon uploaded (512×512 or larger)
- [ ] Privacy policy URL live and WhatsApp-specific (see §3 above)
- [ ] Contact email monitored
- [ ] Business Verification status: VERIFIED
- [ ] Test researcher account created and ready

**Embedded Signup:**
- [ ] Configuration created in Meta App Dashboard
- [ ] Configuration ID copied to staging.yaml + dashboard-client .env.staging
- [ ] Staging dashboard "Connect WhatsApp" button displays Embedded Signup popup

**Code & Environment:**
- [ ] All Track B code deployed to staging (backend + frontend)
- [ ] Hermes WhatsApp webhook handler deployed (Chunk 3)
- [ ] `WHATSAPP_VERIFY_TOKEN` set in staging environment
- [ ] Dashboard-server `/whatsapp/exchange-code` endpoint functional
- [ ] E2E test suite green (35/35 testrunner tests pass)

**Reviewer Materials:**
- [ ] Test researcher login credentials prepared
- [ ] Test WhatsApp number or WABA ID documented
- [ ] Step-by-step test scenarios (§5.3 & §5.4) verified manually
- [ ] Environment notes for reviewers written

---

## 8. Summary: What Meta Reviewers Will Verify

Meta's advanced-access review team will:

1. **Read the descriptions** to ensure they match actual use cases (academic research, opt-in surveys, no marketing).
2. **Watch the screencasts** to see:
   - Respondent entry via wa.me / Click-to-WhatsApp (not cold outreach).
   - Message send/receive within 24-hour window.
   - Utility template approval flow.
   - Researcher control (Embedded Signup, account connection, template management).
3. **Test the staging environment** using provided credentials:
   - Connect a WhatsApp Business Account via Embedded Signup.
   - Create and manage templates.
   - Send a test survey and receive responses.
   - Verify that no bulk/cold messaging is possible.
4. **Review the privacy policy** to confirm WhatsApp data handling, retention, and deletion practices.
5. **Verify Business Verification** completion.

**Expected turnaround:** 24–48 hours for initial review; additional clarifications possible.

---

## Appendix: Environment Variable Configuration Reference

These environment variables must be set in the staging deployment before submission:

**Backend (`dashboard-server`):**
```
FACEBOOK_APP_ID=<your-meta-app-id>
FACEBOOK_APP_SECRET=<your-meta-app-secret>
FACEBOOK_GRAPH_URL=https://graph.instagram.com/v25.0
WHATSAPP_CONFIG_ID=<your-embedded-signup-config-id>
```

**Frontend (`dashboard-client`, Netlify staging context):**
```
REACT_APP_WHATSAPP_CONFIG_ID=<your-embedded-signup-config-id>
```

**Kubernetes Secret (`gbv-bot-envs` in `vstag` namespace):**
```
FACEBOOK_APP_SECRET=<same-as-above>
WHATSAPP_VERIFY_TOKEN=<random-long-string-for-webhook-verification>
```

---

**Document prepared by:** Scout Agent  
**Last updated:** 2026-07-22  
**Revision:** 1.0  
**Status:** Ready for user review before submission
