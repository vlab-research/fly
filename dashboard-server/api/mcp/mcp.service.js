/*
 * The imperative shell: everything that touches the database or the network.
 *
 * Creating a survey version is NOT implemented here. It is one shared function
 * in api/surveys/survey.service.js, called by both POST /api/v1/surveys and the
 * create_survey / create_survey_version tools, so the two paths cannot drift.
 *
 * What is here is the MCP-shaped work: authoring a form in Typeform, and the
 * read-modify-write on survey_settings. That read exists because Survey.update
 * is an upsert replacing both columns, so a partial update through it would
 * null the column the caller did not mention. The read is also what turns "not
 * yours" into a specific message: ownership itself is enforced inside the
 * statement, so this is the error message, not the access control.
 */

const { Survey } = require('../../queries');

const {
  SurveyFailure,
  typeformToken,
  registerSurveyVersion,
} = require('../surveys/survey.service');
const { findById, mergeSettings } = require('./mcp.core');
const { createForm } = require('./mcp.typeform');

/*
 * Author a form in the researcher's own Typeform account.
 */
async function createTypeformForm({ email, payload }) {
  const token = await typeformToken({ email });
  if (!token) return { ok: false, missingCredential: true };

  const form = await createForm(token, payload);
  return { ok: true, form };
}

const listSurveys = ({ email }) => Survey.retrieve({ email });

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
  // Re-exported under its old name: mcp.tools only cares about `expected`.
  ToolFailure: SurveyFailure,
  typeformToken,
  listSurveys,
  createTypeformForm,
  registerSurveyVersion,
  updateSettings,
};
