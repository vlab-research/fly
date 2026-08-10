'use strict';

/*
 * Pre-upload of asset bytes to a messaging platform, producing a HANDLE
 * (planning/media-abstraction.md §2).
 *
 * This is `media.facebook.js` generalised, not replaced. The mechanism it used
 * — node-fetch with a multipart FormData body, POSTed with a page token before
 * any send — already works in production; only the model around it changed.
 *
 * BOTH PLATFORMS ARE ONE CODE PATH. Under pre-upload, Messenger and WhatsApp
 * are the same operation with a different endpoint, a different form shape and
 * a different id field in the response:
 *
 *   Messenger  POST /me/message_attachments        -> {attachment_id}  +90 days
 *   WhatsApp   POST /{phone_number_id}/media       -> {id}             +30 days
 *
 * MESSENGER EXPIRES. Meta documents "Attachment IDs expire after 90 days"
 * (messenger-platform/send-messages/saving-assets). An earlier draft of this
 * design recorded it as never expiring, which would have been a silent failure
 * rather than a documentation nit: with no expiry, the reconciler never
 * refreshes, every Messenger handle dies at 90 days, and because a handle is
 * only ever an optimisation, every send falls back to URL forever with nothing
 * erroring — on the platform carrying ~100% of live media traffic. Never
 * reintroduce a null expiry here.
 *
 * IO BOUNDARY. Everything above this line in the call stack is pure.
 */

const FormData = require('form-data');
const fetch = require('node-fetch');

const fb = require('../../config').FACEBOOK;
const { canonicalPlatform, DEFAULT_RECONCILE_POLICY } = require('./media.core');

/**
 * Per-platform differences, and nothing else. Adding a platform is adding a row
 * here plus a TTL in DEFAULT_RECONCILE_POLICY.ttlMs — the TTL is read from the
 * core rather than duplicated, so the reconciler's notion of when a handle dies
 * and the writer's notion of when it expires cannot drift apart.
 */
const PLATFORMS = {
  messenger: {
    path: () => '/me/message_attachments',
    idField: 'attachment_id',
    form: (form, { buffer, filename, contentType, mediaType }) => {
      form.append(
        'message',
        JSON.stringify({
          attachment: { type: mediaType, payload: { is_reusable: true } },
        }),
      );
      form.append('filedata', buffer, { filename, contentType });
    },
  },
  whatsapp: {
    // account_id for a whatsapp_business credential IS the phone number id
    // (credentials.key), which is what makes the handle key work — see
    // devops/migrations/24-media-assets.sql.
    path: accountId => `/${encodeURIComponent(accountId)}/media`,
    idField: 'id',
    form: (form, { buffer, filename, contentType }) => {
      form.append('messaging_product', 'whatsapp');
      form.append('type', contentType);
      form.append('file', buffer, { filename, contentType });
    },
  },
};

/** Never let a token reach a log line or an error message. */
function sanitize(message) {
  return String(message || '').replace(/access_token=[^&\s]+/g, 'access_token=REDACTED');
}

/**
 * Uploads bytes to one platform account and returns the handle facts.
 *
 * Resolves rather than throws on a platform-level error: fan-out is
 * best-effort, and a failure for one account is a logged miss, never an
 * exception that could take the upload response with it. `now` is a parameter
 * so expiry is testable without a clock.
 *
 * @param {Object} args
 * @param {string} args.platform - 'messenger'|'whatsapp' (or a credentials.entity spelling)
 * @param {string} args.accountId - credentials.key
 * @param {string} args.accessToken
 * @param {{buffer: Buffer, filename: string, contentType: string, mediaType: string}} args.file
 * @param {Date} [args.now]
 * @returns {Promise<{ok:true, platform, platformMediaId, uploadedAt, expiresAt}|{ok:false, error}>}
 */
async function uploadToPlatform({ platform, accountId, accessToken, file, now }) {
  const canonical = canonicalPlatform(platform);
  const spec = PLATFORMS[canonical];
  if (!spec) return { ok: false, error: `no upload endpoint for platform ${platform}` };
  if (!accessToken) return { ok: false, error: `no access token for account ${accountId}` };

  const form = new FormData();
  spec.form(form, file);

  const url = `${fb.url}${spec.path(accountId)}?access_token=${encodeURIComponent(accessToken)}`;

  let body;
  try {
    // node-fetch rather than r2: r2's makeBody() mangles FormData streams, it
    // only supports Buffer/string bodies. Inherited from media.facebook.js.
    const res = await fetch(url, { method: 'POST', body: form, headers: form.getHeaders() });
    body = await res.json();
  } catch (err) {
    return { ok: false, error: sanitize(err.message) };
  }

  if (!body || body.error) {
    const message = (body && body.error && (body.error.message || JSON.stringify(body.error))) || 'empty response';
    return { ok: false, error: sanitize(message) };
  }

  const platformMediaId = body[spec.idField];
  if (!platformMediaId) {
    return { ok: false, error: `no ${spec.idField} in response from ${canonical}` };
  }

  const uploadedAt = now instanceof Date ? now : new Date();
  const ttl = DEFAULT_RECONCILE_POLICY.ttlMs[canonical];
  if (!ttl) {
    // Unreachable while PLATFORMS and ttlMs agree, and deliberately loud if
    // they ever stop agreeing: a handle written with no expiry is a handle the
    // reconciler will never refresh.
    return { ok: false, error: `no handle TTL recorded for platform ${canonical}` };
  }

  return {
    ok: true,
    platform: canonical,
    platformMediaId: String(platformMediaId),
    uploadedAt,
    expiresAt: new Date(uploadedAt.getTime() + ttl),
  };
}

module.exports = { uploadToPlatform, PLATFORMS };
