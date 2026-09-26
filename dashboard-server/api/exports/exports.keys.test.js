'use strict';

const { expect } = require('chai');

const {
  EXPORT_LINK_PLACEHOLDER,
  ownerPrefix,
  isOwnedExportLink,
  withOwnedLink,
} = require('./exports.keys');

const ALICE = 'alice@example.org';
const BOB = 'bob@example.org';

// The exporter's presigned MinIO links are path-style: /<bucket>/<key>?X-Amz-...
const link = key => `https://storage-api.vlab.digital/fly/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc`;

describe('exports.keys', () => {
  describe('ownerPrefix', () => {
    it('matches the exporter (exporter/exporter/tests/test_keys.py pins the same values)', () => {
      expect(ownerPrefix(ALICE)).to.equal('7a64adf28737ea90');
      expect(ownerPrefix(BOB)).to.equal('686b5e4cf4f963ad');
    });
  });

  describe('isOwnedExportLink', () => {
    const aliceKey = `exports/${ownerPrefix(ALICE)}/default.csv`;
    const bobKey = `exports/${ownerPrefix(BOB)}/default.csv`;

    it('accepts a link under the caller\'s own prefix, for every artifact type', () => {
      ['default.csv', 'default_chat_log.csv', 'default_full_messages_20251001T000000Z_to_open.csv']
        .forEach(name => expect(isOwnedExportLink(ALICE, link(`exports/${ownerPrefix(ALICE)}/${name}`))).to.equal(true));
    });

    it('accepts a virtual-hosted link with no bucket segment', () => {
      expect(isOwnedExportLink(ALICE, `https://fly.s3.example.com/${aliceKey}?sig=1`)).to.equal(true);
    });

    it('accepts URL-encoded survey names', () => {
      expect(isOwnedExportLink(ALICE, link(`exports/${ownerPrefix(ALICE)}/GW%20Pediatric%20Vaccinations.csv`))).to.equal(true);
    });

    it('refuses another owner\'s object even for the same survey_name', () => {
      expect(isOwnedExportLink(ALICE, link(bobKey))).to.equal(false);
      expect(isOwnedExportLink(BOB, link(aliceKey))).to.equal(false);
    });

    it('refuses a pre-fix key, which any owner of that survey_name may have overwritten', () => {
      expect(isOwnedExportLink(ALICE, link('exports/default.csv'))).to.equal(false);
      expect(isOwnedExportLink(ALICE, link('exports/default_chat_log.csv'))).to.equal(false);
      expect(isOwnedExportLink(ALICE, link('exports/default_full_messages.csv'))).to.equal(false);
    });

    it('refuses the owner prefix appearing deeper than the key root', () => {
      expect(isOwnedExportLink(ALICE, link(`exports/x/exports/${ownerPrefix(ALICE)}/default.csv`))).to.equal(false);
    });

    it('refuses anything that is not a URL', () => {
      expect(isOwnedExportLink(ALICE, 'Base backend fake link')).to.equal(false);
      expect(isOwnedExportLink(ALICE, undefined)).to.equal(false);
      expect(isOwnedExportLink(undefined, link(aliceKey))).to.equal(false);
    });
  });

  describe('withOwnedLink', () => {
    const row = { id: 'e1', user_id: ALICE, survey_id: 'default', status: 'Finished' };

    it('keeps an owned link', () => {
      const owned = { ...row, export_link: link(`exports/${ownerPrefix(ALICE)}/default.csv`) };
      expect(withOwnedLink(ALICE)(owned)).to.equal(owned);
    });

    it('replaces a pre-fix or foreign link with the placeholder, leaving the rest of the row', () => {
      [link('exports/default.csv'), link(`exports/${ownerPrefix(BOB)}/default.csv`)].forEach((l) => {
        expect(withOwnedLink(ALICE)({ ...row, export_link: l }))
          .to.eql({ ...row, export_link: EXPORT_LINK_PLACEHOLDER });
      });
    });

    it('leaves placeholder and empty links alone', () => {
      [EXPORT_LINK_PLACEHOLDER, null].forEach((l) => {
        const r = { ...row, status: 'Requested', export_link: l };
        expect(withOwnedLink(ALICE)(r)).to.equal(r);
      });
    });
  });
});
