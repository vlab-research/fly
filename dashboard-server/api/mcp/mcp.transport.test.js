'use strict';

/*
 * Transport-level tests: a real express app on a real port, driven by the real
 * MCP client from the SDK, so the initialize / tools/list / tools/call handshake
 * is exercised end to end over HTTP.
 *
 * The IO layer is stubbed with proxyquire in noCallThru mode, so nothing here
 * touches a database. The express app is assembled to match server.js — the
 * same global `express.json()`, and an auth middleware in front of the router —
 * because the two things most likely to break this endpoint are the pre-parsed
 * body and the identity on `req.user`.
 */

/*
 * `r2` is loaded on purpose, first, because that is production: r2 is pulled in
 * by utils/ and does `global.fetch = require('node-fetch')` plus
 * `global.Headers = node-fetch.Headers` at import time. Every request the real
 * dashboard-server serves is served under those replaced globals, so the MCP
 * endpoint is tested under them too. (This is also why the client below cannot
 * use `fetch`: node-fetch v2 puts a Node PassThrough on Response.body where the
 * MCP client expects a web ReadableStream with .cancel().)
 */
require('r2');

const http = require('http');
const express = require('express');
const { expect } = require('chai');

// noCallThru: the stub must REPLACE mcp.service, not be merged over it. Merging
// loads the real module, which opens a pg Pool at require time.
const proxyquire = require('proxyquire').noCallThru();

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { TOOLS } = require('./mcp.core');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const EMAIL = 'researcher@example.org';

const SURVEYS = [
  {
    id: 'aaaa-1111',
    survey_name: 'Solo Study',
    shortcode: 'solo',
    title: 'Solo',
    formid: 'f3',
    created: '2026-01-20T00:00:00Z',
  },
];

const seen = [];

const fakeService = {
  async listSurveys(args) {
    seen.push({ name: 'listSurveys', args });
    return SURVEYS;
  },
  async createTypeformForm(args) {
    seen.push({ name: 'createTypeformForm', args });
    return {
      ok: true,
      form: { id: 'newform', url: 'https://form.typeform.com/to/newform', title: 'New' },
    };
  },
  async registerSurveyVersion(args) {
    seen.push({ name: 'registerSurveyVersion', args });
    return { ok: true, survey: { id: 'bbbb-2222', ...args, created: '2026-03-01T00:00:00Z' } };
  },
  async updateSettings(args) {
    seen.push({ name: 'updateSettings', args });
    return {
      ok: true,
      survey: { survey_name: 'Solo Study', shortcode: 'solo' },
      settings: { timeouts: null, off_time: '2026-05-01' },
    };
  },

  // monitoring
  async resolveSurvey(args) {
    seen.push({ name: 'resolveSurvey', args });
    if (args.survey_name !== 'Solo Study') return { ok: false, notFound: true, known: ['Solo Study'] };
    return { ok: true, email: args.email, surveyName: 'Solo Study', shortcodes: ['solo'] };
  },
  async statesSummary(survey) {
    seen.push({ name: 'statesSummary', args: survey });
    return { summary: [{ current_state: 'RESPONDING', current_form: 'solo', count: 12 }] };
  },
  async listStates(survey, filters) {
    seen.push({ name: 'listStates', args: survey, filters });
    return { states: [{ userid: 'p1', current_state: 'ERROR', current_form: 'solo' }], total: 1 };
  },
  async stateDetail(survey, userid) {
    seen.push({ name: 'stateDetail', args: survey, userid });
    return { userid, current_state: 'ERROR', state_json: {} };
  },
  async healthFindings(survey) {
    seen.push({ name: 'healthFindings', args: survey });
    return { window_hours: 24, findings: [], aggregates: {} };
  },
  async platformNotices() {
    seen.push({ name: 'platformNotices' });
    return { notices: [] };
  },

  // data
  async startExport(args) {
    seen.push({ name: 'startExport', args });
    return { export_id: 'exp-1', source: 'responses', status: 'Requested' };
  },
  async listExports(args) {
    seen.push({ name: 'listExports', args });
    return [
      { id: 'exp-1', user_id: EMAIL, survey_id: 'Solo Study', source: 'responses', status: 'Finished', export_link: 'https://minio/x', updated: '2026-09-01', retry_count: 0, options: {} },
    ];
  },
  async getResponses(args) {
    seen.push({ name: 'getResponses', args });
    return { responses: [{ userid: 'p1', question_ref: 'q1', response: 'A', token: 'tok-1' }] };
  },

  // templates and media
  async listTemplates(args) {
    seen.push({ name: 'listTemplates', args });
    return [{ id: 't1', name: 'prize_ready', language: 'en_US', status: 'APPROVED' }];
  },
  async getTemplate(args) {
    seen.push({ name: 'getTemplate', args });
    return { id: args.id, name: 'prize_ready', language: 'en_US', status: 'APPROVED' };
  },
  async createTemplate(args) {
    seen.push({ name: 'createTemplate', args });
    return { id: 't2', name: args.name, language: args.language, status: 'PENDING' };
  },
  async deleteTemplate(args) {
    seen.push({ name: 'deleteTemplate', args });
    return { id: args.id, name: 'prize_ready', language: 'en_US' };
  },
  async listAssets(args) {
    seen.push({ name: 'listAssets', args });
    return [{ id: 'a1', filename: 'welcome.png', url: 'https://media/a/a1/welcome.png' }];
  },
  async uploadAsset(args) {
    seen.push({ name: 'uploadAsset', args: { email: args.email, filename: args.file.originalname, bytes: args.file.buffer.length } });
    return {
      ok: true,
      deduplicated: false,
      asset: { id: 'a2', filename: args.file.originalname, url: `https://media/a/a2/${args.file.originalname}` },
      fanOut: async () => ({ attempted: 0, succeeded: 0, failed: 0 }),
    };
  },
  async fetchSource(url) {
    seen.push({ name: 'fetchSource', url });
    return { buffer: Buffer.from('png-bytes'), contentType: 'image/png', url };
  },
};

const tools = proxyquire('./mcp.tools', { './mcp.service': fakeService });
const mcpServer = proxyquire('./mcp.server', { './mcp.tools': tools });
const routes = proxyquire('./mcp.routes', { './mcp.server': mcpServer });

/*
 * Mirrors server.js: express.json() globally, auth in front of the router. The
 * fake auth stands in for middleware/auth.js and does the one thing that
 * matters downstream — put an email on req.user when a Bearer token is present.
 */
function makeApp() {
  return express()
    .use(express.json())
    .use('/api/v1', (req, res, next) => {
      const header = req.get('authorization') || '';
      if (header.startsWith('Bearer ')) req.user = { email: EMAIL };
      next();
    })
    .use('/api/v1/mcp', routes);
}

let server;
let baseUrl;

before(done => {
  server = http.createServer(makeApp()).listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/mcp`;
    done();
  });
});

after(done => server.close(done));

beforeEach(() => {
  seen.length = 0;
});

/*
 * A web-standard `fetch` built on node:http, so the client half of these tests
 * is unaffected by whatever the process has done to global.fetch. It returns a
 * real global Response — r2 replaces fetch and Headers but not Response — which
 * is exactly the surface the MCP client transport relies on.
 */
function httpFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url.toString());
    const headers = {};
    const given = init.headers;
    if (given) {
      if (typeof given.forEach === 'function') given.forEach((v, k) => { headers[k] = v; });
      else Object.entries(given).forEach(([k, v]) => { headers[k] = v; });
    }

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: init.method || 'GET',
        headers,
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const out = {};
          Object.entries(res.headers).forEach(([k, v]) => {
            out[k] = Array.isArray(v) ? v.join(', ') : v;
          });
          resolve(
            new global.Response(body.length ? body : null, {
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: out,
            }),
          );
        });
      },
    );

    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function connect(headers = { Authorization: 'Bearer fake-api-key' }) {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers },
    fetch: httpFetch,
  });
  await client.connect(transport);
  return client;
}

// Raw JSON-RPC, for the cases a well-behaved client will not produce.
function post(body, headers = {}) {
  return httpFetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer fake-api-key',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0' },
  },
};

describe('mcp transport: handshake', () => {
  it('initializes and advertises the tools capability and instructions', async () => {
    const client = await connect();

    expect(client.getServerCapabilities()).to.have.property('tools');
    expect(client.getServerVersion()).to.include({ name: 'vlab-fly-surveys' });
    expect(client.getInstructions()).to.match(/APPEND-ONLY VERSIONING/);

    await client.close();
  });

  // Stateless mode: nothing may pin a client to the pod that answered, or the
  // next request lands on a different replica and fails.
  it('issues no session id, so any replica can serve the next request', async () => {
    const res = await post(INITIALIZE);
    expect(res.status).to.equal(200);
    expect(res.headers.get('mcp-session-id')).to.equal(null);
  });

  it('answers as one application/json response rather than an event stream', async () => {
    const res = await post(INITIALIZE);
    expect(res.headers.get('content-type')).to.match(/application\/json/);
  });

  it('lists every tool with its description and schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map(t => t.name)).to.eql(TOOLS.map(t => t.name));
    tools.forEach(t => {
      expect(t.description, t.name).to.be.a('string');
      expect(t.inputSchema, t.name).to.include({ type: 'object' });
    });

    await client.close();
  });
});

describe('mcp transport: tool calls', () => {
  it('scopes a call to the identity the auth middleware put on the request', async () => {
    const client = await connect();
    const out = await client.callTool({ name: 'list_surveys', arguments: {} });

    expect(seen[0]).to.eql({ name: 'listSurveys', args: { email: EMAIL } });
    expect(JSON.parse(out.content[0].text).surveys[0].survey_name).to.equal('Solo Study');

    await client.close();
  });

  it('round-trips a write through the transport', async () => {
    const client = await connect();
    const out = await client.callTool({
      name: 'create_survey',
      arguments: {
        formid: 'newform',
        survey_name: 'Brand New',
        shortcode: 'bn1',
        title: 'Screener',
      },
    });

    const write = seen.find(c => c.name === 'registerSurveyVersion');
    expect(write.args).to.include({ email: EMAIL, formid: 'newform', shortcode: 'bn1' });
    expect(JSON.parse(out.content[0].text).created.survey_name).to.equal('Brand New');

    await client.close();
  });

  // A tool error must come back as a result the model can read and correct,
  // not as a JSON-RPC protocol error that ends the turn.
  it('returns a bad-argument failure as an isError result, not a protocol error', async () => {
    const client = await connect();
    const out = await client.callTool({ name: 'create_survey', arguments: { formid: 'x' } });

    expect(out.isError).to.equal(true);
    expect(out.content[0].text).to.match(/missing required property "survey_name"/);
    expect(seen).to.have.lengthOf(0);

    await client.close();
  });

  // Monitoring: one read per tool through the real client, and the ownership
  // gate is what carries the email from the auth middleware to the query.
  it('serves a states summary scoped to the caller', async () => {
    const client = await connect();
    const out = await client.callTool({ name: 'get_states_summary', arguments: { survey_name: 'Solo Study' } });

    expect(seen.map(c => c.name)).to.eql(['resolveSurvey', 'statesSummary']);
    expect(seen[0].args).to.eql({ email: EMAIL, survey_name: 'Solo Study' });
    expect(JSON.parse(out.content[0].text).summary[0].count).to.equal(12);

    await client.close();
  });

  it('serves a bounded, filtered participant list', async () => {
    const client = await connect();
    const out = await client.callTool({
      name: 'list_states',
      arguments: { survey_name: 'Solo Study', state: 'ERROR', limit: 999 },
    });

    expect(seen[1].filters).to.include({ state: 'ERROR', limit: 200, offset: 0 });
    const body = JSON.parse(out.content[0].text);
    expect(body).to.include({ total: 1, limit: 200 });
    expect(body.items[0].userid).to.equal('p1');

    await client.close();
  });

  it('serves one participant, survey health, and the platform notices', async () => {
    const client = await connect();

    const one = await client.callTool({
      name: 'get_participant_state',
      arguments: { survey_name: 'Solo Study', userid: 'p1' },
    });
    expect(JSON.parse(one.content[0].text).current_state).to.equal('ERROR');

    const health = await client.callTool({ name: 'get_survey_health', arguments: { survey_name: 'Solo Study' } });
    expect(JSON.parse(health.content[0].text).window_hours).to.equal(24);

    const notices = await client.callTool({ name: 'get_platform_notices', arguments: {} });
    expect(JSON.parse(notices.content[0].text)).to.eql({ notices: [] });

    await client.close();
  });

  it('starts an export, lists it, and pages responses', async () => {
    const client = await connect();

    const started = await client.callTool({
      name: 'start_export',
      arguments: { survey_name: 'Solo Study', export_type: 'responses', options: { pivot: true, response_value: 'response' } },
    });
    expect(seen.find(c => c.name === 'startExport').args).to.eql({
      email: EMAIL,
      survey_name: 'Solo Study',
      export_type: 'responses',
      options: { pivot: true, response_value: 'response' },
    });
    expect(JSON.parse(started.content[0].text).export_id).to.equal('exp-1');

    const listed = await client.callTool({ name: 'list_exports', arguments: {} });
    const rows = JSON.parse(listed.content[0].text).items;
    expect(rows[0]).to.include({ id: 'exp-1', status: 'Finished', export_link: 'https://minio/x' });
    expect(rows[0]).to.not.have.property('user_id');

    const page = await client.callTool({ name: 'get_responses', arguments: { survey_name: 'Solo Study', page_size: 1 } });
    const body = JSON.parse(page.content[0].text);
    expect(body.next_cursor).to.equal('tok-1');
    expect(body.items[0].response).to.equal('A');

    await client.close();
  });

  it('round-trips every template tool', async () => {
    const client = await connect();

    const listed = await client.callTool({ name: 'list_message_templates', arguments: {} });
    expect(JSON.parse(listed.content[0].text).items[0].name).to.equal('prize_ready');

    const one = await client.callTool({ name: 'get_message_template', arguments: { id: 't1' } });
    expect(JSON.parse(one.content[0].text).id).to.equal('t1');

    const created = await client.callTool({
      name: 'create_message_template',
      arguments: { account_id: 'page1', name: 'reminder', language: 'en_US', body: 'Hello' },
    });
    expect(seen.find(c => c.name === 'createTemplate').args).to.include({ email: EMAIL, accountId: 'page1', name: 'reminder' });
    expect(JSON.parse(created.content[0].text).status).to.equal('PENDING');

    const deleted = await client.callTool({ name: 'delete_message_template', arguments: { id: 't1' } });
    expect(JSON.parse(deleted.content[0].text).deleted.id).to.equal('t1');

    await client.close();
  });

  it('lists media and uploads from base64 and from a URL', async () => {
    const client = await connect();

    const listed = await client.callTool({ name: 'list_media', arguments: {} });
    expect(JSON.parse(listed.content[0].text).items[0].url).to.match(/welcome\.png$/);

    const inline = await client.callTool({
      name: 'upload_media',
      arguments: { filename: 'hello.txt', content_base64: Buffer.from('hello').toString('base64') },
    });
    expect(seen.find(c => c.name === 'uploadAsset').args).to.eql({ email: EMAIL, filename: 'hello.txt', bytes: 5 });
    expect(JSON.parse(inline.content[0].text).url).to.equal('https://media/a/a2/hello.txt');

    seen.length = 0;
    const fetched = await client.callTool({
      name: 'upload_media',
      arguments: { filename: 'logo.png', source_url: 'https://cdn.example.org/logo.png' },
    });
    expect(seen.map(c => c.name)).to.eql(['fetchSource', 'uploadAsset']);
    expect(JSON.parse(fetched.content[0].text).deduplicated).to.equal(false);

    await client.close();
  });

  it('reports an unknown tool as a readable error', async () => {
    const client = await connect();
    const out = await client.callTool({ name: 'drop_survey', arguments: {} });

    expect(out.isError).to.equal(true);
    expect(out.content[0].text).to.match(/Unknown tool "drop_survey"/);

    await client.close();
  });
});

describe('mcp transport: HTTP contract', () => {
  it('rejects a request with no authenticated user', async () => {
    const res = await post(INITIALIZE, { Authorization: '' });
    expect(res.status).to.equal(401);
    expect((await res.json()).error.message).to.match(/Unauthorized/);
  });

  it('refuses GET and DELETE, naming POST as the only method', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await httpFetch(baseUrl, {
        method,
        headers: { Authorization: 'Bearer fake-api-key' },
      });
      expect(res.status, method).to.equal(405);
      expect(res.headers.get('allow'), method).to.equal('POST');
      expect((await res.json()).error.message, method).to.match(/stateless/);
    }
  });

  it('refuses a client that does not accept both JSON and event-stream', async () => {
    const res = await post(INITIALIZE, { Accept: 'application/json' });
    expect(res.status).to.equal(406);
  });

  // express.json() has already drained the body by the time the transport runs;
  // if it were not handed over explicitly the request would hang forever.
  it('reads the body express.json() already consumed', async () => {
    const res = await post(INITIALIZE);
    const body = await res.json();
    expect(body.result.serverInfo.name).to.equal('vlab-fly-surveys');
  });
});
