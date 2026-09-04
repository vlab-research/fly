# Survey API for agents

A reference for a program — an AI agent, a script, a notebook — that holds a Fly
API token and wants to create and version surveys. It documents the wire
behaviour of the three survey endpoints, the MCP server that fronts the same
operations (§9), and the things that must already exist around them for a
created survey to actually run.

Everything below was read out of the code; the file that establishes each claim
is named next to it. Where a shape could not be determined from code, it is
marked **undetermined** rather than guessed — see "Known gaps" at the end.

## Authentication

Every request carries `Authorization: Bearer <token>` against
`https://<dashboard-server>/api/v1`. The token is an **API key**: an HS256 JWT
minted by the researcher, tied to their email, and usable on every endpoint in
this document and on the MCP endpoint in §9. The mechanism lives in
`dashboard-server/api/auth/auth.core.js`; the implementation detail is in
`dashboard-server/README.md` and only what an API consumer has to act on is
repeated here.

### Getting a key

```
POST /api/v1/auth/api-token
{ "name": "hpv-agent", "scopes": ["surveys:read", "surveys:write"] }

201 { "name": "hpv-agent", "token": "eyJ…", "scopes": [...], "expiresAt": "…" }
```

**The token is shown once and never stored**, so there is no endpoint that reads
it back — losing it means minting another. Names are unique, and uniqueness is
*global* rather than per user, so a name already taken by anyone is a `400`.
Newly minted keys **expire after 90 days**; keys minted before this scheme
existed never expire and are unaffected.

Minting itself needs the `auth:write` scope, and a key can only grant scopes it
already holds — so an agent's key normally cannot mint more keys, which is the
intent.

### Scopes

`<resource>:<action>`, where the action is `read`, `write` or `*`, plus the bare
scope `*` for everything. `write` implies `read` on the same resource. The
action a request needs comes from its method: `GET`/`HEAD`/`OPTIONS` are `read`,
everything else is `write`.

The resource is the first path segment: `surveys`, `responses`, `exports`,
`media`, `credentials` (which also covers `/facebook` and `/whatsapp`),
`templates` (`/message-templates`), `tickets`, `users`, `platform`, `auth`.
`responses` is deliberately separate from `surveys`, so a key can read study
structure without reading respondents' answers.

Three things will surprise you:

- **A key minted with no `scopes` is unrestricted**, not powerless. That is the
  backward-compatibility rule for keys that predate scoping, and it applies to
  new keys too.
- **`/typeform` counts as `surveys`, not as `credentials`.** A `surveys:read`
  key can `GET /api/v1/typeform/form` — the check the runbook in §8 tells you to
  make — because Typeform is where survey content is authored. It spends only
  your own stored `typeform_token`, which stays unreadable through
  `/credentials`.
- **`mcp` is not a scope.** `/mcp` enforces scopes per tool instead; see §9.

A refusal is `403` with `{"error": {"message", "required", "scopes"}}` — it names
the scope the request needed and the ones the key holds, so it is worth reading
rather than retrying.

### Revocation

```
DELETE /api/v1/auth/api-token?name=hpv-agent
```

By **name**, not by token: the name is the only handle that survives the token
being shown once, and a token in a URL is a token in the access log. Scoped to
the caller's email, so a globally-unique name is still only revocable by its
owner. `404` if there is no such key.

Revocation is a delete of the underlying credential row, and validity is
positive — a key is live only while its row is. There is a **30-second
in-process cache per replica**, so a revoked key can keep working for up to 30
seconds on replicas other than the one that served the DELETE. Treat revocation
as "dead within a minute", not "dead instantly".

---

## 1. The mental model

Three identifiers, and none of them mean what their names suggest.

| Field | What it is | Chosen by |
|---|---|---|
| `survey_name` | A **study**. A folder. The unit a researcher thinks in and the unit the dashboard groups by. Many shortcodes, many versions. | You, free text |
| `shortcode` | A **form within the study**, and the thing a participant types or clicks to enter it. Stable across versions. | You, free text |
| `id` | A **single immutable version** of that form: one UUID per `POST /surveys`. | The database |

A `survey_name` contains many `shortcode`s (`documentation/questions.md`'s
"stitch" moves a conversation from one to another). A `shortcode` accumulates
many `id`s over time. The dashboard's "v1, v2, v3" labels are not stored — the
client sorts a shortcode's rows by `created` and numbers them
(`dashboard-client/src/containers/Surveys/Surveys.js` `sortForms`).

### There is no update endpoint. `POST` is the update.

`dashboard-server/api/surveys/survey.routes.js` exposes exactly three routes —
`POST /`, `GET /`, `PUT /:surveyid/settings`. No `PUT /surveys/:id`, no
`PATCH`, no `DELETE`. The insert is
`INSERT INTO surveys(...) ON CONFLICT(id) DO NOTHING`
(`dashboard-server/queries/surveys/survey.queries.js` `create`), and `id`
defaults to `gen_random_uuid()`, so the conflict clause can never fire. The
table is append-only.

**"Updating a survey" means POSTing the same `survey_name` and `shortcode`
again.** You get a new row, a new `id`, a later `created`, and the previous row
stays exactly where it is. The dashboard does the same thing — its "new version"
link is just the create form pre-filled from an existing row
(`SurveyScreen.js`: `` `/surveys/create?from=${record.id}` ``).

### Version resolution is by timestamp, not by pointer

Nothing marks a row "current". When a participant sends a message, formcentral
resolves which version they are on:

```sql
-- formcentral/db.go, getSurveyByParams
WHERE s.userid = (SELECT userid FROM credentials
                  WHERE key = $1
                    AND entity IN ('facebook_page','whatsapp_business') LIMIT 1)
  AND s.shortcode = $2
  AND created <= $3          -- $3 = the event timestamp
ORDER BY created DESC LIMIT 1
```

Consequences that bite:

- **A new version only applies to conversations that start after it.** A
  participant already mid-form stays on the version whose `created` precedes
  their `form_start_time`. This is deliberate; the same rule is mirrored in
  `dashboard-server/queries/states/states.queries.js` (see its header comment)
  so that monitoring attributes a participant to the version they actually saw.
- **Resolution keys on `(userid, shortcode, created)` — `survey_name` is not in
  it.** If you reuse a shortcode under a second `survey_name` for the same
  owner, you have not created a separate form; you have created a newer version
  of the first one, and every live participant moves to it. The states query
  header calls this out as the reason it has to disambiguate by
  `survey_name` after the fact.
- **`created` is server-assigned** (`new Date()` in the controller) and cannot
  be back- or post-dated through the API.

### Deletion

There is no delete endpoint for surveys. The nearest thing is the kill switch,
`off_time` — see §5.

---

## 2. Content is authored in Typeform, not here

`POST /surveys` does not accept questions. It accepts a **`formid`**, and the
server fetches the content itself
(`dashboard-server/api/surveys/survey.controller.js` `postOne`):

```js
const cred  = await Credential.getOne({ email, entity: 'typeform_token',
                                        key: TypeformUtil.makeKey(email) });
const token = cred.details.access_token;
const form     = await TypeformUtil.TypeformForm(token, formid);      // GET /forms/:id
const messages = await TypeformUtil.TypeformMessages(token, formid);  // GET /forms/:id/messages
```

Both responses are stored **verbatim as strings** in `surveys.form` and
`surveys.messages` (`devops/migrations/01-init.sql`; `form_json` and
`messages_json` are `STORED` computed columns that just cast them to JSON).

So the loop for changing a question is: edit in Typeform → `POST /surveys`
again. The API cannot edit content, and — see §3 — it cannot read it back
either.

**Question semantics ride in the Typeform field *Description*, as YAML.**
Fly parses `properties.description`, and if the parsed object has a `type` key
it *replaces* the Typeform field type with it and merges the rest in as field
metadata (`addCustomType` in `replybot/lib/typewheels/form.js`). That is how
`webview`, `link_tracking`, `moviehouse`, `stitch`, `wait`, `notify` and the
payment types exist at all — none of them are Typeform types.

**Do not restate that vocabulary from this document.** The full catalogue of
field types, their YAML, the interpolation syntax, the seeds convention and the
silent-failure rules (invalid YAML is ignored with no error; quote anything
containing a URL) is `documentation/questions.md`. For creating the Typeform
form itself from a script, `scripts/typeform-create.py` is the stdlib-only CLI —
see `documentation/typeform-create.md`.

---

## 3. `POST /api/v1/surveys`

Creates one new survey version.

### Request

```json
{
  "survey_name": "HPV Nigeria Study",
  "shortcode": "hpvintro",
  "formid": "AbC12345",
  "title": "HPV Intro (Hausa)",
  "metadata": { "wave": "1", "arm": "treatment" },
  "translation_conf": {}
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `survey_name` | string | **yes** | Checked in the controller's early guard |
| `shortcode` | string | **yes** | Early guard, then `joi.string().required()` |
| `formid` | string | **yes** | Early guard, then `joi.string().alphanum().required()` — the Typeform form id |
| `title` | string | **effectively yes** | *Not* in the early guard, but `joi.string().required()` in `dashboard-server/utils/surveys/survey.util.js`. Omitting it is a `400` |
| `metadata` | object | **effectively yes** | joi treats it as optional, but the column is `JSONB NOT NULL`; see the note below |
| `translation_conf` | object | **effectively yes** | Dereferenced before it is validated; see the note below |

> **`title`, `metadata` and `translation_conf` are documented as optional
> nowhere and behave as required.** Only `survey_name`, `formid` and `shortcode`
> reach the explicit 400. The other three fail later and less legibly:
> `title` in the joi schema; `translation_conf` because `validateTranslation`
> reads `translation_conf.destination` before checking it exists, so `undefined`
> raises a `TypeError`; `metadata` because an omitted value is bound as SQL
> `NULL` into `metadata JSONB NOT NULL DEFAULT '{}'` and the default does not
> apply to an explicit `NULL`. **Send `{}` for both objects.** (The `metadata`
> case is inferred from `devops/migrations/01-init.sql` plus the parameter
> binding in `survey.queries.js`, not observed at runtime — see "Known gaps".)

### Response — `201`

`RETURNING *` on the `surveys` row, so you get back the whole record: `id`,
`created`, `formid`, `form`, `messages`, `shortcode`, `title`, `form_json`,
`messages_json`, `userid`, `has_followup`, `metadata`, `survey_name`,
`translation_conf`. **`form` and `form_json` are the entire Typeform document**,
so this response is large — often hundreds of kilobytes. Read `id` and discard
the rest.

### Failure modes

| Condition | Status | Body |
|---|---|---|
| `survey_name`, `formid` or `shortcode` missing | `400` | text, literally: `Missing shit!: formid: <formid>, shortcode: <shortcode>` |
| No `users` row for the token's email | `404` | `{"error": "User <email> does not exist!"}` |
| No `typeform_token` credential | `400` | text: `No Typeform account is connected to this Fly account. ...` |
| **Typeform has no such form**, or the token cannot read it | `400` | text: `Typeform has no form with id "<formid>" ...`, quoting Typeform's response |
| Typeform returns something unparseable | `400` | text: `Typeform returned an unreadable form for "<formid>": ...` |
| Typeform request throws (network, auth) | `400` | text: `Could not read Typeform form "<formid>": <message>` |
| formcentral rejects the translation mapping | `400` | text: `translation_conf is not valid: <formcentral's body>` |
| `title` missing, or a joi type violation (`formid` not alphanumeric, `shortcode` not a string) | `400` | text: `Config validation error: ...` |
| `translation_conf` sets **both** `self` and `destination` | `500` | thrown from `SurveyUtil.validateTranslation`, which is not a caller-safe failure and so is not echoed |

`translation_conf` and `metadata` may both be omitted; each defaults to `{}`.

> **A `400` from this endpoint carries a real message.** The create path
> distinguishes failures that are the caller's own — those are returned
> verbatim — from internal ones, which are logged and answered with an empty
> `500` body (`res.status(500).send(err)` serialises an `Error` to `{}`). So a
> `400` tells you what to fix; a `500` means read the server log.

> **Historical note.** Before VIR-37 this endpoint answered a missing
> `typeform_token`, an omitted `translation_conf`, an omitted `metadata` and any
> joi violation with an empty `500`, and — worse — answered a *wrong `formid`*
> with `201`, storing Typeform's 404 error body verbatim as the survey's form so
> that the survey only failed later, at conversation time. Both paths now run
> through one shared implementation, so an id Typeform does not know is a `400`
> at create time. Verifying with `GET /api/v1/typeform/form` first is still the
> cheapest way to be sure you have the form you meant.

---

## 4. `GET /api/v1/surveys`

Every survey version the caller owns — all `survey_name`s, all shortcodes, all
versions, flat, `ORDER BY created DESC`. There is no filtering, no pagination
and no single-survey `GET`.

```json
[
  {
    "created": "2026-08-14T10:22:31.184Z",
    "shortcode": "hpvintro",
    "id": "9a1f0c2e-....",
    "title": "HPV Intro (Hausa)",
    "survey_name": "HPV Nigeria Study",
    "metadata": { "wave": "1" },
    "translation_conf": {},
    "formid": "AbC12345",
    "off_time": null,
    "timeouts": null
  }
]
```

The projection is fixed in `survey.queries.js` `retrieve`: those ten columns,
with `off_time` and `timeouts` LEFT JOINed from `survey_settings`.

**`form` and `messages` are not returned.** There is no endpoint that gives you
back the stored survey content — to see the questions, read the form from
Typeform with `formid`. Group by `shortcode` and sort by `created` to reconstruct
version numbers.

---

## 5. `PUT /api/v1/surveys/:surveyid/settings`

Writes the `survey_settings` row for one **version** (`surveyid` is the `id`
from `POST`, not the shortcode).

### Request

```json
{
  "timeouts": [
    { "name": "reminder", "type": "relative", "value": "2 days" },
    { "name": "wave_2",   "type": "absolute", "value": "2026-09-01 12:00" }
  ],
  "off_time": "2026-09-30T00:00:00.000Z"
}
```

### Response — `200`

The `survey_settings` row: `{ timeouts, off_time, surveyid }`
(`devops/migrations/03-survey-settings.sql` and `05-off-time-in-survey.sql`;
the original `userid`/`shortcode` columns were dropped by 05).

### It is a replace, never a patch

```sql
INSERT INTO survey_settings(surveyid, timeouts, off_time) VALUES($1,$2,$3)
ON CONFLICT(surveyid) DO UPDATE SET timeouts = $2, off_time = $3
```

Both columns are always written. **A PUT carrying only `timeouts` sets
`off_time` to `NULL`, and a PUT carrying only `off_time` wipes the timeouts**
(pinned by `dashboard-server/queries/surveys/survey.test.js`, which asserts
`update.timeouts` is null after an `off_time`-only update). Always send both
fields, reading the current values from `GET /surveys` first.

Settings are **per version**. A new `POST` produces a new `id` with no
settings row at all — its timeouts and kill switch are empty until you PUT
them again. This is the single most common thing to forget when versioning.

### `timeouts`

An array of named durations. Verified against the consumer,
`dean/queries.go` (`Timeouts`), which unrolls it with
`json_array_elements(timeouts)->>'name' | 'type' | 'value'`:

| Key | Values |
|---|---|
| `name` | Free text. The join key — see below |
| `type` | `"relative"` or `"absolute"` |
| `value` | For `relative`, a Postgres interval string: `"20 minutes"`, `"5 hours"`, `"2 days"`. For `absolute`, a timestamp parsed by CockroachDB's `parse_timestamp`, e.g. `"2026-09-01 12:00"` |

`name` is what a Typeform field points at. A field whose Description contains

```yaml
type: wait
wait:
  type: timeout
  value:
    type: relative
    variable: reminder
```

fires when the setting named `reminder` elapses — dean joins
`settings.name = state_json->'wait'->'value'->>'variable'`
(`dean/queries.go`; fixtures in `dean/queries_test.go`). **A `variable` with no
matching setting on that version yields no timeout date and the conversation
waits forever**, because dean's `CASE` returns NULL and the row never satisfies
the window. This is the trap behind "settings do not carry to a new version".

A field can also inline its timeout instead of naming one — see the `wait`
examples in `documentation/questions.md`; then no settings entry is needed.

### `off_time` — the kill switch

A timestamp. `TIMESTAMPTZ` since migration 05; an ISO-8601 string is what the
dashboard sends (`new Date()` serialised by `JSON.stringify`).

Once set, formcentral returns it with the survey, replybot converts it to
`form.offTime` (`replybot/lib/typewheels/ourform.js`), and every inbound message
after that instant is answered with the Typeform custom message
`label.error.mustAccept` instead of the next question
(`replybot/lib/typewheels/machine.js` `_response` → `offResponse` /
`offMessage`). The conversation is not advanced and the participant is not
progressed.

Two honest caveats:

- **It kills a version, not a shortcode.** Killing v3 while v2 exists means
  formcentral still resolves conversations starting before v3's `created` to v2,
  which is alive. To stop a form entirely, kill every live version of that
  shortcode.
- **The dashboard presents this as irreversible** ("once you flip this switch,
  you can never go back") and disables the toggle, but that is UI-only. The API
  will happily write `off_time: null` back. Killed versions are also
  deliberately *kept* in monitoring queries so historical attribution stays
  correct (`states.queries.js` header).

### Ownership

The write is scoped to the caller in SQL: `Survey.update` is an
`INSERT … SELECT` gated on `surveys JOIN users WHERE users.email = $4`, so a
`surveyid` belonging to someone else selects no row, writes nothing, and comes
back **`404 {"error": "No such survey."}`**. A `surveyid` that is not a UUID gets
the same `404`.

It is `404` rather than `403` on purpose — "not yours" and "does not exist" are
deliberately the same answer, so the response never confirms someone else's
survey id. Do not read a `404` here as "the survey was deleted".

> Until VIR-37 this endpoint had **no** ownership check at all: any
> authenticated caller who knew a survey's UUID could overwrite its timeouts and
> `off_time`. Earlier revisions of this document and of
> `dashboard-server/README.md` described a `validateSurveyAccess` middleware
> that does not exist.

---

## 6. Credentials

`GET /api/v1/credentials` returns the caller's credentials, deduped to the
newest row per `(entity, key)`, as `{entity, key, details, created}`
(`dashboard-server/queries/credentials/credentials.queries.js` `get`).
`POST /api/v1/credentials` takes `{entity, key, details}` and always inserts —
it never updates. `PUT` updates in place and returns `404` if no
`(entity, key)` row matches.

Credentials are **append-mostly**: readers everywhere take the newest row per
`(entity, key)`, so re-POSTing an entity is how rotation works.

| `entity` | `key` | `details` | Verified in |
|---|---|---|---|
| `typeform_token` | `<email>:typeform` (`TypeformUtil.makeKey`) | The raw Typeform OAuth token response. Only `details.access_token` is ever read | `api/typeform/typeform.controller.js`, `api/surveys/survey.controller.js` |
| `facebook_page` | the Facebook **page id** | `{ id, name, access_token }` | `dashboard-client/.../FacebookPages.js` |
| `whatsapp_business` | the **phone_number_id** | `{ id, waba_id, access_token }`. `details.display_phone_number` is read by the dashboard if present, so it is written by some path | `dashboard-client/.../WhatsAppEmbedded.js`, `Accounts.js` |
| `reloadly` | your own label, referenced as `payment.key` in a field | `{ id, secret }` | `dashboard-client/.../Reloadly.js`, `dinersclub/reloadly.go` |
| `secrets` | the variable name used in `<< ... >>` templating | `{ value: "<string>" }` | `dashboard-client/.../Secrets.js`, `dinersclub/http_provider.go` |
| `api_token` | the token name | `{ name, jti, issued_at, expires_at }`, plus `scopes` when the key is scoped. Legacy rows hold only `{ name }`. **This row is the API key** — deleting it revokes the token | `dashboard-server/utils/auth/auth.util.js`, `api/auth/auth.core.js` |

`dingconnect` appears as a payment *provider* but deliberately has **no
credential entity of its own** — it reads `secrets` rows instead
(`dinersclub/dingconnect.go`). Do not invent one.

### The one invariant worth memorising

For `facebook_page` and `whatsapp_business`, **`key` is the platform account
id**, and that equality is load-bearing in at least four places:
`message-worker/tokenstore.go` resolves send tokens by it, `formcentral/db.go`
resolves a survey's owner by it, `dean/queries.go` joins on it, and media
handles are written against it. Writing anything else into `key` breaks survey
resolution — a participant messaging that account will not find any survey.

Messaging credentials also dual-write an account registry; see the "Credentials
and the messaging account registry" section of `dashboard-server/README.md`
before creating one programmatically.

---

## 7. `metadata` and `translation_conf`

Both are `JSONB NOT NULL DEFAULT '{}'` on `surveys`
(`devops/migrations/01-init.sql`), and neither has a schema beyond
`joi.object()`.

### `metadata` — open, but conventionally a flat string map

Nothing in the backend reads it. It is returned by `GET /surveys` and that is
its entire consumption path in this repo. Its one real use is in the dashboard,
which **spreads every metadata key onto the survey row and renders each distinct
key as a table column** (`Surveys.js`: `...f.metadata`; `SurveyScreen.js` builds
`metadataFields` from the union of keys). The create UI only lets a researcher
enter flat `key`/`value` string pairs and converts them with
`Object.fromEntries` (`CreateForm.js` `formatData`).

So: **a flat object of string keys to string values.** Nested objects and
arrays will store fine and will render as `[object Object]` in the dashboard.
Typical keys are study dimensions the researcher wants to sort versions by —
wave, arm, language, creative. There is no reserved key and no validation.

`surveys.metadata` is unrelated to `responses.metadata` and `states.md`, which
are different columns on different tables with their own consumers.

### `translation_conf` — two known keys, and only two

Machine-translation of one form's content into another form's structure.
The keys are read by `dashboard-server/utils/surveys/survey.util.js` and by
`formcentral/db.go` `getTranslationForms` / `server.go` `CreateTranslator`:

| Shape | Meaning |
|---|---|
| `{}` | No translation. The normal case |
| `{"self": true}` | The form translates against itself |
| `{"destination": "<survey id UUID>"}` | Translate into the structure of that survey **version id** (not a shortcode, not a survey_name) |

Setting both is a hard error (a 500, per §3 — it is thrown rather than reported). On create, the dashboard validates
the pair by POSTing `{form, ...translation_conf}` to formcentral's
`/translators`, which builds a by-`ref` field mapping between the two forms and
returns `404` if the destination id does not exist or `400` if the mapping
cannot be built; either becomes the dashboard's `400`.

Note the coupling that follows from `destination` being a version id: a
destination survey that later gets a new version does **not** update this
pointer. It keeps pointing at the row you named.

Beyond these keys the column is open, but nothing reads anything else.

---

## 8. End-to-end runbook

Everything that must exist before a survey actually answers a participant, in
order. Steps 1–3 are one-time per researcher; 4–6 are per survey.

1. **Connect Typeform.** A `typeform_token` credential must exist for your
   email under the key `<email>:typeform`. It is created by the OAuth callback
   `GET /api/v1/typeform/auth/:code`, which is a browser flow. Check it exists
   with `GET /api/v1/typeform/form` — a `401 Do not have Typeform Token for
   user` means it does not, and **no agent-only path creates it**; a human has
   to complete the OAuth flow in the dashboard once.

2. **Connect a messaging account.** A `facebook_page` or `whatsapp_business`
   credential whose `key` is the page id / phone_number_id. Without one,
   formcentral cannot resolve *any* survey for that account (§6) — the survey
   will exist and be unreachable. These are also browser flows
   (`documentation/whatsapp-onboarding.md`).

3. **Connect payment or secret credentials** only if your form uses them —
   `reloadly` for top-ups, `secrets` for `<< TOKEN >>` templating in generic
   HTTP payments. See the payment sections of `documentation/questions.md`.

4. **Build the Typeform form.** Question types and the YAML that goes in each
   field's Description: `documentation/questions.md`. Scripted creation:
   `scripts/typeform-create.py` (`documentation/typeform-create.md`). Keep the
   form id it returns. Confirm it is visible to your token with
   `GET /api/v1/typeform/form` — this is what protects you from the silent
   bad-`formid` 201 in §3.

5. **`POST /api/v1/surveys`** with `survey_name`, `shortcode`, `formid`,
   `title`, `metadata: {}`, `translation_conf: {}`. Keep the returned `id`.
   Multi-form studies: repeat with the same `survey_name` and a different
   `shortcode` per form, and link them with `stitch` fields
   (`documentation/questions.md`).

6. **`PUT /api/v1/surveys/<id>/settings`** if any field waits on a named
   timeout. Send both `timeouts` and `off_time` (§5). Re-do this after every
   new version — settings do not carry forward.

7. **Launch.** Participants enter by shortcode:
   `m.me/<page>?ref=form.<SHORTCODE>.<key>.<value>...` on Messenger, or the
   prefilled text `form.<SHORTCODE>` — typically
   `wa.me/<number>?text=form.<SHORTCODE>` — on WhatsApp. The trailing
   dot-separated pairs land in the participant's state metadata. Full rules,
   including WhatsApp's encoding hazards, are in
   `documentation/referral-form-resolution.md` and
   `documentation/whatsapp-onboarding.md`.

8. **Iterate.** To change a question: edit in Typeform, then repeat step 5 with
   the same `survey_name` and `shortcode`, then step 6. In-flight participants
   stay on the old version by design (§1).

---

## 9. MCP

`POST /api/v1/mcp` is a Model Context Protocol server over the same operations,
for an agent that speaks MCP rather than HTTP. It is not a different permission
system or a different account: same bearer token, same `req.user.email`, same
rows.

### Connecting

- **Transport**: MCP Streamable HTTP, **stateless**. One `POST` per JSON-RPC
  message, answered as a single `application/json` body — no SSE stream, no
  session id. `GET` and `DELETE` return `405`; a client that insists on opening
  a notification stream will not work.
- **Auth**: `Authorization: Bearer <api key>` on the POST, exactly as in "Authentication".
  There is no MCP-specific handshake, no OAuth flow and no separate credential.
- **Server identity**: `vlab-fly-surveys`, and its `instructions` carry the
  versioning and identifier model from §1 — worth reading, because an agent that
  has not internalised "POST is the update" will create duplicate studies trying
  to edit one.

Statelessness is why a session id is never issued: the server runs on several
replicas behind a load balancer, and a session would pin a client to one pod.

### Scopes

`/mcp` is exempt from the path-based scope check, because one POST reaches every
tool and the tool name is in the JSON-RPC body where a path-based rule cannot
see it. **The scope is enforced per tool instead** (`TOOL_SCOPES` in
`dashboard-server/api/mcp/mcp.tools.js`):

| Tool | Scope required |
|---|---|
| `list_surveys` | `surveys:read` |
| `create_typeform_form` | `surveys:write` |
| `create_survey` | `surveys:write` |
| `create_survey_version` | `surveys:write` |
| `update_survey_settings` | `surveys:write` |

So a `surveys:read` key connects fine and can list, and every write tool refuses.
A refusal arrives as an MCP **tool error** — a normal result with `isError: true`
naming the missing scope — not as an HTTP `403`, so read the result rather than
retrying. `create_typeform_form` is `surveys:write` because authoring the
questions is authoring the survey.

An unscoped key (see "Authentication") can call everything.

### The five tools

Full argument schemas are advertised by `tools/list` and defined in
`dashboard-server/api/mcp/mcp.core.js`; what follows is what they do and where
they differ from the REST endpoints above.

**`list_surveys(survey_name?)`** — the same rows as `GET /surveys` (§4) but
nested **study → form → versions** instead of flat, with a computed `version`
number per row and the current version broken out as `current`. `off_time` and
`timeouts` come along, so this is also how you read settings before merging them.
Call it first: `create_survey_version` needs an exact `survey_name`, and
`update_survey_settings` needs a version `id`.

**`create_typeform_form({title, fields, hidden?, thankyou_screens?, workspace_id?})`**
— authors a form in the researcher's own Typeform account and returns a
`formid`. This has **no REST equivalent**; it is the one Typeform write in the
codebase. It registers nothing with Fly — follow it with `create_survey`.

Each field is `{type, ref, title, description?, choices?, properties?,
validations?}`. Two conveniences that are project convention rather than
Typeform behaviour:

- `choices: ["Yes","No"]` appends lettered options to the title and makes the
  actual Typeform choices `A`/`B`, because a participant in a chat window types
  a letter, not a sentence. Maximum 13. Pass `properties.choices` yourself to
  opt out.
- `description` is the Typeform Description box, which is where every rich Fly
  type is authored as YAML (§2). It is the most important argument and the tool's
  own schema describes the vocabulary; `documentation/questions.md` is the full
  catalogue.

A hidden field named `seed_N` is how surveys randomise participants into arms.

**`create_survey({formid, survey_name, shortcode, title, metadata?, translation_conf?})`**
— `POST /surveys` (§3) with the sharp edges filed off: `metadata` and
`translation_conf` genuinely default to `{}` here, and a Typeform id that does
not resolve is refused with a message instead of being stored as the survey's
content (the REST endpoint's silent `201`, §3). It **refuses if `survey_name`
already exists** for you, because a second row under an existing name is a new
version, not a new study.

**`create_survey_version({survey_name, shortcode?, formid?, title?, metadata?, translation_conf?})`**
— the closest thing to an update. Everything but `survey_name` is inherited from
the current version, so "I edited the form in Typeform, publish it" is a
one-argument call. `shortcode` is required only when the study holds more than
one form, and passing a shortcode that does not already exist is **refused** —
a new shortcode is a new form that no participant link points at, not a new
version. The result names the row it replaces and reminds you that settings did
not carry over.

**`update_survey_settings({surveyid, timeouts?, off_time?})`** — `PUT
/surveys/:surveyid/settings` (§5) with one deliberate difference: it **reads
before it writes and merges**, so passing only `timeouts` does not wipe
`off_time`. Pass an explicit `null` to clear a field; `timeouts` still replaces
the whole list rather than appending. `surveyid` is a version `id` from
`list_surveys` and must be yours — otherwise the tool says so by name rather
than returning a bare 404.

### Failure

Every failure is a tool error (`isError: true`) with a sentence a model can act
on, never a thrown exception or a transport error, because a dead turn teaches
an agent nothing. Argument validation runs against the same JSON Schema that was
advertised in `tools/list`, so a schema violation is reported per field. The one
opaque case is an unexpected internal error, which is logged server-side and
reported generically.

---

## 10. Known gaps

Marked here rather than guessed at.

- **API keys and internal service JWTs share one signing secret**
  (`AUTH0_DASHBOARD_SECRET`, also deployed to replybot and hermes). This is why
  the verifier cannot require `exp` and why an absent scopes claim has to mean
  unrestricted. Splitting the secret was deliberately deferred — see
  `dashboard-server/README.md`.
- **`whatsapp_business.details.display_phone_number`** is read by
  `Accounts.js` but is not written by the embedded-signup path in
  `WhatsAppEmbedded.js`. Some other path writes it; that path was not
  identified. Treat the field as optional.
- **`metadata` beyond "flat string map"** — there is no schema, no validator and
  no backend reader, so any claim stronger than "the dashboard renders keys as
  columns" would be invention. Nested values are permitted by the column and
  unsupported by the only consumer.
- **`translation_conf` beyond `self` / `destination`** — no other key is read
  anywhere in this repo. Whether unknown keys are used operationally is
  undetermined.
- **`timeouts[].value` for `absolute`** is passed to CockroachDB's
  `parse_timestamp`; the exact set of accepted formats is that function's, not
  ours. `"2026-09-01 12:00"` is verified by `dean/queries_test.go`; other
  formats are undetermined.
- **The 500-with-empty-body behaviour** means an agent cannot distinguish the
  no-Typeform-token case from the missing-`title` case from the response alone.
  There is no error-code vocabulary on these endpoints; the controller carries a
  `TODO: create unified error handler` to that effect.
