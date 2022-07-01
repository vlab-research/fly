'use strict';

const t = require('./token');

const token = new t.Token();

const {
  ClientCursorStream,
  cursorResult,
} = require('@vlab-research/client-cursor-stream');

class RequestError extends Error {}

async function _all(email, survey, timestamp, userid, ref, pageSize, pool) {
  const GET_ALL = `SELECT parent_surveyid,
  parent_shortcode,
  surveyid,
  flowid,
  responses.userid,
  question_ref,
  question_idx,
  question_text,
  response,
  timestamp::string,
  responses.metadata,
  pageid,
  translated_response
  FROM responses
  LEFT JOIN surveys ON responses.surveyid = surveys.id 
  LEFT JOIN users ON surveys.userid = users.id
  WHERE users.email = $1
  AND surveys.survey_name = $2
  AND (timestamp, responses.userid, question_ref) > ($3, $4, $5)
  ORDER BY (timestamp, responses.userid, question_ref)
  LIMIT $6`;

  const { rows } = await pool.query(GET_ALL, [
    email,
    survey,
    timestamp,
    userid,
    ref,
    pageSize,
  ]);

  return rows;
}

async function all(email, survey, after = null, pageSize = 25) {
  var [timestamp, userid, ref] =
    after !== null
      ? token.decode(after)
      : '1970-01-01 00:00:00+00:00,,'.split(',');

  const responses = await _all(
    email,
    survey,
    timestamp,
    userid,
    ref,
    pageSize,
    this,
  );

  if (!responses) {
    throw new RequestError(
      `Could not find the requested survey: ${survey} for user: ${email}`,
    );
  }

  responses.map(r =>
    Object.assign(r, {
      token: token.encode([r.timestamp, r.userid, r.question_ref]),
    }),
  );

  return {
    responses, // one token per response
  };
}

async function firstAndLast() {
  const GET_FIRST_AND_LAST = `SELECT *
    FROM  (
       SELECT DISTINCT ON (1) userid, timestamp AS first_timestamp, response AS first_response, surveyid
       FROM   responses
       ORDER  BY 1,2
       ) f
    JOIN (
       SELECT DISTINCT ON (1) userid, timestamp AS last_timestamp, response AS last_response, surveyid
       FROM   responses
       ORDER  BY 1,2 DESC
       ) l USING (userid)`;
  const { rows } = await this.query(GET_FIRST_AND_LAST);

  return rows;
}

// TODO: remove question_text and push to another download? save space.
async function responsesQuery(pool, email, name, time, lim) {
  // TODO: put back in the clause: AS OF SYSTEM TIME $3
  // was removed because cockroach was freakin out and not working mysteriously
  // probably will be fine after upgrade.

  const query = `SELECT parent_surveyid,
                        parent_shortcode,
                        surveyid,
                        flowid,
                        responses.userid,
                        question_ref,
                        question_idx,
                        question_text,
                        response,
                        timestamp::string,
                        responses.metadata,
                        pageid,
                        translated_response
                 FROM responses
                 LEFT JOIN surveys ON responses.surveyid = surveys.id
                 LEFT JOIN users ON surveys.userid = users.id
                 WHERE users.email = $1
                 AND surveys.survey_name = $2
                 AND (responses.userid, timestamp, question_ref) > ($3, $4, $5)
                 ORDER BY (responses.userid, timestamp, question_ref)
                 LIMIT 100000`;

  const res = await pool.query(query, [email, name, ...lim]);
  const fin = res.rows.slice(-1)[0];

  if (!fin) return cursorResult(null, null);

  // function to extract limit from single row
  return cursorResult(res.rows, [
    fin['userid'],
    fin['timestamp'],
    fin['question_ref'],
  ]);
}

async function formResponses(email, survey) {
  const fn = (lim, time) => responsesQuery(this, email, survey, time, lim);
  const stream = new ClientCursorStream(fn, ['', new Date('1970-01-01'), '']);
  return stream;
}

async function formData(email, survey) {
  // Adds "version" following same logic as per dashboard.
  // TODO: clean this up, there is duplicated logic with surveys
  // controller -- make surveys controller get by survey_name instead
  // of all surveys? hrm...
  const query = `WITH t AS (
                   SELECT surveys.*, row_number() OVER (partition BY shortcode ORDER BY created) AS version
                   FROM surveys
                   LEFT JOIN users ON surveys.userid = users.id
                   WHERE users.email = $1
                   AND survey_name = $2
                 )
                 SELECT id as surveyid,
                        shortcode,
                        survey_name,
                        version,
                        created::string as survey_created,
                        metadata
                 FROM t
                 ORDER BY shortcode, created`;

  const { rows } = await this.query(query, [email, survey]);
  return rows;
}

module.exports = {
  name: 'Response',
  _all,
  queries: pool => ({
    all: all.bind(pool),
    firstAndLast: firstAndLast.bind(pool),
    formResponses: formResponses.bind(pool),
    formData: formData.bind(pool),
  }),
};
