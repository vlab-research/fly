'use strict';

/*
 * Unit tests for the MCP functional core. No database, no network, no stubs —
 * every function here is pure, which is the whole reason the decision layer was
 * split out of the tool handlers.
 */

const { expect } = require('chai');

const core = require('./mcp.core');

const {
  TOOLS,
  SERVER_INSTRUCTIONS,
  MAX_CHOICES,
  validateAgainstSchema,
  validateToolArgs,
  toolByName,
  resolveFieldType,
  expandChoices,
  applyFieldDefaults,
  validateFormSpec,
  buildTypeformCreatePayload,
  buildSurveyRecord,
  summariseSurveys,
  findById,
  surveyNameExists,
  resolvePreviousVersion,
  buildVersionRequest,
  mergeSettings,
  toolResult,
  toolError,
  invalidArgsError,
} = core;

describe('mcp.core: tool definitions', () => {
  it('exposes exactly the five tools, each with a name, description and schema', () => {
    expect(TOOLS.map(t => t.name)).to.eql([
      'list_surveys',
      'create_typeform_form',
      'create_survey',
      'create_survey_version',
      'update_survey_settings',
    ]);

    TOOLS.forEach(tool => {
      expect(tool.description, tool.name).to.be.a('string');
      expect(tool.inputSchema, tool.name).to.include({ type: 'object' });
      expect(tool.inputSchema.properties, tool.name).to.be.an('object');
    });
  });

  // The append-only model is the single most surprising thing about this API.
  // An agent that misses it creates duplicate studies trying to edit one, so
  // the explanation being present is a contract, not a nicety.
  it('explains append-only versioning in every tool that writes a version', () => {
    ['create_survey', 'create_survey_version'].forEach(name => {
      expect(toolByName(name).description, name).to.match(/APPEND-ONLY VERSIONING/);
    });
    expect(SERVER_INSTRUCTIONS).to.match(/APPEND-ONLY VERSIONING/);
  });

  it('documents that every schema property carries a description', () => {
    TOOLS.forEach(tool => {
      Object.entries(tool.inputSchema.properties).forEach(([key, schema]) => {
        expect(schema.description, `${tool.name}.${key}`).to.be.a('string');
      });
    });
  });

  it('points authors at the Description box for rich question types', () => {
    const desc = toolByName('create_typeform_form').inputSchema.properties.fields.items
      .properties.description.description;

    ['webview', 'link_tracking', 'moviehouse', 'stitch', 'YAML'].forEach(word => {
      expect(desc).to.include(word);
    });
    // The silent-failure trap from documentation/questions.md.
    expect(desc).to.match(/SILENTLY/);
  });
});

describe('mcp.core: validateAgainstSchema', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    additionalProperties: false,
    properties: {
      a: { type: 'string', minLength: 1 },
      n: { type: 'number' },
      e: { type: 'string', enum: ['x', 'y'] },
      list: { type: 'array', minItems: 1, items: { type: 'string' } },
      nullable: { type: ['string', 'null'] },
    },
  };

  it('accepts a valid object', () => {
    expect(validateAgainstSchema(schema, { a: 'hi', n: 2, e: 'x', list: ['q'] })).to.eql([]);
  });

  it('reports a missing required property', () => {
    expect(validateAgainstSchema(schema, {})).to.eql(['arguments: missing required property "a"']);
  });

  it('reports an unknown property and names the accepted ones', () => {
    const [err] = validateAgainstSchema(schema, { a: 'x', shortcod: 'y' });
    expect(err).to.match(/unknown property "shortcod"/);
    expect(err).to.match(/accepted: a, n, e, list, nullable/);
  });

  it('reports a wrong type with the type it actually got', () => {
    expect(validateAgainstSchema(schema, { a: 5 })).to.eql([
      'a: expected string, got integer',
    ]);
  });

  it('accepts an integer where a number is wanted', () => {
    expect(validateAgainstSchema(schema, { a: 'x', n: 3 })).to.eql([]);
  });

  it('enforces enums, minLength and minItems', () => {
    expect(validateAgainstSchema(schema, { a: '', e: 'z', list: [] })).to.eql([
      'a: must be at least 1 character(s)',
      'e: must be one of "x", "y"',
      'list: must contain at least 1 item(s)',
    ]);
  });

  it('validates array items and names the index', () => {
    expect(validateAgainstSchema(schema, { a: 'x', list: ['ok', 3] })).to.eql([
      'list.[1]: expected string, got integer',
    ]);
  });

  it('accepts null only where the type union allows it', () => {
    expect(validateAgainstSchema(schema, { a: 'x', nullable: null })).to.eql([]);
    expect(validateAgainstSchema(schema, { a: 'x', n: null })).to.eql([
      'n: expected number, got null',
    ]);
  });
});

describe('mcp.core: validateToolArgs', () => {
  it('rejects an unknown tool by listing the real ones', () => {
    const { ok, errors } = validateToolArgs('update_survey', {});
    expect(ok).to.equal(false);
    expect(errors[0]).to.match(/Unknown tool "update_survey"/);
    expect(errors[0]).to.match(/create_survey_version/);
  });

  it('accepts a fully specified create_survey call', () => {
    expect(
      validateToolArgs('create_survey', {
        formid: 'abc123',
        survey_name: 'HPV Study',
        shortcode: 'hpv1',
        title: 'Screener',
      }),
    ).to.eql({ ok: true });
  });

  it('lists every missing required argument at once', () => {
    const { errors } = validateToolArgs('create_survey', { formid: 'abc' });
    expect(errors).to.have.length(3);
  });

  it('treats missing arguments as an empty object', () => {
    expect(validateToolArgs('list_surveys', undefined)).to.eql({ ok: true });
  });

  it('validates timeout entries structurally', () => {
    const { errors } = validateToolArgs('update_survey_settings', {
      surveyid: 'id',
      timeouts: [{ name: 'wait1', type: 'eventually', value: '2 days' }],
    });
    expect(errors[0]).to.match(/timeouts\.\[0\]\.type: must be one of "relative", "absolute"/);
  });
});

describe('mcp.core: Typeform form construction', () => {
  it('maps the typeform-create.py type shortcuts', () => {
    expect(resolveFieldType('mc')).to.equal('multiple_choice');
    expect(resolveFieldType('text')).to.equal('short_text');
    expect(resolveFieldType('phone')).to.equal('phone_number');
    expect(resolveFieldType('number')).to.equal('number');
    expect(resolveFieldType('statement')).to.equal('statement');
  });

  it('passes a full Typeform type through untouched', () => {
    expect(resolveFieldType('opinion_scale')).to.equal('opinion_scale');
  });

  // Byte-for-byte the shape scripts/typeform-create.py produces: the letters
  // go in the title, and the answers are the letters.
  it('expands choices into lettered title lines with A/B/C answers', () => {
    const field = expandChoices({
      type: 'mc',
      ref: 'colour',
      title: 'Pick a color',
      choices: ['Red', 'Blue', 'Green'],
    });

    expect(field.title).to.equal('Pick a color\n- A. Red\n- B. Blue\n- C. Green');
    expect(field.properties.choices).to.eql([{ label: 'A' }, { label: 'B' }, { label: 'C' }]);
    expect(field.type).to.equal('multiple_choice');
    expect(field.choices).to.equal(undefined);
  });

  it('leaves a field without choices alone', () => {
    const field = expandChoices({ type: 'text', ref: 'q', title: 'Why?' });
    expect(field).to.eql({ type: 'short_text', ref: 'q', title: 'Why?' });
  });

  // The Description box is where every rich Fly type is authored, so it has to
  // land at properties.description and nowhere else.
  it('moves a field description into properties.description', () => {
    const field = applyFieldDefaults({
      type: 'statement',
      ref: 'vid',
      title: 'Watch',
      description: 'type: moviehouse\nvideoId: "164118668"',
    });

    expect(field.properties.description).to.equal('type: moviehouse\nvideoId: "164118668"');
    expect(field.description).to.equal(undefined);
  });

  it('applies the same defaults as typeform-create.py', () => {
    const payload = buildTypeformCreatePayload({
      title: 'Survey',
      fields: [
        { type: 'mc', ref: 'q1', title: 'Yes?', choices: ['Yes', 'No'] },
        { type: 'text', ref: 'q2', title: 'Why?' },
      ],
      hidden: ['userid', 'surveyid'],
    });

    expect(payload.fields[0].validations).to.eql({ required: false });
    expect(payload.fields[0].properties.allow_multiple_selection).to.equal(false);
    expect(payload.fields[0].properties.vertical_alignment).to.equal(true);
    expect(payload.fields[1].validations).to.eql({ required: false });
    expect(payload.hidden).to.eql(['userid', 'surveyid']);
    expect(payload.thankyou_screens[0].ref).to.equal('default_ending');
  });

  it('lets the caller override any applied default', () => {
    const payload = buildTypeformCreatePayload({
      title: 'Survey',
      fields: [
        {
          type: 'mc',
          ref: 'q1',
          title: 'Yes?',
          choices: ['Yes', 'No'],
          validations: { required: true },
          properties: { allow_multiple_selection: true },
        },
      ],
    });

    expect(payload.fields[0].validations.required).to.equal(true);
    expect(payload.fields[0].properties.allow_multiple_selection).to.equal(true);
  });

  // typeform-create.py hardcodes the internal WA44hg test workspace. Doing that
  // here would drop a real researcher's form into someone else's workspace.
  it('omits workspace unless one is given', () => {
    expect(buildTypeformCreatePayload({ title: 't', fields: [] }).workspace).to.equal(undefined);
    expect(
      buildTypeformCreatePayload({ title: 't', fields: [], workspace_id: 'WA44hg' }).workspace,
    ).to.eql({ href: 'https://api.typeform.com/workspaces/WA44hg' });
  });

  it('rejects duplicate refs, over-long choice lists and choiceless multiple choice', () => {
    const errors = validateFormSpec({
      fields: [
        { type: 'text', ref: 'q1', title: 'a' },
        { type: 'text', ref: 'q1', title: 'b' },
        {
          type: 'mc',
          ref: 'q2',
          title: 'c',
          choices: Array.from({ length: MAX_CHOICES + 1 }, (_, i) => `c${i}`),
        },
        { type: 'multiple_choice', ref: 'q3', title: 'd' },
      ],
    });

    expect(errors).to.have.length(3);
    expect(errors[0]).to.match(/duplicate ref "q1"/);
    expect(errors[1]).to.match(/maximum is 13/);
    expect(errors[2]).to.match(/multiple_choice needs "choices"/);
  });
});

describe('mcp.core: survey shaping', () => {
  const created = new Date('2026-01-01T00:00:00Z');

  it('builds the survey row, defaulting the two JSON columns', () => {
    expect(
      buildSurveyRecord({
        formid: 'f1',
        form: '{}',
        messages: '{}',
        title: 'T',
        userid: 'u1',
        shortcode: 'sc',
        survey_name: 'S',
        created,
      }),
    ).to.eql({
      formid: 'f1',
      form: '{}',
      messages: '{}',
      title: 'T',
      userid: 'u1',
      shortcode: 'sc',
      survey_name: 'S',
      metadata: {},
      translation_conf: {},
      created,
    });
  });
});

describe('mcp.core: summariseSurveys', () => {
  const rows = [
    { id: 'v3', survey_name: 'HPV', shortcode: 'main', title: 'Main v3', formid: 'f1', created: '2026-03-01' },
    { id: 'v2', survey_name: 'HPV', shortcode: 'main', title: 'Main v2', formid: 'f1', created: '2026-02-01' },
    { id: 'v1', survey_name: 'HPV', shortcode: 'main', title: 'Main v1', formid: 'f1', created: '2026-01-01', off_time: '2026-02-01' },
    { id: 'b1', survey_name: 'HPV', shortcode: 'branch', title: 'Branch', formid: 'f2', created: '2026-01-15' },
    { id: 'o1', survey_name: 'Other', shortcode: 'other', title: 'Other', formid: 'f3', created: '2026-01-20' },
  ];

  it('groups study -> form -> versions and numbers versions oldest-first', () => {
    const out = summariseSurveys(rows);

    expect(out.survey_count).to.equal(2);
    const hpv = out.surveys.find(s => s.survey_name === 'HPV');
    expect(hpv.form_count).to.equal(2);

    const main = hpv.forms.find(f => f.shortcode === 'main');
    expect(main.version_count).to.equal(3);
    expect(main.versions.map(v => [v.version, v.id])).to.eql([[3, 'v3'], [2, 'v2'], [1, 'v1']]);
    expect(main.current.id).to.equal('v3');
  });

  it('normalises absent settings to null rather than dropping them', () => {
    const main = summariseSurveys(rows).surveys[0].forms[0];
    expect(main.current.off_time).to.equal(null);
    expect(main.current.timeouts).to.equal(null);
    expect(main.versions[2].off_time).to.equal('2026-02-01');
  });

  it('filters to one study', () => {
    const out = summariseSurveys(rows, { survey_name: 'Other' });
    expect(out.survey_count).to.equal(1);
    expect(out.surveys[0].forms[0].shortcode).to.equal('other');
  });

  it('handles an empty list', () => {
    expect(summariseSurveys([])).to.eql({ survey_count: 0, surveys: [] });
  });

  it('orders by created, not by input order', () => {
    const shuffled = [rows[1], rows[2], rows[0]];
    expect(summariseSurveys(shuffled).surveys[0].forms[0].current.id).to.equal('v3');
  });
});

describe('mcp.core: resolvePreviousVersion', () => {
  const rows = [
    { id: 'a2', survey_name: 'HPV', shortcode: 'main', formid: 'f1', title: 'M2', created: '2026-02-01' },
    { id: 'a1', survey_name: 'HPV', shortcode: 'main', formid: 'f0', title: 'M1', created: '2026-01-01' },
    { id: 'b1', survey_name: 'HPV', shortcode: 'branch', formid: 'f2', title: 'B', created: '2026-01-15' },
    { id: 'c1', survey_name: 'Solo', shortcode: 'only', formid: 'f3', title: 'S', created: '2026-01-20' },
  ];

  it('picks the newest version when the study has one form', () => {
    const out = resolvePreviousVersion(rows, { survey_name: 'Solo' });
    expect(out.ok).to.equal(true);
    expect(out.previous.id).to.equal('c1');
  });

  it('refuses an ambiguous study and names the forms', () => {
    const out = resolvePreviousVersion(rows, { survey_name: 'HPV' });
    expect(out.ok).to.equal(false);
    expect(out.error).to.match(/contains 2 forms \("main", "branch"\)/);
    expect(out.error).to.match(/Pass `shortcode`/);
  });

  it('disambiguates by shortcode and takes that form’s newest row', () => {
    const out = resolvePreviousVersion(rows, { survey_name: 'HPV', shortcode: 'main' });
    expect(out.previous.id).to.equal('a2');
  });

  // A shortcode that does not exist is a new form, and a new form is an orphan
  // no participant link points at. Guessing here is the damaging option.
  it('refuses an unknown shortcode instead of creating one', () => {
    const out = resolvePreviousVersion(rows, { survey_name: 'HPV', shortcode: 'maim' });
    expect(out.ok).to.equal(false);
    expect(out.error).to.match(/no form with shortcode "maim"/);
    expect(out.error).to.match(/"main", "branch"/);
  });

  it('refuses an unknown survey_name and lists the real ones', () => {
    const out = resolvePreviousVersion(rows, { survey_name: 'HPB' });
    expect(out.ok).to.equal(false);
    expect(out.error).to.match(/No survey named "HPB"/);
    expect(out.error).to.match(/"HPV", "Solo"/);
  });

  it('says so when the researcher has nothing at all', () => {
    expect(resolvePreviousVersion([], { survey_name: 'x' }).error).to.match(/no surveys yet/);
  });
});

describe('mcp.core: buildVersionRequest', () => {
  const previous = {
    id: 'a2',
    survey_name: 'HPV',
    shortcode: 'main',
    formid: 'f1',
    title: 'Main',
    metadata: { wave: 1 },
    translation_conf: { self: true },
  };

  // The common case: edit the questions in Typeform, re-import the same form.
  it('inherits everything when only survey_name is given', () => {
    expect(buildVersionRequest(previous, { survey_name: 'HPV' })).to.eql({
      survey_name: 'HPV',
      shortcode: 'main',
      formid: 'f1',
      title: 'Main',
      metadata: { wave: 1 },
      translation_conf: { self: true },
    });
  });

  it('applies overrides', () => {
    const out = buildVersionRequest(previous, {
      survey_name: 'HPV',
      formid: 'f9',
      title: 'Main v2',
      metadata: {},
    });
    expect(out.formid).to.equal('f9');
    expect(out.title).to.equal('Main v2');
    expect(out.metadata).to.eql({});
  });

  // The shortcode is the participant-link identity; a caller cannot move it.
  it('never lets the caller change the shortcode', () => {
    expect(buildVersionRequest(previous, { survey_name: 'HPV', shortcode: 'other' }).shortcode)
      .to.equal('main');
  });
});

describe('mcp.core: mergeSettings', () => {
  const current = { timeouts: [{ name: 'w', type: 'relative', value: '2 days' }], off_time: '2026-05-01' };

  // The write is an upsert over both columns, so a partial update would
  // otherwise silently un-retire a survey.
  it('keeps the field the caller did not mention', () => {
    expect(mergeSettings(current, { timeouts: [] })).to.eql({
      timeouts: null,
      off_time: '2026-05-01',
    });
    expect(mergeSettings(current, { off_time: null }).timeouts).to.eql(current.timeouts);
  });

  it('clears a field on an explicit null', () => {
    expect(mergeSettings(current, { off_time: null }).off_time).to.equal(null);
  });

  it('handles a version with no settings row yet', () => {
    expect(mergeSettings({}, { off_time: '2026-06-01' })).to.eql({
      timeouts: null,
      off_time: '2026-06-01',
    });
  });
});

describe('mcp.core: lookups and results', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];

  it('finds a survey by id and returns null otherwise', () => {
    expect(findById(rows, 'b')).to.eql({ id: 'b' });
    expect(findById(rows, 'z')).to.equal(null);
  });

  it('detects an existing survey_name', () => {
    expect(surveyNameExists([{ survey_name: 'X' }], 'X')).to.equal(true);
    expect(surveyNameExists([{ survey_name: 'X' }], 'Y')).to.equal(false);
  });

  it('shapes a successful result as pretty JSON text', () => {
    const out = toolResult({ a: 1 });
    expect(out.content[0]).to.eql({ type: 'text', text: '{\n  "a": 1\n}' });
    expect(out.isError).to.equal(undefined);
  });

  it('shapes an error as an isError result the model can read', () => {
    expect(toolError('nope')).to.eql({ content: [{ type: 'text', text: 'nope' }], isError: true });
  });

  it('bullets every validation error into one message', () => {
    expect(invalidArgsError(['a', 'b']).content[0].text).to.equal(
      'Invalid arguments:\n  - a\n  - b',
    );
  });
});
