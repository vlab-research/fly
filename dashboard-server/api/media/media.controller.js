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
  limits: { fileSize: 200 * 1024 * 1024 },
}).single('file');

/**
 * Factory that creates handler functions with injected IO dependencies.
 *
 * @param {Object} deps
 * @param {Object} deps.credentialQuery - { getOne, get } from Credential queries
 * @param {Object} deps.mediaQuery - { create, list } from Media queries
 * @param {Function} deps.facebookClient - async (token, payload) => fbResponseBody
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
        return res.status(502).json({ error: parsed.error });
      }

      // 6. Build DB record (pure)
      const record = buildMediaRecord(email, pageId, parsed.attachmentId, mediaType, req.file.originalname);

      // 7. Insert into database (IO)
      const saved = await mediaQuery.create(record);

      return res.status(201).json(saved);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  async function listMedia(req, res) {
    const { email } = req.user;
    try {
      const rows = await mediaQuery.list({ email });
      return res.status(200).json(formatMediaList(rows));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  async function listPages(req, res) {
    const { email } = req.user;
    try {
      const credentials = await credentialQuery.get({ email });
      return res.status(200).json(extractPages(credentials));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  return { uploadMedia, listMedia, listPages };
}

module.exports = { upload, makeHandlers };
