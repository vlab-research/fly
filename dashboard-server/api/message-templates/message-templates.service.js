'use strict';

/*
 * Utility-message template operations, req-free, shared by the REST handlers
 * (message-templates.controller.js) and the MCP tools.
 *
 * `makeService(deps)` keeps the dependency injection the controller always
 * had — credential and template queries plus the two Meta clients — so the
 * existing controller tests drive exactly this code through makeHandlers.
 * The real deps are built once in message-templates.deps.js.
 *
 * Failures are TemplateFailure (`expected`, with the HTTP status the REST
 * layer answers): the caller's own bad input, a missing account, or Meta
 * refusing. Anything else is ours and callers must not echo it.
 */

const {
  validateCreateInput,
  buildFacebookCreatePayload,
  buildWhatsAppCreatePayload,
  resolveWabaId,
  parseCreateResponse,
  parseListResponse,
  matchFbEntry,
  formatRecord,
} = require('./message-templates.core');

class TemplateFailure extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TemplateFailure';
    this.expected = true;
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new TemplateFailure(message, status);
};

function isUniqueViolation(err) {
  // Postgres / CockroachDB unique_violation
  return err && (err.code === '23505' || /duplicate key|unique constraint/i.test(err.message || ''));
}

function makeService({ credentialQuery, templateQuery, facebookClient, whatsappClient }) {
  const { createTemplate, getTemplatesByName, deleteTemplateByHsmId } = facebookClient;
  const waClient = whatsappClient || {};

  // Resolves the messaging account behind accountId and returns
  // platform-appropriate template operations bound to the right Meta id and
  // token. Messenger operations are identical to the original page-token
  // path (Graph calls against the page id with the page access token).
  // WhatsApp template CRUD is a WABA-level API: operations run against the
  // WABA id resolved from the whatsapp_business credential's
  // details.waba_id, using the credential's stored business access token.
  // A whatsapp_business credential without waba_id fails loudly (400) —
  // no silent fallback.
  async function resolveAccountOps(email, accountId) {
    const page = await credentialQuery.getOne({
      email,
      entity: 'facebook_page',
      key: accountId,
    });
    if (page) {
      const token = page.details && page.details.access_token;
      if (!token) return { ok: false, status: 404, error: 'Page not found or not connected' };
      return {
        ok: true,
        platform: 'messenger',
        buildCreatePayload: buildFacebookCreatePayload,
        createTemplate: payload => createTemplate(accountId, token, payload),
        getTemplatesByName: name => getTemplatesByName(accountId, token, name),
        // Messenger delete-by-id needs only hsm_id.
        deleteTemplate: row => deleteTemplateByHsmId(accountId, token, row.fb_template_id),
      };
    }

    const wa = await credentialQuery.getOne({
      email,
      entity: 'whatsapp_business',
      key: accountId,
    });
    if (wa) {
      const token = wa.details && wa.details.access_token;
      if (!token) return { ok: false, status: 404, error: 'Page not found or not connected' };
      const waba = resolveWabaId(wa);
      if (!waba.ok) return { ok: false, status: 400, error: waba.error };
      return {
        ok: true,
        platform: 'whatsapp',
        buildCreatePayload: buildWhatsAppCreatePayload,
        createTemplate: payload => waClient.createTemplate(waba.wabaId, token, payload),
        getTemplatesByName: name => waClient.getTemplatesByName(waba.wabaId, token, name),
        // WhatsApp delete-by-id requires BOTH hsm_id and name.
        deleteTemplate: row => waClient.deleteTemplateByHsmId(waba.wabaId, token, row.fb_template_id, row.name),
      };
    }

    return { ok: false, status: 404, error: 'Page not found or not connected' };
  }

  async function requireAccount(email, accountId) {
    const account = await resolveAccountOps(email, accountId);
    if (!account.ok) fail(account.status, account.error);
    return account;
  }

  // Submits the template to Meta for approval and records it. Returns the
  // formatted record, whose `status` is whatever Meta answered (PENDING, or
  // APPROVED when it auto-approved).
  async function createTemplateRecord({ email, accountId, name, language, body, buttons, examples }) {
    const validation = validateCreateInput({ accountId, name, language, body, buttons, examples });
    if (!validation.valid) fail(400, validation.error);
    const normalizedButtons = validation.buttons || [];
    const normalizedExamples = validation.examples || [];

    const account = await requireAccount(email, accountId);

    const payload = account.buildCreatePayload({
      name, language, body, buttons: normalizedButtons, examples: normalizedExamples,
    });
    const fbResponse = await account.createTemplate(payload);
    const parsed = parseCreateResponse(fbResponse);

    if (!parsed.ok) fail(502, parsed.error.message || parsed.error);

    let saved;
    try {
      saved = await templateQuery.create({
        email,
        accountId,
        fbTemplateId: parsed.fbTemplateId,
        name,
        language,
        body,
        status: parsed.status,
        rejectionReason: parsed.rejectionReason,
        buttons: normalizedButtons,
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        fail(409, `A template with name "${name}" in language "${language}" already exists for this page.`);
      }
      throw e;
    }

    return formatRecord(saved);
  }

  async function refreshTemplateStatus(rows, email) {
    // Only PENDING rows can transition — Facebook's GET endpoint never returns
    // rejection_reason or specific_rejection_reason, so polling REJECTED rows
    // is useless. Rejection reasons are captured from the create response only.
    const pending = rows.filter(r => r.status === 'PENDING');
    if (pending.length === 0) return;

    const accountIds = [...new Set(pending.map(r => r.account_id))];
    for (const aid of accountIds) {
      const account = await resolveAccountOps(email, aid);
      if (!account.ok) continue;
      const namesToRefresh = [...new Set(pending.filter(r => r.account_id === aid).map(r => r.name))];
      for (const name of namesToRefresh) {
        try {
          const fbResponse = await account.getTemplatesByName(name);
          const fbEntries = parseListResponse(fbResponse);
          const rowsWithName = pending.filter(r => r.account_id === aid && r.name === name);
          for (const row of rowsWithName) {
            const entry = matchFbEntry(row, fbEntries);
            if (entry && entry.status !== row.status) {
              const updated = await templateQuery.updateStatus({
                id: row.id,
                status: entry.status,
                rejectionReason: entry.rejectionReason,
                fbTemplateId: entry.fbTemplateId,
              });
              Object.assign(row, updated);
            }
          }
        } catch (refreshErr) {
          console.error(`Failed to refresh template status for "${name}":`, refreshErr);
        }
      }
    }
  }

  // Formatted rows, PENDING ones refreshed from Meta first (best-effort).
  async function listTemplates({ email, accountId }) {
    const rows = accountId
      ? await templateQuery.list({ email, accountId })
      : await templateQuery.listAll({ email });

    await refreshTemplateStatus(rows, email);
    return rows.map(formatRecord);
  }

  async function getTemplate({ email, id }) {
    const row = await templateQuery.get({ email, id });
    if (!row) fail(404, 'Template not found');

    if (row.status === 'PENDING') {
      await refreshTemplateStatus([row], email);
    }

    return formatRecord(row);
  }

  // Deletes at Meta first, then locally. Meta's "template not found" (code
  // 100) is swallowed so an orphaned row can still be cleaned up.
  async function deleteTemplate({ email, id }) {
    const row = await templateQuery.get({ email, id });
    if (!row) fail(404, 'Template not found');

    const account = await requireAccount(email, row.account_id);

    if (row.fb_template_id) {
      const fbResponse = await account.deleteTemplate(row);
      if (fbResponse && fbResponse.error) {
        const code = fbResponse.error.code;
        if (code !== 100) {
          fail(502, fbResponse.error.message || 'Facebook delete failed');
        }
      }
    }

    await templateQuery.remove({ email, id });
    return { id, name: row.name, language: row.language };
  }

  return {
    createTemplate: createTemplateRecord,
    listTemplates,
    getTemplate,
    deleteTemplate,
    refreshTemplateStatus,
  };
}

module.exports = { makeService, TemplateFailure, isUniqueViolation };
