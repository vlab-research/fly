#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * Reproduction for the message_echoes regression on user_phone_number
 * quick replies (FB Messenger Platform, observed from ~2026-05-21 12:00 UTC).
 *
 * What it does:
 *   1. Starts a minimal HTTPS-style webhook receiver on $PORT.
 *   2. Sends TWO outbound messages via the Send API:
 *        A. control:    plain text, no quick replies
 *        B. test case:  same text PLUS quick_replies user_phone_number
 *   3. Waits 60 seconds for message_echoes webhooks to arrive.
 *   4. Prints which echoes arrived. Before 2026-05-21 both arrived;
 *      since then only A arrives.
 *
 * Zero npm dependencies. Built-ins only.
 *
 * Setup
 * -----
 *   - PAGE_TOKEN     Page access token for a page subscribed to message_echoes.
 *   - PSID           Page-scoped ID of a test recipient who has messaged the
 *                    page within the last 24h (so the standard window is open).
 *   - VERIFY_TOKEN   Any string; used for the GET webhook verification.
 *   - PUBLIC_URL     Public URL pointing at this process (e.g. ngrok tunnel).
 *                    Must already be configured as the app's webhook callback
 *                    URL and have message_echoes + messages in subscribed_fields.
 *   - PORT           Local port to listen on (default 3000).
 *   - GRAPH_VERSION  Graph API version (default v22.0).
 *
 * Run
 * ---
 *   PAGE_TOKEN=EAA... PSID=12345 VERIFY_TOKEN=foo \
 *   PUBLIC_URL=https://your-tunnel/webhook \
 *   node fb-bug-repro.js
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '3000', 10);
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v22.0'}`;
const TOKEN = process.env.PAGE_TOKEN;
const PSID = process.env.PSID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_me';

if (!TOKEN || !PSID) {
  console.error('PAGE_TOKEN and PSID env vars are required.');
  process.exit(1);
}

const REF_CONTROL = 'repro_control_' + Date.now();
const REF_TEST = 'repro_user_phone_number_' + Date.now();

const echoes = { control: null, test: null };

// ---- webhook receiver ----------------------------------------------------

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // GET — webhook verification handshake
  if (req.method === 'GET') {
    if (u.searchParams.get('hub.verify_token') === VERIFY_TOKEN) {
      res.writeHead(200);
      res.end(u.searchParams.get('hub.challenge') || '');
    } else {
      res.writeHead(401);
      res.end('bad verify_token');
    }
    return;
  }

  // POST — webhook event
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200);
    res.end();

    let payload;
    try { payload = JSON.parse(body); } catch { return; }

    for (const entry of payload.entry || []) {
      for (const ev of entry.messaging || []) {
        if (!ev.message || !ev.message.is_echo) continue;

        let meta;
        try { meta = JSON.parse(ev.message.metadata || '{}'); } catch { meta = {}; }

        const tag = meta.ref === REF_CONTROL ? 'control'
                  : meta.ref === REF_TEST    ? 'test'
                  : null;
        if (!tag) continue;

        echoes[tag] = ev;
        console.log(`[echo received] ${tag} ref=${meta.ref} mid=${ev.message.mid}`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  runTest().catch((e) => { console.error(e); process.exit(1); });
});

// ---- send helpers --------------------------------------------------------

function send(payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${GRAPH}/me/messages?access_token=${encodeURIComponent(TOKEN)}`);
    const data = Buffer.from(JSON.stringify(payload));
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          if (res.statusCode >= 400 || json.error) reject(new Error(buf));
          else resolve(json);
        } catch { reject(new Error(buf)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runTest() {
  const TEXT = 'Bug repro: this is a test, please ignore.';
  const WAIT_MS = 60_000;

  console.log('\n[1/2] sending CONTROL (plain text, no quick replies)');
  const a = await send({
    recipient: { id: PSID },
    message: {
      text: TEXT,
      metadata: JSON.stringify({ ref: REF_CONTROL }),
    },
  });
  console.log('     send ok, message_id =', a.message_id);

  console.log('\n[2/2] sending TEST (user_phone_number quick reply)');
  const b = await send({
    recipient: { id: PSID },
    message: {
      text: TEXT,
      quick_replies: [{ content_type: 'user_phone_number' }],
      metadata: JSON.stringify({ ref: REF_TEST }),
    },
  });
  console.log('     send ok, message_id =', b.message_id);

  console.log(`\nwaiting ${WAIT_MS / 1000}s for echo webhooks…`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  console.log('\n=================== RESULT ===================');
  console.log('control echo (plain text)         :', echoes.control ? 'RECEIVED' : 'MISSING');
  console.log('test echo (user_phone_number QR)  :', echoes.test    ? 'RECEIVED' : 'MISSING');
  console.log('==============================================');

  if (echoes.control && !echoes.test) {
    console.log('\nBUG REPRODUCED: control echoes but test does not.');
    process.exit(0);
  }
  if (echoes.control && echoes.test) {
    console.log('\nNo regression observed: both echoes arrived.');
    process.exit(0);
  }
  console.log('\nInconclusive: control echo also missing. Check webhook setup.');
  process.exit(2);
}
