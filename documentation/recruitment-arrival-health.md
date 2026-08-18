# Recruitment arrival health

**What it answers:** did the people a study paid for actually arrive, in the right
survey, through the channels the ad was meant to open?

Every other signal in `study-error-alerting.md` measures what happens to a
conversation once it exists. Nothing measured whether it started in the right
place — and that gap has a shape, a cost, and a precedent.

**Companion reading:**
- `documentation/study-error-alerting.md` — the error taxonomy this plugs into
- `documentation/referral-form-resolution.md` — how a ref becomes a survey
- `documentation/alerting.md` — the runbook the alerts link to

---

## 1. The failure this exists to catch

A recruitment ad carries a routing token. If that token is missing, mangled, or
aimed at a channel the ad never reaches, `getMetadata` falls through to
`FALLBACK_FORM` — production value `305` — and the respondent begins **a real
survey belonging to a real researcher**.

Nothing errors. The state machine is healthy, the error ratio is flat, the user
answers questions and reaches `END`. They look like a completion.

That ran for four days and 1,770 users in July 2026 (VIR-19). What eventually
noticed was a person reading response data. Every alert in `study-health.yaml`
was blind to it by construction — and the fallback form is *deliberately
excluded* from the error-ratio baselines there, because it is 100% error by
design and would drag the fleet baseline up.

## 2. Why the obvious alert does not work

"Alert when people land on the fallback form" fires permanently.

Measured on prod 2026-08-18: **form 305 receives ~1,771 arrivals per 24h.** Almost
all of them are legitimate — anyone who messages a page organically has no ref, so
`md.form` falls through and they land there by design. An alert on that count
would be silenced within a week, which is worse than no alert.

The signal has to separate "arrived with no ref" from "arrived from an ad and lost
its ref". Two mechanisms do that, and they cover different populations.

### 2.1 The ad-id gate — unambiguous, partial coverage

fly stamps `md.ad_id` only when the referral says the arrival came from an ad
(`adIdFromReferral`, `typewheels/utils.js`). So an arrival that is **both** on the
fallback form **and** carries an ad id is someone who demonstrably clicked an ad
and ended up in someone else's survey. There is no benign reading of that, which
is what makes it alertable at a threshold near zero.

**Its blind spot, stated plainly:** it only sees arrivals that carry an ad id.

| Platform | Ad-id coverage | Why |
|---|---|---|
| WhatsApp (click-to-WhatsApp) | effectively all | a CTWA referral accompanies the arrival by construction |
| Messenger | **~31%** | Meta sends the `messaging_referrals` webhook for only about a third of ad entrants |

Measured over 30 days to 2026-08-18: **2,475 of 7,983** Messenger ad entrants had a
resolvable ad id. The other 5,508 arrived through the welcome message's quick-reply
payload, which carries the dotted ref but no ad id — there is nothing to capture,
and no code change recovers it.

Two things are true at once here and they are easy to conflate:

- **Every ad-sourced referral that arrives carries an ad id.** Zero exceptions in
  2,475 measured arrivals.
- **A referral only arrives for about a third of Messenger ad entrants.**

So: a firing alert is proof of a misroute. A quiet one is not proof of its absence.

### 2.2 The encoded ref — full coverage, for studies that adopt it

The encoded recruitment ref (`r.<base64url>`, `decodeRecruitmentRef` in
`typewheels/utils.js`) closes that blind spot from the other side. It rides the
quick-reply payload and the WhatsApp autofill — carriers **every** entrant has,
because vlab authors them — rather than a webhook Meta may not send.

Because the encoded ref is the only carrier of the shortcode, a ref that will not
decode means fly does not know which survey the person wanted. It therefore throws
`RefDecodeError` (tag `REF_DECODE`) and the respondent lands in a **visible ERROR
state** rather than a wrong survey. That converts the silent failure into a counted
one, which is the whole point.

Legacy dotted refs are untouched and permanent. Every existing Messenger study
keeps `creative.X.form.Y` forever; the encoded form is opt-in per study.

## 3. What is exported

`survey_arrivals{shortcode, survey, researcher, platform, ad_id, page}` — the
`recruitment_health` collector in `devops/sql-exporter/templates/configmap.yaml`,
windows `1h` and `24h`.

A conversation counts as an arrival if the form it is currently on **started** in
the window (`states.form_start_time`), not if the user was merely active. That is
what makes it a recruitment signal rather than a traffic one.

Three questions, one metric:

| Question | Read |
|---|---|
| Is a study recruiting at all? | arrivals by `shortcode` |
| Landing in the right survey? | arrivals where `shortcode` is the fallback form |
| Through which channel? | the `platform` label |

The third is what makes a **multi-destination ad** observable. Such an ad opens
either Messenger or WhatsApp with Meta choosing per respondent, so the only way to
know both arms work is to watch arrivals split across platforms for one shortcode:

- an arm that never delivers → traffic on one platform, none on the other;
- an arm whose token does not survive → traffic on that platform landing on the
  fallback form, or `REF_DECODE` errors.

Neither is inferable from any other metric, and neither can be measured by asking
Meta.

### Cost and cardinality

`shortcode × platform × ad_id × page`, × 2 windows. Measured on prod 2026-08-18:
**45 groups over 24h ≈ 90 series**, on 4,546 arrivals.

The query is index-shaped deliberately — see the INDEX DISCIPLINE block at the top
of the configmap. `form_start_time` is a computed column in no index, so filtering
on it alone full-scans 1.1M rows (~7s). Pinning `current_state` and bounding
`updated` first reuses the existing `(current_state, updated)` spans, and the
`form_start_time` predicate then only refines rows already fetched. That is sound
and not merely cheap: `updated` is the last write and `form_start_time` the
conversation's start, so `form_start_time > t` always implies `updated > t`.

## 4. The alerts

Both live in `devops/alerts/templates/study-health.yaml`.

**`RecruitmentAdArrivalsInFallback`** — ad clickers who landed in the fallback
survey. Healthy value is zero. Threshold 2 sustained 30m, only so one hand-edited
WhatsApp prefill cannot page. Raising it means accepting that ad spend is
recruiting people into another researcher's survey — do not, without writing down
why.

**`RecruitmentRefDecodeErrors`** — a study's encoded refs will not decode. Healthy
value is zero; the small allowance exists solely for hand-edited WhatsApp prefills,
since on Messenger the ref is untamperable. **v1 with no measured background** — no
study uses the encoded format yet. Recalibrate after the first campaign rather than
trusting the numbers.

`REF_DECODE` is absent from every consumer's platform allow-list, so it tickets the
study rather than paging the platform on-call. That is correct: the artifact at
fault is one study's ad.

## 5. What this does not tell you

- **It cannot see a Messenger misroute with no ad id** — about two thirds of
  Messenger ad entrants, unless the study uses the encoded ref. This is the single
  most important caveat and the reason §2.2 exists.
- **It cannot distinguish an ad that stopped delivering from a study that was
  paused.** Both look like arrivals going to zero. That is a job for spend data,
  which lives in vlab.
- **It says nothing about whether an arrival was correctly *attributed*** to a
  stratum. `ad_id=present` means fly captured an id, not that vlab holds a mapping
  row for it. That join happens in vlab at analysis time.
