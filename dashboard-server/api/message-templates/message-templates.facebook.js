'use strict';

const fetch = require('node-fetch');
const fb = require('../../config').FACEBOOK;

function sanitize(msg) {
  return String(msg || '').replace(/access_token=[^&\s]+/g, 'access_token=REDACTED');
}

async function facebookCreateTemplate(pageId, pageToken, payload) {
  const url = `${fb.url}/${pageId}/message_templates?access_token=${pageToken}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    throw new Error(sanitize(err.message));
  }
}

async function facebookGetTemplatesByName(pageId, pageToken, name) {
  const url = `${fb.url}/${pageId}/message_templates?name=${encodeURIComponent(name)}&access_token=${pageToken}`;
  try {
    const res = await fetch(url, { method: 'GET' });
    return await res.json();
  } catch (err) {
    throw new Error(sanitize(err.message));
  }
}

async function facebookDeleteTemplateByHsmId(pageId, pageToken, hsmId) {
  const url = `${fb.url}/${pageId}/message_templates?hsm_id=${encodeURIComponent(hsmId)}&access_token=${pageToken}`;
  try {
    const res = await fetch(url, { method: 'DELETE' });
    return await res.json();
  } catch (err) {
    throw new Error(sanitize(err.message));
  }
}

module.exports = {
  facebookCreateTemplate,
  facebookGetTemplatesByName,
  facebookDeleteTemplateByHsmId,
};
