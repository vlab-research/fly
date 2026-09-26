'use strict';

/*
 * Which export links a caller may be shown. Pure.
 *
 * The exporter writes every artifact under exports/<ownerPrefix(email)>/
 * (exporter/exporter/keys.py). A link whose object key is not under the
 * caller's own prefix cannot be shown to belong to them: it is either an
 * object written before keys were owner-scoped, when researchers who shared a
 * survey_name overwrote each other's exports, or it was never a real object
 * link. Such links are replaced by the placeholder, never served.
 */

const crypto = require('crypto');

const EXPORT_LINK_PLACEHOLDER = 'Not Found';
const OWNER_PREFIX_LENGTH = 16;

// Must equal keys.owner_prefix in the exporter; both test suites pin the
// same values.
const ownerPrefix = email => crypto
  .createHash('sha256')
  .update(email, 'utf8')
  .digest('hex')
  .slice(0, OWNER_PREFIX_LENGTH);

// The key is the path, optionally after one bucket segment: MinIO presigns
// path-style (/<bucket>/exports/...), virtual-hosted S3 omits the bucket.
function isOwnedExportLink(email, link) {
  if (!email || typeof link !== 'string') return false;
  let pathname;
  try {
    ({ pathname } = new URL(link));
  } catch (e) {
    return false;
  }
  const owned = new RegExp(`^/(?:[^/]+/)?exports/${ownerPrefix(email)}/`);
  return owned.test(pathname);
}

const withOwnedLink = email => row => (
  !row.export_link
  || row.export_link === EXPORT_LINK_PLACEHOLDER
  || isOwnedExportLink(email, row.export_link)
    ? row
    : { ...row, export_link: EXPORT_LINK_PLACEHOLDER }
);

module.exports = {
  EXPORT_LINK_PLACEHOLDER,
  ownerPrefix,
  isOwnedExportLink,
  withOwnedLink,
};
