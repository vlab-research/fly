'use strict';

/*
 * Builds one MCP server instance, bound to one authenticated researcher.
 *
 * A fresh instance per HTTP request is not waste, it is the point: this express
 * app is horizontally scaled behind Kubernetes, so any state held between
 * requests would be state that the next request — landing on a different pod —
 * cannot see. The identity is closed over here rather than read from a global,
 * which is also what makes it impossible for one caller's context to leak into
 * another's tool call.
 *
 * The low-level `Server` is used rather than `McpServer` because the tool
 * schemas are plain JSON Schema data in the pure core. Going through the
 * high-level helper would mean expressing them as zod, which is code, which
 * cannot be diffed or asserted on as a contract.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { TOOLS, SERVER_INSTRUCTIONS } = require('./mcp.core');
const { runTool } = require('./mcp.tools');

const SERVER_INFO = {
  name: 'vlab-fly-surveys',
  title: 'Fly Surveys',
  version: '0.1.0',
};

function buildServer({ email, scopes = null }) {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async request =>
    runTool(request.params.name, request.params.arguments || {}, { email, scopes }),
  );

  return server;
}

module.exports = { buildServer, SERVER_INFO };
