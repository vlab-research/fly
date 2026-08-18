# WhatsApp × webview/linksniffer exposure — production measurement

Measured against `vprod` (`gbv-cockroachdb-0`, `chatroach`), read-only, 2026-08-17.
Gates §7.1 of `planning/conversation-identity.md` (state cache re-key + deletion of the
`state.md.platform` fallback in `replybot/lib/typewheels/transition.js`).

## Headline

| # | Question | Answer |
|---|---|---|
| 1 | Live surveys on WhatsApp-capable accounts containing a webview field | **84** (2 researchers) |
| 1b | …of which have **ever been served to a participant on a WhatsApp account** | **0** |
| 2 | Same count, Messenger-only accounts (migration denominator) | **96** (+23 on accounts with no messaging credential) |
| 3 | Of the 84, pointing at a linksniffer host | **49** surveys / 224 fields |
| 4 | Of those 49, already authoring a `platform` param | **0** (0 of 1007 webview fields repo-wide) |
| 5 | Of the 84, `wait` on `linksniffer:click` (conversation **hangs**) | **13** surveys / 16 fields — all `worldbank@vlab.digital` (Girl Effect, Kenya TVET) + 2 `nandanmarkrao@gmail.com` test forms |
| 5b | …of those 13, ever served on WhatsApp | **0** |
| 6 | Shortcodes served on both a Messenger and a WhatsApp account | **3** (`305`, `hpvbl`, `hpvincentivedouble`) — **none contains a webview field** |

**Ship recommendation signal:** the intersection of "runs on WhatsApp" and "has a hand-authored
tracked link" is empty today. WhatsApp production traffic is **4 conversations total** across both
WhatsApp accounts, all created 2026-08-13..17 (smoke/pilot), and none of the 3 shortcodes involved
contains a webview field. The one real exposure is **indirect, via stitch** (§Stitch reachability)
and is `keepMoving: true` — lost click analytics, not a hung conversation.

## Definitions

**"Live"** = `DISTINCT ON (userid, shortcode, survey_name) ... ORDER BY created DESC` over
`chatroach.surveys`, restricted to rows where `jsonb_typeof(form_json->'fields') = 'array'`.
This is exactly what `formcentral.getSurveyByParams` (`formcentral/db.go:76-88`) serves for
`created <= now()`. 5141 total survey rows → **1208 live**.

**Account → platform.** `surveys` is scoped to `userid`, **not** to an account. `formcentral`
resolves `pageid → credentials.userid → surveys.shortcode`, so *every* survey a user owns is
reachable from *every* messaging account that user owns. Classes used below:

| class | definition | live surveys |
|---|---|---|
| `WA-owner` | userid has ≥1 `whatsapp_business` credential (both also have `facebook_page`) | 492 |
| `Messenger-only` | userid has `facebook_page` only | 651 |
| `no-account` | userid has neither → surveys unreachable by `getSurveyByParams` | 65 |

There is **no WhatsApp-exclusive owner**: both WhatsApp users also own Facebook pages, so
deliverable #6 is structurally true for all 492 (84 with webviews). The empirical answer is the
3 shortcodes measured in `states`.

**Credential census** (verified as expected): 62 `facebook_page` / 20 users, 2 `whatsapp_business` / 2 users.

| entity | key | userid | email |
|---|---|---|---|
| whatsapp_business | 1203867182815254 | 10383123-…b54b17a | nandanmarkrao@gmail.com |
| whatsapp_business | 1265380589988964 | 56c6bf37-…35ea35c2 | worldbank@vlab.digital |
| facebook_page | 1855355231229529 | 10383123-…b54b17a | nandanmarkrao@gmail.com |
| facebook_page | 101435865704727, 111108121363615, 881943064995558 | 56c6bf37-…35ea35c2 | worldbank@vlab.digital |

**Webview detection.** Not a literal `"type":"webview"` — **0** live fields have that.
All 1007 are `statement` fields promoted by `addCustomType` (`replybot/lib/typewheels/form.js:351`).
Detection replicated exactly: `js-yaml@3.14.2 safeLoad(properties.description.trim())` →
`_cleanStrings` → `params.type === 'webview'`. SQL pre-filters with
`f->>'type'='webview' OR properties.description ILIKE '%webview%'` (1024 candidate fields / 206
surveys), then Node applies the real promotion (1007 fields / **203** surveys). 3 surveys /
17 fields mention "webview" in a description that does not promote — correctly excluded.

**Linksniffer host allowlist.** `isKnownLinksnifferHost` **does not exist in the tree** — it is
part of the unwritten §7.1 change, so it could not be read. Set derived from
`devops/values/production.yaml:395` (`links.vlab.digital`),
`devops/values/staging.yaml:440` (`staging.links.vlab.digital`), and the legacy hosts that
actually dominate production data:

```
links.vlab.digital              146 fields
gbvlinks.nandan.cloud           193 fields   (legacy prod — NOT in any values file)
gbvlinks-staging.nandan.cloud     7 fields   (legacy staging)
staging.links.vlab.digital        0 fields
```
Any allowlist that omits `gbvlinks.nandan.cloud` misses **56%** of production tracked links.

`linksniffer` today (`linksniffer/server.go:33-40`, `linksniffer/eventer.go:33`) reads only
`id`, `pageid`, `url`, `p` and emits `{"user","page","event":{"type":"external","value":{"type":"linksniffer:click","url"}}}`.
**There is no `platform` param and no platform field in the event yet.**

## 1–5. Counts

### Survey level (live surveys with ≥1 effective webview field)

| class | webview surveys | linksniffer host | `platform` param | `wait`→`linksniffer:click` | any `wait` |
|---|---|---|---|---|---|
| WA-owner | **84** | **49** | **0** | **13** | 45 |
| Messenger-only | 96 | 38 | 0 | 1 | 47 |
| no-account | 23 | 17 | 0 | 1 | 1 |
| **total** | **203** | **104** | **0** | **15** | 93 |

### Field level (1007 effective webview fields)

| class | fields | linksniffer | `platform` | `wait`→click | any `wait` | `keepMoving` |
|---|---|---|---|---|---|---|
| WA-owner | 420 | 224 | 0 | 16 | 160 | 258 |
| Messenger-only | 509 | 87 | 0 | 1 | 393 | 300 |
| no-account | 78 | 35 | 0 | 2 | 2 | 76 |
| **total** | **1007** | **346** | **0** | **19** | 555 | 634 |

### Per researcher

| email | class | webview surveys | linksniffer surveys | wait-on-click surveys | linksniffer fields |
|---|---|---|---|---|---|
| worldbank@vlab.digital | **WA-owner** | 38 | **30** | **11** | 52 |
| nandanmarkrao@gmail.com | **WA-owner** | 46 | **19** | **2** | 172 |
| dpinzonhernandez@worldbank.org | Messenger-only | 21 | 21 | 1 | 33 |
| curiouslearning@vlab.digital | no-account | 22 | 16 | 1 | 18 |
| mchatila@worldbank.org | Messenger-only | 57 | 15 | 0 | 35 |
| test@test.com | Messenger-only | 3 | 2 | 0 | 19 |
| malaria@barcelonagse.eu | no-account | 1 | 1 | 0 | 17 |
| raquelgerard@gwu.edu, joana.lourenco@efsa.europa.eu, j.ludwig.1@tu-berlin.de, mattea.cussel@upf.edu | Messenger-only | 15 | 0 | 0 | 0 |

**Eventual `tracked: true` migration size: 104 live surveys / 346 fields, 7 researchers.**

### URL shapes (confirms the doc gap)

`documentation/questions.md` documents only the object `url` form. Repo-wide:
`string` **780** fields / `object` **227**. Restricted to linksniffer hosts: `string` **201** /
`object` **145**. Both forms must be handled; `makeUrl` (`replybot/lib/generic-translator.js:1-11`)
already does.

### 1b/5b. Actual WhatsApp traffic

All 4 WhatsApp conversations that have ever existed in production:

| pageid | platform | current_form | current_state | updated |
|---|---|---|---|---|
| 1265380589988964 | whatsapp | hpvincentivedouble | QOUT | 2026-08-17 11:00 |
| 1265380589988964 | whatsapp | 305 | ERROR | 2026-08-16 18:34 |
| 1203867182815254 | whatsapp | 305 | END | 2026-08-16 18:21 |
| 1203867182815254 | whatsapp | hpvbl | ERROR | 2026-08-13 18:59 |

Webview field counts in the live versions of those shortcodes, for the two WA owners:
`305` → **0** (all 10 variants, 1 field each), `hpvbl` → **0** (68 fields),
`hpvincentivedouble` → **0** (18 fields).

Activity check across all 38 shortcodes that carry a WA-owner linksniffer webview:
21 have participants, **`on_whatsapp = 0` for every one**. Largest are Messenger-only and current:
`tuki` 243, `both` 224, `wazzii` 197, `hpvendline` 172 (all last-active 2026-08-17, pageid 101435865704727).

## 6. Cross-platform shortcodes

All three WhatsApp-served shortcodes are also served on Messenger — but none has a webview,
so no hardcoded `pageid`/`platform` is wrong for them.

| current_form | whatsapp pageids | messenger pageids |
|---|---|---|
| 305 | 1203867182815254 (1), 1265380589988964 (1) | 1855355231229529 (29663), 101435865704727 (15782), 111108121363615 (4006), 881943064995558 (838) |
| hpvbl | 1203867182815254 (1) | 881943064995558 (2143), 101435865704727 (1346) |
| hpvincentivedouble | 1265380589988964 (1) | 101435865704727 (69) |

**Structurally**, however, all 84 WA-owner webview surveys are dual-served, and **every one of the
49 linksniffer surveys hardcodes a Messenger `pageid`** into the tracked link (or omits it).
Distinct hardcoded `pageid` values across all 1007 live webview fields:

| pageid | fields | note |
|---|---|---|
| 101435865704727 | 44 | worldbank FB page |
| 111108121363615 | 21 | worldbank FB page |
| 881943064995558 | 4 | worldbank FB page |
| 1855355231229529 | 1 | nandanmarkrao FB page |
| **1134338372** | 2 | **not in `credentials` at all** — `kenya_tvet_bl` (worldbank, created 2026-08-04) |
| `[object Object]` | 9 | static-analysis artifact, see Dirt |
| (absent) | 265 of 346 linksniffer fields | linksniffer posts `page: ""` |

## Stitch reachability — the one real WhatsApp exposure

The WhatsApp-served forms stitch (`{"type":"stitch","stitch":{"form":…}}`) into linksniffer
webview forms. 407 stitch edges across the two WA owners; BFS from each WhatsApp-served shortcode:

| start (served on WhatsApp) | reaches | linksniffer-webview forms reachable |
|---|---|---|
| `hpvincentivedouble` (worldbank) | 6 forms | **`hpvel`, `hpvfup`** |
| `hpvbl` (worldbank) | 18 forms | **`misinfogame`, `hpvendline`, `hpvel`, `hpvfollowup`, `hpvfup`** |
| `305` (either owner) | 0 | none |

All 16 reachable linksniffer webview fields are `keepMoving: true`, `wait: absent`,
`waitOnClick: false`, host `links.vlab.digital`, and hardcode `pageid: 101435865704727` or
`881943064995558`. Example (`hpvfup` / `vax_upload_link`, HPV Triple):

```json
{"type":"webview",
 "url":{"base":"links.vlab.digital",
        "params":{"url":"upenn.app.box.com/f/89624a6d37a7415a92c3851cdfe0c69a",
                  "id":"{{hidden:id}}","pageid":"101435865704727"}},
 "buttonText":"Upload Info","extensions":false,"keepMoving":true}
```

**Consequence, today, before §7.1:** a WhatsApp participant on `1265380589988964` who reaches
`hpvfup` and clicks gets a `linksniffer:click` stamped `page=101435865704727` — a *Messenger*
page belonging to the same user. The click is already routed to the wrong conversation
identity **irrespective of the platform param**. §7.1 does not create this; the hardcoded
`pageid` does. Because these fields are `keepMoving`, the conversation never blocks.

## Hang-risk inventory (deliverable 5 detail)

WA-owner fields with `wait.value.type === 'linksniffer:click'` — these are the only forms where a
misrouted click **hangs** the conversation. All still Messenger-only in practice.

| email | shortcode | survey_name | ref | host | hardcoded pageid |
|---|---|---|---|---|---|
| worldbank@vlab.digital | both | Kenya Girl Effect | wazzii_link | links.vlab.digital | 101435865704727 |
| worldbank@vlab.digital | bothswahili | Kenya Girl Effect / Girl Effect | wazzii_link | links.vlab.digital | 101435865704727 |
| worldbank@vlab.digital | girleffectboth | Girl Effect | wazzii_link | links.vlab.digital | 101435865704727 |
| worldbank@vlab.digital | wazzii | Kenya Girl Effect | wazzii_contraceptives | links.vlab.digital | 101435865704727 |
| worldbank@vlab.digital | wazziiswahili | Girl Effect / Kenya Girl Effect | wazzii_contraceptives | links.vlab.digital | 101435865704727 |
| worldbank@vlab.digital | girleffectwazzii | Girl Effect | wazzii_contraceptives | links.vlab.digital | 101435865704727 |
| worldbank@vlab.digital | kenya-tvet-scope | Kenya TVET Scoping | consent_adult, consent_minor | links.vlab.digital | 101435865704727 |
| worldbank@vlab.digital | kenya-tvet-test-url-enforcement | Kenya TVET Test URL Enforcement | consent_adult, consent_minor | links.vlab.digital | 101435865704727 / 111108121363615 |
| worldbank@vlab.digital | test_url_enforcement2 | Kenya TVET Test URL Enforcement | consent_adult, consent_minor | links.vlab.digital | 101435865704727 / 111108121363615 |
| nandanmarkrao@gmail.com | testlinksniff | Test Surveys | ad2bc602-… | links.vlab.digital | 1855355231229529 |
| nandanmarkrao@gmail.com | sniff | default | 97743912-… | gbvlinks-staging.nandan.cloud | (none) |

`wazzii` / `both` / `tuki` (Girl Effect) are the **most active linksniffer-wait surveys in
production** (243 / 224 / 197 participants, last activity 2026-08-17). If worldbank ever runs
Girl Effect on `1265380589988964`, these hang. That is the migration trigger, not §7.1.

## Dirt / allowlist hazards

**Malformed webview `pageid` in `surveys`:**
- `1134338372` (worldbank, `kenya_tvet_bl`, created 2026-08-04) — 10 digits, not a `credentials.key`.
  Also appears in `states.pageid` with 2 participants (last 2026-08-05). Real, current, and wrong.
- `[object Object]` × 9 fields (`mchatila@worldbank.org`, `dpinzonhernandez@worldbank.org`):
  descriptions write `"id": {{hidden:id}}` / `"pageid": {{hidden:pageid}}` **unquoted**, so YAML
  loads them as nested maps and `new URLSearchParams` would stringify them. These forms do run in
  production, so interpolation must land before promotion — **flagged as a static-analysis artifact,
  not measured as a live bug.** Still fragile authoring; the quoted form (`"{{hidden:id}}"`) is used
  everywhere else.
- No leading-apostrophe or URL-encoded `pageid` found in live webview URLs
  (`SELECT count(*) FROM surveys WHERE form LIKE '%pageid%''1%'` → **0**).
  A looser probe (`form LIKE '%pageid%25%' OR form LIKE '%device_id%'`) returns 218 but is
  false-positive-dominated by URL-encoded `url` params — **not a usable number.**

**New `states.pageid` dirt not yet in the docs** (rows whose `pageid` is not a
`facebook_page`/`whatsapp_business` credential key):

| pageid | participants | last | note |
|---|---|---|---|
| `1.07718E+14` | **74** | 2024-11-23 | Excel scientific notation — same page as the documented `'107718334922830` |
| `156222641066477` | 55 | 2026-06-22 | plausible page id, credential deleted? |
| `253917574462129` | 4 | 2024-03-02 | |
| `324090`, `456` | 3, 1 | 2024-09-19, 2026-08-09 | far too short |
| `1134338372` | 2 | 2026-08-05 | matches the bad webview pageid above |
| `105246245358509)` | 1 | 2022-10-26 | trailing paren |
| `'107718334922830` | 1 | 2024-10-08 | already documented |
| `111108121363615%26device_id%3D5b9385ab-…` | 1 | 2023-08-04 | already documented |
| 10× `5xxxxxxxxxxxxxxx` | 1 each | 2022-11-08 | 16-digit, single day — likely PSIDs |

**URLs that would break a strict scheme/allowlist check** — 3 string-form webview URLs lack a
parseable scheme:

| email | shortcode | ref | raw url |
|---|---|---|---|
| worldbank@vlab.digital | mentalitypod | vimeo_playlist | `www.youtube.com/watch?v=f6WW9g5hqLI&list=…` (no scheme) |
| nandanmarkrao@gmail.com | bebbobg2baseeng | download_bebbo_control | `" https://9meseca.bg/"` (**leading space**) |
| nandanmarkrao@gmail.com | bebbobg2basebul | download_bebbo_control | `" https://9meseca.bg/"` (**leading space**) |

**`p` param usage:** 43 fields, all `p=http`. **Zero** `tel:` / `mailto:` / `sms:` in live
surveys, contrary to what `documentation/platform-abstraction.md:493-496` implies is in use.

**`linksniffer` would 400:** 3 linksniffer-host fields author no `id` param
(`server.go:41-44` returns 400 without it). 265 of 346 author no `pageid`.

**`states.platform` backfill gap:** the overwhelming majority of `states` rows have
`platform IS NULL`; only rows touched since ~2026-08-05 carry `'messenger'`/`'whatsapp'`.
Any §7.1 canary that reads `states.platform` must treat NULL as "unknown", not "messenger".

## SQL — exact statements

All run as
`kubectl exec -n vprod gbv-cockroachdb-0 -- cockroach sql --insecure -d chatroach --format=table -e "<sql>"`.

### Credential census
```sql
SELECT entity, count(*) AS rows, count(DISTINCT key) AS keys, count(DISTINCT userid) AS users
FROM chatroach.credentials GROUP BY entity ORDER BY 2 DESC;

SELECT u.email, c.userid,
  count(*) FILTER (WHERE c.entity='facebook_page')     AS fb_pages,
  count(*) FILTER (WHERE c.entity='whatsapp_business') AS wa_accts
FROM credentials c JOIN users u ON u.id=c.userid
WHERE c.entity IN ('facebook_page','whatsapp_business')
GROUP BY 1,2 ORDER BY wa_accts DESC, fb_pages DESC;
```

### Deliverables 1 + 2 (survey counts by platform class)
```sql
WITH live AS (
  SELECT DISTINCT ON (userid, shortcode, survey_name)
         id, userid, shortcode, survey_name, created, form_json
  FROM surveys WHERE jsonb_typeof(form_json->'fields')='array'
  ORDER BY userid, shortcode, survey_name, created DESC
),
acct AS (
  SELECT userid, bool_or(entity='whatsapp_business') AS has_wa,
                 bool_or(entity='facebook_page')     AS has_fb
  FROM credentials WHERE entity IN ('facebook_page','whatsapp_business') GROUP BY userid
),
wv AS (
  SELECT l.id,
    bool_or(f->>'type'='webview')                                        AS literal_webview,
    bool_or(coalesce(f->'properties'->>'description','') ILIKE '%webview%') AS desc_webview
  FROM live l, jsonb_array_elements(l.form_json->'fields') f
  GROUP BY 1
)
SELECT CASE WHEN a.has_wa AND a.has_fb THEN 'both'
            WHEN a.has_wa THEN 'whatsapp_only'
            WHEN a.has_fb THEN 'messenger_only'
            ELSE 'no_messaging_account' END AS platform_class,
       count(*) AS live_surveys,
       count(*) FILTER (WHERE wv.literal_webview OR wv.desc_webview) AS with_webview,
       count(*) FILTER (WHERE wv.literal_webview)                    AS literal_type_webview,
       count(*) FILTER (WHERE wv.desc_webview)                       AS desc_promoted_webview
FROM live l JOIN wv ON wv.id=l.id LEFT JOIN acct a ON a.userid=l.userid
GROUP BY 1 ORDER BY 2 DESC;
```

### Deliverables 3, 4, 5 — field extract, then exact promotion in Node
SQL pre-filter (base64-wrapped so JSON survives the `kubectl exec` pipe):
```sql
WITH live AS (
  SELECT DISTINCT ON (userid, shortcode, survey_name)
         id, userid, shortcode, survey_name, created, form_json
  FROM surveys WHERE jsonb_typeof(form_json->'fields')='array'
  ORDER BY userid, shortcode, survey_name, created DESC
),
acct AS (
  SELECT userid, bool_or(entity='whatsapp_business') AS has_wa,
                 bool_or(entity='facebook_page')     AS has_fb
  FROM credentials WHERE entity IN ('facebook_page','whatsapp_business') GROUP BY userid
)
SELECT encode(convert_to(jsonb_agg(jsonb_build_object(
  'sid', l.id, 'email', u.email, 'shortcode', l.shortcode, 'survey_name', l.survey_name,
  'created', l.created, 'has_wa', coalesce(a.has_wa,false), 'has_fb', coalesce(a.has_fb,false),
  'ref', f->>'ref', 'ftype', f->>'type', 'desc', f->'properties'->>'description'))::string,
  'UTF8'), 'base64')
FROM live l
  JOIN LATERAL jsonb_array_elements(l.form_json->'fields') f ON true
  LEFT JOIN acct  a ON a.userid=l.userid
  LEFT JOIN users u ON u.id=l.userid
WHERE f->>'type'='webview' OR coalesce(f->'properties'->>'description','') ILIKE '%webview%';
```
Post-processing (`js-yaml` 3.14.2 from `replybot/node_modules`, mirroring
`form.js addCustomType` + `_cleanStrings` + `generic-translator.js makeUrl`) classified each
field on: effective `type==='webview'`, `host ∈ {links.vlab.digital, staging.links.vlab.digital,
gbvlinks.nandan.cloud, gbvlinks-staging.nandan.cloud}`, presence of `id`/`pageid`/`platform`/`p`
params (both the encoded query string and the raw object `params`), `keepMoving`, `wait`, and
`wait.value.type === 'linksniffer:click'`.

### 1b / 5b — actual WhatsApp usage
```sql
SELECT pageid, platform, count(*) AS participants,
       count(DISTINCT current_form) AS forms, max(updated) AS last_activity
FROM states WHERE pageid IN ('1203867182815254','1265380589988964')
GROUP BY 1,2 ORDER BY 3 DESC;

SELECT pageid, current_form, current_state, updated
FROM states WHERE pageid IN ('1203867182815254','1265380589988964') ORDER BY updated DESC;

-- 38 shortcodes carrying a WA-owner linksniffer webview
SELECT current_form AS shortcode, count(*) AS participants,
  count(*) FILTER (WHERE pageid IN ('1203867182815254','1265380589988964')) AS on_whatsapp,
  max(updated)::date AS last_activity, string_agg(DISTINCT pageid, ',') AS pageids
FROM states
WHERE current_form IN ('701','702','XXXXXXXX','XXX_','both','bothswahili','endline_eng',
  'endline_hin','endlineeng','endlineeng1','foobartest','girleffectboth','girleffecttuki',
  'girleffectwazzii','hpvel','hpvendline','hpvfollowup','hpvfup','kenya-tvet-scope',
  'kenya-tvet-test-url-enforcement','kenya_tvet_bl','mentalityendline','misinfogame','mldtesteng',
  'mldtestrou','mldtestrus','multilink','pledgecard','sniff','test_url_enforcement2',
  'testendline_eng','testendline_eng2','testendline_hin','testlinksniff','tuki','tukiswahili',
  'wazzii','wazziiswahili')
GROUP BY 1 ORDER BY 2 DESC;
```

### Webview count for the WhatsApp-served shortcodes
```sql
WITH live AS (
  SELECT DISTINCT ON (userid, shortcode, survey_name)
         id, userid, shortcode, survey_name, created, form_json
  FROM surveys WHERE jsonb_typeof(form_json->'fields')='array'
  ORDER BY userid, shortcode, survey_name, created DESC
)
SELECT u.email, l.shortcode, l.survey_name, l.created::date,
  (SELECT count(*) FROM jsonb_array_elements(l.form_json->'fields') f
   WHERE f->>'type'='webview'
      OR coalesce(f->'properties'->>'description','') ILIKE '%webview%') AS webview_fields,
  jsonb_array_length(l.form_json->'fields') AS total_fields
FROM live l JOIN users u ON u.id=l.userid
WHERE l.userid IN ('10383123-9fb1-429b-8312-447c1b54b17a','56c6bf37-39ab-420e-af4e-108735ea35c2')
  AND l.shortcode IN ('305','hpvbl','hpvincentivedouble')
ORDER BY 1,2,3;
```

### Deliverable 6
```sql
SELECT current_form, platform, pageid, count(*) AS participants, max(updated)::date AS last
FROM states
WHERE current_form IN ('hpvincentivedouble','hpvbl','305')
  AND pageid IN ('1855355231229529','1203867182815254','101435865704727',
                 '111108121363615','881943064995558','1265380589988964')
GROUP BY 1,2,3 ORDER BY 1,4 DESC;
```

### Stitch graph (BFS done in Node over the extract)
```sql
WITH live AS (
  SELECT DISTINCT ON (userid, shortcode, survey_name)
         id, userid, shortcode, survey_name, created, form_json
  FROM surveys WHERE jsonb_typeof(form_json->'fields')='array'
  ORDER BY userid, shortcode, survey_name, created DESC
)
SELECT encode(convert_to(jsonb_agg(jsonb_build_object(
  'email',u.email,'shortcode',l.shortcode,'survey_name',l.survey_name,
  'created',l.created,'desc',f->'properties'->>'description'))::string,'UTF8'),'base64')
FROM live l JOIN LATERAL jsonb_array_elements(l.form_json->'fields') f ON true
            JOIN users u ON u.id=l.userid
WHERE l.userid IN ('10383123-9fb1-429b-8312-447c1b54b17a','56c6bf37-39ab-420e-af4e-108735ea35c2')
  AND coalesce(f->'properties'->>'description','') ILIKE '%stitch%';
```

### Dirt
```sql
SELECT count(*) FROM surveys WHERE form LIKE '%pageid%''1%';   -- 0

SELECT s.pageid, count(*) AS participants, max(s.updated)::date AS last
FROM states s
WHERE NOT EXISTS (SELECT 1 FROM credentials c
                  WHERE c.key=s.pageid AND c.entity IN ('facebook_page','whatsapp_business'))
GROUP BY 1 ORDER BY 2 DESC LIMIT 25;
```

## Not measured / unobtainable

- **`isKnownLinksnifferHost`'s real allowlist** — the function does not exist in the working tree.
  Host set above is derived from ingress values + observed data, not from the code. If the §7.1
  implementation hardcodes only `links.vlab.digital`/`staging.links.vlab.digital`, 200 of 346
  production tracked links (`gbvlinks*.nandan.cloud`) will not be recognised as tracked.
- **Whether a campaign actively targets a WhatsApp account.** `campaign_confs` conf types are
  `opt`/`audience`/`creative`/`stratum`; no account/platform binding was found there, so
  "live" could not be narrowed by campaign targeting. `states` was used as the activity proxy.
- **Historical `linksniffer:click` events on WhatsApp.** `messages` is 101M rows; not scanned.
  The `states` evidence (4 WhatsApp conversations, 0 webview fields) makes it moot.
