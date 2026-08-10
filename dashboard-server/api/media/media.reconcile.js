'use strict';

/*
 * The media handle reconciler (planning/media-abstraction.md §2, §7, §11.3).
 *
 * A RECONCILER, NOT A REFRESHER.
 *
 *   Desired state: one fresh handle per (asset × each of its owner's messaging
 *                  accounts).
 *   Actual state:  the rows in media_handle.
 *
 * This closes the gap, and ONE MECHANISM COVERS THREE CASES: a handle nearing
 * the end of its life, an account connected after the asset was uploaded, and
 * the partial fan-out failures that upload time is allowed to leave behind
 * precisely because this exists. That is what lets fan-out be a best-effort
 * warm-the-cache step rather than something that has to be reliable while a
 * researcher waits.
 *
 * THE DECISION LAYER IS NOT HERE. `planReconcile` in media.core.js is pure and
 * clock-injected and already tested; this file is the imperative shell around
 * it — read state, ask the core what to do, do it, report. The one piece of
 * logic that lives here is `prioritiseActions`, and it is pure for the same
 * reason: which work gets deferred under a cap is a decision, and a decision
 * you cannot test without a clock and a Meta account is a decision nobody
 * checks.
 *
 * AGE IS THE MECHANISM; ERRORS ARE NOT. There is deliberately no error-driven
 * invalidation (§8.4, settled by §11.2). Meta documents no error code for an
 * expired or nonexistent media id, and the nearest one is an explicit catch-all
 * merging permanent and transient causes. Classifying against a guessed taxonomy
 * bulk-invalidates good handles and triggers a re-upload storm. A platform
 * upload that fails here is logged and dropped; the next tick retries it.
 *
 * FAILURE IS NOT FATAL. A handle is always an optimisation, never a requirement
 * — every asset has a public URL we control, so every failure in this file
 * degrades to a URL send rather than a failed message (§13). One dead token,
 * one unreadable object, one owner whose credentials are broken: logged,
 * counted, and the run continues.
 */

const { planReconcile, DEFAULT_RECONCILE_POLICY, canonicalPlatform } = require('./media.core');

// --------------------------------------------------------------------------
// Bounds
// --------------------------------------------------------------------------
//
// WHY THERE IS A BOUND AT ALL. Desired state is assets × accounts, which grows
// multiplicatively, and one production user has 29 messaging accounts (§11.1b).
// Every action is a file upload to Meta of up to 100 MB, so "reconcile
// everything" is not a run, it is an incident: connecting one account for that
// user turns every asset they own into an upload, all in one tick.
//
// TWO BOUNDS, because count alone is the wrong unit. 200 actions is a few
// seconds of small images or 20 GB of documents, and only one of those is
// survivable. The byte budget is what actually bounds the cost, and the count
// bound is what bounds the number of round trips to Meta.
const DEFAULT_LIMITS = {
  // Actions (platform uploads) per run. Steady state is far below this: with
  // 90/30-day TTLs and an hourly tick, refreshes arrive a handful at a time.
  // The cap only bites on a burst — a newly connected account backfilling an
  // existing library — and a burst is exactly what should be spread over ticks
  // rather than fired at Meta at once.
  maxActions: 200,
  // Bytes re-uploaded per run. 512 MB is roughly the 29-account user's 16 MB
  // video fanned out once, so even the worst documented case makes progress in
  // one tick instead of deadlocking.
  maxBytes: 512 * 1024 * 1024,
  // How many deferred actions to name in the summary before summarising the
  // rest. Naming SOME is the point (§10): a silent cap reads as "covered
  // everything" when it did not.
  logDeferred: 20,
};

// Urgency classes, most urgent first. This ordering is the whole anti-
// starvation design, so it is worth being explicit about why it is this way:
//
//   'expiring' — a handle that WORKS TODAY and stops working soon. Refreshing
//                it PREVENTS a degradation. This is the only class where
//                deferring makes something worse.
//   'dead'     — platform_media_id IS NULL. Already degrading.
//   'missing'  — no handle at all. Already degrading, and has been since upload.
//
// Both degraded classes are already sending by URL, which is correct and
// invisible to the respondent, so they wait behind the one that is not yet
// degraded. Refreshes cannot starve creates over time because a refreshed
// handle is not due again for a full TTL — the class is self-limiting.
const REASON_RANK = { expiring: 0, dead: 1, missing: 2 };

// A NUL separator, not a space or a dash: account ids are page ids and phone
// number ids, and while none of them contains a NUL, guessing that none of
// them contains a printable separator is how two distinct handles quietly
// collapse into one map entry.
const KEY_SEP = '\u0000';

function handleKey(assetId, accountId) {
  return `${assetId}${KEY_SEP}${accountId}`;
}

function toMs(value) {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

const DURATION_UNITS = { ms: 1, s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000 };

/**
 * Parses a Go-style duration ("72h", "30m", "7d") to milliseconds. PURE.
 *
 * THE UNIT IS REQUIRED. `refreshMargin: "72h"` in devops/values/<env>.yaml is
 * the operator-facing spelling, and accepting a bare number there would be
 * ambiguous enough to be dangerous: read as milliseconds, "72" is a margin of
 * 72ms, which silently disables refresh-ahead and leaves every handle to die
 * between ticks with nothing erroring.
 *
 * @returns {number|null} null when the input is not a duration
 */
function parseDuration(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(String(value));
  if (!m) return null;
  return Number(m[1]) * DURATION_UNITS[m[2]];
}

/**
 * Orders the planned actions by urgency and splits them against the per-run
 * bounds. PURE.
 *
 * PRUNES ARE NEVER DEFERRED. A prune is a single DELETE — no bytes fetched, no
 * upload, no Meta round trip — so charging it against a budget that exists to
 * limit uploads would defer cheap correctness behind expensive work.
 *
 * THE BUDGET CUT IS A TAIL, NOT A FILTER. When the next action does not fit the
 * byte budget we stop, rather than skipping it to squeeze in smaller ones
 * behind it. Skipping would reorder by size and starve large assets forever;
 * stopping means the next tick starts at the same place, finds the head already
 * done, and advances. The very first action is always allowed through even if
 * it alone exceeds the budget, so a single oversized asset cannot deadlock the
 * queue.
 *
 * @param {Array} actions - from planReconcile
 * @param {Map<string,{byteSize:number, created:*}>} assets - by asset id
 * @param {Map<string,{uploadedAt:*, expiresAt:*}>} handles - by handleKey()
 * @param {{maxActions:number, maxBytes:number}} limits
 * @returns {{prunes:Array, todo:Array, deferred:Array}}
 */
function prioritiseActions(actions, assets, handles, limits) {
  const max = Object.assign({}, DEFAULT_LIMITS, limits || {});

  const prunes = [];
  const uploads = [];
  for (const a of actions || []) {
    if (a.type === 'prune') prunes.push(a);
    else uploads.push(a);
  }

  const sortKey = a => {
    const rank = REASON_RANK[a.reason] !== undefined ? REASON_RANK[a.reason] : 9;
    // Within 'expiring', soonest death first — and it must be expires_at, not
    // uploaded_at: a WhatsApp handle (30 days) uploaded 28 days ago is more
    // urgent than a Messenger one (90 days) uploaded 60 days ago, and ordering
    // on upload time gets that backwards.
    const handle = handles.get(handleKey(a.assetId, a.accountId));
    const asset = assets.get(a.assetId);
    const when = rank === 0
      ? (handle && (toMs(handle.expiresAt) !== null ? toMs(handle.expiresAt) : toMs(handle.uploadedAt)))
      // Longest-waiting asset first, so an asset that has never had a handle
      // does not sit behind newer uploads on every tick.
      : (asset && toMs(asset.created));
    return [rank, when === null || when === undefined ? 0 : when, a.assetId, a.accountId];
  };

  const keyed = uploads.map(a => ({ a, k: sortKey(a) }));
  keyed.sort((x, y) => {
    for (let i = 0; i < 4; i++) {
      if (x.k[i] < y.k[i]) return -1;
      if (x.k[i] > y.k[i]) return 1;
    }
    return 0;
  });

  const todo = [];
  const deferred = [];
  let bytes = 0;
  let full = false;
  for (const { a } of keyed) {
    const asset = assets.get(a.assetId);
    const size = asset && Number(asset.byteSize) ? Number(asset.byteSize) : 0;
    const overCount = todo.length >= max.maxActions;
    const overBytes = todo.length > 0 && bytes + size > max.maxBytes;
    if (full || overCount || overBytes) {
      full = true;
      deferred.push(a);
      continue;
    }
    bytes += size;
    todo.push(a);
  }

  return { prunes, todo, deferred };
}

// --------------------------------------------------------------------------
// The shell
// --------------------------------------------------------------------------

function defaultLog(level, message, fields) {
  const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(
    `[media/reconcile] ${line}`,
  );
}

/**
 * Reads one owner's desired and actual state.
 *
 * Returns null when the owner cannot be read at all — a broken credentials row
 * or a query failure for one researcher must not take the whole run down, and
 * the next tick retries them.
 */
async function readOwner({ owner, mediaQuery, credentialQuery, log }) {
  try {
    const [accounts, assets, handles] = await Promise.all([
      credentialQuery.getMessagingAccounts({ email: owner.email }),
      mediaQuery.listAssetsForOwner({ userid: owner.userid }),
      mediaQuery.listHandlesForOwner({ userid: owner.userid }),
    ]);
    return { accounts: accounts || [], assets: assets || [], handles: handles || [] };
  } catch (e) {
    log('error', `could not read state for owner ${owner.email}: ${e.message}`);
    return null;
  }
}

/**
 * Runs one reconciliation pass.
 *
 * IDEMPOTENT. Apply what this returns, run it again against the same state with
 * the same clock, and it does nothing: `planReconcile` produces no actions for a
 * handle that is fresh, and every write is an upsert on the primary key
 * (asset_id, account_id), so even a duplicated action converges rather than
 * accumulating.
 *
 * SAFE TO RUN ALONGSIDE AN UPLOAD FANNING OUT. The one read-then-write window
 * that matters is the prune, and it is closed by matching on the `uploaded_at`
 * the snapshot read (see deleteHandleIfUnchanged). A refresh racing a fan-out
 * writes the same shape of row twice and the later write wins, so the only cost
 * of losing that race is a wasted upload.
 *
 * @param {Object} deps
 * @param {Object} deps.mediaQuery       - listAssetOwners, listAssetsForOwner, listHandlesForOwner, upsertHandle, deleteHandleIfUnchanged
 * @param {Object} deps.credentialQuery  - getMessagingAccounts
 * @param {Object} deps.storage          - { get } — the bytes are re-uploaded, so they must be read back
 * @param {Function} deps.platformUpload - uploadToPlatform from ./media.platform-upload
 * @param {Date} [deps.now]              - injected clock
 * @param {Object} [deps.policy]         - defaults to DEFAULT_RECONCILE_POLICY
 * @param {Object} [deps.limits]         - defaults to DEFAULT_LIMITS
 * @param {Function} [deps.log]          - (level, message, fields)
 * @returns {Promise<Object>} the summary that gets logged
 */
async function reconcile({ mediaQuery, credentialQuery, storage, platformUpload, now, policy, limits, log }) {
  const clock = now instanceof Date ? now : new Date();
  const pol = policy || DEFAULT_RECONCILE_POLICY;
  const max = Object.assign({}, DEFAULT_LIMITS, limits || {});
  const say = log || defaultLog;

  const summary = {
    owners: 0,
    ownersFailed: 0,
    assets: 0,
    accounts: 0,
    handles: 0,
    planned: 0,
    created: 0,
    refreshed: 0,
    pruned: 0,
    failed: 0,
    deferred: 0,
    deferredBytes: 0,
    bytesUploaded: 0,
  };

  // ---- 1. Read the world -------------------------------------------------
  //
  // Rows, not bytes: three indexed queries per owner returning small rows. The
  // expensive thing is the uploads, and those are what the bounds limit. If the
  // asset count ever grows past what one pass can hold in memory, the shape to
  // reach for is paging this loop by owner — the plan and the bounds below
  // already work per-owner.
  const owners = await mediaQuery.listAssetOwners();
  const assetIndex = new Map();   // assetId -> {byteSize, created, filename, mimeType, mediaType}
  const handleIndex = new Map();  // handleKey -> {uploadedAt, expiresAt}
  const accountIndex = new Map(); // accountId -> {platform, accessToken}
  let actions = [];

  for (const owner of owners || []) {
    const state = await readOwner({ owner, mediaQuery, credentialQuery, log: say });
    if (!state) {
      summary.ownersFailed += 1;
      continue;
    }
    summary.owners += 1;
    summary.assets += state.assets.length;
    summary.accounts += state.accounts.length;
    summary.handles += state.handles.length;

    for (const asset of state.assets) {
      assetIndex.set(String(asset.id).toLowerCase(), {
        byteSize: Number(asset.byte_size),
        created: asset.created,
        filename: asset.filename,
        mimeType: asset.mime_type,
        mediaType: asset.media_type,
      });
    }
    for (const h of state.handles) {
      handleIndex.set(handleKey(String(h.asset_id).toLowerCase(), String(h.account_id)), {
        uploadedAt: h.uploaded_at,
        expiresAt: h.expires_at,
      });
    }
    for (const account of state.accounts) {
      // credentials.key. NOT the entity, NOT details->>'page_id' — the worker
      // looks handles up by (asset_id, account_id) alone, so any other value
      // here writes a handle nothing ever reads, and the miss is invisible
      // because a miss is the designed URL fallback (§5).
      accountIndex.set(String(account.key), {
        platform: canonicalPlatform(account.entity),
        accessToken: (account.details || {}).access_token,
      });
    }

    // ---- 2. Decide (pure) ----
    const accountsForPlan = state.accounts.map(a => ({
      userid: owner.userid,
      accountId: a.key,
      platform: a.entity,
    }));
    actions = actions.concat(planReconcile(clock, state.assets, accountsForPlan, state.handles, pol));
  }

  summary.planned = actions.length;

  // ---- 3. Prioritise and bound (pure) ------------------------------------
  const { prunes, todo, deferred } = prioritiseActions(actions, assetIndex, handleIndex, max);
  summary.deferred = deferred.length;
  summary.deferredBytes = deferred.reduce((n, a) => {
    const asset = assetIndex.get(a.assetId);
    return n + (asset && Number(asset.byteSize) ? Number(asset.byteSize) : 0);
  }, 0);

  // ---- 4. Prune (cheap, never deferred) ----------------------------------
  for (const action of prunes) {
    const existing = handleIndex.get(handleKey(action.assetId, action.accountId));
    try {
      const gone = await mediaQuery.deleteHandleIfUnchanged({
        assetId: action.assetId,
        accountId: action.accountId,
        uploadedAt: existing && existing.uploadedAt,
      });
      if (gone) summary.pruned += 1;
      // No `else`, deliberately: a miss means the row changed under us — the
      // credential came back and fan-out rewrote the handle — and leaving that
      // fresh handle alone is the correct outcome, not a failure.
    } catch (e) {
      summary.failed += 1;
      say('warn', `prune failed for ${action.assetId}/${action.accountId}: ${e.message}`);
    }
  }

  // ---- 5. Upload -----------------------------------------------------------
  //
  // Grouped by asset so the bytes are fetched ONCE and re-used across that
  // asset's accounts. For the 29-account user that is 1 storage read instead of
  // 29, and it is why the byte budget above is charged per upload (the cost to
  // Meta) rather than per fetch.
  const byAsset = new Map();
  for (const action of todo) {
    if (!byAsset.has(action.assetId)) byAsset.set(action.assetId, []);
    byAsset.get(action.assetId).push(action);
  }

  for (const [assetId, group] of byAsset) {
    const asset = assetIndex.get(assetId);

    let buffer;
    try {
      ({ buffer } = await storage.get({ assetId }));
    } catch (e) {
      // Not fatal to the run (§13). The object may be genuinely missing, or
      // MinIO may be briefly unavailable; either way every send for this asset
      // keeps working by URL and the next tick retries.
      summary.failed += group.length;
      say('warn', `could not fetch bytes for asset ${assetId}: ${e.message}`);
      continue;
    }

    const file = {
      buffer,
      filename: asset.filename,
      contentType: asset.mimeType,
      mediaType: asset.mediaType,
    };

    for (const action of group) {
      const account = accountIndex.get(action.accountId);
      try {
        const uploaded = await platformUpload({
          platform: action.platform,
          accountId: action.accountId,
          accessToken: account && account.accessToken,
          file,
          now: clock,
        });
        if (!uploaded.ok) throw new Error(uploaded.error);

        // INSERT ... ON CONFLICT (asset_id, account_id) DO UPDATE — which is
        // what makes reconcile idempotent by construction and what makes
        // racing a concurrent fan-out harmless.
        await mediaQuery.upsertHandle({
          assetId,
          accountId: action.accountId,
          platform: uploaded.platform,
          platformMediaId: uploaded.platformMediaId,
          // Restamped, so age-based expiry measures from THIS upload. Leaving
          // the original uploaded_at would make the handle look due again on
          // the very next tick, forever.
          uploadedAt: uploaded.uploadedAt,
          expiresAt: uploaded.expiresAt,
        });

        if (action.type === 'create') summary.created += 1;
        else summary.refreshed += 1;
        summary.bytesUploaded += buffer.length;
      } catch (e) {
        summary.failed += 1;
        say(
          'warn',
          `${action.type} failed for ${assetId}/${action.accountId} (${action.platform}): ${e.message}`,
        );
      }
    }
  }

  // ---- 6. Report -----------------------------------------------------------
  //
  // The deferral list is named, not just counted. A silent cap reads as
  // "covered everything" when it did not (§10) — the whole point of a bound is
  // that an operator can see the backlog it created and decide whether the
  // schedule or the cap needs to change.
  if (deferred.length) {
    const shown = deferred.slice(0, max.logDeferred);
    say('warn', `deferred ${deferred.length} action(s) to the next tick — the per-run bound was reached`, {
      maxActions: max.maxActions,
      maxBytes: max.maxBytes,
      deferredBytes: summary.deferredBytes,
      examples: shown.map(a => `${a.type}:${a.reason} ${a.assetId}/${a.accountId}`),
      andMore: Math.max(0, deferred.length - shown.length),
    });
  }
  say('info', 'run complete', summary);

  return summary;
}

module.exports = {
  reconcile,
  prioritiseActions,
  parseDuration,
  DEFAULT_LIMITS,
  handleKey,
};
