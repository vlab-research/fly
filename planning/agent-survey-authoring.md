# Agent survey authoring: inline forms, a validator, a simulator

**Status:** proposed 2026-09-06. Nothing implemented. Linear: VIR-48.
**Context:** `documentation/agent-api.md` (the REST surface and the five MCP
tools), `documentation/questions.md` (the field vocabulary),
`dashboard-server/api/mcp/mcp.core.js` (tool definitions),
`replybot/lib/typewheels/form.js` (the logic evaluator),
`replybot/lib/typewheels/machine.js` (the pure state machine).
**Prompted by:** the LAC Healthy Diets build, 2026-09-01 to 2026-09-06. The
concrete failures are in §2; every one of them is a tooling gap, not a study
mistake.

---

## 1. The model in one paragraph

An agent building a survey should produce two artefacts: the form JSON, and a
set of **scenarios** that describe what a respondent who enters a given way and
answers a given way should experience. Fly validates the JSON against its own
contract, runs the scenarios through the real state machine, and publishes the
JSON verbatim. The agent never needs to understand replybot. It needs the field
vocabulary, the logic contract, a validator whose errors name refs, and a
simulator whose failures are diffs against a trace. Typeform is not in that
loop: we do not care about validating it and are moving away from it.

There is no Python SDK in this model. Emitting JSON is the easy part; what an
agent lacks is the contract, a way to check the result, and a way to see what
is live. Those three are the SDK.

## 2. What went wrong this week, and why it is tooling

The LAC study is the first to script its logic rather than click it together in
the Typeform editor. It needed ~600 lines of logic injection, ~1900 lines of row
building feeding an xlsx whose only consumer is `upload-typeform`, and an
offline checker that lived in a scratch directory. Each incident below traces
to logic and Fly-owned metadata living outside the tooling.

| incident | root cause | what would have caught it |
|---|---|---|
| `upload-typeform --update` rejected three forms with `UNKNOWN_FIELD_REFERENCE` | the uploader carries a form's existing logic forward; removed refs were still named | a validator run before any API call |
| translations had to be re-uploaded in a specific order | `--translation --update` copies logic and hidden from the English form as it stands | logic as an input, not a side effect |
| Bolivia's first real Messenger respondents were all turned away by the arrival gate (`ad_id == ""` → sorry) | `ad_id` is only present on Messenger for OPEN_THREAD referrals; most ad entrants come via the quick-reply payload, which is our own object (`vlab/adopt/adopt/marketing.py`, `quick_replies` comment). This fact lived in two code comments and no doc | a simulator run with `platform: messenger, ad_id: absent`; a doc listing Fly-owned metadata per platform |
| could not confirm what Fly stored for a version, twice | `GET /surveys` omits `form`; there is no per-version read | read-back |

## 3. What exists

- **MCP server** (`dashboard-server/api/mcp/`): `list_surveys`,
  `create_typeform_form`, `create_survey`, `create_survey_version`,
  `update_survey_settings`. Tool descriptions point at
  `documentation/questions.md` rather than restating it. This is the right
  pattern and the rest of this plan extends it.
- **`POST /surveys`** takes a `formid`, fetches the form and messages from
  Typeform with the researcher's stored token, and stores both verbatim
  (`survey.controller.js` `postOne` → `registerSurveyVersion`). Typeform is in
  the critical path only because of this fetch.
- **The evaluator** (`form.js`): `getNextField` → `jump` walks a field's
  `actions` in order, first true condition wins, fall-through is the next
  field. `getCondition` supports `always`, `and`, `or`, `equal`/`is`,
  `not_equal`/`is_not`, `greater_than`, `lower_than`, `greater_equal_than`,
  `lower_equal_than`, `contains`, `not_contains`. Operands are `constant`,
  `choice` (resolved to the label through the paired `field`), `field`
  (last answer) and `hidden` (metadata; unset resolves to `""`). Non-string
  ops pass through `castValue`. None of this is documented outside the code.
- **The machine** (`machine.js`): `getState(log)` is a pure reduce over
  events; `exec`/`apply`/`act` are pure given a `ctx` carrying the form. Form
  fetching lives in `ourform.js` and `transition.js`. The tests already drive
  the machine with synthesized raw events. **The simulator already exists; it
  has no front door.**
- **Custom types** ride in `properties.description` as YAML and are promoted
  by `addCustomType`. `documentation/questions.md` is the catalogue.

## 4. The plan

Ordered so that each step is useful on its own and none blocks the next.

### 4.1 Inline form ingestion and read-back

`POST /surveys` accepts `form` and `messages` inline as an alternative to
`formid`. Same table, same verbatim storage, same append-only versioning;
`formid` becomes optional and the Typeform fetch is only taken when `form` is
absent. `GET /surveys/:id` (or `?include=form`) returns the stored `form` and
`messages` for one version. The MCP gains `publish_survey_version` (inline)
and `get_survey_version`.

This is the one change that removes Typeform from the critical path. The JSON
you published is the JSON that is live, so the update and translation gotchas
in §2 disappear rather than getting fixed.

### 4.2 Validator

A pure function over a form (or a set of forms that stitch to each other),
returning a list of `{ref, rule, message}`. Rules, all against Fly's contract
and none against Typeform's:

- refs unique; every logic block names an existing ref; every jump target is
  an existing field or thank-you screen; no two logic blocks on one ref
- every `hidden:` operand and `{{hidden:...}}` interpolation is declared (or
  is a Fly-owned key, see §5)
- every `choice` operand resolves in its paired field
- every description parses as YAML when it looks like YAML, and the promoted
  type is one the machine knows (`addCustomType` silently ignores parse
  failures today; the validator makes that loud)
- custom-type shape: `wait` has a matching external event id, `payment`
  carries `provider`/`details`, `stitch` names a shortcode that resolves in
  the supplied set, the field after a stitch is a question (payments are only
  extracted on RESPOND)
- platform limits as static checks: quick-reply and list caps, button title
  length, WhatsApp list size
- translation rule: a translated form has the same refs and the same choice
  counts as its source

Exposed as an MCP tool `validate_form` and as a CLI. Run implicitly by
`publish_survey_version`; refuse to publish on errors.

### 4.3 Simulator

A scenario is:

```yaml
entry:  { platform: messenger, ad_id: absent, ref: "form.lacbo1es", seed_4: 2 }
script:
  - answer: 1                       # consent
  - answer: 1990
  - external: { type: payment:dingconnect, id: p1_send, success: false }
  - answer: "+59171234567"
expect:
  path: [consent, q1_birth_year, ..., pay_1_phone, p1_send, pay_1_fail, pay_1_phone]
  actions: [{ type: payment, id: p1_send }, ...]
  ends: thankyou_default
```

The runner synthesizes the raw events the normalizer would produce for that
entry and script, feeds them through `getState`/`exec`/`act` with the supplied
forms in `ctx`, and returns a **trace**: per step, the field ref, the rendered
text after interpolation, the action taken, the state entered. `expect` is
diffed against the trace, so a failure reads
`after consent on messenger: expected q1_birth_year, got sorry_click_ad`.

Two consequences worth designing for:

- **Scenarios persist** in the study repo and rerun on every publish. They are
  the study's tests.
- **The trace is the review artefact.** A client reads what a Bolivian
  respondent on WhatsApp who fails the payment once sees, as a transcript,
  instead of walking the survey on a phone.

Exposed as `simulate_form` (MCP) and a CLI that takes a scenario file.

Boundaries, stated so the tool is trusted for what it covers: it simulates
Fly, not the platforms; payment and timeout outcomes are injected events, not
real ones (a funded test still matters for the provider side); rendering caps
are the validator's job.

### 4.4 Documentation

Next to `questions.md`, so the MCP descriptions can point at them:

- **`documentation/logic.md`**: the evaluator contract from §3, with the
  house patterns as worked forms: consent and opt-out, seed randomisation, the
  payment loop (phone → one send → fail returns to phone → ok exits), stitch.
- **`documentation/metadata.md`**: every key Fly writes into `md`
  (`form`, `pageid`, `platform`, `startTime`, `seed_N`, `ad_id`, `vt`, ref
  pairs), when each is present per platform, and which are fly-owned and
  cannot be injected from a ref. Cite the adopt measurement for Messenger
  quick replies. This is the doc that would have prevented the Bolivia gate.

### 4.5 A native form schema (later)

Once 4.1 to 4.3 are in use, the YAML-in-description hack has no reason to
exist: a payment or a stitch should be a field with a real `type` and real
keys. A converter from the Typeform-shaped form is trivial because the machine
already reads custom types off the merged field. Old surveys run through the
converter; new ones are authored natively; the validator's errors get cleaner.
Not before the first three; changing the format is its own project with a
migration attached.

## 5. Where the code goes

The validator and simulator must run the same `form.js`, `machine.js`,
`utils.js`, `waiting.js` and `generic-validator.js` that replybot runs, or they
drift. dashboard-server hosts the MCP server, replybot owns the code. The
options:

1. Extract `replybot/lib/typewheels` (plus the validator and translator it
   imports) into a workspace package both services depend on. Cleanest;
   touches replybot's imports and release lineage.
2. dashboard-server depends on `../replybot` as a file dependency. Cheapest;
   couples deploys.

Recommendation: option 1, done as the first PR of 4.2 and kept mechanical
(move files, fix imports, replybot's test suite unchanged and green). The
scenario runner then lives in that package with a thin MCP/CLI wrapper each.

## 6. What a study repo becomes

A spec: forms as JSON (or a compact YAML the CLI expands), a scenarios file,
and whatever is genuinely study-specific (LAC's region cascade, incentive
table). `build_xlsx.py`, `upload-typeform` and the logic injector are not
needed once 4.1 exists. The generic pieces of the LAC injector (choice ref by
position with label check, dangling-jump detection, retrying PUT) are the
seed of 4.2, not study code.

## 7. Acceptance

- An agent with only `documentation/agent-api.md`, `questions.md`, `logic.md`
  and `metadata.md` can author, validate, simulate and publish a survey with
  a payment loop and a stitch without reading replybot.
- The LAC Bolivia base form plus a scenario `platform: messenger, ad_id:
  absent` fails against the 2026-09-05 logic and passes against the 2026-09-06
  logic.
- `get_survey_version` returns byte-identical `form` to what was published.
- replybot's test suite is unchanged by the package extraction.

## 8. Open questions

- Scenario file format: YAML as sketched, or JSON only. YAML reads better for
  the review use; JSON is what the MCP tool takes either way.
- How the simulator models `dean` timeouts: as injected synthetic events
  (faithful for logic, not for wall clock) is the proposal.
- Whether `publish_survey_version` should refuse on validator *warnings* or
  only errors.
- Messages (`surveys.messages`): inline as part of the form spec, or a
  separate argument mirroring today's two-table storage.
