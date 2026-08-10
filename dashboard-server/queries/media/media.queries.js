'use strict';

/*
 * media_asset / media_handle (devops/migrations/24-media-assets.sql).
 *
 * Two tables, two very different jobs:
 *
 *   media_asset  -- immutable, write-once. Losing it loses the researcher's
 *                   library, so nothing here ever UPDATEs it.
 *   media_handle -- volatile cache, one row per (asset, account). You can
 *                   DELETE every row at any moment and nothing breaks.
 *
 * THE HANDLE KEY IS (asset_id, account_id). account_id is credentials.key --
 * the page id or phone number id -- and NOT the entity, NOT details->>'page_id',
 * and never a (platform, account_id) pair. The platform has two spellings in
 * this codebase and the writer (fan-out, iterating credentials) holds a
 * different one from the reader (message-worker, holding a send command), so a
 * two-part key lets them disagree while every message still delivers by URL: an
 * invisible failure. See the migration's comment.
 */

// The asset columns every read returns. `userid` is deliberately absent — the
// controller shapes the response and never leaks it.
const ASSET_COLUMNS = `
  m.id, m.content_hash, m.media_type, m.mime_type,
  m.byte_size, m.filename, m.created
`;

/**
 * Inserts a media_asset row.
 *
 * The id is supplied by the caller rather than defaulted, because the object
 * key derives from it and the bytes are written to storage BEFORE this row
 * exists. That ordering is chosen deliberately: a stored object with no row is
 * garbage the reconciler can sweep, while a row with no object is a broken
 * image in a respondent's chat.
 */
async function create({ id, email, contentHash, mediaType, mimeType, byteSize, filename }) {
  const q = `
    INSERT INTO media_asset (id, userid, content_hash, media_type, mime_type, byte_size, filename)
    VALUES (
      $1,
      (SELECT id FROM users WHERE email = $2),
      $3, $4, $5, $6, $7
    )
    RETURNING id, content_hash, media_type, mime_type, byte_size, filename, created
  `;
  const values = [id, email, contentHash, mediaType, mimeType, byteSize, filename];
  const { rows } = await this.query(q, values);
  return rows[0];
}

/**
 * The existing asset for these exact bytes and this exact user, if any.
 *
 * PER-RESEARCHER, not global (UNIQUE (userid, content_hash)). A different user
 * uploading identical bytes gets their own row: global dedupe would mean the
 * second researcher's media tab -- which filters by userid -- would not show
 * their own file.
 */
async function findByHash({ email, contentHash }) {
  const q = `
    SELECT ${ASSET_COLUMNS}
    FROM media_asset m
    JOIN users u ON m.userid = u.id
    WHERE u.email = $1 AND m.content_hash = $2
    LIMIT 1
  `;
  const { rows } = await this.query(q, [email, contentHash]);
  return rows[0];
}

async function get({ email, id }) {
  const q = `
    SELECT ${ASSET_COLUMNS}
    FROM media_asset m
    JOIN users u ON m.userid = u.id
    WHERE u.email = $1 AND m.id = $2
    LIMIT 1
  `;
  const { rows } = await this.query(q, [email, id]);
  return rows[0];
}

async function list({ email }) {
  const q = `
    SELECT ${ASSET_COLUMNS}
    FROM media_asset m
    JOIN users u ON m.userid = u.id
    WHERE u.email = $1
    ORDER BY m.created DESC
  `;
  const { rows } = await this.query(q, [email]);
  return rows;
}

/**
 * Deletes an asset owned by this user. Handles cascade (FK ON DELETE CASCADE),
 * which is why deletion is safe under UUID identity: the URL identifies exactly
 * one row, so there is no refcount to get wrong.
 *
 * Returns the deleted row, or undefined when it was not theirs / not there —
 * the email predicate is the authorisation check, so a miss must be a 404.
 */
async function remove({ email, id }) {
  const q = `
    DELETE FROM media_asset
    WHERE id = $1
      AND userid = (SELECT id FROM users WHERE email = $2)
    RETURNING id, content_hash, media_type, mime_type, byte_size, filename, created
  `;
  const { rows } = await this.query(q, [id, email]);
  return rows[0];
}

/**
 * Writes one handle. INSERT ... ON CONFLICT (asset_id, account_id) DO UPDATE.
 *
 * The primary key enforces "exactly one handle per (asset, account)" in the
 * database rather than by query discipline, which is what makes both fan-out
 * and reconciliation idempotent by construction: run either twice and the
 * second run overwrites rather than accumulating.
 *
 * `platform` is written for debugging and reconciler reporting only. It is
 * never part of the key and must never become a lookup predicate.
 */
async function upsertHandle({ assetId, accountId, platform, platformMediaId, uploadedAt, expiresAt }) {
  const q = `
    INSERT INTO media_handle (asset_id, account_id, platform, platform_media_id, uploaded_at, expires_at)
    VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_TIMESTAMP), $6)
    ON CONFLICT (asset_id, account_id) DO UPDATE
    SET platform = EXCLUDED.platform,
        platform_media_id = EXCLUDED.platform_media_id,
        uploaded_at = EXCLUDED.uploaded_at,
        expires_at = EXCLUDED.expires_at
    RETURNING asset_id, account_id, platform, platform_media_id, uploaded_at, expires_at
  `;
  const values = [
    assetId,
    accountId,
    platform,
    platformMediaId || null,
    uploadedAt || null,
    expiresAt || null,
  ];
  const { rows } = await this.query(q, values);
  return rows[0];
}

/** Every handle for one asset. Used by the reconciler and by tests. */
async function listHandles({ assetId }) {
  const q = `
    SELECT asset_id, account_id, platform, platform_media_id, uploaded_at, expires_at
    FROM media_handle
    WHERE asset_id = $1
    ORDER BY account_id ASC
  `;
  const { rows } = await this.query(q, [assetId]);
  return rows;
}

module.exports = {
  name: 'Media',
  queries: pool => ({
    create: create.bind(pool),
    findByHash: findByHash.bind(pool),
    get: get.bind(pool),
    list: list.bind(pool),
    remove: remove.bind(pool),
    upsertHandle: upsertHandle.bind(pool),
    listHandles: listHandles.bind(pool),
  }),
};
