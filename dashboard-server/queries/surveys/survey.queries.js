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
  const RETRIEVE_ALL = `SELECT s.created, s.shortcode, s.id, s.title, s.survey_name, s.metadata, s.translation_conf, s.formid
                        FROM surveys s
                        LEFT JOIN users on s.userid = users.id
                        WHERE email=$1
                        ORDER BY created DESC`;
  const values = [email];
  const { rows } = await this.query(RETRIEVE_ALL, values);
  return rows;
}

module.exports = {
  name: 'Survey',
  queries: pool => ({
    create: create.bind(pool),
    retrieve: retrieve.bind(pool),
  }),
};
