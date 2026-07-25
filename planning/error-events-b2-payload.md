# B2 — the real `machine_report` payload in `messages`

**Status:** resolved from code (first-hand verified). No prod data was available
(the 5432 port-forward is dead), but every claim below is traced to source.
Supersedes an earlier draft of this file that was wrong in two material ways
(see §7).

---

## 1. The envelope — `event.value`, NOT `payload`

Three hops build what lands in `messages.content`:

1. **replybot** (`replybot/lib/index.js:14-28`) posts to botserver `/synthetic`:
   ```js
   { user: report.user, page: report.page,
     event: { type: 'machine_report', value: report } }
   ```
2. **message-worker** (`message-worker/worker.go:358`) posts the same shape via
   `botparty.NewExternalEvent(userID, accountID, "machine_report", &rawValue)`
   (`worker_test.go:215-219` confirms `.Page` / `.Event.Value`).
3. **botserver** (`botserver/server/handlers.js:70,80`) wraps and produces to
   Kafka, keyed by user:
   ```js
   const message = { ...body, source: 'synthetic', timestamp: Date.now() }
   producer.produce(eventTopic, null, data, message.user)
   ```

So `messages.content` is:

```json
{
  "user":  "<userid>",
  "page":  "<account_id>",
  "event": { "type": "machine_report", "value": { ...the report... } },
  "source": "synthetic",
  "timestamp": 1721678401234
}
```

> **Trap:** `machine.js:293` reads `nxt.payload`. That is the *in-machine*
> parsed representation produced by `parseEvent`, **not** the on-disk shape.
> Any SQL written against `content->'payload'` matches zero rows.

## 2. Not every `machine_report` is an error

`index.js:70` publishes whenever `report.publish` is true, and the **success**
path (`transition.js:167-176`) and the **RESET** path (`transition.js:140-148`)
both return `publish: true` with no `error` key. So the normal, high-volume
case is a *non-error* `machine_report` in `messages`.

(No infinite loop: the republished report re-enters the machine, hits
`output.action === 'NONE'`, and returns `publish: false` — `transition.js:130-138`.)

**The error filter is therefore mandatory, not cosmetic:**

```sql
WHERE content::JSONB->'event'->>'type' = 'machine_report'
  AND content::JSONB->'event'->'value'->'error' IS NOT NULL
```

## 3. What actually reaches `messages`

| Tag | Site | `publish` | Reaches `messages`? | has `page` | has `newState` |
|---|---|---|---|---|---|
| `CORRUPTED_MESSAGE` | `transition.js:114`, `:120` | `true` | ✅ | ❌ **no** | ❌ no |
| `STATE_TRANSITION` | `transition.js:151-157` | **`false`** | ❌ **never** | — | — |
| `STATE_ACTIONS` | `transition.js:184-191` | `true` | ✅ | ✅ | ✅ |
| `FORM_NOT_FOUND` | `transition.js:179-190` (`MachineIOError.tag`, `details.status`=404) | `true` | ✅ | ✅ | ✅ |
| `FB` | `message-worker/worker.go:327-347` | n/a | ✅ | ✅ | ❌ **no** |
| `STATE_ACTIONS` (worker fallback) | `worker.go:328` | n/a | ✅ | ✅ | ❌ no |

**`STATE_TRANSITION` never lands.** `publish: false` is deliberate, set in
commit `cb87b858` ("dont publish report in state_transition error") and carried
forward ever since. These errors are logged to stdout only — they never enter
`messages`, never reach the state machine, and so can never appear in an
`errors` projection. `documentation/error-events.md §1` lists
`STATE_TRANSITION` as a producer feeding the log; **that is incorrect** and the
doc needs fixing.

## 4. Column source map

`messages` columns are only `id, content, userid, timestamp, hsh`
(`devops/migrations/01-init.sql:17-27`) — everything else is JSON extraction.

| errors column | source path | always present? |
|---|---|---|
| `userid` | `messages.userid` (Kafka key) | ✅ |
| `account_id` | `content->>'page'` | ❌ **NULL for `CORRUPTED_MESSAGE`** — that report has no `page` (`transition.js:114,120`) |
| `timestamp` (occurrence) | `content->'event'->'value'->>'timestamp'` | ✅ |
| `tag` | `…->'value'->'error'->>'tag'` | ✅ |
| `message` | `…->'value'->'error'->>'message'` | ✅ |
| `code` | `…->'value'->'error'->>'code'` (FB: HTTP status; FORM_NOT_FOUND: `status` 404) | ❌ only FB / FORM_NOT_FOUND |
| `stack` | `…->'value'->'error'->>'stack'` | ❌ replybot only (Go side sends none) |
| `form` | `…->'value'->'newState'->'forms'->>-1` | ❌ **NULL for every `FB` and `CORRUPTED_MESSAGE`** |
| `platform` | `…->'value'->'newState'->'md'->>'platform'` | ❌ **NULL for every `FB`**; also NULL on pre-WhatsApp states (`COALESCE(...,'messenger')`, per `21-states-platform.sql:8-9`) |

`form` mirrors `states.current_form = state_json->'forms'->>-1`
(`01-init.sql:119`).

### 4.1 The blocking problem: FB errors have no form

`FB` is the delivery-failure tag — the highest-volume error class and the one
the alerts care most about — and its report carries **only**
`{error:{tag,message,code}, user, page, timestamp}` (`worker.go:320-347`).
No `newState`, so no `form` and no `platform`.

The cause is structural: `SendMessageCommand`
(`message-worker/types/command.go:17-27`) has `Platform` and
`PlatformAccountID` but **no form/survey field**, because
`transition.js buildCommands(messages, handoff, user, page, platform)`
(`transition.js:76-104`) never puts one in the command. message-worker cannot
attribute the error to a survey because it was never told which survey it was
sending for.

Today this is masked: the FB report is fed back through the machine, sets
`states.error` on the user's row, and the alerts read `states.current_form`.
Attribution happens **via the state**, not via the event. A pure
event-projection loses it.

- `platform` is a cheap fix — `cmd.Platform` is already in hand at
  `worker.go:327`, just not serialized into `MachineReportValue`.
- `form` requires threading a form/shortcode through the command envelope
  (replybot `buildCommands` → `SendMessageCommand` → `reportError`).

**This is the open decision for B1/B3** — see §7.

## 5. Identity / idempotency

`hsh INT AS (fnv64a(content)) STORED NOT NULL`, `PRIMARY KEY (hsh, userid)`
(`01-init.sql:22-23`) — computed server-side by CockroachDB, and the existing
sink relies on it: `scribble/message.go:35` does
`ON CONFLICT(hsh, userid) DO NOTHING`.

Reuse exactly that for `errors`: carry `(hsh, userid)` as the projection's
identity so replay/backfill is idempotent. Retry re-fails are genuinely
*different* events (different message/code/timestamp → different `hsh`) and so
correctly produce separate rows — that is the flow signal, not a dedup bug.

## 6. Verified SQL

```sql
-- every error occurrence in the log
SELECT
  m.userid,
  m.hsh,
  m.content::JSONB->>'page'                                        AS account_id,
  m.content::JSONB->'event'->'value'->'newState'->'forms'->>-1     AS form,
  m.content::JSONB->'event'->'value'->'newState'->'md'->>'platform' AS platform,
  to_timestamp(((m.content::JSONB->'event'->'value'->>'timestamp')::INT8)/1000) AS occurred_at,
  m.content::JSONB->'event'->'value'->'error'->>'tag'     AS tag,
  m.content::JSONB->'event'->'value'->'error'->>'code'    AS code,
  m.content::JSONB->'event'->'value'->'error'->>'message' AS message,
  m.content::JSONB->'event'->'value'->'error'->>'stack'   AS stack
FROM chatroach.messages m
WHERE m.content::JSONB->'event'->>'type' = 'machine_report'
  AND m.content::JSONB->'event'->'value'->'error' IS NOT NULL;

-- distribution by tag (run this first on prod to size the problem)
SELECT content::JSONB->'event'->'value'->'error'->>'tag' AS tag, count(*)
FROM chatroach.messages
WHERE content::JSONB->'event'->>'type' = 'machine_report'
  AND content::JSONB->'event'->'value'->'error' IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;
```

## 7. Corrections to the earlier draft of this file

1. **All SQL used `content->'payload'->…`** — matches nothing. The on-disk key
   is `content->'event'->'value'`. Root cause: `machine.js:293` reads
   `nxt.payload`, which is the post-`parseEvent` in-memory shape.
2. **"All `machine_report` events are error reports"** — false; the success and
   RESET paths publish error-free reports (§2).
3. It also listed `STATE_TRANSITION` as merely "unresolved"; it is resolved —
   `publish:false`, never in `messages` (§3), and it under-reported that `FB`
   (not just CORRUPTED_MESSAGE) has no `form`/`platform` (§4.1).

## 8. Still needs prod data

Not blocking the design, but sizes the trade-off — run once a port-forward is
back (`kubectl port-forward` must be run by the user; the Bash sandbox blocks
it):

- the tag-distribution query in §6 — **what fraction of errors are `FB`?** That
  is exactly the fraction that loses form attribution.
- how many error reports lack `page` (CORRUPTED_MESSAGE volume).
- volume of non-error `machine_report` rows, to size the backfill scan.
