export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export function backoffDelay(
  attempt: number,
  { baseMs, maxMs }: BackoffOptions,
  random: () => number = Math.random,
): number {
  if (attempt < 0 || !Number.isFinite(attempt)) attempt = 0;
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
