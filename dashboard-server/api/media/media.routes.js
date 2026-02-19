'use strict';

const multer = require('multer');
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

/**
 * Wraps the multer middleware to catch MulterError (e.g. file too large)
 * and return a proper 400 JSON response instead of letting it bubble
 * to the global error handler.
 */
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File exceeds maximum size of 25 MB' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'File upload error' });
  }
  next();
}

router
  .post('/upload', upload, handleMulterError, handlers.uploadMedia)
  .get('/', handlers.listMedia)
  .get('/pages', handlers.listPages);

module.exports = router;
