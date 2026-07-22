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

// ---------------------------------------------------------------------------
// WhatsApp — template CRUD happens at the WABA (WhatsApp Business Account)
// level, not the phone-number level. The wabaId comes from the
// whatsapp_business credential's details.waba_id; the token is the business
// access token stored on the same credential (NOT a page token).
// ---------------------------------------------------------------------------

async function whatsappCreateTemplate(wabaId, accessToken, payload) {
  const url = `${fb.url}/${wabaId}/message_templates?access_token=${accessToken}`;
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

async function whatsappGetTemplatesByName(wabaId, accessToken, name) {
  const url = `${fb.url}/${wabaId}/message_templates?name=${encodeURIComponent(name)}&access_token=${accessToken}`;
  try {
    const res = await fetch(url, { method: 'GET' });
    return await res.json();
  } catch (err) {
    throw new Error(sanitize(err.message));
  }
}

// WhatsApp's delete-by-id requires BOTH hsm_id AND name (unlike Messenger,
// where hsm_id alone suffices) — hsm_id without name deletes nothing.
async function whatsappDeleteTemplateByHsmId(wabaId, accessToken, hsmId, name) {
  const url = `${fb.url}/${wabaId}/message_templates?hsm_id=${encodeURIComponent(hsmId)}&name=${encodeURIComponent(name)}&access_token=${accessToken}`;
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
  whatsappCreateTemplate,
  whatsappGetTemplatesByName,
  whatsappDeleteTemplateByHsmId,
};
