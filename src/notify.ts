import { EventEmitter } from 'node:events';
import pg from 'pg';
import { backoffDelay, sleep } from './backoff.js';
import { silentLogger, type Logger } from './log.js';

export interface NoteChange {
  op: 'insert' | 'update' | 'delete';
  id: string;
  title: string;
}

/**
 * LISTEN on the channel the notes trigger writes to, on a dedicated
 * connection (a pooled one would be handed to someone else between queries
 * and stop receiving). Reconnects with backoff; a reconnect emits 'resync' so
 * readers refetch whatever they may have missed while it was down.
 */
export class ChangeFeed extends EventEmitter {
  private abort = new AbortController();
  private client: pg.Client | null = null;

  constructor(
    private readonly databaseUrl: string,
    private readonly log: Logger = silentLogger,
  ) {
    super();
  }

  start(): void {
    void this.loop();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.client?.end().catch(() => undefined);
  }

  private async loop(): Promise<void> {
    let attempt = 0;
    let first = true;
    while (!this.abort.signal.aborted) {
      const client = new pg.Client({ connectionString: this.databaseUrl });
      this.client = client;
      try {
        const ended = new Promise<void>((resolve) => {
          client.once('end', resolve);
          client.once('error', (err) => {
            this.log.warn('change feed error', { error: err.message });
            resolve();
          });
        });
        await client.connect();
        client.on('notification', (msg) => {
          if (msg.channel !== 'notes_changed' || !msg.payload) return;
          try {
            this.emit('change', JSON.parse(msg.payload) as NoteChange);
          } catch {
            this.log.warn('unreadable notification', { payload: msg.payload });
          }
        });
        await client.query('listen notes_changed');
        attempt = 0;
        if (!first) this.emit('resync');
        first = false;
        await ended;
      } catch (err) {
        this.log.warn('change feed connect failed', { error: (err as Error).message });
      } finally {
        await client.end().catch(() => undefined);
      }
      if (this.abort.signal.aborted) break;
      await sleep(backoffDelay(attempt++, { baseMs: 500, maxMs: 15_000 }), this.abort.signal);
    }
  }
}
