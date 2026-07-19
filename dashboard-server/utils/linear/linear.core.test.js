'use strict';

const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars

const {
  REPORTER_MARKER_PREFIX,
  MAX_TITLE_LENGTH,
  buildReporterMarker,
  buildIssueDescription,
  buildReplyBody,
  isReporterIssue,
  extractReporter,
  formatIssue,
  formatIssueDetail,
  sortByCreatedDesc,
  filterByReporter,
} = require('./linear.core');

describe('linear.core', () => {
  // -------------------------------------------------------
  // buildReporterMarker
  // -------------------------------------------------------
  describe('buildReporterMarker', () => {
    it('prefixes the email with the sentinel', () => {
      buildReporterMarker('alice@vlab.com').should.equal('vlab-reporter:alice@vlab.com');
    });
  });

  // -------------------------------------------------------
  // buildIssueDescription — assembles user body + context + reporter marker
  // -------------------------------------------------------
  describe('buildIssueDescription', () => {
    it('appends only the reporter marker when no context fields are supplied', () => {
      const out = buildIssueDescription({ body: 'Something broke', email: 'a@vlab.com' });
      out.should.include('Something broke');
      out.should.include('vlab-reporter:a@vlab.com');
      out.should.not.include('**Context**');
    });

    it('includes a Context block with survey and user IDs when supplied', () => {
      const out = buildIssueDescription({
        body: 'It broke', surveyName: 'HPV Nigeria', userIds: ['123', '456'], email: 'a@vlab.com',
      });
      out.should.include('**Context**');
      out.should.include('**Survey:** HPV Nigeria');
      out.should.include('**Impacted user IDs:** 123, 456');
    });

    it('omits the survey line when surveyName is empty', () => {
      const out = buildIssueDescription({ body: 'b', surveyName: '', userIds: ['1'], email: 'a@vlab.com' });
      out.should.not.include('**Survey:**');
      out.should.include('**Impacted user IDs:** 1');
    });

    it('omits the user IDs line when userIds is empty', () => {
      const out = buildIssueDescription({ body: 'b', surveyName: 'S', userIds: [], email: 'a@vlab.com' });
      out.should.include('**Survey:** S');
      out.should.not.include('**Impacted user IDs**');
    });

    it('places the reporter marker as the final line', () => {
      const out = buildIssueDescription({ body: 'b', surveyName: 'S', userIds: ['1'], email: 'a@vlab.com' });
      out.should.match(/\*vlab-reporter:a@vlab\.com\*$/);
    });

    it('trims the leading/trailing whitespace from the body', () => {
      const out = buildIssueDescription({ body: '  hi  ', email: 'a@vlab.com' });
      out.should.match(/^hi/);
    });
  });

  // -------------------------------------------------------
  // buildReplyBody — appends reporter attribution to a reply
  // -------------------------------------------------------
  describe('buildReplyBody', () => {
    it('appends the reporter marker to the reply', () => {
      buildReplyBody({ body: 'Any update?', email: 'a@vlab.com' })
        .should.equal('Any update?\n\n*vlab-reporter:a@vlab.com*');
    });

    it('omits the marker when email is missing (defensive)', () => {
      buildReplyBody({ body: 'hi', email: undefined }).should.equal('hi');
    });

    it('trims the body', () => {
      buildReplyBody({ body: '  hi  ', email: 'a@vlab.com' }).should.match(/^hi/);
    });
  });

  // -------------------------------------------------------
  // isReporterIssue — sentinel membership test
  // -------------------------------------------------------
  describe('isReporterIssue', () => {
    it('returns true when the description contains the caller marker', () => {
      const issue = { description: 'x\n\n*vlab-reporter:alice@vlab.com*' };
      isReporterIssue(issue, 'alice@vlab.com').should.equal(true);
    });

    it('returns false when the marker belongs to a different email', () => {
      const issue = { description: 'x\n\n*vlab-reporter:bob@vlab.com*' };
      isReporterIssue(issue, 'alice@vlab.com').should.equal(false);
    });

    it('returns false when the description has no marker at all', () => {
      isReporterIssue({ description: 'plain text' }, 'a@vlab.com').should.equal(false);
    });

    it('returns false for null/missing issues or descriptions', () => {
      isReporterIssue(null, 'a@vlab.com').should.equal(false);
      isReporterIssue({}, 'a@vlab.com').should.equal(false);
    });
  });

  // -------------------------------------------------------
  // extractReporter — pulls the email out of a description or comment body
  // -------------------------------------------------------
  describe('extractReporter', () => {
    it('extracts the email from an issue description marker', () => {
      extractReporter({ description: '...\n\n*vlab-reporter:alice@vlab.com*' })
        .should.equal('alice@vlab.com');
    });

    it('returns null when no marker is present', () => {
      should.equal(extractReporter({ description: 'no marker here' }), null);
    });

    it('returns null for null/missing input', () => {
      should.equal(extractReporter(null), null);
      should.equal(extractReporter({}), null);
    });
  });

  // -------------------------------------------------------
  // formatIssue — DB/wire shape for list view
  // -------------------------------------------------------
  describe('formatIssue', () => {
    it('maps the Linear issue node to the list shape', () => {
      const issue = {
        id: 'i1', identifier: 'VLAB-1', url: 'https://linear.app/issue/VLAB-1',
        title: 'T', priority: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
        state: { name: 'In Progress' },
      };
      formatIssue(issue).should.deep.equal({
        id: 'i1', identifier: 'VLAB-1', url: 'https://linear.app/issue/VLAB-1',
        title: 'T', state: 'In Progress', priority: 2,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
      });
    });

    it('returns null for a missing issue', () => {
      should.equal(formatIssue(null), null);
    });
  });

  // -------------------------------------------------------
  // formatIssueDetail — includes description + flattened comments sorted asc
  // -------------------------------------------------------
  describe('formatIssueDetail', () => {
    it('flattens comments and sorts them oldest-first', () => {
      const issue = {
        id: 'i1', identifier: 'VLAB-1', url: 'u', title: 'T', priority: 0,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z',
        state: { name: 'Backlog' },
        description: 'body\n\n*vlab-reporter:a@vlab.com*',
        comments: {
          nodes: [
            { id: 'c2', body: 'second', createdAt: '2026-01-02T00:00:00Z', user: { name: 'Sam' } },
            { id: 'c1', body: 'first', createdAt: '2026-01-01T00:00:00Z', user: { name: 'Bot' } },
          ],
        },
      };
      const out = formatIssueDetail(issue);
      out.comments.should.have.length(2);
      out.comments[0].id.should.equal('c1');
      out.comments[1].id.should.equal('c2');
      out.comments[0].author.should.equal('Bot');
      should.equal(out.comments[0].reporterEmail, null);
    });

    it('detects reporter email on a comment that came from the dashboard', () => {
      const issue = {
        id: 'i', identifier: 'VLAB-1', url: 'u', title: 't',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        state: { name: 'Backlog' }, description: 'd\n\n*vlab-reporter:a@vlab.com*',
        comments: { nodes: [{ id: 'c', body: 'reply\n\n*vlab-reporter:a@vlab.com*', createdAt: 't', user: { name: 'Bot' } }] },
      };
      formatIssueDetail(issue).comments[0].reporterEmail.should.equal('a@vlab.com');
    });

    it('returns [] comments when the connection is missing', () => {
      const issue = { id: 'i', identifier: 'VLAB-1', url: 'u', title: 't', createdAt: 't', updatedAt: 't', state: { name: 'Backlog' }, description: 'd' };
      formatIssueDetail(issue).comments.should.deep.equal([]);
    });
  });

  // -------------------------------------------------------
  // sortByCreatedDesc / filterByReporter
  // -------------------------------------------------------
  describe('sortByCreatedDesc', () => {
    it('sorts newest first and does not mutate the input', () => {
      const items = [
        { createdAt: '2026-01-01T00:00:00Z' },
        { createdAt: '2026-03-01T00:00:00Z' },
        { createdAt: '2026-02-01T00:00:00Z' },
      ];
      const sorted = sortByCreatedDesc(items);
      sorted.map(i => i.createdAt).should.deep.equal([
        '2026-03-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z',
      ]);
      items[0].createdAt.should.equal('2026-01-01T00:00:00Z');
    });
  });

  describe('filterByReporter', () => {
    it('keeps only issues whose marker matches the email', () => {
      const issues = [
        { description: 'vlab-reporter:alice@vlab.com' },
        { description: 'vlab-reporter:bob@vlab.com' },
        { description: 'no marker' },
      ];
      filterByReporter(issues, 'alice@vlab.com').should.have.length(1);
    });
  });

  it('exports the constants used by validation', () => {
    REPORTER_MARKER_PREFIX.should.equal('vlab-reporter:');
    MAX_TITLE_LENGTH.should.be.a('number');
  });
});
