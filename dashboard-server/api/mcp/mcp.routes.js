'use strict';

/*
 * Transport wiring for the MCP endpoint.
 *
 * Mounted at /api/v1/mcp, which is inside the JWT middleware applied to the
 * whole /api/v1 tree in server.js. That is the entire authentication story:
 * an MCP client sends `Authorization: Bearer <api key>`, the existing
 * middleware verifies it (Auth0 RS256 first, then the HS256 API keys minted by
 * POST /api/v1/auth/api-token), and req.user.email is the identity every tool
 * scopes on — the same identity every REST controller scopes on. There is no
 * MCP-specific auth here and there must never be one: a second way to say who
 * you are is a second way to get it wrong.
 *
 * Stateless mode, one transport per request. Sessions would pin a client to the
 * pod that issued the session id, which is wrong behind a load balancer with
 * more than one replica.
 */

const router = require('express').Router();
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { buildServer } = require('./mcp.server');

const jsonRpcError = (code, message) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

async function handlePost(req, res) {
  const email = req.user && req.user.email;

  // The middleware should have made this impossible; failing loudly beats
  // running a tool with an undefined owner, which would scope queries to
  // "everyone".
  if (!email) {
    return res.status(401).json(jsonRpcError(-32001, 'Unauthorized: no user on request'));
  }

  // req.apiScopes is set by middleware/auth.js. null means unrestricted; the
  // dispatcher enforces the per-tool scope because this path is delegated.
  const server = buildServer({ email, scopes: req.apiScopes });

  // `sessionIdGenerator: undefined` is what selects stateless mode.
  // `enableJsonResponse` makes a tool call answer as one application/json
  // response instead of an SSE stream: nothing here streams partial results,
  // and a long-lived event stream through an ingress that buffers responses is
  // a hang rather than an error.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    Promise.resolve(transport.close()).catch(() => {});
    Promise.resolve(server.close()).catch(() => {});
  });

  try {
    await server.connect(transport);
    // express.json() (server.js) has already drained the body, so it is handed
    // over explicitly — the transport would otherwise wait forever on a stream
    // that has already ended.
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  }
}

// Stateless servers have nothing to stream unprompted and no session to delete.
function methodNotAllowed(req, res) {
  res
    .status(405)
    .set('Allow', 'POST')
    .json(
      jsonRpcError(
        -32000,
        `Method not allowed: this MCP endpoint is stateless, so only POST is supported ` +
          `(got ${req.method}).`,
      ),
    );
}

router.post('/', handlePost);
router.get('/', methodNotAllowed);
router.delete('/', methodNotAllowed);

module.exports = router;
