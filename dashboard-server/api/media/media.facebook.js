'use strict';

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

module.exports = { facebookUploadAttachment };
