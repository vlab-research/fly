'use strict';

/*
 * Tool-handler tests.
 *
 * The IO layer (`mcp.service`) is stubbed with proxyquire and `@noCallThru`, so
 * the real module — and with it `queries/`, which opens a pg Pool at require
 * time — is never loaded. These tests touch no database.
 */

const { expect } = require('chai');
const proxyquire = require('proxyquire');

const { NO_TYPEFORM_CREDENTIAL } = require('./mcp.core');

const CONTEXT = { email: 'researcher@example.org' };

const SURVEYS = [
  { id: 'v2', survey_name: 'HPV', shortcode: 'main', title: 'Main', formid: 'f1', created: '2026-02-01', metadata: { wave: 1 }, translation_conf: {} },
  { id: 'v1', survey_name: 'HPV', shortcode: 'main', title: 'Main', formid: 'f0', created: '2026-01-01' },
  { id: 'b1', survey_name: 'HPV', shortcode: 'branch', title: 'Branch', formid: 'f2', created: '2026-01-15' },
  { id: 's1', survey_name: 'Solo', shortcode: 'only', title: 'Solo', formid: 'f3', created: '2026-01-20', timeouts: [{ name: 'w', type: 'relative', value: '2 days' }], off_time: null },
];

function makeService(overrides = {}) {
  const calls = [];
  // `args2` is the second positional argument, for the service functions that
  // take (resolvedSurvey, ...) rather than one options object.
  const record = name => async (args, args2) => {
    calls.push({ name, args, args2 });
    const impl = overrides[name];
    return typeof impl === 'function' ? impl(args, args2) : impl;
  };

  const service = {
    listSurveys: record('listSurveys'),
    createTypeformForm: record('createTypeformForm'),
    registerSurveyVersion: record('registerSurveyVersion'),
    updateSettings: record('updateSettings'),
    // monitoring
    resolveSurvey: record('resolveSurvey'),
    statesSummary: record('statesSummary'),
    listStates: record('listStates'),
    stateDetail: record('stateDetail'),
    healthFindings: record('healthFindings'),
    platformNotices: record('platformNotices'),
    // data
    startExport: record('startExport'),
    listExports: record('listExports'),
    getResponses: record('getResponses'),
    '@noCallThru': true,
  };

  if (!overrides.listSurveys) {
    service.listSurveys = async args => {
      calls.push({ name: 'listSurveys', args });
      return SURVEYS;
    };
  }

  // The same ownership answer the real resolveSurvey gives over SURVEYS.
  if (!overrides.resolveSurvey) {
    service.resolveSurvey = async args => {
      calls.push({ name: 'resolveSurvey', args });
      const mine = SURVEYS.filter(r => r.survey_name === args.survey_name);
      if (!mine.length) {
        return { ok: false, notFound: true, known: [...new Set(SURVEYS.map(r => r.survey_name))] };
      }
      return {
        ok: true,
        email: args.email,
        surveyName: args.survey_name,
        shortcodes: [...new Set(mine.map(r => r.shortcode))],
      };
    };
  }

  return { service, calls };
}

function loadTools(overrides) {
  const { service, calls } = makeService(overrides);
  const tools = proxyquire('./mcp.tools', { './mcp.service': service });
  return { runTool: tools.runTool, tools, calls };
}

const payloadOf = result => JSON.parse(result.content[0].text);
const textOf = result => result.content[0].text;

describe('mcp.tools: argument validation', () => {
  it('rejects an unknown tool without calling anything', async () => {
    const { runTool, calls } = loadTools();
    const out = await runTool('delete_survey', {}, CONTEXT);

    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.match(/Unknown tool "delete_survey"/);
    expect(calls).to.have.lengthOf(0);
  });

  it('rejects bad arguments before any IO happens', async () => {
    const { runTool, calls } = loadTools();
    const out = await runTool('create_survey', { formid: 'f1' }, CONTEXT);

    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.match(/Invalid arguments/);
    expect(textOf(out)).to.match(/missing required property "survey_name"/);
    expect(calls).to.have.lengthOf(0);
  });
});

describe('mcp.tools: list_surveys', () => {
  it('returns the study -> form -> version summary for the caller', async () => {
    const { runTool, calls } = loadTools();
    const out = await runTool('list_surveys', {}, CONTEXT);

    expect(calls[0]).to.eql({ name: 'listSurveys', args: { email: CONTEXT.email } });
    const body = payloadOf(out);
    expect(body.survey_count).to.equal(2);
    expect(body.surveys.map(s => s.survey_name)).to.eql(['HPV', 'Solo']);
  });

  it('names the surveys that do exist when a filter matches nothing', async () => {
    const { runTool } = loadTools();
    const out = await runTool('list_surveys', { survey_name: 'HPB' }, CONTEXT);

    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.match(/"HPV", "Solo"/);
  });
});

describe('mcp.tools: create_typeform_form', () => {
  it('sends the built payload and reports the formid and the next step', async () => {
    const { runTool, calls } = loadTools({
      createTypeformForm: async () => ({
        ok: true,
        form: { id: 'abc123', url: 'https://form.typeform.com/to/abc123', title: 'Survey' },
      }),
    });

    const out = await runTool(
      'create_typeform_form',
      {
        title: 'Survey',
        fields: [
          { type: 'mc', ref: 'q1', title: 'Agree?', choices: ['Yes', 'No'] },
          { type: 'statement', ref: 'vid', title: 'Watch', description: 'type: moviehouse' },
        ],
        hidden: ['userid'],
      },
      CONTEXT,
    );

    const sent = calls[0].args.payload;
    expect(sent.fields[0].title).to.equal('Agree?\n- A. Yes\n- B. No');
    expect(sent.fields[1].properties.description).to.equal('type: moviehouse');
    expect(sent.hidden).to.eql(['userid']);

    const body = payloadOf(out);
    expect(body.formid).to.equal('abc123');
    expect(body.field_count).to.equal(2);
    expect(body.next_step).to.match(/create_survey/);
  });

  it('refuses a form spec the Typeform API would reject, without calling it', async () => {
    const { runTool, calls } = loadTools();
    const out = await runTool(
      'create_typeform_form',
      { title: 'S', fields: [{ type: 'mc', ref: 'q1', title: 'Pick' }] },
      CONTEXT,
    );

    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.match(/multiple_choice needs "choices"/);
    expect(calls).to.have.lengthOf(0);
  });

  it('explains how to connect Typeform when no credential exists', async () => {
    const { runTool } = loadTools({
      createTypeformForm: async () => ({ ok: false, missingCredential: true }),
    });

    const out = await runTool(
      'create_typeform_form',
      { title: 'S', fields: [{ type: 'text', ref: 'q', title: 'Q' }] },
      CONTEXT,
    );

    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.equal(NO_TYPEFORM_CREDENTIAL);
  });
});

describe('mcp.tools: create_survey', () => {
  const args = {
    formid: 'f9',
    survey_name: 'New Study',
    shortcode: 'ns1',
    title: 'Screener',
  };

  it('registers the version and explains the immutability model', async () => {
    const { runTool, calls } = loadTools({
      registerSurveyVersion: async a => ({
        ok: true,
        survey: { id: 'new', ...a, created: '2026-03-01' },
      }),
    });

    const out = await runTool('create_survey', args, CONTEXT);

    expect(calls[1].name).to.equal('registerSurveyVersion');
    expect(calls[1].args).to.include({ email: CONTEXT.email, formid: 'f9', shortcode: 'ns1' });

    const body = payloadOf(out);
    expect(body.created).to.include({ survey_name: 'New Study', version: 1 });
    expect(body.note).to.match(/create_survey_version/);
  });

  // Reusing an existing survey_name is how you publish a revision, not how you
  // start a study, and getting that wrong silently forks a live study in two.
  it('refuses an existing survey_name and points at create_survey_version', async () => {
    const { runTool, calls } = loadTools();
    const out = await runTool('create_survey', { ...args, survey_name: 'HPV' }, CONTEXT);

    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.match(/already exists/);
    expect(textOf(out)).to.match(/create_survey_version/);
    expect(calls.map(c => c.name)).to.eql(['listSurveys']);
  });

  it('surfaces an expected service failure as a readable tool error', async () => {
    // `expected` is the flag mcp.service.ToolFailure sets; asserting on the
    // flag rather than the class keeps this test off the real service module,
    // which pulls in the pg pool.
    const { runTool } = loadTools({
      registerSurveyVersion: async () => {
        const err = new Error('Typeform has no form with id "f9" for this account.');
        err.expected = true;
        throw err;
      },
    });

    const out = await runTool('create_survey', args, CONTEXT);
    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.match(/Typeform has no form with id "f9"/);
  });

  it('never leaks an unexpected failure as a thrown exception', async () => {
    const { runTool } = loadTools({
      registerSurveyVersion: async () => {
        throw new Error('connection terminated unexpectedly');
      },
    });

    const out = await runTool('create_survey', args, CONTEXT);
    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.match(/failed unexpectedly/);
  });
});

describe('mcp.tools: create_survey_version', () => {
  it('inherits everything from the current version when given only survey_name', async () => {
    const { runTool, calls } = loadTools({
      registerSurveyVersion: async a => ({
        ok: true,
        survey: { id: 'v3', ...a, created: '2026-03-01' },
      }),
    });

    const out = await runTool('create_survey_version', { survey_name: 'Solo' }, CONTEXT);

    expect(calls[1].args).to.include({
      email: CONTEXT.email,
      survey_name: 'Solo',
      shortcode: 'only',
      formid: 'f3',
      title: 'Solo',
    });

    const body = payloadOf(out);
    expect(body.replaces.id).to.equal('s1');
    expect(body.created.version).to.equal(2);
    // Settings do not follow a version; saying so is the whole point.
    expect(body.note).to.match(/were NOT carried over/);
  });

  it('refuses an ambiguous study before writing anything', async () => {
    const { runTool, calls } = loadTools();
    const out = await runTool('create_survey_version', { survey_name: 'HPV' }, CONTEXT);

    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.match(/contains 2 forms/);
    expect(calls.map(c => c.name)).to.eql(['listSurveys']);
  });

  it('versions the named form when the study has several', async () => {
    const { runTool, calls } = loadTools({
      registerSurveyVersion: async a => ({ ok: true, survey: { id: 'v3', ...a } }),
    });

    await runTool(
      'create_survey_version',
      { survey_name: 'HPV', shortcode: 'main', formid: 'f5' },
      CONTEXT,
    );

    expect(calls[1].args).to.include({ shortcode: 'main', formid: 'f5' });
    expect(calls[1].args.metadata).to.eql({ wave: 1 });
  });
});

describe('mcp.tools: update_survey_settings', () => {
  it('refuses a call that would change nothing', async () => {
    const { runTool, calls } = loadTools();
    const out = await runTool('update_survey_settings', { surveyid: 's1' }, CONTEXT);

    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.match(/Nothing to change/);
    expect(calls).to.have.lengthOf(0);
  });

  it('passes only the settings through and reports the retired flag', async () => {
    const { runTool, calls } = loadTools({
      updateSettings: async () => ({
        ok: true,
        survey: { survey_name: 'Solo', shortcode: 'only' },
        settings: { timeouts: null, off_time: '2026-05-01' },
      }),
    });

    const out = await runTool(
      'update_survey_settings',
      { surveyid: 's1', off_time: '2026-05-01' },
      CONTEXT,
    );

    expect(calls[0].args).to.eql({
      email: CONTEXT.email,
      surveyid: 's1',
      args: { off_time: '2026-05-01' },
    });
    expect(payloadOf(out)).to.include({ retired: true, shortcode: 'only' });
  });

  it('explains that settings key off a version id when the id is not the caller’s', async () => {
    const { runTool } = loadTools({
      updateSettings: async () => ({ ok: false, notFound: true }),
    });

    const out = await runTool(
      'update_survey_settings',
      { surveyid: 'someone-elses', timeouts: [] },
      CONTEXT,
    );

    expect(out.isError).to.equal(true);
    expect(textOf(out)).to.match(/belongs to you/);
    expect(textOf(out)).to.match(/not a survey_name or a shortcode/);
  });

  /*
   * Per-tool scoping. The auth middleware marks /mcp delegated and cannot gate
   * it, so this table is the only scope enforcement a tool call gets.
   */
  describe('scope enforcement', () => {
    const scoped = scopes => ({ ...CONTEXT, scopes });

    it('lets a survey-read key list surveys', async () => {
      const { runTool } = loadTools({ listSurveys: async () => SURVEYS });
      const out = await runTool('list_surveys', {}, scoped(['surveys:read']));
      expect(out.isError).to.not.equal(true);
    });

    it('refuses a write tool to a survey-read key, and says what it needs', async () => {
      const { runTool, calls } = loadTools({ listSurveys: async () => SURVEYS });

      const out = await runTool(
        'create_survey',
        { formid: 'f9', survey_name: 'New', shortcode: 'new', title: 'New' },
        scoped(['surveys:read']),
      );

      expect(out.isError).to.equal(true);
      expect(textOf(out)).to.match(/not permitted to use "create_survey"/);
      expect(textOf(out)).to.match(/surveys:write/);
      // and nothing was attempted
      expect(calls).to.have.length(0);
    });

    it('allows a write tool to a survey-write key', async () => {
      const { runTool } = loadTools({
        listSurveys: async () => [],
        registerSurveyVersion: async () => ({
          ok: true,
          survey: { id: 'n1', survey_name: 'New', shortcode: 'new', title: 'New', formid: 'f9', created: '2026-03-01' },
        }),
      });

      const out = await runTool(
        'create_survey',
        { formid: 'f9', survey_name: 'New', shortcode: 'new', title: 'New' },
        scoped(['surveys:write']),
      );

      expect(out.isError).to.not.equal(true);
    });

    it('treats absent scopes as unrestricted, like the middleware does', async () => {
      const { runTool } = loadTools({ listSurveys: async () => SURVEYS });
      const out = await runTool('list_surveys', {}, { email: CONTEXT.email });
      expect(out.isError).to.not.equal(true);
    });

    it('denies every tool to a key with an empty scope list', async () => {
      const { runTool, calls } = loadTools({ listSurveys: async () => SURVEYS });
      const out = await runTool('list_surveys', {}, scoped([]));
      expect(out.isError).to.equal(true);
      expect(calls).to.have.length(0);
    });

    it('has a scope for every tool it dispatches', () => {
      const { TOOL_HANDLERS, TOOL_SCOPES } = loadTools().tools;
      Object.keys(TOOL_HANDLERS).forEach(name => {
        expect(TOOL_SCOPES[name], `${name} has no entry in TOOL_SCOPES`).to.be.a('string');
      });
    });
  });
});

/*
 * Monitoring. Every survey-scoped tool goes through resolveSurvey — the same
 * lookup the REST middleware uses — and hands the resolved survey (with its
 * shortcodes, the query pre-filter) to the service. A miss is a tool error
 * naming the caller's real surveys, and nothing else is called.
 */
describe('mcp.tools: monitoring', () => {
  const RESOLVED = { email: CONTEXT.email, surveyName: 'HPV', shortcodes: ['main', 'branch'] };

  describe('get_states_summary', () => {
    it('resolves the survey and returns the summary rows', async () => {
      const summary = { summary: [{ current_state: 'ERROR', current_form: 'main', count: 3 }] };
      const { runTool, calls } = loadTools({ statesSummary: async () => summary });

      const out = await runTool('get_states_summary', { survey_name: 'HPV' }, CONTEXT);

      expect(calls.map(c => c.name)).to.eql(['resolveSurvey', 'statesSummary']);
      expect(calls[1].args).to.eql(RESOLVED);
      expect(payloadOf(out)).to.eql(summary);
    });

    it('answers a survey that is not yours with the ones that are, and stops', async () => {
      const { runTool, calls } = loadTools();
      const out = await runTool('get_states_summary', { survey_name: 'Nope' }, CONTEXT);

      expect(out.isError).to.equal(true);
      expect(textOf(out)).to.match(/No survey named "Nope"/);
      expect(textOf(out)).to.match(/"HPV", "Solo"/);
      expect(calls.map(c => c.name)).to.eql(['resolveSurvey']);
    });
  });

  describe('list_states', () => {
    it('maps the arguments onto the query filters and shapes the page', async () => {
      const { runTool, calls } = loadTools({
        listStates: async () => ({ states: [{ userid: 'u1', current_state: 'ERROR' }], total: 7 }),
      });

      const out = await runTool(
        'list_states',
        { survey_name: 'HPV', state: 'ERROR', error_tag: 'FB', limit: 5, offset: 5 },
        CONTEXT,
      );

      const [survey, filters] = [calls[1].args, calls[1].args2];
      expect(survey).to.eql(RESOLVED);
      expect(filters).to.eql({
        state: 'ERROR',
        errorTag: 'FB',
        form: undefined,
        search: undefined,
        limit: 5,
        offset: 5,
      });
      expect(payloadOf(out)).to.eql({
        total: 7,
        limit: 5,
        offset: 5,
        items: [{ userid: 'u1', current_state: 'ERROR' }],
      });
    });

    it('caps the limit at 200 no matter what is asked', async () => {
      const { runTool, calls } = loadTools({ listStates: async () => ({ states: [], total: 0 }) });
      await runTool('list_states', { survey_name: 'HPV', limit: 100000 }, CONTEXT);
      expect(calls[1].args2.limit).to.equal(200);
    });
  });

  describe('get_participant_state', () => {
    it('returns the full row for one participant', async () => {
      const row = { userid: 'u1', current_state: 'ERROR', state_json: { qa: [] } };
      const { runTool, calls } = loadTools({ stateDetail: async () => row });

      const out = await runTool('get_participant_state', { survey_name: 'HPV', userid: 'u1' }, CONTEXT);

      expect(calls[1].args).to.eql(RESOLVED);
      expect(calls[1].args2).to.equal('u1');
      expect(payloadOf(out)).to.eql(row);
    });

    it('names the missing participant rather than returning nothing', async () => {
      const { runTool } = loadTools({ stateDetail: async () => null });
      const out = await runTool('get_participant_state', { survey_name: 'HPV', userid: 'ghost' }, CONTEXT);

      expect(out.isError).to.equal(true);
      expect(textOf(out)).to.match(/No participant "ghost" in survey "HPV"/);
    });
  });

  describe('get_survey_health', () => {
    it('returns the findings and aggregates for the resolved survey', async () => {
      const health = { window_hours: 24, findings: [{ level: 'action' }], aggregates: {} };
      const { runTool, calls } = loadTools({ healthFindings: async () => health });

      const out = await runTool('get_survey_health', { survey_name: 'Solo' }, CONTEXT);

      expect(calls[1].args).to.eql({ email: CONTEXT.email, surveyName: 'Solo', shortcodes: ['only'] });
      expect(payloadOf(out)).to.eql(health);
    });
  });

  describe('get_platform_notices', () => {
    it('returns the notices without touching any survey', async () => {
      const { runTool, calls } = loadTools({ platformNotices: async () => ({ notices: [] }) });
      const out = await runTool('get_platform_notices', {}, CONTEXT);

      expect(calls.map(c => c.name)).to.eql(['platformNotices']);
      expect(payloadOf(out)).to.eql({ notices: [] });
    });

    it('needs platform:read, not surveys:read', async () => {
      const { runTool } = loadTools({ platformNotices: async () => ({ notices: [] }) });
      const refused = await runTool('get_platform_notices', {}, { ...CONTEXT, scopes: ['surveys:read'] });
      expect(refused.isError).to.equal(true);
      expect(textOf(refused)).to.match(/platform:read/);

      const ok = await runTool('get_platform_notices', {}, { ...CONTEXT, scopes: ['platform:read'] });
      expect(ok.isError).to.not.equal(true);
    });
  });

  it('lets a surveys:read key read participant state, as REST does', async () => {
    const { runTool } = loadTools({ statesSummary: async () => ({ summary: [] }) });
    const out = await runTool('get_states_summary', { survey_name: 'HPV' }, { ...CONTEXT, scopes: ['surveys:read'] });
    expect(out.isError).to.not.equal(true);
  });
});

describe('mcp.tools: data', () => {
  describe('start_export', () => {
    it('resolves the survey, inserts the request and explains how to follow it', async () => {
      const { runTool, calls } = loadTools({
        startExport: async () => ({ export_id: 'e1', source: 'chat_log', status: 'Requested' }),
      });

      const out = await runTool(
        'start_export',
        { survey_name: 'HPV', export_type: 'chat_log', options: { include_metadata: true } },
        CONTEXT,
      );

      expect(calls.map(c => c.name)).to.eql(['resolveSurvey', 'startExport']);
      expect(calls[1].args).to.eql({
        email: CONTEXT.email,
        survey_name: 'HPV',
        export_type: 'chat_log',
        options: { include_metadata: true },
      });
      expect(payloadOf(out)).to.include({ export_id: 'e1', export_type: 'chat_log', status: 'Requested' });
      expect(payloadOf(out).note).to.match(/list_exports/);
    });

    it('refuses an option from another export type before any IO', async () => {
      const { runTool, calls } = loadTools();
      const out = await runTool(
        'start_export',
        { survey_name: 'HPV', export_type: 'full_messages', options: { pivot: true } },
        CONTEXT,
      );

      expect(out.isError).to.equal(true);
      expect(textOf(out)).to.match(/unknown property "pivot"/);
      expect(calls).to.have.lengthOf(0);
    });

    it('refuses a survey that is not yours before inserting anything', async () => {
      const { runTool, calls } = loadTools();
      const out = await runTool('start_export', { survey_name: 'Nope', export_type: 'responses' }, CONTEXT);

      expect(out.isError).to.equal(true);
      expect(textOf(out)).to.match(/No survey named "Nope"/);
      expect(calls.map(c => c.name)).to.eql(['resolveSurvey']);
    });

    it('needs exports:write', async () => {
      const { runTool, calls } = loadTools();
      const out = await runTool(
        'start_export',
        { survey_name: 'HPV', export_type: 'responses' },
        { ...CONTEXT, scopes: ['exports:read', 'surveys:write'] },
      );
      expect(out.isError).to.equal(true);
      expect(textOf(out)).to.match(/exports:write/);
      expect(calls).to.have.lengthOf(0);
    });
  });

  describe('list_exports', () => {
    const ROWS = [
      { id: 'e2', user_id: CONTEXT.email, survey_id: 'HPV', source: 'responses', status: 'Finished', export_link: 'https://x/e2', updated: '2026-09-02', retry_count: 0, options: {} },
      { id: 'e1', user_id: CONTEXT.email, survey_id: 'HPV', source: 'chat_log', status: 'Requested', export_link: 'Not Found', updated: '2026-09-01', retry_count: 0, options: {} },
    ];

    it('lists everything without a survey filter and projects the rows', async () => {
      const { runTool, calls } = loadTools({ listExports: async () => ROWS });
      const out = await runTool('list_exports', {}, CONTEXT);

      expect(calls.map(c => c.name)).to.eql(['listExports']);
      expect(calls[0].args).to.eql({ email: CONTEXT.email, survey_name: undefined });
      const body = payloadOf(out);
      expect(body.count).to.equal(2);
      expect(body.items[0]).to.include({ id: 'e2', status: 'Finished', export_link: 'https://x/e2' });
      expect(body.items[1].export_link).to.equal(null);
      expect(body.items[0]).to.not.have.property('user_id');
    });

    it('resolves the survey when one is named', async () => {
      const { runTool, calls } = loadTools({ listExports: async () => [] });
      await runTool('list_exports', { survey_name: 'HPV' }, CONTEXT);
      expect(calls.map(c => c.name)).to.eql(['resolveSurvey', 'listExports']);
      expect(calls[1].args).to.eql({ email: CONTEXT.email, survey_name: 'HPV' });

      const out = await runTool('list_exports', { survey_name: 'Nope' }, CONTEXT);
      expect(out.isError).to.equal(true);
    });
  });

  describe('get_responses', () => {
    const rows = n => Array.from({ length: n }, (_, i) => ({ userid: `u${i}`, token: `t${i}` }));

    it('passes the cursor and a clamped page size, and returns the next cursor', async () => {
      const { runTool, calls } = loadTools({ getResponses: async () => ({ responses: rows(500) }) });

      const out = await runTool(
        'get_responses',
        { survey_name: 'HPV', after: 'abc', page_size: 100000 },
        CONTEXT,
      );

      expect(calls[1].args).to.eql({ email: CONTEXT.email, survey_name: 'HPV', after: 'abc', pageSize: 500 });
      const body = payloadOf(out);
      expect(body.page_size).to.equal(500);
      expect(body.next_cursor).to.equal('t499');
      expect(body.items).to.have.lengthOf(500);
    });

    it('defaults to 25 rows and ends paging on a short page', async () => {
      const { runTool, calls } = loadTools({ getResponses: async () => ({ responses: rows(3) }) });
      const out = await runTool('get_responses', { survey_name: 'HPV' }, CONTEXT);

      expect(calls[1].args).to.include({ after: null, pageSize: 25 });
      expect(payloadOf(out).next_cursor).to.equal(null);
    });

    // The whole reason `responses` is its own resource.
    it('refuses a surveys:read key and needs responses:read', async () => {
      const { runTool } = loadTools({ getResponses: async () => ({ responses: [] }) });
      const refused = await runTool('get_responses', { survey_name: 'HPV' }, { ...CONTEXT, scopes: ['surveys:write'] });
      expect(refused.isError).to.equal(true);
      expect(textOf(refused)).to.match(/responses:read/);

      const ok = await runTool('get_responses', { survey_name: 'HPV' }, { ...CONTEXT, scopes: ['responses:read'] });
      expect(ok.isError).to.not.equal(true);
    });
  });
});
