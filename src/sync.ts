import { EventEmitter } from 'node:events';
import { backoffDelay, type BackoffOptions } from './backoff.js';
import { silentLogger, type Logger } from './log.js';
import { parseNote } from './note.js';
import { WorkQueue } from './queue.js';
import type { NoteStore, UpsertResult } from './store.js';
import {
  advanceWatermark,
  diffUids,
  filterNewUids,
  planSync,
  type SyncPlan,
  type SyncTrigger,
} from './uid-state.js';

export interface MailboxSnapshot {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export interface FetchedMessage {
  uid: number;
  source: Buffer;
}

/** A mailbox opened read-only for one sync pass. */
export interface MailboxSession {
  readonly snapshot: MailboxSnapshot;
  listUids(): Promise<number[]>;
  fetch(range: number[] | { from: number }): AsyncIterable<FetchedMessage>;
  close(): Promise<void>;
}

export interface MailSource {
  open(mailbox: string): Promise<MailboxSession>;
}

export interface PassReport {
  plan: SyncPlan['kind'];
  reason?: string;
  uidValidity: number;
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  failed: number;
  skipped: number;
  lastUid: number;
  ms: number;
}

export interface MailboxSyncOptions {
  mailbox: string;
  store: NoteStore;
  concurrency: number;
  maxAttempts: number;
  log?: Logger;
  /** Retry delay base for transient database errors; tests set it to 0. */
  retryBaseMs?: number;
}

const FETCH_CHUNK = 250;

/**
 * One sync pass over one mailbox: plan from the UID bookkeeping, fetch what
 * is new, parse and upsert through a bounded queue, then reconcile deletions.
 *
 * Fetching happens on the IMAP connection one message at a time (IMAP is a
 * single ordered stream anyway); parsing and the database write, which is
 * where the time goes, run `concurrency` at a time.
 */
export class MailboxSync {
  private readonly log: Logger;
  /**
   * UIDs that will never produce a row: messages that are not notes, and older
   * duplicates of a note that already has a newer version. Remembered per
   * UIDVALIDITY so a full pass does not download them again every time.
   */
  private ignored = new Set<number>();
  private ignoredValidity: number | null = null;

  constructor(private readonly opts: MailboxSyncOptions) {
    this.log = opts.log ?? silentLogger;
  }

  async run(source: MailSource, triggers: ReadonlySet<SyncTrigger>): Promise<PassReport> {
    const started = Date.now();
    const { mailbox, store } = this.opts;
    const session = await source.open(mailbox);
    try {
      const snap = session.snapshot;
      if (this.ignoredValidity !== snap.uidValidity) {
        this.ignored = new Set();
        this.ignoredValidity = snap.uidValidity;
      }
      const stored = await store.getState(mailbox);
      const plan = planSync(stored, snap, triggers);
      const report: PassReport = {
        plan: plan.kind,
        reason: plan.kind === 'full' ? plan.reason : undefined,
        uidValidity: snap.uidValidity,
        fetched: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        deleted: 0,
        failed: 0,
        skipped: 0,
        lastUid: stored?.lastUid ?? 0,
        ms: 0,
      };

      if (plan.kind === 'noop') {
        report.ms = Date.now() - started;
        return report;
      }

      if (plan.kind === 'full') {
        if (plan.resetUids) {
          this.log.warn('stored UIDs no longer valid, forgetting them', {
            mailbox,
            reason: plan.reason,
            was: stored?.uidValidity,
            now: snap.uidValidity,
          });
          this.ignored = new Set();
          await store.resetUids(mailbox, snap.uidValidity);
        }
        const present = await this.listUidsChecked(session);
        const known = await store.knownUids(mailbox, snap.uidValidity);
        const { toFetch } = diffUids(present, known, this.ignored);
        const outcomes = await this.process(session, toFetch, snap.uidValidity, report);
        const failed = new Set(outcomes.filter((o) => !o.done).map((o) => o.uid));
        report.deleted = (await store.deleteMissing(mailbox, snap.uidValidity, present)).length;
        report.lastUid = advanceWatermark(
          0,
          present.map((uid) => ({ uid, done: !failed.has(uid) })),
        );
        await store.saveState(mailbox, { uidValidity: snap.uidValidity, lastUid: report.lastUid }, true);
      } else {
        const lastUid = stored!.lastUid;
        if (plan.fromUid !== null) {
          const outcomes = await this.process(session, { from: plan.fromUid }, snap.uidValidity, report, lastUid);
          report.lastUid = advanceWatermark(lastUid, outcomes);
        }
        if (plan.reconcileDeletes) {
          const present = await this.listUidsChecked(session);
          report.deleted = (await store.deleteMissing(mailbox, snap.uidValidity, present)).length;
        }
        await store.saveState(mailbox, { uidValidity: snap.uidValidity, lastUid: report.lastUid });
      }

      report.ms = Date.now() - started;
      return report;
    } finally {
      await session.close();
    }
  }

  private async listUidsChecked(session: MailboxSession): Promise<number[]> {
    const uids = await session.listUids();
    // An empty answer for a mailbox the server just said is not empty would
    // make deleteMissing wipe the table. Refuse it; the next pass retries.
    if (uids.length === 0 && session.snapshot.exists > 0) {
      throw new Error(`server reported ${session.snapshot.exists} messages but returned no UIDs`);
    }
    return uids;
  }

  private async process(
    session: MailboxSession,
    range: number[] | { from: number },
    uidValidity: number,
    report: PassReport,
    watermark = 0,
  ): Promise<Array<{ uid: number; done: boolean }>> {
    const { mailbox, store } = this.opts;
    const queue = new WorkQueue({
      concurrency: this.opts.concurrency,
      maxAttempts: this.opts.maxAttempts,
      retryBaseMs: this.opts.retryBaseMs,
    });
    const pending: Array<Promise<{ uid: number; done: boolean }>> = [];

    const chunks = Array.isArray(range) ? chunk(range, FETCH_CHUNK) : [range];
    for (const part of chunks) {
      if (Array.isArray(part) && part.length === 0) continue;
      for await (const msg of session.fetch(part)) {
        // `UID FETCH n:*` returns the last message even when its UID is below n.
        if (!Array.isArray(part) && filterNewUids([msg.uid], watermark).length === 0) continue;
        report.fetched++;
        await queue.waitForCapacity();
        pending.push(
          queue
            .push(async () => store.upsert(await parseNote(msg.source), { mailbox, uid: msg.uid, uidValidity }))
            .then((outcome) => {
              if (outcome.ok) {
                this.count(report, outcome.value);
                if (outcome.value === 'unchanged') this.ignored.add(msg.uid);
                return { uid: msg.uid, done: true };
              }
              if (outcome.permanent) {
                report.skipped++;
                this.ignored.add(msg.uid);
                this.log.warn('skipping message', { mailbox, uid: msg.uid, reason: outcome.error.message });
                return { uid: msg.uid, done: true };
              }
              report.failed++;
              this.log.error('message failed after retries', {
                mailbox,
                uid: msg.uid,
                attempts: outcome.attempts,
                error: outcome.error.message,
              });
              return { uid: msg.uid, done: false };
            }),
        );
      }
    }
    return Promise.all(pending);
  }

  private count(report: PassReport, result: UpsertResult): void {
    if (result === 'inserted') report.inserted++;
    else if (result === 'updated') report.updated++;
    else report.unchanged++;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Coalescing, single-flight runner. IDLE can deliver a burst of EXISTS and
 * EXPUNGE events (an edit is one of each); running a pass per event would
 * queue passes that find nothing. Instead, triggers that arrive while a pass
 * is running are merged and handled by exactly one follow-up pass.
 *
 * A failed pass keeps its triggers and is retried with backoff, so a database
 * that is briefly down delays the sync instead of dropping it.
 */
export class SyncScheduler extends EventEmitter {
  private pending = new Set<SyncTrigger>();
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;

  constructor(
    private readonly runPass: (triggers: ReadonlySet<SyncTrigger>) => Promise<void>,
    private readonly options: { debounceMs?: number; retry?: BackoffOptions } = {},
  ) {
    super();
  }

  request(trigger: SyncTrigger): void {
    if (this.stopped) return;
    this.pending.add(trigger);
    if (this.running || (this.timer && this.failures > 0)) return;
    this.schedule(this.options.debounceMs ?? 150);
  }

  /** Resolves when no pass is running or scheduled. */
  async idle(): Promise<void> {
    while (this.running || this.timer) {
      if (this.running) await this.running;
      else await new Promise((r) => setTimeout(r, 25));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, ms);
  }

  private drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        while (this.pending.size > 0 && !this.stopped) {
          const batch = this.pending;
          this.pending = new Set();
          try {
            await this.runPass(batch);
            this.failures = 0;
          } catch (err) {
            for (const t of batch) this.pending.add(t);
            const delay = backoffDelay(this.failures++, this.options.retry ?? { baseMs: 1_000, maxMs: 30_000 });
            this.emit('pass-error', err, delay);
            this.schedule(delay);
            return;
          }
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
