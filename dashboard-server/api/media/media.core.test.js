'use strict';

const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars

const {
  validateUploadInput,
  parseAttachmentResponse,
  extractPages,
  MAX_FILE_SIZE,
} = require('./media.core');

describe('media.core', () => {
  // -------------------------------------------------------
  // validateUploadInput — branching validation logic
  // -------------------------------------------------------
  describe('validateUploadInput', () => {
    const validFile = { buffer: Buffer.from('x'), originalname: 'pic.jpg', mimetype: 'image/jpeg', size: 1024 };

    it('accepts complete, correct input', () => {
      validateUploadInput({ file: validFile, pageId: '123', mediaType: 'image' })
        .should.deep.equal({ valid: true });
    });

    it('rejects missing pageId', () => {
      const result = validateUploadInput({ file: validFile, pageId: undefined, mediaType: 'image' });
      result.valid.should.equal(false);
      result.error.should.include('pageId');
    });

    it('rejects empty-string pageId (falsy but not undefined)', () => {
      const result = validateUploadInput({ file: validFile, pageId: '', mediaType: 'image' });
      result.valid.should.equal(false);
    });

    it('rejects an unrecognized mediaType', () => {
      const result = validateUploadInput({ file: validFile, pageId: '123', mediaType: 'audio' });
      result.valid.should.equal(false);
      result.error.should.include('mediaType');
    });

    it('rejects missing mediaType', () => {
      const result = validateUploadInput({ file: validFile, pageId: '123', mediaType: undefined });
      result.valid.should.equal(false);
    });

    it('accepts "video" as a valid mediaType', () => {
      validateUploadInput({ file: validFile, pageId: '123', mediaType: 'video' })
        .should.deep.equal({ valid: true });
    });

    it('rejects null file', () => {
      const result = validateUploadInput({ file: null, pageId: '123', mediaType: 'image' });
      result.valid.should.equal(false);
      result.error.should.include('file');
    });

    it('rejects file exceeding the size limit', () => {
      const bigFile = { ...validFile, size: MAX_FILE_SIZE + 1 };
      const result = validateUploadInput({ file: bigFile, pageId: '123', mediaType: 'image' });
      result.valid.should.equal(false);
      result.error.should.include('size');
    });

    it('accepts file at exactly the size limit (boundary)', () => {
      const maxFile = { ...validFile, size: MAX_FILE_SIZE };
      validateUploadInput({ file: maxFile, pageId: '123', mediaType: 'image' })
        .should.deep.equal({ valid: true });
    });

    it('checks pageId before file — missing pageId reported even when file is also null', () => {
      // Validates that the function short-circuits in a predictable order.
      // Users who forgot to select a page should see the pageId error first.
      const result = validateUploadInput({ file: null, pageId: '', mediaType: 'image' });
      result.error.should.include('pageId');
    });
  });

  // -------------------------------------------------------
  // parseAttachmentResponse — error-handling branches
  // -------------------------------------------------------
  describe('parseAttachmentResponse', () => {
    it('extracts attachment_id from a successful Facebook response', () => {
      parseAttachmentResponse({ attachment_id: '9876543210' })
        .should.deep.equal({ ok: true, attachmentId: '9876543210' });
    });

    it('forwards the full Facebook error object on API errors', () => {
      const fbError = { message: 'Invalid OAuth token', type: 'OAuthException', code: 190 };
      const result = parseAttachmentResponse({ error: fbError });
      result.ok.should.equal(false);
      result.error.should.deep.equal(fbError);
    });

    it('treats a response with no attachment_id and no error as a failure', () => {
      // Facebook occasionally returns unexpected shapes; must not silently succeed
      const result = parseAttachmentResponse({ success: true });
      result.ok.should.equal(false);
      result.error.message.should.include('attachment_id');
    });

    it('handles null response (network-level failure)', () => {
      const result = parseAttachmentResponse(null);
      result.ok.should.equal(false);
      result.error.message.should.include('Empty response');
    });

    it('handles undefined response', () => {
      const result = parseAttachmentResponse(undefined);
      result.ok.should.equal(false);
    });

    it('prefers the error field over attachment_id when both are present', () => {
      // Defensive: if Facebook sends both (unlikely but possible), treat as error
      const result = parseAttachmentResponse({ attachment_id: '123', error: { message: 'partial failure' } });
      result.ok.should.equal(false);
    });
  });

  // -------------------------------------------------------
  // extractPages — filtering logic + security (no token leak)
  // -------------------------------------------------------
  describe('extractPages', () => {
    it('filters to facebook_page credentials and returns only id + name', () => {
      const creds = [
        { entity: 'facebook_page', details: { id: 'p1', name: 'Page One', access_token: 'secret' } },
        { entity: 'typeform_token', details: { token: 'tf-token' } },
        { entity: 'facebook_page', details: { id: 'p2', name: 'Page Two', access_token: 'secret2' } },
      ];
      const result = extractPages(creds);
      result.should.deep.equal([
        { id: 'p1', name: 'Page One' },
        { id: 'p2', name: 'Page Two' },
      ]);
    });

    it('never exposes access_token or any other credential field', () => {
      const creds = [
        { entity: 'facebook_page', details: { id: 'p1', name: 'P', access_token: 'TOP_SECRET', refresh_token: 'also_secret' } },
      ];
      const result = extractPages(creds);
      const outputKeys = Object.keys(result[0]);
      outputKeys.should.deep.equal(['id', 'name']);
    });

    it('filters out rows where details.name is missing', () => {
      const creds = [
        { entity: 'facebook_page', details: { id: 'p1', access_token: 'tok' } },
      ];
      extractPages(creds).should.have.length(0);
    });

    it('filters out rows where details.id is missing', () => {
      const creds = [
        { entity: 'facebook_page', details: { name: 'No ID Page', access_token: 'tok' } },
      ];
      extractPages(creds).should.have.length(0);
    });

    it('filters out rows with null details', () => {
      const creds = [
        { entity: 'facebook_page', details: null },
      ];
      extractPages(creds).should.have.length(0);
    });

    it('filters out rows with undefined details', () => {
      const creds = [
        { entity: 'facebook_page' },
      ];
      extractPages(creds).should.have.length(0);
    });

    it('returns empty array when no facebook_page credentials exist', () => {
      extractPages([{ entity: 'typeform_token', details: {} }]).should.deep.equal([]);
    });

    it('returns empty array for empty input', () => {
      extractPages([]).should.deep.equal([]);
    });
  });
});
