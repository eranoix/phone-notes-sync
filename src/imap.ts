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

/**
 * The connection that fetches. It is separate from the IDLE connection on
 * purpose: a connection busy running a FETCH is not idling, and a server only
 * pushes EXISTS/EXPUNGE to a connection that is. With one connection, a note
 * saved on the phone during a long sync pass would wait for the next event to
 * be noticed; with two, the listener never stops listening.
 *
 * Connected lazily and reconnected on demand: between passes it may time out,
 * and that is fine.
 */
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
    // EXAMINE, not SELECT: this service never changes anything in the mailbox,
    // not even the \Seen flag.
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
        // Close the mailbox so the next pass EXAMINEs again and sees a fresh
        // UIDNEXT; a mailbox left open only learns about new messages lazily.
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

/**
 * Holds one connection in IDLE on the notes mailbox and reports what the
 * server pushes. Reconnects forever with capped, jittered backoff.
 *
 * Events:
 *   'connected'    - the mailbox is open and IDLE is running. Anything may
 *                    have happened while we were away, so the caller should
 *                    run a full pass.
 *   'exists'       - new message(s): an added note, or the new half of an edit.
 *   'expunge'      - a message left: a deleted note, or the old half of an edit.
 *   'status'       - ListenerStatus, for the web page.
 */
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
        // A clean close (server restart, network drop, idle timeout): start over quickly.
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

  /** One connection's lifetime. Resolves when it closes. */
  private async session(signal: AbortSignal): Promise<void> {
    const client = new ImapFlow(
      clientOptions(this.settings, {
        // This connection never runs anything else, so IDLE can start at once.
        autoIdleDelay: 100,
        // RFC 2177: re-issue IDLE before 29 minutes or the server may drop us.
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
      // imapflow keeps the server's own words in responseText ("Mailbox does not exist").
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
