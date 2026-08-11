# Image/Media Pre-Uploading Pattern & Utility Message Templates

## Overview

The fly codebase has a **complete, production-ready media pre-upload system** that handles Facebook image/video attachment uploads. This document traces the entire flow and provides a reference architecture for designing an analogous flow for Facebook Utility Message templates.

---

## 1. Dashboard UI: Image/Media Upload Page

### Location
`/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/Media/Media.js`

### User Flow
1. **Navigate**: User clicks "Media" link in navbar → `/media` route
2. **Select page**: Dropdown lists connected Facebook pages (retrieved from `GET /api/v1/media/pages`)
3. **Select type**: Radio buttons choose between "Image" or "Video"
4. **Upload**: Drag-and-drop or click to upload file (Ant Design `Upload.Dragger` component)
5. **Processing**: Form data sent to `POST /api/v1/media/upload`
6. **Result**: On success, displays success message with **copyable `attachment_id`**
7. **List**: Table below shows all uploaded media with columns:
   - Filename
   - Type (image/video)
   - **Attachment ID** (copyable text field)
   - Page name
   - Uploaded date

### Key UI Details
- **Page selection dropdown** (line 141-150): Scoped per user via Auth0 token
- **Media type radio buttons** (line 153-156): 'image' or 'video' (sent to server)
- **File upload handler** (line 41-77):
  - Creates FormData with: `file`, `pageId`, `mediaType`
  - Sends to `/media/upload` POST
  - Displays error/success message
  - Updates table immediately with returned record
- **Attachment ID display** (line 100-102): Uses Ant Design's `copyable` Text component for easy copy-to-clipboard
- **Loading state**: Shows spinner while uploading (line 170)

---

## 2. Dashboard Server: API Endpoints

### Routing
**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.routes.js`

The media routes are mounted at `/api/v1/media`:

```
POST   /media/upload      → uploadMedia (file upload)
GET    /media             → listMedia (list user's uploaded media)
GET    /media/pages       → listPages (list connected Facebook pages)
```

### 2A. POST /media/upload: Upload File to Facebook

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.controller.js` (lines 30-78)

**Request**:
- Method: POST
- Headers: Authorization: Bearer {Auth0 token} (auto-added by dashboard-client)
- Content-Type: multipart/form-data (auto-set by browser, body is FormData)
- Body fields:
  - `file` — the binary file (from multer)
  - `pageId` — Facebook page ID (string, sent as form field)
  - `mediaType` — 'image' or 'video' (string, sent as form field)

**Response (201 Created)**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "facebook_page_id": "123456789",
  "attachment_id": "1234567890:1234567890",
  "media_type": "image",
  "filename": "photo.jpg",
  "created": "2026-02-18T23:26:00Z"
}
```

**Processing Steps**:
1. **Validate inputs** (pure function `validateUploadInput`):
   - Check `pageId` is provided
   - Check `mediaType` is 'image' or 'video'
   - Check `file` exists and size ≤ 200 MB
2. **Look up page token** (IO): Query credentials table for the page's access token
   - Query: `SELECT * FROM credentials WHERE email=$1 AND entity='facebook_page' AND key=$2`
   - Access token stored in `credentials.details.access_token`
3. **Build Facebook payload** (pure function `buildFacebookPayload`):
   - Constructs form fields for Facebook API:
     ```json
     {
       "message": {
         "attachment": {
           "type": "image|video",
           "payload": { "is_reusable": true }
         }
       },
       "file": { buffer, filename, contentType }
     }
     ```
4. **Upload to Facebook** (IO): POST to `https://graph.facebook.com/v{version}/me/message_attachments`
   - Uses **node-fetch** + **form-data** to properly handle multipart boundaries
   - Includes access token in query param: `?access_token={pageToken}`
   - Request body is multipart FormData with:
     - Field `message`: JSON string of attachment template
     - Field `filedata`: binary file buffer
5. **Parse response** (pure function `parseAttachmentResponse`):
   - Check for `error` field → return error
   - Check for `attachment_id` field → success
   - Return either `{ ok: true, attachmentId: "..." }` or `{ ok: false, error: {...} }`
6. **Insert into database** (IO): Save to `media` table with:
   - `userid` (foreign key to users, looked up via email)
   - `facebook_page_id` (the page ID)
   - `attachment_id` (from Facebook response)
   - `media_type` ('image' or 'video')
   - `filename` (original filename)
   - `created` (CURRENT_TIMESTAMP)
7. **Return 201** with the inserted row

**Error Handling**:
- 400: Missing/invalid inputs (pageId, mediaType, file, file size)
- 404: Page not found (credential not found for the page)
- 502: Facebook API error (invalid response, missing attachment_id)
- 500: Database error or internal server error

### 2B. GET /media/list: Retrieve User's Uploaded Media

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.controller.js` (lines 80-88)

**Request**:
- Method: GET
- Headers: Authorization: Bearer {Auth0 token}

**Response (200 OK)**:
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "facebook_page_id": "123456789",
    "attachment_id": "1234567890:1234567890",
    "media_type": "image",
    "filename": "photo.jpg",
    "created": "2026-02-18T23:26:00Z"
  },
  ...
]
```

**Query** (line 17-28 in queries/media/media.queries.js):
```sql
SELECT m.id, m.facebook_page_id, m.attachment_id, m.media_type,
       m.filename, m.created
FROM media m
JOIN users u ON m.userid = u.id
WHERE u.email = $1
ORDER BY m.created DESC
```

- Filters by authenticated user's email
- Orders newest first
- Returns all columns needed for the UI table

### 2C. GET /media/pages: List Connected Facebook Pages

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.controller.js` (lines 91-100)

**Request**:
- Method: GET
- Headers: Authorization: Bearer {Auth0 token}

**Response (200 OK)**:
```json
[
  { "id": "123456789", "name": "My Page" },
  { "id": "987654321", "name": "My Other Page" }
]
```

**Processing**:
1. Query credentials for user: `SELECT * FROM credentials WHERE email=$1`
2. Filter to only `entity='facebook_page'` (pure function `extractPages`)
3. Extract `id` and `name` from `credentials.details` JSON
4. Never expose access tokens or other sensitive fields
5. Return `[{ id, name }, ...]`

---

## 3. Database: Media Table Schema

**File**: `/home/nandan/Documents/vlab-research/fly/devops/migrations/10-media.sql`

```sql
CREATE TABLE IF NOT EXISTS chatroach.media(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
    facebook_page_id VARCHAR NOT NULL,
    attachment_id VARCHAR NOT NULL,
    media_type VARCHAR NOT NULL,       -- 'image' or 'video'
    filename VARCHAR NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (userid, created DESC),
    INDEX (facebook_page_id, created DESC)
);

GRANT SELECT ON TABLE chatroach.media TO chatreader;
GRANT INSERT, SELECT ON TABLE chatroach.media TO chatroach;
```

### Schema Design
- **id**: UUID primary key with auto-generation
- **userid**: Foreign key to `users(id)`, cascade on delete (if user deletes account, media records go too)
- **facebook_page_id**: VARCHAR (page ID as string, not FK to credentials—survives credential rotation)
- **attachment_id**: VARCHAR (Facebook's permanent ID returned from API)
- **media_type**: VARCHAR constrained to 'image' or 'video' at application level
- **filename**: Original uploaded filename (for display)
- **created**: Timestamp, defaults to current time
- **Indexes**:
  - `(userid, created DESC)` — fast lookup of user's media newest-first
  - `(facebook_page_id, created DESC)` — fast lookup of page's media

### Design Rationale
- No file size or mime type stored (can be added later if needed)
- No DELETE permission (media records are append-only; deletion wouldn't remove from Facebook)
- Attachment IDs are permanent and reusable across message sends

---

## 4. How Attachment IDs Are Used in Surveys

### 4A. JSON Structure in Typeform Question

Users add JSON to a **Typeform statement field description** to reference pre-uploaded media:

**Format** (documented in `/home/nandan/Documents/vlab-research/fly/documentation/questions.md`):

```json
{"type": "attachment",
 "keepMoving": true,
 "attachment": {
    "type": "image|video",
    "url": "https://i.imgur.com/..."  OR  "attachment_id": "1234567890:1234567890"
 }
}
```

**Two modes supported**:
1. **By URL** (legacy, external/uploaded URLs):
   ```json
   {
     "type": "attachment",
     "attachment": {
       "type": "image",
       "url": "https://i.imgur.com/ZSHauqq.png"
     }
   }
   ```

2. **By attachment_id** (pre-uploaded via dashboard):
   ```json
   {
     "type": "attachment",
     "attachment": {
       "type": "image",
       "attachment_id": "1234567890:1234567890"
     }
   }
   ```

### 4B. Translation in translate-typeform Package

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/node_modules/@vlab-research/translate-typeform/translate-fields.js` (lines 278-300)

**Function**: `translateAttachment(data)`

```javascript
const translateAttachment = (data) => {
  const { attachment } = data.md
  const { type, url, attachment_id } = attachment

  const payload = {}

  if (url) {
    payload['url'] = url
    payload['is_reusable'] = true    // Facebook will cache the image
  }

  if (attachment_id) {
    payload['attachment_id'] = attachment_id  // Use pre-uploaded ID
  }

  const response = {
    "attachment": {
      "type": type,       // 'image', 'video', 'audio', 'file'
      "payload": payload
    }
  }
  return response
}
```

**Output to Facebook Send API**:
```json
{
  "message": {
    "attachment": {
      "type": "image",
      "payload": {
        "attachment_id": "1234567890:1234567890"
      }
    }
  }
}
```

Or with URL (for comparison):
```json
{
  "message": {
    "attachment": {
      "type": "image",
      "payload": {
        "url": "https://i.imgur.com/ZSHauqq.png",
        "is_reusable": true
      }
    }
  }
}
```

### 4C. Field Type Registration

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/node_modules/@vlab-research/translate-typeform/translate-fields.js` (line 326)

```javascript
const lookup = {
  // ... other field types ...
  'attachment': translateAttachment,
  // ...
}
```

When Typeform question has `type: 'attachment'`, the translator routes it to `translateAttachment()`.

---

## 5. Full Round-Trip: User Upload to Sent Message

### Step 1: User Uploads Image in Dashboard
1. Navigate to `/media` page
2. Select Facebook page
3. Choose "Image" media type
4. Drag and drop or click to upload `photo.jpg`
5. Dashboard sends `POST /api/v1/media/upload` with FormData:
   - `file: <binary>` 
   - `pageId: "123456789"`
   - `mediaType: "image"`

### Step 2: Server Uploads to Facebook & Stores ID
1. Dashboard-server receives request, validates inputs
2. Looks up page access token from credentials table
3. Calls Facebook `POST /{pageId}/message_attachments`:
   - Multipart form with `message` + `filedata`
   - Facebook returns: `{ attachment_id: "1234567890:1234567890" }`
4. Inserts into `media` table:
   - `userid`, `facebook_page_id: "123456789"`, `attachment_id: "1234567890:1234567890"`, `media_type: "image"`, `filename: "photo.jpg"`, `created: NOW()`
5. Returns 201 with the inserted row

### Step 3: UI Displays Attachment ID
1. Media.js receives response with `attachment_id`
2. Shows success message: "Uploaded! Attachment ID: 1234567890:1234567890"
3. Adds record to table with copyable attachment ID
4. User copies the ID: `1234567890:1234567890`

### Step 4: Survey Author References ID in Typeform
1. In Typeform, adds a **Statement** field
2. Sets description to JSON:
   ```json
   {"type": "attachment",
    "keepMoving": true,
    "attachment": {
      "type": "image",
      "attachment_id": "1234567890:1234567890"
    }
   }
   ```
3. Saves Typeform

### Step 5: Replybot Sends Message to Facebook User
1. Replybot parses form JSON, encounters `type: 'attachment'`
2. Calls `translateAttachment()` with the JSON
3. Extracts `attachment.attachment_id` → `"1234567890:1234567890"`
4. Builds message payload:
   ```json
   {
     "recipient": { "id": "PSID" },
     "message": {
       "attachment": {
         "type": "image",
         "payload": { "attachment_id": "1234567890:1234567890" }
       }
     }
   }
   ```
5. POSTs to Facebook `/{pageId}/messages`
6. Facebook sends the cached image to the user in Messenger

---

## 6. Key Implementation Patterns

### 6A. Pure vs IO Separation

The media feature demonstrates the **Functional Core, Imperative Shell** pattern from CLAUDE.md:

**Pure Functions** (`media.core.js`):
- `validateUploadInput()` — validates inputs, returns error object
- `buildFacebookPayload()` — constructs API payload
- `parseAttachmentResponse()` — parses Facebook response
- `buildMediaRecord()` — shapes database row
- `formatMediaList()` — transforms DB rows to API response
- `extractPages()` — filters credentials to pages

**IO Layer** (`media.controller.js`):
- Orchestrates pure functions with injected dependencies
- Handles Express request/response
- Manages database queries and Facebook API calls

**Dependency Injection**:
```javascript
const handlers = makeHandlers({
  credentialQuery: Credential,
  mediaQuery: Media,
  facebookClient: facebookUploadAttachment,
});
```

This allows testing pure core independently without mocking.

### 6B. File Upload Handling

**multer middleware** (media.controller.js, line 14-17):
```javascript
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },  // 200 MB
}).single('file');
```

- **Memory storage**: Files loaded into memory (OK for images/videos, not for massive files)
- **Single file**: Only one file per request (`single('file')`)
- **Size limit**: Enforced by multer
- **Error handling**: Custom middleware catches `multer.MulterError` and returns JSON (not default HTML error page)

### 6C. FormData Support in Client Fetcher

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/services/api/fetcher.js` (lines 24-31)

```javascript
if (method === 'POST' || method === 'PUT') {
  if (body instanceof FormData) {
    // Let the browser set Content-Type with multipart boundary automatically
    opts.body = body;
  } else {
    opts.headers['Content-Type'] = 'application/json';
    if (body) opts.body = JSON.stringify(body);
  }
}
```

- Detects FormData objects
- Skips JSON serialization
- Lets browser auto-set `Content-Type: multipart/form-data; boundary=...`
- For non-FormData: sets `application/json` and JSON.stringify

### 6D. Facebook API Integration

**File**: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.facebook.js`

Uses **node-fetch** + **form-data** (not the r2 HTTP client used elsewhere):
- Reason: r2 doesn't properly handle FormData streams
- Constructs proper multipart boundary
- Appends JSON message + binary file
- Sanitizes error messages to never leak access tokens (line 36)

---

## 7. Designing Utility Message Templates Analogously

Based on this pattern, here's how to design a **Utility Message Template pre-upload system**:

### 7A. Dashboard UI Component

Create `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/UtilityMessageTemplates/UtilityMessageTemplates.js`:

**Structure** (mirroring Media.js):
1. **Page selector dropdown** → list of connected Facebook pages
2. **Template type radio buttons** → "Text Only", "With Image", "With Button", etc.
3. **Form fields**:
   - Title (max 65 chars per Facebook)
   - CTA text ("ALLOW", "GET", "GET_UPDATES", "OPT_IN", "SIGN_UP")
   - Optional timezone selector
   - Optional image upload (pre-upload to get attachment_id)
   - Optional message body
4. **Submit button** → POST to `/api/v1/utility-message-templates/create`
5. **List table** → Show templates with:
   - Title
   - Type
   - CTA text
   - Associated image (if any)
   - Created date
   - **Copy action** for template ID (like attachment IDs)

### 7B. API Endpoints

Mount at `/api/v1/utility-message-templates`:

```
POST   /utility-message-templates         → createTemplate
GET    /utility-message-templates         → listTemplates
GET    /utility-message-templates/:id     → getTemplate (for preview)
```

**POST /create** request:
```json
{
  "pageId": "123456789",
  "title": "Get your results",
  "notificationMessagesCtaText": "ALLOW",
  "timezone": "US/Pacific",
  "attachmentId": "1234567890:1234567890",
  "description": "Survey results are ready"
}
```

**Response (201)**:
```json
{
  "id": "template-uuid-here",
  "pageId": "123456789",
  "title": "Get your results",
  "ctaText": "ALLOW",
  "timezone": "US/Pacific",
  "attachmentId": "1234567890:1234567890",
  "description": "Survey results are ready",
  "created": "2026-02-18T23:26:00Z"
}
```

### 7C. Database Table

Create migration `/home/nandan/Documents/vlab-research/fly/devops/migrations/11-utility-message-templates.sql`:

```sql
CREATE TABLE IF NOT EXISTS chatroach.utility_message_templates(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
    facebook_page_id VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    notification_messages_cta_text VARCHAR NOT NULL,
    timezone VARCHAR DEFAULT 'UTC',
    attachment_id VARCHAR,                 -- optional, refs media table
    description VARCHAR,
    created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (userid, created DESC),
    INDEX (facebook_page_id, created DESC)
);

GRANT SELECT ON TABLE chatroach.utility_message_templates TO chatreader;
GRANT INSERT, SELECT ON TABLE chatroach.utility_message_templates TO chatroach;
```

### 7D. Typeform Integration

In Typeform question description, add JSON for **utility message opt-in request**:

```json
{
  "type": "notification_messages",
  "title": "Get your results",
  "ctaText": "ALLOW",
  "timezone": "US/Pacific"
}
```

**Alternative: reference pre-defined template**:
```json
{
  "type": "notification_messages_template",
  "templateId": "template-uuid-here"
}
```

### 7E. Translator Addition

Add to `/home/nandan/Documents/vlab-research/fly/replybot/node_modules/@vlab-research/translate-typeform/translate-fields.js`:

```javascript
const translateNotificationMessages = (data) => {
  const { title, ctaText = 'ALLOW', timezone = 'UTC' } = data.md
  
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "notification_messages",
        title: title,
        notification_messages_cta_text: ctaText,
        notification_messages_timezone: timezone,
        payload: JSON.stringify({ ref: data.ref })
      }
    }
  }
}

const lookup = {
  // ... existing ...
  'notification_messages': translateNotificationMessages,
}
```

---

## 8. Key Differences Between Media & Utility Message Templates

| Aspect | Media Upload | Utility Message Template |
|--------|-------------|------------------------|
| **What's uploaded** | Binary file (image/video) | JSON template definition |
| **Facebook API** | `POST /message_attachments` | `POST /messages` (for opt-in) |
| **Stored ID** | `attachment_id` (Facebook) | `template_id` (app-generated UUID) |
| **Reuse** | File cached by Facebook, can send many times | Template sent once per opt-in, then user token used for messaging |
| **Dashboard UI** | File drag-drop, simple form | Form fields for template metadata |
| **Database table** | `media` (file metadata) | `utility_message_templates` (template definition) |
| **Typeform reference** | `"attachment": { "attachment_id": "..." }` | `"type": "notification_messages"` with metadata |

---

## 9. File Paths Summary

### Dashboard Client
- Route: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/root.js` (line 43)
- Navbar: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/Navbar/Navbar.js` (line 21)
- Container: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/Media/Media.js`
- Fetcher: `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/services/api/fetcher.js`

### Dashboard Server
- Routes: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.routes.js`
- Controller: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.controller.js`
- Core: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.core.js`
- Facebook IO: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.facebook.js`
- Queries: `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/media/media.queries.js`
- Router wiring: `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/index.js` (line 12)

### Database
- Migration: `/home/nandan/Documents/vlab-research/fly/devops/migrations/10-media.sql`

### Replybot / Translate-typeform
- Translator: `/home/nandan/Documents/vlab-research/fly/replybot/node_modules/@vlab-research/translate-typeform/translate-fields.js` (lines 278-300)
- Lookup: `/home/nandan/Documents/vlab-research/fly/replybot/node_modules/@vlab-research/translate-typeform/translate-fields.js` (line 326)

### Documentation
- Questions/attachments: `/home/nandan/Documents/vlab-research/fly/documentation/questions.md` (lines 47-72)
- Utility messages: `/home/nandan/Documents/vlab-research/fly/documentation/marketing-messages.md`

---

## 10. Summary: What's Needed for Utility Message Templates

To implement utility message template pre-upload analogously:

1. **Database**: New `utility_message_templates` table (schema similar to media, but stores template JSON, not files)
2. **Dashboard Server**:
   - Pure core functions (validate, build template payload, parse responses)
   - Controller to orchestrate (handle requests, call Facebook API if needed, store templates)
   - Routes (POST create, GET list, GET detail for preview)
   - Queries module (CRUD against new table)
3. **Dashboard Client**:
   - New UtilityMessageTemplates container (form fields for template metadata)
   - Route + navbar link
   - Form submission to POST endpoint
4. **Replybot**:
   - Translator function to build Facebook `notification_messages` template payload
   - Register in lookup table
5. **Documentation**:
   - Document the JSON format for Typeform question descriptions
   - Update questions.md with examples

The architecture mirrors the media upload system exactly—just with different file handling (no binary upload), different stored metadata, and different Facebook API calls.
