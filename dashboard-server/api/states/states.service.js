'use strict';

/*
 * Participant-state operations, req-free, shared by the REST controller and
 * the MCP tools. The rule (dashboard-server/README.md "Creating a survey
 * version is one shared function") is that an operation lives with its module
 * and MCP calls it; nothing in here knows about req or res.
 *
 * `resolveSurvey` is the ownership gate. It is the same lookup and the same
 * filtering `validateSurveyNameAccess` has always done — the middleware now
 * calls it — so there is one implementation of "is this survey_name yours,
 * and which shortcodes does it use". The shortcodes matter: the states queries
 * take them as a pre-filter so the version-resolution subquery never scans the
 * whole `states` table (see queries/states/states.queries.js).
 */

const { Survey, States } = require('../../queries');

const distinct = xs => Array.from(new Set(xs));

/*
 * -> { ok: true, email, surveyName, shortcodes }
 * -> { ok: false, notFound: true, known: [survey_name, ...] }
 *
 * `known` is what lets a caller answer "no such survey" with the names that do
 * exist, which is the only message an agent can act on. Not-yours and
 * does-not-exist are deliberately the same answer.
 */
async function resolveSurvey({ email, survey_name }) {
  const surveys = await Survey.retrieve({ email });
  const matching = surveys.filter(s => s.survey_name === survey_name);

  if (!matching.length) {
    return { ok: false, notFound: true, known: distinct(surveys.map(s => s.survey_name)) };
  }

  return {
    ok: true,
    email,
    surveyName: survey_name,
    shortcodes: distinct(matching.map(s => s.shortcode)),
  };
}

// Each takes a resolved survey — the `ok: true` shape above — so the ownership
// check cannot be skipped by accident: there is no way to call these with a
// bare survey_name.
const statesSummary = ({ email, surveyName, shortcodes }) =>
  States.summary(email, surveyName, shortcodes);

const listStates = ({ email, surveyName, shortcodes }, filters) =>
  States.list(email, surveyName, shortcodes, filters);

const stateDetail = ({ email, surveyName, shortcodes }, userid) =>
  States.detail(email, surveyName, shortcodes, userid);

module.exports = { resolveSurvey, statesSummary, listStates, stateDetail };
