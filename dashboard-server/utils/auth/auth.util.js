const { Credential } = require('../../queries');
const jwtwebtoken = require('jsonwebtoken');
const { SERVER_JWT: serverConfig } = require('../../config');

/*
 * Signs an HS256 JWT with the shared server secret.
 *
 * `opts` is passed through to jsonwebtoken and NOTHING is defaulted into it. In
 * particular there is no default `expiresIn`: this same function signs the
 * tokens the test suites use as bearer credentials, and the same shared secret
 * signs replybot's and hermes' internal service JWTs, which carry no exp at
 * all. Expiry is a property of a researcher API key, applied by the mint route,
 * not of every token signed here.
 */
async function makeAPIToken(payload, opts = {}) {
  const secret = serverConfig.secret
  const options = Object.assign({ algorithm: 'HS256' }, opts)

  return new Promise((resolve, reject) => {
    jwtwebtoken.sign(payload, secret, options, (err, token) => {
      if (err) return reject(err);

      resolve(token)
    })
  })
}

/*
 * The credentials row is the revocable half of an API key — the token is never
 * stored — so jti, scopes and expiry live in `details` next to the name.
 *
 * The two-argument call still writes `{name}` and nothing else, which is a
 * valid-but-unscoped, non-expiring key. That is the legacy shape, and tests
 * across the suite depend on it.
 */
function insertIntoCredentials(email, name, details = {}) {
  return Credential.create({
    key: name,
    entity: 'api_token',
    details: Object.assign({ name }, details),
    email,
  })
}

module.exports = { makeAPIToken, insertIntoCredentials }
