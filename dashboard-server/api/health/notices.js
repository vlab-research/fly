'use strict';

// Pure translation from AlertManager v2 alert objects to researcher-facing
// platform notices. Whitelist + copy live in rules.js (platformNotices);
// anything not listed there — all infra alerts — is dropped.
//
// alerts: [{ labels: { alertname, ... }, startsAt, ... }]
// -> [{ alertname, message, since }]
function translateAlerts(alerts, table) {
  if (!Array.isArray(alerts)) return [];

  const seen = new Set();
  const notices = [];

  alerts.forEach(alert => {
    const alertname = alert && alert.labels && alert.labels.alertname;
    if (!alertname || !table[alertname] || seen.has(alertname)) return;
    seen.add(alertname);
    notices.push({
      alertname,
      message: table[alertname],
      since: alert.startsAt || null,
    });
  });

  return notices;
}

module.exports = { translateAlerts };
