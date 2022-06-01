const { Pool } = require('pg');
require('chai').should();
require('mocha');

const model = require('./user.queries');

const { DATABASE_CONFIG } = require('../../config');

describe('User queries', () => {
  let User;
  let vlabPool;

  before(async () => {
    vlabPool = new Pool(DATABASE_CONFIG);
    await vlabPool.query('DELETE FROM users');

    User = model.queries(vlabPool);
  });

  // afterEach(async () => {
  //   await vlabPool.query('DELETE FROM users');
  // });

  describe('.create()', () => {
    it('should insert a new user and return the newly created record', async () => {
      const user = {
        email: 'test@vlab.com',
      };

      const newUser = await User.create(user);
      newUser.email.should.equal(user.email);
    });
  });

  describe('.user()', () => {
    it('should return the corresponding user', async () => {
      const user = {
        email: 'test@vlab.com',
      };
      await User.create(user);
      const userFromDb = await User.user(user);
      userFromDb.email.should.equal(user.email);
    });
  });
});
