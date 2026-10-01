'use strict';

const { expect } = require('chai');
const { parseBailEventsQuery, shapeBailEvents, BAIL_EVENTS_LIMIT } = require('./bails.core');

describe('bails.core: parseBailEventsQuery', () => {
  it('defaults the limit and leaves the filters off', () => {
    expect(parseBailEventsQuery({})).to.eql({
      ok: true,
      query: { bailId: null, limit: BAIL_EVENTS_LIMIT.default, since: null },
    });
  });

  it('reads limit, since and bail_id from the query string', () => {
    expect(parseBailEventsQuery({ limit: '20', since: '2026-09-30T00:00:00Z', bail_id: 'b1' })).to.eql({
      ok: true,
      query: { bailId: 'b1', limit: 20, since: '2026-09-30T00:00:00Z' },
    });
  });

  it('refuses a limit outside 1..max rather than clamping it', () => {
    for (const limit of ['0', '501', 'ten', '2.5', '-1']) {
      expect(parseBailEventsQuery({ limit }).ok, limit).to.equal(false);
    }
  });

  it('refuses a since that is not a timestamp', () => {
    expect(parseBailEventsQuery({ since: 'yesterday' }).ok).to.equal(false);
  });
});

describe('bails.core: shapeBailEvents with since', () => {
  const event = ts => ({ id: ts, bail_id: 'b1', event_type: 'execution', timestamp: ts });
  const rows = [event('2026-09-30T12:00:00.5Z'), event('2026-09-30T11:00:00Z'), event('2026-09-29T00:00:00Z')];

  it('keeps only events at or after since, inclusive', () => {
    const page = shapeBailEvents(rows, 10, '2026-09-30T11:00:00Z');
    expect(page.items.map(e => e.id)).to.eql(['2026-09-30T12:00:00.5Z', '2026-09-30T11:00:00Z']);
    expect(page.truncated).to.equal(false);
  });

  it('applies since before the limit', () => {
    const page = shapeBailEvents(rows, 1, '2026-09-30T00:00:00Z');
    expect(page.count).to.equal(1);
    expect(page.truncated).to.equal(true);
  });

  it('keeps everything without since', () => {
    expect(shapeBailEvents(rows, 10).count).to.equal(3);
  });
});
