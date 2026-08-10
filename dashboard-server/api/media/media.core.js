'use strict';

/*
 * Functional core of the media asset/handle model (planning/media-abstraction.md §6).
 *
 * PURE ONLY. No fs, no network, no database, no `Date.now()`. Every function
 * that needs the time takes `now` as a parameter, so expiry behaviour is
 * asserted by passing a clock rather than by waiting 30 days.
 *
 * The invariant everything here preserves: a handle is always an optimisation,
 * never a requirement. Every asset has a public URL we control, so any failure
 * of the handle layer degrades to a URL send rather than a failed message.
 */

const crypto = require('crypto');
// Only used to inflate a ZIP's first entry during content sniffing. Pure: it is
// a deterministic byte->byte transform with no IO, so the core stays testable
// without fixtures on disk.
const zlib = require('zlib');

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const OCTET_STREAM = 'application/octet-stream';

// Containers the sniffer can positively name but that are NOT sendable. Naming
// them is what turns "unrecognised format" into an actionable error — a ZIP or a
// legacy .doc gets told what it is and what to convert to. They are deliberately
// absent from MEDIA_TYPE_LIMITS, so they are rejected exactly like GIF is.
const ZIP_CONTAINER = 'application/zip';
const OLE2_CONTAINER = 'application/x-ole-storage';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Limits per media type, enforced at the strictest supported platform's limits.
// All eligible uploads are guaranteed sendable on every supported platform
// (§11.5). This removes the need for later per-platform eligibility checks.
const MEDIA_TYPE_LIMITS = {
  image: {
    mimeTypes: ['image/jpeg', 'image/png'],
    maxBytes: 5 * 1024 * 1024, // 5 MB
    humanName: 'image',
    acceptedFormats: ['JPEG', 'PNG'],
  },
  video: {
    mimeTypes: ['video/mp4', 'video/3gpp'],
    maxBytes: 16 * 1024 * 1024, // 16 MB
    humanName: 'video',
    acceptedFormats: ['MP4', '3GPP'],
  },
  audio: {
    mimeTypes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
    maxBytes: 16 * 1024 * 1024, // 16 MB
    humanName: 'audio',
    acceptedFormats: ['AAC', 'MP4', 'MPEG', 'AMR', 'OGG'],
  },
  file: {
    // Meta documents eight document MIME types at 100 MB (§11.5). We accept the
    // subset the sniffer can POSITIVELY IDENTIFY from magic bytes, because
    // acceptance is bounded by identification, never by the client's claim or
    // the file extension: sniffContentType returns application/octet-stream both
    // for legitimate-but-unrecognised containers AND for an HTML/SVG payload
    // relabelled as an image (§4.6), and trusting that as "a document" would
    // store and serve executable content back from our own domain.
    //
    // Of Meta's eight:
    //   - application/pdf — %PDF- magic. Supported.
    //   - the three OOXML types — ZIP containers; the subtype is read out of the
    //     package's own [Content_Types].xml, not guessed. Supported.
    //   - the three legacy Office types (doc/xls/ppt) — OLE2 compound files. The
    //     magic bytes identify the CONTAINER but not which of the three it is;
    //     that needs a CFB directory walk, which is not cheap or reliable enough
    //     to be worth it here. Rejected, with an error naming the format.
    //   - text/plain — has NO magic bytes at all. It is indistinguishable from
    //     arbitrary unidentifiable input, which is precisely what the
    //     octet-stream rejection exists to catch. DELIBERATELY NOT SUPPORTED:
    //     accepting it would mean accepting anything, including HTML.
    mimeTypes: ['application/pdf', DOCX, XLSX, PPTX],
    maxBytes: 100 * 1024 * 1024, // 100 MB
    humanName: 'document',
    acceptedFormats: ['PDF', 'DOCX', 'XLSX', 'PPTX'],
  },
};

// The mimetypes validateUpload accepts, keyed by nothing but useful as a flat
// list for the controller and for negative assertions in tests ("gif is not in
// here"). This IS an exhaustive allowlist — see getLimitForMimeType.
const ALLOWED_MIME_TYPES = Object.values(MEDIA_TYPE_LIMITS)
  .flatMap(limit => limit.mimeTypes);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// Known handle lifetime measured from uploaded_at, NOT from last use.
// Meta's reference says 30 days from upload; third-party docs claim 30 days
// from last use. From-upload is the stricter of the two, so a reconciler built
// on it is correct under both (§2).
//
// EVERY PLATFORM WE FAN OUT TO MUST HAVE A FINITE TTL HERE. A null (or missing)
// entry means endOfLife can never place the handle's death, so planReconcile
// never refreshes it by age — and because a handle is only ever an optimisation,
// nothing errors when it dies: every send silently falls back to URL, forever.
// That is exactly the bug this table had until 2026-08-10, when Messenger was
// recorded as never expiring. Meta documents "Attachment IDs expire after 90
// days" (§11.2), and Messenger carries ~100% of live media traffic (§11.1).
const DEFAULT_RECONCILE_POLICY = {
  ttlMs: {
    messenger: 90 * DAY, // Meta: "Attachment IDs expire after 90 days."
    whatsapp: 30 * DAY,
  },
  // Refresh this far ahead of end-of-life. Must comfortably exceed one
  // reconciler tick, so a handle is replaced before anything tries to use it.
  refreshMarginMs: 3 * DAY,
  // Drop handle rows for accounts the owner no longer has.
  prune: true,
};

// credentials.entity spells the platform one way, SendMessageCommand another
// (§5). Handles are never keyed on platform, but the descriptive column and the
// TTL lookup both need one spelling, so normalise to the command's.
const CANONICAL_PLATFORM = {
  facebook_page: 'messenger',
  messenger: 'messenger',
  whatsapp_business: 'whatsapp',
  whatsapp: 'whatsapp',
  instagram: 'instagram',
};

function canonicalPlatform(platform) {
  if (!platform) return null;
  const key = String(platform).toLowerCase();
  return CANONICAL_PLATFORM[key] || key;
}

// --------------------------------------------------------------------------
// Identity, keys and URLs
// --------------------------------------------------------------------------

/**
 * sha256 of the uploaded bytes, hex.
 *
 * This is dedupe DETECTION only, NEVER identity. Identity is the asset's UUID
 * (§5): a content-addressed key would make deletion a refcounting problem and
 * would give anyone holding a file a confirmation oracle for whether it is in
 * the library. The hash exists solely to power UNIQUE (userid, content_hash).
 */
function hashContent(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('hashContent requires a Buffer');
  }
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertAssetId(assetId) {
  if (typeof assetId !== 'string' || !UUID_PATTERN.test(assetId)) {
    throw new TypeError(`invalid asset id: ${JSON.stringify(assetId)}`);
  }
  return assetId.toLowerCase();
}

/**
 * The S3 object key for an asset: `a/<uuid>`.
 *
 * The filename is deliberately NOT in the key (§5) — it is cosmetic, can change
 * without touching storage, and cannot collide. Validating the uuid here is what
 * keeps a caller from ever constructing a key that escapes the prefix.
 */
function storageKeyFor(assetId) {
  return `a/${assertAssetId(assetId)}`;
}

/**
 * The public URL: `<base>/a/<uuid>/<filename>`.
 *
 * Never stored — it derives from the id and MEDIA_PUBLIC_BASE, so moving the
 * domain is a helm edit rather than a data migration. The filename segment is
 * for humans and for WhatsApp document sends; the proxy ignores it.
 */
function publicUrlFor(base, assetId, filename) {
  if (typeof base !== 'string' || !base.trim()) {
    throw new TypeError('publicUrlFor requires a non-empty base URL');
  }
  const id = assertAssetId(assetId);
  const root = `${base.trim().replace(/\/+$/, '')}/a/${id}`;
  const name = sanitizeFilename(filename);
  return name ? `${root}/${encodeURIComponent(name)}` : root;
}

/**
 * Strips any path context from a client-supplied filename and rejects names
 * that carry no usable characters. Returns null when nothing survives.
 */
function sanitizeFilename(filename) {
  if (typeof filename !== 'string') return null;
  const base = filename.split(/[/\\]/).pop() || '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 255);
  return cleaned || null;
}

/**
 * Extracts an asset UUID from a media URL, or null if the URL is not one of ours.
 *
 * HOST-INDEPENDENT by design, and behaviourally identical to
 * message-worker/mediaresolve.ParseAssetID — the two sides must not drift. Only
 * the path shape is inspected, so a production media URL pasted into a survey
 * that then runs on staging parses fine, misses the local lookup, and sends the
 * production URL, which the production proxy serves. Pinning the host would turn
 * that into a broken image.
 *
 * A third-party URL simply fails to match and is used as-is, with no lookup.
 */
const ASSET_PATH = new RegExp(
  '^/a/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:/[^/]*)?/?$',
);

function parseAssetId(url) {
  if (typeof url !== 'string') return null;
  // Cheap reject before any work: every asset URL contains this.
  if (url.indexOf('/a/') < 0) return null;

  let path = url;
  // Strip scheme://host without a full URL parse — only the path participates,
  // and a permissive URL parser would accept shapes this regex rejects.
  const scheme = path.indexOf('://');
  if (scheme >= 0) {
    const rest = path.slice(scheme + 3);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    path = rest.slice(slash);
  }
  // Query and fragment do not participate in identity.
  const mark = path.search(/[?#]/);
  if (mark >= 0) path = path.slice(0, mark);

  const m = ASSET_PATH.exec(path);
  if (!m) return null;
  // gen_random_uuid() emits lowercase, so the column is lowercase.
  return m[1].toLowerCase();
}

// --------------------------------------------------------------------------
// Upload validation
// --------------------------------------------------------------------------

/**
 * Determines the content type from the bytes themselves.
 *
 * The client's `claimed` type is NEVER trusted to widen what we accept — it can
 * only narrow a result within the same container. An mp4 container holds both
 * audio and video tracks and an `ftyp` box cannot tell them apart, so a claim of
 * audio/* refines video/mp4 to audio/mp4. Anything we cannot positively
 * identify is application/octet-stream regardless of what was claimed, which is
 * what stops an HTML or SVG payload renamed .png from being served back under
 * our own domain (§4.6).
 */
function sniffContentType(buffer, claimed) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return OCTET_STREAM;

  const ascii = (offset, length) => buffer.slice(offset, offset + length).toString('latin1');
  const magic = (...bytes) => bytes.every((b, i) => buffer[i] === b);
  const claimsAudio = typeof claimed === 'string' && claimed.toLowerCase().startsWith('audio/');

  if (magic(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (magic(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';

  const head6 = ascii(0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (head6.startsWith('%PDF-')) return 'application/pdf';
  if (head6.startsWith('#!AMR')) return 'audio/amr';

  if (ascii(0, 4) === 'RIFF') {
    const form = ascii(8, 4);
    if (form === 'WEBP') return 'image/webp';
    if (form === 'WAVE') return 'audio/wav';
    return OCTET_STREAM;
  }

  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand.startsWith('3g')) return 'video/3gpp';
    if (brand.startsWith('M4A')) return 'audio/mp4';
    return claimsAudio ? 'audio/mp4' : 'video/mp4';
  }

  if (magic(0x1a, 0x45, 0xdf, 0xa3)) return claimsAudio ? 'audio/webm' : 'video/webm';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  // MPEG audio frame sync: 11 set bits, then a non-reserved layer.
  if (buffer[0] === 0xff && (buffer[1] & 0xe6) === 0xe2) return 'audio/mpeg';

  // ZIP local file header. docx/xlsx/pptx are ZIPs, so this is where the three
  // OOXML document types are resolved — from the package's own manifest, never
  // from the extension. Anything else zip-shaped stays a plain ZIP: named, so
  // the error can say so, but not accepted.
  if (magic(0x50, 0x4b, 0x03, 0x04)) return sniffZipContainer(buffer);

  // OLE2 / CFB compound file: .doc, .xls, .ppt — and also .msi, .msg and a dozen
  // other unrelated formats. The magic names the container only; which of the
  // three Office types it holds lives in the CFB directory, reachable only by
  // walking the FAT sector chain. Not worth that here, so this is named and
  // refused rather than guessed at from the extension.
  if (magic(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return OLE2_CONTAINER;

  // NOTE: text/plain is absent on purpose and must stay absent. It has no magic
  // bytes, so "is this text?" is unanswerable — every HTML and SVG payload the
  // octet-stream rejection exists to catch is also plain text (§4.6, §11.5).

  return OCTET_STREAM;
}

// The main-part content type an OOXML package declares for itself, mapped to the
// package MIME type Meta accepts. Matching the ".main+xml" part type — rather
// than sniffing filenames like "word/" — is what makes this identification and
// not a guess, and it is why macro-enabled packages (docm/xlsm/pptm, whose main
// parts are `application/vnd.ms-word.document.macroEnabled.main+xml` and
// friends) fall through to a plain ZIP and are refused. That is a welcome
// side-effect: they carry executable content.
const OOXML_MAIN_PARTS = [
  ['wordprocessingml.document.main+xml', DOCX],
  ['spreadsheetml.sheet.main+xml', XLSX],
  ['presentationml.presentation.main+xml', PPTX],
];

const CONTENT_TYPES_PART = '[Content_Types].xml';
// [Content_Types].xml is a few KB in any real package. The cap makes a zip bomb
// a rejection rather than a memory event.
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Names a ZIP container: one of the three OOXML document types, or a plain ZIP.
 *
 * Every OPC package (docx/xlsx/pptx) must contain [Content_Types].xml, and every
 * producer writes it as the first entry, so the first local file header is
 * enough. If it is not there, or unreadable, the answer is "a ZIP" — never a
 * guess from the filename or the claimed type.
 */
function sniffZipContainer(buffer) {
  const manifest = readFirstZipEntry(buffer, CONTENT_TYPES_PART);
  if (manifest === null) return ZIP_CONTAINER;
  for (const [marker, mime] of OOXML_MAIN_PARTS) {
    if (manifest.includes(marker)) return mime;
  }
  return ZIP_CONTAINER;
}

/**
 * The decompressed bytes of a ZIP's first entry, as latin1 text, when that entry
 * is named `wantName`. null for anything unreadable — wrong name, encrypted,
 * truncated, an unsupported compression method, or corrupt deflate data.
 */
function readFirstZipEntry(buffer, wantName) {
  const HEADER = 30;
  if (buffer.length < HEADER) return null;

  const flags = buffer.readUInt16LE(6);
  const method = buffer.readUInt16LE(8);
  const compressedSize = buffer.readUInt32LE(18);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);

  if (flags & 0x01) return null; // encrypted: the bytes cannot be identified
  if (buffer.length < HEADER + nameLength) return null;
  if (buffer.slice(HEADER, HEADER + nameLength).toString('latin1') !== wantName) return null;

  const start = HEADER + nameLength + extraLength;
  // A zero compressed size means the sizes went in a trailing data descriptor
  // (flag bit 3). Inflating to the end of the buffer still works; a corrupt read
  // just throws and becomes null.
  const end = compressedSize > 0 ? start + compressedSize : buffer.length;
  if (start >= buffer.length || end > buffer.length) return null;

  const data = buffer.slice(start, end);
  try {
    if (method === 0) return data.slice(0, MAX_MANIFEST_BYTES).toString('latin1');
    if (method === 8) {
      return zlib.inflateRawSync(data, { maxOutputLength: MAX_MANIFEST_BYTES }).toString('latin1');
    }
  } catch (err) {
    return null;
  }
  return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The bit depth declared in a PNG's IHDR chunk, or null when there is no
 * readable IHDR.
 *
 * Meta requires images to be "8-bit, RGB or RGBA". A 16-bit PNG passes every
 * size and MIME check and is then refused by WhatsApp at fan-out, leaving an
 * asset that gets no handle and sends by URL forever with nothing erroring —
 * the invisible-degradation class §11.5 exists to remove. The depth is one byte
 * at a fixed offset, so unlike codec validation (§11.5, deliberately not
 * attempted) this is cheap enough to be worth doing.
 *
 * IHDR is required to be the first chunk: signature (8) + length (4) + type (4)
 * + width (4) + height (4), so depth is byte 24 and colour type byte 25.
 */
function pngBitDepth(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 26) return null;
  if (!PNG_SIGNATURE.every((b, i) => buffer[i] === b)) return null;
  if (buffer.slice(12, 16).toString('latin1') !== 'IHDR') return null;
  return buffer[24];
}

/** image | video | audio | file — the media_type column (§5). */
function mediaTypeFor(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Looks up the size limit and friendly name for a sniffed MIME type.
 * Returns { maxBytes, humanName, acceptedFormats } or null if not allowed.
 *
 * Every category, including documents, is gated on the sniffer positively
 * naming the container (§4.6): application/octet-stream — the sniffer's result
 * for both "genuinely unrecognised" and "HTML/SVG relabelled as an image" — is
 * never treated as an accepted document. See the comment on MEDIA_TYPE_LIMITS.file.
 */
function getLimitForMimeType(mimeType) {
  for (const limit of Object.values(MEDIA_TYPE_LIMITS)) {
    if (limit.mimeTypes.includes(mimeType)) return limit;
  }
  return null;
}

/**
 * Validates an uploaded file and returns the server-determined facts about it.
 *
 * Everything the client asserted — mimetype, size — is recomputed rather than
 * believed. The returned mimeType is what gets written as S3 object metadata
 * and served back by the proxy, so trusting the client here would be an XSS
 * vector on our own domain.
 *
 * Size limits are enforced using the sniffed MIME type (never the client's
 * claimed type), so a file is judged by what it actually is, not what it claims.
 *
 * @returns {{ok:true, filename, mimeType, mediaType, byteSize}|{ok:false, error:string}}
 */
function validateUpload(file) {
  if (!file) {
    return { ok: false, error: 'file is required' };
  }
  if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    return { ok: false, error: 'file is empty' };
  }

  // Sniff the MIME type first, since size limits depend on it.
  const mimeType = sniffContentType(file.buffer, file.mimetype);

  // Check if this type is allowed. application/octet-stream lands here too —
  // it is the sniffer's result for both genuinely-unrecognised bytes and an
  // HTML/SVG payload relabelled as an image, and neither is an accepted
  // document (§4.6; see the comment on MEDIA_TYPE_LIMITS.file).
  const limit = getLimitForMimeType(mimeType);
  if (!limit) {
    // Determine a human-readable name for what was detected.
    const DETECTED_NAMES = {
      'image/gif': 'GIF',
      'image/webp': 'WebP',
      'video/webm': 'WebM',
      'video/quicktime': 'QuickTime',
      'audio/wav': 'WAV',
      'audio/webm': 'WebM audio',
      [ZIP_CONTAINER]: 'ZIP archive',
      [OLE2_CONTAINER]: 'legacy Office document (.doc/.xls/.ppt)',
      [OCTET_STREAM]: 'unrecognised format',
    };
    const detectedName = DETECTED_NAMES[mimeType] || mimeType;

    // Accepted alternatives are whatever this same general media type allows.
    // An unrecognised format (octet-stream) is the one case with nothing to
    // suggest: it could have been anything, so naming document formats would be
    // misleading. Everything else was positively identified and gets told what
    // to convert to — including a ZIP or a legacy .doc, which are documents we
    // simply cannot name precisely enough to accept.
    const generalType = mediaTypeFor(mimeType);
    const accepted = mimeType === OCTET_STREAM ? [] : MEDIA_TYPE_LIMITS[generalType].acceptedFormats;
    const suggestions = accepted.length ? `; use ${accepted.join(' or ')}` : '';

    return {
      ok: false,
      error: `${detectedName} is not supported${suggestions}`,
    };
  }

  // buffer.length, not file.size: the bytes are the only thing we can verify.
  const byteSize = file.buffer.length;
  if (byteSize > limit.maxBytes) {
    const maxMB = (limit.maxBytes / (1024 * 1024)).toFixed(1);
    const actualMB = (byteSize / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      error: `${limit.humanName} is ${actualMB} MB, maximum is ${maxMB} MB`,
    };
  }

  // Meta: "Images must be 8-bit, RGB or RGBA." Only the depth is checked, and
  // only for PNG — JPEG is 8-bit by construction in every baseline/progressive
  // profile a researcher can produce, and the colour-type rule is not enforced
  // because an 8-bit greyscale or palette PNG is accepted in practice. Codec
  // constraints on video and audio stay unenforced by design (§11.5).
  if (mimeType === 'image/png') {
    const depth = pngBitDepth(file.buffer);
    if (depth !== 8) {
      return {
        ok: false,
        error: depth === null
          ? 'PNG header is unreadable or truncated; re-export the image as an 8-bit PNG'
          : `PNG is ${depth}-bit, and only 8-bit PNG can be sent; re-export the image as 8-bit`,
      };
    }
  }

  const filename = sanitizeFilename(file.originalname);
  if (!filename) {
    return { ok: false, error: 'filename is required' };
  }

  return { ok: true, filename, mimeType, mediaType: mediaTypeFor(mimeType), byteSize };
}

/**
 * Builds the media_asset row. Write-once — this table is never updated (§5).
 *
 * @param {string} email - identifies the owner; the query layer resolves it to userid.
 * @param {string} hash - from hashContent; dedupe detection only.
 * @param {{filename, mimeType, mediaType?, byteSize}} meta - server-determined, from validateUpload.
 */
function buildAssetRecord(email, hash, meta) {
  if (!email) throw new TypeError('buildAssetRecord requires an email');
  if (!hash) throw new TypeError('buildAssetRecord requires a content hash');
  const m = meta || {};
  if (!m.mimeType) throw new TypeError('buildAssetRecord requires meta.mimeType');
  const filename = sanitizeFilename(m.filename);
  if (!filename) throw new TypeError('buildAssetRecord requires meta.filename');

  return {
    email,
    contentHash: hash,
    mediaType: m.mediaType || mediaTypeFor(m.mimeType),
    mimeType: m.mimeType,
    byteSize: m.byteSize,
    filename,
  };
}

// --------------------------------------------------------------------------
// Reconciliation
// --------------------------------------------------------------------------

function toMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

// Handles arrive either as mapped objects or as raw snake_case database rows.
// Accepting both is deliberate: a shape mismatch here would look like "this
// asset has no handles", so the reconciler would re-upload everything on every
// tick and nothing would ever report an error. Silent, expensive, invisible.
function normalizeHandle(h) {
  if (!h) return null;
  const assetId = h.assetId !== undefined ? h.assetId : h.asset_id;
  const accountId = h.accountId !== undefined ? h.accountId : h.account_id;
  const platformMediaId = h.platformMediaId !== undefined ? h.platformMediaId : h.platform_media_id;
  const uploadedAt = h.uploadedAt !== undefined ? h.uploadedAt : h.uploaded_at;
  const expiresAt = h.expiresAt !== undefined ? h.expiresAt : h.expires_at;
  if (!assetId || !accountId) return null;
  return {
    assetId: String(assetId).toLowerCase(),
    accountId: String(accountId),
    platformMediaId: platformMediaId || null,
    uploadedAt: toMs(uploadedAt),
    expiresAt: toMs(expiresAt),
  };
}

function normalizeAccount(a) {
  if (!a) return null;
  const accountId = a.accountId !== undefined ? a.accountId : (a.account_id !== undefined ? a.account_id : a.key);
  const userid = a.userid !== undefined ? a.userid : a.user_id;
  const platform = canonicalPlatform(a.platform !== undefined ? a.platform : a.entity);
  if (!accountId || !userid) return null;
  return { accountId: String(accountId), userid: String(userid), platform };
}

function normalizeAsset(a) {
  if (!a || !a.id) return null;
  const userid = a.userid !== undefined ? a.userid : a.user_id;
  return { id: String(a.id).toLowerCase(), userid: userid === undefined || userid === null ? null : String(userid) };
}

/**
 * When this handle stops being usable, in ms.
 *
 * expires_at wins when the platform told us one. Otherwise the lifetime is
 * derived from uploaded_at plus the platform's TTL — from upload, never from
 * last use (§2). A handle with a TTL but no uploaded_at has an unknowable age
 * and is treated as already over.
 *
 * null means "no plannable end of life", which now happens ONLY for a platform
 * absent from policy.ttlMs. Both platforms we fan out to have a finite TTL
 * (Messenger 90 days, WhatsApp 30) — see the warning on
 * DEFAULT_RECONCILE_POLICY before adding a third without one.
 */
function endOfLife(handle, platform, policy) {
  if (handle.expiresAt !== null) return handle.expiresAt;
  const ttl = (policy.ttlMs || {})[platform];
  if (!ttl) return null;
  if (handle.uploadedAt === null) return -Infinity;
  return handle.uploadedAt + ttl;
}

/**
 * The reconciler's entire decision layer. Pure and clock-injected.
 *
 * Desired state: one fresh handle per (asset × each of its owner's messaging
 * accounts). Actual state: the handle rows passed in. This returns the actions
 * that close the gap — and one mechanism covers every case (§2):
 *
 *   - a handle that was never created (fan-out at upload is best-effort)
 *   - a handle nearing the end of its life
 *   - an account connected after the asset was uploaded (backfill)
 *   - a handle for an account the owner no longer has (prune)
 *
 * IDEMPOTENT: apply the returned actions, run it again with the same clock, and
 * it returns nothing. That property is what makes it safe to run on a tick.
 *
 * @param {Date|number} now
 * @param {Array<{id, userid}>} assets
 * @param {Array<{userid, accountId, platform}>} accounts
 * @param {Array<{assetId, accountId, platformMediaId, uploadedAt, expiresAt}>} handles
 * @param {{ttlMs, refreshMarginMs, prune}} policy
 * @returns {Array<{type:'create'|'refresh'|'prune', assetId, accountId, platform, reason}>}
 */
function planReconcile(now, assets, accounts, handles, policy) {
  const p = policy || DEFAULT_RECONCILE_POLICY;
  const nowMs = toMs(now);
  if (nowMs === null) throw new TypeError('planReconcile requires a clock');
  const margin = p.refreshMarginMs || 0;
  const deadline = nowMs + margin;

  const assetList = (assets || []).map(normalizeAsset).filter(Boolean);

  const accountsByUser = new Map();
  for (const account of (accounts || []).map(normalizeAccount).filter(Boolean)) {
    if (!accountsByUser.has(account.userid)) accountsByUser.set(account.userid, []);
    accountsByUser.get(account.userid).push(account);
  }

  // Keyed on account_id ALONE — never on (platform, account_id). The platform
  // has two spellings in this codebase and the writer and reader hold different
  // ones, so a two-part key lets them disagree while every message still
  // delivers by URL: an invisible failure. See migration 24's comment.
  const handlesByAsset = new Map();
  for (const handle of (handles || []).map(normalizeHandle).filter(Boolean)) {
    if (!handlesByAsset.has(handle.assetId)) handlesByAsset.set(handle.assetId, new Map());
    handlesByAsset.get(handle.assetId).set(handle.accountId, handle);
  }

  const actions = [];

  for (const asset of assetList) {
    const owned = accountsByUser.get(asset.userid) || [];
    const existing = handlesByAsset.get(asset.id) || new Map();

    for (const account of owned) {
      const handle = existing.get(account.accountId);
      if (!handle) {
        actions.push(action('create', asset.id, account, 'missing'));
        continue;
      }
      if (!handle.platformMediaId) {
        actions.push(action('refresh', asset.id, account, 'dead'));
        continue;
      }
      const end = endOfLife(handle, account.platform, p);
      if (end !== null && end <= deadline) {
        actions.push(action('refresh', asset.id, account, 'expiring'));
      }
    }

    // Prune only within the batch's own assets. A handle for an asset we were
    // not asked about may simply belong to another page of work.
    if (p.prune !== false) {
      const ownedIds = new Set(owned.map(a => a.accountId));
      for (const handle of existing.values()) {
        if (!ownedIds.has(handle.accountId)) {
          actions.push({
            type: 'prune',
            assetId: asset.id,
            accountId: handle.accountId,
            platform: null,
            reason: 'account_disconnected',
          });
        }
      }
    }
  }

  return actions;
}

function action(type, assetId, account, reason) {
  return { type, assetId, accountId: account.accountId, platform: account.platform, reason };
}

module.exports = {
  MEDIA_TYPE_LIMITS,
  ALLOWED_MIME_TYPES,
  DEFAULT_RECONCILE_POLICY,
  OCTET_STREAM,
  canonicalPlatform,
  hashContent,
  storageKeyFor,
  publicUrlFor,
  sanitizeFilename,
  parseAssetId,
  sniffContentType,
  pngBitDepth,
  mediaTypeFor,
  validateUpload,
  buildAssetRecord,
  planReconcile,
};
