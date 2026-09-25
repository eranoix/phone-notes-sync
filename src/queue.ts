import { backoffDelay, sleep } from './backoff.js';

/**
 * Thrown by a task that must not be retried: a message that does not parse
 * will not parse on the fourth attempt either, and retrying it only delays
 * everything queued behind it.
 */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}

export type TaskOutcome<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: Error; attempts: number; permanent: boolean };

export interface QueueOptions {
  /** How many tasks may run at the same time. */
  concurrency: number;
  /** Total tries per task, the first one included. */
  maxAttempts: number;
  /** Tasks queued or running beyond which `waitForCapacity` blocks the producer. */
  highWaterMark?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

interface Entry {
  run: () => Promise<void>;
}

/**
 * A small work queue with bounded concurrency, retries for transient errors
 * and backpressure towards the producer.
 *
 * The producer here is an IMAP FETCH streaming message sources. Without a
 * bound, a first sync of a large mailbox would open as many database writes
 * as there are messages; with it, at most `concurrency` run at once and the
 * FETCH loop pauses (via `waitForCapacity`) while the backlog is full.
 */
export class WorkQueue {
  private readonly waiting: Entry[] = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];
  private capacityWaiters: Array<() => void> = [];
  private readonly highWaterMark: number;

  constructor(private readonly options: QueueOptions) {
    if (options.concurrency < 1) throw new RangeError('concurrency must be at least 1');
    this.highWaterMark = options.highWaterMark ?? options.concurrency * 4;
  }

  get size(): number {
    return this.waiting.length + this.running;
  }

  /** Enqueue a task; the promise settles with its outcome and never rejects. */
  push<T>(task: (attempt: number) => Promise<T>): Promise<TaskOutcome<T>> {
    return new Promise((resolve) => {
      this.waiting.push({
        run: async () => resolve(await this.execute(task)),
      });
      this.pump();
    });
  }

  /** Resolves once the backlog is below the high-water mark. */
  async waitForCapacity(): Promise<void> {
    while (this.size >= this.highWaterMark) {
      await new Promise<void>((r) => this.capacityWaiters.push(r));
    }
  }

  /** Resolves when nothing is queued or running. */
  onIdle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump(): void {
    while (this.running < this.options.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      this.running++;
      void entry.run().finally(() => {
        this.running--;
        this.notify();
        this.pump();
      });
    }
  }

  private notify(): void {
    if (this.size < this.highWaterMark) {
      const waiters = this.capacityWaiters;
      this.capacityWaiters = [];
      waiters.forEach((w) => w());
    }
    if (this.size === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private async execute<T>(task: (attempt: number) => Promise<T>): Promise<TaskOutcome<T>> {
    const { maxAttempts, retryBaseMs = 200, retryMaxMs = 5_000 } = this.options;
    let lastError: Error = new Error('task never ran');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return { ok: true, value: await task(attempt), attempts: attempt };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError instanceof PermanentError) {
          return { ok: false, error: lastError, attempts: attempt, permanent: true };
        }
        if (attempt < maxAttempts) {
          await sleep(backoffDelay(attempt - 1, { baseMs: retryBaseMs, maxMs: retryMaxMs }));
        }
      }
    }
    return { ok: false, error: lastError, attempts: maxAttempts, permanent: false };
  }
}
