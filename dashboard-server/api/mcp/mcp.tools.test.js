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
  const record = name => async args => {
    calls.push({ name, args });
    const impl = overrides[name];
    return typeof impl === 'function' ? impl(args) : impl;
  };

  const service = {
    listSurveys: record('listSurveys'),
    createTypeformForm: record('createTypeformForm'),
    registerSurveyVersion: record('registerSurveyVersion'),
    updateSettings: record('updateSettings'),
    '@noCallThru': true,
  };

  if (!overrides.listSurveys) {
    service.listSurveys = async args => {
      calls.push({ name: 'listSurveys', args });
      return SURVEYS;
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
