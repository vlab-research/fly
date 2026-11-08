const { Pool } = require('pg');
require('chai').should();
require('mocha');

const credentialModel = require('./credentials.queries');
const userModel = require('../users/user.queries');

const { DATABASE_CONFIG } = require('../../config');

describe('Credential queries', () => {
  let Credential;
  let User;
  let vlabPool;

  before(async () => {
    vlabPool = new Pool(DATABASE_CONFIG);
    Credential = credentialModel.queries(vlabPool);
    User = userModel.queries(vlabPool);
  });

  beforeEach(async () => {
    await vlabPool.query('DELETE FROM users');
    await User.create({ email: 'owner@vlab.com' });
  });

  after(async () => {
    await vlabPool.query('DELETE FROM users');
    await vlabPool.end();
  });

  const pin = (value, email = 'owner@vlab.com') => ({
    entity: 'whatsapp_registration_pin', key: 'w1', details: { pin: value }, email,
  });

  describe('.createIfAbsent()', () => {
    it('writes the first value and never replaces it', async () => {
      const first = await Credential.createIfAbsent(pin('111111'));
      first.details.should.deep.equal({ pin: '111111' });

      const second = await Credential.createIfAbsent(pin('222222'));
      (second === undefined).should.equal(true);

      const row = await Credential.getOne({ email: 'owner@vlab.com', entity: 'whatsapp_registration_pin', key: 'w1' });
      row.details.should.deep.equal({ pin: '111111' });
    });
  });

  describe('.get()', () => {
    it('leaves registration PINs out of the browser-facing list', async () => {
      await Credential.create({ entity: 'whatsapp_business', key: 'w1', details: { id: 'w1' }, email: 'owner@vlab.com' });
      await Credential.createIfAbsent(pin('111111'));

      const rows = await Credential.get({ email: 'owner@vlab.com' });
      rows.map(r => r.entity).should.deep.equal(['whatsapp_business']);
    });
  });
});
