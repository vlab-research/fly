// Per-page configuration for smoke-echo.
//
// Facebook's handover protocol is inherently per-page: each page smoke-echo
// participates in has (a) its OWN page access token — one issued to *this* app
// for *that* page — and (b) its own Primary Receiver ("Fly") app that control
// gets handed back to. Production and staging are different pages with
// different Fly apps, so a single PAGE_ACCESS_TOKEN/FLY_APP_ID can't serve both.
//
// We keep smoke-echo stateless (no DB, no Kafka — its defining property) by
// carrying every page's config in a single JSON env var:
//
//   SMOKE_ECHO_PAGES = {
//     "<pageId>": { "token": "<page access token>", "flyAppId": "<primary app id>" },
//     ...
//   }
//
// The legacy PAGE_ACCESS_TOKEN / FLY_APP_ID env vars act as the "default page"
// fallback for any page NOT present in SMOKE_ECHO_PAGES. This lets you add pages
// incrementally: the original page keeps working from PAGE_ACCESS_TOKEN while
// you add, say, the staging page to the map — no need to move the existing
// token. If neither the map nor the legacy vars cover a page, the page is
// unconfigured (getPageConfig returns null) and events for it are skipped
// rather than sent with a wrong token.

function parsePages() {
  const raw = process.env.SMOKE_ECHO_PAGES
  if (!raw) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`SMOKE_ECHO_PAGES is not valid JSON: ${e.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SMOKE_ECHO_PAGES must be a JSON object keyed by page id')
  }
  return parsed
}

const pages = parsePages()

// Legacy single-page vars — the "default page" fallback for any page not in the
// map (see the note above).
const legacy = {
  token: process.env.PAGE_ACCESS_TOKEN,
  flyAppId: process.env.FLY_APP_ID,
}

// Returns { token, flyAppId } for a page, or null if the page isn't configured
// (not in the map and no legacy fallback token available).
function getPageConfig(pageId) {
  const cfg = pageId ? pages[pageId] : null
  if (cfg && cfg.token) {
    return { token: cfg.token, flyAppId: cfg.flyAppId || legacy.flyAppId }
  }
  // Fall back to the legacy "default page" token for any page not in the map.
  if (legacy.token) {
    return { token: legacy.token, flyAppId: legacy.flyAppId }
  }
  return null
}

function configuredPageIds() {
  return Object.keys(pages)
}

module.exports = { getPageConfig, configuredPageIds }
