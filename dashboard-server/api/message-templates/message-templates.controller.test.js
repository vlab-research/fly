'use strict';

const chai = require('chai');
chai.should();

const { makeHandlers } = require('./message-templates.controller');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res.body = data; return res; },
    send(data) { res.body = data; return res; },
  };
  return res;
}

describe('message-templates.controller (makeHandlers)', () => {
  const email = 'test@vlab.com';
  const pageId = 'page1';
  const validBody = { pageId, name: 'prize_ready', language: 'en_US', body: 'Hi {{1}}' };
  const validReq = { user: { email }, body: validBody };

  // Default mocks — all happy-path, overridden per test as needed
  const defaultCredentialQuery = {
    getOne: async () => ({
      entity: 'facebook_page', key: pageId,
      details: { id: pageId, name: 'Test Page', access_token: 'tok123' },
    }),
  };
  const defaultTemplateQuery = {
    create: async (record) => ({
      id: 'uuid-new',
      facebook_page_id: record.facebookPageId,
      fb_template_id: record.fbTemplateId,
      name: record.name,
      language: record.language,
      body: record.body,
      status: record.status,
      rejection_reason: null,
      created: '2026-04-18T00:00:00Z',
      updated: '2026-04-18T00:00:00Z',
    }),
    list: async () => [],
    get: async ({ id }) => ({
      id,
      facebook_page_id: pageId,
      fb_template_id: 'fb_abc',
      name: 'prize_ready',
      language: 'en_US',
      status: 'APPROVED',
    }),
    updateStatus: async ({ id, status, rejectionReason, fbTemplateId }) => ({
      id, status, rejection_reason: rejectionReason, fb_template_id: fbTemplateId,
    }),
    remove: async ({ id }) => ({ id }),
  };
  const defaultFacebookClient = {
    createTemplate: async () => ({ id: 'fb_abc', status: 'APPROVED' }),
    getTemplatesByName: async () => ({ data: [] }),
    deleteTemplateByHsmId: async () => ({ success: true }),
  };

  function makeTestHandlers(overrides = {}) {
    return makeHandlers({
      credentialQuery: overrides.credentialQuery || defaultCredentialQuery,
      templateQuery: overrides.templateQuery || defaultTemplateQuery,
      facebookClient: overrides.facebookClient || defaultFacebookClient,
    });
  }

  // -------------------------------------------------------
  // create
  // -------------------------------------------------------
  describe('create', () => {
    it('returns 400 when validation fails (missing name)', async () => {
      const res = mockRes();
      await makeTestHandlers().create(
        { user: { email }, body: { ...validBody, name: undefined } },
        res,
      );
      res.statusCode.should.equal(400);
      res.body.error.should.include('name');
    });

    it('returns 400 when name is not snake_case', async () => {
      const res = mockRes();
      await makeTestHandlers().create(
        { user: { email }, body: { ...validBody, name: 'BadName' } },
        res,
      );
      res.statusCode.should.equal(400);
    });

    it('returns 404 when the page credential is not connected', async () => {
      const res = mockRes();
      await makeTestHandlers({
        credentialQuery: { getOne: async () => null },
      }).create(validReq, res);
      res.statusCode.should.equal(404);
      res.body.error.should.include('Page not found');
    });

    it('returns 502 with FB error message when Facebook rejects the template', async () => {
      const res = mockRes();
      await makeTestHandlers({
        facebookClient: { ...defaultFacebookClient, createTemplate: async () => ({ error: { message: 'Invalid body', code: 100 } }) },
      }).create(validReq, res);
      res.statusCode.should.equal(502);
      res.body.error.should.include('Invalid body');
    });

    it('returns 201 with formatted record on success', async () => {
      const res = mockRes();
      await makeTestHandlers().create(validReq, res);
      res.statusCode.should.equal(201);
      res.body.should.have.property('id', 'uuid-new');
      res.body.should.have.property('fb_template_id', 'fb_abc');
      res.body.should.have.property('status', 'APPROVED');
      res.body.should.not.have.property('userid');
    });

    it('persists the FB-returned status (APPROVED) so auto-approvals skip PENDING', async () => {
      // FB often auto-approves custom UTILITY templates in seconds and returns APPROVED
      // on the initial POST. We must persist that, not blindly set PENDING.
      let captured;
      await makeTestHandlers({
        templateQuery: { ...defaultTemplateQuery, create: async (r) => { captured = r; return { id: 'u', ...r, status: r.status }; } },
      }).create(validReq, mockRes());
      captured.status.should.equal('APPROVED');
    });

    it('defaults to PENDING when FB does not return a status', async () => {
      let captured;
      await makeTestHandlers({
        facebookClient: { ...defaultFacebookClient, createTemplate: async () => ({ id: 'fb' }) },
        templateQuery: { ...defaultTemplateQuery, create: async (r) => { captured = r; return { id: 'u', ...r }; } },
      }).create(validReq, mockRes());
      captured.status.should.equal('PENDING');
    });

    it('returns 409 when the (page, name, language) already exists', async () => {
      // Identity of a template is (page, name, language). Duplicate inserts must 409
      // with a message that names BOTH the name and the language — otherwise authors
      // can\'t tell they collided with a sibling-language variant.
      const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      const res = mockRes();
      await makeTestHandlers({
        templateQuery: { ...defaultTemplateQuery, create: async () => { throw pgError; } },
      }).create(validReq, res);
      res.statusCode.should.equal(409);
      res.body.error.should.include('prize_ready');
      res.body.error.should.include('en_US');
    });

    it('returns 500 on an unexpected DB error', async () => {
      const res = mockRes();
      await makeTestHandlers({
        templateQuery: { ...defaultTemplateQuery, create: async () => { throw new Error('DB down'); } },
      }).create(validReq, res);
      res.statusCode.should.equal(500);
    });

    it('passes the correct page token to the Facebook client', async () => {
      let captured;
      await makeTestHandlers({
        facebookClient: {
          ...defaultFacebookClient,
          createTemplate: async (pid, token) => { captured = { pid, token }; return { id: 'fb', status: 'APPROVED' }; },
        },
      }).create(validReq, mockRes());
      captured.pid.should.equal(pageId);
      captured.token.should.equal('tok123');
    });

    it('threads buttons through FB create + DB insert when supplied', async () => {
      // End-to-end: buttons in the request body land on BOTH the FB payload
      // (as a BUTTONS component with QUICK_REPLY entries) AND the DB record
      // (as the stored buttons JSONB). If this routing breaks, button-less
      // templates would leak through silently.
      let fbPayload;
      let dbRecord;
      const res = mockRes();
      await makeTestHandlers({
        facebookClient: {
          ...defaultFacebookClient,
          createTemplate: async (pid, token, payload) => { fbPayload = payload; return { id: 'fb', status: 'APPROVED' }; },
        },
        templateQuery: {
          ...defaultTemplateQuery,
          create: async (r) => { dbRecord = r; return { id: 'u', ...r, buttons: r.buttons }; },
        },
      }).create(
        { user: { email }, body: { ...validBody, buttons: [{ label: '  Yes  ' }, { label: 'No' }] } },
        res,
      );

      res.statusCode.should.equal(201);
      fbPayload.components.should.have.length(2);
      fbPayload.components[1].buttons.should.deep.equal([
        { type: 'QUICK_REPLY', text: 'Yes' },
        { type: 'QUICK_REPLY', text: 'No' },
      ]);
      dbRecord.buttons.should.deep.equal([{ label: 'Yes' }, { label: 'No' }]);
    });

    it('returns 400 with the validation error when buttons violate constraints', async () => {
      const res = mockRes();
      await makeTestHandlers().create(
        { user: { email }, body: { ...validBody, buttons: [{ label: 'Yes' }, { label: 'Yes' }] } },
        res,
      );
      res.statusCode.should.equal(400);
      res.body.error.should.include('duplicate');
    });
  });

  // -------------------------------------------------------
  // list
  // -------------------------------------------------------
  describe('list', () => {
    const listReq = { user: { email }, query: { pageId } };

    it('returns 400 when pageId query param is missing', async () => {
      const res = mockRes();
      await makeTestHandlers().list({ user: { email }, query: {} }, res);
      res.statusCode.should.equal(400);
      res.body.error.should.include('pageId');
    });

    it('returns 200 with the formatted row list', async () => {
      const rows = [{
        id: 'u1', facebook_page_id: pageId, fb_template_id: 'fb1',
        name: 'prize', language: 'en_US', body: 'hi', status: 'APPROVED',
        rejection_reason: null, created: 't', updated: 't',
      }];
      const res = mockRes();
      await makeTestHandlers({
        templateQuery: { ...defaultTemplateQuery, list: async () => rows },
      }).list(listReq, res);
      res.statusCode.should.equal(200);
      res.body.should.have.length(1);
      res.body[0].should.not.have.property('userid');
    });

    it('does NOT call Facebook when every row is already terminal (APPROVED/REJECTED)', async () => {
      // Polling should stop hitting FB once no rows are PENDING — otherwise we'd
      // hammer their API forever just to re-confirm APPROVED status
      let called = false;
      await makeTestHandlers({
        templateQuery: {
          ...defaultTemplateQuery,
          list: async () => [{ id: '1', name: 'p', language: 'en_US', status: 'APPROVED', facebook_page_id: pageId }],
        },
        facebookClient: { ...defaultFacebookClient, getTemplatesByName: async () => { called = true; return { data: [] }; } },
      }).list(listReq, mockRes());
      called.should.equal(false);
    });

    it('refreshes PENDING rows from Facebook and updates matching (name, language) entries', async () => {
      const row = {
        id: 'u1', facebook_page_id: pageId, fb_template_id: null,
        name: 'prize', language: 'en_US', status: 'PENDING',
      };
      let updateArgs;
      const res = mockRes();
      await makeTestHandlers({
        templateQuery: {
          ...defaultTemplateQuery,
          list: async () => [row],
          updateStatus: async (args) => { updateArgs = args; return { ...row, status: args.status, fb_template_id: args.fbTemplateId }; },
        },
        facebookClient: {
          ...defaultFacebookClient,
          getTemplatesByName: async () => ({
            data: [{ id: 'fb_xyz', name: 'prize', language: 'en_US', status: 'APPROVED' }],
          }),
        },
      }).list(listReq, res);

      res.statusCode.should.equal(200);
      updateArgs.status.should.equal('APPROVED');
      updateArgs.fbTemplateId.should.equal('fb_xyz');
      res.body[0].status.should.equal('APPROVED');
    });

    it('matches FB responses by (name, language) — does not confuse sibling language rows', async () => {
      // Two PENDING rows with the same name but different languages. FB's response
      // carries both variants. Each row must receive ITS OWN language\'s status.
      const rows = [
        { id: 'u-en', facebook_page_id: pageId, name: 'prize', language: 'en_US', status: 'PENDING' },
        { id: 'u-es', facebook_page_id: pageId, name: 'prize', language: 'es_LA', status: 'PENDING' },
      ];
      const updates = [];
      await makeTestHandlers({
        templateQuery: {
          ...defaultTemplateQuery,
          list: async () => rows,
          updateStatus: async (args) => { updates.push(args); return { ...args }; },
        },
        facebookClient: {
          ...defaultFacebookClient,
          getTemplatesByName: async () => ({
            data: [
              { id: 'fb_en', name: 'prize', language: 'en_US', status: 'APPROVED' },
              { id: 'fb_es', name: 'prize', language: 'es_LA', status: 'REJECTED', rejected_reason: 'PROMOTIONAL' },
            ],
          }),
        },
      }).list(listReq, mockRes());

      const byId = Object.fromEntries(updates.map(u => [u.id, u]));
      byId['u-en'].status.should.equal('APPROVED');
      byId['u-es'].status.should.equal('REJECTED');
      byId['u-es'].rejectionReason.should.equal('PROMOTIONAL');
    });

    it('still returns the row list even when FB refresh throws (graceful degradation)', async () => {
      const row = { id: 'u1', facebook_page_id: pageId, name: 'prize', language: 'en_US', status: 'PENDING' };
      const res = mockRes();
      await makeTestHandlers({
        templateQuery: { ...defaultTemplateQuery, list: async () => [row] },
        facebookClient: { ...defaultFacebookClient, getTemplatesByName: async () => { throw new Error('FB down'); } },
      }).list(listReq, res);

      // Stale status is better than a broken dashboard page
      res.statusCode.should.equal(200);
      res.body.should.have.length(1);
      res.body[0].status.should.equal('PENDING');
    });
  });

  // -------------------------------------------------------
  // remove
  // -------------------------------------------------------
  describe('remove', () => {
    const delReq = { user: { email }, params: { id: 'uuid-abc' } };

    it('returns 404 when the row does not belong to the user', async () => {
      const res = mockRes();
      await makeTestHandlers({
        templateQuery: { ...defaultTemplateQuery, get: async () => null },
      }).remove(delReq, res);
      res.statusCode.should.equal(404);
    });

    it('returns 204 after deleting the row locally and on Facebook', async () => {
      let removed = false;
      const res = mockRes();
      await makeTestHandlers({
        templateQuery: { ...defaultTemplateQuery, remove: async () => { removed = true; return { id: 'uuid-abc' }; } },
      }).remove(delReq, res);
      res.statusCode.should.equal(204);
      removed.should.equal(true);
    });

    it('calls Facebook with hsm_id — not name — so only one language variant is removed', async () => {
      // This is the core reason we store fb_template_id per row. Without it,
      // FB\'s name-based delete would take down every language of the template.
      let captured;
      await makeTestHandlers({
        facebookClient: {
          ...defaultFacebookClient,
          deleteTemplateByHsmId: async (pid, token, hsm) => { captured = { pid, token, hsm }; return {}; },
        },
      }).remove(delReq, mockRes());
      captured.hsm.should.equal('fb_abc');
      captured.pid.should.equal(pageId);
      captured.token.should.equal('tok123');
    });

    it('swallows FB "template not found" (code 100) so orphaned rows can be cleaned up', async () => {
      // If the template was deleted on FB side out-of-band, the local row is stale.
      // We still want to remove it so the dashboard is consistent.
      let localRemoved = false;
      const res = mockRes();
      await makeTestHandlers({
        facebookClient: {
          ...defaultFacebookClient,
          deleteTemplateByHsmId: async () => ({ error: { code: 100, message: 'not found' } }),
        },
        templateQuery: { ...defaultTemplateQuery, remove: async () => { localRemoved = true; return {}; } },
      }).remove(delReq, res);
      res.statusCode.should.equal(204);
      localRemoved.should.equal(true);
    });

    it('returns 502 and preserves the local row when FB returns a non-100 error', async () => {
      // Any other FB error (permissions, rate limit, etc.) means we shouldn\'t
      // delete the local row — it would put the user in a state where their
      // template is still live on FB but invisible in the dashboard.
      let localRemoved = false;
      const res = mockRes();
      await makeTestHandlers({
        facebookClient: {
          ...defaultFacebookClient,
          deleteTemplateByHsmId: async () => ({ error: { code: 200, message: 'permissions' } }),
        },
        templateQuery: { ...defaultTemplateQuery, remove: async () => { localRemoved = true; return {}; } },
      }).remove(delReq, res);
      res.statusCode.should.equal(502);
      localRemoved.should.equal(false);
    });

    it('skips the FB call when the row has no fb_template_id (migration safety)', async () => {
      // Rows created before fb_template_id was stored reliably may lack one.
      // We shouldn\'t fail the delete — just clean up locally.
      let fbCalled = false;
      const res = mockRes();
      await makeTestHandlers({
        templateQuery: {
          ...defaultTemplateQuery,
          get: async () => ({ id: 'uuid-abc', facebook_page_id: pageId, fb_template_id: null, name: 'x', language: 'en_US' }),
        },
        facebookClient: {
          ...defaultFacebookClient,
          deleteTemplateByHsmId: async () => { fbCalled = true; return {}; },
        },
      }).remove(delReq, res);
      fbCalled.should.equal(false);
      res.statusCode.should.equal(204);
    });
  });
});
