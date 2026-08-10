'use strict';

/*
 * Media upload, list and delete (planning/media-abstraction.md §2, §3).
 *
 * THE IMPERATIVE SHELL. Every decision comes from media.core.js — what is
 * eligible, what the bytes hash to, what the key and the URL are. This file
 * only sequences IO and maps outcomes onto HTTP.
 *
 * The pipeline:
 *
 *   validate -> hash -> dedupe -> put -> insert asset -> respond -> fan out
 *
 * TWO THINGS ABOUT THAT ORDER ARE DELIBERATE.
 *
 * 1. `put` before `insert`. The asset id is generated here rather than
 *    defaulted by the database, because the object key derives from it. The
 *    resulting failure mode is the better one: a stored object with no row is
 *    garbage nobody can reach, while a row with no object is a broken image in
 *    a respondent's chat.
 *
 * 2. Fan-out runs AFTER the response is sent, and its failures are swallowed.
 *    A handle is always an optimisation, never a requirement (§2), so upload
 *    must succeed with zero connected accounts, with a dead page token, or with
 *    Meta down. The reconciler backfills everything fan-out misses, which is
 *    what lets fan-out be fire-and-forget rather than reliable.
 *
 * Asset creation is PLATFORM-INDEPENDENT. There is no page selector and no
 * connected-page requirement — that was the prod/staging environment question
 * (§1) moved one screen earlier, and it fails silently.
 */

const uuidv4 = require('uuid/v4');

const {
  validateUpload,
  hashContent,
  buildAssetRecord,
  canonicalPlatform,
} = require('./media.core');

/**
 * The researcher-facing shape of an asset. The URL is derived, never stored
 * (§5), so moving MEDIA_PUBLIC_BASE is a helm edit rather than a data
 * migration.
 *
 * Handle state is deliberately absent: it is our problem, not the author's.
 */
function formatAsset(row, storage) {
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.media_type,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    created: row.created,
    url: storage.publicUrl(row.id, row.filename),
  };
}

/**
 * @param {Object} deps
 * @param {Object} deps.credentialQuery - { getMessagingAccounts }
 * @param {Object} deps.mediaQuery      - { create, findByHash, list, remove, upsertHandle }
 * @param {Object} deps.storage         - { put, delete, publicUrl } from ./storage
 * @param {Function} deps.platformUpload - uploadToPlatform from ./media.platform-upload
 * @param {Function} [deps.newId]       - injectable for deterministic tests
 */
function makeHandlers({ credentialQuery, mediaQuery, storage, platformUpload, newId }) {
  const nextId = newId || uuidv4;

  /**
   * Pushes one asset to every messaging account its owner has.
   *
   * BEST-EFFORT BY CONSTRUCTION. `allSettled` means one dead token cannot take
   * the others down, and the returned summary is for logs and tests only — no
   * caller branches on it. Zero accounts is a normal, successful outcome.
   *
   * account_id is `credentials.key`. That is the seam that matters: the worker
   * looks handles up by (asset_id, account_id) alone, so writing the entity or
   * a details field here would produce a handle nothing ever reads, and the
   * miss would be invisible because a miss is the designed URL fallback.
   */
  async function fanOutHandles({ email, assetId, file }) {
    let accounts;
    try {
      accounts = await credentialQuery.getMessagingAccounts({ email });
    } catch (e) {
      console.error(`[media] fan-out: could not list accounts for ${email}: ${e.message}`);
      return { attempted: 0, succeeded: 0, failed: 0 };
    }

    if (!accounts || !accounts.length) return { attempted: 0, succeeded: 0, failed: 0 };

    const results = await Promise.allSettled(
      accounts.map(async account => {
        const platform = canonicalPlatform(account.entity);
        const details = account.details || {};
        const uploaded = await platformUpload({
          platform,
          accountId: account.key,
          accessToken: details.access_token,
          file,
        });
        if (!uploaded.ok) throw new Error(uploaded.error);

        await mediaQuery.upsertHandle({
          assetId,
          // credentials.key. NOT account.entity, NOT details.page_id.
          accountId: account.key,
          platform: uploaded.platform,
          platformMediaId: uploaded.platformMediaId,
          uploadedAt: uploaded.uploadedAt,
          expiresAt: uploaded.expiresAt,
        });
      }),
    );

    const failed = results.filter(r => r.status === 'rejected');
    // Logged, never thrown. The reconciler fixes these on the next tick.
    failed.forEach(r => {
      console.warn(`[media] fan-out failed for asset ${assetId}: ${r.reason && r.reason.message}`);
    });

    return {
      attempted: accounts.length,
      succeeded: accounts.length - failed.length,
      failed: failed.length,
    };
  }

  async function uploadMedia(req, res) {
    const { email } = req.user;

    // 1. Validate (pure). Every client-asserted fact is recomputed — the
    //    mimeType this returns is what gets written as object metadata and
    //    served back from our own domain, so trusting the client would be an
    //    XSS vector (§4.6). The error names the problem and the fix.
    const validation = validateUpload(req.file);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const { filename, mimeType, mediaType, byteSize } = validation;

    let asset;
    try {
      // 2. Hash (pure) — dedupe DETECTION only, never identity.
      const contentHash = hashContent(req.file.buffer);

      // 3. Dedupe, per researcher. UNIQUE (userid, content_hash): the same user
      //    re-uploading the same bytes gets the existing asset back, with no
      //    second row and no second object. A DIFFERENT user uploading
      //    identical bytes gets their own row — global dedupe would hide the
      //    second researcher's file from their own media tab, which filters by
      //    userid.
      const existing = await mediaQuery.findByHash({ email, contentHash });
      if (existing) {
        return res.status(200).json(formatAsset(existing, storage));
      }

      const assetId = nextId();

      // 4. Store the bytes, with the Content-Type and Content-Disposition the
      //    proxy will serve back off the object (§4.4).
      await storage.put({ assetId, buffer: req.file.buffer, contentType: mimeType, filename });

      // 5. Insert the write-once row.
      const record = buildAssetRecord(email, contentHash, { filename, mimeType, mediaType, byteSize });
      asset = await mediaQuery.create({ id: assetId, ...record });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }

    // 6. Respond. The asset exists and has a URL; nothing below can change that.
    res.status(201).json(formatAsset(asset, storage));

    // 7. Fan out, after the response, best-effort. Awaited only so callers that
    //    want to observe it (tests, and any future synchronous caller) can —
    //    the researcher is not waiting on it, and it can never fail the upload.
    try {
      await fanOutHandles({
        email,
        assetId: asset.id,
        file: { buffer: req.file.buffer, filename, contentType: mimeType, mediaType },
      });
    } catch (e) {
      console.error(`[media] fan-out crashed for asset ${asset.id}: ${e.message}`);
    }
  }

  async function listMedia(req, res) {
    const { email } = req.user;
    try {
      const rows = await mediaQuery.list({ email });
      return res.status(200).json(rows.map(r => formatAsset(r, storage)));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  /**
   * Deletes an asset: the row, then the object. Handles cascade (§11.6).
   *
   * The row goes first because it is the authorisation boundary and the thing
   * the list view reads. A failed object delete after a successful row delete
   * leaves an unreachable orphan — logged, and cheap — whereas the reverse
   * would leave a listed asset whose URL 404s.
   */
  async function deleteMedia(req, res) {
    const { email } = req.user;
    const { id } = req.params;
    try {
      const deleted = await mediaQuery.remove({ email, id });
      if (!deleted) return res.status(404).json({ error: 'Media not found' });

      try {
        await storage.delete({ assetId: deleted.id });
      } catch (e) {
        console.error(`[media] deleted row ${deleted.id} but object remains: ${e.message}`);
      }

      return res.status(204).send();
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  return { uploadMedia, listMedia, deleteMedia, fanOutHandles, formatAsset };
}

module.exports = { makeHandlers, formatAsset };
