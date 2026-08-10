# Facebot

Fake facebook chatbot used for testing purposes.

## Mock Endpoints (`receiver/index.js`)

### Message Send (Polling)

- `POST /me/messages` — Messenger message send, queues for polling
- `POST /:phoneNumberId/messages` — WhatsApp message send, queues for polling
- `GET /sent/:id` — Poll and retrieve queued messages
- `POST /respond/:token` — Callback response to a polled message

### Message Handoff

- `POST /me/pass_thread_control` — Handoff/thread control response (handover protocol)

### Media Upload (Pre-upload Fan-out)

- `POST /me/message_attachments` — Messenger attachment upload; returns `{attachment_id: "<id>"}`
- `POST /:phoneNumberId/media` — WhatsApp media upload; returns `{id: "<id>"}`

### Inspection Routes

- `GET /uploads` — Returns array of all recorded uploads
- `POST /uploads/reset` — Clears recorded uploads and returns `{reset: true}`

**Upload Record Shape**: Each upload in `/uploads` contains `endpoint`, `timestamp`, `body`, and `phoneNumberId` (WhatsApp only).