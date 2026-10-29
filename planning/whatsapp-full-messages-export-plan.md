# WhatsApp in the Full Messages export (VIR-114)

Status: **steps 0–4 and 6 done** on `nandan/vir-114-full-messages-export-include-whatsapp-conversations-both`; step 5 (deploy) is next. Linear: VIR-114 (follows from VIR-112).

Decisions made while reviewing this plan (2026-10-29): bot text comes from the echo (option A), not from `machine_report` commands; forward-only, no historical backfill; the exporter parses each row once (`parse_event`) rather than classifying and extracting separately; a failed send is the new `send_failed` type.

## Problem

`classify_event` (`exporter/exporter/exporter.py:46`) has branches for `source: "messenger"` and
`source: "synthetic"` only. Every WhatsApp row, the participant's and the bot's, comes out as
`unknown`. That type is in no event group, so the row is dropped. A mixed-platform survey exports
only its Messenger users. WhatsApp is about 90% of live conversations.

Separately, the WhatsApp `bot_echo` that message-worker publishes carries no text, so the bot's side
would export empty even once it is classified.

## What exploration found (beyond the ticket)

1. **The branch can't be lifted as is.** On `feature/synthetic-echo`, `message-worker/echo.go`
   defines `BotEcho` / `NewBotEcho` with `source, account_id, from, type, metadata, text,
   timestamp`. Since then `main` has moved the echo to `BuildWhatsAppEcho` in
   `message-worker/envelope.go`. That version also stamps `platform` and `phone_number_id`. The
   envelope guard (`kafka.go` → `guardEnvelope`) requires `platform`, and the `messages` backfill
   reads `phone_number_id`. Lifting `echo.go` would drop both. Lift only `EchoText` and its tests,
   and add a `Text` field to `WhatsAppEcho`.
2. **replybot already has the authoritative WhatsApp mapping.** `categorizeWhatsAppEvent`
   (`replybot/lib/event-normalizer.js:358`) maps every inbound shape, including the cases the
   ticket doesn't list: `voice`, `reaction`, a CTWA `referral`, and `status: failed` as a send
   failure (not a watermark). The exporter should mirror its order and decisions, so the export
   and the state machine agree on what a row *was*.
3. **The historical fallback is real.** replybot posts each `machine.run` report to botserver's
   `/synthetic` as `{event: {type: "machine_report", value: report}}`
   (`replybot/lib/index.js:13`). On success, `report.commands[]` holds every `send_message` with
   `message.{type, text | question_text | caption, metadata}` (`transition.js:76`). The echo's
   `metadata` is the same `cmd.Message.Metadata` object (`BuildWhatsAppEcho`), so the two can be
   joined.
4. **Doc drift:**
   - `exporter/README.md` claims `full_messages` "covers all message sources (Messenger,
     WhatsApp, synthetic)". That is false today.
   - `documentation/full-messages-export.md` has an uncommitted edit that states the gap. But its
     table directly above still describes `bot_echo` matching as if it were deployed.

## Principles applied

- **Functional core.** Classification, content extraction and the historical join are all pure
  functions of parsed JSON. The only IO change is none: the query is unchanged.
- **Read-only and additive.** The exporter change only reads. The message-worker change adds one
  field to an event whose consumers ignore unknown fields (replybot reads only `metadata`; Hermes
  and scribble pass bodies through).
- **Independent, reversible pieces.** Each one ships and rolls back on its own. The Messenger
  `is_echo` swap stays on `feature/synthetic-echo`, untouched.
- **No silent loss.** WhatsApp shapes we don't recognise classify as `unknown_whatsapp`, the same
  as `unknown_messenger`, not `unknown`. They are counted in the export's `filtered` stat, so a new
  Meta shape shows up in logs rather than vanishing without trace.

## Plan

### Step 0: Documentation corrections (separate commit, before code)

- `exporter/README.md`: correct the "covers all message sources" sentence.
- `documentation/full-messages-export.md`: reconcile the table with the gap paragraph. That file
  has an uncommitted edit in the working tree, so finish or commit that edit first.

### Step 1: Exporter, classify WhatsApp (pieces 1 and 2)

Branch: `nandan/vir-114-full-messages-export-include-whatsapp-conversations-both` from `main`, in a
worktree (`../fly-vir-114`).

`exporter/exporter/exporter.py`:

- `classify_event`: check `msg.get("type") == "bot_echo"` → `echo` **before** the per-source
  dispatch. Our own envelope is platform-agnostic. Lift this and its tests from the branch.
- Add `source == "whatsapp"` → `_classify_whatsapp(msg)`, in the same order as
  `categorizeWhatsAppEvent`:

  | WhatsApp row | type | content |
  |---|---|---|
  | has `referral` (CTWA) | `referral` | `referral.ref`, else `text.body` (the autofill token) |
  | `status == "failed"` | **`send_failed`** (new, in `system`) | `errors[0].code`: `errors[0].title` |
  | `status` in sent/delivered/read | `watermark` | the status |
  | `type: text` | `text` | `text.body` |
  | `type: interactive` (`button_reply`/`list_reply`) | `quick_reply` | reply `title` (the label the machine validates against) |
  | `type: button` (template quick reply) | `quick_reply` | `button.text` |
  | image, video, audio, voice, document, sticker | `media` | the type (`voice` → `audio`), as the Messenger branch does |
  | `type: reaction` | `reaction` | `reaction.emoji` |
  | anything else | `unknown_whatsapp` | |

  A bare-text `form.<code>` entry token stays `text`. It is what the participant typed, and the
  export has no other place to show it.
- `extract_content` is currently Messenger-shaped for the user types. Make it source-aware: the
  WhatsApp helper returns `(type, content)` together, so the two can't drift apart.
- `get_direction`: add `send_failed` → `system` (the existing default). No other change is needed,
  because every user-facing WhatsApp type maps onto an existing type.
- `EVENT_GROUPS["system"]` gains `send_failed`. No dashboard change is needed: groups expand on the
  exporter side.

### Step 2: (dropped) Historical bot text

Decided 2026-10-29: forward-only. WhatsApp echoes sent before step 3 deploys export as `bot` rows with empty content. The text is recoverable from `machine_report` commands if this is ever wanted (see finding 3).

### Step 3: message-worker, put the text on the echo (piece 3)

- `message-worker/envelope.go`: add `Text string \`json:"text"\`` to `WhatsAppEcho`. Set it from a
  pure `EchoText(cmd.Message)`, lifted from the branch's `echo.go`, together with its table tests.
  Captionless media → `""`, and options are not included. These match the branch's documented
  reasoning.
- `envelope_test.go`: the byte-for-byte shape assertion gains `text`. The envelope-guard tests must
  stay green unchanged. That is the check that `account_id`, `platform` and `phone_number_id`
  survived.
- `message-worker/README.md` and `documentation/event-envelope.md` (the echo shape) gain the
  field.

### Step 4: Tests

- **Exporter unit tests** (`tests/test_full_messages_export.py`): one test per WhatsApp shape,
  using **real payloads** (see Questions), and `bot_echo` with and without `text`. 
- **Mixed survey** (done as a unit test of `_iter_messages`, not a DB integration test: the
  query does not depend on the source, so a database adds nothing). One Messenger user and one
  WhatsApp user each export `user` and `bot` rows. This is the VIR-112 regression test.
- message-worker: `go test ./...`. Exporter: `pytest exporter/`, plus the integration run against
  `make -C ../devops test-db`.

### Step 5: Deploy (IaC only)

The two ship independently. The exporter alone already restores the participant's side and an
(empty-content) bot row per send.

1. Exporter: tag, bump the image in `devops/values/staging.yaml`, `helm upgrade`. Run a staging
   full-messages export of a WhatsApp survey and check it, then do the same for
   `devops/values/production.yaml`.
2. message-worker: the same cycle. Then verify that a new `bot_echo` row in `messages` has `text`,
   and that `RESPONDING → QOUT` progression on WhatsApp is unchanged (it reads only `metadata`).

### Step 6: Close-out docs

- `documentation/full-messages-export.md`: replace the gap paragraph with the WhatsApp mapping
  table and the `send_failed` type, and note that pre-deploy WhatsApp echoes have no text. Remove the wrong
  claim about a `whatsapp` branch on `feature/synthetic-echo`.
- `planning/synthetic-echo-migration.md`: mark steps 1 (text only, WhatsApp only) and 5 as shipped
  separately under VIR-114. That branch should drop its copies when it is rebased.
- Re-run VIR-112's MENtality export as acceptance.

## Out of scope

- Messenger `is_echo` → synthetic echo (`planning/synthetic-echo-migration.md`).
- Instagram inbound (`translator_instagram.go` exists, and those rows will also be `unknown`). This
  is worth its own ticket.
- Platform resolution, Dean, `states.platform`: nothing here reads or writes them
  (`planning/platform-guess-expiry.md`).
- Exporting question options. Neither the echo nor `is_echo` text includes them. Adding them would
  be a new `event_detail` convention.

## Questions

1. **Real payloads.** The fixtures should come from `messages`. Reading vprod from this session was
   blocked. Needed: one row of each WhatsApp shape, plus one `machine_report` row and the
   `bot_echo` row it led to for the same user (to confirm the metadata join and timestamp order).
2. **`send_failed` as a new type, or fold it into `platform_response`?** The plan proposes the new
   type: the shape differs, and it keeps the synthetic type's meaning narrow.
