# Facebook Bug Report — `message_echoes` not delivered for outbound messages with `user_phone_number` quick replies

## Title (suggested)

`message_echoes webhook not delivered for outbound messages containing quick_replies with content_type "user_phone_number" (regression around 2026-05-21 ~12:00 UTC)`

## Product / Category

Messenger Platform → Webhooks → `message_echoes`

Possibly related (cannot view, requires login): https://developers.facebook.com/support/bugs/1243075530581852/

## Summary

Starting at approximately **2026-05-21 11:00–12:00 UTC**, Facebook stopped delivering `message_echoes` webhook events for outbound messages where `message.quick_replies` contains an entry with `content_type: "user_phone_number"`. Echoes for all other message types from the same pages — plain text, multiple-choice quick replies, button templates, thankyou screens — continue to be delivered correctly. The Send API call itself still returns success, and recipients receive the message and reply to it; only the echo webhook is missing.

Our app's state machine depends on `is_echo: true` events to transition users out of the `RESPONDING` state, so this silent change has caused **860+ users to become permanently stuck mid-survey**.

## App / page details

- **App ID:** 699455733740842 (Virtual Lab)
- **Affected pages (sample):**
  - `101435865704727` ("Our World In Surveys")
  - `758018254333043` ("Global Health Hub")
  - (Many other pages with the same outbound message shape are also affected)
- **Graph API version used for sending:** `v22.0`
- **Webhook subscription state (verified via GET `/{page-id}/subscribed_apps`):** `subscribed_fields` includes `message_echoes` on every affected page. The subscription has not changed.

## Steps to reproduce

1. Have an app subscribed to `message_echoes` on a Facebook Page.
2. From the page, send a Messenger message containing a `user_phone_number` quick reply via the Send API. Example payload (this is what we send and what we expect an echo for):

   ```json
   POST https://graph.facebook.com/v22.0/me/messages
   {
     "recipient": {"id": "<PSID>"},
     "message": {
       "text": "What phone number should we send the mobile credit to?",
       "quick_replies": [{"content_type": "user_phone_number"}],
       "metadata": "{\"ref\":\"phone_number\",\"type\":\"phone_number\"}"
     }
   }
   ```
3. The Send API returns `200 OK` with a `message_id`. The recipient receives the message and can tap the quick reply to share their phone number, producing a normal inbound webhook with their reply.
4. **Expected:** within seconds, a `message_echoes` webhook fires for the outbound message with `sender.id = <page>`, `recipient.id = <PSID>`, `message.is_echo = true`, `message.text = "What phone number..."`, and `message.quick_replies` mirroring the outbound payload.
5. **Actual (as of 2026-05-21 ~12:00 UTC):** no echo webhook is delivered for that message. Outbound messages from the same page sent in the same minute without `user_phone_number` quick replies do produce echoes normally.

## Expected vs. actual behavior

| | Pre-2026-05-21 12:00 UTC | After 2026-05-21 12:00 UTC |
|---|---|---|
| Send `user_phone_number` quick reply | Echo delivered | **Echo NOT delivered** |
| Send plain text | Echo delivered | Echo delivered ✓ |
| Send `multiple_choice` quick replies | Echo delivered | Echo delivered ✓ |
| Send button template | Echo delivered | Echo delivered ✓ |

## When it started — sharp cutover

On a single high-volume page (`101435865704727`), our internal logs show:

| Date (UTC) | Outbound `user_phone_number` sends | Successful flows (echo received → user reply processed) | Users stuck (no echo) |
|---|---|---|---|
| 2026-05-20 | ~500 | **424** | 0 |
| 2026-05-21 00:00–11:00 | ~50 | ~45 | 0 |
| **2026-05-21 12:00 UTC** | — | — | First stuck users appear |
| 2026-05-21 12:00–23:59 | ~25 | 7 | 14 |
| 2026-05-22 | ~40 | 9 | 30 |
| 2026-05-23 | ~14 | 4 | 10 |
| 2026-05-24 | ~8 | 2 | 6 |
| 2026-05-25 | ~24 | 2 | 22 |

No deploys or code changes on our side around the cutover. The change is unambiguously on the Facebook side, between **11:00 and 12:00 UTC on 2026-05-21**.

## Evidence from webhook logs (last 2 hours of our webhook receiver)

- **32 `is_echo: true` events received**, all for non-`user_phone_number` messages.
- Echo `text` distribution: `"Thank you!"`, `"Sorry, we can't accept any responses now."`, `"Please wait!"`, multiple-choice questions in English and Hausa, button templates, thankyou screens. All these echo normally.
- Meanwhile **hundreds of outbound `user_phone_number` sends in the same window produced zero echoes**.

Sample echo event we DO receive (multiple-choice question, works correctly):

```
sender: { id: 758018254333043 }
recipient: { id: 27697504466519327 }
message: {
  mid: "m_NGfc22fo_HBmmWN81NwZsJwiiSyOXbJeqJDpuQvcgIepAk8nVR-6aH0PGnrWSR-K4oQtYgpCjNcDAszN65aibw",
  is_echo: true,
  text: "Shekarunka nawa?\n\n1) Ƙasa da shekaru 18\n...",
  metadata: "{\"ref\":\"q2_age\",\"type\":\"multiple_choice\"}",
  app_id: 699455733740842
}
```

Sample echo event we DO NOT receive (`user_phone_number` quick reply, missing):

```
(Outbound: "What phone number should we send the mobile credit to?"
 quick_replies: [{ content_type: "user_phone_number" }]
 metadata: '{"ref":"phone_number","type":"phone_number"}'

 No matching is_echo event ever arrives — but the recipient's reply with
 a phone number does arrive on the messages webhook within seconds.)
```

## Impact

- **~860 users currently stuck** in our system because their state machine cannot advance without the missing echo.
- Affects every survey that issues a mobile-credit / payment reward — `girleffectincentive`, `dreampay3`, `bauchipilot1`, `bauchipilot1hausa`, `incentiveswahili`, `ecdenglishincentive`, and more.
- Two pages confirmed affected; presumably any page sending `user_phone_number` quick replies is affected (system-wide change, not page-specific).

## Things we have ruled out

- **Subscription** — `GET /{page-id}/subscribed_apps?access_token=...` confirms `message_echoes` is subscribed on every affected page. No change in subscription history.
- **App permissions** — unchanged. No app review event around 2026-05-21.
- **API version** — we have been on `v22.0` since 2026-02-22; no version change near the cutover.
- **Our own code** — last bot deploy on 2026-05-15; no commits to webhook-handling, message-sending, or quick-reply code between then and the cutover.
- **User-side / network** — recipients still receive the message and can reply. The Send API returns 200 OK with a `message_id`. Failure is specifically the absence of the echo webhook.

## What we'd like to know / what we suspect

1. Is this a known intentional change to `message_echoes` behavior for messages containing sensitive-input quick replies (`user_phone_number`, `user_email`)?
2. If intentional — is `user_email` similarly affected? (We are not yet at scale on that QR but it is the same shape.)
3. If unintentional — please restore echo delivery for these messages.
4. If intentional and permanent — please update the [Quick Replies documentation](https://developers.facebook.com/docs/messenger-platform/send-messages/quick-replies) to document this exception, so the contract is explicit.

## Workaround we are evaluating (please advise)

We rely on `is_echo` as the contract for transitioning users out of the "responding" state — this is by design across our whole app. We're considering temporarily generating a synthetic local echo when we send a `user_phone_number` quick reply, to keep our state machine unblocked. But that's a worse contract than what Facebook has provided historically. Would prefer a fix or a documented behavior we can plan around.

## Contact for follow-up

(Fill in: developer email, app contact, page admin contact)
