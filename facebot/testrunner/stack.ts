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
  scribbleMessages: StartedTestContainer;
  scribbleChatlLog: StartedTestContainer;
  formcentral: StartedTestContainer;
  dinersclub: StartedTestContainer;
  botserver: StartedTestContainer;
  replybot: StartedTestContainer;
  messageWorker: StartedTestContainer;
  facebot: StartedTestContainer;
  facebotUrl: string;
  botserverUrl: string;
  chatbaseConnString: string;
  redisPort: number;
  redisUrl: string;
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
  // A10. Kafka is deliberately NOT exposed to the host.
  //
  // Redpanda advertises PLAINTEXT://redpanda:9092, which only resolves inside the
  // docker network: a host client connects, gets told to talk to `redpanda:9092`,
  // and fails. Fixing that properly needs two listeners with an external
  // advertised address, and the external port is not known until after the
  // container starts -- a chicken-and-egg that testcontainers solves only with
  // fixed host ports or a restart-with-rewritten-config dance.
  //
  // Not worth it: the one test that wants Kafka (B1-4, "both conversations are
  // produced under the same user-id key") can consume from INSIDE the network via
  // `rpk`, which needs no external listener at all. Use consumeTopic() below.
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

  // Load scribble env from YAML and apply overrides.
  // A8: Added scribble-messages and scribble-chat-log sinks. Without these, the
  // event log (chatroach.messages) is never populated, so replay tests would pass
  // vacuously. See planning/conversation-identity-test-plan.md §0.1.
  console.time('[setup] scribble + redis + formcentral');
  const scribbleStatesEnv = loadKubeEnv(
    path.join(repoRoot, 'scribble/kube-dev/states.yaml')
  );
  scribbleStatesEnv.KAFKA_BROKERS = 'redpanda:9092';

  const scribbleResponsesEnv = loadKubeEnv(
    path.join(repoRoot, 'scribble/kube-dev/responses.yaml')
  );
  scribbleResponsesEnv.KAFKA_BROKERS = 'redpanda:9092';

  const scribbleMessagesEnv = loadKubeEnv(
    path.join(repoRoot, 'scribble/kube-dev/messages.yaml')
  );
  scribbleMessagesEnv.KAFKA_BROKERS = 'redpanda:9092';

  const scribbleChatlLogEnv = loadKubeEnv(
    path.join(repoRoot, 'scribble/kube-dev/chat-log.yaml')
  );
  scribbleChatlLogEnv.KAFKA_BROKERS = 'redpanda:9092';

  const [scribbleStates, scribbleResponses, scribbleMessages, scribbleChatlLog] = await Promise.all([
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
    new GenericContainer(scribbleImageName)
      .withNetwork(network)
      .withNetworkAliases('scribble-messages')
      .withEnvironment(scribbleMessagesEnv)
      .withWaitStrategy(Wait.forLogMessage(/Scribble messages ready/))
      .start(),
    new GenericContainer(scribbleImageName)
      .withNetwork(network)
      .withNetworkAliases('scribble-chat-log')
      .withEnvironment(scribbleChatlLogEnv)
      .withWaitStrategy(Wait.forLogMessage(/Scribble chat-log ready/))
      .start(),
  ]);

  // Start redis (required by replybot for state locking).
  // A9: Expose Redis port so tests can connect from host for direct key inspection
  // (e.g., asserting cache shape or that certain operations never ran).
  const redis = await new GenericContainer('redis:7-alpine')
    .withNetwork(network)
    .withNetworkAliases('redis')
    .withExposedPorts(6379)
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

  // THE RESET SHORTCODE. `replybot/kube-dev/dev.yaml` does not set it, while
  // `devops/values/{staging,production}.yaml` both set it to "reset" -- so a
  // production code path was UNREACHABLE in the harness and nobody noticed.
  //
  // It is the only referral branch that sets `state_json.pointer`
  // (machine.js, REFERRAL -> action RESET), and therefore the only way to make
  // `states.message_pointer` non-NULL (a computed column, migrations/04-pointers.sql).
  // `message_pointer` is the truncation checkpoint that §7.5's replay JOIN reads,
  // so with the var unset the whole pointer half of §7.5 -- B8-2's subject -- could
  // not be exercised at all. See RESET_SHORTCODE in test.tc.ts.
  if (!replybotEnv.REPLYBOT_RESET_SHORTCODE) {
    replybotEnv.REPLYBOT_RESET_SHORTCODE = 'reset';
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
    WHATSAPP_GRAPH_URL: 'http://facebot:3000',
    NUM_WORKERS: '1',
    TOKEN_CACHE_TTL: '300',
    // Media handle layer (planning/media-abstraction.md §8.5). This DEFAULTS TO
    // OFF in message-worker/config.go because the feature ships dark in
    // production. It must be ON here or every media resolution test silently
    // passes by sending everything by URL — a handle miss is not an error, it is
    // the designed fallback, so the suite would look green while resolution was
    // never exercised at all.
    MEDIA_HANDLE_USE: 'true',
    // Expiry margin. The seeded WhatsApp handle expires 30 days out, so any
    // small margin keeps it usable; pinning it here stops a future default
    // change from quietly turning the by-id tests into by-url tests.
    MEDIA_HANDLE_MARGIN: '1h',
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

  // A9: Get Redis mapped port for direct host connection (tests read cache shape).
  // A10: Get Redpanda mapped port for host-side Kafka topic consumption.
  const redisPort = redis.getMappedPort(6379);
  const redisUrl = `redis://localhost:${redisPort}`;

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
    scribbleMessages,
    scribbleChatlLog,
    formcentral,
    dinersclub,
    botserver,
    replybot,
    messageWorker,
    facebot,
    facebotUrl,
    botserverUrl,
    chatbaseConnString,
    redisPort,
    redisUrl,
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
    stack.scribbleMessages.stop(),
    stack.scribbleChatlLog.stop(),
    stack.redis.stop(),
    stack.redpanda.stop(),
    stack.cockroach.stop(),
  ]);
  await stack.network.stop();
}

export interface TopicRecord {
  partition: number;
  offset: number;
  key: string | null;
  value: any;
}

/** Per-partition offsets of a topic: `{ [partition]: offset }`. */
export type TopicOffsets = Record<number, number>;

/**
 * The current high watermark of every partition of `topic` — i.e. the offset the
 * NEXT record produced to that partition will get.
 *
 * This is the "bookmark" half of the consumeTopic API: snapshot it before the
 * activity you care about, hand it back as `{ from }`, and you read exactly the
 * records your own test produced and nothing else. See consumeTopic below for
 * why that matters.
 *
 * Parses `rpk topic describe <topic> -p`, which prints a fixed-width table:
 *
 *     PARTITION  LEADER  EPOCH  REPLICAS  LOG-START-OFFSET  HIGH-WATERMARK
 *     0          0       1      [0]       0                 556
 *
 * Column position is read from the header rather than hard-coded, because
 * `--stable` (not passed here) inserts an extra column.
 */
export async function topicEndOffsets(stack: Stack, topic: string): Promise<TopicOffsets> {
  const res = await stack.redpanda.exec(['rpk', 'topic', 'describe', topic, '-p']);
  if (res.exitCode !== 0) {
    throw new Error(`topicEndOffsets(${topic}) failed (exit ${res.exitCode}): ${res.output}`);
  }

  const lines = res.output.split('\n').map(l => l.trim()).filter(l => l !== '');
  const headerIdx = lines.findIndex(l => l.startsWith('PARTITION') && l.includes('HIGH-WATERMARK'));
  if (headerIdx === -1) {
    throw new Error(
      `topicEndOffsets(${topic}): no partition table in \`rpk topic describe -p\` output. ` +
      `Does the topic exist? Got:\n${res.output}`,
    );
  }

  const header = lines[headerIdx].split(/\s+/);
  const partitionCol = header.indexOf('PARTITION');
  const hwmCol = header.indexOf('HIGH-WATERMARK');

  const offsets: TopicOffsets = {};
  for (const line of lines.slice(headerIdx + 1)) {
    const cols = line.split(/\s+/);
    if (cols.length <= hwmCol) continue;
    const partition = Number(cols[partitionCol]);
    const hwm = Number(cols[hwmCol]);
    if (Number.isNaN(partition) || Number.isNaN(hwm)) continue;
    offsets[partition] = hwm;
  }

  if (Object.keys(offsets).length === 0) {
    throw new Error(`topicEndOffsets(${topic}): parsed no partitions from:\n${res.output}`);
  }
  return offsets;
}

/**
 * Consume records of a Kafka topic from INSIDE the docker network, via redpanda's
 * own `rpk`.
 *
 * Why not a host-side Kafka client: see the A10 note next to the redpanda
 * container. The broker advertises an address that only resolves inside the
 * network, so an external client cannot follow the redirect. Running `rpk` in the
 * container sidesteps the whole problem.
 *
 * WHICH RECORDS. This used to be `--offset start --num 500`, i.e. the OLDEST 500
 * records of the topic. That is a bug that gets worse with every test added:
 * `chat-events` was measured at a high watermark of 556 and climbing, so a test
 * running late in the suite produced its events well outside that window, found
 * none of them, and failed as a bare 120s mocha timeout with nothing pointing at
 * the cause. Scale-dependent, silent, and guaranteed to come back.
 *
 * Two modes, and both are bounded by the topic's CURRENT end, so neither can hang:
 *
 *   - `{ from }`  — a `topicEndOffsets()` snapshot taken before the activity under
 *                   test. Reads exactly what was produced since. PREFER THIS: its
 *                   cost is proportional to what your test did, not to the size of
 *                   the suite, so it stays correct however much the suite grows.
 *   - `{ newest }` — the last N records. A fallback for when there was no chance to
 *                   take a bookmark first.
 *
 * Every read resolves to an explicit `<start>:end` range per partition. That is
 * deliberate rather than using rpk's own relative `-o -N`: `-o -N --num N` blocks
 * forever when the topic holds fewer than N records (it waits for the rest), which
 * would trade the old silent-empty failure for a silent-hang one.
 *
 * `value` is parsed as JSON when possible — it is JSON for every topic in this
 * stack — and left as a string otherwise.
 */
export async function consumeTopic(
  stack: Stack,
  topic: string,
  opts: { from?: TopicOffsets; newest?: number } = {},
): Promise<TopicRecord[]> {
  const ends = await topicEndOffsets(stack, topic);
  const newest = opts.newest ?? 500;

  const records: TopicRecord[] = [];

  for (const partition of Object.keys(ends).map(Number).sort((a, b) => a - b)) {
    const end = ends[partition];
    const start = opts.from && opts.from[partition] !== undefined
      ? opts.from[partition]
      : Math.max(0, end - newest);

    if (start >= end) continue; // nothing produced in the window

    const res = await stack.redpanda.exec([
      'rpk', 'topic', 'consume', topic,
      '--partitions', String(partition),
      '--offset', `${start}:end`,
      '--format', '%p\t%o\t%k\t%v\n',
    ]);

    if (res.exitCode !== 0) {
      throw new Error(
        `consumeTopic(${topic}) partition ${partition} [${start}:end] failed ` +
        `(exit ${res.exitCode}): ${res.output}`,
      );
    }

    for (const line of res.output.split('\n')) {
      if (line.trim() === '') continue;
      const parts = line.split('\t');
      if (parts.length < 4) continue;
      const [p, o, k, ...rest] = parts;
      const raw = rest.join('\t');
      let value: any = raw;
      try { value = JSON.parse(raw); } catch { /* leave as string */ }
      records.push({
        partition: Number(p),
        offset: Number(o),
        key: k === '' ? null : k,
        value,
      });
    }
  }

  return records;
}
