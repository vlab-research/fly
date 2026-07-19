'use strict';

const r2 = require('r2');
const { LIST_PAGE_SIZE } = require('./linear.core');

const ISSUE_CREATE = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`;

const TEAM_ISSUES = `
query TeamIssues($teamId: String!, $first: Int) {
  team(id: $teamId) {
    issues(first: $first) {
      nodes {
        id identifier url title description priority
        createdAt updatedAt
        state { name }
      }
    }
  }
}`;

const ISSUE = `
query Issue($id: String!) {
  issue(id: $id) {
    id identifier url title description priority
    createdAt updatedAt
    state { name }
    comments(first: 100) {
      nodes { id body createdAt user { name } }
    }
  }
}`;

const COMMENT_CREATE = `
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id }
  }
}`;

async function graphqlRequest({ url, apiKey, query, variables }) {
  const res = await r2(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  }).response;
  let json;
  try {
    json = await res.json();
  } catch (e) {
    const text = await res.text().catch(() => '');
    throw new Error(`Linear API returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (json && json.errors && json.errors.map(er => er.message).join('; '))
      || `Linear API HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (json.errors && json.errors.length) {
    throw new Error(json.errors.map(er => er.message).join('; '));
  }
  return json.data;
}

async function createIssue({ apiKey, url, teamId, title, description, stateId }) {
  const input = { teamId, title, description };
  if (stateId) input.stateId = stateId;
  const data = await graphqlRequest({
    url, apiKey,
    query: ISSUE_CREATE,
    variables: { input },
  });
  if (!data.issueCreate || !data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error('Linear issueCreate did not return a successful issue');
  }
  return data.issueCreate.issue;
}

async function listTeamIssues({ apiKey, url, teamId, first }) {
  const data = await graphqlRequest({
    url, apiKey,
    query: TEAM_ISSUES,
    variables: { teamId, first: first || LIST_PAGE_SIZE },
  });
  if (!data.team || !data.team.issues) {
    throw new Error(`Linear team ${teamId} not found`);
  }
  return data.team.issues.nodes;
}

async function getIssue({ apiKey, url, id }) {
  const data = await graphqlRequest({
    url, apiKey,
    query: ISSUE,
    variables: { id },
  });
  return data.issue;
}

async function createComment({ apiKey, url, issueId, body }) {
  const data = await graphqlRequest({
    url, apiKey,
    query: COMMENT_CREATE,
    variables: { input: { issueId, body } },
  });
  if (!data.commentCreate || !data.commentCreate.success || !data.commentCreate.comment) {
    throw new Error('Linear commentCreate did not return a successful comment');
  }
  return data.commentCreate.comment;
}

function makeClient({ apiKey, url, teamId }) {
  const bound = {
    apiKey,
    url,
    teamId,
  };
  return {
    createIssue: ({ title, description, stateId }) => createIssue({ ...bound, teamId, title, description, stateId }),
    listTeamIssues: ({ first } = {}) => listTeamIssues({ ...bound, teamId, first }),
    getIssue: ({ id }) => getIssue({ ...bound, id }),
    createComment: ({ issueId, body }) => createComment({ ...bound, issueId, body }),
  };
}

module.exports = {
  graphqlRequest,
  createIssue,
  listTeamIssues,
  getIssue,
  createComment,
  makeClient,
};
