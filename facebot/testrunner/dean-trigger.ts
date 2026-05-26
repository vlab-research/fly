/// <reference types="node" />
import { GenericContainer, StartedNetwork } from 'testcontainers';

/**
 * Trigger dean as a one-shot container to process a specific query type.
 * Dean reads DB state, applies business logic, and exits when done.
 */
export async function triggerDean(
  network: StartedNetwork,
  deanImage: string,
  baseEnv: Record<string, string>,
  queries: string
): Promise<void> {
  const env = { ...baseEnv, DEAN_QUERIES: queries };

  const container = await new GenericContainer(deanImage)
    .withNetwork(network)
    .withEnvironment(env)
    .withStartupTimeout(120000)
    .start();

  // Read container logs
  const stream = (await container.logs()) as any;
  let logs = '';
  stream.on('data', (chunk: Buffer) => { logs += chunk.toString(); });

  // Wait for container to exit (dean is one-shot, should exit within seconds)
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      const result = await container.exec(['echo', 'alive']);
      if (result.exitCode !== 0) break;
    } catch {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (logs.trim()) {
    console.log('Dean:', logs.trim());
  }

  await container.stop();
}
