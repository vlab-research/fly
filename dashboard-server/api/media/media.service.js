'use strict';

/*
 * Media upload and list, req-free (planning/media-abstraction.md §2, §3),
 * shared by the REST handlers (media.controller.js) and the MCP tools.
 *
 * THE IMPERATIVE SHELL. Every decision comes from media.core.js — what is
 * eligible, what the bytes hash to, what the key and the URL are. This file
 * only sequences IO.
 *
 * The pipeline:
 *
 *   validate -> hash -> dedupe -> put -> insert asset -> (respond) -> fan out
 *
 * TWO THINGS ABOUT THAT ORDER ARE DELIBERATE.
 *
 * 1. `put` before `insert`. The asset id is generated here rather than
 *    defaulted by the database, because the object key derives from it. The
 *    resulting failure mode is the better one: a stored object with no row is
 *    garbage nobody can reach, while a row with no object is a broken image in
 *    a respondent's chat.
 *
 * 2. Fan-out runs AFTER the caller has its answer, and its failures are
 *    swallowed. A handle is always an optimisation, never a requirement (§2),
 *    so upload must succeed with zero connected accounts, with a dead page
 *    token, or with Meta down. `uploadAsset` therefore returns the asset AND a
 *    `fanOut` thunk; the HTTP shell responds and then runs it, the MCP tool
 *    runs it without waiting. The reconciler backfills everything fan-out
 *    misses, which is what lets fan-out be fire-and-forget rather than
 *    reliable.
 *
 * Asset creation is PLATFORM-INDEPENDENT. There is no page selector and no
 * connected-page requirement.
 */

const dns = require('dns').promises;
const uuidv4 = require('uuid/v4');
const fetch = require('node-fetch');

const {
  validateUpload,
  hashContent,
  buildAssetRecord,
  canonicalPlatform,
  checkSourceUrl,
  isPublicAddress,
  MAX_UPLOAD_BYTES,
} = require('./media.core');

class MediaFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaFailure';
    this.expected = true;
  }
}

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

const NO_FAN_OUT = { attempted: 0, succeeded: 0, failed: 0 };

/**
 * @param {Object} deps
 * @param {Object} deps.credentialQuery - { getMessagingAccounts }
 * @param {Object} deps.mediaQuery      - { create, findByHash, list, remove, upsertHandle }
 * @param {Object} deps.storage         - { put, delete, publicUrl } from ./storage
 * @param {Function} deps.platformUpload - uploadToPlatform from ./media.platform-upload
 * @param {Function} [deps.newId]       - injectable for deterministic tests
 */
function makeService({ credentialQuery, mediaQuery, storage, platformUpload, newId }) {
  const nextId = newId || uuidv4;
  const format = row => formatAsset(row, storage);

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
      return NO_FAN_OUT;
    }

    if (!accounts || !accounts.length) return NO_FAN_OUT;

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

  /*
   * -> { ok: false, error }                                     refused (400)
   * -> { ok: true, deduplicated, asset, fanOut: () => Promise }  stored
   *
   * `file` is `{ buffer, originalname, mimetype }` — multer's shape, which is
   * also what the MCP tool builds from a URL or base64 body. Every client-
   * asserted fact is recomputed by validateUpload (§4.6).
   */
  async function uploadAsset({ email, file }) {
    const validation = validateUpload(file);
    if (!validation.ok) return { ok: false, error: validation.error };
    const { filename, mimeType, mediaType, byteSize } = validation;

    // Dedupe DETECTION only, never identity.
    const contentHash = hashContent(file.buffer);

    // Dedupe, per researcher. UNIQUE (userid, content_hash): the same user
    // re-uploading the same bytes gets the existing asset back, with no
    // second row and no second object. The reconciler owns existing assets,
    // so a dedupe hit does not fan out.
    const existing = await mediaQuery.findByHash({ email, contentHash });
    if (existing) {
      return { ok: true, deduplicated: true, asset: format(existing), fanOut: async () => NO_FAN_OUT };
    }

    const assetId = nextId();

    // Store the bytes, with the Content-Type and Content-Disposition the
    // proxy will serve back off the object (§4.4).
    await storage.put({ assetId, buffer: file.buffer, contentType: mimeType, filename });

    // Insert the write-once row.
    const record = buildAssetRecord(email, contentHash, { filename, mimeType, mediaType, byteSize });
    const asset = await mediaQuery.create({ id: assetId, ...record });

    const fanOut = () =>
      fanOutHandles({
        email,
        assetId: asset.id,
        file: { buffer: file.buffer, filename, contentType: mimeType, mediaType },
      }).catch(e => {
        console.error(`[media] fan-out crashed for asset ${asset.id}: ${e.message}`);
        return NO_FAN_OUT;
      });

    return { ok: true, deduplicated: false, asset: format(asset), fanOut };
  }

  async function listAssets({ email }) {
    const rows = await mediaQuery.list({ email });
    return rows.map(format);
  }

  return { uploadAsset, listAssets, fanOutHandles, formatAsset: format };
}

// ---------------------------------------------------------------------------
// Fetching bytes from a URL, for callers that cannot send multipart (MCP).
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30 * 1000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/*
 * This server runs inside the cluster, so a URL it fetches on a caller's
 * behalf can reach things the caller cannot: AlertManager, the Kubernetes API,
 * CockroachDB's admin port. The pure checkSourceUrl refuses non-http schemes,
 * cluster-internal names and private IP literals; this resolves the hostname
 * and refuses a private address too. Redirects are followed by hand so every
 * hop gets the same check. A DNS answer that changes between this lookup and
 * the connection (rebinding) is not defended against.
 */
async function assertPublicSource(url) {
  const check = checkSourceUrl(url);
  if (!check.ok) throw new MediaFailure(check.error);

  const { hostname } = new URL(url);
  let resolved;
  try {
    resolved = await dns.lookup(hostname);
  } catch (e) {
    throw new MediaFailure(`source_url host "${hostname}" does not resolve: ${e.message}`);
  }
  if (!isPublicAddress(resolved.address)) {
    throw new MediaFailure(
      `source_url host "${hostname}" resolves to a private address and was not fetched.`,
    );
  }
}

/*
 * -> { buffer, contentType, url }  the final URL after redirects.
 *
 * Bounded by `maxBytes` — the largest per-type limit, so every per-type
 * refusal still comes from validateUpload with the actual number in it.
 */
async function fetchSource(url, { maxBytes = MAX_UPLOAD_BYTES } = {}) {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicSource(current);

    let res;
    try {
      res = await fetch(current, { redirect: 'manual', timeout: FETCH_TIMEOUT_MS, size: maxBytes });
    } catch (e) {
      throw new MediaFailure(`Could not fetch source_url: ${e.message}`);
    }

    if (REDIRECT_STATUSES.includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new MediaFailure(`source_url redirected (HTTP ${res.status}) without a Location.`);
      current = new URL(location, current).toString();
      continue;
    }

    if (!res.ok) {
      throw new MediaFailure(`source_url answered HTTP ${res.status}; nothing was uploaded.`);
    }

    let buffer;
    try {
      buffer = await res.buffer();
    } catch (e) {
      if (e && e.type === 'max-size') {
        const maxMB = (maxBytes / (1024 * 1024)).toFixed(0);
        throw new MediaFailure(`source_url is larger than ${maxMB} MB, which is beyond every media limit.`);
      }
      throw new MediaFailure(`Could not read source_url: ${e.message}`);
    }

    return { buffer, contentType: res.headers.get('content-type'), url: current };
  }

  throw new MediaFailure(`source_url redirected more than ${MAX_REDIRECTS} times; pass the final URL.`);
}

module.exports = { makeService, formatAsset, fetchSource, MediaFailure, FETCH_TIMEOUT_MS, MAX_REDIRECTS };
