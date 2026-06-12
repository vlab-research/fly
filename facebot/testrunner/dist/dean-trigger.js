"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.triggerDean = void 0;
/// <reference types="node" />
const testcontainers_1 = require("testcontainers");
/**
 * Trigger dean as a one-shot container to process a specific query type.
 * Dean reads DB state, applies business logic, and exits when done.
 */
async function triggerDean(network, deanImage, baseEnv, queries) {
    const env = { ...baseEnv, DEAN_QUERIES: queries };
    const container = await new testcontainers_1.GenericContainer(deanImage)
        .withNetwork(network)
        .withEnvironment(env)
        .withStartupTimeout(120000)
        .start();
    // Read container logs
    const stream = (await container.logs());
    let logs = '';
    stream.on('data', (chunk) => { logs += chunk.toString(); });
    // Wait for container to exit (dean is one-shot, should exit within seconds)
    const start = Date.now();
    while (Date.now() - start < 15000) {
        try {
            const result = await container.exec(['echo', 'alive']);
            if (result.exitCode !== 0)
                break;
        }
        catch (_a) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (logs.trim()) {
        console.log('Dean:', logs.trim());
    }
    await container.stop();
}
exports.triggerDean = triggerDean;
