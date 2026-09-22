# W1 audit — do legacy bare-`pageId` webview URLs remain in live production surveys?

<!-- Search aliases: W1, legacy webview, hand-authored webview, bare pageId,
     pageId= hardcoded, moviehouse legacy URL, linksniffer legacy URL,
     phantom conversation, WAIT_EXTERNAL_EVENT moviehouse:play, hpvmedia,
     misinfogame, open question 4, platform-guess-expiry Q4. -->

**Written 2026-09-04. Measured on `vprod`, reads only.**

**Answer: NO. W1 is NOT closeable. Legacy bare-`pageId` webview URLs remain in
live production surveys, and the hazard has already fired twice more since the
2026-08-13 incident that motivated W1 — most recently on 2026-08-19, with the
resulting phantom `BLOCKED` conversation still in production today.**

This file settles open question 4 in `planning/platform-guess-expiry.md` §9,
which recorded W1 as **UNVERIFIED**. It does not modify that file.

---

## 0. Summary of the verdict

| | |
|---|---|
| Legacy hand-authored `webview` fields pointing at moviehouse/linksniffer | **802** across **131** current surveys |
| …of those, on a **LIVE** (reachable) host | **110 fields / 53 surveys** |
| …of those, carrying a **literal hardcoded account id** | **92** |
| …of those, that **`wait`** on the tracked event (hang, not degrade) | **49** |
| Legacy fields carrying **any** `platform` / `vlab_platform` param | **0 of 802** |
| Distinct hardcoded account ids on live hosts | 4 — **all `facebook_page`** |
| **WhatsApp conversations that reached an affected survey (90d)** | **2** |
| **Phantom `BLOCKED` conversations on a Messenger page, `platform='whatsapp'`** | **2** (2026-08-19, 2026-08-24) |

The single most important row: **`hpvmedia`**, the exact survey from the
2026-08-13 incident, is still live, still on the reachable moviehouse host, still
hardcoding `pageId=101435865704727` (a `facebook_page`), still carrying no
platform, and still `wait`ing on `moviehouse:play`. A WhatsApp participant
entered it on 2026-08-19 and is still stuck.

**Two claims in `platform-guess-expiry.md` §9 Q4 are wrong and made W1 look
smaller than it is.** See §6.

---

## 1. The pattern audited, and why it is the right one

W1 concerns a *hand-authored* `webview` field whose URL points at a first-party
tracking page (moviehouse or linksniffer) and supplies the conversation identity
as query params the researcher typed. Establishing the shape from source:

**A custom field type is YAML in the Typeform field's description**, not a JSON
`type` key. `replybot/lib/typewheels/form.js:361` (`addCustomType`) parses
`field.properties.description` as YAML and lifts `params.type` onto the field.
This is why grepping survey JSON for `"type":"webview"` finds nothing — the
audit must replay the YAML parse. `_cleanStrings`/`_removeMdLinks`
(`form.js:337-359`) then strips markdown links globally, and it must be replayed
too: without it, Typeform's auto-linkification corrupts the query string, which
is where production's junk `pageId`s came from (`form.js:327-333`).

**The URL has two authored forms.** `replybot/lib/generic-translator.js:137`
(`makeUrl`) accepts a plain string or `{base, protocol, params}`. Both are
rendered byte-identically, with no decoration — `generic-translator.js:327-333`:
*"Renders the researcher's URL and nothing else — no host matching, no identity,
no decoration."* So whatever the researcher typed is what the participant clicks.

**The legacy identity param names are named in source, on both readers:**

| component | canonical | legacy aliases | source |
|---|---|---|---|
| account | `vlab_account` | `account_id`, **`pageId`** | `moviehouse/src/identity.js:133` |
| account | `vlab_account` | `account_id`, **`pageid`** | `linksniffer/server.go:116` |
| platform | `vlab_platform` | `platform` | `identity.js:135`, `server.go:117` |
| user | `vlab_user` | `userId` / `id` | `identity.js:78`, `server.go:115` |

Note the casing split — moviehouse reads `pageId`, linksniffer reads `pageid` —
so an audit must match both, case-sensitively.

**Why "no platform" is the hazard, not merely "bare pageId".** Both readers
**assume `messenger`** when the platform param is absent:

- `moviehouse/src/identity.js:36` — `var ASSUMED_PLATFORM = 'messenger';`, applied
  at `:147`. The comment at `:112-123` is explicit that this is a borrowed
  assumption: *"It is assumed anyway because MESSENGER IS THE ONLY LIVE
  TRANSPORT… THE RESIDUAL IS REAL AND IS THE THING TO REVISIT: the moment
  WhatsApp carries production traffic, a legacy moviehouse URL clicked by a
  WhatsApp participant reproduces 2026-08-13 exactly."*
- `linksniffer/server.go:92-99` — same, logging `[LINKSNIFFER_PLATFORM_ASSUMED]`.

So the audited pattern is:

> a `webview`-typed field (YAML `type: webview`) whose `url` resolves to a
> **moviehouse or linksniffer host**, and whose query string carries **no**
> `vlab_platform` and no `platform`.

with the account param graded three ways, because they fail differently:

| account in URL | what happens on a WhatsApp conversation |
|---|---|
| **literal digits** (hardcoded page id) | worst. Event is addressed to a *different* account on the *wrong* transport → phantom conversation, real one hangs. This is 2026-08-13. |
| `{{hidden:pageid}}` (interpolated) | account correct, platform wrong → event lands on `state:messenger:<wa-account>:<user>`, a cache identity that is not the live conversation. |
| absent | account missing → hermes `[INCOMPLETE_CONVERSATION]`; degrades to an account-scoped replay rather than mis-routing. Least bad. |

`documentation/event-envelope.md` and `moviehouse/README.md` § "An absent platform
is omitted, never assumed" describe this taxonomy (that section is now stale —
see §6.3).

---

## 2. Method and exact queries

All queries are `kubectl exec -n vprod gbv-cockroachdb-0 -- ./cockroach sql
--insecure -d chatroach`. Reads only. Migration 26's REMOVAL GATE query was **not**
run.

### 2.1 Choosing the "live survey" definition — this matters

`surveys` is append-only: 5,341 rows, 1,256 distinct `(userid, shortcode,
survey_name)`, 1,151 distinct `(userid, shortcode)`.

`formcentral/db.go:76-87` (`getSurveyByParams`) is the authority on which version
a conversation is actually served:

```sql
WHERE s.userid=(SELECT userid FROM credentials WHERE key=$1 AND entity IN (...))
  AND s.shortcode=$2
  AND created<=$3
ORDER BY created DESC LIMIT 1
```

It keys on **`(userid, shortcode)`** — *not* `survey_name` — and takes the newest
version created at or before the conversation's start. So:

- The headline numbers below use `DISTINCT ON (userid, shortcode) ORDER BY created
  DESC` = **what a conversation starting today would be served**. 1,151 surveys.
- An earlier pass using `(userid, shortcode, survey_name)` gave 1,256 surveys /
  154 live-host fields. The difference is stale `survey_name` variants of the
  same shortcode, which formcentral would never serve. Reported here for
  reproducibility, not as the headline.

### 2.2 Extraction

The first attempt exported `surveys.form` as CSV and parsed it locally; **30 of
295 forms failed to parse** on the CSV round-trip (`Invalid \escape`), and the
casualties included **`hpvmedia`** — the incident survey. Do not audit this way.
The fix is to let CockroachDB do the JSON parsing via the computed `form_json`
column and export only the field descriptions:

```sql
WITH cur AS (
  SELECT DISTINCT ON (userid, shortcode) id, userid, shortcode, survey_name, created, form_json
  FROM surveys ORDER BY userid, shortcode, created DESC
)
SELECT c.id, c.userid, c.shortcode, c.survey_name, c.created,
       f->>'ref' AS ref, f->'properties'->>'description' AS descr
FROM cur c, jsonb_array_elements(c.form_json->'fields') AS f
WHERE f->'properties'->>'description' IS NOT NULL
  AND (f->'properties'->>'description' LIKE '%url%'
    OR f->'properties'->>'description' LIKE '%http%');
```

`form_json` is non-NULL for **all 1,256** live rows (`count(form_json) = 1256`),
so nothing is lost at this step. Each description was then YAML-parsed and
markdown-link-cleaned in Python, replaying `addCustomType` + `_cleanStrings`, and
each resulting `md.url` rendered through `makeUrl`'s two forms.

### 2.3 Host liveness — probed, not assumed

| host | role | HTTP, 2026-09-04 | verdict |
|---|---|---|---|
| `virtuallab-videos.netlify.app` | moviehouse, `MOVIEHOUSE_URL` (`devops/values/production.yaml:840`) | **200** | **LIVE** |
| `links.vlab.digital` | linksniffer, `LINKSNIFFER_URL` (`production.yaml:832`) | **400** (its own "lacking tracking id", `server.go:126`) | **LIVE** |
| `virtuallab-videos.netlify.com` | retired Netlify apex | 404 | dead |
| `gbvlinks.nandan.cloud` | retired linksniffer host | conn/TLS failure | dead |

A legacy URL on a dead host cannot produce a mis-addressed event, because the
page never loads. Those fields are already broken and are **latent**, not live.

### 2.4 Activity cross-reference

`states.current_form` holds a **shortcode**, not a formid — verified by sampling
(`vlpulseng`, `girleffectel`, …). A join on `surveys.formid` silently returns
zero for everything; do not use it.

Because a survey can sit mid-chain rather than last, the audit expands the whole
chain from `state_json->'forms'` and joins each element:

```sql
WITH ex AS (
  SELECT s.pageid, s.updated, f.form AS shortcode
  FROM states s, jsonb_array_elements_text(s.state_json->'forms') AS f(form)
)
SELECT ex.shortcode, COALESCE(c.entity,'(no credential)') AS account_entity,
       count(*) AS convos,
       count(*) FILTER (WHERE ex.updated > now() - INTERVAL '90 days') AS active_90d,
       count(*) FILTER (WHERE ex.updated > now() - INTERVAL '30 days') AS active_30d,
       max(ex.updated) AS last_seen
FROM ex LEFT JOIN credentials c
  ON c.key = ex.pageid AND c.entity IN ('facebook_page','whatsapp_business')
WHERE ex.shortcode IN (<the 53 affected shortcodes>)
GROUP BY 1,2 ORDER BY 4 DESC, 3 DESC;
```

---

## 3. Results

### 3.1 Corpus

| class | fields | current surveys |
|---|---|---|
| legacy `webview` → moviehouse/linksniffer | **802** | **131** |
| — on a **LIVE** host | **110** | **53** |
| — on a dead host (`.netlify.com`, `gbvlinks`) | 683 | — |
| — on a staging host | 9 | — |
| legacy `webview` → third-party (youtube, qualtrics, …) | 91 | — |
| **stamped** `moviehouse` field type | 26 | 5 |
| **stamped** `link_tracking` field type | 7 | 6 |

**Zero of the 802 legacy fields carry a `platform` or `vlab_platform` param.**
Not one. Every one of them is resolved by the assume-messenger branch at
`identity.js:147` / `server.go:93`.

Account param on the 110 live-host fields: **92 literal**, 16 absent, 2
interpolated (`flysmoke`, the smoke survey, which is correctly authored).

The four literal account ids, joined to `credentials`:

| literal in URL | `credentials.entity` | owner |
|---|---|---|
| `101435865704727` (68 fields) | `facebook_page` | worldbank@vlab.digital |
| `111108121363615` (21 fields) | `facebook_page` | worldbank@vlab.digital |
| `1855355231229529` (1 field) | `facebook_page` | nandanmarkrao@gmail.com |
| `1134338372` (2 fields) | **no credential row** | — junk: this is a **Vimeo video id** pasted into `pageid` (`kenya_tvet_bl`) |

**Every resolvable hardcoded account is a Messenger page.** There is no legacy
URL anywhere that names a WhatsApp account. That is the whole hazard: these URLs
assert Messenger twice over — once by the page id and once by omitting the
platform.

### 3.2 The two WhatsApp accounts in production

```sql
SELECT c.key, c.entity, u.email FROM credentials c LEFT JOIN users u ON u.id=c.userid
WHERE c.entity='whatsapp_business';
-- 1203867182815254 | whatsapp_business | nandanmarkrao@gmail.com
-- 1265380589988964 | whatsapp_business | worldbank@vlab.digital
```

`worldbank@vlab.digital` owns **both** WhatsApp account `1265380589988964` **and**
the Messenger pages `101435865704727` / `111108121363615` that its own surveys
hardcode. That single-owner overlap is what lets a WhatsApp conversation reach a
survey whose URLs name a Messenger page.

### 3.3 Per-survey findings, live hosts only

Sorted by hazard: WhatsApp traffic first, then Messenger volume. `wait` = fields
that block on the tracked event (these **hang**; the rest merely lose tracking).

| shortcode | owner | flds | wait | services | account in URL | FB 90d | **WA 90d** | last seen |
|---|---|---|---|---|---|---|---|---|
| **hpvmedia** | worldbank | 7 | 1 | moviehouse:7 | `101435865704727` | 63 | **1** | 2026-08-29 |
| **misinfogame** | worldbank + nandan | 2 | 0 | linksniffer:2 | `101435865704727` | 62 | **1** | 2026-08-31 |
| both | worldbank | 6 | 5 | moviehouse:4+linksniffer:2 | `101435865704727` | 1022 | 0 | 2026-09-04 |
| tuki | worldbank | 5 | 4 | moviehouse:4+linksniffer:1 | `101435865704727` | 1016 | 0 | 2026-09-04 |
| wazzii | worldbank | 3 | 1 | linksniffer:3 | `101435865704727` | 1012 | 0 | 2026-09-04 |
| mentalityendline | worldbank | 2 | 0 | linksniffer:2 | `111108121363615` | 365 | 0 | 2026-09-04 |
| hpvendline | worldbank | 1 | 0 | linksniffer:1 | `101435865704727` | 131 | 0 | 2026-09-02 |
| hpvel | worldbank | 1 | 0 | linksniffer:1 | `101435865704727` | 97 | 0 | 2026-08-29 |
| girleffecttuki | worldbank | 5 | 4 | moviehouse:4+linksniffer:1 | `101435865704727` | 79 | 0 | 2026-09-03 |
| girleffectwazzii | worldbank | 3 | 1 | linksniffer:3 | `101435865704727` | 76 | 0 | 2026-09-04 |
| girleffectboth | worldbank | 6 | 5 | moviehouse:4+linksniffer:2 | `101435865704727` | 75 | 0 | 2026-09-04 |
| wazziiswahili | worldbank | 3 | 1 | linksniffer:3 | `101435865704727` | 43 | 0 | 2026-09-04 |
| tukiswahili | worldbank | 5 | 4 | moviehouse:4+linksniffer:1 | `101435865704727` | 39 | 0 | 2026-09-04 |
| bothswahili | worldbank | 6 | 5 | moviehouse:4+linksniffer:2 | `101435865704727` | 34 | 0 | 2026-09-04 |
| kenya_tvet_bl | worldbank | 4 | 2 | moviehouse:2+linksniffer:2 | `101435865704727`, junk `1134338372` | 7 | 0 | 2026-08-06 |
| clmcpilot2baseline_l | curiouslearning | 1 | 0 | linksniffer:1 | `111108121363615` | 2 | 0 | 2026-08-28 |
| hpvfollowup | worldbank | 2 | 0 | linksniffer:2 | `101435865704727` | 2 | 0 | 2026-07-21 |
| clmcpilot2baseline | curiouslearning | 1 | 0 | linksniffer:1 | `111108121363615` | 1 | 0 | 2026-08-28 |
| clmcpilot2baseline_h | curiouslearning | 1 | 0 | linksniffer:1 | `111108121363615` | 1 | 0 | 2026-07-24 |
| flysmoke | nandan | 2 | 2 | moviehouse:1+linksniffer:1 | *interpolated* | 1 | 0 | 2026-07-13 |
| vaccgambia | dpinzonhernandez | 2 | 0 | linksniffer:2 | absent | 1 | 0 | 2026-08-26 |

**Dead below this line** — 32 further surveys with 0 conversations in 90 days:
`baseeng`, `clmc_test_new_assessment`, `clmcassessmenttest`,
`clmcpilot2baseline_h_TEST`, `clmcpilot2baseline_l_TEST`, `clmcpilot2baselineh`,
`clmcpilot2fup`, `clmcpilot2fup_h`, `clmcpilot2fup_h_TEST`, `clmcpilot2fup_l`,
`clmcpilot2fup_l_TEST`, `clmcpilotbase`, `clmcpilotfu`, `consent`, `consentest`,
**`hpvendlinewa`**, `hpvfup`, `iq2test`, `kenya-tvet-scope`,
`kenya-tvet-test-url-enforcement`, `laos2test`, `pledgecard`, `rolling`,
`test_url_enforcement`, `test_url_enforcement2`, `testing1`, `testing2`,
`testlinksniff`, `treatmentpodcast`, `vaccgambiatest`, `videotest`.

⚠️ **`hpvendlinewa` is a WhatsApp-named survey carrying `pageid=101435865704727`,
a Messenger page.** It has no traffic yet — created 2026-08-28. It is armed, not
fired. Same for `treatmentpodcast` and `pledgecard`, which sit in the **MENtality**
study whose `mentalitybaseline` was live on WhatsApp account `1265380589988964`
as recently as 2026-09-04 23:16.

### 3.4 The live hazard — it has already fired, twice, since 2026-08-13

Two WhatsApp conversations reached an affected survey within 90 days:

```sql
SELECT userid, pageid, current_state, current_form, platform, updated, state_json->'wait'
FROM states WHERE userid IN ('12679287515','15419799714');
```

| userid | pageid | entity | state | form | `platform` | updated |
|---|---|---|---|---|---|---|
| `12679287515` | `1265380589988964` | whatsapp_business | **`WAIT_EXTERNAL_EVENT`** | `hpvmedia` | whatsapp | 2026-08-19 13:58 |
| `12679287515` | **`101435865704727`** | facebook_page | **`BLOCKED`** | `hpvmedia` | whatsapp | 2026-08-19 18:01 |
| `15419799714` | `1265380589988964` | whatsapp_business | `ERROR` | `305` | whatsapp | 2026-08-16 18:34 |
| `15419799714` | `1203867182815254` | whatsapp_business | `QOUT` | `lacbo1es` | whatsapp | 2026-09-04 23:18 |

The first two rows are **the 2026-08-13 incident, reproduced on 2026-08-19**, and
still sitting in production 16 days later. The real WhatsApp conversation's wait
is:

```json
{"type": "external", "value": {"id": "1143993262", "type": "moviehouse:play"}}
```

Video `1143993262` is the same video, and `pageId=101435865704727` the same
hardcoded page, named in the 2026-08-13 trace in
`planning/moviehouse-conversation-identity.md` §2. Same field, same page id, new
participant.

A broader sweep for the phantom signature — a `states` row on a Messenger page
whose `md.platform` says whatsapp:

```sql
SELECT s.pageid, c.entity, s.current_state, count(*), min(s.updated), max(s.updated)
FROM states s JOIN credentials c ON c.key=s.pageid AND c.entity='facebook_page'
WHERE s.platform='whatsapp' GROUP BY 1,2,3;
-- 101435865704727 | facebook_page | BLOCKED | 2 | 2026-08-19 18:01 | 2026-08-24 18:35
```

Both are on `current_form = hpvmedia`. The second is participant `15126808320` —
**the original 2026-08-13 victim**, re-touched on 2026-08-24, meaning the phantom
is still being swept.

⚠️ **This count is a hard lower bound.** It can only see rows where
`state_json->'md'->>'platform'` is populated, and `platform-guess-expiry.md` §2
measured that column NULL for **95.7%** of `states`. The true phantom population
is unknown and is larger.

---

## 4. What this does and does not prove

**Proven:**

- Legacy bare-`pageId` webview URLs **remain** in live production surveys: 110
  fields across 53 current-version surveys on reachable hosts, 92 with a
  hardcoded Messenger page id, **none** with a platform.
- WhatsApp conversations **do** reach them: 2 in the last 90 days, on
  `hpvmedia` and `misinfogame`.
- The failure is **not hypothetical and not historical**: it recurred 2026-08-19,
  produced a phantom `BLOCKED` conversation on a Messenger page, and both the
  phantom and the hung real conversation are in production now.

**Not proven / out of this audit's reach:**

- **Older survey versions still in flight.** `getSurveyByParams` serves the newest
  version with `created <= <conversation start>`. A conversation that began before
  a survey was last edited is still being served the **older** row, which this
  audit does not read. The audit therefore **under-counts** exposure among
  long-running conversations. Direction of error is known; magnitude is not.
- **Whether any legacy URL is currently *deliverable* to a WhatsApp participant.**
  That depends on study/stitch routing this audit did not trace. `hpvmedia` and
  `misinfogame` demonstrably are (§3.4). Whether `hpvendlinewa`,
  `treatmentpodcast` or `pledgecard` are, is **UNVERIFIED**.
- **The true phantom-conversation count.** Lower bound 2; see the 95.7% NULL
  caveat above.
- **Surveys whose webview URL is built by a mechanism other than an `md.url` on a
  YAML-typed field.** The extraction filtered descriptions to those containing
  `url` or `http`; a field constructing a link some other way would be missed. No
  such mechanism was found in `generic-translator.js`, but the audit cannot
  exclude one.
- **`messages` history.** No attempt was made to count how many legacy URLs were
  actually *delivered* to participants. That would need the `messages` table and
  was deliberately not run.

---

## 5. Recommendation

**W1 is not closeable. It needs work, and it is more urgent than its position in
the plan implies** — it is not a pre-launch checklist item any more, it is an
active production defect with a 16-day-old stuck participant.

Ordering, cheapest first:

1. **Fix `hpvmedia` first, alone.** 7 fields, one owner, and it is the only survey
   with a confirmed WhatsApp casualty. Changing its 7 fields from hand-authored
   `webview` to `type: moviehouse` removes the hardcoded page id and makes
   replybot stamp `vlab_user`/`vlab_account`/`vlab_platform` from the live
   conversation. The researcher already knows how — the same owner authored
   `hpvmediawa` correctly with stamped types on 2026-08-28. This is a survey edit,
   not a code change.
2. **Then `misinfogame`** (2 fields, both owners' copies), then the
   MENtality pair (`treatmentpodcast`, `pledgecard`) and `hpvendlinewa`, which are
   armed but unfired on a WhatsApp-active study.
3. **Then the Messenger-only bulk** — `both`/`tuki`/`wazzii`/`girleffect*`, ~3,400
   active conversations. Latent today because the assumption happens to be right;
   they become live hazards the moment any of those studies adds a WhatsApp
   account, which requires no code change and no review.
4. **Do not rely on migration alone.** W1's own wording offers an alternative —
   *"**or** platform must come from a lookup rather than an assumption"* — and
   that is the durable half. `identity.js:120-123` already names the fix:
   `credentials.entity` maps account → transport. Neither moviehouse (a Netlify
   page) nor linksniffer has DB access to do that lookup today, so the resolution
   belongs on hermes' `/synthetic` ingress, where the account is known and
   `credentials` is reachable. Until that exists, every future hand-authored URL
   re-arms this.
5. **Clearing the two phantom `BLOCKED` rows is task D's problem, not this one.**
   Same ordering rule applies: fix the generator first or they come back.

**Also worth doing regardless:** the audit has no tripwire. A single Prometheus
counter on hermes for *"synthetic event whose asserted platform disagrees with
`credentials.entity` for its account"* would have caught 2026-08-13, 2026-08-19,
2026-08-24 and the Dean incident on day one. That is the same instrument
`platform-guess-expiry.md` §9 Q3 scopes for message-worker; the two should be
decided together rather than separately.

---

## 6. Corrections to existing docs

These are recorded here, not applied — the target files are being edited
concurrently.

### 6.1 `planning/platform-guess-expiry.md` §9 Q4 — the premise is wrong

Q4 states: *"39 production surveys created in the last 90 days use the
`moviehouse` field type and 9 use `link_tracking`… Those are the stamped field
types, which is fine."*

That figure comes from a substring match, and it does not mean what it says:

```sql
SELECT count(*) FILTER (WHERE form LIKE '%moviehouse%')             AS mentions,        -- 40
       count(*) FILTER (WHERE form LIKE '%type: moviehouse%')       AS looks_stamped,   --  0
       count(*) FILTER (WHERE form LIKE '%moviehouse:play%')        AS play_wait        -- 34
FROM surveys WHERE created > now() - INTERVAL '90 days';
```

**Zero** of those 40 rows carry a stamped `moviehouse` field. They mention
"moviehouse" because they are **legacy webviews that `wait` on
`moviehouse:play`** — precisely the population W1 is about. The 39/40 was
counting the hazard and reading it as the fix.

Note also that `LIKE '%type: moviehouse%'` is itself unreliable: it matches
`type: moviehouse:play` inside a `wait` block as a prefix. Only the YAML replay
distinguishes them. The real stamped adoption on current versions is **26
`moviehouse` fields / 5 surveys** and **7 `link_tracking` fields / 6 surveys** —
all authored between 2026-08-26 and 2026-09-04 (`flysmoke`, `hpvmediawa`,
`hpvfupwa`, `hpvmisinfowa`, `mentalitypod`, `mentalitypodnorms`,
`mentalitycontrol`). Migration has *started*, on the new WhatsApp-facing surveys
only, and covers ~4% of the corpus.

### 6.2 `moviehouse/README.md` § "Migration status" is stale but directionally right

It cites *"82 live surveys / 570 fields / 4 researchers"* from 2026-08-17. On the
current-version definition it is now **131 surveys / 802 fields**. The apparent
growth is mostly the definition (that pass counted moviehouse fields only; this
one counts moviehouse **and** linksniffer). Nothing has been migrated away from
the dead `.netlify.com` host: still **490 fields**, exactly as measured then.

### 6.3 `moviehouse/README.md` § "An absent platform is omitted, never assumed" is wrong

That section, and the table above it, state that moviehouse omits an absent
platform and that this is a deliberate divergence from linksniffer. The code
reversed this on 2026-08-22: `identity.js:36` defines `ASSUMED_PLATFORM =
'messenger'` and `:147` applies it, with a comment at `:98-100` explicitly
recording the reversal. The README's four-point justification for omitting now
describes behaviour that no longer exists — and it is the *assumption*, not the
omission, that makes W1 a live hazard. This section should be rewritten in the
documentation pass (task A), since `CLAUDE.md` directs agents to read
`documentation/` and `<app>/README.md` as ground truth before reading code.

---

## 7. Traps for the next person

- **`states.current_form` holds a shortcode, not a formid.** Joining it to
  `surveys.formid` returns zero rows for everything and looks like a clean bill of
  health. It is not.
- **Exporting `surveys.form` as CSV corrupts ~10% of forms.** 30 of 295 failed to
  re-parse, including `hpvmedia`. Use `form_json` and let CockroachDB parse.
- **`"type":"webview"` does not appear in survey JSON.** The type is YAML inside
  `properties.description`. Any grep-based audit finds nothing and concludes
  wrongly.
- **`LIKE '%type: moviehouse%'` matches `type: moviehouse:play`.** See §6.1.
- **moviehouse reads `pageId`, linksniffer reads `pageid`.** Case-sensitively.
  Match both.
- **A survey can sit mid-chain.** Filter on `state_json->'forms'` expanded, not on
  `current_form`, or you miss stitched surveys — which is exactly how the
  2026-08-13 victim was reached (`hpvbl` → `hpvmedia`).
- **Do not filter the WhatsApp population on `states.pageid IN (<wa keys>)`.** The
  phantom row hides on a *Facebook page id*. `planning/moviehouse-conversation-identity.md`
  §2 says this too, and it is still true.
- **`states.platform` is NULL for 95.7% of rows**, so every count filtered on it
  is a lower bound. Say so when you report one.
