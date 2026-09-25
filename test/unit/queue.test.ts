import { describe, expect, it } from 'vitest';
import { backoffDelay } from '../../src/backoff.js';
import { PermanentError, WorkQueue } from '../../src/queue.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('WorkQueue', () => {
  it('never runs more than `concurrency` tasks at once', async () => {
    const q = new WorkQueue({ concurrency: 3, maxAttempts: 1 });
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        q.push(async () => {
          running++;
          peak = Math.max(peak, running);
          await tick();
          running--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results.map((r) => (r.ok ? r.value : -1))).toEqual([...Array(12).keys()]);
  });

  it('retries transient errors and reports the attempts', async () => {
    const q = new WorkQueue({ concurrency: 1, maxAttempts: 4, retryBaseMs: 1, retryMaxMs: 2 });
    let calls = 0;
    const out = await q.push(async () => {
      if (++calls < 3) throw new Error('connection reset');
      return 'stored';
    });
    expect(out).toEqual({ ok: true, value: 'stored', attempts: 3 });
  });

  it('gives up after maxAttempts', async () => {
    const q = new WorkQueue({ concurrency: 1, maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 1 });
    const out = await q.push(async () => {
      throw new Error('still down');
    });
    expect(out).toMatchObject({ ok: false, attempts: 2, permanent: false });
  });

  it('does not retry a PermanentError', async () => {
    const q = new WorkQueue({ concurrency: 1, maxAttempts: 5, retryBaseMs: 1 });
    let calls = 0;
    const out = await q.push(async () => {
      calls++;
      throw new PermanentError('not a note');
    });
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: false, permanent: true, attempts: 1 });
  });

  it('applies backpressure at the high-water mark', async () => {
    const q = new WorkQueue({ concurrency: 1, maxAttempts: 1, highWaterMark: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    void q.push(() => gate);
    void q.push(async () => undefined);
    let passed = false;
    const waiting = q.waitForCapacity().then(() => (passed = true));
    await tick();
    expect(passed).toBe(false);
    release();
    await waiting;
    expect(passed).toBe(true);
    await q.onIdle();
    expect(q.size).toBe(0);
  });
});

describe('backoffDelay', () => {
  const opts = { baseMs: 1000, maxMs: 60_000 };
  it('doubles, stays within [ceiling/2, ceiling], and caps', () => {
    expect(backoffDelay(0, opts, () => 0)).toBe(500);
    expect(backoffDelay(0, opts, () => 1)).toBe(1000);
    expect(backoffDelay(3, opts, () => 0)).toBe(4000);
    expect(backoffDelay(3, opts, () => 1)).toBe(8000);
    expect(backoffDelay(50, opts, () => 1)).toBe(60_000);
    expect(backoffDelay(1e9, opts, () => 0)).toBe(30_000);
  });
});
