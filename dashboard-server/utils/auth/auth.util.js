const jwtwebtoken = require('jsonwebtoken');
const { SERVER_JWT: serverConfig } = require('../../config');

async function makeAPIToken(payload) {
  const secret = serverConfig.secret
  const opts = { algorithm: 'HS256' }

  return new Promise((resolve, reject) => {
    jwtwebtoken.sign(payload, secret, opts, (err, token) => {
      if (err) return reject(err);

      resolve(token)
    })
  })
}

module.exports = { makeAPIToken }
