'use strict';

/*
 * Tests for the shared survey-create path used by BOTH POST /api/v1/surveys and
 * the MCP create tools. `queries/` and `utils/` are replaced outright
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

  const service = proxyquire('./survey.service', {
    '../../queries': queries,
    '../../utils': utils,
  });

  return { service, calls };
}

const find = (calls, name) => calls.find(c => c.name === name);

describe('survey.service: Typeform credential', () => {
  it('looks the token up by the same key the dashboard writes it under', async () => {
    const { service, calls } = load();
    await service.typeformToken({ email: EMAIL });

    expect(find(calls, 'Credential.getOne').args).to.eql({
      email: EMAIL,
      entity: 'typeform_token',
      key: `${EMAIL}:typeform`,
    });
  });

  it('returns the token when the credential is there, and null when it is not', async () => {
    expect(await load().service.typeformToken({ email: EMAIL })).to.equal('tf-token');
    expect(await load({ credential: null }).service.typeformToken({ email: EMAIL })).to.equal(null);
  });

  it('treats a credential row with no access_token as no credential', async () => {
    const { service } = load({ credential: { details: {} } });
    expect(await service.typeformToken({ email: EMAIL })).to.equal(null);
  });
});

describe('survey.service: registerSurveyVersion', () => {
  const args = {
    email: EMAIL,
    formid: 'f1',
    shortcode: 'sc',
    survey_name: 'Study',
    title: 'Screener',
    now: new Date('2026-03-01T00:00:00Z'),
  };

  it('writes the row the REST create path writes', async () => {
    const { service, calls } = load();
    const out = await service.registerSurveyVersion(args);

    expect(out.ok).to.equal(true);
    expect(find(calls, 'Survey.create').args).to.eql({
      formid: 'f1',
      form: VALID_FORM,
      messages: '{}',
      title: 'Screener',
      userid: 'user-1',
      shortcode: 'sc',
      survey_name: 'Study',
      metadata: {},
      translation_conf: {},
      created: args.now,
    });
  });

  // The controller passes req.body's translation_conf straight through, and
  // validateTranslation dereferences it — so an omitted value is a TypeError
  // there. Defaulting it is the difference between a 500 and a survey.
  it('defaults translation_conf to {} instead of dereferencing undefined', async () => {
    const { service, calls } = load();
    await service.registerSurveyVersion(args);

    expect(find(calls, 'SurveyUtil.validateTranslation').args.translation_conf).to.eql({});
  });

  it('reports a missing Typeform credential without touching the database', async () => {
    const { service, calls } = load({ credential: null });
    const out = await service.registerSurveyVersion(args);

    expect(out).to.eql({ ok: false, missingCredential: true });
    expect(find(calls, 'Survey.create')).to.equal(undefined);
  });

  /*
   * Typeform answers an unknown form id with a 404 BODY rather than an error,
   * and TypeformForm returns res.text() unconditionally. Without this check the
   * error blob is stored verbatim as a survey definition and the failure only
   * surfaces later, to a participant, as a broken conversation.
   */
  it('refuses to store a Typeform response that is not a form', async () => {
    const { service, calls } = load({
      form: JSON.stringify({ code: 'FORM_NOT_FOUND', description: 'Non existing form' }),
    });

    let error;
    try {
      await service.registerSurveyVersion(args);
    } catch (e) {
      error = e;
    }

    expect(error.expected).to.equal(true);
    expect(error.message).to.match(/Typeform has no form with id "f1"/);
    expect(find(calls, 'Survey.create')).to.equal(undefined);
  });

  it('refuses unparseable Typeform output', async () => {
    const { service } = load({ form: '<html>502</html>' });
    let error;
    try {
      await service.registerSurveyVersion(args);
    } catch (e) {
      error = e;
    }
    expect(error.message).to.match(/unreadable form/);
  });

  it('surfaces a formcentral translation rejection as an expected failure', async () => {
    const { service, calls } = load({ translationError: 'no such destination shortcode' });
    let error;
    try {
      await service.registerSurveyVersion({ ...args, translation_conf: { destination: 'x' } });
    } catch (e) {
      error = e;
    }

    expect(error.expected).to.equal(true);
    expect(error.message).to.match(/no such destination shortcode/);
    expect(find(calls, 'Survey.create')).to.equal(undefined);
  });

  /*
   * Reported as an outcome rather than thrown, so each caller keeps its own
   * status for it: POST /surveys has always answered this with a 404.
   */
  it('reports an unknown researcher rather than writing an orphan row', async () => {
    const { service, calls } = load({ user: null });

    const result = await service.registerSurveyVersion(args);

    expect(result).to.deep.equal({ ok: false, noAccount: true });
    expect(find(calls, 'Survey.create')).to.equal(undefined);
  });
});
