const express = require('express')
const {getUser} = require('./users')
const util = require('util')
const shortid = require('shortid');

const app = express()

const err = {error: {message: 'Facebot has no answer to give.', code: 99999 }}

const messages = {}
const callbacks = {}
const uploads = []

// Account registration: maps Authorization bearer token to {accountId, platform}.
// Allows the Messenger handler to resolve the account from the token header,
// since /me/messages carries no page id on the wire (only the token identifies it).
const tokenRegistry = {}

// numeric-looking fake id, since real Meta attachment/media ids are numeric
const numericId = () => String(Math.floor(Math.random() * 9e15) + 1e15)

// Registered ahead of the catch-all GET /:id below: Express matches routes
// in registration order, not by specificity, so GET /uploads would otherwise
// be swallowed by /:id (matching id="uploads") and never reach this handler.
app.get('/uploads', express.json(), async (req, res) => {
  res.json(uploads)
});

app.post('/uploads/reset', express.json(), async (req, res) => {
  uploads.length = 0
  res.json({ reset: true })
});

// Account registration endpoint. Accepts {token, accountId, platform} or an array of them.
// Stores the mapping so Messenger sends (which lack the account on the wire) can be
// resolved via their Authorization: Bearer <token> header.
app.post('/accounts', express.json(), async (req, res) => {
  const accounts = Array.isArray(req.body) ? req.body : [req.body];
  for (const acc of accounts) {
    if (!acc.token || !acc.accountId || !acc.platform) {
      return res.status(400).json({ error: 'Missing token, accountId, or platform' });
    }
    tokenRegistry[acc.token] = { accountId: acc.accountId, platform: acc.platform };
  }
  res.json({ registered: accounts.length });
});

// Clear the account registration map for test isolation.
app.post('/accounts/reset', express.json(), async (req, res) => {
  for (const key in tokenRegistry) {
    delete tokenRegistry[key];
  }
  res.json({ reset: true });
});

app.get('/:id', (req, res) => res.send(getUser(req.params.id)))

app.post('/me/messages', express.json(), async (req, res) => {
  const data = req.body
  let sent;

  const cb = (response) => {
    if (sent) return
    res.json(response)
    sent = true
  }

  setTimeout(() => {
    if (sent) return
    console.error('Timed out in response to: ', util.inspect(data, null, 6))
    res.json(err)
    sent = true
  }, 10000)

  if (!data.recipient) {
    console.error('NO RECIPIENT: ')
    console.error(data)
    res.json(err)
  }

  const rec = data.recipient.id || data.recipient.one_time_notif_token

  // Resolve the account from the Authorization: Bearer <token> header.
  // The token is the ONLY account signal on the Messenger wire (/me/messages
  // carries no page id). If the token is unregistered or absent, record accountId: null
  // so unregistered tests still work (the 40 existing tests never register anything).
  let accountId = null;
  let platform = 'messenger';
  let token = null;
  const authHeader = req.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (match) {
    token = match[1];
    const account = tokenRegistry[token];
    if (account) {
      accountId = account.accountId;
      platform = account.platform;
    }
  }

  const entry = { data, cb, accountId, platform, token };

  if (!messages[rec]) {
    messages[rec] = [entry]
  } else {
    messages[rec].push(entry)
  }
});

// WhatsApp Cloud API send: POST /{phone_number_id}/messages. Mirrors
// /me/messages but keys the captured payload by `to` (the recipient user id),
// so GET /sent/:userId polls WhatsApp and Messenger sends the same way.
// The phone_number_id is captured as the accountId; it is on the wire in the URL path.
app.post('/:phoneNumberId/messages', express.json(), async (req, res) => {
  const data = req.body
  let sent

  const cb = (response) => {
    if (sent) return
    res.json(response)
    sent = true
  }

  setTimeout(() => {
    if (sent) return
    console.error('Timed out (whatsapp) in response to: ', util.inspect(data, null, 6))
    res.json(err)
    sent = true
  }, 10000)

  const rec = data && data.to
  if (!rec) {
    console.error('NO WHATSAPP RECIPIENT: ', data)
    return res.json(err)
  }

  const accountId = req.params.phoneNumberId;
  const platform = 'whatsapp';

  const entry = { data, cb, accountId, platform, token: null };

  if (!messages[rec]) {
    messages[rec] = [entry]
  } else {
    messages[rec].push(entry)
  }
});

app.post('/me/pass_thread_control', express.json(), async (req, res) => {
  res.json({ success: true })
});

// Media pre-upload endpoints. Both record the id they issued, so a test can
// assert that the id handed back is the one that ended up stored.
//
// NOTE: express.json() only populates req.body for JSON callers. A real
// fan-out posts multipart/form-data (the file bytes), which arrives here with
// an empty body -- the upload is still recorded and still answers with an id,
// so call-count and id assertions work either way. Do not assert on `body`
// unless the caller genuinely sent JSON.
app.post('/me/message_attachments', express.json(), async (req, res) => {
  const attachmentId = numericId()
  uploads.push({
    endpoint: '/me/message_attachments',
    timestamp: new Date().toISOString(),
    id: attachmentId,
    body: req.body
  })
  res.json({ attachment_id: attachmentId })
});

app.post('/:phoneNumberId/media', express.json(), async (req, res) => {
  const mediaId = numericId()
  uploads.push({
    endpoint: '/:phoneNumberId/media',
    phoneNumberId: req.params.phoneNumberId,
    timestamp: new Date().toISOString(),
    id: mediaId,
    body: req.body
  })
  res.json({ id: mediaId })
});

// NEW: Account-scoped GET for two-account tests. Scans the user's FIFO for the
// first entry matching the specified accountId, removes it (preserving order of the rest),
// and returns it. Returns { missing: true } if no match found, matching the legacy miss shape.
app.get('/sent/:accountId/:userId', express.json(), async (req, res) => {
  const userId = req.params.userId;
  const targetAccountId = req.params.accountId;

  const msgs = messages[userId];
  if (!msgs || msgs.length === 0) {
    return res.json({ missing: true });
  }

  // Find the first entry with a matching accountId and remove it (splice).
  let matchIdx = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].accountId === targetAccountId) {
      matchIdx = i;
      break;
    }
  }

  if (matchIdx === -1) {
    return res.json({ missing: true });
  }

  const entry = msgs.splice(matchIdx, 1)[0];
  const { data, cb, accountId, platform, token: bearerToken } = entry;

  const token = shortid.generate();
  callbacks[token] = cb;

  const json = { data, token, accountId, platform };
  res.json(json);
});

// UNCHANGED: Legacy GET /sent/:id pops the head of the user's FIFO regardless of account.
// All 40 existing tests use this and must pass byte-identically. The response now includes
// accountId and platform fields so new tests can assert which account a send went out on
// even when they use the legacy route.
app.get('/sent/:id', express.json(), async (req, res) => {
  const rec = req.params.id

  const msgs = messages[rec]
  if (!msgs || msgs.length == 0) {
    return res.json({ missing: true })
  }

  const entry = msgs.shift();
  const { data, cb, accountId, platform } = entry;

  const token = shortid.generate()
  callbacks[token] = cb

  const json = { data, token, accountId, platform }
  res.json(json)
});

app.post('/respond/:token', express.json(), async (req, res) => {
  const token = req.params.token
  const cb = callbacks[token]
  cb(req.body)
  res.send('OK')
});

app.listen(3000)

module.exports = app
