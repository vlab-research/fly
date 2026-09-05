'use strict';

/*
 * Pure survey logic. No database, no network, no clock.
 */

/*
 * The row `Survey.create` expects. Kept as one expression, rather than inline
 * in whichever shell is calling, so that "what a survey version is made of" is
 * the same testable thing for POST /surveys and for the MCP create tools.
 */
function buildSurveyRecord({
  formid,
  form,
  messages,
  title,
  userid,
  shortcode,
  survey_name,
  metadata,
  translation_conf,
  created,
}) {
  return {
    formid,
    form,
    messages,
    title,
    userid,
    shortcode,
    survey_name,
    metadata: metadata || {},
    translation_conf: translation_conf || {},
    created,
  };
}

module.exports = { buildSurveyRecord };
