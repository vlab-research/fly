'use strict';

async function create({ token, email }) {
  const CREATE_ONE = `INSERT INTO users(token, email)
       values($1, $2)
       ON CONFLICT(id) DO NOTHING
       RETURNING *`;
  const values = [token, email];
  const { rows } = await this.query(CREATE_ONE, values);
  return rows[0];
}

async function update({ token, email }) {
  const UPDATE_OR_CREATE = `
    UPDATE users SET token=$1 WHERE email=$2
    RETURNING *`;
  const values = [token, email];
  const { rows } = await this.query(UPDATE_OR_CREATE, values);

  return rows.length ? rows[0] : create.bind(this)({ token, email });
}

async function user({ email }) {
  const UPDATE_OR_CREATE = `SELECT * FROM users WHERE email=$1`;
  const { rows } = await this.query(UPDATE_OR_CREATE, [email]);
  return !!rows.length && rows[0];
}

module.exports = {
  name: 'User',
  queries: pool => ({
    create: create.bind(pool),
    update: update.bind(pool),
    user: user.bind(pool),
  }),
};