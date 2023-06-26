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
                          settings.timeouts,
                          settings.off_time
                        FROM surveys s
                        LEFT JOIN users ON s.userid = users.id
                        LEFT JOIN survey_settings settings
                          ON s.userid = settings.userid
                          AND s.shortcode = settings.shortcode
                        WHERE email=$1
                        ORDER BY created DESC`;
  const values = [email];
  const { rows } = await this.query(RETRIEVE_ALL, values);
  return rows;
}

async function update({ email, shortcode, timeouts, off_time }) {
  const UPDATE_SETTINGS = `INSERT INTO survey_settings(userid, shortcode, timeouts, off_time)
                        VALUES(
                        (SELECT id FROM users WHERE email=$1 LIMIT 1),
                        $2, $3, $4)
                        ON CONFLICT(userid, shortcode)
                        DO UPDATE SET timeouts = $3, off_time= $4
                        RETURNING *`;

  const values = [email, shortcode, JSON.stringify(timeouts), off_time];
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
