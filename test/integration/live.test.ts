/**
 * Runs the real thing against the compose services: GreenMail over IMAP and
 * Postgres. Start them with `docker compose up -d postgres imap`.
 *
 * Every test works in its own mailbox, so it never disturbs the demo's
 * "Notes" mailbox or another test.
 */
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdleListener, ImapMailSource, type ImapSettings } from '../../src/imap.js';
import { buildNoteMessage } from '../../src/note-format.js';
import { NoteStore } from '../../src/store.js';
import { MailboxSync, SyncScheduler } from '../../src/sync.js';

const imap: ImapSettings = {
  host: process.env.IT_IMAP_HOST ?? '127.0.0.1',
  port: Number(process.env.IT_IMAP_PORT ?? 3143),
  secure: false,
  user: process.env.IT_IMAP_USER ?? 'notes@example.com',
  password: process.env.IT_IMAP_PASSWORD ?? 'demo-password',
};
const databaseUrl = process.env.IT_DATABASE_URL ?? 'postgres://notes:notes@127.0.0.1:54329/notes';

let pool: pg.Pool;
let store: NoteStore;
let writer: ImapFlow;
const mailboxes: string[] = [];

function note(id: string, title: string, body: string, minute: number): Buffer {
  return buildNoteMessage({
    id,
    title,
    html: `<div><h1>${title}</h1></div><div>${body}</div>`,
    createdAt: new Date(Date.UTC(2026, 6, 1)),
    modifiedAt: new Date(Date.UTC(2026, 6, 1, 12, minute)),
  });
}

async function append(mailbox: string, source: Buffer): Promise<number> {
  const res = await writer.append(mailbox, source);
  if (!res || !res.uid) throw new Error('append returned no uid');
  return res.uid;
}

async function remove(mailbox: string, uid: number): Promise<void> {
  const lock = await writer.getMailboxLock(mailbox);
  try {
    await writer.messageDelete(String(uid), { uid: true });
  } finally {
    lock.release();
  }
}

async function freshMailbox(): Promise<string> {
  const name = `IT-${randomUUID().slice(0, 8)}`;
  await writer.mailboxCreate(name);
  mailboxes.push(name);
  return name;
}

async function rows(mailbox: string) {
  const { rows } = await pool.query<{ id: string; title: string; body_text: string; uid: string }>(
    'select id, title, body_text, uid from notes where mailbox = $1 order by title',
    [mailbox],
  );
  return rows;
}

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  return last;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: databaseUrl });
  store = new NoteStore(pool);
  await store.migrate();
  writer = new ImapFlow({ host: imap.host, port: imap.port, secure: false, auth: { user: imap.user, pass: imap.password }, logger: false, disableAutoIdle: true });
  writer.on('error', () => undefined);
  await writer.connect();
});

afterAll(async () => {
  for (const m of mailboxes) {
    await pool.query('delete from notes where mailbox = $1', [m]);
    await pool.query('delete from mailbox_state where mailbox = $1', [m]);
    await writer.mailboxDelete(m).catch(() => undefined);
  }
  await writer.logout().catch(() => undefined);
  await pool.end();
});

describe('live sync against IMAP and Postgres', () => {
  it('follows adds, edits and deletes pushed by IDLE, with no polling', async () => {
    const mailbox = await freshMailbox();
    const source = new ImapMailSource(imap);
    const sync = new MailboxSync({ mailbox, store, concurrency: 4, maxAttempts: 3 });
    const passes: string[] = [];
    const scheduler = new SyncScheduler(async (t) => {
      const r = await sync.run(source, t);
      passes.push(`${r.plan}:${[...t].sort().join('+')}`);
    });
    const listener = new IdleListener(imap, mailbox, { idleRestartMs: 60_000, reconnect: { baseMs: 200, maxMs: 1_000 } });
    listener.on('connected', () => scheduler.request('connect'));
    listener.on('exists', () => scheduler.request('new-messages'));
    listener.on('expunge', () => scheduler.request('expunge'));
    const connected = new Promise((r) => listener.once('connected', r));
    void listener.start();
    await connected;
    await scheduler.idle();

    try {
      const a = randomUUID().toUpperCase();
      const b = randomUUID().toUpperCase();
      const uidA = await append(mailbox, note(a, 'Alpha', 'first draft', 1));
      await append(mailbox, note(b, 'Bravo', 'to be deleted', 2));
      const added = await eventually(() => rows(mailbox), (r) => r.length === 2);
      expect(added.map((r) => r.title)).toEqual(['Alpha', 'Bravo']);

      // Edit the way the phone does: new message with the same identity, old one expunged.
      await append(mailbox, note(a, 'Alpha', 'second draft', 3));
      await remove(mailbox, uidA);
      const edited = await eventually(() => rows(mailbox), (r) => r.some((x) => x.body_text.includes('second draft')));
      expect(edited.find((x) => x.id === a)?.body_text).toBe('Alpha\nsecond draft');

      const uidB = Number(edited.find((x) => x.id === b)!.uid);
      await remove(mailbox, uidB);
      const afterDelete = await eventually(() => rows(mailbox), (r) => r.length === 1);
      expect(afterDelete.map((r) => r.id)).toEqual([a]);

      // Everything after the first pass was driven by IDLE events, never by a timer.
      expect(passes[0]).toBe('full:connect');
      expect(passes.slice(1).every((p) => !p.includes('interval'))).toBe(true);
    } finally {
      scheduler.stop();
      await listener.stop();
      await scheduler.idle();
      await source.close();
    }
  });

  it('recovers from a UIDVALIDITY change: the mailbox is recreated, notes keep their identity', async () => {
    const mailbox = await freshMailbox();
    const source = new ImapMailSource(imap);
    const sync = new MailboxSync({ mailbox, store, concurrency: 2, maxAttempts: 3 });
    const ids = [randomUUID().toUpperCase(), randomUUID().toUpperCase()];
    const doomed = randomUUID().toUpperCase();
    await append(mailbox, note(ids[0]!, 'One', 'x', 1));
    await append(mailbox, note(ids[1]!, 'Two', 'y', 2));
    await append(mailbox, note(doomed, 'Three', 'z', 3));
    const before = await sync.run(source, new Set(['connect']));
    expect(before).toMatchObject({ inserted: 3 });

    // Recreating a mailbox is the portable way to get a new UIDVALIDITY.
    // GreenMail derives it from the clock in whole seconds, so recreate in a
    // later second or it keeps the old value (the planner catches that case
    // too, through UIDNEXT, and a unit test covers it).
    await writer.mailboxDelete(mailbox);
    await new Promise((r) => setTimeout(r, 1_100));
    await writer.mailboxCreate(mailbox);
    await append(mailbox, note(ids[1]!, 'Two', 'y', 2));
    await append(mailbox, note(ids[0]!, 'One', 'x', 1));

    const after = await sync.run(source, new Set(['new-messages']));
    expect(after.reason).toBe('uidvalidity-changed');
    expect(after.uidValidity).not.toBe(before.uidValidity);
    expect(after).toMatchObject({ inserted: 0, deleted: 1 });
    const r = await rows(mailbox);
    expect(r.map((x) => x.id).sort()).toEqual([...ids].sort());
    expect(r.every((x) => x.uid !== null)).toBe(true);
    await source.close();
  });

  it('a replayed full pass writes nothing', async () => {
    const mailbox = await freshMailbox();
    const source = new ImapMailSource(imap);
    const sync = new MailboxSync({ mailbox, store, concurrency: 2, maxAttempts: 3 });
    await append(mailbox, note(randomUUID().toUpperCase(), 'Solo', 'x', 1));
    expect(await sync.run(source, new Set(['connect']))).toMatchObject({ inserted: 1 });
    const again = await sync.run(source, new Set(['interval']));
    expect(again).toMatchObject({ fetched: 0, inserted: 0, updated: 0, deleted: 0 });
    await source.close();
  });
});
