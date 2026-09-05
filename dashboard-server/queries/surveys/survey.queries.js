'use strict';

async function create({
  created,
  formid,
  form,
  messages,
  shortcode,
  userid,
  title,
  survey_name,
  metadata,
  translation_conf
}) {
  const CREATE_ONE = `INSERT INTO surveys(created, formid, form, messages, shortcode, userid, title, survey_name, metadata, translation_conf)
       values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT(id) DO NOTHING
       RETURNING *`;
  const values = [created, formid, form, messages, shortcode, userid, title, survey_name, metadata, translation_conf];
  const { rows } = await this.query(CREATE_ONE, values);
  return rows[0];
}

async function retrieve({ email }) {
  const RETRIEVE_ALL = `SELECT 
                          s.created,
                          s.shortcode,
                          s.id,
                          s.title,
                          s.survey_name,
                          s.metadata,
                          s.translation_conf,
                          s.formid,
                          settings.off_time,
                          settings.timeouts
                        FROM surveys s
                        LEFT JOIN users ON s.userid = users.id
                        LEFT JOIN survey_settings settings
                          ON s.id = settings.surveyid
                        WHERE email=$1
                        ORDER BY created DESC`;
  const values = [email];
  const { rows } = await this.query(RETRIEVE_ALL, values);
  return rows;
}

/*
 * Ownership is enforced in the statement rather than in a middleware, so there
 * is no window between the check and the write. The SELECT yields no row when
 * the survey is not the caller's, so the INSERT writes nothing and no
 * ON CONFLICT fires — someone else's settings are untouched and `undefined`
 * comes back. Callers turn that into a 404.
 */
async function update({ surveyid, email, timeouts, off_time }) {
  const UPDATE_SETTINGS = `INSERT INTO survey_settings(surveyid, timeouts, off_time)
                        SELECT $1::UUID, $2::JSON, $3::TIMESTAMPTZ
                        FROM surveys s
                        JOIN users ON s.userid = users.id
                        WHERE s.id = $1::UUID AND users.email = $4
                        ON CONFLICT(surveyid)
                        DO UPDATE SET timeouts = $2::JSON, off_time = $3::TIMESTAMPTZ
                        RETURNING *`;

  const values = [surveyid, JSON.stringify(timeouts), off_time, email];
  const { rows } = await this.query(UPDATE_SETTINGS, values);
  return rows[0];
}

module.exports = {
  name: 'Survey',
  queries: pool => ({
    create: create.bind(pool),
    retrieve: retrieve.bind(pool),
    update: update.bind(pool),
  }),
};
