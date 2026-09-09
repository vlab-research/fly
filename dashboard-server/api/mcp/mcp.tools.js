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
  // surveys
  list_surveys: 'surveys:read',
  create_typeform_form: 'surveys:write',
  create_survey: 'surveys:write',
  create_survey_version: 'surveys:write',
  update_survey_settings: 'surveys:write',

  // monitoring — states and health live under /surveys/:name over REST, so
  // surveys:read already reaches participant state there; the tools match.
  get_states_summary: 'surveys:read',
  list_states: 'surveys:read',
  get_participant_state: 'surveys:read',
  get_survey_health: 'surveys:read',
  get_platform_notices: 'platform:read',

  // data — `responses` is its own resource so a key can see study structure
  // and participant state without reading people's answers.
  start_export: 'exports:write',
  list_exports: 'exports:read',
  get_responses: 'responses:read',

  // templates and media
  list_message_templates: 'templates:read',
  get_message_template: 'templates:read',
  create_message_template: 'templates:write',
  delete_message_template: 'templates:write',
  list_media: 'media:read',
  upload_media: 'media:write',

  // bails — REST addresses them as /users/:userId/bails, so `users` is the
  // resource. preview_bail changes nothing, but REST derives it from a POST
  // and every scope here is the one its route has; parity is what makes this
  // table auditable against the router.
  list_bails: 'users:read',
  get_bail: 'users:read',
  create_bail: 'users:write',
  update_bail: 'users:write',
  delete_bail: 'users:write',
  preview_bail: 'users:write',
  list_bail_events: 'users:read',


  // accounts. Reads only: no tool writes a credential or mints an API key —
  // those stay in the dashboard, where a human does them (plan section 8).
  // list_typeform_forms is surveys:read because /typeform maps to `surveys`,
  // for the reason ROUTE_RESOURCES gives.
  list_messaging_accounts: 'credentials:read',
  list_typeform_forms: 'surveys:read',
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
  unknownSurveyError,
  buildStatesFilters,
  shapeStatesList,
  noParticipantError,
  validateExportOptions,
  shapeExportRow,
  shapeExportStarted,
  shapeResponsesPage,
  clampLimit,
  GET_RESPONSES_PAGE,
  validateUploadSource,
  decodeBase64,
  shapeUploadResult,
  BAIL_EVENTS_LIMIT,
  buildBailRequest,
  shapeBail,
  shapeBailSummary,
  shapeBailEvents,
  shapeBailPreview,
  redactCredential,
  shapeTypeformForms,
  NO_TYPEFORM_CREDENTIAL_LIST,
} = core;

/*
 * The ownership gate for every survey-scoped tool: resolve the name through
 * the same lookup the REST middleware uses, and answer a miss with the names
 * that exist. `fn` receives the resolved survey and never a bare name.
 */
async function withSurvey(args, email, fn) {
  const resolved = await service.resolveSurvey({ email, survey_name: args.survey_name });
  if (!resolved.ok) return toolError(unknownSurveyError(args.survey_name, resolved.known));
  const { email: owner, surveyName, shortcodes } = resolved;
  return fn({ email: owner, surveyName, shortcodes });
}

/*
 * The bail equivalent of withSurvey. Bails are addressed by user id over REST
 * and the dashboard gets that id by calling POST /users on mount; an agent has
 * no such step and must never see an id, so it is resolved from the caller's
 * email here (get-or-create, exactly what the dashboard does) and every bail
 * operation takes the resolved user.
 */
async function withVlabUser(email, fn) {
  return fn(await service.resolveVlabUser({ email }));
}

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

  // --- monitoring ----------------------------------------------------------

  get_states_summary(args, { email }) {
    return withSurvey(args, email, async survey =>
      toolResult(await service.statesSummary(survey)),
    );
  },

  list_states(args, { email }) {
    return withSurvey(args, email, async survey => {
      const filters = buildStatesFilters(args);
      const result = await service.listStates(survey, filters);
      return toolResult(shapeStatesList(result, filters));
    });
  },

  get_participant_state(args, { email }) {
    return withSurvey(args, email, async survey => {
      const row = await service.stateDetail(survey, args.userid);
      if (!row) return toolError(noParticipantError(args.userid, args.survey_name));
      return toolResult(row);
    });
  },

  get_survey_health(args, { email }) {
    return withSurvey(args, email, async survey =>
      toolResult(await service.healthFindings(survey)),
    );
  },

  async get_platform_notices() {
    return toolResult(await service.platformNotices());
  },

  // --- data ----------------------------------------------------------------

  start_export(args, { email }) {
    // Options are checked against the per-type schema before any IO, and the
    // survey is resolved before the insert so a survey that is not yours is a
    // message rather than a row the exporter would run to nothing.
    const optionErrors = validateExportOptions(args.export_type, args.options);
    if (optionErrors.length) return invalidArgsError(optionErrors);

    return withSurvey(args, email, async () => {
      const started = await service.startExport({
        email,
        survey_name: args.survey_name,
        export_type: args.export_type,
        options: args.options || {},
      });
      return toolResult(shapeExportStarted(started, args.survey_name));
    });
  },

  async list_exports(args, { email }) {
    const list = async () => {
      const rows = await service.listExports({ email, survey_name: args.survey_name });
      return toolResult({ count: rows.length, items: rows.map(shapeExportRow) });
    };
    return args.survey_name ? withSurvey(args, email, list) : list();
  },

  get_responses(args, { email }) {
    return withSurvey(args, email, async () => {
      const pageSize = clampLimit(args.page_size, GET_RESPONSES_PAGE);
      const { responses } = await service.getResponses({
        email,
        survey_name: args.survey_name,
        after: args.after || null,
        pageSize,
      });
      return toolResult(shapeResponsesPage(responses, pageSize));
    });
  },

  // --- templates -----------------------------------------------------------

  async list_message_templates(args, { email }) {
    const items = await service.listTemplates({ email, accountId: args.account_id });
    return toolResult({ count: items.length, items });
  },

  async get_message_template(args, { email }) {
    return toolResult(await service.getTemplate({ email, id: args.id }));
  },

  async create_message_template(args, { email }) {
    const record = await service.createTemplate({
      email,
      accountId: args.account_id,
      name: args.name,
      language: args.language,
      body: args.body,
      buttons: args.buttons,
      examples: args.examples,
    });
    return toolResult({
      ...record,
      note:
        record.status === 'APPROVED'
          ? 'Meta approved the template immediately; it can be sent now.'
          : `Submitted to Meta with status ${record.status}. Approval is asynchronous — ` +
            'call list_message_templates or get_message_template to see it become ' +
            'APPROVED or REJECTED (with a rejection_reason).',
    });
  },

  async delete_message_template(args, { email }) {
    const deleted = await service.deleteTemplate({ email, id: args.id });
    return toolResult({
      deleted,
      note: 'Removed at Meta and in Fly. Any survey question still naming this template will fail to send.',
    });
  },

  // --- media ---------------------------------------------------------------

  async list_media(args, { email }) {
    const items = await service.listAssets({ email });
    return toolResult({ count: items.length, items });
  },

  async upload_media(args, { email }) {
    const source = validateUploadSource(args);
    if (!source.ok) return invalidArgsError(source.errors);

    let buffer;
    let mimetype = args.mime_type;
    if (source.source === 'url') {
      const fetched = await service.fetchSource(source.url);
      buffer = fetched.buffer;
      mimetype = mimetype || fetched.contentType || undefined;
    } else {
      buffer = decodeBase64(args.content_base64);
    }

    const result = await service.uploadAsset({
      email,
      file: { buffer, originalname: args.filename, mimetype },
    });
    if (!result.ok) return toolError(`Refused: ${result.error}. Nothing was stored.`);

    // Best-effort platform copies, never awaited: a handle is an optimisation
    // (media.service.js), and the reconciler backfills whatever this misses.
    result.fanOut();

    return toolResult(shapeUploadResult(result));
  },

  // --- bails ---------------------------------------------------------------

  list_bails(args, { email }) {
    return withVlabUser(email, async user => {
      const result = await service.listBails(user);
      const rows = (result && result.bails) || [];
      return toolResult({ count: rows.length, items: rows.map(shapeBailSummary) });
    });
  },

  get_bail(args, { email }) {
    return withVlabUser(email, async user =>
      toolResult(shapeBail(await service.getBail(user, args.bail_id))),
    );
  },

  create_bail(args, { email }) {
    const built = buildBailRequest(args);
    if (!built.ok) return invalidArgsError(built.errors);

    return withVlabUser(email, async user => {
      const row = await service.createBail(user, built.request);
      return toolResult({
        created: shapeBail(row),
        note: args.enabled
          ? 'ENABLED: it will fire on the schedule above and move whoever matches. ' +
            'Watch list_bail_events for what it actually did.'
          : 'Created disabled — nothing has moved. Enable it with update_bail once ' +
            'preview_bail shows the count you expect.',
      });
    });
  },

  update_bail(args, { email }) {
    const { bail_id: bailId, ...changes } = args;

    if (!Object.keys(changes).length) {
      return toolError(
        'Nothing to change: pass at least one of `name`, `description`, `definition`, ' +
          '`destination_form` or `enabled`.',
      );
    }

    const built = buildBailRequest(changes);
    if (!built.ok) return invalidArgsError(built.errors);

    return withVlabUser(email, async user => {
      const row = await service.updateBail(user, bailId, built.request);
      return toolResult({
        updated: shapeBail(row),
        note: changes.enabled === true
          ? 'Now enabled: it will fire on the schedule above and move whoever matches.'
          : changes.enabled === false
            ? 'Now disabled: it will not fire again. Participants it already moved stay ' +
              'where it put them.'
            : 'Changed. Anything it already did is unaffected.',
      });
    });
  },

  delete_bail(args, { email }) {
    return withVlabUser(email, async user => {
      await service.deleteBail(user, args.bail_id);
      return toolResult({
        deleted: args.bail_id,
        note:
          'Gone, with its event history. Participants it already moved stay where it ' +
          'put them.',
      });
    });
  },

  preview_bail(args, { email }) {
    // Built through the same function create_bail uses, so a definition that
    // previews cleanly is one that can be created unchanged.
    const built = buildBailRequest({ definition: args.definition });
    if (!built.ok) return invalidArgsError(built.errors);

    return withVlabUser(email, async user =>
      toolResult(shapeBailPreview(await service.previewBail(user, built.request.definition))),
    );
  },

  list_bail_events(args, { email }) {
    return withVlabUser(email, async user => {
      const limit = clampLimit(args.limit, BAIL_EVENTS_LIMIT);

      // The per-bail endpoint returns the whole history and takes no limit, so
      // that page is cut here; the user-wide one is limited in the query.
      const result = args.bail_id
        ? await service.bailEvents(user, args.bail_id)
        : await service.userBailEvents(user, limit);

      return toolResult(shapeBailEvents(result && result.events, limit));
    });
  },

  // --- accounts ------------------------------------------------------------

  async list_messaging_accounts(args, { email }) {
    const rows = await service.listMessagingAccounts({ email });
    // Redaction is a pure function with a recursive no-secret test: nothing
    // from the credential's `details` blob leaves here but a display name.
    return toolResult({ count: rows.length, items: rows.map(redactCredential) });
  },

  async list_typeform_forms(args, { email }) {
    const result = await service.listTypeformForms({ email });
    if (!result.ok) return toolError(NO_TYPEFORM_CREDENTIAL_LIST);
    return toolResult(shapeTypeformForms(result.forms));
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
