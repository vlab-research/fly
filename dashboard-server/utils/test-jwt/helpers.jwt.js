var { Buffer } = require('buffer');
var { createSecretKey } = require('crypto');
var { SignJWT, generateKeyPair, exportJWK } = require('jose');
var nock = require('nock');

const now = (Date.now() / 1000) | 0;
const day = 60 * 60 * 24;
exports.now = now;

const createJwt = async ({
  payload = {},
  issuer = 'https://issuer.example.com/',
  subject = 'me',
  audience = 'https://api/',
  jwksUri = '/.well-known/jwks.json',
  discoveryUri = '/.well-known/openid-configuration',
  iat = now,
  exp = now + day,
  kid = 'kid',
  jwksSpy = undefined,
  discoverSpy = undefined,
  secret,
} = {}) => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  nock(issuer)
    .persist()
    .get(jwksUri)
    .reply(200, (...args) => {
      // jwksSpy(...args);
      return { keys: [{ kid, ...publicJwk }] };
    })
    .get(discoveryUri)
    .reply(200, (...args) => {
      // discoverSpy(...args);
      return {
        issuer,
        jwks_uri: (issuer + jwksUri).replace('//.well-known', '/.well-known'),
      };
    });

  const secretKey = secret && createSecretKey(Buffer.from(secret));

  return new SignJWT(payload)
    .setProtectedHeader({
      alg: secretKey ? 'HS256' : 'RS256',
      typ: 'JWT',
      kid,
    })
    .setIssuer(issuer)
    .setSubject(subject)
    .setAudience(audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey || privateKey);
};
exports.createJwt = createJwt;