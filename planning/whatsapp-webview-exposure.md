# WhatsApp × webview/linksniffer exposure — production measurement

**Measured against `vprod`, read-only, 2026-08-17. Last full pass 2026-08-20**, which cut the
SQL appendix and the per-deliverable working — this is now the findings only. Git history has
the statements if you need to re-run them.

**Why it existed:** it gated the state-cache re-key and the deletion of the
`state.md.platform` fallback in `replybot/lib/typewheels/transition.js`. **That gate is
passed and the work is built** (`planning/conversation-identity.md` §3.2). What survives here
is the exposure picture, which still informs the rollout.

---

## Headline

| # | Question | Answer |
|---|---|---|
| 1 | Live surveys on WhatsApp-capable accounts containing a webview field | **84** (2 researchers) |
| 1b | …ever served to a participant on a WhatsApp account | **0** |
| 2 | Same count, Messenger-only accounts | **96** (+23 on accounts with no messaging credential) |
| 3 | Of the 84, pointing at a linksniffer host | **49** surveys / 224 fields |
| 4 | Of those 49, already authoring a `platform` param | **0** — and 0 of 1007 webview fields repo-wide |
| 5 | Of the 84, `wait` on `linksniffer:click` (conversation **hangs** if misrouted) | **13** surveys / 16 fields |
| 5b | …of those 13, ever served on WhatsApp | **0** |
| 6 | Shortcodes served on both a Messenger and a WhatsApp account | **3** (`305`, `hpvbl`, `hpvincentivedouble`) — **none contains a webview field** |

**The direct intersection is empty.** "Runs on WhatsApp" ∩ "has a hand-authored tracked link"
had no members at measurement time. WhatsApp production traffic was **4 conversations total**
across both accounts, all 2026-08-13..17 (smoke/pilot).

Method: "live" = `DISTINCT ON (userid, shortcode, survey_name) ORDER BY created DESC`. No live
field carries a literal `"type":"webview"`, so detection replays `addCustomType` +
`_cleanStrings` in Node over `js-yaml@3.14.2` and classifies both the string and object `url`
forms — 1024 candidates → **1007 effective webview fields / 203 surveys**.

---

## The one real exposure is indirect, via stitch

WhatsApp-served forms stitch (`{"type":"stitch","stitch":{"form":…}}`) into linksniffer webview
forms. 407 stitch edges across the two WA owners; BFS from each WhatsApp-served shortcode:

| start (served on WhatsApp) | reaches | linksniffer-webview forms reachable |
|---|---|---|
| `hpvincentivedouble` (worldbank) | 6 forms | `hpvel`, `hpvfup` |
| `hpvbl` (worldbank) | 18 forms | `misinfogame`, `hpvendline`, `hpvel`, `hpvfollowup`, `hpvfup` |
| `305` (either owner) | 0 | none |

All 16 reachable fields are `keepMoving: true`, `wait: absent`, host `links.vlab.digital`, and
hardcode `pageid: 101435865704727` or `881943064995558`.

**What that means:** a WhatsApp participant on `1265380589988964` who reaches `hpvfup` and clicks
gets a `linksniffer:click` stamped `page=101435865704727` — a **Messenger** page belonging to the
same researcher. The click is routed to the wrong conversation identity *irrespective of the
platform param*. The re-key did not create this; **the hardcoded `pageid` does.** Because those
fields are `keepMoving`, the conversation never blocks — the cost is lost click analytics, not a
hang.

---

## What still matters for the rollout

- **Nothing here blocks the deploy.** The direct intersection was empty and the indirect one is
  `keepMoving`, so no conversation hangs either way.
- **Legacy hand-authored links do not fix themselves.** `link_tracking` and `moviehouse` field
  types now have replybot build the URL (`planning/moviehouse-conversation-identity.md`), which
  removes this class going forward. The 224 fields counted above keep their hardcoded `pageid`
  until their surveys are re-authored.
- **0 of 1007 webview fields author a `platform` param.** Any design that expected researchers
  to supply one was never going to work; that is part of why replybot owns the URL now.
- **These counts are a snapshot from 2026-08-17.** WhatsApp usage was 4 conversations then. If
  WhatsApp has since gone into real use, re-measure before relying on "the intersection is
  empty" — and see the filtering note in `planning/moviehouse-conversation-identity.md` §2, since
  a misrouted row hides under a Facebook page id.
