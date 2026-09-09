'use strict';

/*
 * Typeform reads, req-free, shared by GET /typeform/form and the
 * list_typeform_forms tool.
 *
 * The token lookup is survey.service#typeformToken — the same one
 * create_survey spends — so a researcher who can register a form can always
 * list the forms available to register. A missing credential is not an error
 * here: it is `{ ok: false, missingCredential: true }`, and each caller keeps
 * the answer it has always given (401 over REST, a tool error over MCP).
 */

const { TypeformUtil } = require('../../utils');
const { typeformToken } = require('../surveys/survey.service');

async function listForms({ email }) {
  const token = await typeformToken({ email });
  if (!token) return { ok: false, missingCredential: true };

  return { ok: true, forms: await TypeformUtil.TypeformFormList(token) };
}

module.exports = { listForms };
