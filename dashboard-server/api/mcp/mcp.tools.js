'use strict';

/*
 * The tool table: one thin async function per tool.
 *
 * Each one is the same three steps — decide with the pure core, do the IO in
 * the service, shape the answer with the pure core again. Anything that looks
 * like reasoning in here should be a function in mcp.core.js instead.
 */

const core = require('./mcp.core');
const service = require('./mcp.service');
const { scopeGrants } = require('../auth/auth.core');

/*
 * The scope each tool actually needs.
 *
 * The auth middleware cannot enforce this: /mcp is one POST and the tool name
 * is in the body, so it marks /mcp delegated and leaves the caller's scopes on
 * req.apiScopes for us. This table is therefore the ONLY scope check a tool
 * call gets, and a tool with no entry here is denied rather than allowed.
 *
 * create_typeform_form is surveys:write because authoring the questions is
 * authoring the survey; the Typeform credential it spends is the researcher's
 * own and is not otherwise readable through this endpoint.
 */
const TOOL_SCOPES = {
  list_surveys: 'surveys:read',
  create_typeform_form: 'surveys:write',
  create_survey: 'surveys:write',
  create_survey_version: 'surveys:write',
  update_survey_settings: 'surveys:write',
};

// Absent scopes are unrestricted, matching the middleware exactly.
function toolAllowed(scopes, name) {
  if (scopes === null || scopes === undefined) return true;
  const required = TOOL_SCOPES[name];
  if (!required) return false;
  return scopes.some(granted => scopeGrants(granted, required));
}

const {
  toolResult,
  toolError,
  invalidArgsError,
  validateToolArgs,
  summariseSurveys,
  surveyNameExists,
  resolvePreviousVersion,
  buildVersionRequest,
  validateFormSpec,
  buildTypeformCreatePayload,
  NO_TYPEFORM_CREDENTIAL,
  NO_FLY_ACCOUNT,
} = core;

// Everything a tool says about a survey it just wrote. `version` is computed
// rather than stored, so it is recomputed from the full list every time.
function describeSurvey(survey, allRows) {
  const sameForm = allRows.filter(
    r => r.survey_name === survey.survey_name && r.shortcode === survey.shortcode,
  );

  return {
    id: survey.id,
    survey_name: survey.survey_name,
    shortcode: survey.shortcode,
    title: survey.title,
    formid: survey.formid,
    created: survey.created,
    version: sameForm.length,
  };
}

const TOOL_HANDLERS = {
  async list_surveys(args, { email }) {
    const rows = await service.listSurveys({ email });
    const summary = summariseSurveys(rows, { survey_name: args.survey_name });

    if (args.survey_name && !summary.survey_count) {
      const known = summariseSurveys(rows).surveys.map(s => s.survey_name);
      return toolError(
        `No survey named "${args.survey_name}". ` +
          (known.length
            ? `Your surveys are: ${known.map(n => `"${n}"`).join(', ')}.`
            : 'You have no surveys yet.'),
      );
    }

    return toolResult(summary);
  },

  async create_typeform_form(args, { email }) {
    const specErrors = validateFormSpec(args);
    if (specErrors.length) return invalidArgsError(specErrors);

    const payload = buildTypeformCreatePayload(args);
    const result = await service.createTypeformForm({ email, payload });

    if (result.missingCredential) return toolError(NO_TYPEFORM_CREDENTIAL);

    return toolResult({
      formid: result.form.id,
      url: result.form.url,
      title: result.form.title,
      field_count: payload.fields.length,
      next_step:
        'The form exists in Typeform but is not a Fly survey yet. Call create_survey ' +
        `with formid "${result.form.id}" plus a survey_name, shortcode and title to ` +
        'make it live.',
    });
  },

  async create_survey(args, { email }) {
    const rows = await service.listSurveys({ email });

    if (surveyNameExists(rows, args.survey_name)) {
      return toolError(
        `A survey named "${args.survey_name}" already exists. Creating a second one ` +
          'under the same name is not how you publish a revision — call ' +
          `create_survey_version with survey_name "${args.survey_name}" instead, or ` +
          'pick a different survey_name if this really is a new study.',
      );
    }

    const result = await service.registerSurveyVersion({ email, ...args });
    if (result.noAccount) return toolError(NO_FLY_ACCOUNT);
    if (result.missingCredential) return toolError(NO_TYPEFORM_CREDENTIAL);

    return toolResult({
      created: describeSurvey(result.survey, rows.concat(result.survey)),
      note:
        'This survey version is now live and immutable. To change the questions, edit ' +
        'the form in Typeform and call create_survey_version — the row you just created ' +
        'keeps serving participants who already started it.',
    });
  },

  async create_survey_version(args, { email }) {
    const rows = await service.listSurveys({ email });

    const resolved = resolvePreviousVersion(rows, args);
    if (!resolved.ok) return toolError(resolved.error);

    const request = buildVersionRequest(resolved.previous, args);
    const result = await service.registerSurveyVersion({ email, ...request });
    if (result.noAccount) return toolError(NO_FLY_ACCOUNT);
    if (result.missingCredential) return toolError(NO_TYPEFORM_CREDENTIAL);

    return toolResult({
      created: describeSurvey(result.survey, rows.concat(result.survey)),
      replaces: {
        id: resolved.previous.id,
        created: resolved.previous.created,
        formid: resolved.previous.formid,
      },
      note:
        'Participants who already started the previous version stay on it; only new ' +
        'participants get this one. Survey settings (timeouts, off_time) attach to a ' +
        'version id and were NOT carried over — re-apply them with ' +
        'update_survey_settings if the previous version had any.',
    });
  },

  async update_survey_settings(args, { email }) {
    const { surveyid, ...settings } = args;

    if (settings.timeouts === undefined && settings.off_time === undefined) {
      return toolError(
        'Nothing to change: pass `timeouts`, `off_time`, or both. Pass an explicit null ' +
          'to clear one.',
      );
    }

    const result = await service.updateSettings({ email, surveyid, args: settings });

    if (result.notFound) {
      return toolError(
        `No survey version with id "${surveyid}" belongs to you. Settings attach to a ` +
          'single version row — use the `id` from list_surveys, not a survey_name or a ' +
          'shortcode.',
      );
    }

    return toolResult({
      surveyid,
      survey_name: result.survey.survey_name,
      shortcode: result.survey.shortcode,
      timeouts: result.settings.timeouts,
      off_time: result.settings.off_time,
      retired: !!result.settings.off_time,
    });
  },
};

/*
 * Validate, dispatch, and make sure no failure ever escapes as a transport
 * error: an MCP tool error is a normal result with isError set, which the model
 * can read and correct. A thrown exception is just a dead turn.
 */
async function runTool(name, args, context) {
  const validation = validateToolArgs(name, args);
  if (!validation.ok) return invalidArgsError(validation.errors);

  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return toolError(
      `Unknown tool "${name}". Available: ${Object.keys(TOOL_HANDLERS).join(', ')}`,
    );
  }

  // Said as a tool error rather than a transport 403 so the model can read why
  // it was refused and stop retrying, instead of seeing a dead turn.
  if (!toolAllowed(context && context.scopes, name)) {
    return toolError(
      `This API key is not permitted to use "${name}". It needs the ` +
        `${TOOL_SCOPES[name] || 'required'} scope; it has ` +
        `${(context.scopes || []).join(', ') || 'no scopes'}.`,
    );
  }

  try {
    return await handler(args || {}, context);
  } catch (err) {
    if (err && err.expected) return toolError(err.message);

    console.error(`[mcp] tool "${name}" failed for ${context && context.email}:`, err);
    return toolError(
      `The "${name}" tool failed unexpectedly: ${err && err.message}. Nothing was ` +
        'changed by the failing step.',
    );
  }
}

module.exports = { runTool, TOOL_HANDLERS, TOOL_SCOPES, toolAllowed, describeSurvey };
