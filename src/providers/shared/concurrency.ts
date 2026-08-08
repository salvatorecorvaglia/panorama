/**
 * Bounded-concurrency iteration, shared by every provider that fetches one
 * package at a time.
 *
 * Registries differ in how much parallelism they tolerate, so the limit is the
 * caller's decision — crates.io wants one request per second, npm is happy with
 * eight in flight.
 */

/** Runs `worker` over `items` with a bounded number in flight. */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
}
