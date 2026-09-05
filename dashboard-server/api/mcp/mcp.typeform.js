'use strict';

/*
 * The one Typeform call the dashboard has never needed: creating a form.
 *
 * `utils/typeform/typeform.util.js` reads forms (list / get / messages) because
 * until now the dashboard was only ever a picker over forms a researcher had
 * already authored by hand. The MCP surface is the first caller that writes, so
 * the write lives here rather than being bolted onto a util another agent owns.
 *
 * The base URL is read from the same TYPEFORM config as every other Typeform
 * call, so a staging or mock endpoint applies here too — a second hardcoded
 * https://api.typeform.com would be a copy that can silently disagree.
 */

const fetch = require('node-fetch');

const { TYPEFORM: { typeformUrl } } = require('../../config');

const FORM_URL = id => `https://form.typeform.com/to/${id}`;

/*
 * Errors carry Typeform's own body verbatim. Typeform's 400s name the offending
 * field path ("fields[2].properties.choices"), which is the only thing that
 * makes an authoring failure fixable without a round trip through a human.
 */
async function createForm(token, payload) {
  const res = await fetch(`${typeformUrl}/forms`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`Typeform rejected the form (HTTP ${res.status}): ${text}`);
    err.status = res.status;
    err.typeform = true;
    throw err;
  }

  const body = text ? JSON.parse(text) : {};
  return { id: body.id, url: FORM_URL(body.id), title: body.title };
}

module.exports = { createForm, FORM_URL };
