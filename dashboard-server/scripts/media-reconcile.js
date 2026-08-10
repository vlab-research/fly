#!/usr/bin/env node
'use strict';

/*
 * Entry point for the media handle reconciler (planning/media-abstraction.md
 * §2, §7, §11.3).
 *
 *   node scripts/media-reconcile.js
 *
 * Run as a Kubernetes CronJob from the dashboard image, which already has these
 * modules, this database connection and these S3 credentials —
 * devops/vlab/templates/media-reconciler-cronjob.yaml.
 *
 * WHY A SCRIPT AND NOT AN ENDPOINT ON DASHBOARD-SERVER (§11.3, decided here).
 * An internal HTTP endpoint would need its own authentication — one more secret
 * to issue, rotate and get wrong — and would exist for exactly one caller,
 * cron. It would also put a job that re-uploads up to hundreds of megabytes on
 * the same process that serves the researcher UI, where a long pass competes
 * with request handling and a crash takes the dashboard with it. A script gets
 * process isolation, its own resource limits and its own failure surface for
 * free, and reuses the same S3 client, the same credentials lookup and the same
 * `planReconcile` because it is the same codebase.
 *
 * EXIT CODES ARE A DELIBERATE DESIGN, NOT AN AFTERTHOUGHT.
 *
 *   0 — the pass ran, whatever it found. Individual upload failures are
 *       EXPECTED (a rotated page token, Meta being briefly unhappy, an asset
 *       whose codec WhatsApp refuses — §11.5) and they are not an outage: a
 *       handle is an optimisation, so every one of those messages still sends
 *       by URL. Exiting non-zero on them would fire CronJobRepeatedlyFailing
 *       (devops/alerts/templates/cronjob-health.yaml) for a condition that
 *       needs no page, and an alert that cries wolf gets muted, taking the real
 *       signal with it. The health signal for the handle layer is the by-URL
 *       counter (§8.5), not this exit code.
 *   1 — the pass could not run at all: no database, no config. That IS worth
 *       waking someone for, because nothing is being reconciled.
 */

const { Media, Credential, pool } = require('../queries');
const { STORAGE, MEDIA_RECONCILE } = require('../config');
const { makeStorage } = require('../api/media/storage');
const { uploadToPlatform } = require('../api/media/media.platform-upload');
const { DEFAULT_RECONCILE_POLICY } = require('../api/media/media.core');
const { reconcile, parseDuration, DEFAULT_LIMITS } = require('../api/media/media.reconcile');

/**
 * Builds the policy and the bounds from config, refusing anything malformed.
 *
 * Fails loudly rather than falling back to a default. A refreshMargin that does
 * not parse is not a typo you want silently replaced by 72h: the operator wrote
 * it to change something, and quietly ignoring them is how a value in a file
 * stops describing the cluster.
 */
function settingsFrom(cfg) {
  const policy = Object.assign({}, DEFAULT_RECONCILE_POLICY, { prune: cfg.prune });

  if (cfg.refreshMargin) {
    const ms = parseDuration(cfg.refreshMargin);
    if (ms === null) {
      throw new Error(
        `MEDIA_RECONCILE_REFRESH_MARGIN="${cfg.refreshMargin}" is not a duration ` +
          '(expected something like "72h", "30m" or "7d")',
      );
    }
    policy.refreshMarginMs = ms;
  }

  const limits = Object.assign({}, DEFAULT_LIMITS);
  if (cfg.maxActions) limits.maxActions = Number(cfg.maxActions);
  if (cfg.maxBytes) limits.maxBytes = Number(cfg.maxBytes);

  return { policy, limits };
}

async function main() {
  const { policy, limits } = settingsFrom(MEDIA_RECONCILE);
  const storage = makeStorage(STORAGE);

  if (storage.backend !== 's3') {
    // The reconciler RE-UPLOADS BYTES, so it is the one component that cannot
    // work against the no-op backend: there is nothing to read back. Refusing
    // is better than a run that reports every asset as failed.
    throw new Error('STORAGE_BACKEND=none: the reconciler needs real bytes to re-upload');
  }

  console.log(
    '[media/reconcile] starting ' +
      JSON.stringify({
        bucket: storage.bucket,
        refreshMarginMs: policy.refreshMarginMs,
        prune: policy.prune,
        maxActions: limits.maxActions,
        maxBytes: limits.maxBytes,
      }),
  );

  const summary = await reconcile({
    mediaQuery: Media,
    credentialQuery: Credential,
    storage,
    platformUpload: uploadToPlatform,
    policy,
    limits,
    now: new Date(),
  });

  return summary;
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async err => {
    // Only infrastructure-level failures reach here — reconcile() swallows and
    // counts everything per-owner and per-action. See the exit-code note above.
    console.error(`[media/reconcile] run could not complete: ${err && err.stack ? err.stack : err}`);
    try {
      await pool.end();
    } catch (e) {
      /* already down; the exit code is what matters */
    }
    process.exit(1);
  });
