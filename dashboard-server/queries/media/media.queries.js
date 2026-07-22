'use strict';

async function create({ email, accountId, pageId, attachmentId, mediaType, filename }) {
  // Support both accountId (new) and legacy pageId parameter for deploy safety
  const accountIdValue = accountId || pageId;
  const q = `
    INSERT INTO media (userid, account_id, attachment_id, media_type, filename)
    VALUES (
      (SELECT id FROM users WHERE email = $1),
      $2, $3, $4, $5
    )
    RETURNING *
  `;
  const values = [email, accountIdValue, attachmentId, mediaType, filename];
  const { rows } = await this.query(q, values);
  return rows[0];
}

async function list({ email }) {
  const q = `
    SELECT m.id, m.account_id, m.attachment_id, m.media_type,
           m.filename, m.created
    FROM media m
    JOIN users u ON m.userid = u.id
    WHERE u.email = $1
    ORDER BY m.created DESC
  `;
  const values = [email];
  const { rows } = await this.query(q, values);
  return rows;
}

module.exports = {
  name: 'Media',
  queries: pool => ({
    create: create.bind(pool),
    list: list.bind(pool),
  }),
};
