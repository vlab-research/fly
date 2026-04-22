'use strict';

const {
  validateCreateInput,
  buildFacebookCreatePayload,
  parseCreateResponse,
  parseListResponse,
  matchFbEntry,
  formatRecord,
} = require('./message-templates.core');

function isUniqueViolation(err) {
  // Postgres / CockroachDB unique_violation
  return err && (err.code === '23505' || /duplicate key|unique constraint/i.test(err.message || ''));
}

function makeHandlers({ credentialQuery, templateQuery, facebookClient }) {
  const { createTemplate, getTemplatesByName, deleteTemplateByHsmId } = facebookClient;

  async function getPageToken(email, pageId) {
    const credential = await credentialQuery.getOne({
      email,
      entity: 'facebook_page',
      key: pageId,
    });
    return credential ? credential.details.access_token : null;
  }

  async function create(req, res) {
    const { email } = req.user;
    const { pageId, name, language, body, buttons, examples } = req.body;

    const validation = validateCreateInput({ pageId, name, language, body, buttons, examples });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    const normalizedButtons = validation.buttons || [];
    const normalizedExamples = validation.examples || [];

    try {
      const pageToken = await getPageToken(email, pageId);
      if (!pageToken) {
        return res.status(404).json({ error: 'Page not found or not connected' });
      }

      const payload = buildFacebookCreatePayload({
        name, language, body, buttons: normalizedButtons, examples: normalizedExamples,
      });
      const fbResponse = await createTemplate(pageId, pageToken, payload);
      const parsed = parseCreateResponse(fbResponse);

      if (!parsed.ok) {
        return res.status(502).json({ error: parsed.error.message || parsed.error });
      }

      const saved = await templateQuery.create({
        email,
        facebookPageId: pageId,
        fbTemplateId: parsed.fbTemplateId,
        name,
        language,
        body,
        status: parsed.status,
        buttons: normalizedButtons,
      });

      return res.status(201).json(formatRecord(saved));
    } catch (e) {
      if (isUniqueViolation(e)) {
        return res.status(409).json({
          error: `A template with name "${name}" in language "${language}" already exists for this page.`,
        });
      }
      console.error('message-templates create error:', e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  async function refreshTemplateStatus(rows, email) {
    // Refresh PENDING rows (status may have changed) and REJECTED rows that
    // still have no reason (Facebook sometimes populates it on a later poll).
    const toRefresh = rows.filter(r => r.status === 'PENDING' || (r.status === 'REJECTED' && !r.rejection_reason));
    if (toRefresh.length === 0) return;

    const pageIds = [...new Set(toRefresh.map(r => r.facebook_page_id))];
    for (const pid of pageIds) {
      const pageToken = await getPageToken(email, pid);
      if (!pageToken) continue;
      const namesToRefresh = [...new Set(toRefresh.filter(r => r.facebook_page_id === pid).map(r => r.name))];
      for (const name of namesToRefresh) {
        try {
          const fbResponse = await getTemplatesByName(pid, pageToken, name);
          const fbEntries = parseListResponse(fbResponse);
          const rowsWithName = toRefresh.filter(r => r.facebook_page_id === pid && r.name === name);
          for (const row of rowsWithName) {
            const entry = matchFbEntry(row, fbEntries);
            const statusChanged = entry && entry.status !== row.status;
            const reasonArrived = entry && entry.rejectionReason && !row.rejection_reason;
            if (statusChanged || reasonArrived) {
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

  async function list(req, res) {
    const { email } = req.user;
    const { pageId } = req.query;

    try {
      const rows = pageId
        ? await templateQuery.list({ email, facebookPageId: pageId })
        : await templateQuery.listAll({ email });

      await refreshTemplateStatus(rows, email);
      return res.status(200).json(rows.map(formatRecord));
    } catch (e) {
      console.error('message-templates list error:', e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  async function remove(req, res) {
    const { email } = req.user;
    const { id } = req.params;

    try {
      const row = await templateQuery.get({ email, id });
      if (!row) {
        return res.status(404).json({ error: 'Template not found' });
      }

      const pageToken = await getPageToken(email, row.facebook_page_id);
      if (!pageToken) {
        return res.status(404).json({ error: 'Page not found or not connected' });
      }

      if (row.fb_template_id) {
        const fbResponse = await deleteTemplateByHsmId(row.facebook_page_id, pageToken, row.fb_template_id);
        if (fbResponse && fbResponse.error) {
          const code = fbResponse.error.code;
          // 100 = template not found; ignore so the local row can be cleaned up
          if (code !== 100) {
            return res.status(502).json({ error: fbResponse.error.message || 'Facebook delete failed' });
          }
        }
      }

      await templateQuery.remove({ email, id });
      return res.status(204).send();
    } catch (e) {
      console.error('message-templates delete error:', e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  async function getOne(req, res) {
    const { email } = req.user;
    const { id } = req.params;
    try {
      const row = await templateQuery.get({ email, id });
      if (!row) return res.status(404).json({ error: 'Template not found' });

      if (row.status === 'PENDING') {
        await refreshTemplateStatus([row], email);
      }

      return res.status(200).json(formatRecord(row));
    } catch (e) {
      console.error('message-templates getOne error:', e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  return { create, list, getOne, remove };
}

module.exports = { makeHandlers };
