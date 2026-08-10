const express = require('express')
const {getUser} = require('./users')
const util = require('util')
const shortid = require('shortid');

const app = express()

const err = {error: {message: 'Facebot has no answer to give.', code: 99999 }}

const messages = {}
const callbacks = {}
const uploads = []

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

  if (!messages[rec]) {
    messages[rec] = [[data, cb]]
  } else {
    messages[rec].push([data, cb])
  }
});

// WhatsApp Cloud API send: POST /{phone_number_id}/messages. Mirrors
// /me/messages but keys the captured payload by `to` (the recipient user id),
// so GET /sent/:userId polls WhatsApp and Messenger sends the same way.
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

  if (!messages[rec]) {
    messages[rec] = [[data, cb]]
  } else {
    messages[rec].push([data, cb])
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

app.get('/sent/:id', express.json(), async (req, res) => {
  const rec = req.params.id

  const msgs = messages[rec]
  if (!msgs || msgs.length == 0) {
    return res.json({ missing: true })
  }

  const [data, cb] = msgs.shift()
  const token = shortid.generate()
  callbacks[token] = cb

  const json = { data, token }
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
