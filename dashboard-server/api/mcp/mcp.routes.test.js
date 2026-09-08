'use strict';

/*
 * Integration test for the MCP endpoint via the real express app and real
 * authentication middleware. This test specifically verifies that the MCP
 * endpoint works end-to-end with Bearer JWT authentication, which exercises
 * the global crypto object that requires Node >=19 (regression test for the
 * MCP SDK's Streamable HTTP transport calling crypto.randomUUID()).
 *
 * This test uses the real auth middleware and real route handlers, with
 * database queries stubbed via proxyquire to avoid requiring a running
 * database for this specific regression.
 */

const request = require('supertest');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

const { makeAPIToken } = require('../../utils/auth/auth.util');
const { TOOLS } = require('./mcp.core');

const EMAIL = 'researcher@test.org';

// Stub the service layer to avoid database queries
const stubService = {
  async listSurveys() {
    return [
      {
        id: 'test-survey-id',
        survey_name: 'Test Survey',
        shortcode: 'test',
        title: 'Test',
        formid: 'f123',
        created: '2026-01-01T00:00:00Z',
      },
    ];
  },
  async createTypeformForm(args) {
    return { ok: true, form: { id: 'newform', url: 'https://form.typeform.com/to/newform' } };
  },
  async registerSurveyVersion(args) {
    return { ok: true, survey: { id: 'new-survey-id', ...args, created: '2026-01-02T00:00:00Z' } };
  },
  async updateSettings(args) {
    return { ok: true, survey: { survey_name: 'Test Survey' }, settings: {} };
  },
  async uploadAsset({ file }) {
    return {
      ok: true,
      deduplicated: false,
      asset: { id: 'a1', filename: file.originalname, byteSize: file.buffer.length, url: 'https://media/a/a1/x' },
      fanOut: async () => ({ attempted: 0, succeeded: 0, failed: 0 }),
    };
  },
};

// Stub the mcp.tools module to use our stubbed service
const tools = proxyquire('./mcp.tools', { './mcp.service': stubService });
const mcpServer = proxyquire('./mcp.server', { './mcp.tools': tools });
const mcpRoutes = proxyquire('./mcp.routes', { './mcp.server': mcpServer });

// server.js requires './api', and api/index.js is what requires './mcp', so the
// stub has to go in at that layer — a key of './api/mcp' on server would never
// match and the real service (and a real database) would be reached.
const apiRouter = proxyquire('../../api', { './mcp': mcpRoutes });
const app = proxyquire('../../server', { './api': apiRouter });

describe('MCP routes integration: crypto regression', () => {
  let authToken;

  before(async () => {
    authToken = await makeAPIToken({ email: EMAIL });
  });

  it('initializes the MCP server over HTTP with Bearer JWT', async () => {
    const res = await request(app)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.1' },
        },
      });

    expect(res.status).to.equal(200);
    const body = JSON.parse(res.text);
    expect(body).to.have.property('result');
    expect(body.result).to.have.property('serverInfo');
    expect(body.result.serverInfo.name).to.equal('vlab-fly-surveys');
  });

  it('lists every tool the core defines', async () => {
    const res = await request(app)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      });

    expect(res.status).to.equal(200);
    const body = JSON.parse(res.text);
    expect(body).to.have.property('result');
    expect(body.result).to.have.property('tools');

    const toolNames = body.result.tools.map(t => t.name);
    // The exact list is the core test's contract (TOOL_NAMES); this test is
    // about the transport advertising whatever the core defines.
    expect(toolNames).to.eql(TOOLS.map(t => t.name));

    // Verify each tool has a description and schema
    body.result.tools.forEach(tool => {
      expect(tool).to.have.property('description');
      expect(tool).to.have.property('inputSchema');
      expect(tool.inputSchema).to.have.property('type');
    });
  });

  // upload_media's content_base64 is a string inside the JSON-RPC body, so the
  // JSON parser's limit is the upload limit. The global parser's default is
  // 100 KB; server.js mounts a larger one on the MCP path ahead of it.
  it('accepts a multi-megabyte inline upload through the real body parser', async () => {
    const bytes = 3 * 1024 * 1024;
    const res = await request(app)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'upload_media',
          arguments: { filename: 'big.bin', content_base64: Buffer.alloc(bytes, 7).toString('base64') },
        },
      });

    expect(res.status).to.equal(200);
    const result = JSON.parse(res.text).result;
    expect(result.isError, result.content && result.content[0].text).to.not.equal(true);
    expect(JSON.parse(result.content[0].text).byteSize).to.equal(bytes);
  });

  it('rejects requests without authentication with 401', async () => {
    const res = await request(app)
      .post('/api/v1/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.1' },
        },
      });

    expect(res.status).to.equal(401);
  });
});
