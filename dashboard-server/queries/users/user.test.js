const { Pool } = require('pg');
require('chai').should();
require('mocha');
const axios = require('axios');

const model = require('./user.queries');

const { DATABASE_CONFIG } = require('../../config');

describe('User queries', () => {
  let User;
  let pool;

  before(async () => {
    pool = new Pool(DATABASE_CONFIG);
    User = model.queries(pool);
  });

  beforeEach(async () => {
    await axios.get('http://system/resetdb');
  });

  describe('.create()', () => {
    it('should insert a new user and return the newly created record', async () => {
      const user = {
        token: 'HxpnYoykme73Jz1c9DdAxPws77GzH9jLqE1wu1piSqJj',
        email: 'test@vlab.com',
      };
      const newUser = await User.create(user);
      newUser.email.should.equal(user.email);
    });
  });

  describe('.user()', () => {
    it('should return the corresponding user', async () => {
      const user = {
        token: '8eQ9ZYXw2Vsb16aC7aKzXFqzE7oamzKQttaHnCNHoRu8',
        email: 'test@vlab.com',
      };
      await User.create(user);
      const userFromDb = await User.user(user);
      userFromDb.email.should.equal(user.email);
    });
  });
});
