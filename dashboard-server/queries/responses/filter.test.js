'use strict';

const { expect } = require('chai');
const { filterClauses } = require('./response.queries');

describe('Response queries: filterClauses', () => {
  it('adds nothing without filters', () => {
    expect(filterClauses({}, 7)).to.eql({ sql: '', params: [] });
  });

  it('numbers its placeholders from firstParam, in a stable order', () => {
    const { sql, params } = filterClauses({ questionRef: 'complete', since: '2026-09-30T00:00:00Z' }, 7);
    expect(sql).to.match(/question_ref = \$7/).and.match(/timestamp >= \$8::TIMESTAMPTZ/);
    expect(params).to.eql(['complete', '2026-09-30T00:00:00Z']);
  });

  it('numbers since alone from firstParam', () => {
    const { sql, params } = filterClauses({ since: '2026-09-30T00:00:00Z' }, 7);
    expect(sql).to.match(/timestamp >= \$7::TIMESTAMPTZ/);
    expect(params).to.eql(['2026-09-30T00:00:00Z']);
  });
});
