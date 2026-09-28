import { EventEmitter } from 'node:events';
import pg from 'pg';
import { loadConfig } from './config.js';
import { IdleListener, ImapMailSource } from './imap.js';
import { logger } from './log.js';
import { ChangeFeed } from './notify.js';
import { NoteStore } from './store.js';
import { MailboxSync, SyncScheduler, type PassReport } from './sync.js';
import { createWebServer } from './web.js';

const log = logger('main');
const config = loadConfig();

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.sync.concurrency + 2 });
pool.on('error', (err) => log.warn('idle database client error', { error: err.message }));
const store = new NoteStore(pool);

async function migrateWithRetry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await store.migrate();
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      log.warn('database not ready, retrying', { attempt, error: (err as Error).message });
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}
await migrateWithRetry();

const imapSettings = {
  host: config.imap.host,
  port: config.imap.port,
  secure: config.imap.secure,
  user: config.imap.user,
  password: config.imap.password,
};

const hub = new EventEmitter();
const source = new ImapMailSource(imapSettings, logger('fetch'));
const mailboxSync = new MailboxSync({
  mailbox: config.imap.mailbox,
  store,
  concurrency: config.sync.concurrency,
  maxAttempts: config.sync.maxAttempts,
  log: logger('sync'),
});
const listener = new IdleListener(
  imapSettings,
  config.imap.mailbox,
  { idleRestartMs: config.imap.idleRestartMs, reconnect: config.reconnect },
  logger('idle'),
);

let lastPass: (PassReport & { at: string; triggers: string[] }) | null = null;
let syncing = false;
const status = () => ({ mailbox: config.imap.mailbox, listener: listener.status, syncing, lastPass });
const publishStatus = () => hub.emit('status', status());

const scheduler = new SyncScheduler(async (triggers) => {
  syncing = true;
  publishStatus();
  try {
    const report = await mailboxSync.run(source, triggers);
    lastPass = { ...report, at: new Date().toISOString(), triggers: [...triggers] };
    if (report.plan !== 'noop') {
      logger('sync').info('pass done', { ...report, triggers: [...triggers].join(',') });
    }
  } finally {
    syncing = false;
    publishStatus();
  }
});
scheduler.on('pass-error', (err: Error, delay: number) => {
  logger('sync').error('pass failed, will retry', { error: err.message, retry_in_ms: delay });
});

listener.on('connected', () => scheduler.request('connect'));
listener.on('exists', () => scheduler.request('new-messages'));
listener.on('expunge', () => scheduler.request('expunge'));
listener.on('status', publishStatus);

const resync = config.sync.resyncIntervalMs > 0
  ? setInterval(() => scheduler.request('interval'), config.sync.resyncIntervalMs)
  : null;

const feed = new ChangeFeed(config.databaseUrl, logger('feed'));
feed.on('change', (c) => hub.emit('change', c));
feed.on('resync', () => hub.emit('resync'));
feed.start();

const server = createWebServer({ store, events: hub, status, log: logger('web') });
server.listen(config.web.port, config.web.host, () => {
  log.info('web page ready', { url: `http://localhost:${config.web.port}` });
});

void listener.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  if (resync) clearInterval(resync);
  scheduler.stop();
  await listener.stop();
  await scheduler.idle().catch(() => undefined);
  await source.close();
  await feed.stop();
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
