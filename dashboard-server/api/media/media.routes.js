'use strict';

const multer = require('multer');
const router = require('express').Router();

const { Credential, Media } = require('../../queries');
const { STORAGE } = require('../../config');
const { makeHandlers } = require('./media.controller');
const { makeStorage } = require('./storage');
const { uploadToPlatform } = require('./media.platform-upload');
const { MEDIA_TYPE_LIMITS } = require('./media.core');

/*
 * The multer cap is DERIVED from the core's per-type limits, never hardcoded.
 *
 * It used to be a flat 25 MB, which preempted validateUpload: a 40 MB video
 * died inside multer with "File exceeds maximum size of 25 MB" instead of
 * "video is 40.0 MB, maximum is 16.0 MB". §11.5's whole bargain is that we
 * refuse rather than transcode, and the refusal is only fair if it names the
 * actual problem and the actual fix — so multer must be a backstop against
 * unbounded memory, not the thing that decides eligibility.
 *
 * Set to the LARGEST per-type limit (documents, 100 MB) so every per-type error
 * message comes from the core. A file over that is beyond every limit we have,
 * and its message can safely be generic.
 */
const MAX_UPLOAD_BYTES = Math.max(
  ...Object.values(MEDIA_TYPE_LIMITS).map(limit => limit.maxBytes),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
}).single('file');

const handlers = makeHandlers({
  credentialQuery: Credential,
  mediaQuery: Media,
  storage: makeStorage(STORAGE),
  platformUpload: uploadToPlatform,
});

/**
 * Turns multer's errors into JSON 400s rather than letting them reach the
 * global error handler.
 */
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMB = (MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);
      return res.status(400).json({ error: `file exceeds the maximum upload size of ${maxMB} MB` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'File upload error' });
  }
  next();
}

/*
 * GET /pages IS GONE, on purpose (§3). Asset creation is platform-independent:
 * there is no page selector, no connected-page requirement, and no account
 * scope for the author to choose. Fan-out goes to all of the owner's accounts
 * and is best-effort, so a researcher with no accounts connected yet uploads
 * fine and handles appear when they connect one.
 *
 * DELETE /:id is deliberately NOT offered in v1 (planning/media-abstraction.md §11.6).
 * The reasons are stated in the plan: no backup (VIR-24) and no reference counting
 * against surveys, so deletion is a click that irrevocably breaks any live survey
 * that references the asset with zero signal to anyone. The accidental-confidential-
 * upload case is handled out-of-band — the researcher tells us and we delete it
 * after a human considers whether the URL escaped. Once backup exists and reference
 * counting against surveys is implemented, deletion can be revisited.
 */
router
  .post('/upload', upload, handleMulterError, handlers.uploadMedia)
  .get('/', handlers.listMedia);

module.exports = router;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
