/**
 * Plays the part of a phone: writes invented notes into the IMAP mailbox the
 * way Apple Notes does, then edits and deletes some of them, pausing between
 * steps so the change is visible on the web page as it happens.
 *
 * An edit is done exactly like the real app: APPEND the new version with the
 * same X-Universally-Unique-Identifier, then expunge the old message.
 */
import { ImapFlow } from 'imapflow';
import { buildNoteMessage } from '../src/note-format.js';
import { DELETES, DEMO_NOTES, EDITS, LATE_ARRIVAL, type DemoNote } from './demo-notes.js';

const env = process.env;
const mailbox = env.NOTES_MAILBOX || 'Notes';
const step = Number(env.SEED_STEP_MS ?? 1500);
const reset = (env.SEED_RESET ?? '1') !== '0';
const from = env.IMAP_USER ?? 'notes@example.com';

const say = (msg: string) => console.log(`${new Date().toISOString()} [seed] ${msg}`);
const pause = (ms = step) => new Promise((r) => setTimeout(r, ms));

async function connect(): Promise<ImapFlow> {
  for (let attempt = 1; ; attempt++) {
    const client = new ImapFlow({
      host: env.IMAP_HOST ?? '127.0.0.1',
      port: Number(env.IMAP_PORT ?? 3143),
      secure: (env.IMAP_SECURE ?? 'false') === 'true',
      auth: { user: from, pass: env.IMAP_PASSWORD ?? '' },
      logger: false,
      disableAutoIdle: true,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      return client;
    } catch (err) {
      if (attempt >= 60) throw err;
      say(`IMAP not ready (${(err as Error).message}), retrying`);
      await pause(1000);
    }
  }
}

const uids = new Map<string, number>();

async function append(client: ImapFlow, note: DemoNote | (typeof EDITS)[number], createdDaysAgo: number) {
  const now = new Date();
  const created = new Date(now.getTime() - createdDaysAgo * 86_400_000);
  const message = buildNoteMessage({
    id: note.id,
    title: note.title,
    html: note.html,
    createdAt: created,
    modifiedAt: now,
    from,
    attachments: 'attachments' in note ? note.attachments : undefined,
  });
  const res = await client.append(mailbox, message, ['\\Seen'], now);
  if (!res || !res.uid) throw new Error('APPEND did not return a UID (server without UIDPLUS?)');
  return res.uid;
}

async function main() {
  const client = await connect();
  const boxes = await client.list();
  if (!boxes.some((b) => b.path === mailbox)) {
    await client.mailboxCreate(mailbox);
    say(`created mailbox "${mailbox}"`);
  }

  await client.mailboxOpen(mailbox);
  if (reset && client.mailbox && client.mailbox.exists > 0) {
    await client.messageDelete('1:*');
    say('cleared the demo mailbox');
    await pause();
  }

  say(`writing ${DEMO_NOTES.length} notes`);
  for (const note of DEMO_NOTES) {
    const uid = await append(client, note, note.daysAgo);
    uids.set(note.id, uid);
    say(`  + ${note.title} (uid ${uid})`);
    await pause(step / 2);
  }
  await pause(step * 2);

  for (const edit of EDITS) {
    const old = uids.get(edit.id)!;
    const original = DEMO_NOTES.find((n) => n.id === edit.id)!;
    const uid = await append(client, edit, original.daysAgo);
    await client.messageDelete(String(old), { uid: true });
    uids.set(edit.id, uid);
    say(`  ~ edited ${edit.title} (uid ${old} -> ${uid})`);
    await pause();
  }

  for (const id of DELETES) {
    const note = DEMO_NOTES.find((n) => n.id === id)!;
    await client.messageDelete(String(uids.get(id)), { uid: true });
    uids.delete(id);
    say(`  - deleted ${note.title}`);
    await pause();
  }

  const uid = await append(client, LATE_ARRIVAL, 0);
  uids.set(LATE_ARRIVAL.id, uid);
  say(`  + ${LATE_ARRIVAL.title} (uid ${uid})`);

  await client.logout();
  say(`done: ${uids.size} notes in "${mailbox}"`);
}

main().catch((err) => {
  console.error(`[seed] failed: ${(err as Error).message}`);
  process.exit(1);
});
