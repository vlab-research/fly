// Pure helpers for the media library (planning/media-abstraction.md §3).
//
// Everything here is a pure function of its arguments so it can be tested
// without rendering anything. The container is the imperative shell: it
// fetches, and hands the results to these.

/**
 * Human-readable byte size.
 *
 * Base 1024, one decimal place at MB and above, and the unit spelled "MB" —
 * DELIBERATELY the same convention dashboard-server's validateUpload uses
 * ("image is 6.2 MB, maximum is 5.0 MB", media.core.js:506). A researcher who
 * is told to shrink a 6.2 MB image must be able to find the 6.2 MB row in the
 * list. If the two disagreed, the actionable error would stop being actionable.
 */
export const formatBytes = (bytes) => {
  // `Number(null)` is 0, so a missing size would otherwise render as "0 B" —
  // a plausible-looking lie. Guard the empty cases before coercing.
  if (bytes === null || bytes === undefined || bytes === '') return '—';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

/**
 * Pulls the server's message out of whatever the API client threw.
 *
 * THIS IS THE POINT OF THE ERROR PATH, not a nicety. §11.5 decided that the
 * dashboard refuses ineligible files rather than transcoding them — no
 * downscaling, no re-encoding, no silent mutation of a researcher's file. That
 * bargain is only fair because the refusal names the problem and the fix:
 * "image is 6.2 MB, maximum is 5.0 MB", "GIF is not supported; use JPEG or
 * PNG". Collapsing that into "upload failed" would leave the researcher with a
 * file they cannot fix and no way to learn why, which destroys the whole
 * decision. So: surface the server's string VERBATIM, and only fall back to a
 * generic message when there is genuinely no server string to show.
 *
 * services/api/fetcher.js throws `new Error(await res.text())` on any non-2xx,
 * so err.message is the raw response body — normally `{"error": "..."}`. A
 * network failure throws a TypeError whose message is not JSON; that message is
 * still better than a placeholder, so it is passed through too.
 */
export const parseApiError = (err, fallback = 'Upload failed') => {
  const raw = (err && err.message) || '';
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string' && parsed) return parsed;
    if (parsed && typeof parsed.error === 'string' && parsed.error) return parsed.error;
    // Older/other endpoints nest it; keep reading rather than losing the text.
    if (parsed && parsed.error && typeof parsed.error.message === 'string') {
      return parsed.error.message;
    }
    if (parsed && typeof parsed.message === 'string' && parsed.message) return parsed.message;
    return fallback;
  } catch (e) {
    // Not JSON. The body (or the network error) is the most specific thing we
    // have, so show it rather than swallowing it.
    return raw;
  }
};

/**
 * Puts an uploaded asset into the list.
 *
 * REGRESSION GUARD FOR THE DEDUPE PATH. POST /media/upload answers 201 with a
 * new asset, but 200 with the EXISTING asset when the same researcher uploads
 * bytes they have already uploaded (media.controller.js, `UNIQUE (userid,
 * content_hash)`). Blindly prepending would show the same asset twice, with the
 * same key, until the page was reloaded. Replace-by-id keeps the list honest
 * for both status codes without the client having to know which it got.
 *
 * Newest first, matching GET /media's ordering.
 */
export const mergeAsset = (assets, asset) => {
  if (!asset) return assets;
  const rest = (assets || []).filter(a => a.id !== asset.id);
  return [asset, ...rest];
};

/** Only images get an inline preview; everything else shows its type. */
export const isPreviewable = asset => !!asset && asset.mediaType === 'image';
