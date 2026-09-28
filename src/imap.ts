import { EventEmitter } from 'node:events';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { backoffDelay, sleep, type BackoffOptions } from './backoff.js';
import { silentLogger, type Logger } from './log.js';
import type { FetchedMessage, MailboxSession, MailSource } from './sync.js';

export interface ImapSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

function clientOptions(s: ImapSettings, extra: Partial<ImapFlowOptions> = {}): ImapFlowOptions {
  return {
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: { user: s.user, pass: s.password },
    logger: false,
    ...extra,
  };
}

export class ImapMailSource implements MailSource {
  private client: ImapFlow | null = null;

  constructor(
    private readonly settings: ImapSettings,
    private readonly log: Logger = silentLogger,
  ) {}

  private async connected(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    const client = new ImapFlow(clientOptions(this.settings, { disableAutoIdle: true }));
    client.on('error', (err: Error) => this.log.warn('fetch connection error', { error: err.message }));
    await client.connect();
    this.client = client;
    return client;
  }

  async open(mailbox: string): Promise<MailboxSession> {
    const client = await this.connected();
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    const box = client.mailbox;
    if (!box) {
      lock.release();
      throw new Error(`mailbox ${mailbox} did not open`);
    }
    const snapshot = {
      uidValidity: Number(box.uidValidity),
      uidNext: box.uidNext,
      exists: box.exists,
    };
    return {
      snapshot,
      async listUids() {
        const result = await client.search({ all: true }, { uid: true });
        return Array.isArray(result) ? result : [];
      },
      async *fetch(range): AsyncIterable<FetchedMessage> {
        const set = Array.isArray(range) ? range.join(',') : `${range.from}:*`;
        for await (const msg of client.fetch(set, { uid: true, source: true }, { uid: true })) {
          if (msg.source) yield { uid: msg.uid, source: msg.source };
        }
      },
      async close() {
        lock.release();
        await client.mailboxClose().catch(() => undefined);
      },
    };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c?.usable) await c.logout().catch(() => undefined);
  }
}

export type ListenerState = 'starting' | 'connecting' | 'idle' | 'reconnecting' | 'stopped';

export interface ListenerStatus {
  state: ListenerState;
  attempt: number;
  retryInMs: number | null;
  connectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
}

export class IdleListener extends EventEmitter {
  private abort = new AbortController();
  private client: ImapFlow | null = null;
  readonly status: ListenerStatus = {
    state: 'starting',
    attempt: 0,
    retryInMs: null,
    connectedAt: null,
    lastEventAt: null,
    lastError: null,
  };

  constructor(
    private readonly settings: ImapSettings,
    private readonly mailbox: string,
    private readonly options: { idleRestartMs: number; reconnect: BackoffOptions },
    private readonly log: Logger = silentLogger,
  ) {
    super();
  }

  private setStatus(patch: Partial<ListenerStatus>): void {
    Object.assign(this.status, patch);
    this.emit('status', { ...this.status });
  }

  start(): Promise<void> {
    return this.loop();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    const c = this.client;
    if (c?.usable) await c.logout().catch(() => undefined);
    this.setStatus({ state: 'stopped' });
  }

  private async loop(): Promise<void> {
    const signal = this.abort.signal;
    let attempt = 0;
    while (!signal.aborted) {
      this.setStatus({ state: 'connecting', attempt, retryInMs: null });
      try {
        await this.session(signal);
        attempt = 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('listener connection failed', { attempt, error: message });
        this.setStatus({ lastError: message });
      }
      if (signal.aborted) break;
      const delay = backoffDelay(attempt++, this.options.reconnect);
      this.log.info('reconnecting', { in_ms: delay, attempt });
      this.setStatus({ state: 'reconnecting', attempt, retryInMs: delay, connectedAt: null });
      await sleep(delay, signal);
    }
  }

  private async session(signal: AbortSignal): Promise<void> {
    const client = new ImapFlow(
      clientOptions(this.settings, {
        autoIdleDelay: 100,
        maxIdleTime: this.options.idleRestartMs,
      }),
    );
    this.client = client;
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.on('error', (err: Error) => {
      this.log.warn('listener connection error', { error: err.message });
      this.setStatus({ lastError: err.message });
    });

    await client.connect();
    try {
      await client.mailboxOpen(this.mailbox, { readOnly: true });
    } catch (err) {
      await client.logout().catch(() => undefined);
      const e = err as Error & { responseText?: string };
      throw new Error(`cannot open mailbox "${this.mailbox}": ${e.responseText || e.message}`);
    }
    if (signal.aborted) {
      await client.logout().catch(() => undefined);
      return;
    }

    const touch = () => this.setStatus({ lastEventAt: new Date().toISOString() });
    client.on('exists', (data: { count: number; prevCount: number }) => {
      touch();
      this.log.debug('EXISTS', data);
      this.emit('exists', data);
    });
    client.on('expunge', (data: { seq?: number; uid?: number }) => {
      touch();
      this.log.debug('EXPUNGE', data);
      this.emit('expunge', data);
    });

    this.log.info('listening with IDLE', { mailbox: this.mailbox, host: this.settings.host });
    this.setStatus({
      state: 'idle',
      attempt: 0,
      retryInMs: null,
      connectedAt: new Date().toISOString(),
      lastError: null,
    });
    this.emit('connected');
    await closed;
    this.client = null;
    if (!signal.aborted) this.log.warn('listener connection closed');
  }
}
