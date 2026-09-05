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

/*
 * The verifier's hot path: a token's jti -> the live row that authorises it.
 *
 * Served as an index-only read by migration 32's unique_api_token_jti, which is
 * partial on `api_token_jti IS NOT NULL`, so the entity filter is already
 * implied by the index and is stated only so the query reads correctly on its
 * own.
 *
 * No row means the key was revoked. That is the whole mechanism: the token is
 * never stored, so this row IS the credential.
 */
async function getApiTokenByJti ({jti}) {
  const q = `
    SELECT c.key, c.details, c.created, u.email
    FROM credentials c
    JOIN users u ON c.userid = u.id
    WHERE c.entity = 'api_token'
    AND c.api_token_jti = $1
  `

  const {rows} = await this.query(q, [jti])
  return rows[0]
}

/*
 * The same lookup for keys minted before migration 32: they carry a token-name
 * claim but no jti. Newest row wins, matching `getOne`.
 */
async function getApiTokenByName ({email, name}) {
  const q = `
    SELECT c.key, c.details, c.created, u.email
    FROM credentials c
    JOIN users u ON c.userid = u.id
    WHERE c.entity = 'api_token'
    AND u.email = $1
    AND c.key = $2
    ORDER BY c.created DESC
    LIMIT 1
  `

  const {rows} = await this.query(q, [email, name])
  return rows[0]
}

/*
 * Revocation. Scoped to the owner's email so that a key name — which
 * UNIQUE(entity, key) makes globally unique across ALL users — can never be
 * revoked by anyone but its owner.
 *
 * Deleting rather than flagging frees the name for reuse; migration 32 explains
 * why that is safe, and why it needed a DELETE grant.
 */
async function deleteApiToken ({email, name}) {
  const q = `
    DELETE FROM credentials
    WHERE entity = 'api_token'
    AND key = $2
    AND userid = (SELECT id FROM users WHERE email = $1)
    RETURNING key, details
  `

  const {rows} = await this.query(q, [email, name])
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


module.exports = {
  name: 'Credential',
  queries: pool => ({
    create: create.bind(pool),
    update: update.bind(pool),
    get: get.bind(pool),
    getOne: getOne.bind(pool),
    getMessagingAccounts: getMessagingAccounts.bind(pool),
    getApiTokenByJti: getApiTokenByJti.bind(pool),
    getApiTokenByName: getApiTokenByName.bind(pool),
    deleteApiToken: deleteApiToken.bind(pool),
  }),
};
