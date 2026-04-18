'use strict';

const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars

const {
  validateCreateInput,
  buildFacebookCreatePayload,
  parseCreateResponse,
  parseListResponse,
  matchFbEntry,
  formatRecord,
  normalizeStatus,
  MAX_BODY_LENGTH,
} = require('./message-templates.core');

describe('message-templates.core', () => {
  // -------------------------------------------------------
  // validateCreateInput — branching validation logic
  // -------------------------------------------------------
  describe('validateCreateInput', () => {
    const valid = { pageId: 'p1', name: 'prize_ready', language: 'en_US', body: 'Hi {{1}}' };

    it('accepts complete, correct input', () => {
      validateCreateInput(valid).should.deep.equal({ valid: true });
    });

    it('rejects missing pageId', () => {
      const r = validateCreateInput({ ...valid, pageId: undefined });
      r.valid.should.equal(false);
      r.error.should.include('pageId');
    });

    it('rejects empty-string pageId', () => {
      validateCreateInput({ ...valid, pageId: '' }).valid.should.equal(false);
    });

    it('rejects missing name', () => {
      const r = validateCreateInput({ ...valid, name: undefined });
      r.valid.should.equal(false);
      r.error.should.include('name');
    });

    it('rejects uppercase letters in name', () => {
      // Facebook requires snake_case; pattern enforces that at API boundary
      const r = validateCreateInput({ ...valid, name: 'PrizeReady' });
      r.valid.should.equal(false);
      r.error.should.include('snake_case');
    });

    it('rejects hyphen in name', () => {
      validateCreateInput({ ...valid, name: 'prize-ready' }).valid.should.equal(false);
    });

    it('rejects name with spaces', () => {
      validateCreateInput({ ...valid, name: 'prize ready' }).valid.should.equal(false);
    });

    it('accepts digits and underscores in name', () => {
      validateCreateInput({ ...valid, name: 'prize_2_ready' }).should.deep.equal({ valid: true });
    });

    it('rejects missing language', () => {
      const r = validateCreateInput({ ...valid, language: undefined });
      r.valid.should.equal(false);
      r.error.should.include('language');
    });

    it('rejects missing body', () => {
      const r = validateCreateInput({ ...valid, body: undefined });
      r.valid.should.equal(false);
      r.error.should.include('body');
    });

    it('rejects body over the character limit', () => {
      const r = validateCreateInput({ ...valid, body: 'x'.repeat(MAX_BODY_LENGTH + 1) });
      r.valid.should.equal(false);
      r.error.should.include('1024');
    });

    it('accepts body at exactly the character limit (boundary)', () => {
      const r = validateCreateInput({ ...valid, body: 'x'.repeat(MAX_BODY_LENGTH) });
      r.should.deep.equal({ valid: true });
    });

    it('reports pageId error before name when both are missing', () => {
      // Predictable short-circuit order: authors see the first missing field first
      const r = validateCreateInput({ pageId: '', name: '', language: 'en_US', body: 'x' });
      r.error.should.include('pageId');
    });
  });

  // -------------------------------------------------------
  // buildFacebookCreatePayload — pure transformation
  // -------------------------------------------------------
  describe('buildFacebookCreatePayload', () => {
    it('builds the canonical UTILITY template shape', () => {
      const payload = buildFacebookCreatePayload({ name: 'prize', language: 'en_US', body: 'Hi {{1}}' });
      payload.should.deep.equal({
        name: 'prize',
        language: 'en_US',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Hi {{1}}' }],
      });
    });

    it('always sets category to UTILITY (never promotional/auth)', () => {
      // Guard against accidental future support for MARKETING/AUTHENTICATION —
      // this dashboard only authors UTILITY templates.
      const payload = buildFacebookCreatePayload({ name: 'x', language: 'fr', body: 'b' });
      payload.category.should.equal('UTILITY');
    });
  });

  // -------------------------------------------------------
  // parseCreateResponse — FB success / error branches
  // -------------------------------------------------------
  describe('parseCreateResponse', () => {
    it('extracts id and status on APPROVED response', () => {
      parseCreateResponse({ id: '12345', status: 'APPROVED', category: 'UTILITY' })
        .should.deep.equal({ ok: true, fbTemplateId: '12345', status: 'APPROVED' });
    });

    it('extracts id and status on PENDING response', () => {
      parseCreateResponse({ id: '12345', status: 'PENDING' })
        .should.deep.equal({ ok: true, fbTemplateId: '12345', status: 'PENDING' });
    });

    it('defaults missing status to PENDING', () => {
      // FB sometimes returns only an id without status; treat that as PENDING
      // so the poller can pick it up and fill in the real value.
      parseCreateResponse({ id: '12345' }).status.should.equal('PENDING');
    });

    it('normalizes lowercase status', () => {
      parseCreateResponse({ id: '1', status: 'approved' }).status.should.equal('APPROVED');
    });

    it('falls back to PENDING on unknown status string', () => {
      // Unknown statuses shouldn't silently pass through — the DB only carries a finite set
      parseCreateResponse({ id: '1', status: 'WAT' }).status.should.equal('PENDING');
    });

    it('forwards the FB error object on API errors', () => {
      const fbError = { message: 'Invalid body', type: 'OAuthException', code: 100 };
      const r = parseCreateResponse({ error: fbError });
      r.ok.should.equal(false);
      r.error.should.deep.equal(fbError);
    });

    it('treats null response as an error (network-level failure)', () => {
      const r = parseCreateResponse(null);
      r.ok.should.equal(false);
      r.error.message.should.include('Empty');
    });

    it('prefers error over id when both are present', () => {
      // Defensive: FB shouldn't send both, but if it does we must not pretend success
      const r = parseCreateResponse({ id: '1', error: { message: 'partial failure' } });
      r.ok.should.equal(false);
    });
  });

  // -------------------------------------------------------
  // parseListResponse — FB list response parsing
  // -------------------------------------------------------
  describe('parseListResponse', () => {
    it('maps all data entries including language and status', () => {
      const fb = {
        data: [
          { id: '1', name: 'prize', language: 'en_US', status: 'APPROVED' },
          { id: '2', name: 'prize', language: 'es_LA', status: 'PENDING' },
        ],
      };
      parseListResponse(fb).should.deep.equal([
        { fbTemplateId: '1', name: 'prize', language: 'en_US', status: 'APPROVED', rejectionReason: null },
        { fbTemplateId: '2', name: 'prize', language: 'es_LA', status: 'PENDING', rejectionReason: null },
      ]);
    });

    it('extracts rejected_reason when present', () => {
      const fb = {
        data: [{ id: '1', name: 'x', language: 'en_US', status: 'REJECTED', rejected_reason: 'PROMOTIONAL' }],
      };
      parseListResponse(fb)[0].rejectionReason.should.equal('PROMOTIONAL');
    });

    it('returns empty array on missing data field', () => {
      parseListResponse({}).should.deep.equal([]);
    });

    it('returns empty array on null response', () => {
      parseListResponse(null).should.deep.equal([]);
    });

    it('returns empty array on FB error response (does not crash the list endpoint)', () => {
      // The list endpoint degrades gracefully if an individual name lookup fails
      parseListResponse({ error: { message: 'rate limited' } }).should.deep.equal([]);
    });
  });

  // -------------------------------------------------------
  // matchFbEntry — (name, language) composite-key match
  // -------------------------------------------------------
  describe('matchFbEntry', () => {
    const entries = [
      { name: 'prize', language: 'en_US', status: 'APPROVED' },
      { name: 'prize', language: 'es_LA', status: 'PENDING' },
    ];

    it('matches on the full (name, language) tuple', () => {
      matchFbEntry({ name: 'prize', language: 'es_LA' }, entries)
        .should.have.property('status', 'PENDING');
    });

    it('returns null when name matches but language does not (identity requires both)', () => {
      // Same name, different language = different template.
      // This is the whole point of the composite-key model.
      should.equal(matchFbEntry({ name: 'prize', language: 'fr' }, entries), null);
    });

    it('returns null when no entry matches', () => {
      should.equal(matchFbEntry({ name: 'other', language: 'en_US' }, entries), null);
    });
  });

  // -------------------------------------------------------
  // normalizeStatus
  // -------------------------------------------------------
  describe('normalizeStatus', () => {
    it('uppercases valid statuses', () => {
      normalizeStatus('approved').should.equal('APPROVED');
      normalizeStatus('Pending').should.equal('PENDING');
    });

    it('returns null for unknown status', () => {
      should.equal(normalizeStatus('weird'), null);
    });

    it('returns null for null/undefined', () => {
      should.equal(normalizeStatus(null), null);
      should.equal(normalizeStatus(undefined), null);
    });
  });

  // -------------------------------------------------------
  // formatRecord — DB row → API shape
  // -------------------------------------------------------
  describe('formatRecord', () => {
    it('keeps the snake_case wire shape expected by the client', () => {
      const row = {
        id: 'u1', facebook_page_id: 'p1', fb_template_id: 'fb1',
        name: 'prize', language: 'en_US', body: 'hi', status: 'APPROVED',
        rejection_reason: null, created: 't1', updated: 't2',
        userid: 'should_be_stripped',
      };
      const out = formatRecord(row);
      out.should.not.have.property('userid');
      out.should.have.property('id', 'u1');
      out.should.have.property('facebook_page_id', 'p1');
      out.should.have.property('fb_template_id', 'fb1');
      out.should.have.property('language', 'en_US');
    });
  });
});
