'use strict';

async function create({ email, facebookPageId, fbTemplateId, name, language, body, status, rejectionReason }) {
  const q = `
    INSERT INTO message_templates
      (userid, facebook_page_id, fb_template_id, name, language, body, status, rejection_reason)
    VALUES (
      (SELECT id FROM users WHERE email = $1),
      $2, $3, $4, $5, $6, $7, $8
    )
    RETURNING *
  `;
  const values = [
    email,
    facebookPageId,
    fbTemplateId || null,
    name,
    language,
    body,
    status || 'PENDING',
    rejectionReason || null,
  ];
  const { rows } = await this.query(q, values);
  return rows[0];
}

async function list({ email, facebookPageId }) {
  const q = `
    SELECT m.id, m.facebook_page_id, m.fb_template_id, m.name, m.language,
           m.body, m.status, m.rejection_reason, m.created, m.updated
    FROM message_templates m
    JOIN users u ON m.userid = u.id
    WHERE u.email = $1
      AND m.facebook_page_id = $2
    ORDER BY m.name ASC, m.language ASC
  `;
  const values = [email, facebookPageId];
  const { rows } = await this.query(q, values);
  return rows;
}

async function get({ email, id }) {
  const q = `
    SELECT m.id, m.facebook_page_id, m.fb_template_id, m.name, m.language,
           m.body, m.status, m.rejection_reason, m.created, m.updated
    FROM message_templates m
    JOIN users u ON m.userid = u.id
    WHERE u.email = $1 AND m.id = $2
    LIMIT 1
  `;
  const values = [email, id];
  const { rows } = await this.query(q, values);
  return rows[0];
}

async function updateStatus({ id, status, rejectionReason, fbTemplateId }) {
  const q = `
    UPDATE message_templates
    SET status = $2,
        rejection_reason = $3,
        fb_template_id = COALESCE($4, fb_template_id),
        updated = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `;
  const values = [id, status, rejectionReason || null, fbTemplateId || null];
  const { rows } = await this.query(q, values);
  return rows[0];
}

async function remove({ email, id }) {
  const q = `
    DELETE FROM message_templates
    WHERE id = $1
      AND userid = (SELECT id FROM users WHERE email = $2)
    RETURNING id
  `;
  const values = [id, email];
  const { rows } = await this.query(q, values);
  return rows[0];
}

module.exports = {
  name: 'MessageTemplate',
  queries: pool => ({
    create: create.bind(pool),
    list: list.bind(pool),
    get: get.bind(pool),
    updateStatus: updateStatus.bind(pool),
    remove: remove.bind(pool),
  }),
};
