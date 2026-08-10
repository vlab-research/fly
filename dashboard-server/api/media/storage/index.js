'use strict';

/*
 * Object storage for media assets (planning/media-abstraction.md §4).
 *
 * THE S3 API AND NOTHING ELSE (§4.1). No cloud-provider SDK, no provider
 * identity system, no two-backend abstraction — MinIO is reached over plain S3
 * with static credentials, and the same code would reach any S3-compatible
 * endpoint by changing S3_ENDPOINT. `minio` (minio-js) is the client for the
 * same reason media-proxy uses `minio-go`: it is an S3 client rather than a
 * cloud vendor's SDK, it is a fraction of the dependency weight of
 * @aws-sdk/client-s3, and the two sides of the read/write pair then speak the
 * same library's semantics.
 *
 * THE LOAD-BEARING PART IS THE METADATA ON PutObject.
 *
 * `put` sets Content-Type and Content-Disposition as object metadata at write
 * time. media-proxy reads those back off the object and never sniffs at serve
 * time, which is exactly what keeps the proxy DATABASE-FREE (§4.4) — it cannot
 * be the thing that breaks when CockroachDB is slow. If these stop being
 * written here, the proxy serves media with no content type and browsers
 * sniff, which is the XSS class §4.6 exists to close. See media-proxy/README.md.
 */

const Minio = require('minio');

const { storageKeyFor, publicUrlFor } = require('../media.core');

/**
 * Content-Disposition for a stored object.
 *
 * `inline` because survey media is meant to render, not download. The filename
 * is advisory — the object key never contains it (§5) — but it is what a
 * researcher sees if they do save the file, and it is what WhatsApp document
 * sends surface. RFC 5987 `filename*` carries anything non-ASCII; the plain
 * `filename` stays ASCII-only so old clients do not choke.
 */
function contentDisposition(filename) {
  if (!filename) return 'inline';
  // eslint-disable-next-line no-control-regex
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * A no-op backend for local development without MinIO (STORAGE_BACKEND=none).
 *
 * Matches the exporter's convention (§4.7). It is deliberately NOT silent about
 * being a no-op — a developer who thinks bytes are being stored and finds a 404
 * later has been misled, so every write says so.
 */
function makeNoopStorage(config) {
  return {
    backend: 'none',
    keyFor: storageKeyFor,
    publicUrl: (assetId, filename) => publicUrlFor(config.publicBase, assetId, filename),
    async put({ assetId }) {
      console.warn(`[media/storage] STORAGE_BACKEND=none: discarding bytes for asset ${assetId}`);
      return { key: storageKeyFor(assetId), stored: false };
    },
    async delete({ assetId }) {
      return { key: storageKeyFor(assetId), deleted: false };
    },
  };
}

function makeS3Storage(config) {
  const endpoint = new URL(config.endpoint);
  const client = new Minio.Client({
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : undefined,
    useSSL: endpoint.protocol === 'https:',
    region: config.region,
    accessKey: config.accessKeyId,
    secretKey: config.secretAccessKey,
    // MinIO and AWS both serve path-style; virtual-host style would require the
    // bucket to be a DNS label under our own endpoint, which it is not.
    pathStyle: true,
  });

  return {
    backend: 's3',
    client,
    bucket: config.bucket,
    keyFor: storageKeyFor,
    publicUrl: (assetId, filename) => publicUrlFor(config.publicBase, assetId, filename),

    /**
     * Writes the bytes for an asset, with the metadata the proxy serves back.
     *
     * @param {{assetId: string, buffer: Buffer, contentType: string, filename: string}} file
     */
    async put({ assetId, buffer, contentType, filename }) {
      const key = storageKeyFor(assetId);
      await client.putObject(config.bucket, key, buffer, buffer.length, {
        // minio-js passes these through as real S3 headers rather than
        // x-amz-meta-* (it has an allowlist of native headers), which is what
        // makes them readable by any S3 client — including minio-go in the
        // proxy — as the object's own content type and disposition.
        'Content-Type': contentType,
        'Content-Disposition': contentDisposition(filename),
      });
      return { key, stored: true };
    },

    async delete({ assetId }) {
      const key = storageKeyFor(assetId);
      await client.removeObject(config.bucket, key);
      return { key, deleted: true };
    },
  };
}

/**
 * Builds a storage client from a resolved config object (config/index.js STORAGE).
 * Pure dispatch — the only branch is the backend, per §4.1's "one S3 client,
 * not a two-backend abstraction".
 */
function makeStorage(config) {
  if (!config || config.backend === 'none') return makeNoopStorage(config || {});
  if (config.backend !== 's3') {
    throw new Error(`unknown STORAGE_BACKEND: ${config.backend} (expected s3 or none)`);
  }
  return makeS3Storage(config);
}

module.exports = { makeStorage, contentDisposition };
