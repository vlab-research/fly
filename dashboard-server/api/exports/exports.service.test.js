'use strict';

/*
 * listExports is the only path by which export links reach a caller (REST
 * /exports/status* and the MCP list_exports tool). `queries/` is replaced, so no
 * pg Pool is constructed.
 */

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

const { ownerPrefix } = require('./exports.keys');

const ALICE = 'alice@example.org';
const BOB = 'bob@example.org';

const link = key => `https://storage-api.vlab.digital/fly/${key}?X-Amz-Signature=abc`;

// Alice's own rows. `default` is also the name of one of Bob's surveys.
const ROWS = [
  { id: 'new', user_id: ALICE, survey_id: 'default', status: 'Finished', export_link: link(`exports/${ownerPrefix(ALICE)}/default.csv`) },
  { id: 'old', user_id: ALICE, survey_id: 'default', status: 'Finished', export_link: link('exports/default.csv') },
  { id: 'foreign', user_id: ALICE, survey_id: 'default', status: 'Finished', export_link: link(`exports/${ownerPrefix(BOB)}/default.csv`) },
  { id: 'pending', user_id: ALICE, survey_id: 'default', status: 'Requested', export_link: 'Not Found' },
];

function load() {
  const queries = {
    Exports: {
      async bySurvey() { return { responses: ROWS }; },
      async all() { return { responses: ROWS }; },
    },
    User: { async user({ email }) { return { email }; } },
  };
  return proxyquire('./exports.service', { '../../queries': queries });
}

const linksById = rows => Object.fromEntries(rows.map(r => [r.id, r.export_link]));

describe('exports.service listExports', () => {
  [
    ['by survey', { survey_name: 'default' }],
    ['all', {}],
  ].forEach(([label, args]) => {
    it(`${label}: serves only links under the caller's own key prefix`, async () => {
      const rows = await load().listExports({ email: ALICE, ...args });
      expect(linksById(rows)).to.eql({
        new: ROWS[0].export_link,
        old: 'Not Found',
        foreign: 'Not Found',
        pending: 'Not Found',
      });
    });
  });
});
