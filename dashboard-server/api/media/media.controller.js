'use strict';

/*
 * HTTP shell over media.service.js (planning/media-abstraction.md §2, §3).
 * The pipeline and its two deliberate orderings — `put` before `insert`, and
 * fan-out after the response — are documented on the service; this file maps
 * outcomes onto HTTP. `makeHandlers(deps)` keeps the injected-dependency
 * signature the tests and the routes use.
 */

const { makeService, formatAsset } = require('./media.service');

function makeHandlers(deps) {
  const service = makeService(deps);

  async function uploadMedia(req, res) {
    const { email } = req.user;

    let result;
    try {
      result = await service.uploadAsset({ email, file: req.file });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }

    // The error names the problem and the fix.
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    // Respond. The asset exists and has a URL; nothing below can change that.
    res.status(result.deduplicated ? 200 : 201).json(result.asset);

    // Fan out, after the response, best-effort. Awaited only so callers that
    // want to observe it (tests, and any future synchronous caller) can —
    // the researcher is not waiting on it, and it can never fail the upload.
    await result.fanOut();
  }

  async function listMedia(req, res) {
    const { email } = req.user;
    try {
      return res.status(200).json(await service.listAssets({ email }));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  return { uploadMedia, listMedia, fanOutHandles: service.fanOutHandles, formatAsset: service.formatAsset };
}

module.exports = { makeHandlers, formatAsset };
