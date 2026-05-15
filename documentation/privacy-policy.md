# Privacy Policy

**Last updated:** 2026-05-15

Virtual Lab, LLC ("VLab", "we", "us") operates a research platform that enables academic institutions and nonprofits to design, recruit for, and run behavioral studies. This policy describes what data we collect, why, how we use it, and the choices you have. It applies to both the VLab Dashboard & API (study configuration, recruitment, and analytics) and Fly, our survey-delivery service that runs over chat, messaging, SMS, and web channels — including Facebook Messenger and other platforms researchers may connect.

---

## 1. Who this policy covers

This policy applies to two groups:

- **Researchers** — staff at academic, nonprofit, or partner organizations who use the VLab Dashboard to configure studies and connect external messaging and advertising platforms.
- **Participants** — individuals who answer a VLab-powered survey.

For participant data, the researcher's institution is normally the **data controller** and VLab acts as a **data processor** on their behalf. For researcher account data, VLab is the controller.

---

## 2. Information we collect

### 2.1 From researchers

- **Account information:** name, email address, organization, and authentication identifiers.
- **Platform integration data:** identifiers, campaign metadata, and access tokens for the third-party messaging and advertising platforms a researcher connects (for example, Meta / Facebook), used to call those platforms' APIs on the researcher's behalf.
- **Study configuration:** survey definitions, targeting specifications, message templates, recruitment parameters, and budget settings.
- **Operational telemetry:** logs of dashboard activity used to operate and secure the service.

### 2.2 From participants

The exact fields depend on the study. Typical categories include:

- **Platform-assigned identifiers** issued by the channel a participant uses (for example, a Facebook Messenger PSID, a phone number where SMS is used with the participant's consent, or an anonymous web session ID).
- **Survey responses** to questions authored by the researcher.
- **Message metadata** such as timestamps, message direction, delivery status, and chatbot state.
- **Consent and permission records** for follow-up contact — for example study opt-ins, recurring-notification opt-ins, or platform-specific messaging permissions — recorded with timestamp.
- **Limited profile data** that the messaging platform exposes (e.g. first name, locale).

We do not ask researchers to collect, and we do not knowingly process, payment card data or government identifiers.

### 2.3 Special category data

Some studies may involve special categories of personal data within the meaning of GDPR Article 9 (e.g. health, political opinion, religion, ethnic origin, or sexual orientation). Where such data is collected, the researcher's institution is responsible for obtaining the explicit consent required under Article 9(2)(a) and any necessary ethics-committee or IRB approval. VLab processes such data only on the controller's documented instructions.

### 2.4 Cookies and local storage

The dashboard uses cookies and browser local storage only for authentication and UI preferences. We do not use third-party advertising cookies.

---

## 3. How we use information

We use this data to:

- Authenticate researchers and provide the dashboard, API, and admin tooling.
- Execute the studies researchers configure — sending survey messages, recording responses, and surfacing results to the researcher.
- Manage advertising and recruitment campaigns on connected platforms (such as Meta ad accounts).
- Send **non-promotional follow-up messages** — such as utility messages, opt-in confirmations, multi-wave study invitations, or reminders to complete a survey — only where the participant has granted the necessary permission (a study opt-in, an SMS opt-in, a Facebook Messenger message tag, or an analogous platform mechanism), and only within what that permission allows. These messages are transactional or research-related and contain no third-party promotional content.
- Operate, monitor, debug, and secure the service.
- Comply with legal obligations.

We do not sell personal data, use participant responses to train general-purpose AI models, or use participant data for advertising outside of the specific study the participant joined.

---

## 4. Legal bases (GDPR / UK GDPR)

Where the GDPR or UK GDPR applies, we rely on the following legal bases:

- **Contract** — to provide the dashboard and API to researchers and their organizations.
- **Consent** — for participant survey responses and for follow-up contact under the relevant opt-in or platform permission.
- **Legitimate interests** — for operational logging, security monitoring, and abuse prevention.
- **Legal obligation** — for responding to lawful requests and meeting record-keeping requirements.

A Data Processing Agreement (DPA) is available on request to institutional customers who require one — contact `privacy@vlab.digital`.

---

## 5. How we share information

We share information only as needed to operate the service:

- **With the researcher / their institution** — all data collected under a researcher's study is available to that researcher and their authorized colleagues.
- **With infrastructure providers** — Google Cloud (EU regions) hosts our application servers, databases, and storage, and Auth0 (an Okta company) provides authentication. These providers process data on our behalf under their standard data processing terms.
- **With connected third-party platforms** — when a researcher connects an external messaging, social, or advertising platform (for example, Meta / Facebook), we exchange data with that platform strictly to perform the actions the researcher has requested. Use of that data is also governed by the platform's own terms (e.g. [Meta's Platform Terms](https://developers.facebook.com/terms/)).
- **For legal reasons** — when required by law, subpoena, or to protect the rights, property, or safety of VLab, our users, or others.

We do not sell or rent personal data to third parties.

---

## 6. International transfers

VLab production infrastructure is hosted in the European Union (Google Cloud, `europe-west` regions). VLab, LLC is incorporated in the United States, so data may be accessed by our staff and U.S.-based subprocessors. Where required for transfers out of the EEA, we rely on Standard Contractual Clauses and equivalent safeguards.

---

## 7. Retention

- **Researcher account data** — retained while the account is active and for 90 days after account closure.
- **Study and participant data** — retained for the duration of the study and afterward according to the researcher's institutional retention policy. Researchers can delete studies and participant records at any time.
- **Platform access tokens** — revoked when the researcher disconnects the corresponding account.
- **Operational logs** — retained on a 90-day rolling basis.
- **Database backups** — encrypted and deleted after 90 days by storage-bucket lifecycle policy.

Deletion requests against primary stores are honored promptly. Because backups age out on a fixed cycle, deleted records may persist in encrypted backup archives for up to 90 days.

---

## 8. Security

We apply layered security controls including:

- Encryption in transit (TLS) for all dashboard, API, and chatbot traffic.
- Encryption at rest for databases and backups.
- Role-based access controls and least-privilege service accounts.
- Centralized logging and monitoring of administrative access.

No system is perfectly secure; please report suspected vulnerabilities to the contact below.

In the event of a personal data breach affecting data processed on a controller's behalf, we will notify the affected controller without undue delay and, where feasible, within 72 hours of becoming aware of the breach, consistent with GDPR Article 33.

---

## 9. Your rights

Depending on where you live, you may have the right to:

- Access the personal data we hold about you.
- Correct inaccurate data.
- Request deletion.
- Restrict or object to certain processing.
- Receive a portable copy of your data.
- Withdraw consent at any time. Participants can stop a survey by no longer replying; to request deletion of data already collected, contact us or the researcher running the study.

To exercise these rights, use the contact details below. If your data was collected as part of a study, please contact the researcher's institution first; we will support them in responding. We respond to verified rights requests within **one month**, extendable by up to two further months for complex requests.

You also have the right to **lodge a complaint with a data protection supervisory authority** in your EU/EEA member state. A list is maintained at <https://edpb.europa.eu/about-edpb/about-edpb/members_en>.

### 9.1 California residents

If you are a California resident, the CCPA (as amended by the CPRA) gives you the right to know, delete, correct, opt out of sale or sharing, and not be discriminated against for exercising these rights. VLab does **not** sell or share personal information as defined by the CCPA. To exercise these rights, contact `privacy@vlab.digital`.

---

## 10. Automated decision-making

VLab does not make decisions about participants based solely on automated processing that produce legal or similarly significant effects within the meaning of GDPR Article 22.

---

## 11. Children

The platform is intended for use in research approved by an institutional review board (IRB) or equivalent ethics committee. Researchers are responsible for obtaining the appropriate consent (including parental or guardian consent where applicable) before enrolling minors. We do not knowingly collect data directly from children under 13 without such consent.

---

## 12. Changes to this policy

We may update this policy from time to time. Material changes will be announced in the dashboard and, where appropriate, by email to the account owner. The "Last updated" date at the top reflects the most recent revision.

---

## 13. Contact

**Virtual Lab, LLC**
5931 NW Burgundy Drive
Corvallis, OR 97330, USA
Email: privacy@vlab.digital

For data processing matters where VLab is acting as a processor on behalf of a researcher institution, please also contact that institution's data protection officer.
