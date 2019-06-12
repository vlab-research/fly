'use strict';

require('dotenv').config();
const joi = require('joi');
const jwks = require('jwks-rsa');

const envVarsSchema = joi
  .object({
    NODE_ENV: joi.string().allow(['development', 'production', 'test']),
    PORT: joi.number(),
    API_VERSION: joi.number(),
    AUTH0_HOST: joi.string().required(),
    DB_USER: joi.string(),
    DB_HOST: joi.string(),
    DB_PASSWORD: joi
      .string()
      .optional()
      .empty(''),
    DB_DATABASE: joi.string(),
    DB_PORT: joi.number(),
  })
  .unknown()
  .required();

const { error, value: envVars } = joi.validate(process.env, envVarsSchema);
if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const isTest = () => envVars.NODE_ENV === 'test';

const config = {
  ENV: envVars.NODE_ENV,
  IS_DEVELOPMENT: envVars.NODE_ENV === 'development',
  IS_TEST: isTest(),
  SERVER: {
    PORT: envVars.PORT || 3000,
    API_VERSION: envVars.API_VERSION || '1',
  },
  TYPEFORM: {
    typeformUrl: envVars.TYEPFORM_URL || '',
    secret: envVars.TYEPFORM_CLIENT_SECRET || '',
    clientId: envVars.TYEPFORM_CLIENT_ID || '',
    redirectUri: envVars.TYPEFORM_REDIRECT_URL || '',
  },
  JWT: {
    secret: jwks.expressJwtSecret({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      jwksUri: `${envVars.AUTH0_HOST}/.well-known/jwks.json`,
    }),
    algorithms: ['RS256'],
  },
  DATABASE_CONFIG: {
    user: isTest() ? 'postgres' : envVars.DB_USER || 'postgres',
    host: isTest() ? 'localhost' : envVars.DB_HOST || 'localhost',
    database: isTest() ? 'vlab_dashboard_test' : envVars.DB_DATABASE || 'postgres',
    password: isTest() ? undefined : envVars.DB_PASSWORD || undefined,
    port: isTest() ? 5432 : envVars.DB_PORT || 5432,
  },
};

module.exports = config;