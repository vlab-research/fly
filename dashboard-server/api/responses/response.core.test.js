'use strict';

const { expect } = require('chai');
const { parseResponseFilters } = require('./response.core');

describe('response.core: parseResponseFilters', () => {
  it('is no filter at all when neither is given', () => {
    expect(parseResponseFilters({ survey: 'S' })).to.eql({ ok: true, filters: { questionRef: null, since: null } });
  });

  it('carries question_ref and a validated since', () => {
    expect(parseResponseFilters({ question_ref: 'complete', since: '2026-09-30' })).to.eql({
      ok: true,
      filters: { questionRef: 'complete', since: '2026-09-30T00:00:00Z' },
    });
  });

  it('refuses a since that is not a timestamp', () => {
    const out = parseResponseFilters({ since: 'last tuesday' });
    expect(out.ok).to.equal(false);
    expect(out.error).to.match(/since/);
  });

  // ?question_ref=a&question_ref=b arrives from express as an array.
  it('refuses a repeated question_ref', () => {
    expect(parseResponseFilters({ question_ref: ['a', 'b'] }).ok).to.equal(false);
  });
});
