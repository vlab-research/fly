async function get ({email}) {
   const q = `
     WITH t AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY entity, key ORDER BY created DESC) AS n
                FROM credentials
                JOIN users ON userid=id
                WHERE email = $1)
     SELECT entity, key, details, created
     FROM t
     WHERE n = 1
  `

  const values = [email]
  const {rows} = await this.query(q, values)
  return rows
}

/*
 * Every messaging account a user owns — the fan-out target set for media
 * uploads (planning/media-abstraction.md §2).
 *
 * The findings doc rejected pre-upload because a survey resolves under ANY of
 * its owner's accounts, so the target account is unknown at authoring time.
 * That is true, but "unknown" and "one of these" are different problems: this
 * query IS the set, so you do not predict the account, you upload to all of
 * them. Served as an index-only scan by migration 20's unique_messaging_account.
 *
 * `key` is what becomes media_handle.account_id — the page id or phone number
 * id, NOT the entity and NOT details->>'page_id'. It is the one identifier the
 * writer and the reader already agree on in production, because tokenstore.go
 * resolves access tokens by that same equality.
 *
 * Deduped newest-first per (entity, key) exactly like `get`: credentials rotate
 * and old rows are kept, so without this a rotated page would be uploaded to
 * twice — once with a dead token.
 */
async function getMessagingAccounts ({email}) {
  const q = `
    WITH t AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY entity, key ORDER BY created DESC) AS n
               FROM credentials
               JOIN users ON userid=id
               WHERE email = $1
               AND entity IN ('facebook_page', 'whatsapp_business'))
    SELECT entity, key, details
    FROM t
    WHERE n = 1
  `

  const {rows} = await this.query(q, [email])
  return rows
}

async function getOne ({email, entity, key}) {
   const q = `
     SELECT entity, key, details, created
     FROM credentials
     JOIN users ON userid=id
     WHERE email = $1
     AND entity = $2
     AND key = $3
     ORDER BY created DESC
     LIMIT 1
  `

  const values = [email, entity, key]
  const {rows} = await this.query(q, values)
  return rows[0]
}

// TURN INTO UPSERT?
async function update ({entity, key, details, email}) {
  const q = `
    UPDATE credentials
    SET (details, created) = ($4, CURRENT_TIMESTAMP)
    WHERE entity = $1
    AND key = $2
    AND userid = (SELECT id FROM users WHERE email = $3)
    RETURNING *
  `

  const values = [entity, key, email, details]
  const {rows} = await this.query(q, values)
  return rows[0]
}



async function create ({entity, key, details, email}) {

  const q = `
    INSERT INTO credentials (entity, key, details, userid)
    VALUES ($1, $2, $3, (SELECT id FROM users WHERE email = $4))
    RETURNING *
  `

  const values = [entity, key, details, email]
  const {rows} = await this.query(q, values)
  return rows[0]
}

/**
 * Creates a credential and a corresponding messaging_accounts registry row
 * in a single transaction.
 *
 * On success, returns the credential row. On failure (either insert), rolls back
 * both and throws the database error.
 *
 * @param {Object} params
 * @param {string} params.entity - Credential entity ('facebook_page', 'whatsapp_business', etc.)
 * @param {string} params.key - Credential key (account id for messaging)
 * @param {Object} params.details - Credential details JSON
 * @param {string} params.email - User's email (resolved to userid)
 * @param {string} params.platform - Platform for registry row ('messenger', 'whatsapp', etc.)
 * @returns {Promise<Object>} - The created credential row
 * @throws {Error} - Database error (which will roll back the transaction)
 */
async function createWithMessagingRegistry ({entity, key, details, email, platform}) {
  const client = await this.connect();

  try {
    await client.query('BEGIN');

    // Insert credential
    const credQ = `
      INSERT INTO chatroach.credentials (entity, key, details, userid)
      VALUES ($1, $2, $3, (SELECT id FROM chatroach.users WHERE email = $4))
      RETURNING entity, key, details, userid, created
    `;
    const credValues = [entity, key, details, email];
    const credResult = await client.query(credQ, credValues);
    const credential = credResult.rows[0];

    if (!credential) {
      await client.query('ROLLBACK');
      throw new Error('Failed to insert credential');
    }

    // Insert registry row
    const regQ = `
      INSERT INTO chatroach.messaging_accounts
        (platform, account_id, userid, credentials_entity, credentials_key, created)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `;
    const regValues = [platform, key, credential.userid, entity, key];
    await client.query(regQ, regValues);

    await client.query('COMMIT');
    return credential;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Rollback failed, but we're already erroring, so log and continue
      console.error('Rollback failed:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}


module.exports = {
  name: 'Credential',
  queries: pool => ({
    create: create.bind(pool),
    createWithMessagingRegistry: createWithMessagingRegistry.bind(pool),
    update: update.bind(pool),
    get: get.bind(pool),
    getOne: getOne.bind(pool),
    getMessagingAccounts: getMessagingAccounts.bind(pool),
  }),
};
