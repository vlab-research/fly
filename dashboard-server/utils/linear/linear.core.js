'use strict';

// Sentinel stamped into every issue description so the dashboard can scope
// "my tickets" by reporter email without local storage. The form
// `vlab-reporter:<email>` is distinctive enough that it won't collide with
// content a user might type into their own description, and it renders as
// discreet italic text at the bottom of the Linear issue.
const REPORTER_MARKER_PREFIX = 'vlab-reporter:';

const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 20000;
const MAX_USER_IDS = 200;
const MAX_REPLY_LENGTH = 20000;
const LIST_PAGE_SIZE = 100;

function buildReporterMarker(email) {
  return `${REPORTER_MARKER_PREFIX}${email}`;
}

function buildIssueDescription({ body, surveyName, userIds, email }) {
  const parts = [body && body.trim()];

  const contextLines = [];
  if (surveyName) contextLines.push(`- **Survey:** ${surveyName}`);
  if (Array.isArray(userIds) && userIds.length > 0) {
    contextLines.push(`- **Impacted user IDs:** ${userIds.join(', ')}`);
  }
  if (contextLines.length > 0) {
    parts.push('---\n\n**Context**\n' + contextLines.join('\n'));
  }

  // Reporter marker always last, on its own line, so extractReporter can
  // find it reliably regardless of what the user typed above.
  parts.push(`*${buildReporterMarker(email)}*`);
  return parts.filter(Boolean).join('\n\n');
}

function buildReplyBody({ body, email }) {
  const trimmed = body && body.trim();
  if (!email) return trimmed;
  return `${trimmed}\n\n*${buildReporterMarker(email)}*`;
}

function isReporterIssue(issue, email) {
  if (!issue || !issue.description) return false;
  return issue.description.includes(buildReporterMarker(email));
}

function extractReporter(issue) {
  if (!issue || !issue.description) return null;
  const idx = issue.description.indexOf(REPORTER_MARKER_PREFIX);
  if (idx === -1) return null;
  const start = idx + REPORTER_MARKER_PREFIX.length;
  // The marker ends at the first whitespace, backtick, asterisk, or newline.
  const rest = issue.description.slice(start);
  const match = rest.match(/^[^\s`*]+/);
  return match ? match[0] : null;
}

function formatIssue(issue) {
  if (!issue) return null;
  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    title: issue.title,
    state: issue.state && issue.state.name,
    priority: issue.priority,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function formatIssueDetail(issue) {
  const base = formatIssue(issue);
  if (!base) return null;
  const comments = (issue.comments && Array.isArray(issue.comments.nodes))
    ? issue.comments.nodes.map(formatComment).filter(Boolean)
    : [];
  comments.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return ta - tb;
  });
  return { ...base, description: issue.description, comments };
}

function formatComment(comment) {
  if (!comment) return null;
  return {
    id: comment.id,
    body: comment.body,
    createdAt: comment.createdAt,
    author: (comment.user && comment.user.name) || null,
    reporterEmail: extractReporter({ description: comment.body }),
  };
}

function sortByCreatedDesc(items) {
  return items.slice().sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });
}

function filterByReporter(issues, email) {
  return issues.filter(issue => isReporterIssue(issue, email));
}

module.exports = {
  REPORTER_MARKER_PREFIX,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_USER_IDS,
  MAX_REPLY_LENGTH,
  LIST_PAGE_SIZE,
  buildReporterMarker,
  buildIssueDescription,
  buildReplyBody,
  isReporterIssue,
  extractReporter,
  formatIssue,
  formatIssueDetail,
  formatComment,
  sortByCreatedDesc,
  filterByReporter,
};
