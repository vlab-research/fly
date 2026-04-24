#!/usr/bin/env node

// Standalone test for the Messenger Send API utility-messages payload shape.
// Talks directly to Graph — bypasses dashboard-server, replybot, and the
// translate-typeform package. Use this to validate a candidate payload shape
// against Facebook before shipping a fix to the translator.
//
// Setup:
//   cp scripts/.env.example scripts/.env
//   # fill PAGE_ID, PAGE_ACCESS_TOKEN
//   PSID=... TEMPLATE_NAME=recontact node scripts/test-utility-send.js

const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v22.0';
const PSID = process.env.PSID;
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || 'recontact';
const LANGUAGE = process.env.LANGUAGE || 'en_US';
const BODY_PARAM = process.env.BODY_PARAM || '₦1,000';
const REF = process.env.REF || 'welcome_back_hpv';
const BUTTON_COUNT = parseInt(process.env.BUTTON_COUNT || '1', 10);

if (!PAGE_ID || !PAGE_ACCESS_TOKEN || !PSID) {
  console.error('Missing PAGE_ID, PAGE_ACCESS_TOKEN, or PSID. Set PSID in the env.');
  process.exit(1);
}

// Which send-payload variant to test:
//   candidate    — single `buttons` component, positional POSTBACK parameters (current fix)
//   per_button   — one `buttons` component per button, no index (rejected shape variant)
//   text_only    — body only, no buttons
const VARIANT = process.env.VARIANT || process.argv[2] || 'candidate';

function buildComponents(variant) {
  const body = {
    type: 'body',
    parameters: [{ type: 'text', text: BODY_PARAM }],
  };
  if (variant === 'text_only' || BUTTON_COUNT === 0) return [body];

  if (variant === 'candidate') {
    return [
      body,
      {
        type: 'buttons',
        parameters: Array.from({ length: BUTTON_COUNT }, () => ({ type: 'POSTBACK', payload: REF })),
      },
    ];
  }

  if (variant === 'per_button') {
    const btns = Array.from({ length: BUTTON_COUNT }, () => ({
      type: 'buttons',
      parameters: [{ type: 'POSTBACK', payload: REF }],
    }));
    return [body, ...btns];
  }

  throw new Error(`Unknown VARIANT: ${variant}`);
}

const payload = {
  recipient: { id: PSID },
  messaging_type: 'UTILITY',
  message: {
    template: {
      name: TEMPLATE_NAME,
      language: { code: LANGUAGE },
      components: buildComponents(VARIANT),
    },
  },
};

const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PAGE_ID}/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;

console.log(`\n=== Variant: ${VARIANT} / BUTTON_COUNT=${BUTTON_COUNT} ===`);
console.log('POST', url.replace(PAGE_ACCESS_TOKEN, 'REDACTED'));
console.log('Body:', JSON.stringify(payload, null, 2));

(async () => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log('\nStatus:', res.status);
  console.log('\nResponse:');
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
})().catch(err => {
  console.error('Request failed:', err);
  process.exit(1);
});
