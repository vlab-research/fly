'use strict';

/*
 * HTTP shell over message-templates.service.js. Every decision and every
 * Meta call lives in the service; this file maps outcomes onto status codes.
 * `makeHandlers(deps)` keeps the injected-dependency signature the tests and
 * the routes use.
 */

const { makeService } = require('./message-templates.service');

function makeHandlers(deps) {
  const service = makeService(deps);

  // A TemplateFailure carries its own status and a message safe to return;
  // anything else is ours and is logged with the operation that raised it.
  function failed(res, err, operation) {
    if (err && err.expected) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(`message-templates ${operation} error:`, err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }

  async function create(req, res) {
    const { email } = req.user;
    // Support both accountId (new) and legacy pageId parameter for deploy safety
    const accountId = req.body.accountId || req.body.pageId;
    const { name, language, body, buttons, examples } = req.body;

    try {
      const record = await service.createTemplate({
        email, accountId, name, language, body, buttons, examples,
      });
      return res.status(201).json(record);
    } catch (e) {
      return failed(res, e, 'create');
    }
  }

  async function list(req, res) {
    const { email } = req.user;
    // Support both accountId (new) and legacy pageId parameter for deploy safety
    const accountId = req.query.accountId || req.query.pageId;

    try {
      return res.status(200).json(await service.listTemplates({ email, accountId }));
    } catch (e) {
      return failed(res, e, 'list');
    }
  }

  async function remove(req, res) {
    const { email } = req.user;
    const { id } = req.params;

    try {
      await service.deleteTemplate({ email, id });
      return res.status(204).send();
    } catch (e) {
      return failed(res, e, 'delete');
    }
  }

  async function getOne(req, res) {
    const { email } = req.user;
    const { id } = req.params;
    try {
      return res.status(200).json(await service.getTemplate({ email, id }));
    } catch (e) {
      return failed(res, e, 'getOne');
    }
  }

  return { create, list, getOne, remove };
}

module.exports = { makeHandlers };
