#!/usr/bin/env node

// Standalone test for Facebook Messenger utility message template creation.
// Bypasses dashboard-server entirely — talks directly to the Graph API.
//
// Setup:
//   cp scripts/.env.example scripts/.env
//   # fill in PAGE_ID and PAGE_ACCESS_TOKEN
//   node scripts/test-utility-template.js

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
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || `test_utility_${Date.now()}`;

if (!PAGE_ID || !PAGE_ACCESS_TOKEN) {
  console.error('Missing PAGE_ID or PAGE_ACCESS_TOKEN in scripts/.env');
  process.exit(1);
}

// Which variant to test: simple | buttons | placeholders | buttons_placeholders
const VARIANT = process.env.VARIANT || process.argv[2] || 'simple';

function buildPayload(variant) {
  const base = { name: TEMPLATE_NAME, language: 'en_US', category: 'UTILITY' };
  switch (variant) {
    case 'simple':
      return {
        ...base,
        components: [
          { type: 'BODY', text: 'Your appointment is confirmed for tomorrow at 10am.' },
        ],
      };
    case 'buttons':
      // Mirrors dashboard-server buildFacebookCreatePayload with buttons
      return {
        ...base,
        components: [
          { type: 'BODY', text: 'Your appointment is confirmed. Coming?' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'Yes' },
              { type: 'QUICK_REPLY', text: 'No' },
            ],
          },
        ],
      };
    case 'placeholders':
      return {
        ...base,
        components: [
          { type: 'BODY', text: 'Hi {{1}}, your prize is {{2}}.' },
        ],
      };
    case 'buttons_placeholders':
      return {
        ...base,
        components: [
          { type: 'BODY', text: 'Hi {{1}}, your prize is {{2}}.' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'Claim' },
              { type: 'QUICK_REPLY', text: 'Skip' },
            ],
          },
        ],
      };
    case 'real':
      // Reproduces the exact content the user is trying to create via the dashboard
      return {
        ...base,
        components: [
          {
            type: 'BODY',
            text: "Hello!\n\nThank you for taking part in our previous survey.  We're back with the next survey you requested and the additional {{1}}.\n\nReady to get started?",
          },
        ],
      };
    case 'body_with_example':
      // Full end-to-end dashboard-server shape: POSTBACK buttons + BODY
      // placeholder with sample values (TEMPLATE_VARIABLES_MISSING_SAMPLE_VALUES
      // workaround).
      return {
        ...base,
        components: [
          {
            type: 'BODY',
            text: 'Hi {{1}}, your prize is {{2}}.',
            example: { body_text: [['Alice', '$5']] },
          },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'POSTBACK', text: 'Claim', payload: '{"value":"Claim","ref":"{{1}}"}' },
              { type: 'POSTBACK', text: 'Skip', payload: '{"value":"Skip","ref":"{{1}}"}' },
            ],
          },
        ],
      };
    case 'single_button':
      return {
        ...base,
        components: [
          { type: 'BODY', text: 'Your appointment is confirmed. Coming?' },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'QUICK_REPLY', text: 'Yes!' }],
          },
        ],
      };
    case 'postback':
      return {
        ...base,
        components: [
          { type: 'BODY', text: 'Your appointment is confirmed. Coming?' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'POSTBACK', text: 'Yes!', payload: 'APPOINTMENT_YES' },
            ],
          },
        ],
      };
    case 'postback_placeholder':
      // Tests whether Facebook accepts a {{N}} placeholder inside a POSTBACK
      // payload. If it does, we can use this to inject per-send `ref` values.
      return {
        ...base,
        components: [
          { type: 'BODY', text: 'Your appointment is confirmed. Coming?' },
          {
            type: 'BUTTONS',
            buttons: [
              {
                type: 'POSTBACK',
                text: 'Yes!',
                payload: '{"value":"yes","ref":"{{1}}"}',
              },
            ],
          },
        ],
      };
    default:
      throw new Error(`Unknown VARIANT: ${variant}`);
  }
}

const payload = buildPayload(VARIANT);
console.log(`\n=== Variant: ${VARIANT} ===`);

const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PAGE_ID}/message_templates?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;

(async () => {
  console.log('POST', url.replace(PAGE_ACCESS_TOKEN, 'REDACTED'));
  console.log('Body:', JSON.stringify(payload, null, 2));

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log('\nStatus:', res.status);
  console.log('Headers:');
  for (const [k, v] of res.headers) console.log(`  ${k}: ${v}`);
  console.log('\nBody:');
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
})().catch(err => {
  console.error('Request failed:', err);
  process.exit(1);
});
