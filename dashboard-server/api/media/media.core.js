'use strict';

const VALID_MEDIA_TYPES = ['image', 'video'];
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB

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
  if (!fbResponseBody) {
    return { ok: false, error: { message: 'Empty response from Facebook' } };
  }
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
 * Never exposes access_token or other sensitive fields.
 *
 * @param {Array<Object>} credentialRows - Raw credential rows
 * @returns {Array<{ id: string, name: string }>}
 */
function extractPages(credentialRows) {
  return credentialRows
    .filter(c => c.entity === 'facebook_page' && c.details && c.details.id && c.details.name)
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
