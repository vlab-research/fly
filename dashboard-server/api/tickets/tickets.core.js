'use strict';

const {
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_USER_IDS,
  MAX_REPLY_LENGTH,
} = require('../../utils/linear/linear.core');

// Parse the free-text "impacted user IDs" field into a clean array.
// Accepts comma, newline, or whitespace separation. Duplicates dropped.
function parseUserIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map(s => String(s).trim()).filter(Boolean)));
  }
  return Array.from(new Set(
    String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean),
  ));
}

function validateCreate({ title, description, surveyName, userIds }) {
  if (!title || !String(title).trim()) {
    return { valid: false, error: 'title is required' };
  }
  if (String(title).length > MAX_TITLE_LENGTH) {
    return { valid: false, error: `title exceeds ${MAX_TITLE_LENGTH} characters` };
  }
  if (!description || !String(description).trim()) {
    return { valid: false, error: 'description is required' };
  }
  if (String(description).length > MAX_DESCRIPTION_LENGTH) {
    return { valid: false, error: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
  }
  const normalizedUserIds = parseUserIds(userIds);
  if (normalizedUserIds.length > MAX_USER_IDS) {
    return { valid: false, error: `impacted user IDs exceed ${MAX_USER_IDS} entries` };
  }
  const normalizedSurveyName = (surveyName && String(surveyName).trim()) || null;
  return {
    valid: true,
    title: String(title).trim(),
    description: String(description).trim(),
    surveyName: normalizedSurveyName,
    userIds: normalizedUserIds,
  };
}

function validateReply({ body }) {
  if (!body || !String(body).trim()) {
    return { valid: false, error: 'reply body is required' };
  }
  if (String(body).length > MAX_REPLY_LENGTH) {
    return { valid: false, error: `reply exceeds ${MAX_REPLY_LENGTH} characters` };
  }
  return { valid: true, body: String(body).trim() };
}

module.exports = {
  parseUserIds,
  validateCreate,
  validateReply,
};
