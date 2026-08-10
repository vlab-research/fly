'use strict';

const joi = require('joi');
const jwks = require('jwks-rsa');

const envVarsSchema = joi
  .object({
    NODE_ENV: joi.string().allow(['development', 'production', 'test']),
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
    FACEBOOK_GRAPH_URL: joi.string(),
    KAFKA_BROKERS: joi.string(),
    KAFKA_EXPORTS_TOPIC: joi.string(),
    EXODUS_API_URL: joi.string().optional().empty(''),
    LINEAR_API_KEY: joi.string().optional().empty(''),
    LINEAR_TEAM_ID: joi.string().optional().empty(''),
    LINEAR_API_URL: joi.string().optional().empty(''),
    LINEAR_TODO_STATE_ID: joi.string().optional().empty(''),
    ALERTMANAGER_URL: joi.string().optional().empty(''),
    // Media object storage (planning/media-abstraction.md §4.7). S3 API only —
    // no cloud-provider SDK or identity system anywhere in the application.
    STORAGE_BACKEND: joi.string().allow(['s3', 'none']).optional().empty(''),
    MEDIA_BUCKET: joi.string().optional().empty(''),
    MEDIA_PREFIX: joi.string().optional().empty(''),
    MEDIA_PUBLIC_BASE: joi.string().optional().empty(''),
    S3_ENDPOINT: joi.string().optional().empty(''),
    S3_REGION: joi.string().optional().empty(''),
    S3_ACCESS_KEY_ID: joi.string().optional().empty(''),
    S3_SECRET_ACCESS_KEY: joi.string().optional().empty(''),
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
    secret: isTest() ? 'secret' : envVars.AUTH0_DASHBOARD_SECRET
  },
  DATABASE_CONFIG: {
    user: isTest() ? 'root' : envVars.DB_USER || 'postgres',
    host: isTest() ? 'localhost' : envVars.DB_HOST || 'localhost',
    database: isTest() ? 'chatroach' : envVars.DB_DATABASE || 'postgres',
    password: isTest() ? undefined : envVars.DB_PASSWORD || undefined,
    port: isTest() ? 5433 : envVars.DB_PORT || 5432,
  },
  KAFKA: {
    BROKERS: isTest() ? "" : envVars.KAFKA_BROKERS.split(","),
    EXPORTS_TOPIC: envVars.KAFKA_EXPORTS_TOPIC || 'vlabs-exports'
  },
  EXODUS: {
    url: envVars.EXODUS_API_URL || 'http://exodus-api:8080',
  },
  LINEAR: {
    apiKey: envVars.LINEAR_API_KEY || '',
    teamId: envVars.LINEAR_TEAM_ID || '',
    url: envVars.LINEAR_API_URL || 'https://api.linear.app/graphql',
    todoStateId: envVars.LINEAR_TODO_STATE_ID || '',
  },
  // Media object storage (§4.7). Defaults are the local docker-compose stack, so
  // `npm test` and `npm run dev` work with nothing set; production and staging
  // set every key from devops/values/<env>.yaml plus the gitignored .env.
  STORAGE: {
    // 'none' is a dev no-op that discards bytes, matching the exporter's
    // convention. Anything else must be 's3'; there is no second backend.
    backend: envVars.STORAGE_BACKEND || 's3',
    bucket: envVars.MEDIA_BUCKET || 'media',
    // Fixed at 'a/' rather than genuinely configurable: media.core.js derives
    // the object key and the public URL from it, and media-proxy's path regex
    // hard-codes the same segment. Accepting the env var and refusing a
    // different value keeps the config honest — a mismatch here would produce
    // objects the proxy can never serve, and the failure would only show up as
    // a broken image in a respondent's chat.
    prefix: envVars.MEDIA_PREFIX || 'a/',
    publicBase: envVars.MEDIA_PUBLIC_BASE || 'http://localhost:9000/media',
    endpoint: envVars.S3_ENDPOINT || 'http://localhost:9000',
    // MinIO ignores the region; the S3 protocol requires one.
    region: envVars.S3_REGION || 'us-east-1',
    accessKeyId: envVars.S3_ACCESS_KEY_ID || 'minioadmin',
    secretAccessKey: envVars.S3_SECRET_ACCESS_KEY || 'minioadmin',
  },
  ALERTMANAGER: {
    // Unset -> /platform/notices returns { notices: [] } (feature cleanly
    // off in dev or if monitoring moves). In-cluster:
    // http://alertmanager-operated.monitoring:9093
    url: envVars.ALERTMANAGER_URL || '',
  },
};

// Fail at boot, not at the first upload. See the comment on STORAGE.prefix.
if (config.STORAGE.prefix !== 'a/') {
  throw new Error(
    `Config validation error: MEDIA_PREFIX must be "a/" (got "${config.STORAGE.prefix}") — ` +
      'the object key and the media-proxy path regex both fix it',
  );
}

module.exports = config;
