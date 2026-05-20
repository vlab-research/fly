/// <reference types="node" />
import { GenericContainer, StartedNetwork, Wait } from 'testcontainers';

/**
 * Trigger dean as a one-shot container to process a specific query type
 * Dean reads DB state, applies business logic, and exits when done
 */
export async function triggerDean(
  network: StartedNetwork,
  deanImage: string,
  baseEnv: Record<string, string>,
  queries: string
): Promise<void> {
  const env = { ...baseEnv, DEAN_QUERIES: queries };

  // Dean is one-shot: it processes, logs completion, and exits.
  // Wait.forLogMessage fires when dean logs its completion line, then we stop.
  const container = await new GenericContainer(deanImage)
    .withNetwork(network)
    .withEnvironment(env)
    .withWaitStrategy(Wait.forLogMessage('Dean successfully sent'))
    .start();

  await container.stop();
}
