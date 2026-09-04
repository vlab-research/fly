'use strict';

/*
 * Creating one survey version — the single implementation, used by both
 * POST /api/v1/surveys and the MCP create_survey / create_survey_version tools.
 *
 * It lives here rather than in api/mcp because it is a survey operation that
 * MCP happens to call, not the other way round: the dependency runs
 * mcp -> surveys, and never back.
 *
 * Nothing here knows about req or res. Callers map the outcome onto their own
 * protocol: the controller onto status codes, the MCP dispatcher onto tool
 * errors. Failures come in two kinds and the distinction is the whole contract:
 *
 *   - SurveyFailure (`expected` set) is the caller's fault and its message is
 *     safe to show them verbatim.
 *   - anything else is ours, and callers must not echo it — unexpected messages
 *     leak internals.
 */

const { Survey, User, Credential } = require('../../queries');
const { SurveyUtil, TypeformUtil } = require('../../utils');
const { buildSurveyRecord } = require('./survey.core');

class SurveyFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'SurveyFailure';
    this.expected = true;
  }
}

const fail = message => {
  throw new SurveyFailure(message);
};

async function typeformToken({ email }) {
  const cred = await Credential.getOne({
    email,
    entity: 'typeform_token',
    key: TypeformUtil.makeKey(email),
  });

  const token = cred && cred.details && cred.details.access_token;
  return token || null;
}

// Returns null rather than failing, so callers keep their own status for it —
// POST /surveys has always answered a missing account with 404.
async function userId({ email }) {
  const user = await User.user({ email });
  return user ? user.id : null;
}

/*
 * Insert one survey version.
 *
 * `now` is a parameter so that the created timestamp — which IS the version
 * ordering key deciding what a participant sees — is injectable and never read
 * from a clock buried three calls down.
 */
async function registerSurveyVersion({
  email,
  formid,
  shortcode,
  survey_name,
  title,
  metadata,
  translation_conf,
  now = new Date(),
}) {
  const token = await typeformToken({ email });
  if (!token) return { ok: false, missingCredential: true };

  const userid = await userId({ email });
  if (!userid) return { ok: false, noAccount: true };

  let form;
  let messages;
  try {
    form = await TypeformUtil.TypeformForm(token, formid);
    messages = await TypeformUtil.TypeformMessages(token, formid);
  } catch (err) {
    fail(`Could not read Typeform form "${formid}": ${err.message}`);
  }

  // Typeform answers a missing form with a 404 body rather than a throw, so the
  // shape has to be checked here or a "not found" blob gets stored as a survey
  // and only surfaces later as a broken participant conversation.
  let parsed;
  try {
    parsed = JSON.parse(form);
  } catch (err) {
    fail(`Typeform returned an unreadable form for "${formid}": ${form}`);
  }
  if (!parsed || !parsed.id) {
    fail(
      `Typeform has no form with id "${formid}" for this account, or it is not ` +
        `readable with the connected token. Response: ${form}`,
    );
  }

  // Defaulted because SurveyUtil.validateTranslation dereferences it: passing
  // an absent value straight through is a TypeError, not a validation failure.
  const conf = translation_conf || {};
  const translationError = await SurveyUtil.validateTranslation({ form, translation_conf: conf });
  if (translationError) {
    fail(`translation_conf is not valid: ${translationError}`);
  }

  const record = buildSurveyRecord({
    formid,
    form,
    messages,
    title,
    userid,
    shortcode,
    survey_name,
    metadata,
    translation_conf: conf,
    created: now,
  });

  try {
    SurveyUtil.validate(record);
  } catch (err) {
    fail(err.message);
  }

  const created = await Survey.create(record);
  return { ok: true, survey: created };
}

module.exports = {
  SurveyFailure,
  fail,
  typeformToken,
  userId,
  registerSurveyVersion,
  NO_TYPEFORM_CREDENTIAL:
    'No Typeform account is connected to this Fly account. Connect one in the ' +
    'dashboard before creating a survey.',
};
