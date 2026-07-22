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

// Maps messaging entity types to their first-class (platform, account_id)
// keying (see documentation/platform-abstraction.md and
// devops/migrations/20-platform-abstraction.sql). Non-messaging entities
// (facebook_ad_user, typeform_token, ...) have no platform and stay NULL.
function platformKeys (entity, details) {
  const d = typeof details === 'string' ? JSON.parse(details) : (details || {})

  switch (entity) {
    case 'facebook_page':
      return { platform: 'messenger', accountId: d.id || null }
    case 'whatsapp_business':
      return { platform: 'whatsapp', accountId: d.id || d.phone_number_id || null }
    default:
      return { platform: null, accountId: null }
  }
}

// TURN INTO UPSERT?
async function update ({entity, key, details, email}) {
  // Also (re-)stamps platform/account_id so legacy rows created before the
  // platform keying migration get backfilled on their next token refresh.
  const { platform, accountId } = platformKeys(entity, details)

  const q = `
    UPDATE credentials
    SET (details, created, platform, account_id) = ($4, CURRENT_TIMESTAMP, $5, $6)
    WHERE entity = $1
    AND key = $2
    AND userid = (SELECT id FROM users WHERE email = $3)
    RETURNING *
  `

  const values = [entity, key, email, details, platform, accountId]
  const {rows} = await this.query(q, values)
  return rows[0]
}



async function create ({entity, key, details, email}) {
  const { platform, accountId } = platformKeys(entity, details)

  const q = `
    INSERT INTO credentials (entity, key, details, userid, platform, account_id)
    VALUES ($1, $2, $3, (SELECT id FROM users WHERE email = $4), $5, $6)
    RETURNING *
  `

  const values = [entity, key, details, email, platform, accountId]
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
  }),
};
