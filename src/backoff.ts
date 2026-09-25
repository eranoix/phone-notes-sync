/**
 * Exponential backoff with "equal jitter": half of the delay is fixed, the
 * other half is random. The fixed half guarantees we actually back off; the
 * random half keeps a fleet of clients that lost the server at the same
 * moment from reconnecting in lockstep and knocking it over again.
 */
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
  // 2^attempt overflows to Infinity long before it matters; the cap keeps it sane.
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}

/** A sleep that an AbortSignal can cut short, so shutdown never waits out a backoff. */
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
