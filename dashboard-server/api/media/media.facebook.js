'use strict';

const FormData = require('form-data');
const fetch = require('node-fetch');
const fb = require('../../config').FACEBOOK;

/**
 * Uploads an attachment to Facebook's message_attachments API.
 * This is the IO boundary -- it converts the pure payload into actual HTTP.
 *
 * Uses node-fetch directly instead of r2 because r2's makeBody()
 * mangles FormData streams (it only supports Buffer/string bodies).
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
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
    });
    return await res.json();
  } catch (err) {
    // Sanitize: never leak the access token in error messages
    const safeMsg = (err.message || '').replace(/access_token=[^&\s]+/g, 'access_token=REDACTED');
    throw new Error(safeMsg);
  }
}

module.exports = { facebookUploadAttachment };
