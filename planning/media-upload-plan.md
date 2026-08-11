# Media Upload Feature - Implementation Plan

## Overview

A new top-level "Media" page in the dashboard where users can upload image or video files to Facebook's `message_attachments` API via the dashboard-server, and manage the resulting `attachment_id` values for use in chatbot message templates.

**Architecture**: Browser -> multipart upload to dashboard-server -> forward to Facebook -> store `attachment_id` in DB. No intermediate storage (no GCS, no MinIO).

**Design philosophy**: Functional Core, Imperative Shell. All business logic lives in pure functions (`media.core.js`) that are trivially testable without mocks. The controller is a thin orchestrator that wires pure functions to injected IO dependencies.

## Dependency Graph

```
Chunk 1 (DB Migration)
  |
  v
Chunk 2a (Pure Core + Tests)  <--  no runtime dependency on Chunk 1, but informs data shapes
  |
  v
Chunk 2b (IO Shell + Controller)  <--  depends on Chunk 1 (needs media table) and Chunk 2a (needs core functions)
  |
  v
Chunk 3 (Fetcher Update)  <--  no server dependency, but logically precedes Chunk 4
  |
  v
Chunk 4 (Client UI)  <--  depends on Chunk 2b (API endpoints) and Chunk 3 (FormData support)
  |
  v
Chunk 5 (Testing & Polish)  <--  depends on all above
```

Chunks 1, 2a, and 3 can be implemented in parallel. Chunk 2b depends on Chunks 1 and 2a. Chunk 4 depends on Chunks 2b and 3.

## File Structure Overview

```
dashboard-server/
  api/media/
    index.js              # Re-exports media.routes
    media.core.js         # PURE: all business logic, zero IO
    media.core.test.js    # Unit tests for pure functions (no mocks)
    media.controller.js   # IO SHELL: thin orchestrator with injected dependencies
    media.controller.test.js  # Controller tests (injected mock IO)
    media.routes.js       # Express route definitions
  queries/media/
    media.queries.js      # IO: database queries (pool-bound pattern)
```

### Pure vs IO Separation

| File | Type | Testability |
|------|------|-------------|
| `media.core.js` | **Pure** | Direct unit tests, no mocks, no setup |
| `media.controller.js` | **IO Shell** | Inject mock dependencies, verify orchestration |
| `media.queries.js` | **IO** | Integration tests against real DB |
| `media.routes.js` | **Wiring** | Tested via supertest integration |

---

## Chunk 1: Database Migration

### Required Reading

- `/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql` (lines 170-182 for credentials table pattern)
- `/home/nandan/Documents/vlab-research/fly/devops/migrations/09-export-log-redesign.sql` (latest migration, for numbering and style)

### Files to Create

**`/home/nandan/Documents/vlab-research/fly/devops/migrations/10-media.sql`**

```sql
/*
 * Add media table for tracking Facebook message_attachments uploads.
 *
 * Each row represents a file uploaded to Facebook's message_attachments API
 * via the dashboard. The attachment_id can be used in chatbot message
 * templates (via translate-typeform's translateAttachment function).
 */

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

/*
 * Permissions
 */
GRANT SELECT ON TABLE chatroach.media TO chatreader;
GRANT INSERT, SELECT ON TABLE chatroach.media TO chatroach;
```

### Design Decisions

- **UUID primary key** with `gen_random_uuid()`: matches the pattern used in `campaigns`, `export_status`, and other tables.
- **`userid` FK to `users`**: same pattern as `credentials` and `campaigns`. Enables per-user filtering.
- **`facebook_page_id` as VARCHAR** (not FK to credentials): the credentials table uses a computed column for `facebook_page_id` with a unique constraint, but the media table should survive credential deletion/rotation. Store the page ID as a plain string.
- **`attachment_id` as VARCHAR**: this is the Facebook-assigned ID returned from the `message_attachments` API. It is a permanent identifier.
- **`media_type` as VARCHAR**: constrained at the application level to `'image'` or `'video'`. Matches Facebook's attachment type values.
- **`filename`**: the original filename from the upload. Useful for display in the UI.
- **No `file_size` or `mime_type` columns**: keeping it minimal. Can be added later if needed.
- **No DELETE permission**: media records are append-only. Deleting a record would not remove the attachment from Facebook, so deletion is misleading. Can revisit if needed.

### Acceptance Criteria

- Migration file runs without errors on CockroachDB
- The `media` table is created in the `chatroach` schema
- Permissions are granted to `chatreader` (SELECT) and `chatroach` (INSERT, SELECT)
- Indexes exist on `(userid, created DESC)` and `(facebook_page_id, created DESC)`

---

## Chunk 2a: Pure Core + Unit Tests

### Required Reading

- `/home/nandan/Documents/vlab-research/fly/dashboard-server/utils/responses/response.util.test.js` (pure function test pattern: direct call, assert output)
- `/home/nandan/Documents/vlab-research/fly/CLAUDE.md` ("Functional Core, Imperative Shell" section)

### Dependencies

- None. Pure functions can be written and tested before any IO infrastructure exists.

### Files to Create

#### 1. `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.core.js`

This module contains **all business logic as pure functions**. Every function takes plain data in and returns plain data out. No `require('r2')`, no `require('../../queries')`, no `req`/`res` objects.

```javascript
'use strict';

const VALID_MEDIA_TYPES = ['image', 'video'];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB (Facebook's limit)

/**
 * Validates that all required upload inputs are present and valid.
 *
 * @param {Object} input
 * @param {Object|null} input.file - The uploaded file object (from multer)
 * @param {string|undefined} input.pageId - Facebook page ID
 * @param {string|undefined} input.mediaType - 'image' or 'video'
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
function validateUploadInput({ file, pageId, mediaType }) {
  if (!pageId) {
    return { valid: false, error: 'pageId is required' };
  }
  if (!mediaType || !VALID_MEDIA_TYPES.includes(mediaType)) {
    return { valid: false, error: 'mediaType must be "image" or "video"' };
  }
  if (!file) {
    return { valid: false, error: 'file is required' };
  }
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `file exceeds maximum size of ${MAX_FILE_SIZE} bytes` };
  }
  return { valid: true };
}

/**
 * Constructs a plain object describing what to send to Facebook's
 * POST /me/message_attachments endpoint.
 *
 * Does NOT create actual FormData -- that is IO. Returns the logical
 * payload structure that the IO layer will serialize.
 *
 * @param {{ buffer: Buffer, originalname: string, mimetype: string }} file
 * @param {string} mediaType - 'image' or 'video'
 * @returns {{ message: Object, file: { buffer: Buffer, filename: string, contentType: string } }}
 */
function buildFacebookPayload(file, mediaType) {
  return {
    message: {
      attachment: {
        type: mediaType,
        payload: { is_reusable: true },
      },
    },
    file: {
      buffer: file.buffer,
      filename: file.originalname,
      contentType: file.mimetype,
    },
  };
}

/**
 * Parses Facebook's response from the message_attachments API.
 *
 * @param {Object} fbResponseBody - Raw JSON response from Facebook
 * @returns {{ ok: true, attachmentId: string } | { ok: false, error: Object }}
 */
function parseAttachmentResponse(fbResponseBody) {
  if (fbResponseBody.error) {
    return { ok: false, error: fbResponseBody.error };
  }
  if (!fbResponseBody.attachment_id) {
    return { ok: false, error: { message: 'Facebook response missing attachment_id' } };
  }
  return { ok: true, attachmentId: fbResponseBody.attachment_id };
}

/**
 * Constructs the database row object for a media record.
 *
 * @param {string} email - User's email
 * @param {string} pageId - Facebook page ID
 * @param {string} attachmentId - Facebook attachment ID
 * @param {string} mediaType - 'image' or 'video'
 * @param {string} filename - Original filename
 * @returns {Object} - Row object ready for insertion
 */
function buildMediaRecord(email, pageId, attachmentId, mediaType, filename) {
  return {
    email,
    facebookPageId: pageId,
    attachmentId,
    mediaType,
    filename,
  };
}

/**
 * Transforms raw DB rows into the API response shape for listing media.
 *
 * @param {Array<Object>} rows - Raw database rows
 * @returns {Array<Object>} - Formatted media list
 */
function formatMediaList(rows) {
  return rows.map(row => ({
    id: row.id,
    facebook_page_id: row.facebook_page_id,
    attachment_id: row.attachment_id,
    media_type: row.media_type,
    filename: row.filename,
    created: row.created,
  }));
}

/**
 * Extracts page list from raw credential rows.
 * Filters to facebook_page credentials and returns only {id, name}.
 *
 * @param {Array<Object>} credentialRows - Raw credential rows
 * @returns {Array<{ id: string, name: string }>}
 */
function extractPages(credentialRows) {
  return credentialRows
    .filter(c => c.entity === 'facebook_page')
    .map(c => ({ id: c.details.id, name: c.details.name }));
}

module.exports = {
  VALID_MEDIA_TYPES,
  MAX_FILE_SIZE,
  validateUploadInput,
  buildFacebookPayload,
  parseAttachmentResponse,
  buildMediaRecord,
  formatMediaList,
  extractPages,
};
```

#### 2. `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.core.test.js`

```javascript
'use strict';

const chai = require('chai');
const should = chai.should();

const {
  validateUploadInput,
  buildFacebookPayload,
  parseAttachmentResponse,
  buildMediaRecord,
  formatMediaList,
  extractPages,
  MAX_FILE_SIZE,
} = require('./media.core');

describe('media.core', () => {
  // -------------------------------------------------------
  // validateUploadInput
  // -------------------------------------------------------
  describe('validateUploadInput', () => {
    const validFile = { buffer: Buffer.from('x'), originalname: 'pic.jpg', mimetype: 'image/jpeg', size: 1024 };

    it('returns valid for complete, correct input', () => {
      const result = validateUploadInput({ file: validFile, pageId: '123', mediaType: 'image' });
      result.should.deep.equal({ valid: true });
    });

    it('returns error when pageId is missing', () => {
      const result = validateUploadInput({ file: validFile, pageId: undefined, mediaType: 'image' });
      result.valid.should.equal(false);
      result.error.should.include('pageId');
    });

    it('returns error when pageId is empty string', () => {
      const result = validateUploadInput({ file: validFile, pageId: '', mediaType: 'image' });
      result.valid.should.equal(false);
    });

    it('returns error when mediaType is missing', () => {
      const result = validateUploadInput({ file: validFile, pageId: '123', mediaType: undefined });
      result.valid.should.equal(false);
      result.error.should.include('mediaType');
    });

    it('returns error when mediaType is invalid', () => {
      const result = validateUploadInput({ file: validFile, pageId: '123', mediaType: 'audio' });
      result.valid.should.equal(false);
      result.error.should.include('mediaType');
    });

    it('accepts video as valid mediaType', () => {
      const result = validateUploadInput({ file: validFile, pageId: '123', mediaType: 'video' });
      result.should.deep.equal({ valid: true });
    });

    it('returns error when file is null', () => {
      const result = validateUploadInput({ file: null, pageId: '123', mediaType: 'image' });
      result.valid.should.equal(false);
      result.error.should.include('file');
    });

    it('returns error when file is undefined', () => {
      const result = validateUploadInput({ file: undefined, pageId: '123', mediaType: 'image' });
      result.valid.should.equal(false);
    });

    it('returns error when file exceeds size limit', () => {
      const bigFile = { ...validFile, size: MAX_FILE_SIZE + 1 };
      const result = validateUploadInput({ file: bigFile, pageId: '123', mediaType: 'image' });
      result.valid.should.equal(false);
      result.error.should.include('size');
    });

    it('accepts file at exactly the size limit', () => {
      const maxFile = { ...validFile, size: MAX_FILE_SIZE };
      const result = validateUploadInput({ file: maxFile, pageId: '123', mediaType: 'image' });
      result.should.deep.equal({ valid: true });
    });
  });

  // -------------------------------------------------------
  // buildFacebookPayload
  // -------------------------------------------------------
  describe('buildFacebookPayload', () => {
    it('constructs correct payload structure for image', () => {
      const file = { buffer: Buffer.from('data'), originalname: 'pic.jpg', mimetype: 'image/jpeg' };
      const result = buildFacebookPayload(file, 'image');

      result.message.should.deep.equal({
        attachment: { type: 'image', payload: { is_reusable: true } },
      });
      result.file.filename.should.equal('pic.jpg');
      result.file.contentType.should.equal('image/jpeg');
      result.file.buffer.should.equal(file.buffer);
    });

    it('constructs correct payload structure for video', () => {
      const file = { buffer: Buffer.from('data'), originalname: 'clip.mp4', mimetype: 'video/mp4' };
      const result = buildFacebookPayload(file, 'video');

      result.message.attachment.type.should.equal('video');
      result.file.filename.should.equal('clip.mp4');
      result.file.contentType.should.equal('video/mp4');
    });

    it('sets is_reusable to true', () => {
      const file = { buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' };
      const result = buildFacebookPayload(file, 'image');
      result.message.attachment.payload.is_reusable.should.equal(true);
    });
  });

  // -------------------------------------------------------
  // parseAttachmentResponse
  // -------------------------------------------------------
  describe('parseAttachmentResponse', () => {
    it('extracts attachment_id from successful response', () => {
      const result = parseAttachmentResponse({ attachment_id: '9876543210' });
      result.should.deep.equal({ ok: true, attachmentId: '9876543210' });
    });

    it('returns error when Facebook response has error field', () => {
      const fbError = { message: 'Invalid OAuth token', type: 'OAuthException', code: 190 };
      const result = parseAttachmentResponse({ error: fbError });
      result.ok.should.equal(false);
      result.error.should.deep.equal(fbError);
    });

    it('returns error when attachment_id is missing from response', () => {
      const result = parseAttachmentResponse({ success: true });
      result.ok.should.equal(false);
      result.error.message.should.include('attachment_id');
    });

    it('returns error when response is empty object', () => {
      const result = parseAttachmentResponse({});
      result.ok.should.equal(false);
    });

    it('handles attachment_id as string (Facebook returns strings)', () => {
      const result = parseAttachmentResponse({ attachment_id: '12345' });
      result.attachmentId.should.be.a('string');
    });
  });

  // -------------------------------------------------------
  // buildMediaRecord
  // -------------------------------------------------------
  describe('buildMediaRecord', () => {
    it('constructs record with all fields', () => {
      const result = buildMediaRecord('user@test.com', 'page123', 'attach456', 'image', 'photo.jpg');
      result.should.deep.equal({
        email: 'user@test.com',
        facebookPageId: 'page123',
        attachmentId: 'attach456',
        mediaType: 'image',
        filename: 'photo.jpg',
      });
    });
  });

  // -------------------------------------------------------
  // formatMediaList
  // -------------------------------------------------------
  describe('formatMediaList', () => {
    it('transforms DB rows to API response shape', () => {
      const rows = [
        {
          id: 'uuid-1', facebook_page_id: 'p1', attachment_id: 'a1',
          media_type: 'image', filename: 'pic.jpg', created: '2026-01-01T00:00:00Z',
          userid: 'should-be-stripped',
        },
      ];
      const result = formatMediaList(rows);
      result.should.have.length(1);
      result[0].should.deep.equal({
        id: 'uuid-1', facebook_page_id: 'p1', attachment_id: 'a1',
        media_type: 'image', filename: 'pic.jpg', created: '2026-01-01T00:00:00Z',
      });
      result[0].should.not.have.property('userid');
    });

    it('returns empty array for empty input', () => {
      formatMediaList([]).should.deep.equal([]);
    });

    it('preserves order of rows', () => {
      const rows = [
        { id: '1', facebook_page_id: 'p', attachment_id: 'a', media_type: 'image', filename: 'a.jpg', created: 't1' },
        { id: '2', facebook_page_id: 'p', attachment_id: 'b', media_type: 'video', filename: 'b.mp4', created: 't2' },
      ];
      const result = formatMediaList(rows);
      result[0].id.should.equal('1');
      result[1].id.should.equal('2');
    });
  });

  // -------------------------------------------------------
  // extractPages
  // -------------------------------------------------------
  describe('extractPages', () => {
    it('filters to facebook_page credentials and extracts id+name', () => {
      const creds = [
        { entity: 'facebook_page', details: { id: 'p1', name: 'Page One', access_token: 'secret' } },
        { entity: 'typeform_token', details: { token: 'tf-token' } },
        { entity: 'facebook_page', details: { id: 'p2', name: 'Page Two', access_token: 'secret2' } },
      ];
      const result = extractPages(creds);
      result.should.deep.equal([
        { id: 'p1', name: 'Page One' },
        { id: 'p2', name: 'Page Two' },
      ]);
    });

    it('does not expose access_token', () => {
      const creds = [{ entity: 'facebook_page', details: { id: 'p1', name: 'P', access_token: 'secret' } }];
      const result = extractPages(creds);
      result[0].should.not.have.property('access_token');
    });

    it('returns empty array when no facebook_page credentials exist', () => {
      const creds = [{ entity: 'typeform_token', details: {} }];
      extractPages(creds).should.deep.equal([]);
    });

    it('returns empty array for empty input', () => {
      extractPages([]).should.deep.equal([]);
    });
  });
});
```

### Design Decisions

- **No `req`/`res` objects in pure functions**: Every function takes plain data (strings, objects, buffers) and returns plain data. This makes them usable outside of Express (e.g., in a CLI tool, a worker process, or a migration script).
- **`buildFacebookPayload` returns a logical description, not a FormData**: The actual `FormData` construction (which involves the `form-data` npm package, a form of IO) is handled by the Facebook client in the IO shell. The pure function returns `{message, file}` which describes *what* to send without *how* to serialize it.
- **`extractPages` replaces the inline filter/map in the old `listPages` controller**: This logic was previously inside the controller, making it impossible to test without spinning up Express.
- **Test file is co-located with source**: Following the existing pattern from `dashboard-server/utils/responses/response.util.test.js` and `dashboard-server/api/bails/bails.test.js`.

### Acceptance Criteria

- All pure functions are exported from `media.core.js`
- All tests pass with `mocha api/media/media.core.test.js`
- No IO imports in `media.core.js` (no `require('r2')`, no `require('../../queries')`, no `require('form-data')`)
- Every function has JSDoc describing inputs and outputs

---

## Chunk 2b: IO Shell + Controller

### Required Reading

- `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/facebook/facebook.controller.js` (existing Facebook API call pattern with `r2`)
- `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/bails/bails.controller.js` (thin controller delegating to utils)
- `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/credentials/credentials.queries.js` (query module pattern, especially `getOne`)
- `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/index.js` (auto-discovery of query modules)
- `/home/nandan/Documents/vlab-research/fly/dashboard-server/config/index.js` (Facebook config: `FACEBOOK.url`)
- `/home/nandan/Documents/vlab-research/fly/dashboard-server/server.js` (middleware stack)

### Dependencies

- Chunk 1 (media table must exist for queries)
- Chunk 2a (pure core functions)

### New Dependencies

- **`multer`** (`^1.4.5-lts.1`): multipart form parsing, memory storage
- **`form-data`** (`^4.0.0`): construct multipart body for outbound Facebook API call

### Dependency Injection Pattern

The controller uses a **factory function** pattern. Instead of hardcoding `require('../../queries')` at module scope, the controller exports a factory (`makeHandlers`) that receives IO dependencies as arguments. The routes file calls the factory with the real dependencies. Tests call it with mocks.

This pattern is new to the dashboard-server codebase, but it follows naturally from the bails controller pattern (which delegates to `BailsUtil` -- a step toward separation, but still hardcoded via `require`). The media controller takes the next step by making the dependencies explicit parameters.

### Files to Create

#### 1. `/home/nandan/Documents/vlab-research/fly/dashboard-server/queries/media/media.queries.js`

Follow the exact pattern from `credentials.queries.js`:

```javascript
'use strict';

async function create({ email, facebookPageId, attachmentId, mediaType, filename }) {
  const q = `
    INSERT INTO media (userid, facebook_page_id, attachment_id, media_type, filename)
    VALUES (
      (SELECT id FROM users WHERE email = $1),
      $2, $3, $4, $5
    )
    RETURNING *
  `;
  const values = [email, facebookPageId, attachmentId, mediaType, filename];
  const { rows } = await this.query(q, values);
  return rows[0];
}

async function list({ email }) {
  const q = `
    SELECT m.id, m.facebook_page_id, m.attachment_id, m.media_type,
           m.filename, m.created
    FROM media m
    JOIN users u ON m.userid = u.id
    WHERE u.email = $1
    ORDER BY m.created DESC
  `;
  const values = [email];
  const { rows } = await this.query(q, values);
  return rows;
}

module.exports = {
  name: 'Media',
  queries: pool => ({
    create: create.bind(pool),
    list: list.bind(pool),
  }),
};
```

#### 2. `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.controller.js`

```javascript
'use strict';

const multer = require('multer');
const {
  validateUploadInput,
  buildFacebookPayload,
  parseAttachmentResponse,
  buildMediaRecord,
  formatMediaList,
  extractPages,
} = require('./media.core');

// multer middleware: memory storage, single file field named 'file'
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
}).single('file');

/**
 * Factory that creates handler functions with injected IO dependencies.
 *
 * @param {Object} deps
 * @param {Object} deps.credentialQuery - { getOne, get } from Credential queries
 * @param {Object} deps.mediaQuery - { create, list } from Media queries
 * @param {Function} deps.facebookClient - async (token, fbUrl, payload) => fbResponseBody
 * @returns {Object} - Express handler functions
 */
function makeHandlers({ credentialQuery, mediaQuery, facebookClient }) {

  async function uploadMedia(req, res) {
    const { email } = req.user;
    const { pageId, mediaType } = req.body;

    // 1. Validate inputs (pure)
    const validation = validateUploadInput({ file: req.file, pageId, mediaType });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    try {
      // 2. Look up page token (IO)
      const credential = await credentialQuery.getOne({
        email,
        entity: 'facebook_page',
        key: pageId,
      });

      if (!credential) {
        return res.status(404).json({ error: 'Page not found or not connected' });
      }

      const pageToken = credential.details.access_token;

      // 3. Build Facebook payload (pure)
      const payload = buildFacebookPayload(req.file, mediaType);

      // 4. Upload to Facebook (IO)
      const fbResponseBody = await facebookClient(pageToken, payload);

      // 5. Parse Facebook response (pure)
      const parsed = parseAttachmentResponse(fbResponseBody);
      if (!parsed.ok) {
        console.error('Facebook API error:', parsed.error);
        return res.status(400).json({ error: parsed.error });
      }

      // 6. Build DB record (pure)
      const record = buildMediaRecord(email, pageId, parsed.attachmentId, mediaType, req.file.originalname);

      // 7. Insert into database (IO)
      const saved = await mediaQuery.create(record);

      return res.status(201).json(saved);
    } catch (e) {
      console.error(e);
      return res.status(500).send(e.message || e);
    }
  }

  async function listMedia(req, res) {
    const { email } = req.user;
    try {
      const rows = await mediaQuery.list({ email });
      return res.status(200).json(formatMediaList(rows));
    } catch (e) {
      console.error(e);
      return res.status(500).send(e.message || e);
    }
  }

  async function listPages(req, res) {
    const { email } = req.user;
    try {
      const credentials = await credentialQuery.get({ email });
      return res.status(200).json(extractPages(credentials));
    } catch (e) {
      console.error(e);
      return res.status(500).send(e.message || e);
    }
  }

  return { uploadMedia, listMedia, listPages };
}

module.exports = { upload, makeHandlers };
```

#### 3. Facebook Client Wrapper (IO boundary)

The `facebookClient` dependency is a thin function that converts the logical payload from `buildFacebookPayload` into actual `FormData` and sends it via HTTP. It is defined in the routes file (or could be its own small module) and injected into `makeHandlers`.

```javascript
// Defined in media.routes.js or a small media.facebook.js file:
const FormData = require('form-data');
const r2 = require('r2');
const fb = require('../../config').FACEBOOK;

/**
 * Uploads an attachment to Facebook's message_attachments API.
 * This is the IO boundary -- it converts the pure payload into actual HTTP.
 *
 * @param {string} pageToken - Facebook page access token
 * @param {{ message: Object, file: { buffer: Buffer, filename: string, contentType: string } }} payload
 * @returns {Promise<Object>} - Facebook's JSON response body
 */
async function facebookUploadAttachment(pageToken, payload) {
  const form = new FormData();
  form.append('message', JSON.stringify(payload.message));
  form.append('filedata', payload.file.buffer, {
    filename: payload.file.filename,
    contentType: payload.file.contentType,
  });

  const url = `${fb.url}/me/message_attachments?access_token=${pageToken}`;
  return r2.post(url, { body: form, headers: form.getHeaders() }).json;
}
```

**Note on `r2` compatibility**: If `r2` does not work with `form-data` streams (it is quite minimal), fall back to `node-fetch` directly:

```javascript
const fetch = require('node-fetch');

async function facebookUploadAttachment(pageToken, payload) {
  const form = new FormData();
  form.append('message', JSON.stringify(payload.message));
  form.append('filedata', payload.file.buffer, {
    filename: payload.file.filename,
    contentType: payload.file.contentType,
  });

  const url = `${fb.url}/me/message_attachments?access_token=${pageToken}`;
  const res = await fetch(url, { method: 'POST', body: form, headers: form.getHeaders() });
  return res.json();
}
```

The implementer should test `r2` first. `node-fetch` is already a transitive dependency of `r2`.

#### 4. `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.routes.js`

```javascript
'use strict';

const router = require('express').Router();
const { Credential, Media } = require('../../queries');
const { upload, makeHandlers } = require('./media.controller');
const { facebookUploadAttachment } = require('./media.facebook');

// Wire real IO dependencies into the controller
const handlers = makeHandlers({
  credentialQuery: Credential,
  mediaQuery: Media,
  facebookClient: facebookUploadAttachment,
});

router
  .post('/upload', upload, handlers.uploadMedia)
  .get('/', handlers.listMedia)
  .get('/pages', handlers.listPages);

module.exports = router;
```

#### 5. `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.facebook.js`

(Extracted from the route file for clarity and testability)

```javascript
'use strict';

const FormData = require('form-data');
const r2 = require('r2');
const fb = require('../../config').FACEBOOK;

async function facebookUploadAttachment(pageToken, payload) {
  const form = new FormData();
  form.append('message', JSON.stringify(payload.message));
  form.append('filedata', payload.file.buffer, {
    filename: payload.file.filename,
    contentType: payload.file.contentType,
  });

  const url = `${fb.url}/me/message_attachments?access_token=${pageToken}`;
  return r2.post(url, { body: form, headers: form.getHeaders() }).json;
}

module.exports = { facebookUploadAttachment };
```

#### 6. `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/index.js`

```javascript
module.exports = require('./media.routes');
```

#### 7. `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.controller.test.js`

Tests inject mock IO dependencies. No `proxyquire` needed because `makeHandlers` accepts dependencies explicitly.

```javascript
'use strict';

const chai = require('chai');
const should = chai.should();

const { makeHandlers } = require('./media.controller');

// Helper: create a mock Express response
function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res.body = data; return res; },
    send(data) { res.body = data; return res; },
  };
  return res;
}

describe('media.controller (makeHandlers)', () => {
  // Default mock dependencies
  const defaultCredentialQuery = {
    getOne: async () => ({ entity: 'facebook_page', key: 'page1', details: { access_token: 'tok123', id: 'page1', name: 'Test Page' } }),
    get: async () => [
      { entity: 'facebook_page', details: { id: 'p1', name: 'Page One', access_token: 'tok' } },
    ],
  };
  const defaultMediaQuery = {
    create: async (record) => ({ id: 'uuid-new', ...record, created: '2026-01-01T00:00:00Z' }),
    list: async () => [],
  };
  const defaultFacebookClient = async () => ({ attachment_id: '9876543210' });

  function makeTestHandlers(overrides = {}) {
    return makeHandlers({
      credentialQuery: overrides.credentialQuery || defaultCredentialQuery,
      mediaQuery: overrides.mediaQuery || defaultMediaQuery,
      facebookClient: overrides.facebookClient || defaultFacebookClient,
    });
  }

  // -------------------------------------------------------
  // uploadMedia
  // -------------------------------------------------------
  describe('uploadMedia', () => {
    const validReq = {
      user: { email: 'test@vlab.com' },
      body: { pageId: 'page1', mediaType: 'image' },
      file: { buffer: Buffer.from('data'), originalname: 'pic.jpg', mimetype: 'image/jpeg', size: 1024 },
    };

    it('returns 400 when validation fails (missing pageId)', async () => {
      const handlers = makeTestHandlers();
      const req = { ...validReq, body: { mediaType: 'image' } };
      const res = mockRes();

      await handlers.uploadMedia(req, res);
      res.statusCode.should.equal(400);
      res.body.error.should.include('pageId');
    });

    it('returns 404 when page credential is not found', async () => {
      const handlers = makeTestHandlers({
        credentialQuery: { ...defaultCredentialQuery, getOne: async () => null },
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      res.statusCode.should.equal(404);
      res.body.error.should.include('Page not found');
    });

    it('returns 400 when Facebook returns an error', async () => {
      const fbError = { message: 'Invalid token', type: 'OAuthException', code: 190 };
      const handlers = makeTestHandlers({
        facebookClient: async () => ({ error: fbError }),
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      res.statusCode.should.equal(400);
      res.body.error.should.deep.equal(fbError);
    });

    it('returns 201 with saved record on success', async () => {
      const handlers = makeTestHandlers();
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      res.statusCode.should.equal(201);
      res.body.should.have.property('id');
      res.body.should.have.property('attachmentId', '9876543210');
    });

    it('passes correct token to facebookClient', async () => {
      let capturedToken;
      const handlers = makeTestHandlers({
        facebookClient: async (token) => { capturedToken = token; return { attachment_id: '111' }; },
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      capturedToken.should.equal('tok123');
    });

    it('passes correct record to mediaQuery.create', async () => {
      let capturedRecord;
      const handlers = makeTestHandlers({
        mediaQuery: {
          ...defaultMediaQuery,
          create: async (record) => { capturedRecord = record; return { id: 'uuid', ...record }; },
        },
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      capturedRecord.email.should.equal('test@vlab.com');
      capturedRecord.facebookPageId.should.equal('page1');
      capturedRecord.attachmentId.should.equal('9876543210');
      capturedRecord.mediaType.should.equal('image');
      capturedRecord.filename.should.equal('pic.jpg');
    });

    it('returns 500 when credentialQuery throws', async () => {
      const handlers = makeTestHandlers({
        credentialQuery: { ...defaultCredentialQuery, getOne: async () => { throw new Error('DB down'); } },
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      res.statusCode.should.equal(500);
    });
  });

  // -------------------------------------------------------
  // listMedia
  // -------------------------------------------------------
  describe('listMedia', () => {
    it('returns formatted media list', async () => {
      const rows = [
        { id: '1', facebook_page_id: 'p', attachment_id: 'a', media_type: 'image', filename: 'f.jpg', created: 't', userid: 'stripped' },
      ];
      const handlers = makeTestHandlers({
        mediaQuery: { ...defaultMediaQuery, list: async () => rows },
      });
      const res = mockRes();

      await handlers.listMedia({ user: { email: 'test@vlab.com' } }, res);
      res.statusCode.should.equal(200);
      res.body.should.have.length(1);
      res.body[0].should.not.have.property('userid');
    });

    it('returns empty array when no media exists', async () => {
      const handlers = makeTestHandlers();
      const res = mockRes();

      await handlers.listMedia({ user: { email: 'test@vlab.com' } }, res);
      res.statusCode.should.equal(200);
      res.body.should.deep.equal([]);
    });
  });

  // -------------------------------------------------------
  // listPages
  // -------------------------------------------------------
  describe('listPages', () => {
    it('returns filtered page list from credentials', async () => {
      const handlers = makeTestHandlers();
      const res = mockRes();

      await handlers.listPages({ user: { email: 'test@vlab.com' } }, res);
      res.statusCode.should.equal(200);
      res.body.should.deep.equal([{ id: 'p1', name: 'Page One' }]);
    });

    it('does not expose access_token', async () => {
      const handlers = makeTestHandlers();
      const res = mockRes();

      await handlers.listPages({ user: { email: 'test@vlab.com' } }, res);
      res.body[0].should.not.have.property('access_token');
    });
  });
});
```

### How to Mock the Facebook API in Controller Tests

The key insight: **you don't mock `r2` or `node-fetch`**. You mock the `facebookClient` function itself, because it is an injected dependency.

```javascript
// In test setup:
const handlers = makeHandlers({
  credentialQuery: mockCredentialQuery,
  mediaQuery: mockMediaQuery,
  facebookClient: async (token, payload) => {
    // Return whatever Facebook would return:
    return { attachment_id: '9876543210' };
    // Or simulate an error:
    // return { error: { message: 'Invalid token', type: 'OAuthException', code: 190 } };
    // Or throw to simulate network failure:
    // throw new Error('ETIMEDOUT');
  },
});
```

No `proxyquire`, no `sinon.stub(r2, 'post')`, no `nock`. The Facebook HTTP call is completely isolated behind the `facebookClient` function boundary. The controller tests verify that:

1. The right pure functions are called (validated via the response shape)
2. The right IO dependencies are called in the right order (validated via captured arguments)
3. Errors from any step are handled correctly (validated via response status codes)

### Files to Modify

#### 8. `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/index.js`

Add the media route registration:

```javascript
.use('/media', require('./media'))
```

The full file becomes:
```javascript
const router = require('express').Router();
const bailsController = require('./bails/bails.controller');

router
  .use('/responses', require('./responses'))
  .use('/exports', require('./exports'))
  .use('/users', require('./users'))
  .use('/surveys', require('./surveys'))
  .use('/typeform', require('./typeform'))
  .use('/credentials', require('./credentials'))
  .use('/facebook', require('./facebook'))
  .use('/auth', require('./auth/auth.routes'))
  .use('/media', require('./media'))
  .use('/users/:userId/bails', require('./bails'))
  .use('/surveys/:surveyName/states', require('./states'))
  .get('/users/:userId/bail-events', bailsController.validateUserAccess, bailsController.getUserEvents);

module.exports = router;
```

#### 9. `/home/nandan/Documents/vlab-research/fly/dashboard-server/package.json`

Add two new dependencies:
- `"multer": "^1.4.5-lts.1"` (multipart form parsing)
- `"form-data": "^4.0.0"` (for constructing multipart body to Facebook)

### Acceptance Criteria

- `POST /api/v1/media/upload` accepts multipart form with `file`, `pageId`, and `mediaType` fields
- The endpoint looks up the page token from the credentials table (not from the request body)
- The endpoint forwards the file to Facebook's `POST /me/message_attachments` API
- On success, the endpoint stores a record in the `media` table and returns it (including `attachment_id`)
- On Facebook API error, the endpoint returns 400 with the Facebook error
- On missing/invalid inputs, the endpoint returns 400 with a descriptive message
- `GET /api/v1/media` returns all media records for the authenticated user, ordered by `created DESC`
- `GET /api/v1/media/pages` returns `[{id, name}]` for the user's connected Facebook pages
- File size is limited to 25 MB (Facebook's limit for message attachments)
- All controller tests pass with injected mock dependencies (no real DB or HTTP calls)
- `makeHandlers` factory accepts `{credentialQuery, mediaQuery, facebookClient}` and returns handler functions

---

## Chunk 3: Dashboard Client - Fetcher Update

### Required Reading

- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/services/api/fetcher.js` (the file to modify)

### Dependencies

- None (can be done in parallel with Chunks 1, 2a, and 2b)

### Files to Modify

#### `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/services/api/fetcher.js`

The current code on lines 24-25:

```javascript
if (method === 'POST' || method === 'PUT') opts.headers['Content-Type'] = 'application/json';
if (body) opts.body = JSON.stringify(body);
```

This must be changed to detect `FormData` and skip JSON serialization:

```javascript
if (method === 'POST' || method === 'PUT') {
  if (body instanceof FormData) {
    // Let the browser set Content-Type with boundary automatically
    opts.body = body;
  } else {
    opts.headers['Content-Type'] = 'application/json';
    if (body) opts.body = JSON.stringify(body);
  }
}
```

**Why this approach**: The browser's `fetch` API automatically sets the correct `Content-Type: multipart/form-data; boundary=...` header when the body is a `FormData` instance. Setting `Content-Type` manually would break the boundary parameter. By checking `instanceof FormData`, existing JSON-based calls are completely unaffected.

**Risk assessment**: Low risk. The `instanceof FormData` check is a standard pattern. All existing callers pass plain objects as `body`, which will continue to be JSON-serialized. Only the new Media upload code will pass `FormData`.

### Acceptance Criteria

- `fetcher({ path, method: 'POST', body: formData })` where `formData` is a `FormData` instance sends a proper multipart request
- `fetcher({ path, method: 'POST', body: { key: 'value' } })` continues to send JSON (no regression)
- The `Authorization` header is still attached for all requests including multipart

---

## Chunk 4: Dashboard Client - Media Page

### Required Reading

- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/BailSystems/BailSystems.js` (reference for page structure, hooks, table, loading)
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/BailSystems/index.js` (re-export pattern)
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/Accounts/Accounts.js` (reference for fetching credentials/pages)
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/index.js` (barrel file)
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/root.js` (route registration)
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/Navbar/Navbar.js` (nav link)
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/services/api/fetcher.js` (how to call API)
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/UI/index.js` (Loading, CreateBtn)

### Dependencies

- Chunk 2b (server endpoints must exist)
- Chunk 3 (fetcher must support FormData)

### Files to Create

#### 1. `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/Media/Media.js`

This is the main component. Structure and behavior:

**State variables** (all `useState`):
- `pages` -- array of `{id, name}` from `GET /api/v1/media/pages`
- `media` -- array of media records from `GET /api/v1/media`
- `loading` -- boolean, true while initial data loads
- `uploading` -- boolean, true during file upload
- `selectedPageId` -- string, the chosen Facebook page ID
- `selectedMediaType` -- string, `'image'` or `'video'` (default `'image'`)
- `fileList` -- array for Ant Design Upload component's controlled file list

**On mount** (`useEffect`):
- Fetch pages from `GET /api/v1/media/pages`
- Fetch existing media from `GET /api/v1/media`
- Set `loading = false` when both complete

**Upload handler**:
```javascript
const handleUpload = async () => {
  if (!selectedPageId || fileList.length === 0) {
    message.error('Please select a page and choose a file');
    return;
  }

  setUploading(true);
  try {
    const formData = new FormData();
    formData.append('file', fileList[0].originFileObj || fileList[0]);
    formData.append('pageId', selectedPageId);
    formData.append('mediaType', selectedMediaType);

    const res = await api.fetcher({
      path: '/media/upload',
      method: 'POST',
      body: formData,
    });
    const record = await res.json();
    setMedia([record, ...media]);
    setFileList([]);
    message.success(`Uploaded! Attachment ID: ${record.attachment_id}`);
  } catch (err) {
    message.error('Upload failed: ' + (err.message || 'Unknown error'));
    console.error(err);
  } finally {
    setUploading(false);
  }
};
```

**Copy-to-clipboard handler**:
```javascript
const handleCopy = (attachmentId) => {
  navigator.clipboard.writeText(attachmentId);
  message.success('Attachment ID copied to clipboard');
};
```

**Layout** (follow BailSystems pattern):
```jsx
<Layout>
  <Content style={{ padding: '30px' }}>
    <h2>Media Uploads</h2>

    {/* Upload section */}
    <div style={{ marginBottom: 24, maxWidth: 600 }}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Select
          placeholder="Select a Facebook Page"
          style={{ width: '100%' }}
          value={selectedPageId}
          onChange={setSelectedPageId}
        >
          {pages.map(p => (
            <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>
          ))}
        </Select>

        <Select
          value={selectedMediaType}
          onChange={setSelectedMediaType}
          style={{ width: 200 }}
        >
          <Select.Option value="image">Image</Select.Option>
          <Select.Option value="video">Video</Select.Option>
        </Select>

        <Upload.Dragger
          fileList={fileList}
          beforeUpload={() => false}  /* prevent auto-upload */
          onChange={({ fileList }) => setFileList(fileList.slice(-1))}  /* single file only */
          maxCount={1}
        >
          <p>Click or drag file to this area to select</p>
        </Upload.Dragger>

        <Button
          type="primary"
          onClick={handleUpload}
          loading={uploading}
          disabled={!selectedPageId || fileList.length === 0}
        >
          Upload to Facebook
        </Button>
      </Space>
    </div>

    {/* Results table */}
    <Table
      columns={columns}
      dataSource={media}
      rowKey="id"
      pagination={{ pageSize: 20 }}
    />
  </Content>
</Layout>
```

**Table columns**:
| Column | Field | Notes |
|--------|-------|-------|
| Filename | `filename` | Plain text |
| Type | `media_type` | Ant Design `<Tag>` (green for image, blue for video) |
| Attachment ID | `attachment_id` | Monospace text with a copy button (`<CopyOutlined />`) |
| Page | `facebook_page_id` | Show page name if available (join with pages list), otherwise show ID |
| Uploaded | `created` | `new Date(created).toLocaleString()` |

**Ant Design imports needed**:
```javascript
import { Layout, Table, Button, Select, Upload, Space, Tag, message } from 'antd';
import { CopyOutlined, UploadOutlined, InboxOutlined } from '@ant-design/icons';
```

**Key Ant Design `Upload` props**:
- `beforeUpload={() => false}` -- prevents automatic upload; we handle it manually
- `onChange` -- updates the controlled `fileList` state
- `maxCount={1}` -- only one file at a time
- `accept="image/*,video/*"` -- optional, restricts file picker to image/video types

#### 2. `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/Media/index.js`

```javascript
export { default } from './Media';
```

### Files to Modify

#### 3. `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/index.js`

Add the Media import and export:

```javascript
// Add import:
import Media from './Media';

// Add to exports:
export {
  // ... existing exports ...
  Media,
};
```

#### 4. `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/root.js`

Add the import at the top (alongside other direct container imports):

```javascript
import Media from './containers/Media';
```

Add the route (insert near the other top-level routes, e.g., after the `/bails` routes):

```jsx
<PrivateRoute exact path="/media" component={Media} auth={Auth} />
```

#### 5. `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/Navbar/Navbar.js`

Add a "Media" menu item after the "Bails" item:

```jsx
<Menu.Item>
  <Link to="/media">Media</Link>
</Menu.Item>
```

### Acceptance Criteria

- Navigating to `/media` shows the Media page (requires login)
- "Media" link appears in the top navbar
- Page selector dropdown shows the user's connected Facebook pages
- User can select a file via drag-and-drop or click
- User can choose image or video media type
- Clicking "Upload to Facebook" sends the file and shows a loading spinner
- On success, the new record appears at the top of the table
- Attachment IDs can be copied to clipboard with one click
- Past uploads are displayed in a table with filename, type, attachment ID, page, and date
- Error messages are shown as Ant Design toast notifications
- The page shows a loading spinner while initial data loads

---

## Chunk 5: Testing and Polish

### Required Reading

- `/home/nandan/Documents/vlab-research/fly/dashboard-server/package.json` (test script: `mocha`)
- `/home/nandan/Documents/vlab-research/fly/dashboard-server/api/bails/bails.test.js` (integration test pattern with supertest)

### Dependencies

- All previous chunks

### Testing Summary

The testing strategy follows naturally from the Functional Core / IO Shell separation:

| Layer | Test Type | Mocking Required | Test File |
|-------|-----------|-----------------|-----------|
| Pure core (`media.core.js`) | Unit tests | **None** | `media.core.test.js` (Chunk 2a) |
| Controller (`media.controller.js`) | Unit tests with injected mocks | Mock `credentialQuery`, `mediaQuery`, `facebookClient` via `makeHandlers` | `media.controller.test.js` (Chunk 2b) |
| Integration | Supertest against Express app | Real DB, mock Facebook only | `media.integration.test.js` (this chunk) |

The pure core tests and controller mock tests are already specified in Chunks 2a and 2b. This chunk adds:

### Integration Test

**`/home/nandan/Documents/vlab-research/fly/dashboard-server/api/media/media.integration.test.js`**

One happy-path integration test using supertest (following the pattern from `bails.test.js`):

```javascript
'use strict';

const request = require('supertest');
const { Pool } = require('pg');
require('chai').should();

const { DATABASE_CONFIG } = require('../../config');
const { User } = require('../../queries');
const { AuthUtil } = require('../../utils');
const { makeAPIToken } = AuthUtil;

// NOTE: This test requires the media table (Chunk 1 migration) to exist.
// It also requires mocking the Facebook API call. Since media.routes.js
// wires the real facebookUploadAttachment, this test either:
//   a) Uses proxyquire to replace media.facebook.js, or
//   b) Uses nock to intercept the HTTP call to graph.facebook.com
// Option (b) is simpler for an integration test.

const nock = require('nock');  // may need to add as devDependency
const app = require('../../server');

const email = 'media-test@vlab.com';

describe('Media API Integration', () => {
  let authToken;
  let vlabPool;

  before(async () => {
    authToken = await makeAPIToken({ email });
    vlabPool = new Pool(DATABASE_CONFIG);
    await User.create({ email });

    // Insert a test credential (facebook_page)
    await vlabPool.query(`
      INSERT INTO credentials (entity, key, details, userid)
      VALUES ('facebook_page', 'test-page-id', $1, (SELECT id FROM users WHERE email = $2))
    `, [JSON.stringify({ id: 'test-page-id', name: 'Test Page', access_token: 'fake-token' }), email]);
  });

  after(async () => {
    await vlabPool.query(`DELETE FROM media WHERE userid = (SELECT id FROM users WHERE email = $1)`, [email]);
    await vlabPool.query(`DELETE FROM credentials WHERE userid = (SELECT id FROM users WHERE email = $1)`, [email]);
    await vlabPool.query(`DELETE FROM users WHERE email = $1`, [email]);
    await vlabPool.end();
  });

  it('POST /media/upload - happy path', async () => {
    // Mock Facebook API
    nock('https://graph.facebook.com')
      .post(/\/me\/message_attachments/)
      .reply(200, { attachment_id: '99887766' });

    const res = await request(app)
      .post('/api/v1/media/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .field('pageId', 'test-page-id')
      .field('mediaType', 'image')
      .attach('file', Buffer.from('fake-image-data'), 'test.jpg')
      .expect(201);

    res.body.should.have.property('attachment_id', '99887766');
    res.body.should.have.property('filename', 'test.jpg');
    res.body.should.have.property('media_type', 'image');
  });

  it('GET /media - returns uploaded media', async () => {
    const res = await request(app)
      .get('/api/v1/media')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    res.body.should.be.an('array');
    // May have records from the upload test above
  });

  it('GET /media/pages - returns connected pages', async () => {
    const res = await request(app)
      .get('/api/v1/media/pages')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    res.body.should.be.an('array');
    res.body.should.deep.include({ id: 'test-page-id', name: 'Test Page' });
  });
});
```

**Note**: The integration test uses `nock` to intercept the HTTP call to Facebook. If `nock` is not in devDependencies, add it: `npm install --save-dev nock`. Alternatively, use `proxyquire` (already a devDependency) to replace `media.facebook.js` with a mock module.

### Error Handling to Implement

| Error | Where | Behavior |
|-------|-------|----------|
| No `pageId` in request | `validateUploadInput` (pure) | 400 `{ error: 'pageId is required' }` |
| Invalid `mediaType` | `validateUploadInput` (pure) | 400 `{ error: 'mediaType must be "image" or "video"' }` |
| No file in request | `validateUploadInput` (pure) | 400 `{ error: 'file is required' }` |
| File too large | `validateUploadInput` (pure) + multer | 400 with size error |
| Page not found in credentials | Controller (after IO) | 404 `{ error: 'Page not found or not connected' }` |
| Facebook API returns error | `parseAttachmentResponse` (pure) | 400 with Facebook's error object |
| Network error to Facebook | Controller catch block | 500 with error message |
| Client-side upload failure | Media.js | `message.error()` toast with error message |

### Polish Items

1. **Multer error handling**: Add middleware to catch multer-specific errors (file too large, wrong field name) and return user-friendly messages instead of Express's default 500.

2. **No pages connected**: If `GET /media/pages` returns an empty array, show a message in the UI directing the user to connect a Facebook page first, with a link to `/connect/facebook-messenger`.

3. **Upload progress**: Ant Design's `Upload` component supports `customRequest` which can provide upload progress. For MVP, the simple `uploading` boolean spinner is sufficient. Progress bar can be added later.

4. **File type validation**: Optionally validate on the client side that the file is an image or video before uploading. Use `accept="image/*,video/*"` on the Upload component and validate `file.type` in the `beforeUpload` callback.

### Acceptance Criteria

- All error cases produce clear, actionable messages
- Server does not crash on malformed requests
- Loading states are shown during all async operations
- Empty states are handled (no pages, no uploads)
- All three test layers pass: pure core, controller mocks, integration

---

## New Dependencies Summary

| Package | Where | Version | Purpose |
|---------|-------|---------|---------|
| `multer` | dashboard-server | `^1.4.5-lts.1` | Parse multipart/form-data file uploads |
| `form-data` | dashboard-server | `^4.0.0` | Construct multipart body for outbound Facebook API call |
| `nock` | dashboard-server (devDependency) | `^13.0.0` | Mock HTTP in integration tests (optional, can use proxyquire instead) |

No new client-side dependencies. `FormData` is a browser native. Ant Design's `Upload` component is already available in `antd@4.8.6`.

## Facebook API Reference

**Endpoint**: `POST /me/message_attachments`

**Documentation**: https://developers.facebook.com/docs/messenger-platform/reference/attachment-upload-api/

**Request format** (multipart/form-data):
- `message` field: `{"attachment":{"type":"image","payload":{"is_reusable":true}}}`
- `filedata` field: the binary file

**Response format**:
```json
{ "attachment_id": "1234567890" }
```

**Supported types**: `image`, `video`, `audio`, `file`

**Size limits**: 25 MB for images, 25 MB for video (via attachment upload API)

**Graph API version**: Use the version from `FACEBOOK_GRAPH_URL` config. Current dashboard-server config points to `v9.0`. The implementer should verify this works with the `message_attachments` endpoint and consider updating to a more recent version (e.g., `v22.0` as used by linksniffer in production).

## Configuration Notes

No new environment variables are needed. The media upload feature uses:
- `FACEBOOK_GRAPH_URL` (existing) -- for the Facebook API base URL
- Database connection (existing) -- for the `media` table
- Auth0 JWT (existing) -- for user authentication

The only infrastructure change is running the database migration (Chunk 1).

## Architecture Decision: Why Functional Core / IO Shell

The existing dashboard-server controllers (e.g., `facebook.controller.js`, `exports.controller.js`) put all logic directly in the handler functions. This works for simple endpoints but creates problems for the media upload feature because:

1. **Multiple IO boundaries**: The upload handler talks to the credentials DB, the Facebook API, and the media DB. Testing the logic between these calls requires mocking all three -- or not testing it at all.

2. **Validation logic is tangled with HTTP**: In the old pattern, validation happens inside the `(req, res)` handler, making it impossible to test validation without constructing fake `req`/`res` objects.

3. **Facebook payload construction is tangled with FormData**: The old plan had `new FormData()` inside the controller. Testing that the payload is correct would require either mocking `FormData` or making real HTTP calls.

The redesigned architecture addresses all three:
- **Pure functions** (`media.core.js`) handle validation, payload construction, response parsing, and data formatting. Each is tested with direct `assert(f(input) === expectedOutput)` -- no mocks, no setup, no teardown.
- **The controller** (`media.controller.js`) is a thin orchestrator. Its `makeHandlers` factory receives IO dependencies as parameters. Tests inject simple mock functions and verify the orchestration logic.
- **IO implementations** (`media.queries.js`, `media.facebook.js`) are small, focused, and only tested at the integration level.

This is a new pattern for the dashboard-server codebase, but it is a natural evolution from the bails controller pattern (which already delegates to `BailsUtil`). The `makeHandlers` factory makes the dependency injection explicit rather than hidden behind `require()`.
