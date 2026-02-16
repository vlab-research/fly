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
  const query = `SELECT * FROM export_status WHERE user_id = $1 ORDER BY updated DESC`;
  const { rows } = await pool.query(query, [email]);
  return rows;
}

async function _bySurvey(email, surveyName, pool) {
  const query = `SELECT * FROM export_status WHERE user_id = $1 AND survey_id = $2 ORDER BY updated DESC`;
  const { rows } = await pool.query(query, [email, surveyName]);
  return rows;
}

async function _insert(id, email, surveyName, source, pool) {
  const query = `
    INSERT INTO export_status (id, user_id, survey_id, status, export_link, source)
    VALUES ($1, $2, $3, 'Started', 'Not Found', $4)
  `;
  await pool.query(query, [id, email, surveyName, source]);
}

async function all(email) {
  const userCheck = await checkUserExists(email, this);
  const [user] = userCheck;

  if (!user.exists) {
    throw new RequestError(
      `No exports were found for user: ${email}`,
    );
  }

  let responses = await _all(email, this);
  return { responses };
}

async function bySurvey(email, surveyName) {
  let responses = await _bySurvey(email, surveyName, this);
  return { responses };
}

async function insert(id, email, surveyName, source) {
  await _insert(id, email, surveyName, source, this);
}

module.exports = {
  name: 'Exports',
  _all,
  _bySurvey,
  _insert,
  queries: pool => ({
    all: all.bind(pool),
    bySurvey: bySurvey.bind(pool),
    insert: insert.bind(pool),
  }),
};
