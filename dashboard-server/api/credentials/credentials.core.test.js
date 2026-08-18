'use strict';

const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars

const {
  entityToPlatform,
  shouldCreateMessagingRegistry,
  validateMessagingCredential,
} = require('./credentials.core');

describe('credentials.core', () => {
  // =========================================================================
  // entityToPlatform
  // =========================================================================
  describe('entityToPlatform', () => {
    it('maps facebook_page to messenger', () => {
      entityToPlatform('facebook_page').should.equal('messenger');
    });

    it('maps whatsapp_business to whatsapp', () => {
      entityToPlatform('whatsapp_business').should.equal('whatsapp');
    });

    it('returns null for non-messaging entities', () => {
      should.not.exist(entityToPlatform('api_token'));
      should.not.exist(entityToPlatform('reloadly'));
      should.not.exist(entityToPlatform('secrets'));
      should.not.exist(entityToPlatform('typeform_token'));
      should.not.exist(entityToPlatform('facebook_ad_user'));
    });

    it('returns null for unknown entities', () => {
      should.not.exist(entityToPlatform('unknown_entity'));
      should.not.exist(entityToPlatform(''));
    });
  });

  // =========================================================================
  // shouldCreateMessagingRegistry
  // =========================================================================
  describe('shouldCreateMessagingRegistry', () => {
    it('returns true for facebook_page', () => {
      shouldCreateMessagingRegistry('facebook_page').should.equal(true);
    });

    it('returns true for whatsapp_business', () => {
      shouldCreateMessagingRegistry('whatsapp_business').should.equal(true);
    });

    it('returns false for non-messaging entities', () => {
      shouldCreateMessagingRegistry('api_token').should.equal(false);
      shouldCreateMessagingRegistry('reloadly').should.equal(false);
      shouldCreateMessagingRegistry('secrets').should.equal(false);
      shouldCreateMessagingRegistry('typeform_token').should.equal(false);
      shouldCreateMessagingRegistry('facebook_ad_user').should.equal(false);
    });

    it('returns false for unknown entities', () => {
      shouldCreateMessagingRegistry('unknown_entity').should.equal(false);
    });
  });

  // =========================================================================
  // validateMessagingCredential
  // =========================================================================
  describe('validateMessagingCredential', () => {
    describe('key validation', () => {
      it('rejects when key is missing', () => {
        const result = validateMessagingCredential({ details: {} });
        result.valid.should.equal(false);
        result.error.should.include('key is required');
      });

      it('rejects when key is empty string', () => {
        const result = validateMessagingCredential({ key: '', details: {} });
        result.valid.should.equal(false);
        result.error.should.include('key is required');
      });

      it('rejects when key is only whitespace', () => {
        const result = validateMessagingCredential({ key: '   ', details: {} });
        result.valid.should.equal(false);
        result.error.should.include('key is required');
      });

      it('rejects when key is not a string', () => {
        const result = validateMessagingCredential({ key: 12345, details: {} });
        result.valid.should.equal(false);
        result.error.should.include('key is required');
      });

      it('rejects when key is null', () => {
        const result = validateMessagingCredential({ key: null, details: {} });
        result.valid.should.equal(false);
        result.error.should.include('key is required');
      });

      it('accepts a valid non-empty string key', () => {
        const result = validateMessagingCredential({ key: '12345', details: {} });
        result.valid.should.equal(true);
      });
    });

    describe('details.id matching', () => {
      it('accepts when details is undefined', () => {
        const result = validateMessagingCredential({ key: '12345', details: undefined });
        result.valid.should.equal(true);
      });

      it('accepts when details is null', () => {
        const result = validateMessagingCredential({ key: '12345', details: null });
        result.valid.should.equal(true);
      });

      it('accepts when details has no id field', () => {
        const result = validateMessagingCredential({ key: '12345', details: { name: 'Test Page' } });
        result.valid.should.equal(true);
      });

      it('accepts when details.id matches key', () => {
        const result = validateMessagingCredential({
          key: '12345',
          details: { id: '12345', name: 'Test Page' },
        });
        result.valid.should.equal(true);
      });

      it('accepts when details.id is undefined (no default)', () => {
        const result = validateMessagingCredential({
          key: '12345',
          details: { id: undefined, name: 'Test Page' },
        });
        result.valid.should.equal(true);
      });

      it('rejects when details.id disagrees with key', () => {
        const result = validateMessagingCredential({
          key: '12345',
          details: { id: '99999', name: 'Test Page' },
        });
        result.valid.should.equal(false);
        result.error.should.include('details.id');
        result.error.should.include('12345');
        result.error.should.include('99999');
      });

      it('rejects when details.id disagrees even with matching names', () => {
        const result = validateMessagingCredential({
          key: 'page-abc',
          details: { id: 'page-xyz', name: 'Same Name' },
        });
        result.valid.should.equal(false);
        result.error.should.include('details.id');
      });

      it('preserves the exact mismatch in the error message', () => {
        const result = validateMessagingCredential({
          key: 'key-value',
          details: { id: 'details-value' },
        });
        result.error.should.include('details-value');
        result.error.should.include('key-value');
      });
    });

    describe('complex real-world scenarios', () => {
      it('accepts Facebook page credential structure', () => {
        const result = validateMessagingCredential({
          key: '1234567890',
          details: {
            id: '1234567890',
            name: 'My Page',
            access_token: 'EAABs...',
          },
        });
        result.valid.should.equal(true);
      });

      it('accepts WhatsApp credential structure', () => {
        const result = validateMessagingCredential({
          key: '1234567890',
          details: {
            id: '1234567890',
            waba_id: '9876543210',
            access_token: 'EAABs...',
          },
        });
        result.valid.should.equal(true);
      });

      it('rejects when key mismatches in Facebook page structure', () => {
        const result = validateMessagingCredential({
          key: '1111111111',
          details: {
            id: '2222222222',
            name: 'My Page',
            access_token: 'EAABs...',
          },
        });
        result.valid.should.equal(false);
      });

      it('rejects when key mismatches in WhatsApp structure', () => {
        const result = validateMessagingCredential({
          key: '1111111111',
          details: {
            id: '2222222222',
            waba_id: '9876543210',
            access_token: 'EAABs...',
          },
        });
        result.valid.should.equal(false);
      });
    });
  });
});
