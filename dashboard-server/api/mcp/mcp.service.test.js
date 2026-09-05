'use strict';

/*
 * Tests for the imperative shell. `queries/` and `utils/` are replaced outright
 * (proxyquire in noCallThru mode), so no pg Pool is ever constructed and no
 * database or Typeform endpoint is contacted.
 *
 * What is worth pinning here is the sequencing the pure core cannot see: which
 * arguments reach the query layer, and what the service refuses to write.
 */

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

const EMAIL = 'researcher@example.org';

const VALID_FORM = JSON.stringify({ id: 'f1', title: 'Form', fields: [] });

function load(overrides = {}) {
  const calls = [];
  const push = (name, args) => calls.push({ name, args });

  const queries = {
    Survey: {
      async create(row) {
        push('Survey.create', row);
        return { id: 'new-id', ...row };
      },
      async retrieve(args) {
        push('Survey.retrieve', args);
        return overrides.surveys || [];
      },
      async update(args) {
        push('Survey.update', args);
        if (overrides.updateWritesNothing) return undefined;
        return { surveyid: args.surveyid, timeouts: args.timeouts, off_time: args.off_time };
      },
    },
    User: {
      async user(args) {
        push('User.user', args);
        return overrides.user === undefined ? { id: 'user-1' } : overrides.user;
      },
    },
    Credential: {
      async getOne(args) {
        push('Credential.getOne', args);
        return overrides.credential === undefined
          ? { details: { access_token: 'tf-token' } }
          : overrides.credential;
      },
    },
  };

  const utils = {
    SurveyUtil: {
      validate(row) {
        push('SurveyUtil.validate', row);
        if (overrides.validateError) throw new Error(overrides.validateError);
      },
      async validateTranslation(args) {
        push('SurveyUtil.validateTranslation', args);
        return overrides.translationError || undefined;
      },
    },
    TypeformUtil: {
      makeKey: email => `${email}:typeform`,
      async TypeformForm(token, formid) {
        push('TypeformForm', { token, formid });
        return overrides.form === undefined ? VALID_FORM : overrides.form;
      },
      async TypeformMessages(token, formid) {
        push('TypeformMessages', { token, formid });
        return '{}';
      },
    },
  };

  const typeform = {
    async createForm(token, payload) {
      push('createForm', { token, payload });
      return { id: 'tf-1', url: 'https://form.typeform.com/to/tf-1', title: payload.title };
    },
  };

  // survey.service is stubbed through the same fakes so its own transitive
  // requires never reach the real queries module.
  const surveyService = proxyquire('../surveys/survey.service', {
    '../../queries': queries,
    '../../utils': utils,
  });

  const service = proxyquire('./mcp.service', {
    '../../queries': queries,
    '../surveys/survey.service': surveyService,
    './mcp.typeform': typeform,
  });

  return { service, calls };
}

const find = (calls, name) => calls.find(c => c.name === name);

describe('mcp.service: updateSettings', () => {
  const surveys = [
    {
      id: 'aaaa',
      survey_name: 'Study',
      shortcode: 'sc',
      timeouts: [{ name: 'w', type: 'relative', value: '2 days' }],
      off_time: null,
    },
  ];

  // Survey.update enforces ownership inside the statement by matching on email;
  // omitting it makes the INSERT select no row and silently write nothing.
  it('passes the caller email through to the ownership-scoped write', async () => {
    const { service, calls } = load({ surveys });
    await service.updateSettings({ email: EMAIL, surveyid: 'aaaa', args: { off_time: '2026-05-01' } });

    expect(find(calls, 'Survey.update').args).to.eql({
      surveyid: 'aaaa',
      email: EMAIL,
      timeouts: surveys[0].timeouts,
      off_time: '2026-05-01',
    });
  });

  // The write casts $1::UUID and would throw on anything else, so an id an
  // agent invented has to be caught by the read.
  it('reports an id that is not the caller’s without reaching the write', async () => {
    const { service, calls } = load({ surveys });
    const out = await service.updateSettings({
      email: EMAIL,
      surveyid: 'not-a-uuid',
      args: { off_time: '2026-05-01' },
    });

    expect(out.notFound).to.equal(true);
    expect(find(calls, 'Survey.update')).to.equal(undefined);
  });

  it('reports not-found when the row disappears between the read and the write', async () => {
    const { service } = load({ surveys, updateWritesNothing: true });
    const out = await service.updateSettings({
      email: EMAIL,
      surveyid: 'aaaa',
      args: { off_time: null },
    });

    expect(out.notFound).to.equal(true);
  });
});

describe('mcp.service: createTypeformForm', () => {
  it('sends the payload with the researcher’s own token', async () => {
    const { service, calls } = load();
    const out = await service.createTypeformForm({ email: EMAIL, payload: { title: 'T' } });

    expect(find(calls, 'createForm').args).to.eql({ token: 'tf-token', payload: { title: 'T' } });
    expect(out.form.id).to.equal('tf-1');
  });

  it('reports a missing credential without calling Typeform', async () => {
    const { service, calls } = load({ credential: null });
    const out = await service.createTypeformForm({ email: EMAIL, payload: { title: 'T' } });

    expect(out).to.eql({ ok: false, missingCredential: true });
    expect(find(calls, 'createForm')).to.equal(undefined);
  });
});
