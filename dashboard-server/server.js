const express = require('express');
const cors = require('cors');
const bodyparser = express.json();

const router = require('./api');
const auth = require('./middleware/auth');
const { API_VERSION } = require('./config').SERVER;
const { MCP_BODY_LIMIT_BYTES } = require('./api/mcp/mcp.core');
const app = express();
const morgan = require('morgan');

// The MCP endpoint carries file bytes inside its JSON (upload_media's
// content_base64), so it gets a parser sized to the media upload cap, mounted
// AHEAD of the global one. body-parser skips a body that is already parsed, so
// the global 100 KB parser never sees an MCP request.
const mcpBodyparser = express.json({ limit: MCP_BODY_LIMIT_BYTES });

app
  .use(morgan('tiny'))
  .use(cors({ exposedHeaders: ['Content-Disposition'] }))
  .use(`/api/v${API_VERSION}/mcp`, mcpBodyparser)
  .use(bodyparser)
  .use(`/api/v${API_VERSION}`, auth, router)
  .use('/health', (req, res) => {
    // TODO: check connection to DB
    return res.status(200).send('hola');
  })
  .use((req, res, next) => {
    res.status(404).json({ code: "NOT_FOUND" })
  })
  .use(function (err, req, res, next) {
    if (err.name === 'UnauthorizedError') {
      res.status(401).json({error: {message: 'Invalid Token.'}});
    }
  });

module.exports = app;
