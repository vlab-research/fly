"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopStack = exports.startStack = exports.loadTestEnv = exports.loadKubeEnv = void 0;
/// <reference types="node" />
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const js_yaml_1 = __importDefault(require("js-yaml"));
const dotenv_1 = __importDefault(require("dotenv"));
const testcontainers_1 = require("testcontainers");
/**
 * Parse k8s deployment YAML and extract env vars from spec.template.spec.containers[0].env
 * Only includes entries with 'value:' (skips valueFrom: secret refs)
 */
function loadKubeEnv(filePath) {
    var _a, _b, _c, _d, _e;
    const fileContent = fs_1.default.readFileSync(filePath, 'utf8');
    const deployment = js_yaml_1.default.load(fileContent);
    if (!((_e = (_d = (_c = (_b = (_a = deployment.spec) === null || _a === void 0 ? void 0 : _a.template) === null || _b === void 0 ? void 0 : _b.spec) === null || _c === void 0 ? void 0 : _c.containers) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.env)) {
        return {};
    }
    const env = {};
    const envArray = deployment.spec.template.spec.containers[0].env;
    for (const envVar of envArray) {
        if (envVar.value !== undefined) {
            env[envVar.name] = envVar.value;
        }
    }
    return env;
}
exports.loadKubeEnv = loadKubeEnv;
/**
 * Parse dotenv file (like devops/testing/.test-env)
 */
function loadTestEnv() {
    const testEnvPath = path_1.default.resolve(__dirname, '../../../devops/testing/.test-env');
    const content = fs_1.default.readFileSync(testEnvPath, 'utf8');
    return dotenv_1.default.parse(content);
}
exports.loadTestEnv = loadTestEnv;
/**
 * Start the full testcontainers stack
 */
async function startStack() {
    // Resolve repo root: __dirname is .../facebot/testrunner/dist at runtime
    const repoRoot = path_1.default.resolve(__dirname, '../../../');
    const t0 = Date.now();
    // Create network
    console.time('[setup] network');
    const network = await new testcontainers_1.Network().start();
    console.timeEnd('[setup] network');
    // Load env vars from test env and YAMLs
    const testEnv = loadTestEnv();
    // Build all images in parallel with explicit names
    const botserverImageName = 'botserver:test';
    console.time('[setup] image builds');
    const replybotImageName = 'replybot:test';
    const scribbleImageName = 'scribble:test';
    const faceBotImageName = 'facebot:test';
    const deanImageName = 'dean:test';
    const formcentralImageName = 'formcentral:test';
    const dinersclubImageName = 'dinersclub:test';
    await Promise.all([
        testcontainers_1.GenericContainer.fromDockerfile(path_1.default.join(repoRoot, 'botserver')).build(botserverImageName),
        testcontainers_1.GenericContainer.fromDockerfile(path_1.default.join(repoRoot, 'replybot')).build(replybotImageName),
        testcontainers_1.GenericContainer.fromDockerfile(path_1.default.join(repoRoot, 'scribble')).build(scribbleImageName),
        testcontainers_1.GenericContainer.fromDockerfile(path_1.default.join(repoRoot, 'facebot/receiver')).build(faceBotImageName),
        testcontainers_1.GenericContainer.fromDockerfile(path_1.default.join(repoRoot, 'dean')).build(deanImageName),
        testcontainers_1.GenericContainer.fromDockerfile(path_1.default.join(repoRoot, 'formcentral')).build(formcentralImageName),
        testcontainers_1.GenericContainer.fromDockerfile(path_1.default.join(repoRoot, 'dinersclub')).build(dinersclubImageName),
    ]);
    console.timeEnd('[setup] image builds');
    // Start cockroach
    console.time('[setup] cockroach + migrations');
    const cockroach = await new testcontainers_1.GenericContainer('cockroachdb/cockroach:v24.1.0')
        .withNetwork(network)
        .withNetworkAliases('cockroach')
        .withExposedPorts(26257)
        .withCommand(['start', '--insecure', '--listen-addr=0.0.0.0:26258', '--sql-addr=0.0.0.0:26257', '--join=localhost:26258'])
        .withWaitStrategy(testcontainers_1.Wait.forLogMessage('Node will now attempt to join a running cluster'))
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
    const migrationsDir = path_1.default.join(repoRoot, 'devops/migrations');
    const migrationFiles = fs_1.default.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();
    for (const file of migrationFiles) {
        const migrationPath = path_1.default.join(migrationsDir, file);
        const migration = fs_1.default.readFileSync(migrationPath, 'utf8');
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
    const redpanda = await new testcontainers_1.GenericContainer('redpandadata/redpanda:v23.3.18')
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
        .withWaitStrategy(testcontainers_1.Wait.forLogMessage('Successfully started Redpanda'))
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
    }
    catch (e) {
        // Topics might already exist, continue
        console.log('Kafka topics creation (may have already existed):', e);
    }
    console.timeEnd('[setup] redpanda + topics');
    // Load scribble env from YAML and apply overrides
    console.time('[setup] scribble + redis + formcentral');
    const scribbleStatesEnv = loadKubeEnv(path_1.default.join(repoRoot, 'scribble/kube-dev/states.yaml'));
    scribbleStatesEnv.KAFKA_BROKERS = 'redpanda:9092';
    const scribbleResponsesEnv = loadKubeEnv(path_1.default.join(repoRoot, 'scribble/kube-dev/responses.yaml'));
    scribbleResponsesEnv.KAFKA_BROKERS = 'redpanda:9092';
    const [scribbleStates, scribbleResponses] = await Promise.all([
        new testcontainers_1.GenericContainer(scribbleImageName)
            .withNetwork(network)
            .withNetworkAliases('scribble-states')
            .withEnvironment(scribbleStatesEnv)
            .withWaitStrategy(testcontainers_1.Wait.forLogMessage(/Scribble states ready/))
            .start(),
        new testcontainers_1.GenericContainer(scribbleImageName)
            .withNetwork(network)
            .withNetworkAliases('scribble-responses')
            .withEnvironment(scribbleResponsesEnv)
            .withWaitStrategy(testcontainers_1.Wait.forLogMessage(/Scribble responses ready/))
            .start(),
    ]);
    // Start redis (required by replybot for state locking)
    const redis = await new testcontainers_1.GenericContainer('redis:7-alpine')
        .withNetwork(network)
        .withNetworkAliases('redis')
        .withWaitStrategy(testcontainers_1.Wait.forLogMessage('Ready to accept connections'))
        .start();
    // Start formcentral (required by replybot for form lookups)
    const formcentralEnv = {
        CHATBASE_DATABASE: 'chatroach',
        CHATBASE_HOST: 'cockroach',
        CHATBASE_PORT: '26257',
        CHATBASE_USER: 'chatroach',
        CHATBASE_MAX_CONNECTIONS: '1',
        PORT: '80',
    };
    const formcentral = await new testcontainers_1.GenericContainer(formcentralImageName)
        .withNetwork(network)
        .withNetworkAliases('formcentral')
        .withExposedPorts(80)
        .withEnvironment(formcentralEnv)
        .withWaitStrategy(testcontainers_1.Wait.forHttp('/health', 80))
        .start();
    console.timeEnd('[setup] scribble + redis + formcentral');
    // Start dinersclub (payment processor, consumes vlab-payment topic)
    const dinersclubEnv = {
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
    const dinersclub = await new testcontainers_1.GenericContainer(dinersclubImageName)
        .withNetwork(network)
        .withNetworkAliases('dinersclub')
        .withEnvironment(dinersclubEnv)
        .start();
    // Load replybot env from YAML and apply overrides
    console.time('[setup] replybot + botserver + facebot');
    const replybotEnv = loadKubeEnv(path_1.default.join(repoRoot, 'replybot/kube-dev/dev.yaml'));
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
    // Disable SSL for pg connections (cockroach runs insecure)
    replybotEnv.PGSSLMODE = 'disable';
    replybotEnv.PGCONNECT_TIMEOUT = '5';
    // Start replybot
    const replybot = await new testcontainers_1.GenericContainer(replybotImageName)
        .withNetwork(network)
        .withNetworkAliases('replybot')
        .withEnvironment(replybotEnv)
        .withWaitStrategy(testcontainers_1.Wait.forLogMessage('producer ready'))
        .start();
    // Load botserver env from YAML and apply overrides
    const botserverEnv = loadKubeEnv(path_1.default.join(repoRoot, 'botserver/kube/deployment.yaml'));
    botserverEnv.PORT = '80';
    botserverEnv.KAFKA_BROKERS = 'redpanda:9092';
    // Merge in test env for secrets
    const botserverEnvWithSecrets = { ...testEnv, ...botserverEnv };
    // Start botserver
    const botserver = await new testcontainers_1.GenericContainer(botserverImageName)
        .withNetwork(network)
        .withNetworkAliases('botserver')
        .withExposedPorts(80)
        .withEnvironment(botserverEnvWithSecrets)
        .withWaitStrategy(testcontainers_1.Wait.forHttp('/health', 80))
        .start();
    // Start facebot receiver
    const facebot = await new testcontainers_1.GenericContainer(faceBotImageName)
        .withNetwork(network)
        .withNetworkAliases('facebot')
        .withExposedPorts(3000)
        .withWaitStrategy(testcontainers_1.Wait.forListeningPorts())
        .start();
    // Get facebot mapped port
    const facebotPort = facebot.getMappedPort(3000);
    const facebotUrl = `http://localhost:${facebotPort}`;
    // Get botserver mapped port
    const botserverPort = botserver.getMappedPort(80);
    const botserverUrl = `http://localhost:${botserverPort}`;
    // Load dean env from YAML
    const deanEnv = loadKubeEnv(path_1.default.join(repoRoot, 'dean/kube-dev/dev.yaml'));
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
        facebot,
        facebotUrl,
        botserverUrl,
        chatbaseConnString,
        deanImage: deanImageName,
        deanEnv,
    };
}
exports.startStack = startStack;
/**
 * Stop the full testcontainers stack
 */
async function stopStack(stack) {
    await Promise.all([
        stack.facebot.stop(),
        stack.botserver.stop(),
        stack.formcentral.stop(),
        stack.dinersclub.stop(),
        stack.replybot.stop(),
        stack.scribbleStates.stop(),
        stack.scribbleResponses.stop(),
        stack.redis.stop(),
        stack.redpanda.stop(),
        stack.cockroach.stop(),
    ]);
    await stack.network.stop();
}
exports.stopStack = stopStack;
