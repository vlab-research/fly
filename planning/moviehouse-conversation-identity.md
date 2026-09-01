# moviehouse and link_tracking — conversation identity in webview URLs

**Last full pass: 2026-08-20.** Rewritten on that date: the original approach (a `tracked: true`
flag plus a `KNOWN_TRACKED_HOSTS` allowlist with per-service param schemes) was superseded and
has been removed from the text. The **production measurements are kept** — they are why the
replacement exists. Git history has the original.

**Status: DEPLOYED TO PRODUCTION 2026-08-25** (Phase 1.3; moviehouse shipped to the
Netlify `main` branch in the same window). Corrected 2026-08-26 — this read "built on
`feature/conversation-identity`. Not deployed." **This file is referenced from code**
(`moviehouse/src/identity.js`, `replybot/lib/generic-translator.js`,
`replybot/lib/typewheels/form.js`), so it is not a deletion candidate.

---

## 1. What it is now

`link_tracking` and `moviehouse` are **first-class field types**, and **replybot builds the whole
URL** — base from config (`LINKSNIFFER_URL` / `MOVIEHOUSE_URL` in the `replybot.env` block of
`devops/values/<env>.yaml`), identity from the conversation, content from the field. The
researcher writes `videoId: "164118668"` and nothing else.

- `replybot/lib/generic-translator.js` — builds the URLs
- `moviehouse/src/identity.js` — reads `vlab_user` / `vlab_account` / `vlab_platform` back off
  the query string and forwards them to hermes' `/synthetic`

**Why not the allowlist that was originally proposed:** an allowlist can only describe hosts a
researcher typed in the past. §3 below is the measurement that killed it — 86% of live fields
sat on a host that appears in **no repo file at all**, and is dead. replybot using *its own*
host needs no list and cannot rot.

---

## 2. This already happened in production — 2026-08-13

Not a projection. Participant `15126808320`, worldbank, `hpvbl` (WhatsApp) → stitch → `hpvmedia`:

```
22:27:33  bot_echo, phone_number_id 1265380589988964  (delivered over WhatsApp)
          webview url=…/?id=1143993262&pageId=101435865704727&userId=15126808320
22:27:34  page 1265380589988964 -> WAIT_EXTERNAL_EVENT (awaiting moviehouse:play)
22:27:48  synthetic {"user":"15126808320","page":"101435865704727", …    <-- WRONG ACCOUNT
           "event":{"value":{"type":"moviehouse:play","id":"1143993262"}}}
22:27:49  page 101435865704727 -> WAIT_EXTERNAL_EVENT, issues send_message
22:27:55  page 101435865704727 -> BLOCKED      (still BLOCKED in production today)
```

The button was delivered over WhatsApp and `userId` interpolated correctly, but **`pageId` was
the hardcoded Messenger page `101435865704727`**. moviehouse echoed it back as `page`, replybot
routed the event to a **phantom conversation on a Facebook page keyed by a phone number**, and
the real WhatsApp conversation never received its `moviehouse:play`. The participant re-entered
the survey manually.

**If you measure this population, do not filter on `states.pageid IN (<whatsapp keys>)`** — the
row hides on a Facebook page id. Filter on `platform='whatsapp'` (a lower bound; the column is
NULL for most rows) or on phone-number-shaped `userid`.

---

## 3. Production measurement — vprod + vstag, read-only, 2026-08-17

"Live" = `DISTINCT ON (userid, shortcode, survey_name) ORDER BY created DESC`. No live field
carries a literal `"type":"webview"`, so detection replays `addCustomType` + `_cleanStrings` in
Node over `js-yaml@3.14.2` and classifies both the string and object `url` forms: 1024
candidates → **1007 effective webview fields / 203 surveys**.

### The hosts

| host | in a repo file? | live prod fields | vstag | HTTP |
|---|---|---|---|---|
| `virtuallab-videos.netlify.app` | yes | 79 / 18 surveys | 13 / 3 | 200 |
| `staging--virtuallab-videos.netlify.app` | yes | 1 / 1 (`flysmoke`) | 1 / 1 | 200 |
| **`virtuallab-videos.netlify.com`** | **no — data only** | **490 / 64 surveys / 3 researchers** | 0 | **404 — dead** |

`virtuallab-videos.netlify.com` is the pre-migration Netlify apex carrying **86% of all live
moviehouse fields**, and it is not merely unlisted — it is **dead**. All 490 fields `wait` on
`moviehouse:play`, so those waits can never resolve.

Both rotted hosts were re-probed and are confirmed dead: `.netlify.com` 404s, and
`gbvlinks.nandan.cloud` (the linksniffer equivalent) resolves to the cluster ingress but is
claimed by no Ingress, so TLS fails against the controller's self-signed certificate.

### Size

**82 live surveys / 570 fields / 4 researchers.**

| class | surveys | fields | `moviehouse:*` wait fields |
|---|---|---|---|
| WA-owner | 36 | 178 | 144 |
| Messenger-only | 46 | 392 | 392 |
| **total** | **82** | **570** | **536** |

### `pageId` was hardcoded almost everywhere

**465 of 570 fields (81.6%)** hardcode `pageId` — versus 81 of 346 for linksniffer. Two
interpolate (`{{hidden:pageid}}`, both in `flysmoke`, the only correctly-authored survey in the
set) and 103 omit it.

| literal | fields | a real `credentials.key`? |
|---|---|---|
| `105246245358509` | 314 | yes — mchatila |
| `101435865704727` | 56 | yes — worldbank |
| **`105246245358509)`** | **37** | **no — trailing paren, junk** |
| **`720722553`** | **18** | **no — a Vimeo video id** |
| `111108121363615` | 12 | yes — worldbank |
| `104662068658429` | 12 | yes — mchatila |
| **`105246245358509)720722553`** | **8** | **no — two ids concatenated** |
| `881943064995558` | 7 | yes — worldbank |
| `1855355231229529` | 1 | yes — nandan |

All 36 WhatsApp-capable moviehouse surveys hardcode a **Messenger** page or omit it, except
`flysmoke`. Note the collision that makes the junk undetectable by validation: Vimeo ids and
Facebook page ids are both bare 9–15-digit strings.

---

## 4. Defects this measurement surfaced

| | Status |
|---|---|
| **`_removeMdLinks` was missing its `/g` flag** (`replybot/lib/typewheels/form.js`), so only the *first* markdown link in a description was unwrapped and the leftover `](…)` fragments concatenated into the query string — the cause of all 63 junk `pageId`s above. It reached production: `states` holds a row with `pageid = '105246245358509)'`. | **Fixed** — the pattern is global as of this branch (`form.js:337`). |
| **411 of 570 fields (72%) omit `userId` entirely**, which has hard-failed since 2025-11-09. | Moot under the new design — replybot builds the URL. |
| **One `buttonText` exceeds WhatsApp's 20-char `cta_url` cap** (`test@test.com` / `Ep5wnS`). | Not fixed. Cosmetic, one field. |
| **The phantom `states` row** at `(101435865704727, 15126808320)`, `BLOCKED`. | Still in production. Harmless but confusing; it is the §2 incident's residue. |

---

## 5. Rollout note

`SYNTHETIC_REQUIRE_CONVERSATION` (hermes) **must stay `false`** until moviehouse's new build is
live. moviehouse is served from **Netlify, not the cluster**, so it cannot roll out in the same
`helm upgrade` — turning the gate on first would 400 every moviehouse event and kill video
tracking outright. See `planning/conversation-identity.md` §5.4.

The 490 fields on the dead `.netlify.com` host are already broken and stay broken until those
surveys are re-authored onto the new field types. Nothing in this work fixes them in place.
