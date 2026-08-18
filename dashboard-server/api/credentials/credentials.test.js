'use strict';

const request = require('supertest');
const { Pool } = require('pg');
require('chai').should();

const { DATABASE_CONFIG } = require('../../config');
const { User } = require('../../queries');
const { AuthUtil } = require('../../utils');
const { makeAPIToken } = AuthUtil;

const app = require('../../server');

describe('Credentials API — Messaging Account Registry', () => {
  let authToken;
  let vlabPool;
  let userId;
  const email = 'credentials-test@vlab.com';

  before(async () => {
    authToken = await makeAPIToken({ email });
    vlabPool = new Pool(DATABASE_CONFIG);
    const user = await User.create({ email });
    userId = user.id;
  });

  after(async () => {
    // Clean up
    try {
      // Delete from messaging_accounts first (FK constraint)
      await vlabPool.query(
        'DELETE FROM chatroach.messaging_accounts WHERE userid = $1',
        [userId]
      );
      // Then delete credentials
      await vlabPool.query(
        'DELETE FROM chatroach.credentials WHERE userid = $1',
        [userId]
      );
      // Then delete the user
      await vlabPool.query(
        'DELETE FROM chatroach.users WHERE email = $1',
        [email]
      );
    } catch (err) {
      console.error('Cleanup error:', err);
    }
    await vlabPool.end();
  });

  // =========================================================================
  // facebook_page: credential and registry row both created
  // =========================================================================
  describe('facebook_page create', () => {
    it('creates both credential and messaging_accounts registry row', async () => {
      const facebookPageId = '123456789';

      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'facebook_page',
          key: facebookPageId,
          details: {
            id: facebookPageId,
            name: 'Test Page',
            access_token: 'test-token-fb',
          },
        });

      res.status.should.equal(201);
      res.body.entity.should.equal('facebook_page');
      res.body.key.should.equal(facebookPageId);

      // Verify credential exists
      const credResult = await vlabPool.query(
        `SELECT * FROM chatroach.credentials
         WHERE userid = $1 AND entity = 'facebook_page' AND key = $2`,
        [userId, facebookPageId]
      );
      credResult.rows.length.should.equal(1);

      // Verify registry row exists with correct platform
      const regResult = await vlabPool.query(
        `SELECT * FROM chatroach.messaging_accounts
         WHERE userid = $1 AND platform = 'messenger' AND account_id = $2`,
        [userId, facebookPageId]
      );
      regResult.rows.length.should.equal(1);
      regResult.rows[0].credentials_entity.should.equal('facebook_page');
      regResult.rows[0].credentials_key.should.equal(facebookPageId);
    });

    it('includes created timestamp on registry row', async () => {
      const facebookPageId = 'test-page-timestamp';

      await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'facebook_page',
          key: facebookPageId,
          details: {
            id: facebookPageId,
            name: 'Page with timestamp',
            access_token: 'test-token',
          },
        });

      const regResult = await vlabPool.query(
        `SELECT created FROM chatroach.messaging_accounts
         WHERE platform = 'messenger' AND account_id = $1`,
        [facebookPageId]
      );
      regResult.rows.length.should.equal(1);
      regResult.rows[0].created.should.be.instanceof(Date);
      regResult.rows[0].created.getTime().should.be.closeTo(Date.now(), 5000);
    });
  });

  // =========================================================================
  // whatsapp_business: credential and registry row both created
  // =========================================================================
  describe('whatsapp_business create', () => {
    it('creates both credential and messaging_accounts registry row with whatsapp platform', async () => {
      const whatsappPhoneNumberId = '987654321';

      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'whatsapp_business',
          key: whatsappPhoneNumberId,
          details: {
            id: whatsappPhoneNumberId,
            waba_id: 'waba-123',
            access_token: 'test-token-wa',
          },
        });

      res.status.should.equal(201);
      res.body.entity.should.equal('whatsapp_business');
      res.body.key.should.equal(whatsappPhoneNumberId);

      // Verify credential exists
      const credResult = await vlabPool.query(
        `SELECT * FROM chatroach.credentials
         WHERE userid = $1 AND entity = 'whatsapp_business' AND key = $2`,
        [userId, whatsappPhoneNumberId]
      );
      credResult.rows.length.should.equal(1);

      // Verify registry row exists with correct platform
      const regResult = await vlabPool.query(
        `SELECT * FROM chatroach.messaging_accounts
         WHERE userid = $1 AND platform = 'whatsapp' AND account_id = $2`,
        [userId, whatsappPhoneNumberId]
      );
      regResult.rows.length.should.equal(1);
      regResult.rows[0].credentials_entity.should.equal('whatsapp_business');
      regResult.rows[0].credentials_key.should.equal(whatsappPhoneNumberId);
    });
  });

  // =========================================================================
  // Atomicity: registry insert failure prevents credential creation
  // =========================================================================
  describe('atomicity — transaction rollback on registry insert failure', () => {
    it('rolls back credential when registry insert fails (duplicate account_id)', async () => {
      const conflictingId = 'atomicity-test-' + Date.now();
      const otherEmail = 'other-user-' + Date.now() + '@vlab.com';

      // Create another user
      const otherUser = await User.create({ email: otherEmail });

      // Pre-insert a facebook_page credential for the other user
      await vlabPool.query(
        `INSERT INTO chatroach.credentials
         (entity, key, details, userid)
         VALUES ($1, $2, $3, $4)`,
        [
          'facebook_page',
          'other-' + conflictingId,  // Different key to avoid UNIQUE constraint
          JSON.stringify({ id: 'other-' + conflictingId }),
          otherUser.id,
        ]
      );

      // Insert a registry row that will conflict on global_account_id
      await vlabPool.query(
        `INSERT INTO chatroach.messaging_accounts
         (platform, account_id, userid, credentials_entity, credentials_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'messenger',
          conflictingId,  // This account_id will conflict
          otherUser.id,
          'facebook_page',
          'other-' + conflictingId,  // Must match the credential
        ]
      );

      // Now try to create a facebook_page credential with the same account_id via the API
      // This should:
      // 1. Pass validation
      // 2. Insert the credential successfully (different key on credentials table)
      // 3. Fail on registry insert (duplicate account_id on global_account_id index)
      // 4. Rollback both inserts
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'facebook_page',
          key: conflictingId,
          details: {
            id: conflictingId,
            name: 'Conflict Test',
            access_token: 'test-token',
          },
        });

      res.status.should.equal(400);

      // Verify that NO credential was created for our test user with the conflicting ID
      const countRes = await vlabPool.query(
        `SELECT COUNT(*) as cnt FROM chatroach.credentials
         WHERE userid = $1 AND entity = 'facebook_page' AND key = $2`,
        [userId, conflictingId]
      );
      // Should be 0 because the transaction was rolled back
      parseInt(countRes.rows[0].cnt).should.equal(0);

      // Clean up the other user
      await vlabPool.query(
        'DELETE FROM chatroach.messaging_accounts WHERE userid = $1',
        [otherUser.id]
      );
      await vlabPool.query(
        'DELETE FROM chatroach.credentials WHERE userid = $1',
        [otherUser.id]
      );
      await vlabPool.query(
        'DELETE FROM chatroach.users WHERE email = $1',
        [otherEmail]
      );
    });
  });

  // =========================================================================
  // Non-messaging entities: credential created, NO registry row
  // =========================================================================
  describe('non-messaging entities', () => {
    it('api_token: creates credential without registry row', async () => {
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'api_token',
          key: 'test-api-key-123',
          details: { token: 'secret-api-token' },
        });

      res.status.should.equal(201);
      res.body.entity.should.equal('api_token');

      // Verify credential exists
      const credResult = await vlabPool.query(
        `SELECT * FROM chatroach.credentials
         WHERE userid = $1 AND entity = 'api_token' AND key = $2`,
        [userId, 'test-api-key-123']
      );
      credResult.rows.length.should.equal(1);

      // Verify NO registry row was created
      const regResult = await vlabPool.query(
        `SELECT * FROM chatroach.messaging_accounts
         WHERE userid = $1 AND account_id = $2`,
        [userId, 'test-api-key-123']
      );
      regResult.rows.length.should.equal(0);
    });

    it('reloadly: creates credential without registry row', async () => {
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'reloadly',
          key: 'reloadly-key-456',
          details: { apiKey: 'secret-reloadly-key' },
        });

      res.status.should.equal(201);

      // Verify NO registry row
      const regResult = await vlabPool.query(
        `SELECT * FROM chatroach.messaging_accounts
         WHERE userid = $1 AND account_id = $2`,
        [userId, 'reloadly-key-456']
      );
      regResult.rows.length.should.equal(0);
    });

    it('secrets: creates credential without registry row', async () => {
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'secrets',
          key: 'secrets-key-789',
          details: { secret: 'my-secret' },
        });

      res.status.should.equal(201);

      // Verify NO registry row
      const regResult = await vlabPool.query(
        `SELECT * FROM chatroach.messaging_accounts
         WHERE userid = $1 AND account_id = $2`,
        [userId, 'secrets-key-789']
      );
      regResult.rows.length.should.equal(0);
    });
  });

  // =========================================================================
  // Malformed messaging credentials: validation rejects with 400
  // =========================================================================
  describe('malformed messaging credentials — validation rejects', () => {
    it('rejects facebook_page when key is missing', async () => {
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'facebook_page',
          // key is missing
          details: {
            id: '123',
            name: 'Test Page',
            access_token: 'token',
          },
        });

      res.status.should.equal(400);
      res.body.should.have.property('error');
      res.body.error.should.include('key is required');
    });

    it('rejects facebook_page when key is empty string', async () => {
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'facebook_page',
          key: '',
          details: {
            id: '123',
            name: 'Test Page',
            access_token: 'token',
          },
        });

      res.status.should.equal(400);
      res.body.error.should.include('key is required');
    });

    it('rejects facebook_page when key is only whitespace', async () => {
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'facebook_page',
          key: '   ',
          details: {
            id: '123',
            name: 'Test Page',
            access_token: 'token',
          },
        });

      res.status.should.equal(400);
      res.body.error.should.include('key is required');
    });

    it('rejects facebook_page when details.id disagrees with key', async () => {
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'facebook_page',
          key: '111111111',
          details: {
            id: '222222222',
            name: 'Test Page',
            access_token: 'token',
          },
        });

      res.status.should.equal(400);
      res.body.error.should.include('details.id');
      res.body.error.should.include('111111111');
      res.body.error.should.include('222222222');
    });

    it('rejects whatsapp_business when key is missing', async () => {
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'whatsapp_business',
          // key is missing
          details: {
            id: '987654321',
            waba_id: 'waba-123',
            access_token: 'token',
          },
        });

      res.status.should.equal(400);
      res.body.error.should.include('key is required');
    });

    it('rejects whatsapp_business when details.id disagrees with key', async () => {
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'whatsapp_business',
          key: '111111111',
          details: {
            id: '999999999',
            waba_id: 'waba-123',
            access_token: 'token',
          },
        });

      res.status.should.equal(400);
      res.body.error.should.include('details.id');
    });

    it('does not reject non-messaging entity with missing key', async () => {
      // Non-messaging entities are not validated by our guard, so they pass through
      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'api_token',
          // key is missing
          details: { token: 'test' },
        });

      // This might succeed or fail depending on database constraints,
      // but it won't fail with our validation error
      if (res.body.error) res.body.error.should.not.include('key is required');
    });
  });

  // =========================================================================
  // Valid messaging credentials without details.id: should succeed
  // =========================================================================
  describe('valid messaging credentials', () => {
    it('creates facebook_page without details.id field', async () => {
      const facebookPageId = 'page-no-details-id';

      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'facebook_page',
          key: facebookPageId,
          details: {
            name: 'Page Without ID Field',
            access_token: 'token',
          },
        });

      res.status.should.equal(201);

      // Verify both rows exist
      const credResult = await vlabPool.query(
        `SELECT * FROM chatroach.credentials
         WHERE userid = $1 AND key = $2`,
        [userId, facebookPageId]
      );
      credResult.rows.length.should.equal(1);

      const regResult = await vlabPool.query(
        `SELECT * FROM chatroach.messaging_accounts
         WHERE platform = 'messenger' AND account_id = $1`,
        [facebookPageId]
      );
      regResult.rows.length.should.equal(1);
    });

    it('creates whatsapp_business with matching id and key', async () => {
      const whatsappId = '555555555';

      const res = await request(app)
        .post('/api/v1/credentials')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          entity: 'whatsapp_business',
          key: whatsappId,
          details: {
            id: whatsappId,
            waba_id: 'waba-123',
            access_token: 'token',
          },
        });

      res.status.should.equal(201);

      // Verify both rows exist
      const regResult = await vlabPool.query(
        `SELECT * FROM chatroach.messaging_accounts
         WHERE platform = 'whatsapp' AND account_id = $1`,
        [whatsappId]
      );
      regResult.rows.length.should.equal(1);
    });
  });
});
