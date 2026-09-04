'use strict';

/*
 * The MCP server's functional core.
 *
 * Everything in this file is a pure function or a data literal: no database, no
 * network, no clock, no `process.env`. Anything time-dependent takes `now` as a
 * parameter. The tool *descriptions* live here too, because for an MCP server
 * the descriptions are not documentation about the product — they ARE the
 * product surface, and they deserve to be tested and diffed like code.
 *
 * The imperative shell is `mcp.service.js` (database + Typeform IO),
 * `mcp.typeform.js` (the one Typeform call that has no home in utils/ yet) and
 * `mcp.routes.js` (transport).
 */

// ---------------------------------------------------------------------------
// The one genuinely surprising thing about this API, written once and reused in
// every description that needs it. An agent that has not read this will create
// duplicate studies trying to "edit" a survey.
// ---------------------------------------------------------------------------

const VERSIONING_NOTE = [
  'APPEND-ONLY VERSIONING. Fly surveys are immutable. There is no update',
  'endpoint and nothing is ever edited in place. "Updating a survey" means',
  'inserting a NEW row with the same survey_name and the same shortcode and a',
  'newer `created` timestamp — that is what create_survey_version does.',
  'Which version a participant sees is resolved at runtime by timestamp: the',
  'newest row whose `created` is at or before the moment that participant',
  'started the form. So participants already mid-conversation keep the version',
  'they started on, and only new participants get the new one. Publishing a fix',
  'is therefore safe, and it is also why a live conversation can never be',
  'retroactively fixed.',
].join(' ');

const IDENTIFIER_NOTE = [
  'IDENTIFIERS. `survey_name` names a study and groups one or more forms.',
  '`shortcode` names ONE form inside that study; it is what participant links',
  'and `stitch` targets reference, and it is the key versions are grouped under,',
  'so it must stay stable across versions. `id` is the UUID of one immutable',
  'version row — survey settings attach to that id, not to the survey_name.',
  '`formid` is the Typeform form whose content was imported into that row.',
].join(' ');

const SERVER_INSTRUCTIONS = [
  'This server creates and versions surveys on the Fly platform (vlab).',
  '',
  IDENTIFIER_NOTE,
  '',
  VERSIONING_NOTE,
  '',
  'AUTHORING MODEL. Survey content is authored in Typeform and imported into',
  'Fly; Fly stores the form JSON verbatim. Simple question types are just',
  'Typeform question types (Short Text, Multiple Choice, Number, Statement).',
  'Everything richer — webviews, tracked links, videos, waits, timeouts,',
  'stitches to another form, payments, images — is written as YAML in the',
  "field's Description box, and Fly promotes a `type:` key found there into the",
  "field's actual type. See the `description` argument of create_typeform_form.",
  '',
  'TYPICAL FLOW. create_typeform_form (author the questions) ->',
  'create_survey (register the form under a survey_name and shortcode) ->',
  'update_survey_settings (timeouts / retire a version) ->',
  'create_survey_version (publish a revision after editing in Typeform).',
  'Call list_surveys first if you are working on something that already exists.',
].join('\n');

// ---------------------------------------------------------------------------
// A small, honest JSON Schema validator.
//
// The tool schemas are advertised to clients as JSON Schema, so validating
// against that same object keeps the contract and the enforcement from
// drifting. This covers exactly the keywords the tool schemas use; it is
// deliberately not a general-purpose validator.
// ---------------------------------------------------------------------------

const typeOf = value => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

const typeMatches = (expected, actual) =>
  expected === actual || (expected === 'number' && actual === 'integer');

const describePath = path => (path.length ? path.join('.') : 'arguments');

function validateAgainstSchema(schema, value, path = []) {
  const errors = [];
  if (!schema) return errors;

  const at = describePath(path);

  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!expected.some(t => typeMatches(t, actual))) {
      errors.push(`${at}: expected ${expected.join(' or ')}, got ${actual}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: must be at least ${schema.minLength} character(s)`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateAgainstSchema(schema.items, item, path.concat(`[${i}]`)));
      });
    }
  }

  if (value !== null && typeOf(value) === 'object') {
    const properties = schema.properties || {};
    (schema.required || []).forEach(key => {
      if (value[key] === undefined) errors.push(`${at}: missing required property "${key}"`);
    });
    Object.keys(value).forEach(key => {
      if (properties[key]) {
        errors.push(...validateAgainstSchema(properties[key], value[key], path.concat(key)));
      } else if (schema.additionalProperties === false) {
        const known = Object.keys(properties).join(', ');
        errors.push(`${at}: unknown property "${key}" (accepted: ${known})`);
      }
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Tool definitions.
// ---------------------------------------------------------------------------

const TIMEOUT_ITEM_SCHEMA = {
  type: 'object',
  required: ['name', 'type', 'value'],
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      description:
        'The timeout variable name. Must match the `wait.value.variable` used by a ' +
        'wait field in the form — that is how a timeout row is bound to a question.',
    },
    type: {
      type: 'string',
      enum: ['relative', 'absolute'],
      description:
        '"relative" fires a fixed duration after the participant started waiting; ' +
        '"absolute" fires at a wall-clock moment for everyone at once.',
    },
    value: {
      type: 'string',
      description:
        'For "relative", a Postgres interval such as "2 days", "36 hours", "30 minutes". ' +
        'For "absolute", a timestamp such as "2026-09-30 12:00".',
    },
  },
};

const TYPEFORM_FIELD_SCHEMA = {
  type: 'object',
  required: ['type', 'ref', 'title'],
  additionalProperties: true,
  properties: {
    type: {
      type: 'string',
      description:
        'Question type. Typeform names — "multiple_choice", "short_text", "statement", ' +
        '"phone_number", "number" — or the short aliases "mc", "text", "statement", ' +
        '"phone", "number". NOTE: for any rich Fly type (webview, link_tracking, ' +
        'moviehouse, stitch, wait, notify, attachment, payment) the Typeform type barely ' +
        'matters — use "statement" and put the real type in `description`.',
    },
    ref: {
      type: 'string',
      minLength: 1,
      description:
        'Stable short identifier for the field, used to reference its answer later ' +
        '(e.g. "q1", "gender", "consent", "age_range"). Must be unique within the form.',
    },
    title: {
      type: 'string',
      minLength: 1,
      description:
        'The question text the participant sees in the chat. For a multiple choice ' +
        'question with answers longer than ~15 characters, write the options into the ' +
        'title as lettered lines and use A/B/C as the actual choices — passing `choices` ' +
        'below does this for you.',
    },
    description: {
      type: 'string',
      description:
        "The Typeform field Description box, and the most important argument here. Fly " +
        'parses it as YAML (JSON is valid YAML, so either form works) and if the result ' +
        'has a `type:` key it REPLACES the field type with that value and merges the whole ' +
        'blob into the field metadata. This is how every rich question type is authored:\n' +
        '  webview        — "type: webview" plus `url`, `buttonText`, `keepMoving`\n' +
        '  link_tracking  — a tracked link/tel/mailto button; Fly builds the whole URL\n' +
        '  moviehouse     — a Vimeo video with play/pause/finish events; give `videoId`\n' +
        '  attachment     — an image or video; `attachment: {type, url}`\n' +
        '  stitch         — jump to another form: `stitch: {form: SHORTCODE}`\n' +
        '  wait / notify  — hold the conversation on a timeout or external event\n' +
        '  payment        — reloadly or generic HTTP payout\n' +
        'Two traps: (1) if the YAML does not parse, Fly SILENTLY keeps the original ' +
        'Typeform type and your config is ignored with no error — the usual cause is an ' +
        'unquoted value containing ":", "[", "]" or "#", so QUOTE any value holding a URL; ' +
        '(2) a `wait` with no timeout hangs the conversation forever if the event never ' +
        'arrives, so pair it with a timeout branch.',
    },
    choices: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Convenience for multiple choice. Given ["Yes","No","Maybe"] this appends ' +
        '"\\n- A. Yes\\n- B. No\\n- C. Maybe" to the title and sets the real Typeform ' +
        'choices to A/B/C — the project convention, because a participant replying in ' +
        'a chat window types a letter, not a sentence. Maximum 13 choices. Pass ' +
        '`properties.choices` yourself if you want the raw labels to be the answers.',
    },
    properties: {
      type: 'object',
      additionalProperties: true,
      description:
        'Raw Typeform field properties, passed through untouched (button_text, ' +
        'choices, allow_multiple_selection, vertical_alignment, ...). Anything you set ' +
        'here wins over the defaults this tool applies.',
    },
    validations: {
      type: 'object',
      additionalProperties: true,
      description: 'Raw Typeform validations. Defaults to {"required": false}.',
    },
  },
};

const TOOLS = [
  {
    name: 'list_surveys',
    description: [
      'List the surveys owned by the authenticated researcher, grouped as they actually',
      'exist: study -> form -> versions.',
      '',
      IDENTIFIER_NOTE,
      '',
      'Call this before create_survey_version or update_survey_settings — you need the',
      'exact survey_name and shortcode for the first, and a version `id` for the second.',
      'A form whose current version has `off_time` set has been retired and no longer',
      'accepts new participants.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        survey_name: {
          type: 'string',
          description: 'Optional exact survey_name to filter to. Omit to list everything.',
        },
      },
    },
  },

  {
    name: 'create_typeform_form',
    description: [
      'Author a new Typeform form from a field spec and return its formid. This is the',
      'first half of creating a survey: it writes the questions into the Typeform account',
      'the researcher has connected to Fly, and does NOT register anything with Fly.',
      'Follow it with create_survey to make it a live survey.',
      '',
      'Fly stores whatever Typeform reports, so this is where the questions really live.',
      'Simple types are plain Typeform types. Everything richer — webviews, tracked links,',
      'videos, stitches, waits, payments, images — is authored as YAML in a field\'s',
      '`description`; read that argument\'s description before writing one.',
      '',
      'Requires a connected Typeform account (the researcher connects it once in the Fly',
      'dashboard). Creating a form is not free of consequence: it appears in the',
      "researcher's real Typeform workspace.",
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['title', 'fields'],
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          description: 'Form title, as it appears in the Typeform workspace.',
        },
        fields: {
          type: 'array',
          minItems: 1,
          items: TYPEFORM_FIELD_SCHEMA,
          description: 'The questions, in the order participants will see them.',
        },
        hidden: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Typeform hidden fields — values passed in rather than answered, readable in ' +
            'question text as {{hidden:name}} and usable in logic jumps. Common ones here: ' +
            '"userid", "surveyid", "pageid", "startTime". A hidden field named "seed_N" ' +
            '(e.g. "seed_3") is special: Fly assigns each participant an integer 1..N in it, ' +
            'which is how surveys randomise participants into arms.',
        },
        thankyou_screens: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Raw Typeform thank-you screens. Omit for a generic one.',
        },
        workspace_id: {
          type: 'string',
          description:
            "Typeform workspace to create the form in. Omit to use the account's default " +
            'workspace, which is almost always what you want.',
        },
      },
    },
  },

  {
    name: 'create_survey',
    description: [
      'Register an existing Typeform form with Fly as a NEW survey, making it live.',
      'Fly fetches the form JSON and its messages from Typeform and stores them verbatim,',
      'so the survey is a snapshot: later edits in Typeform do not reach participants',
      'until you call create_survey_version.',
      '',
      VERSIONING_NOTE,
      '',
      'This tool refuses if survey_name already exists for you, because a second row under',
      'an existing name is how you publish a revision, not how you start a new study —',
      'use create_survey_version for that. Requires a connected Typeform account.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['formid', 'survey_name', 'shortcode', 'title'],
      additionalProperties: false,
      properties: {
        formid: {
          type: 'string',
          minLength: 1,
          description:
            'The Typeform form id to import (the "abc123" in ' +
            'https://form.typeform.com/to/abc123). create_typeform_form returns one.',
        },
        survey_name: {
          type: 'string',
          minLength: 1,
          description:
            'Name of the study this form belongs to. Groups forms together across the ' +
            'dashboard. Must not already exist for this researcher.',
        },
        shortcode: {
          type: 'string',
          minLength: 1,
          description:
            'Short stable identifier for THIS form. It appears in participant links and ' +
            'is what a `stitch` in another form targets, so pick something short and ' +
            'permanent: it must never change once participants have a link to it.',
        },
        title: {
          type: 'string',
          minLength: 1,
          description: 'Human-readable title for this form, shown in the dashboard.',
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description:
            'Arbitrary JSON stamped onto every response collected by this version. Use it ' +
            'for study attributes you want to analyse by (wave, arm, district).',
        },
        translation_conf: {
          type: 'object',
          additionalProperties: true,
          description:
            'Translation configuration, validated against formcentral before the survey is ' +
            'created. Either {"self": true} for a form that is its own translation source, ' +
            'or {"destination": "<survey version id>"} to translate into another form. The ' +
            'destination is the UUID `id` of a survey version (what list_surveys returns ' +
            'as `id`), NOT a shortcode and NOT a survey_name — formcentral casts it to ' +
            'UUID and rejects anything else. Never pass both keys. ' +
            'Omit entirely for a monolingual survey.',
        },
      },
    },
  },

  {
    name: 'create_survey_version',
    description: [
      'Publish a new version of a form that already exists — the closest thing this API',
      'has to an update.',
      '',
      VERSIONING_NOTE,
      '',
      'The common case is: edit the questions in Typeform, then call this with just',
      '`survey_name`. Everything else — shortcode, title, formid, metadata,',
      'translation_conf — is inherited from the current version unless you override it,',
      'so re-importing the same Typeform form is a one-argument call. Pass `shortcode` if',
      'the study contains more than one form; the tool will tell you which ones exist.',
      '',
      'Settings (timeouts, off_time) attach to a version id, so a new version starts with',
      "the settings of a fresh row — re-apply them with update_survey_settings if the",
      'previous version had any. Requires a connected Typeform account.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['survey_name'],
      additionalProperties: false,
      properties: {
        survey_name: {
          type: 'string',
          minLength: 1,
          description: 'The existing study to publish into. Must already exist.',
        },
        shortcode: {
          type: 'string',
          description:
            'Which form inside the study to version. Optional when the study contains ' +
            'exactly one form. Never invent a new value here — a new shortcode is a new ' +
            'form, not a new version, and participant links point at the old one.',
        },
        formid: {
          type: 'string',
          description:
            "Typeform form to import. Defaults to the current version's formid, which is " +
            'what you want after editing that form in Typeform. Pass a different id only ' +
            'to repoint this shortcode at a different Typeform form.',
        },
        title: {
          type: 'string',
          description: 'Override the title. Defaults to the current version\'s title.',
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description:
            "Override the metadata. Defaults to the current version's metadata. Pass {} to " +
            'clear it.',
        },
        translation_conf: {
          type: 'object',
          additionalProperties: true,
          description:
            "Override the translation config. Defaults to the current version's.",
        },
      },
    },
  },

  {
    name: 'update_survey_settings',
    description: [
      'Set the timeouts on a survey version, or retire it.',
      '',
      'Settings hang off ONE immutable version row, addressed by its `id` from',
      'list_surveys — not off the survey_name and not off the shortcode. A new version',
      'created later does not inherit them.',
      '',
      'Omitted arguments are preserved: this tool reads the current settings and merges,',
      'so passing only `timeouts` will not wipe an existing `off_time`. Pass an explicit',
      'null to clear a field.',
      '',
      'RETIRING: setting `off_time` marks the version dead from that moment. Historical',
      'attribution is kept, so retiring is the correct way to take a survey out of',
      'circulation. It is not a delete and there is no delete.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['surveyid'],
      additionalProperties: false,
      properties: {
        surveyid: {
          type: 'string',
          minLength: 1,
          description:
            'The UUID `id` of one survey version, from list_surveys. Must belong to you.',
        },
        timeouts: {
          type: ['array', 'null'],
          items: TIMEOUT_ITEM_SCHEMA,
          description:
            'The full list of named timeouts for this version. This REPLACES the existing ' +
            'list rather than appending to it, so include the ones you want to keep. Each ' +
            'entry binds by `name` to a wait in the form. Pass null or [] to remove all.',
        },
        off_time: {
          type: ['string', 'null'],
          description:
            'ISO-8601 timestamp at which this version stops accepting participants. Set it ' +
            'to retire the version; pass null to bring it back.',
        },
      },
    },
  },
];

const toolByName = name => TOOLS.find(t => t.name === name) || null;

function validateToolArgs(name, args) {
  const tool = toolByName(name);
  if (!tool) {
    return {
      ok: false,
      errors: [`Unknown tool "${name}". Available: ${TOOLS.map(t => t.name).join(', ')}`],
    };
  }
  const errors = validateAgainstSchema(tool.inputSchema, args === undefined ? {} : args);
  return errors.length ? { ok: false, errors } : { ok: true };
}

// ---------------------------------------------------------------------------
// Typeform form construction — the pure half of create_typeform_form.
//
// Mirrors scripts/typeform-create.py (`parse_field_spec` + `apply_defaults`) so
// a form authored through MCP is byte-for-byte the shape that script produces.
// Deliberately no default workspace: the script hardcodes an internal test
// workspace, which would be the wrong home for a real researcher's form.
// ---------------------------------------------------------------------------

const TYPE_ALIASES = {
  mc: 'multiple_choice',
  text: 'short_text',
  phone: 'phone_number',
  number: 'number',
  statement: 'statement',
};

const MAX_CHOICES = 13;

const resolveFieldType = type => TYPE_ALIASES[type] || type;

const letterLabels = n => Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));

const DEFAULT_THANKYOU_SCREENS = [
  {
    ref: 'default_ending',
    title: 'Thank you for completing this survey!',
    properties: { show_button: false, share_icons: false },
  },
];

/*
 * `choices: ['Yes','No']` -> lettered options in the title and A/B as the real
 * answers. documentation/questions.md rule 2: a participant answering in a chat
 * window replies with a letter, so anything longer than ~15 characters has to
 * be lettered or the answer will not match.
 */
function expandChoices(field) {
  const type = resolveFieldType(field.type);
  const { choices, ...rest } = field;
  const out = { ...rest, type };

  if (!choices || !choices.length) return out;

  const labels = letterLabels(choices.length);
  out.title = [field.title].concat(choices.map((c, i) => `- ${labels[i]}. ${c}`)).join('\n');
  out.properties = { ...(field.properties || {}), choices: labels.map(label => ({ label })) };
  return out;
}

function applyFieldDefaults(field) {
  const out = { ...field };

  if (out.description !== undefined) {
    out.properties = { ...(out.properties || {}), description: out.description };
    delete out.description;
  }

  out.validations = { required: false, ...(out.validations || {}) };

  if (out.type === 'multiple_choice') {
    out.properties = {
      allow_multiple_selection: false,
      vertical_alignment: true,
      ...(out.properties || {}),
    };
  }

  return out;
}

function validateFormSpec({ fields }) {
  const errors = [];
  const seen = new Set();

  (fields || []).forEach((field, i) => {
    if (seen.has(field.ref)) errors.push(`fields[${i}]: duplicate ref "${field.ref}"`);
    seen.add(field.ref);

    if (field.choices && field.choices.length > MAX_CHOICES) {
      errors.push(
        `fields[${i}] ("${field.ref}"): ${field.choices.length} choices, maximum is ` +
          `${MAX_CHOICES} — a chat message cannot present more than that legibly`,
      );
    }

    const type = resolveFieldType(field.type);
    const hasChoices =
      (field.choices && field.choices.length) ||
      (field.properties && field.properties.choices && field.properties.choices.length);
    if (type === 'multiple_choice' && !hasChoices) {
      errors.push(
        `fields[${i}] ("${field.ref}"): multiple_choice needs "choices" ` +
          '(or "properties.choices")',
      );
    }
  });

  return errors;
}

function buildTypeformCreatePayload({ title, fields, hidden, thankyou_screens, workspace_id }) {
  const payload = {
    title,
    fields: (fields || []).map(expandChoices).map(applyFieldDefaults),
    thankyou_screens: thankyou_screens || DEFAULT_THANKYOU_SCREENS,
  };

  if (hidden && hidden.length) payload.hidden = hidden;
  if (workspace_id) {
    payload.workspace = { href: `https://api.typeform.com/workspaces/${workspace_id}` };
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Survey shaping.
// ---------------------------------------------------------------------------

// Shared with POST /surveys; re-exported so MCP callers have one import.
const { buildSurveyRecord } = require('../surveys/survey.core');

const byCreatedDesc = (a, b) => new Date(b.created) - new Date(a.created);

const distinct = xs => Array.from(new Set(xs));

/*
 * study -> form -> versions, which is the shape the data actually has and the
 * shape an agent needs in order to pick a shortcode or a version id. The flat
 * list the REST endpoint returns hides the version relationship entirely.
 */
function summariseSurveys(rows, { survey_name } = {}) {
  const filtered = survey_name ? rows.filter(r => r.survey_name === survey_name) : rows;

  const names = distinct(filtered.map(r => r.survey_name));

  const surveys = names.map(name => {
    const inStudy = filtered.filter(r => r.survey_name === name);
    const codes = distinct(inStudy.map(r => r.shortcode));

    const forms = codes.map(shortcode => {
      const versions = inStudy.filter(r => r.shortcode === shortcode).slice().sort(byCreatedDesc);
      const total = versions.length;
      const numbered = versions.map((v, i) => ({
        version: total - i,
        id: v.id,
        formid: v.formid,
        created: v.created,
        title: v.title,
        off_time: v.off_time || null,
        timeouts: v.timeouts || null,
      }));

      return {
        shortcode,
        title: numbered[0].title,
        version_count: total,
        current: numbered[0],
        versions: numbered,
      };
    });

    return { survey_name: name, form_count: forms.length, forms };
  });

  return { survey_count: surveys.length, surveys };
}

const findById = (rows, surveyid) => rows.find(r => r.id === surveyid) || null;

const surveyNameExists = (rows, survey_name) => rows.some(r => r.survey_name === survey_name);

/*
 * Which row is create_survey_version revising? Ambiguity here is the one place
 * an agent can quietly do damage — writing a new shortcode creates an orphan
 * form that no participant link points at — so an ambiguous call is refused
 * with the actual options listed rather than guessed at.
 */
function resolvePreviousVersion(rows, { survey_name, shortcode }) {
  const inStudy = rows.filter(r => r.survey_name === survey_name);

  if (!inStudy.length) {
    const known = distinct(rows.map(r => r.survey_name));
    return {
      ok: false,
      error:
        `No survey named "${survey_name}". ` +
        (known.length
          ? `Your surveys are: ${known.map(n => `"${n}"`).join(', ')}. `
          : 'You have no surveys yet. ') +
        'Use create_survey to start a new study, or list_surveys to see what exists.',
    };
  }

  const codes = distinct(inStudy.map(r => r.shortcode));

  if (shortcode && !codes.includes(shortcode)) {
    return {
      ok: false,
      error:
        `Survey "${survey_name}" has no form with shortcode "${shortcode}". ` +
        `Its forms are: ${codes.map(c => `"${c}"`).join(', ')}. ` +
        'A new shortcode would be a new form, not a new version, so this is refused.',
    };
  }

  if (!shortcode && codes.length > 1) {
    return {
      ok: false,
      error:
        `Survey "${survey_name}" contains ${codes.length} forms ` +
        `(${codes.map(c => `"${c}"`).join(', ')}). ` +
        'Pass `shortcode` to say which one you are publishing a new version of.',
    };
  }

  const pool = shortcode ? inStudy.filter(r => r.shortcode === shortcode) : inStudy;
  return { ok: true, previous: pool.slice().sort(byCreatedDesc)[0] };
}

/*
 * Merge the caller's overrides onto the previous version. Everything defaults
 * to the previous value, which makes "re-import the form I just edited" a
 * one-argument call.
 */
function buildVersionRequest(previous, args) {
  const pick = (key, fallback) => (args[key] !== undefined ? args[key] : fallback);

  return {
    survey_name: previous.survey_name,
    shortcode: previous.shortcode,
    formid: pick('formid', previous.formid),
    title: pick('title', previous.title),
    metadata: pick('metadata', previous.metadata),
    translation_conf: pick('translation_conf', previous.translation_conf),
  };
}

/*
 * The settings write is an upsert that replaces both columns, so a partial
 * update through it silently nulls the other one. Merging first is what makes
 * "set a timeout" not also un-retire a dead survey.
 */
function mergeSettings(current, args) {
  const pick = key => (args[key] !== undefined ? args[key] : current ? current[key] : undefined);

  const timeouts = pick('timeouts');

  return {
    // An empty list and no list mean the same thing — "no timeouts on this
    // version" — so they are stored the same way rather than as two states.
    timeouts: timeouts && timeouts.length ? timeouts : null,
    off_time: pick('off_time') || null,
  };
}

// ---------------------------------------------------------------------------
// Result shaping.
// ---------------------------------------------------------------------------

const toolResult = payload => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const toolError = message => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

const invalidArgsError = errors =>
  toolError(`Invalid arguments:\n${errors.map(e => `  - ${e}`).join('\n')}`);

const NO_TYPEFORM_CREDENTIAL = [
  'No Typeform account is connected for this researcher, so Fly cannot read or write',
  'forms on their behalf. Connect one in the Fly dashboard (it is a one-time OAuth',
  'authorisation) and then retry. Nothing was created.',
].join(' ');

const NO_FLY_ACCOUNT =
  'This key authenticates, but no Fly account exists for its email — the key has ' +
  'outlived its account, so nothing can be created with it.';

module.exports = {
  // constants / data
  TOOLS,
  SERVER_INSTRUCTIONS,
  VERSIONING_NOTE,
  IDENTIFIER_NOTE,
  DEFAULT_THANKYOU_SCREENS,
  MAX_CHOICES,
  NO_TYPEFORM_CREDENTIAL,
  NO_FLY_ACCOUNT,

  // schema + validation
  validateAgainstSchema,
  validateToolArgs,
  toolByName,

  // typeform authoring
  resolveFieldType,
  letterLabels,
  expandChoices,
  applyFieldDefaults,
  validateFormSpec,
  buildTypeformCreatePayload,

  // survey shaping
  buildSurveyRecord,
  summariseSurveys,
  findById,
  surveyNameExists,
  resolvePreviousVersion,
  buildVersionRequest,
  mergeSettings,

  // results
  toolResult,
  toolError,
  invalidArgsError,
};
