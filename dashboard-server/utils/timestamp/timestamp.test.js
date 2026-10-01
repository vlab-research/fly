'use strict';

const { expect } = require('chai');
const { parseTimestamp } = require('.');

describe('parseTimestamp', () => {
  it('treats an absent value as no filter', () => {
    expect(parseTimestamp(undefined)).to.eql({ ok: true, value: null });
    expect(parseTimestamp('')).to.eql({ ok: true, value: null });
  });

  it('passes an RFC 3339 timestamp through, sub-millisecond digits included', () => {
    for (const ts of ['2026-09-30T12:00:00Z', '2026-09-30T12:00:00.123456+00:00', '2026-09-30T08:00:00-04:00']) {
      expect(parseTimestamp(ts)).to.eql({ ok: true, value: ts });
    }
  });

  it('reads a bare date as midnight UTC', () => {
    expect(parseTimestamp('2026-09-30')).to.eql({ ok: true, value: '2026-09-30T00:00:00Z' });
  });

  it('refuses garbage, zone-less times and impossible dates, naming the parameter', () => {
    for (const bad of ['yesterday', '1', '2026-09-30T12:00:00', '2026-09-30 12:00:00Z', '2026-02-30', '2026-09-30T25:00:00Z', ['2026-09-30']]) {
      const out = parseTimestamp(bad, 'since');
      expect(out.ok, JSON.stringify(bad)).to.equal(false);
      expect(out.error).to.match(/^since must be/);
    }
  });
});
