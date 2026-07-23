'use strict';

require('chai').should();

const { translateAlerts } = require('./notices');
const { platformNotices } = require('./rules');

const alert = (alertname, startsAt = '2026-07-22T10:00:00Z') => ({
  labels: { alertname, severity: 'critical' },
  startsAt,
});

describe('platform notices translation (pure)', () => {
  it('translates whitelisted alertnames to researcher copy', () => {
    const notices = translateAlerts(
      [alert('PlatformRateLimited')],
      platformNotices
    );
    notices.length.should.equal(1);
    notices[0].alertname.should.equal('PlatformRateLimited');
    notices[0].message.should.contain('rate-limiting');
    notices[0].since.should.equal('2026-07-22T10:00:00Z');
  });

  it('drops unlisted alertnames (infra alerts)', () => {
    const notices = translateAlerts(
      [alert('KubeProxyDown'), alert('TargetDown'), alert('PlatformInternalErrors')],
      platformNotices
    );
    notices.length.should.equal(1);
    notices[0].alertname.should.equal('PlatformInternalErrors');
  });

  it('dedupes repeated alertnames (grouped alerts fire per-labelset)', () => {
    const notices = translateAlerts(
      [alert('DeanExpiredWaits', '2026-07-22T09:00:00Z'), alert('DeanExpiredWaits', '2026-07-22T10:00:00Z')],
      platformNotices
    );
    notices.length.should.equal(1);
    notices[0].since.should.equal('2026-07-22T09:00:00Z');
  });

  it('tolerates malformed input without throwing', () => {
    translateAlerts(null, platformNotices).should.deep.equal([]);
    translateAlerts([{}, { labels: {} }], platformNotices).should.deep.equal([]);
  });
});
