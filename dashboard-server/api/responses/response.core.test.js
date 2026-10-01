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

  it('passes a zoned timestamp through unchanged', () => {
    for (const ts of ['2026-09-30T12:00:00Z', '2026-09-30T12:00:00.123456+00:00', '2026-09-30T08:00:00-04:00']) {
      expect(parseResponseFilters({ since: ts }).filters.since).to.equal(ts);
    }
  });

  it('refuses garbage, zone-less times and impossible dates', () => {
    for (const bad of ['last tuesday', '1', '2026-09-30T12:00:00', '2026-09-30 12:00:00Z', '2026-02-30', '2026-09-30T25:00:00Z', ['2026-09-30']]) {
      const out = parseResponseFilters({ since: bad });
      expect(out.ok, JSON.stringify(bad)).to.equal(false);
      expect(out.error).to.match(/^since must be/);
    }
  });

  // ?question_ref=a&question_ref=b arrives from express as an array.
  it('refuses a repeated question_ref', () => {
    expect(parseResponseFilters({ question_ref: ['a', 'b'] }).ok).to.equal(false);
  });
});
