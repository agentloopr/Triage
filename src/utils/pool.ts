/**
 * Bounded-concurrency map. Used by both categorization passes, which fan out one model call per item.
 */
export async function runPool(n: number, limit: number, worker: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const inFlight: Promise<void>[] = [];

  const launch = (): void => {
    const i = next++;
    const p = worker(i).finally(() => {
      const idx = inFlight.indexOf(p);
      if (idx !== -1) inFlight.splice(idx, 1);
    });
    inFlight.push(p);
  };

  while (next < n) {
    while (inFlight.length < Math.max(1, limit) && next < n) launch();
    await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
}

/**
 * Warm one call, then fan the rest out.
 *
 * The passes that use this share a very large prompt prefix (the whole board snapshot) across every
 * call. Firing all N at once defeats the provider's prefix cache entirely, because it is only warm
 * after the first call completes — so the first call is deliberately serialized.
 */
export async function runWarmedPool(
  n: number,
  limit: number,
  worker: (i: number) => Promise<void>,
  opts: { warmFirst?: boolean; warmDelayMs?: number } = {}
): Promise<void> {
  if (n === 0) return;
  const warmFirst = opts.warmFirst ?? true;
  const warmDelayMs = Math.max(0, opts.warmDelayMs ?? 0);

  if (n > 1 && warmFirst) {
    await worker(0);
    if (warmDelayMs > 0) await new Promise((r) => setTimeout(r, warmDelayMs));
    await runPool(n - 1, limit, (k) => worker(k + 1));
  } else {
    await runPool(n, limit, worker);
  }
}
