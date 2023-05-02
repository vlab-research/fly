'use strict';

class RequestError extends Error {}

async function checkUserExists(email, pool) {
  const query = `
  SELECT EXISTS(SELECT 1 FROM users WHERE users.email = $1);
`;
  const { rows } = await pool.query(query, [email]);
  return rows;
}

async function _all(email, pool) {

  const query = `SELECT * FROM export_status WHERE user_id = $1`;
  const { rows } = await pool.query(query, [email]);
  return rows;
}

async function all(email) {
  const userCheck = await checkUserExists(email, this);
  const [user] = userCheck;


  if (!user.exists ) {
    throw new RequestError(
      `No exports were found for user: ${email}`,
    );
  }

let responses = await _all(email, this)

  return { responses };
}

module.exports = {
  name: 'Exports',
  _all,
  queries: pool => ({
    all: all.bind(pool),
  }),
};
