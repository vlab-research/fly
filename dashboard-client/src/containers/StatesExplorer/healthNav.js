// Pure helpers for the survey-health surface. The client holds no health
// logic — findings arrive fully resolved from the server; these helpers only
// map `level` -> presentation and `action.dest` -> URL.

// Only `action` findings light the Monitor tab badge; `note` findings and
// platform notices do not.
export const hasActionFindings = findings => (findings || []).some(f => f.level === 'action');

// Map a finding's action to a URL. `monitorUrl` is the Monitor tab base
// (e.g. /surveys/My%20Survey/monitor). Returns null for unknown dests so
// the caller renders the message without a link (forward-compat with new
// server-side dests).
export const destToUrl = (action, monitorUrl) => {
  if (!action || !action.dest) return null;

  if (action.dest === 'states-list') {
    // Same query-param convention StatesSummary uses to drill into
    // StatesList (state/form/error_tag/search).
    const params = new URLSearchParams();
    Object.entries(action.filter || {}).forEach(([key, value]) => {
      if (value) params.append(key, value);
    });
    const qs = params.toString();
    return `${monitorUrl}/list${qs ? `?${qs}` : ''}`;
  }

  if (action.dest === 'message-templates') {
    return '/message-templates';
  }

  return null;
};
