/// <reference types="node" />
import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import {
  GenericContainer,
  StartedTestContainer,
  StartedNetwork,
  Network,
  Wait,
} from 'testcontainers';

interface KubeEnv {
  name: string;
  value?: string;
}

interface KubeContainer {
  env?: KubeEnv[];
}

interface KubeSpec {
  template: {
    spec: {
      containers: KubeContainer[];
    };
  };
}

interface KubeDeployment {
  spec: KubeSpec;
}

export interface Stack {
  network: StartedNetwork;
  cockroach: StartedTestContainer;
  redpanda: StartedTestContainer;
  redis: StartedTestContainer;
  scribbleStates: StartedTestContainer;
  scribbleResponses: StartedTestContainer;
  formcentral: StartedTestContainer;
  dinersclub: StartedTestContainer;
  botserver: StartedTestContainer;
  replybot: StartedTestContainer;
  messageWorker: StartedTestContainer;
  facebot: StartedTestContainer;
  facebotUrl: string;
  botserverUrl: string;
  chatbaseConnString: string;
  deanImage: string;
  deanEnv: Record<string, string>;
}

/**
 * Parse k8s deployment YAML and extract env vars from spec.template.spec.containers[0].env
 * Only includes entries with 'value:' (skips valueFrom: secret refs)
 */
export function loadKubeEnv(filePath: string): Record<string, string> {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const deployment = yaml.load(fileContent) as KubeDeployment;

  if (!deployment.spec?.template?.spec?.containers?.[0]?.env) {
    return {};
  }

  const env: Record<string, string> = {};
  const envArray = deployment.spec.template.spec.containers[0].env;

  for (const envVar of envArray) {
    if (envVar.value !== undefined) {
      env[envVar.name] = envVar.value;
    }
  }

  return env;
}

/**
 * Parse dotenv file (like devops/testing/.test-env)
 */
export function loadTestEnv(): Record<string, string> {
  const testEnvPath = path.resolve(__dirname, '../../../devops/testing/.test-env');
  const content = fs.readFileSync(testEnvPath, 'utf8');
  return dotenv.parse(content);
}

/**
 * Start the full testcontainers stack
 */
export async function startStack(): Promise<Stack> {
  // Resolve repo root: __dirname is .../facebot/testrunner/dist at runtime
  const repoRoot = path.resolve(__dirname, '../../../');
  const t0 = Date.now();

  // Create network
  console.time('[setup] network');
  const network = await new Network().start();
  console.timeEnd('[setup] network');

  // Load env vars from test env and YAMLs
  const testEnv = loadTestEnv();

  // Build all images in parallel with explicit names.
  // Hermes (Rust) is the drop-in replacement for the deprecated Node botserver;
  // it serves the identical /webhooks + /synthetic + /health contract and
  // publishes the same source-tagged raw events to BOTSERVER_EVENT_TOPIC.
  const hermesImageName = 'hermes:test';
  console.time('[setup] image builds');
  const replybotImageName = 'replybot:test';
  const scribbleImageName = 'scribble:test';
  const faceBotImageName = 'facebot:test';
  const deanImageName = 'dean:test';
  const formcentralImageName = 'formcentral:test';
  const dinersclubImageName = 'dinersclub:test';
  const messageWorkerImageName = 'message-worker:test';

  await Promise.all([
    GenericContainer.fromDockerfile(path.join(repoRoot, 'hermes')).build(hermesImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'replybot')).build(replybotImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'scribble')).build(scribbleImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'facebot/receiver')).build(faceBotImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'dean')).build(deanImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'formcentral')).build(formcentralImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'dinersclub')).build(dinersclubImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'message-worker')).build(messageWorkerImageName),
  ]);
  console.timeEnd('[setup] image builds');

  // Start cockroach
  console.time('[setup] cockroach + migrations');
  const cockroach = await new GenericContainer('cockroachdb/cockroach:v24.1.0')
    .withNetwork(network)
    .withNetworkAliases('cockroach')
    .withExposedPorts(26257)
    .withCommand(['start', '--insecure', '--listen-addr=0.0.0.0:26258', '--sql-addr=0.0.0.0:26257', '--join=localhost:26258'])
    .withWaitStrategy(Wait.forLogMessage('Node will now attempt to join a running cluster'))
    .start();

  // Initialize the single-node cluster (connects via RPC port 26258)
  await cockroach.exec([
    './cockroach',
    'init',
    '--insecure',
    '--host=localhost:26258',
  ]);

  // Create test database and user (not auto-created)
  await cockroach.exec([
    './cockroach',
    'sql',
    '--insecure',
    '--host=localhost:26257',
    '-e',
    'CREATE DATABASE IF NOT EXISTS chatroach;',
  ]);
  await cockroach.exec([
    './cockroach',
    'sql',
    '--insecure',
    '--host=localhost:26257',
    '-e',
    'CREATE USER IF NOT EXISTS chatroach;',
  ]);

  // Load production migration files and execute them in cockroach
  const migrationsDir = path.join(repoRoot, 'devops/migrations');
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const migrationPath = path.join(migrationsDir, file);
    const migration = fs.readFileSync(migrationPath, 'utf8');
    const result = await cockroach.exec([
      './cockroach',
      'sql',
      '--insecure',
      '--host=localhost:26257',
      '--database=chatroach',
      '-e',
      migration,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Migration ${file} failed (exit ${result.exitCode}):\n${result.output}`);
    }
  }

  // Test-specific schema adjustments: surveys table needs UNIQUE(userid, shortcode) for seed upserts
  const testSchemaResult = await cockroach.exec([
    './cockroach',
    'sql',
    '--insecure',
    '--host=localhost:26257',
    '--database=chatroach',
    '-e',
    'ALTER TABLE surveys ADD CONSTRAINT IF NOT EXISTS unique_userid_shortcode UNIQUE(userid, shortcode);',
  ]);
  if (testSchemaResult.exitCode !== 0) {
    console.log('Note: adding UNIQUE constraint (may already exist):', testSchemaResult.output);
  }
  console.timeEnd('[setup] cockroach + migrations');

  // Get cockroach mapped port for direct connection (used by testrunner on host)
  const cockroachPort = cockroach.getMappedPort(26257);
  const chatbaseConnString = `postgresql://chatroach@localhost:${cockroachPort}/chatroach?sslmode=disable`;

  // Start redpanda
  console.time('[setup] redpanda + topics');
  const redpanda = await new GenericContainer('redpandadata/redpanda:v23.3.18')
    .withNetwork(network)
    .withNetworkAliases('redpanda')
    .withCommand([
      'redpanda',
      'start',
      '--overprovisioned',
      '--smp',
      '1',
      '--memory',
      '200M',
      '--reserve-memory',
      '0M',
      '--node-id',
      '0',
      '--check=false',
      '--kafka-addr',
      'PLAINTEXT://0.0.0.0:9092',
      '--advertise-kafka-addr',
      'PLAINTEXT://redpanda:9092',
    ])
    .withWaitStrategy(Wait.forLogMessage('Successfully started Redpanda'))
    .start();

  // Create Kafka topics in redpanda
  try {
    await redpanda.exec([
      'rpk',
      'topic',
      'create',
      'vlab-state',
      'vlab-response',
      'vlab-payment',
      'chat-events',
      'vlab-chat-log',
      'commands',
    ]);
  } catch (e) {
    // Topics might already exist, continue
    console.log('Kafka topics creation (may have already existed):', e);
  }
  console.timeEnd('[setup] redpanda + topics');

  // Load scribble env from YAML and apply overrides
  console.time('[setup] scribble + redis + formcentral');
  const scribbleStatesEnv = loadKubeEnv(
    path.join(repoRoot, 'scribble/kube-dev/states.yaml')
  );
  scribbleStatesEnv.KAFKA_BROKERS = 'redpanda:9092';

  const scribbleResponsesEnv = loadKubeEnv(
    path.join(repoRoot, 'scribble/kube-dev/responses.yaml')
  );
  scribbleResponsesEnv.KAFKA_BROKERS = 'redpanda:9092';

  const [scribbleStates, scribbleResponses] = await Promise.all([
    new GenericContainer(scribbleImageName)
      .withNetwork(network)
      .withNetworkAliases('scribble-states')
      .withEnvironment(scribbleStatesEnv)
      .withWaitStrategy(Wait.forLogMessage(/Scribble states ready/))
      .start(),
    new GenericContainer(scribbleImageName)
      .withNetwork(network)
      .withNetworkAliases('scribble-responses')
      .withEnvironment(scribbleResponsesEnv)
      .withWaitStrategy(Wait.forLogMessage(/Scribble responses ready/))
      .start(),
  ]);

  // Start redis (required by replybot for state locking)
  const redis = await new GenericContainer('redis:7-alpine')
    .withNetwork(network)
    .withNetworkAliases('redis')
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  // Start formcentral (required by replybot for form lookups)
  const formcentralEnv: Record<string, string> = {
    CHATBASE_DATABASE: 'chatroach',
    CHATBASE_HOST: 'cockroach',
    CHATBASE_PORT: '26257',
    CHATBASE_USER: 'chatroach',
    CHATBASE_MAX_CONNECTIONS: '1',
    PORT: '80',
  };

  const formcentral = await new GenericContainer(formcentralImageName)
    .withNetwork(network)
    .withNetworkAliases('formcentral')
    .withExposedPorts(80)
    .withEnvironment(formcentralEnv)
    .withWaitStrategy(Wait.forHttp('/health', 80))
    .start();
  console.timeEnd('[setup] scribble + redis + formcentral');

  // Start dinersclub (payment processor, consumes vlab-payment topic)
  const dinersclubEnv: Record<string, string> = {
    CACHE_TTL: '1m',
    CACHE_NUM_COUNTERS: '1000',
    CACHE_MAX_COST: '1000',
    CACHE_BUFFER_ITEMS: '64',
    RELOADLY_SANDBOX: 'true',
    BOTSERVER_URL: 'http://botserver/synthetic',
    CHATBASE_DATABASE: 'chatroach',
    CHATBASE_HOST: 'cockroach',
    CHATBASE_PORT: '26257',
    CHATBASE_USER: 'chatroach',
    CHATBASE_MAX_CONNECTIONS: '1',
    KAFKA_BROKERS: 'redpanda:9092',
    KAFKA_POLL_TIMEOUT: '2s',
    KAFKA_TOPIC: 'vlab-payment',
    KAFKA_GROUP: 'dinersclub-test',
    DINERSCLUB_BATCH_SIZE: '4',
    DINERSCLUB_RETRY_BOTSERVER: '30s',
    DINERSCLUB_RETRY_PROVIDER: '30s',
    DINERSCLUB_POOL_SIZE: '1',
    DINERSCLUB_PROVIDERS: 'fake',
  };

  const dinersclub = await new GenericContainer(dinersclubImageName)
    .withNetwork(network)
    .withNetworkAliases('dinersclub')
    .withEnvironment(dinersclubEnv)
    .start();

  // Load replybot env from YAML and apply overrides
  console.time('[setup] replybot + botserver + facebot');
  const replybotEnv = loadKubeEnv(
    path.join(repoRoot, 'replybot/kube-dev/dev.yaml')
  );
  replybotEnv.CHATBASE_HOST = 'cockroach';
  replybotEnv.KAFKA_BROKERS = 'redpanda:9092';
  replybotEnv.BOTSPINE_KAFKA_BROKERS = 'redpanda:9092';
  replybotEnv.FACEBOOK_GRAPH_URL = 'http://facebot:3000';
  replybotEnv.BOTSERVER_URL = 'http://botserver';
  replybotEnv.FORMCENTRAL_URL = 'http://formcentral';
  replybotEnv.REDIS_HOST = 'redis';
  replybotEnv.REDIS_PORT = '6379';
  replybotEnv.AUTH0_DASHBOARD_SECRET = testEnv.AUTH0_DASHBOARD_SECRET || 'test';

  // Ensure NUM_SPINES is set
  if (!replybotEnv.NUM_SPINES) {
    replybotEnv.NUM_SPINES = '6';
  }

  // Ensure VLAB_CHAT_LOG_TOPIC is set
  if (!replybotEnv.VLAB_CHAT_LOG_TOPIC) {
    replybotEnv.VLAB_CHAT_LOG_TOPIC = 'vlab-chat-log';
  }

  // Disable SSL for pg connections (cockroach runs insecure)
  replybotEnv.PGSSLMODE = 'disable';
  replybotEnv.PGCONNECT_TIMEOUT = '5';

  // Start replybot
  const replybot = await new GenericContainer(replybotImageName)
    .withNetwork(network)
    .withNetworkAliases('replybot')
    .withEnvironment(replybotEnv)
    .withWaitStrategy(Wait.forLogMessage('producer ready'))
    .start();

  // Start message-worker (consumes commands topic, sends to facebot)
  const messageWorkerEnv: Record<string, string> = {
    KAFKA_BROKERS: 'redpanda:9092',
    KAFKA_COMMAND_TOPIC: 'commands',
    KAFKA_EVENT_TOPIC: 'chat-events',
    KAFKA_GROUP_ID: 'message-worker-test',
    KAFKA_AUTO_OFFSET_RESET: 'earliest',
    DATABASE_URL: `postgresql://chatroach@cockroach:26257/chatroach?sslmode=disable`,
    BOTSERVER_URL: 'http://botserver',
    FACEBOOK_GRAPH_URL: 'http://facebot:3000',
    NUM_WORKERS: '1',
    TOKEN_CACHE_TTL: '300',
  };

  const messageWorker = await new GenericContainer(messageWorkerImageName)
    .withNetwork(network)
    .withNetworkAliases('message-worker')
    .withEnvironment(messageWorkerEnv)
    .withWaitStrategy(Wait.forLogMessage('starting message processing'))
    .start();

  // Hermes reads the same env var names as the old botserver
  // (BOTSERVER_EVENT_TOPIC, VERIFY_TOKEN, KAFKA_BROKERS, PORT), so we keep
  // loading the botserver deployment YAML for its values.
  const botserverEnv = loadKubeEnv(
    path.join(repoRoot, 'botserver/kube/deployment.yaml')
  );
  botserverEnv.PORT = '80';
  botserverEnv.KAFKA_BROKERS = 'redpanda:9092';

  // Merge in test env for secrets
  const botserverEnvWithSecrets = { ...testEnv, ...botserverEnv };

  // Start Hermes under the `botserver` network alias so every downstream
  // service (replybot, dean, dinersclub) keeps resolving http://botserver/*.
  const botserver = await new GenericContainer(hermesImageName)
    .withNetwork(network)
    .withNetworkAliases('botserver')
    .withExposedPorts(80)
    .withEnvironment(botserverEnvWithSecrets)
    .withWaitStrategy(Wait.forHttp('/health', 80))
    .start();

  // Start facebot receiver
  const facebot = await new GenericContainer(faceBotImageName)
    .withNetwork(network)
    .withNetworkAliases('facebot')
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  // Get facebot mapped port
  const facebotPort = facebot.getMappedPort(3000);
  const facebotUrl = `http://localhost:${facebotPort}`;

  // Get botserver mapped port
  const botserverPort = botserver.getMappedPort(80);
  const botserverUrl = `http://localhost:${botserverPort}`;

  // Load dean env from YAML
  const deanEnv = loadKubeEnv(path.join(repoRoot, 'dean/kube-dev/dev.yaml'));
  deanEnv.CHATBASE_HOST = 'cockroach';
  deanEnv.BOTSERVER_URL = 'http://botserver/synthetic';
  deanEnv.KAFKA_BROKERS = 'redpanda:9092';
  // Override production intervals for testcontainers (on-demand dean)
  deanEnv.DEAN_RESPONDING_GRACE = '1s';
  deanEnv.DEAN_RESPONDING_INTERVAL = '1m';
  deanEnv.DEAN_ERROR_INTERVAL = '1m';
  deanEnv.DEAN_BLOCKED_INTERVAL = '1m';
  deanEnv.DEAN_PAYMENT_GRACE = '1s';
  deanEnv.DEAN_PAYMENT_INTERVAL = '1m';
  // Widen followup window for testcontainers (on-demand dean)
  deanEnv.DEAN_FOLLOWUP_MIN = '0s';
  deanEnv.DEAN_FOLLOWUP_MAX = '30s';
  console.timeEnd('[setup] replybot + botserver + facebot');
  console.log(`[setup] total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  return {
    network,
    cockroach,
    redpanda,
    redis,
    scribbleStates,
    scribbleResponses,
    formcentral,
    dinersclub,
    botserver,
    replybot,
    messageWorker,
    facebot,
    facebotUrl,
    botserverUrl,
    chatbaseConnString,
    deanImage: deanImageName,
    deanEnv,
  };
}

/**
 * Stop the full testcontainers stack
 */
export async function stopStack(stack: Stack): Promise<void> {
  await Promise.all([
    stack.facebot.stop(),
    stack.botserver.stop(),
    stack.formcentral.stop(),
    stack.dinersclub.stop(),
    stack.messageWorker.stop(),
    stack.replybot.stop(),
    stack.scribbleStates.stop(),
    stack.scribbleResponses.stop(),
    stack.redis.stop(),
    stack.redpanda.stop(),
    stack.cockroach.stop(),
  ]);
  await stack.network.stop();
}
