const { MIDDLEWARE_JWT: clientConfig } = require('../config');
const { auth } = require('express-oauth2-jwt-bearer');

// make middleware that tries auth0 client then if that fails
// tries auth0 server application...
const checkJwt = auth(clientConfig);

module.exports = checkJwt;
