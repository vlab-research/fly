# replybot Node 22 hang: r2 HTTP library

## Status

replybot v0.0.192 (Node 22 + node-rdkafka 2.18.0) hangs after receiving events. Rolled back to v0.0.191 (Node 12). v0.0.193 tag exists on main with an `acks=1` fix that is likely irrelevant.

## Symptom

- Event is consumed from Kafka and logged (`EVENT: ...`, `STATE: ...`)
- Processing never completes — no response sent to user, no further logs
- Rollback to v0.0.191 immediately restores normal operation

## Root cause

`r2` (v2.0.1, wraps an old `node-fetch`) hangs on Node 22 instead of resolving or rejecting. Node 22 changed internal stream/socket handling (the same breakage we saw in the messenger tests before bumping nock — `ERR_INVALID_ARG_TYPE: The "stream" argument must be an instance of ReadableStream, WritableStream, or Stream. Received an instance of Socket`).

Two call sites hang:

### 1. `lib/typewheels/ourform.js:39`
```js
const res = await r2(url, { headers }).response   // hangs
const f = await res.json()
```
Fetches the typeform/survey definition from `FORMCENTRAL_URL`. Confirmed via state showing a previous `getForm` error with a Node 12 stack trace in `retries`.

### 2. `lib/messenger/index.js:49,63,80`
```js
r2.get(url, { headers }).json      // getUserInfo
r2.post(url, { headers, json }).json  // sendMessage
r2.post(url, { headers, json }).json  // passThreadControl
```
All Facebook Graph API calls go through `r2`.

## Fix

Replace `r2` with native `fetch` (built into Node 18+, stable in Node 22). API is compatible at the call sites:

| r2 | native fetch |
|----|-------------|
| `r2(url, { headers }).response` | `fetch(url, { headers })` |
| `r2.get(url, { headers }).json` | `fetch(url, { headers }).then(r => r.json())` |
| `r2.post(url, { headers, json: data }).json` | `fetch(url, { method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(data) }).then(r => r.json())` |

Remove `r2` from `package.json` dependencies after migrating both files.

## Files to change

- `replybot/lib/typewheels/ourform.js` — 1 call site (line 39)
- `replybot/lib/messenger/index.js` — 3 call sites (lines 49, 63, 80)
- `replybot/package.json` — remove `"r2": "^2.0.1"`, upgrade `"nock"` from `^13.5.6` to `^14.0.0`

## Notes

- ~~Existing messenger tests use nock — nock intercepts at the http module level so they will work with native fetch unchanged~~ **INVALID**: nock v13.5.6 does NOT intercept Node 22's native fetch (which uses undici, not the `http` module). nock must be upgraded to v14+ which supports undici interception.
- The `facebookRequest` retry/error wrapper in messenger.js can stay as-is; only the inner `r2.*` calls change
- v0.0.193 is tagged on main with the `acks=1` fix — harmless but not the root cause; the next release should be v0.0.194 after the r2 migration
