'use strict';

const {
  buildIssueDescription,
  buildReplyBody,
  formatIssue,
  formatIssueDetail,
  isReporterIssue,
  sortByCreatedDesc,
  filterByReporter,
} = require('../../utils/linear/linear.core');
const { validateCreate, validateReply } = require('./tickets.core');

function makeHandlers({ linearClient, apiKey, teamId, todoStateId }) {
  function ensureConfigured(res) {
    if (!apiKey || !teamId) {
      res.status(503).json({ error: 'Linear is not configured on the server. Set LINEAR_API_KEY and LINEAR_TEAM_ID.' });
      return true;
    }
    return false;
  }

  async function list(req, res) {
    const { email } = req.user;
    if (ensureConfigured(res)) return;
    try {
      const issues = await linearClient.listTeamIssues({});
      const mine = sortByCreatedDesc(filterByReporter(issues, email));
      return res.status(200).json(mine.map(formatIssue));
    } catch (e) {
      console.error('tickets list error:', e);
      return res.status(502).json({ error: e.message || 'Failed to reach Linear' });
    }
  }

  async function create(req, res) {
    const { email } = req.user;
    if (ensureConfigured(res)) return;
    const v = validateCreate(req.body);
    if (!v.valid) return res.status(400).json({ error: v.error });

    try {
      const description = buildIssueDescription({
        body: v.description,
        surveyName: v.surveyName,
        userIds: v.userIds,
        email,
      });
      const issue = await linearClient.createIssue({ title: v.title, description, stateId: todoStateId || undefined });
      return res.status(201).json(formatIssue(issue));
    } catch (e) {
      console.error('tickets create error:', e);
      return res.status(502).json({ error: e.message || 'Failed to create issue in Linear' });
    }
  }

  async function getOne(req, res) {
    const { email } = req.user;
    const { id } = req.params;
    if (ensureConfigured(res)) return;
    try {
      const issue = await linearClient.getIssue({ id });
      // 404 (not 403) when missing or not owned by caller — don't leak that
      // another user's ticket exists.
      if (!issue || !isReporterIssue(issue, email)) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      return res.status(200).json(formatIssueDetail(issue));
    } catch (e) {
      console.error('tickets getOne error:', e);
      return res.status(502).json({ error: e.message || 'Failed to reach Linear' });
    }
  }

  async function reply(req, res) {
    const { email } = req.user;
    const { id } = req.params;
    if (ensureConfigured(res)) return;
    const v = validateReply(req.body);
    if (!v.valid) return res.status(400).json({ error: v.error });

    try {
      const issue = await linearClient.getIssue({ id });
      if (!issue || !isReporterIssue(issue, email)) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      const body = buildReplyBody({ body: v.body, email });
      const comment = await linearClient.createComment({ issueId: id, body });
      return res.status(201).json({
        id: comment.id,
        body,
        createdAt: new Date().toISOString(),
        author: null,
        reporterEmail: email,
      });
    } catch (e) {
      console.error('tickets reply error:', e);
      return res.status(502).json({ error: e.message || 'Failed to post reply to Linear' });
    }
  }

  return { list, create, getOne, reply };
}

module.exports = { makeHandlers };
