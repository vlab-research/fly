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
  scribbleStates: StartedTestContainer;
  scribbleResponses: StartedTestContainer;
  botserver: StartedTestContainer;
  replybot: StartedTestContainer;
  facebot: StartedTestContainer;
  facebotUrl: string;
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

  // Create network
  const network = await new Network().start();

  // Load env vars from test env and YAMLs
  const testEnv = loadTestEnv();

  // Build all images in parallel with explicit names
  const botserverImageName = 'botserver:test';
  const replybotImageName = 'replybot:test';
  const scribbleImageName = 'scribble:test';
  const faceBotImageName = 'facebot:test';
  const deanImageName = 'dean:test';

  await Promise.all([
    GenericContainer.fromDockerfile(path.join(repoRoot, 'botserver')).build(botserverImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'replybot')).build(replybotImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'scribble')).build(scribbleImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'facebot/receiver')).build(faceBotImageName),
    GenericContainer.fromDockerfile(path.join(repoRoot, 'dean')).build(deanImageName),
  ]);

  // Start cockroach
  const cockroach = await new GenericContainer('cockroachdb/cockroach:v24.1.0')
    .withNetwork(network)
    .withNetworkAliases('cockroach')
    .withExposedPorts(26257)
    .withCommand(['start-single-node', '--insecure'])
    .withWaitStrategy(Wait.forLogMessage('initialized new cluster'))
    .start();

  // Load schema and execute it in cockroach
  const schemaPath = path.join(repoRoot, 'facebot/testrunner/schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  try {
    await cockroach.exec([
      './cockroach',
      'sql',
      '--insecure',
      '--host=localhost:26257',
      '-e',
      schema,
    ]);
  } catch (e) {
    console.error('Failed to initialize schema in cockroach:', e);
    throw e;
  }

  // Start redpanda
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
    ]);
  } catch (e) {
    // Topics might already exist, continue
    console.log('Kafka topics creation (may have already existed):', e);
  }

  // Load scribble env from YAML and apply overrides
  const scribbleStatesEnv = loadKubeEnv(
    path.join(repoRoot, 'scribble/kube-dev/states.yaml')
  );
  scribbleStatesEnv.CHATBASE_HOST = 'cockroach';
  scribbleStatesEnv.KAFKA_BROKERS = 'redpanda:9092';

  const scribbleResponsesEnv = loadKubeEnv(
    path.join(repoRoot, 'scribble/kube-dev/responses.yaml')
  );
  scribbleResponsesEnv.CHATBASE_HOST = 'cockroach';
  scribbleResponsesEnv.KAFKA_BROKERS = 'redpanda:9092';

  // Start scribble-states and scribble-responses in parallel (after cockroach ready)
  // Scribble is a pure Kafka consumer with no listening ports — no wait strategy needed
  const [scribbleStates, scribbleResponses] = await Promise.all([
    new GenericContainer(scribbleImageName)
      .withNetwork(network)
      .withEnvironment(scribbleStatesEnv)
      .start(),
    new GenericContainer(scribbleImageName)
      .withNetwork(network)
      .withEnvironment(scribbleResponsesEnv)
      .start(),
  ]);

  // Load replybot env from YAML and apply overrides
  const replybotEnv = loadKubeEnv(
    path.join(repoRoot, 'replybot/kube-dev/dev.yaml')
  );
  replybotEnv.CHATBASE_HOST = 'cockroach';
  replybotEnv.KAFKA_BROKERS = 'redpanda:9092';
  replybotEnv.BOTSPINE_KAFKA_BROKERS = 'redpanda:9092';
  replybotEnv.FACEBOOK_GRAPH_URL = 'http://facebot';
  replybotEnv.BOTSERVER_URL = 'http://botserver';

  // Ensure NUM_SPINES is set
  if (!replybotEnv.NUM_SPINES) {
    replybotEnv.NUM_SPINES = '6';
  }

  // Ensure VLAB_CHAT_LOG_TOPIC is set
  if (!replybotEnv.VLAB_CHAT_LOG_TOPIC) {
    replybotEnv.VLAB_CHAT_LOG_TOPIC = 'vlab-chat-log';
  }

  // Start replybot
  const replybot = await new GenericContainer(replybotImageName)
    .withNetwork(network)
    .withNetworkAliases('replybot')
    .withEnvironment(replybotEnv)
    .withWaitStrategy(Wait.forLogMessage('producer ready'))
    .start();

  // Load botserver env from YAML and apply overrides
  const botserverEnv = loadKubeEnv(
    path.join(repoRoot, 'botserver/kube/deployment.yaml')
  );
  botserverEnv.PORT = '80';
  botserverEnv.KAFKA_BROKERS = 'redpanda:9092';

  // Merge in test env for secrets
  const botserverEnvWithSecrets = { ...testEnv, ...botserverEnv };

  // Start botserver
  const botserver = await new GenericContainer(botserverImageName)
    .withNetwork(network)
    .withNetworkAliases('botserver')
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

  // Get cockroach mapped port for direct connection
  const cockroachPort = cockroach.getMappedPort(26257);
  const chatbaseConnString = `postgresql://chatroach@localhost:${cockroachPort}/chatroach?sslmode=disable`;

  // Load dean env from YAML
  const deanEnv = loadKubeEnv(path.join(repoRoot, 'dean/kube-dev/dev.yaml'));
  deanEnv.CHATBASE_HOST = 'cockroach';
  deanEnv.BOTSERVER_URL = 'http://botserver/synthetic';
  deanEnv.KAFKA_BROKERS = 'redpanda:9092';

  return {
    network,
    cockroach,
    redpanda,
    scribbleStates,
    scribbleResponses,
    botserver,
    replybot,
    facebot,
    facebotUrl,
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
    stack.replybot.stop(),
    stack.scribbleStates.stop(),
    stack.scribbleResponses.stop(),
    stack.redpanda.stop(),
    stack.cockroach.stop(),
  ]);
  await stack.network.stop();
}
