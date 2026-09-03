'use strict';

/*
 * The imperative shell: everything that touches the database or the network.
 *
 * `registerSurveyVersion` is the survey-create path extracted out of
 * `api/surveys/survey.controller.js#postOne` so that create_survey and
 * create_survey_version share exactly one implementation with the REST
 * endpoint's semantics. It is extracted rather than imported because the
 * controller's version is welded to (req, res); the controller itself is owned
 * elsewhere and is left untouched.
 *
 * Two deliberate differences from the controller, both fixing bugs rather than
 * inventing behaviour:
 *
 *   1. `translation_conf` defaults to {}. The controller passes req.body's value
 *      straight into SurveyUtil.validateTranslation, which dereferences it — so
 *      POST /surveys without translation_conf throws a TypeError and 500s. Every
 *      caller today happens to send {}.
 *
 *   2. Settings updates read before they write. `Survey.update` is an upsert
 *      that replaces both columns, so a partial update through it nulls the
 *      column the caller did not mention. The read is also what turns "not
 *      yours" into a specific message: ownership itself is enforced inside the
 *      statement (the query's WHERE clause matches on email), so this is the
 *      error message, not the access control.
 */

const { Survey, User, Credential } = require('../../queries');
const { SurveyUtil, TypeformUtil } = require('../../utils');

const { buildSurveyRecord, findById, mergeSettings } = require('./mcp.core');
const { createForm } = require('./mcp.typeform');

/*
 * A failure an agent can act on, as opposed to a stack trace. Anything thrown
 * with `expected` set is shown to the model verbatim; everything else is logged
 * and reported as an internal error, because unexpected messages leak internals.
 */
class ToolFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolFailure';
    this.expected = true;
  }
}

const fail = message => {
  throw new ToolFailure(message);
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

async function userId({ email }) {
  const user = await User.user({ email });
  if (!user) fail(`No Fly account exists for ${email}.`);
  return user.id;
}

const listSurveys = ({ email }) => Survey.retrieve({ email });

/*
 * Author a form in the researcher's own Typeform account.
 */
async function createTypeformForm({ email, payload }) {
  const token = await typeformToken({ email });
  if (!token) return { ok: false, missingCredential: true };

  const form = await createForm(token, payload);
  return { ok: true, form };
}

/*
 * Insert one survey version. Identical in effect to POST /api/v1/surveys.
 *
 * `now` is a parameter so that the created timestamp — which IS the version
 * ordering key that decides what a participant sees — is injectable and never
 * read from a clock buried three calls down.
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

  let form;
  let messages;
  try {
    form = await TypeformUtil.TypeformForm(token, formid);
    messages = await TypeformUtil.TypeformMessages(token, formid);
  } catch (err) {
    fail(`Could not read Typeform form "${formid}": ${err.message}`);
  }

  // Typeform answers a missing form with a 404 body rather than a throw, so the
  // shape has to be checked here or a "not found" blob gets stored as a survey.
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

/*
 * Read-modify-write on survey_settings.
 *
 * The read serves two purposes: it supplies the current values to merge onto,
 * and it is what makes a bad surveyid a message rather than a crash — the
 * write casts $1::UUID, which throws on anything that is not one, and an id an
 * agent invented is exactly the input that would hit that cast.
 *
 * `Survey.update` enforces ownership in the statement and returns nothing when
 * the survey is not the caller's, so a row that vanishes between the read and
 * the write is reported as not found rather than silently succeeding.
 */
async function updateSettings({ email, surveyid, args }) {
  const surveys = await Survey.retrieve({ email });
  const survey = findById(surveys, surveyid);

  if (!survey) {
    return { ok: false, notFound: true, surveys };
  }

  const settings = mergeSettings(survey, args);
  const updated = await Survey.update({ surveyid, email, ...settings });

  if (!updated) {
    return { ok: false, notFound: true, surveys };
  }

  return { ok: true, survey, settings: updated };
}

module.exports = {
  ToolFailure,
  typeformToken,
  listSurveys,
  createTypeformForm,
  registerSurveyVersion,
  updateSettings,
};
