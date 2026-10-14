import { availableParallelism } from 'node:os';

/** How many cases run at once by default: one per CPU core. */
export function defaultConcurrency(): number {
  return availableParallelism();
}

/**
 * Calls `fn` on every item with at most `concurrency` calls running at once, and returns the
 * results in input order. Each call also gets its worker slot (0 to concurrency - 1), which no
 * other running call holds, e.g. to reuse a scratch directory per worker.
 *
 * After a call fails, no new item starts; the promise rejects with that error once the calls
 * already running have settled.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number, slot: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`The number of workers must be a positive integer, got ${concurrency}.`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (slot: number) => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index, slot);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, (_, slot) => worker(slot)));
  if (failure !== undefined) throw failure.error;
  return results;
}
