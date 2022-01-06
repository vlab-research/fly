'use strict';

const joi = require('joi');
const jwks = require('jwks-rsa');

const envVarsSchema = joi
  .object({
    API_VERSION: joi.number(),
    AUTH0_HOST: joi.string(),
    DB_USER: joi.string(),
    DB_HOST: joi.string(),
    DB_PASSWORD: joi
      .string()
      .optional()
      .empty(''),
    DB_DATABASE: joi.string(),
    DB_PORT: joi.number(),
    FORMCENTRAL_URL: joi.string(),
    AUTH0_CLIENT_ID: joi.string(),
    AUTH0_DASHBOARD_SECRET: joi.string(),
    FACEBOOK_APP_ID: joi.string(),
    FACEBOOK_APP_SECRET: joi.string(),
    FACEBOOK_GRAPH_URL: joi.string()
  })
  .unknown()
  .required();

const { error, value: envVars } = joi.validate(process.env, envVarsSchema);
if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const config = {
  FORMCENTRAL: {
    url: envVars.FORMCENTRAL_URL,
  },
  SERVER: {
    API_VERSION: envVars.API_VERSION || '1',
  },
  TYPEFORM: {
    typeformUrl: envVars.TYPEFORM_URL || '',
    secret: envVars.TYPEFORM_CLIENT_SECRET || '',
    clientId: envVars.TYPEFORM_CLIENT_ID || '',
    redirectUri: envVars.TYPEFORM_REDIRECT_URL || '',
  },
  FACEBOOK: {
    id: envVars.FACEBOOK_APP_ID,
    secret: envVars.FACEBOOK_APP_SECRET,
    url: envVars.FACEBOOK_GRAPH_URL
  },
  JWT: {
    secret: jwks.expressJwtSecret({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      jwksUri: `${envVars.AUTH0_HOST}/.well-known/jwks.json`,
    }),
    audience: envVars.AUTH0_CLIENT_ID,
    issuer: `${envVars.AUTH0_HOST}/`,
    algorithms: ['RS256'],
  },
  SERVER_JWT: {
    secret: envVars.AUTH0_DASHBOARD_SECRET
  },
  DATABASE_CONFIG: {
    user: envVars.DB_USER,
    host: envVars.DB_HOST,
    database: envVars.DB_DATABASE,
    password: envVars.DB_PASSWORD,
    port: envVars.DB_PORT,
  },
};

module.exports = config;
