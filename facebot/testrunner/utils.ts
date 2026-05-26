/// <reference lib="dom" />
export const snooze = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeout: number = 30000,
  interval: number = 200
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await snooze(interval);
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}