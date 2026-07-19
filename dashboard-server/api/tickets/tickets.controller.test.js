'use strict';

const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars

const { makeHandlers } = require('./tickets.controller');

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

describe('tickets.controller (makeHandlers)', () => {
  const email = 'alice@vlab.com';
  const otherEmail = 'bob@vlab.com';
  const apiKey = 'linkey';
  const teamId = 'team-1';

  const myIssue = {
    id: 'i1', identifier: 'VLAB-1', url: 'https://linear.app/issue/VLAB-1',
    title: 'My ticket', priority: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    state: { name: 'Backlog' },
    description: `It broke\n\n*vlab-reporter:${email}*`,
  };
  const otherIssue = {
    id: 'i2', identifier: 'VLAB-2', url: 'https://linear.app/issue/VLAB-2',
    title: 'Their ticket', priority: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    state: { name: 'Backlog' },
    description: `Private\n\n*vlab-reporter:${otherEmail}*`,
    comments: { nodes: [] },
  };

  const defaultClient = {
    listTeamIssues: async () => [myIssue, otherIssue],
    getIssue: async ({ id }) => (id === 'i1' ? { ...myIssue, comments: { nodes: [] } } : (id === 'i2' ? otherIssue : null)),
    createIssue: async ({ title, description }) => ({
      id: 'iNew', identifier: 'VLAB-99', url: 'https://linear.app/issue/VLAB-99',
      title, priority: 0, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z',
      state: { name: 'Backlog' }, description,
    }),
    createComment: async ({ issueId, body }) => ({ id: 'cNew', issueId, body }),
  };

  function makeTestHandlers(overrides = {}) {
    return makeHandlers({
      linearClient: overrides.linearClient || defaultClient,
      apiKey: overrides.apiKey === undefined ? apiKey : overrides.apiKey,
      teamId: overrides.teamId === undefined ? teamId : overrides.teamId,
      todoStateId: overrides.todoStateId === undefined ? 'state-todo' : overrides.todoStateId,
    });
  }

  // -------------------------------------------------------
  // list
  // -------------------------------------------------------
  describe('list', () => {
    it('returns 200 with only the caller issues, newest first', async () => {
      const res = mockRes();
      await makeTestHandlers().list({ user: { email } }, res);
      res.statusCode.should.equal(200);
      res.body.should.have.length(1);
      res.body[0].id.should.equal('i1');
      res.body[0].should.have.property('identifier', 'VLAB-1');
      res.body[0].should.not.have.property('description');
    });

    it('does not leak another user ticket into the list', async () => {
      const res = mockRes();
      await makeTestHandlers().list({ user: { email } }, res);
      should.equal(res.body.find(i => i.id === 'i2'), undefined);
    });

    it('returns 502 when Linear throws', async () => {
      const res = mockRes();
      await makeTestHandlers({
        linearClient: { ...defaultClient, listTeamIssues: async () => { throw new Error('Linear down'); } },
      }).list({ user: { email } }, res);
      res.statusCode.should.equal(502);
      res.body.error.should.include('Linear down');
    });

    it('returns 503 when Linear is not configured', async () => {
      const res = mockRes();
      await makeTestHandlers({ apiKey: '' }).list({ user: { email } }, res);
      res.statusCode.should.equal(503);
    });
  });

  // -------------------------------------------------------
  // create
  // -------------------------------------------------------
  describe('create', () => {
    const validBody = { title: 'New bug', description: 'Steps to repro', surveyName: 'HPV', userIds: '123, 456' };
    const validReq = { user: { email }, body: validBody };

    it('returns 400 when title is missing', async () => {
      const res = mockRes();
      await makeTestHandlers().create({ user: { email }, body: { ...validBody, title: undefined } }, res);
      res.statusCode.should.equal(400);
    });

    it('returns 400 when description is missing', async () => {
      const res = mockRes();
      await makeTestHandlers().create({ user: { email }, body: { ...validBody, description: undefined } }, res);
      res.statusCode.should.equal(400);
      res.body.error.should.include('description');
    });

    it('stamps the reporter marker into the Linear issue description', async () => {
      let captured;
      let capturedStateId;
      const res = mockRes();
      await makeTestHandlers({
        linearClient: { ...defaultClient, createIssue: async ({ title, description, stateId }) => { captured = description; capturedStateId = stateId; return { id: 'i', identifier: 'VLAB-9', url: 'u', title, createdAt: 't', updatedAt: 't', state: { name: 'Todo' }, priority: 0, description }; } },
      }).create(validReq, res);
      res.statusCode.should.equal(201);
      captured.should.include(`vlab-reporter:${email}`);
      captured.should.include('**Survey:** HPV');
      captured.should.include('**Impacted user IDs:** 123, 456');
      capturedStateId.should.equal('state-todo');
    });

    it('omits stateId when todoStateId is not configured (falls back to Linear default)', async () => {
      let capturedStateId = 'sentinel';
      const res = mockRes();
      await makeTestHandlers({
        todoStateId: '',
        linearClient: { ...defaultClient, createIssue: async ({ title, description, stateId }) => { capturedStateId = stateId; return { id: 'i', identifier: 'VLAB-9', url: 'u', title, createdAt: 't', updatedAt: 't', state: { name: 'Backlog' }, priority: 0, description }; } },
      }).create(validReq, res);
      res.statusCode.should.equal(201);
      should.equal(capturedStateId, undefined);
    });

    it('returns 201 with the formatted issue on success', async () => {
      const res = mockRes();
      await makeTestHandlers().create(validReq, res);
      res.statusCode.should.equal(201);
      res.body.should.have.property('identifier', 'VLAB-99');
      res.body.should.have.property('url');
    });

    it('returns 502 when Linear rejects the create', async () => {
      const res = mockRes();
      await makeTestHandlers({
        linearClient: { ...defaultClient, createIssue: async () => { throw new Error('bad team'); } },
      }).create(validReq, res);
      res.statusCode.should.equal(502);
    });

    it('returns 503 when Linear is not configured', async () => {
      const res = mockRes();
      await makeTestHandlers({ teamId: '' }).create(validReq, res);
      res.statusCode.should.equal(503);
    });
  });

  // -------------------------------------------------------
  // getOne
  // -------------------------------------------------------
  describe('getOne', () => {
    it('returns 200 with the issue + comments when the caller owns it', async () => {
      const res = mockRes();
      await makeTestHandlers().getOne({ user: { email }, params: { id: 'i1' } }, res);
      res.statusCode.should.equal(200);
      res.body.id.should.equal('i1');
      res.body.should.have.property('description');
      res.body.comments.should.deep.equal([]);
    });

    it('returns 404 when the issue does not exist', async () => {
      const res = mockRes();
      await makeTestHandlers().getOne({ user: { email }, params: { id: 'missing' } }, res);
      res.statusCode.should.equal(404);
    });

    it('returns 404 (not 403) when the issue belongs to another user', async () => {
      // 404 avoids leaking that another user ticket exists.
      const res = mockRes();
      await makeTestHandlers().getOne({ user: { email }, params: { id: 'i2' } }, res);
      res.statusCode.should.equal(404);
      res.body.error.should.include('not found');
    });

    it('returns 502 when Linear throws', async () => {
      const res = mockRes();
      await makeTestHandlers({
        linearClient: { ...defaultClient, getIssue: async () => { throw new Error('boom'); } },
      }).getOne({ user: { email }, params: { id: 'i1' } }, res);
      res.statusCode.should.equal(502);
    });
  });

  // -------------------------------------------------------
  // reply
  // -------------------------------------------------------
  describe('reply', () => {
    it('returns 201 with a synthesized comment on success', async () => {
      let captured;
      const res = mockRes();
      await makeTestHandlers({
        linearClient: {
          ...defaultClient,
          createComment: async ({ issueId, body }) => { captured = body; return { id: 'c1', issueId, body }; },
        },
      }).reply({ user: { email }, params: { id: 'i1' }, body: { body: 'Any update?' } }, res);
      res.statusCode.should.equal(201);
      res.body.id.should.equal('c1');
      res.body.reporterEmail.should.equal(email);
      captured.should.include(`vlab-reporter:${email}`);
      captured.should.include('Any update?');
    });

    it('returns 400 when body is missing', async () => {
      const res = mockRes();
      await makeTestHandlers().reply({ user: { email }, params: { id: 'i1' }, body: {} }, res);
      res.statusCode.should.equal(400);
    });

    it('returns 404 when the issue belongs to another user', async () => {
      const res = mockRes();
      await makeTestHandlers().reply({ user: { email }, params: { id: 'i2' }, body: { body: 'hi' } }, res);
      res.statusCode.should.equal(404);
    });

    it('returns 404 when the issue does not exist', async () => {
      const res = mockRes();
      await makeTestHandlers().reply({ user: { email }, params: { id: 'nope' }, body: { body: 'hi' } }, res);
      res.statusCode.should.equal(404);
    });

    it('does not post a comment when ownership check fails', async () => {
      let posted = false;
      const res = mockRes();
      await makeTestHandlers({
        linearClient: { ...defaultClient, createComment: async () => { posted = true; return { id: 'c' }; } },
      }).reply({ user: { email }, params: { id: 'i2' }, body: { body: 'hi' } }, res);
      posted.should.equal(false);
    });

    it('returns 502 when Linear throws on createComment', async () => {
      const res = mockRes();
      await makeTestHandlers({
        linearClient: { ...defaultClient, createComment: async () => { throw new Error('rate limited'); } },
      }).reply({ user: { email }, params: { id: 'i1' }, body: { body: 'hi' } }, res);
      res.statusCode.should.equal(502);
    });
  });
});
